/**
 * `agent-video doctor` — the honest environment report (ADR 0003
 * Decision 3, Appendix E requirements).
 *
 * ONE machine-readable JSON report on stdout; exit codes:
 *   0 usable   — every runtime preflight passed AND all three root
 *                classes configured AND no over-broad-root warning.
 *   1 degraded — the runtime is healthy but the configuration is honest
 *                about gaps: any root relative/missing/non-directory,
 *                zero mediaRoots (imports fail), zero artifactRoot
 *                (preview/export/verify fail), zero projectRoots
 *                (project.open/project.save fail), or a root that IS the
 *                filesystem root (over-broad warning — containment is
 *                technically preserved but reaches everything).
 *   2 unusable — the runtime cannot do its job here: the Chromium launch
 *                probe failed, render is unavailable, ffmpeg/ffprobe are
 *                missing, or the export codec preflight failed.
 *
 * Sections: Chromium probe (+browser build), ffmpeg/ffprobe paths and
 * versions, codec preflight via the runtime probe path, canonicalized
 * roots of all three classes, provider availability with reasons,
 * orphan-artifact listing under artifactRoot (labeled unverifiable —
 * never deleted), checkpoint `.tmp` residue under projectRoots (inert —
 * never valid checkpoints), and the browser-reaper verification.
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  createAgentFacade,
  type Capabilities,
  type FacadeResult,
} from "@openreel/agent-facade";
import {
  createChromiumProviders,
  FfmpegArtifactVerifier,
  resolveFfmpegBinaries,
  type RuntimeProbeResult,
} from "@openreel/runtime-chromium";

import { CONFIG_DEFAULTS, parseArgv, refuseStartup } from "./config";
import { logInfo, setLogLevel } from "./log";
import { verifyBrowserReaper, type ReaperFinding } from "./reaper";
import { TRANSPORT_VERSION } from "./serve";

/* ------------------------------------------------------------------ */
/* Root inspection (lenient — doctor reports, it never refuses)        */
/* ------------------------------------------------------------------ */

export type RootStatus = "ok" | "relative" | "tilde" | "missing" | "not-directory";

export interface RootReport {
  readonly raw: string;
  readonly status: RootStatus;
  readonly canonical?: string;
  /** The root IS the filesystem root ("/", "C:\") — containment warning. */
  readonly overBroad?: boolean;
}

async function inspectRoot(raw: string): Promise<RootReport> {
  if (raw === "~" || raw.startsWith("~/")) {
    return { raw, status: "tilde" };
  }
  if (!path.isAbsolute(raw)) {
    return { raw, status: "relative" };
  }
  const st = await stat(raw).catch(() => null);
  if (st === null) {
    return { raw, status: "missing" };
  }
  if (!st.isDirectory()) {
    return { raw, status: "not-directory" };
  }
  const { realpath } = await import("node:fs/promises");
  const canonical = await realpath(raw);
  return {
    raw,
    status: "ok",
    canonical,
    overBroad: path.parse(canonical).root === canonical,
  };
}

/* ------------------------------------------------------------------ */
/* Filesystem scans (orphans, .tmp residue) — read-only, never delete  */
/* ------------------------------------------------------------------ */

const ORPHAN_LABEL = "orphan — unverifiable, do not trust as an artifact";
const TMP_RESIDUE_LABEL = "inert save residue — never a valid checkpoint";

export interface OrphanFile {
  readonly path: string;
  readonly bytes: number;
  readonly modifiedAt: string;
  readonly label: string;
}

