/**
 * Artifact output containment + hashing + provider-preflight gates,
 * extracted verbatim from AgentFacadeSession so the live session
 * live sessions produce artifacts under their artifactRoot
 * with byte-identical discipline: real directories only (never through
 * symlinks/junctions), realpath containment before AND after every write,
 * streaming sha256 (artifacts are never buffered wholesale), and a live
 * provider preflight gate before any verb acts.
 */
import { lstat, mkdir, realpath, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { pipeline } from "node:stream/promises";

import { FacadeError } from "./errors";
import { resolveContainedPathDetailed } from "./media/path-roots";
import type { ArtifactRef } from "./providers";

/**
 * Artifact-producing verbs need an artifactRoot; its absence is a session
 * configuration gap, reported as UNSUPPORTED (never a silent temp-dir
 * fallback — outputs must live where the caller can audit them).
 */
export function requireArtifactRoot(
  configuredRoot: string | undefined,
  verb: string,
): string {
  if (configuredRoot === undefined || configuredRoot.length === 0) {
    throw new FacadeError(
      "UNSUPPORTED",
      `${verb}: no artifactRoot configured for this session — artifact-producing verbs need an explicit output root`,
    );
  }
  return resolvePath(configuredRoot);
}

/**
 * mkdir + pre-write containment gate, folded together so even a poisoned
 * path that BREAKS mkdir (e.g. a dangling junction — mkdir -p through it
 * throws ENOENT) surfaces as the clear symlink/junction refusal rather
 * than a raw internal error.
 */
export async function prepareArtifactDir(
  dir: string,
  artifactRoot: string,
  verb: string,
): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    const linkStat = await lstat(dir).catch(() => null);
    if (linkStat?.isSymbolicLink()) {
      throw new FacadeError(
        "JOB_FAILED",
        `${verb}: refusing to write through a symlink/junction in the output path: ${dir} — remove it and let the facade create a real directory`,
      );
    }
    throw new FacadeError(
      "JOB_FAILED",
      `${verb}: output directory cannot be created: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await assertSafeArtifactDir(dir, artifactRoot, verb);
}

/**
 * Pre-write output-containment gate for a DIRECTORY the facade is about to
 * let a provider write into (renders/, exports/, exports/<jobId>). Two
 * independent checks, both fail-closed:
 *
 *  1. The directory itself must NOT be a symlink/junction. A link that
 *     points inside today can be re-pointed outside between check and
 *     write (TOCTOU), so linked output dirs are rejected outright — the
 *     facade only ever creates real directories here, anything else was
 *     placed by someone else. (Node's lstat reports Windows junctions as
 *     symbolic links, so one check covers both.)
 *  2. Its realpath must stay inside the realpath of artifactRoot, so even
 *     a real directory nested under a linked ancestor fails containment.
 */
async function assertSafeArtifactDir(
  dir: string,
  artifactRoot: string,
  verb: string,
): Promise<void> {
  const dirStat = await lstat(dir).catch(() => null);
  // The link check comes FIRST: lstat does not follow links, so a
  // symlink/junction to a directory reports isDirectory() === false and
  // would otherwise mask the escape as a plain "not a directory".
  if (dirStat?.isSymbolicLink()) {
    throw new FacadeError(
      "JOB_FAILED",
      `${verb}: refusing to write through a symlink/junction in the output path: ${dir} — remove it and let the facade create a real directory`,
    );
  }
  if (!dirStat || !dirStat.isDirectory()) {
    throw new FacadeError(
      "JOB_FAILED",
      `${verb}: output directory cannot be used (missing or not a directory): ${dir}`,
    );
  }
  let realDir: string;
  let realRoot: string;
  try {
    [realDir, realRoot] = await Promise.all([
      realpath(dir),
      realpath(artifactRoot),
    ]);
  } catch (error) {
    throw new FacadeError(
      "JOB_FAILED",
      `${verb}: output directory cannot be verified (realpath failed): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (resolveContainedPathDetailed(realDir, [realRoot]).kind !== "ok") {
    throw new FacadeError(
      "JOB_FAILED",
      `${verb}: output directory escapes the configured artifactRoot: ${dir}`,
    );
  }
}

/**
 * Post-write containment gate for a FILE a provider claims to have written
 * under artifactRoot. On escape the dishonest file is removed best-effort
 * (it is the file the provider just wrote through the escape; when the
 * path itself is a symlink, unlink removes the link, never the target) and
 * the verb fails — the facade never publishes an artifact it cannot
 * contain. On success it returns the VERIFIED real path, which the caller
 * hashes/publishes (closing the swap window between check and hash).
 */
export async function assertContainedWrittenFile(
  filePath: string,
  artifactRoot: string,
  verb: string,
): Promise<string> {
  const resolution = resolveContainedPathDetailed(filePath, [artifactRoot]);
  if (resolution.kind === "ok") return resolution.path;
  await rm(filePath, { force: true }).catch(() => undefined);
  throw new FacadeError(
    "JOB_FAILED",
    `${verb}: provider wrote outside the configured artifactRoot — the file was rejected and removed`,
    { path: filePath },
  );
}

/** Streaming sha256 — artifacts are never buffered wholesale for hashing. */
export async function sha256File(absPath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(absPath), async function* (source) {
    for await (const chunk of source) {
      hash.update(chunk as Buffer);
    }
  });
  return hash.digest("hex");
}

export async function artifactRefFor(
  absPath: string,
  kind: "image" | "video",
  format: "png" | "jpeg" | "mp4",
  sourceRevision: number,
  expectedBytes?: number,
): Promise<ArtifactRef> {
  const fileStat = await stat(absPath);
  if (!fileStat.isFile() || fileStat.size === 0) {
    throw new FacadeError(
      "JOB_FAILED",
      `provider reported success but the artifact is missing or empty: ${absPath}`,
    );
  }
  if (expectedBytes !== undefined && expectedBytes > fileStat.size) {
    throw new FacadeError(
      "JOB_FAILED",
      `provider wrote fewer bytes (${fileStat.size}) than it reported (${expectedBytes}) for ${absPath}`,
    );
  }
  return {
    kind,
    format,
    path: absPath,
    sizeBytes: fileStat.size,
    sha256: await sha256File(absPath),
    sourceRevision,
  };
}

/**
 * Verbs gate on the provider's OWN live preflight: a capability that
 * reports unavailable must make the verb fail UNSUPPORTED with the same
 * reason — never a silent attempt against a dead runtime.
 */
export async function requireProviderPreflight(
  provider: { preflight(): Promise<{ available: boolean; reason?: string; requires?: string }> },
  verb: string,
): Promise<void> {
  let pre;
  try {
    pre = await provider.preflight();
  } catch (error) {
    throw new FacadeError(
      "UNSUPPORTED",
      `${verb}: provider preflight threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!pre.available) {
    throw new FacadeError(
      "UNSUPPORTED",
      `${verb}: provider is unavailable — ${pre.reason ?? "preflight failed"}`,
      pre.requires ? { requires: pre.requires } : undefined,
    );
  }
}
