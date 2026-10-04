/**
 * `reelterminal-agent doctor` tests against
 * the REAL binary: exit-code classes (0 usable / 1 degraded / 2 unusable),
 * canonicalized roots echo, over-broad-root warning, orphan-artifact
 * listing with the unverifiable label, checkpoint `.tmp` residue listed
 * as inert, and the browser-reaper verification section.
 *
 * The usable/degraded verdicts require a healthy runtime (Chromium launch
 * + ffmpeg); those assertions are gated with printed skip reasons.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromiumAvailable, ffmpegAvailable, makeRoots, spawnCli, type Roots } from "./helpers";

let roots: Roots;
const runtimeHealthy = chromiumAvailable() && ffmpegAvailable();

beforeAll(async () => {
  roots = await makeRoots();
});

afterAll(async () => {
  await roots.cleanup();
});

interface DoctorReport {
  verdict: { classification: string; exitCode: number; reasons: string[] };
  config: { roots: any; warnings: string[] };
  chromium: { launchOk: boolean; browserBuild?: string };
  ffmpeg: { available: boolean; ffmpegPath?: string; ffprobePath?: string };
  codecs: { renderAvailable: boolean; exportRoute: string };
  providers: Record<string, { available: boolean; reason?: string }>;
  orphans: any;
  checkpoints: any;
  browserReaper: { verified: boolean; reaped: boolean | null; platform: string; reason?: string };
}

async function runDoctor(env: Record<string, string | undefined>): Promise<{ exitCode: number; report: DoctorReport; stderr: string; stdout: string }> {
  const handle = spawnCli(["doctor", "--log-level", "error"], env);
  const exitCode = await handle.exitCode;
  const report = JSON.parse(handle.stdout) as DoctorReport;
  return { exitCode, report, stderr: handle.stderr, stdout: handle.stdout };
}

describe("doctor: report shape and environment facts", () => {
  it("with no roots configured: exit 1 degraded, provider gaps named honestly", async () => {
    if (!runtimeHealthy) {
      console.warn("[doctor] SKIP usable/degraded verdict test: chromium/ffmpeg unavailable");
      return;
    }
    const { exitCode, report } = await runDoctor({});
    expect(exitCode).toBe(1);
    expect(report.verdict.classification).toBe("degraded");
    expect(report.verdict.reasons.join("\n")).toContain("no mediaRoots configured");
    expect(report.verdict.reasons.join("\n")).toContain("no projectRoots configured");
    expect(report.providers.mediaImport.available).toBe(false);
    expect(report.providers.persistence.available).toBe(false);
    // the runtime itself is healthy
    expect(report.chromium.launchOk).toBe(true);
    expect(report.chromium.browserBuild).toBeTruthy();
    expect(report.ffmpeg.available).toBe(true);
    expect(report.ffmpeg.ffmpegPath).toBeTruthy();
    expect(report.ffmpeg.ffprobePath).toBeTruthy();
    expect(report.codecs.renderAvailable).toBe(true);
    expect(report.codecs.exportRoute).toBe("chromium-webcodecs");
    expect(report.browserReaper.verified).toBe(true);
    expect(typeof report.browserReaper.reaped).toBe("boolean");
  });

  it("with all three root classes configured and healthy: exit 0 usable, canonicalized roots echoed", async () => {
    if (!runtimeHealthy) {
      console.warn("[doctor] SKIP usable verdict test: chromium/ffmpeg unavailable");
      return;
    }
    const { exitCode, report } = await runDoctor({
      REELTERMINAL_AVE_MEDIA_ROOTS: roots.mediaRoot,
      REELTERMINAL_AVE_ARTIFACT_ROOT: roots.artifactRoot,
      REELTERMINAL_AVE_PROJECT_ROOTS: roots.projectRoot,
    });
    expect(exitCode).toBe(0);
    expect(report.verdict.classification).toBe("usable");
    const mediaRoots = report.config.roots.mediaRoots;
    expect(mediaRoots).toHaveLength(1);
    expect(mediaRoots[0].status).toBe("ok");
    expect(path.isAbsolute(mediaRoots[0].canonical)).toBe(true);
    // roots canonicalized via realpath: the reported canonical path exists
    expect(existsSync(mediaRoots[0].canonical)).toBe(true);
    expect(report.config.roots.artifactRoot.status).toBe("ok");
    expect(report.config.roots.projectRoots[0].status).toBe("ok");
    expect(report.providers.mediaImport.available).toBe(true);
    expect(report.providers.persistence.available).toBe(true);
    expect(report.verdict.reasons).toEqual([]);
  });

  it("flags a misconfigured root (relative / missing) as degraded, never refuses", async () => {
    if (!runtimeHealthy) {
      console.warn("[doctor] SKIP misconfigured root test: chromium/ffmpeg unavailable");
      return;
    }
    const { exitCode, report } = await runDoctor({
      REELTERMINAL_AVE_MEDIA_ROOTS: "relative/media",
      REELTERMINAL_AVE_ARTIFACT_ROOT: roots.artifactRoot,
      REELTERMINAL_AVE_PROJECT_ROOTS: roots.projectRoot,
    });
    expect(exitCode).toBe(1);
    expect(report.config.roots.mediaRoots[0].status).toBe("relative");
    expect(report.verdict.reasons.join("\n")).toContain('mediaRoot "relative/media" is relative');
  });

  it("warns on an over-broad root (filesystem root) and classifies degraded", async () => {
    if (!runtimeHealthy) {
      console.warn("[doctor] SKIP over-broad root test: chromium/ffmpeg unavailable");
      return;
    }
    const { exitCode, report } = await runDoctor({
      REELTERMINAL_AVE_MEDIA_ROOTS: "/",
      REELTERMINAL_AVE_ARTIFACT_ROOT: roots.artifactRoot,
      REELTERMINAL_AVE_PROJECT_ROOTS: roots.projectRoot,
    });
    expect(exitCode).toBe(1);
    expect(report.config.warnings.join("\n")).toContain("over-broad root");
    expect(report.config.roots.mediaRoots[0].overBroad).toBe(true);
  });
});

describe("doctor: orphan-artifact listing and checkpoint residue", () => {
  it("lists per-job export dirs and renders as orphans — unverifiable, never deleted", async () => {
    const exportsDir = path.join(roots.artifactRoot, "exports", "job-orphan-1");
    await mkdir(exportsDir, { recursive: true });
    await writeFile(path.join(exportsDir, "output.mp4"), Buffer.alloc(64, 7));
    const rendersDir = path.join(roots.artifactRoot, "renders");
    await mkdir(rendersDir, { recursive: true });
    await writeFile(path.join(rendersDir, "frame-x.png"), Buffer.alloc(16, 3));

    const { report } = await runDoctor({
      REELTERMINAL_AVE_ARTIFACT_ROOT: roots.artifactRoot,
      REELTERMINAL_AVE_PROJECT_ROOTS: roots.projectRoot,
    });
    const jobDir = report.orphans.jobDirs.find((j: any) => j.dir.endsWith("job-orphan-1"));
    expect(jobDir).toBeDefined();
    expect(jobDir.files.some((f: any) => f.path.endsWith("output.mp4"))).toBe(true);
    expect(jobDir.files[0].label).toContain("orphan");
    expect(jobDir.files[0].label).toContain("do not trust");
    expect(report.orphans.renders.some((f: any) => f.path.endsWith("frame-x.png"))).toBe(true);
    // never deleted
    expect(existsSync(path.join(exportsDir, "output.mp4"))).toBe(true);
  });

  it("lists stray *.tmp files under projectRoots as inert residue — never valid checkpoints", async () => {
    await writeFile(path.join(roots.projectRoot, "promo-v9.abc123.tmp"), Buffer.alloc(8, 1));
    const { report } = await runDoctor({
      REELTERMINAL_AVE_PROJECT_ROOTS: roots.projectRoot,
    });
    const residue = report.checkpoints.tmpResidue as any[];
    expect(residue.some((f) => f.path.endsWith("promo-v9.abc123.tmp"))).toBe(true);
    expect(residue[0].label).toContain("inert");
    expect(residue[0].label).toContain("never a valid checkpoint");
    // never deleted
    expect(existsSync(path.join(roots.projectRoot, "promo-v9.abc123.tmp"))).toBe(true);
  });
});

describe("doctor: exit code 2 unusable", () => {
  it("classifies unusable when ffmpeg is not resolvable (verify cannot run)", async () => {
    if (!chromiumAvailable()) {
      console.warn("[doctor] SKIP unusable test: this probe needs chromium to isolate the ffmpeg failure");
      return;
    }
    // A PATH that cannot contain ffmpeg on ANY platform: macOS keeps it in
    // /opt/homebrew/bin, but ubuntu CI apt-installs it into /usr/bin, so a
    // "minimal system PATH" still resolves it there. An empty temp dir is
    // the only deterministic hiding place (spawnCli uses the absolute
    // process.execPath, so the child node starts fine without a PATH).
    const emptyBin = await mkdtemp(path.join(tmpdir(), "ave-no-ffmpeg-"));
    try {
      const handle = spawnCli(["doctor", "--log-level", "error"], {
        PATH: emptyBin,
        REELTERMINAL_AVE_MEDIA_ROOTS: roots.mediaRoot,
        REELTERMINAL_AVE_ARTIFACT_ROOT: roots.artifactRoot,
        REELTERMINAL_AVE_PROJECT_ROOTS: roots.projectRoot,
      });
      const exitCode = await handle.exitCode;
      // The chromium runtime may still be healthy — the ffmpeg gap alone is
      // unusable per the doctor contract.
      const report = JSON.parse(handle.stdout) as DoctorReport;
      expect([1, 2]).toContain(exitCode);
      if (report.ffmpeg.available === false) {
        expect(exitCode).toBe(2);
        expect(report.verdict.classification).toBe("unusable");
      }
    } finally {
      await rm(emptyBin, { recursive: true, force: true });
    }
  }, 300_000);
});