async function listFilesRecursive(
  dir: string,
  filter?: (name: string) => boolean,
): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return out;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(full, filter)));
    } else if (entry.isFile() && (filter === undefined || filter(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

async function fileReport(absPath: string, label: string): Promise<OrphanFile> {
  const st = await stat(absPath).catch(() => null);
  return {
    path: absPath,
    bytes: st?.size ?? 0,
    modifiedAt: st !== null ? new Date(st.mtimeMs).toISOString() : "",
    label,
  };
}

/** Orphan-artifact listing: per-job dirs under artifactRoot + renders. */
async function scanOrphans(artifactRoot: string): Promise<{
  readonly artifactRoot: string;
  readonly jobDirs: readonly { readonly dir: string; readonly files: readonly OrphanFile[] }[];
  readonly renders: readonly OrphanFile[];
  readonly note: string;
}> {
  const jobDirs: { dir: string; files: OrphanFile[] }[] = [];
  const exportsDir = path.join(artifactRoot, "exports");
  const entries = await readdir(exportsDir, { withFileTypes: true }).catch(() => null);
  if (entries !== null) {
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const jobDir = path.join(exportsDir, entry.name);
      const files = await listFilesRecursive(jobDir);
      jobDirs.push({
        dir: jobDir,
        files: await Promise.all(files.map((f) => fileReport(f, ORPHAN_LABEL))),
      });
    }
  }
  const rendersDir = path.join(artifactRoot, "renders");
  const renderFiles = await listFilesRecursive(rendersDir);
  return {
    artifactRoot,
    jobDirs,
    renders: await Promise.all(renderFiles.map((f) => fileReport(f, ORPHAN_LABEL))),
    note: "Everything listed here exists under artifactRoot but no live session references it (the facade job registry is in-memory; doctor is a separate process). It is never auto-deleted in this slice.",
  };
}

/** Checkpoint section: stray `*.tmp` residue under projectRoots. */
async function scanCheckpointResidue(projectRoots: readonly string[]): Promise<{
  readonly projectRoots: readonly string[];
  readonly tmpResidue: readonly OrphanFile[];
  readonly note: string;
}> {
  const tmpResidue: OrphanFile[] = [];
  for (const root of projectRoots) {
    const files = await listFilesRecursive(root, (name) => name.endsWith(".tmp"));
    for (const file of files) {
      tmpResidue.push(await fileReport(file, TMP_RESIDUE_LABEL));
    }
  }
  return {
    projectRoots: [...projectRoots],
    tmpResidue,
    note: "project.save publishes atomically (temp sibling + rename/hard-link); a crash mid-save can leave an inert `<name>.<uuid>.tmp` sibling. Residue is never a valid checkpoint and never auto-deleted.",
  };
}

/* ------------------------------------------------------------------ */
/* The report                                                          */
/* ------------------------------------------------------------------ */

export interface DoctorReport {
  readonly command: "doctor";
  readonly ts: string;
  readonly transport: {
    readonly name: "agent-video";
    readonly version: string;
    readonly pid: number;
    readonly platform: string;
    readonly node: string;
  };
  readonly config: {
    readonly env: {
      readonly mediaRoots: string;
      readonly artifactRoot: string;
      readonly projectRoots: string;
      readonly log: string;
    };
    readonly roots: {
      readonly mediaRoots: readonly RootReport[];
      readonly artifactRoot: RootReport | null;
      readonly projectRoots: readonly RootReport[];
    };
    readonly warnings: readonly string[];
  };
  readonly chromium: {
    readonly launchOk: boolean;
    readonly launchError?: string;
    readonly browserBuild?: string;
    readonly executablePath?: string | null;
    readonly headless?: boolean;
  };
  readonly ffmpeg: {
    readonly available: boolean;
    readonly ffmpegPath?: string;
    readonly ffprobePath?: string;
    readonly ffmpegVersion?: string;
    readonly ffprobeVersion?: string;
  };
  readonly codecs: {
    readonly renderAvailable: boolean;
    readonly h264DecodeAvailable: boolean;
    readonly h264EncodeAvailable: boolean;
    readonly exportRoute: string;
    readonly exportUnavailableReason?: string;
    readonly videoOnlyFramesRouteAvailable: boolean;
  };
  readonly providers: {
    readonly mediaImport: { readonly available: boolean; readonly reason?: string };
    readonly preview: { readonly available: boolean; readonly reason?: string };
    readonly export: { readonly available: boolean; readonly reason?: string };
    readonly verify: { readonly available: boolean; readonly reason?: string };
    readonly persistence: { readonly available: boolean; readonly reason?: string };
  };
  readonly orphans: Awaited<ReturnType<typeof scanOrphans>> | { readonly note: string };
  readonly checkpoints: Awaited<ReturnType<typeof scanCheckpointResidue>> | { readonly note: string };
  readonly browserReaper: ReaperFinding;
  readonly verdict: {
    readonly classification: "usable" | "degraded" | "unusable";
    readonly exitCode: 0 | 1 | 2;
    readonly reasons: readonly string[];
  };
}

function capabilityView(capability: {
  readonly available: boolean;
  readonly reason?: string;
}): { available: boolean; reason?: string } {
  return capability.available
    ? { available: true }
    : { available: false, reason: capability.reason };
}

export async function doctorCommand(argv: readonly string[]): Promise<number> {
  // doctor accepts --log-level only; any other flag is an invocation error.
  let parsed;
  try {
    parsed = parseArgv(argv);
  } catch (error) {
    refuseStartup(error, "doctor");
  }
  if (
    parsed.roots.mediaRoots.length > 0 ||
    parsed.roots.projectRoots.length > 0 ||
    parsed.roots.artifactRoot !== undefined ||
    parsed.workflowPath !== undefined ||
    parsed.keepGoing
  ) {
    refuseStartup(
      new Error("doctor takes no roots or workflow flags — it reports the ambient env configuration"),
      "doctor",
    );
  }
  setLogLevel(parsed.logLevel ?? "info");
  logInfo("doctor", "environment report starting", { pid: process.pid });

  // 1. Lenient root inspection (env-only — flags belong to serve/run).
  const env = process.env;
  const rawMediaRootsEnv = env[CONFIG_DEFAULTS.mediaRootsEnv];
  const rawProjectRootsEnv = env[CONFIG_DEFAULTS.projectRootsEnv];
  const rawArtifactRoot = env[CONFIG_DEFAULTS.artifactRootEnv];
  const rawMediaRoots =
    rawMediaRootsEnv !== undefined
      ? rawMediaRootsEnv.split(path.delimiter).filter((s) => s.length > 0)
      : [];
  const rawProjectRoots =
    rawProjectRootsEnv !== undefined
      ? rawProjectRootsEnv.split(path.delimiter).filter((s) => s.length > 0)
      : [];
  const mediaRootReports = await Promise.all(rawMediaRoots.map(inspectRoot));
  const projectRootReports = await Promise.all(rawProjectRoots.map(inspectRoot));
  const artifactRootReport =
    rawArtifactRoot !== undefined ? await inspectRoot(rawArtifactRoot) : null;

  const warnings: string[] = [];
  for (const report of [...mediaRootReports, ...projectRootReports, ...(artifactRootReport !== null ? [artifactRootReport] : [])]) {
    if (report.overBroad === true) {
      warnings.push(
        `over-broad root: "${report.canonical}" is the filesystem root — facade containment still applies but reaches everything`,
      );
    }
  }

  // 2. Real runtime probe via the session wiring (the runtime probe path).
  //    Only OK roots reach the session; broken ones stay in the report.
  const canonicalOf = (reports: readonly RootReport[]): string[] =>
    reports
      .filter((r) => r.status === "ok")
      .map((r) => r.canonical)
      .filter((c): c is string => c !== undefined);
  const okMediaRoots = canonicalOf(mediaRootReports);
  const okProjectRoots = canonicalOf(projectRootReports);
  const okArtifactRoot =
    artifactRootReport?.status === "ok" ? artifactRootReport.canonical : undefined;

  const providers = createChromiumProviders();
  const facade = createAgentFacade({
    mediaRoots: okMediaRoots,
    ...(okArtifactRoot !== undefined ? { artifactRoot: okArtifactRoot } : {}),
    projectRoots: okProjectRoots,
    renderProvider: providers.renderProvider,
    exportProvider: providers.exportProvider,
    artifactVerifier: new FfmpegArtifactVerifier(),
  });

  let probe: RuntimeProbeResult | null = null;
  try {
    probe = await providers.probe();
  } catch (error) {
    probe = null;
    logInfo("doctor", "runtime probe threw", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  let capabilities: Capabilities | null = null;
  const capsResult: FacadeResult<Capabilities> = await facade["capabilities.get"]();
  if (capsResult.ok) capabilities = capsResult.value;
  await providers.close().catch(() => undefined);

  // 3. ffmpeg facts — direct resolution so the report carries exact paths
  //    and versions even when Chromium itself is broken.
  const ffmpeg = probe !== null && probe.ffmpeg.available
    ? {
        available: true,
        ...(probe.ffmpeg.ffmpegPath !== undefined ? { ffmpegPath: probe.ffmpeg.ffmpegPath } : {}),
        ...(probe.ffmpeg.ffprobePath !== undefined ? { ffprobePath: probe.ffmpeg.ffprobePath } : {}),
        ...(probe.ffmpeg.version !== undefined ? { ffmpegVersion: probe.ffmpeg.version } : {}),
      }
    : await (async () => {
        const resolved = await resolveFfmpegBinaries().catch(() => null);
        if (resolved === null) return { available: false };
        return {
          available: true,
          ffmpegPath: resolved.ffmpeg,
          ffprobePath: resolved.ffprobe,
          ffmpegVersion: resolved.ffmpegVersion,
          ffprobeVersion: resolved.ffprobeVersion,
        };
      })();

  // 4. Orphans + checkpoint residue (read-only scans).
  const orphanScan =
    okArtifactRoot !== undefined
      ? await scanOrphans(okArtifactRoot)
      : {
          note:
            "no artifactRoot configured — nothing to scan (artifact-producing verbs fail UNSUPPORTED without it)",
        };
  const checkpointScan =
    okProjectRoots.length > 0
      ? await scanCheckpointResidue(okProjectRoots)
      : {
          note:
            "no projectRoots configured — nothing to scan (project.open/project.save fail UNSUPPORTED without them)",
        };

  // 5. Browser-reaper empirical verification.
  const browserReaper = await verifyBrowserReaper();

  // 6. Verdict.
  const reasons: string[] = [];
  let classification: DoctorReport["verdict"]["classification"] = "usable";
  const unusable = (reason: string): void => {
    classification = "unusable";
    reasons.push(reason);
  };
  const degraded = (reason: string): void => {
    if (classification === "usable") classification = "degraded";
    reasons.push(reason);
  };

  if (probe === null) {
    unusable("Chromium runtime probe failed to run — the render/export runtime cannot start");
  } else {
    if (probe.launchError !== undefined) {
      unusable(`Chromium launch probe failed: ${probe.launchError}`);
    }
    if (!probe.summary.renderAvailable) {
      unusable(
        `render unavailable: ${probe.summary.exportUnavailableReason ?? "Chromium page probe did not pass"}`,
      );
    }
    if (probe.summary.exportRoute === "unavailable") {
      unusable(
        `export codec preflight failed: ${probe.summary.exportUnavailableReason ?? "no available export route"}`,
      );
    }
    if (!probe.ffmpeg.available) {
      unusable("ffmpeg/ffprobe not resolvable — verify.artifact cannot run");
    }
  }

  for (const report of mediaRootReports) {
    if (report.status !== "ok") degraded(`mediaRoot "${report.raw}" is ${report.status}`);
  }
  for (const report of projectRootReports) {
    if (report.status !== "ok") degraded(`projectRoot "${report.raw}" is ${report.status}`);
  }
  if (artifactRootReport !== null && artifactRootReport.status !== "ok") {
    degraded(`artifactRoot "${artifactRootReport.raw}" is ${artifactRootReport.status}`);
  }
  if (mediaRootReports.length === 0) {
    degraded("no mediaRoots configured — media.import fails UNSUPPORTED");
  }
  if (artifactRootReport === null) {
    degraded("no artifactRoot configured — preview/export/verify fail UNSUPPORTED");
  }
  if (projectRootReports.length === 0) {
    degraded("no projectRoots configured — project.open/project.save fail UNSUPPORTED (persistence unavailable)");
  }
  for (const warning of warnings) {
    degraded(warning);
  }

  const report: DoctorReport = {
    command: "doctor",
    ts: new Date().toISOString(),
    transport: {
      name: "agent-video",
      version: TRANSPORT_VERSION,
      pid: process.pid,
      platform: process.platform,
      node: process.version,
    },
    config: {
      env: {
        mediaRoots: CONFIG_DEFAULTS.mediaRootsEnv,
        artifactRoot: CONFIG_DEFAULTS.artifactRootEnv,
        projectRoots: CONFIG_DEFAULTS.projectRootsEnv,
        log: CONFIG_DEFAULTS.logLevelEnv,
      },
      roots: {
        mediaRoots: mediaRootReports,
        artifactRoot: artifactRootReport,
        projectRoots: projectRootReports,
      },
      warnings,
    },
    chromium:
      probe === null
        ? { launchOk: false, launchError: "runtime probe did not run" }
        : {
            launchOk: probe.launchError === undefined,
            ...(probe.launchError !== undefined ? { launchError: probe.launchError } : {}),
            browserBuild: probe.chromium.version,
            executablePath: probe.chromium.executablePath,
            headless: probe.chromium.headless,
          },
    ffmpeg,
    codecs:
      probe === null
        ? {
            renderAvailable: false,
            h264DecodeAvailable: false,
            h264EncodeAvailable: false,
            exportRoute: "unavailable",
            videoOnlyFramesRouteAvailable: false,
          }
        : {
            renderAvailable: probe.summary.renderAvailable,
            h264DecodeAvailable: probe.summary.h264DecodeAvailable,
            h264EncodeAvailable: probe.summary.h264EncodeAvailable,
            exportRoute: probe.summary.exportRoute,
            ...(probe.summary.exportUnavailableReason !== undefined
              ? { exportUnavailableReason: probe.summary.exportUnavailableReason }
              : {}),
            videoOnlyFramesRouteAvailable: probe.summary.videoOnlyFramesRouteAvailable,
          },
    providers: {
      mediaImport:
        capabilities !== null
          ? capabilityView(capabilities.mediaImport)
          : { available: false, reason: "capabilities.get failed" },
      preview:
        capabilities !== null
          ? capabilityView(capabilities.preview)
          : { available: false, reason: "capabilities.get failed" },
      export:
        capabilities !== null
          ? capabilityView(capabilities.export)
          : { available: false, reason: "capabilities.get failed" },
      verify:
        capabilities !== null
          ? capabilityView(capabilities.verify)
          : { available: false, reason: "capabilities.get failed" },
      persistence:
        okProjectRoots.length > 0
          ? { available: true }
          : {
              available: false,
              reason: "no projectRoots configured — project.open/project.save fail UNSUPPORTED",
            },
    },
    orphans: orphanScan,
    checkpoints: checkpointScan,
    browserReaper,
    verdict: {
      classification,
      exitCode: classification === "usable" ? 0 : classification === "degraded" ? 1 : 2,
      reasons,
    },
  };

  const json = JSON.stringify(report, null, 2);
  process.stdout.write(`${json}\n`);
  logInfo("doctor", "report written", {
    classification,
    exitCode: report.verdict.exitCode,
  });
  return report.verdict.exitCode;
}
