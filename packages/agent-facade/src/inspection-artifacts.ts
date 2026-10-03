/**
 * Immutable inspection artifacts.
 *
 * Inspection evidence (visual.inspect frames and contact sheets) must behave
 * like published, addressable facts: a path that was already returned to a
 * caller keeps pointing at the same bytes forever. The historical filename
 * scheme (`contact-<project>-r<rev>-<count>-<WxH>.png`) omitted the selector
 * and the sampling plan entirely, so two inspections of DIFFERENT time
 * intervals at the same revision overwrote each other — and the failure
 * branches deleted the shared path, breaking the earlier response's
 * ArtifactRef (path, sizeBytes and sha256 all went stale).
 *
 * Two disciplines fix that:
 *
 *  1. Request-keyed names. Every artifact filename embeds a SHA-256 hash of the
 *     NORMALIZED request: selector, derived sample times, raster, frame
 *     budget, project revision and a content fingerprint of each source media
 *     file the render reads. Different requests — or the same request after a
 *     media file changed under an unchanged project revision — land on
 *     different paths and can never clobber each other. The identical
 *     idempotent request recomputes the same key and may reuse the path.
 *  2. Temp-then-publish. Renders are written to a per-attempt temp file and
 *     atomically linked into the published path only after size/budget
 *     validation succeeds. A failed or over-budget attempt discards only its
 *     own temp file; no code path ever deletes an already-published artifact.
 */
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, realpath, rm, stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

import { stableStringify } from "./idempotency";
import { assertContainedWrittenFile, sha256File } from "./artifact-io";
import { FacadeError } from "./errors";
import { resolveContainedPathDetailed } from "./media/path-roots";

/** Fingerprint of one file the render depends on (media identity + version). */
export interface MediaFingerprint {
  readonly mediaId: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  /** Full-file digest. null is reserved for a missing/non-file source. */
  readonly sha256: string | null;
}

export interface FileContentFingerprint {
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  readonly sha256: string | null;
}

interface CachedFileDigest {
  readonly signature: string;
  readonly sha256: string;
}

/**
 * A process-local LRU avoids rereading an unchanged large media file for
 * every inspection. The cache key includes nanosecond mtime/ctime plus file
 * identity; ordinary same-size rewrites with a restored mtime still change
 * ctime, while inode replacement changes ino. The digest remains the actual
 * request identity, rather than trusting these metadata fields as identity.
 */
const fileDigestCache = new Map<string, CachedFileDigest>();
const MAX_FILE_DIGEST_CACHE_ENTRIES = 256;
const MAX_PARALLEL_SOURCE_HASHES = 4;

type BigIntFileStat = Awaited<ReturnType<typeof stat>> & {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
};

async function bigintFileStat(path: string): Promise<BigIntFileStat | null> {
  const fileStat = await stat(path, { bigint: true }).catch(() => null);
  return fileStat?.isFile() ? fileStat as BigIntFileStat : null;
}

function fileStatSignature(fileStat: BigIntFileStat): string {
  return [
    fileStat.dev,
    fileStat.ino,
    fileStat.size,
    fileStat.mtimeNs,
    fileStat.ctimeNs,
  ].join(":");
}

function rememberDigest(path: string, entry: CachedFileDigest): void {
  fileDigestCache.delete(path);
  fileDigestCache.set(path, entry);
  if (fileDigestCache.size > MAX_FILE_DIGEST_CACHE_ENTRIES) {
    const oldest = fileDigestCache.keys().next().value as string | undefined;
    if (oldest !== undefined) fileDigestCache.delete(oldest);
  }
}

/**
 * Strong content identity with bounded memory. A cache miss performs one
 * streaming read of the complete file, so first inspection cost is O(file
 * bytes); unchanged follow-ups cost two stats. If the file changes during the
 * read we retry once, then fail rather than publish evidence under an
 * incoherent request key.
 */
export async function fingerprintFile(path: string): Promise<FileContentFingerprint> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await bigintFileStat(path);
    if (before === null) {
      fileDigestCache.delete(path);
      return { sizeBytes: -1, mtimeMs: -1, sha256: null };
    }
    const signature = fileStatSignature(before);
    const cached = process.platform === "win32"
      ? undefined
      : fileDigestCache.get(path);
    let sha256: string;
    if (cached?.signature === signature) {
      sha256 = cached.sha256;
    } else {
      try {
        sha256 = await sha256File(path);
      } catch (error) {
        if (attempt === 0) continue;
        throw new FacadePublishError(
          `source file could not be fingerprinted consistently: ${path}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const after = await bigintFileStat(path);
    if (after !== null && fileStatSignature(after) === signature) {
      rememberDigest(path, { signature, sha256 });
      return {
        sizeBytes: Number(after.size),
        mtimeMs: Number(after.mtimeNs / 1_000_000n),
        sha256,
      };
    }
  }
  fileDigestCache.delete(path);
  throw new FacadePublishError(
    `source file changed repeatedly while it was being fingerprinted: ${path}`,
  );
}

/**
 * Fingerprint every file behind a mediaId→path map. buildMediaFiles has
 * already verified readability; a file that vanishes before fingerprinting is
 * recorded with sentinels so the key changes and the provider subsequently
 * reports the missing source rather than reusing earlier evidence.
 */
export async function fingerprintMediaFiles(
  files: Record<string, string>,
): Promise<readonly MediaFingerprint[]> {
  const sources = Object.entries(files)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const fingerprints = new Array<MediaFingerprint>(sources.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(MAX_PARALLEL_SOURCE_HASHES, sources.length) },
    async () => {
      for (;;) {
        const index = nextIndex++;
        if (index >= sources.length) return;
        const [mediaId, path] = sources[index];
        fingerprints[index] = {
          mediaId,
          path,
          ...await fingerprintFile(path),
        };
      }
    },
  );
  await Promise.all(workers);
  return fingerprints;
}

/**
 * Revalidate the exact sources after a provider render and before publishing
 * its temp output. Metadata-cache hits make the unchanged path stat-only;
 * changes force a fresh full digest. The caller owns and must discard its temp
 * when this throws.
 */
export async function assertMediaFingerprintsUnchanged(
  files: Record<string, string>,
  expected: readonly MediaFingerprint[],
  verb: string,
): Promise<void> {
  const current = await fingerprintMediaFiles(files);
  if (stableStringify(current) !== stableStringify(expected)) {
    throw new FacadeError(
      "CONFLICT",
      `${verb}: source media changed during inspection; retry against its new version`,
      { expected, current },
    );
  }
}

/** All request inputs that change the rendered bytes, in normalized form. */
export interface InspectionRequestParts {
  readonly projectId: string;
  readonly revision: number;
  readonly selector:
    | { readonly kind: "preview"; readonly timeSec: number }
    | { readonly kind: "clip"; readonly clipId: string }
    | { readonly kind: "timeRange"; readonly startSec: number; endSec: number }
    /** Comparison artifacts key the full shared config + reference fingerprint. */
    | { readonly kind: "comparison"; readonly [key: string]: unknown };
  /** Derived sampling plan (ms-rounded): the times actually rendered. */
  readonly sampleTimesMs: readonly number[];
  readonly width: number;
  readonly height: number;
  readonly maxFrameBytes: number;
  readonly media: readonly MediaFingerprint[];
}

/**
 * Stable key for one inspection request. stableStringify sorts object keys,
 * so key order never matters. Keep all 256 digest bits: truncating to 40 bits
 * makes collisions plausible for a long-lived library of inspection evidence.
 */
export function inspectionRequestKey(parts: InspectionRequestParts): string {
  return createHash("sha256")
    .update(stableStringify({ v: 3, ...parts }))
    .digest("hex");
}

/**
 * Temp path for one publish attempt. Same extension as the final artifact
 * (frame-budget.ts derives the JPEG path by swapping the .png extension, so
 * the temp must keep it); the leading dot keeps abandoned attempts out of
 * normal listings — publish() or discard() always cleans them up.
 */
export function pendingArtifactPath(
  dir: string,
  finalStem: string,
  ext: "png" | "jpg",
): string {
  return resolvePath(dir, `.${finalStem}.${randomUUID()}.${ext}`);
}

/** Verify a pre-existing destination without ever unlinking it on failure. */
async function assertReusablePublishedFile(
  finalPath: string,
  artifactRoot: string,
  verb: string,
): Promise<string> {
  const existingStat = await lstat(finalPath);
  if (!existingStat.isFile() || existingStat.isSymbolicLink()) {
    throw new Error("the published path exists but is not a regular file");
  }
  const [realFinal, realRoot] = await Promise.all([
    realpath(finalPath),
    realpath(artifactRoot),
  ]);
  if (resolveContainedPathDetailed(realFinal, [realRoot]).kind !== "ok") {
    throw new Error(`${verb}: the published path escapes artifactRoot`);
  }
  return realFinal;
}

/**
 * Atomically publish a fully validated temp file without replacement. A hard
 * link is an atomic create-if-absent operation because pending and final files
 * live in the same directory/filesystem. Unlike rename(), it cannot replace a
 * path another attempt already published.
 *
 * Concurrent identical attempts may reuse the winner only after full-content
 * comparison. If an existing path has different bytes, publication fails
 * explicitly: returning it would misreport the just-rendered evidence, while
 * replacing it would invalidate the earlier ArtifactRef. On every failure only
 * this attempt's temp is discarded; the final path is never removed.
 */
export async function publishArtifact(params: {
  readonly tempPath: string;
  readonly finalPath: string;
  readonly artifactRoot: string;
  readonly verb: string;
}): Promise<string> {
  const { tempPath, finalPath, artifactRoot, verb } = params;
  if (resolvePath(tempPath) === resolvePath(finalPath)) {
    throw new FacadePublishError(
      `${verb}: temp and published artifact paths must be distinct: ${finalPath}`,
    );
  }
  let verifiedTemp: string;
  try {
    verifiedTemp = await assertContainedWrittenFile(tempPath, artifactRoot, verb);
    await link(verifiedTemp, finalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      try {
        const verifiedFinal = await assertReusablePublishedFile(finalPath, artifactRoot, verb);
        const [candidateHash, existingHash] = await Promise.all([
          sha256File(verifiedTemp!),
          sha256File(verifiedFinal),
        ]);
        if (candidateHash !== existingHash) {
          throw new Error(
            "the published path already contains different bytes; refusing to overwrite immutable evidence",
          );
        }
        await rm(tempPath, { force: true }).catch(() => undefined);
        return verifiedFinal;
      } catch (reuseError) {
        await rm(tempPath, { force: true }).catch(() => undefined);
        throw new FacadePublishError(
          `${verb}: failed to reuse inspection artifact at ${finalPath}: ${
            reuseError instanceof Error ? reuseError.message : String(reuseError)
          }`,
        );
      }
    } else {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw new FacadePublishError(
        `${verb}: failed to publish inspection artifact at ${finalPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  await rm(tempPath, { force: true }).catch(() => undefined);
  return assertContainedWrittenFile(finalPath, artifactRoot, verb);
}

/** Discard a temp attempt without touching any published artifact. */
export async function discardArtifact(tempPath: string): Promise<void> {
  await rm(tempPath, { force: true }).catch(() => undefined);
}

/** Typed job failure: callers expose publication/fingerprint failures honestly. */
export class FacadePublishError extends FacadeError {
  constructor(message: string) {
    super("JOB_FAILED", message);
    this.name = "FacadePublishError";
  }
}
