/**
 * Content-addressed reuse for durable derived audio (AUD-13).
 *
 * A reuse entry is keyed by the FULL effective job identity — source content
 * sha256, audio stream index, sample-exact source range, effective
 * parameters, preprocessing/chain version AND the FFmpeg runtime version —
 * never by mediaId alone. A hit is re-validated before it is trusted: every
 * named file must still exist with the recorded sha256 and the recorded
 * algorithm version must match the running one; any mismatch drops the stale
 * entry and the job recomputes from scratch.
 *
 * The index only ever NAMES published artifacts and deletes nothing, so
 * project references, undo history and registered assets are never treated
 * as cache. Undo/redo of a registration replays retained media bytes; a
 * redo-equivalent job that misses this index simply recomputes — reuse is an
 * optimization, not a promise of zero recomputation.
 *
 * Concurrent record() calls race last-write-wins; a lost entry is only a
 * later cache miss, never a correctness issue.
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sha256File } from "./artifact-io";
import { resolveContainedPathDetailed } from "./media/path-roots";
import { stableStringify } from "./idempotency";

export const AUDIO_REUSE_INDEX_VERSION = 1;
/** Bound on tracked entries so the sidecar cannot grow without limit. */
const MAX_INDEX_ENTRIES = 256;

export type ReusableAudioKind = "audio-normalize" | "audio-denoise" | "audio-separate";

interface ReuseIndexEntry {
  readonly artifactId: string;
  readonly algorithmVersion: string;
  readonly files: Readonly<Record<string, string>>;
  readonly createdAt: string;
}

interface ReuseIndex {
  readonly version: number;
  readonly entries: Record<string, ReuseIndexEntry>;
}

export function audioReuseIndexPath(root: string, kind: ReusableAudioKind): string {
  return join(root, "generated-assets", kind, ".reuse-index.json");
}

export function computeAudioReuseKey(parts: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify({ reuseIndex: AUDIO_REUSE_INDEX_VERSION, ...parts })).digest("hex");
}

async function readIndex(indexPath: string): Promise<ReuseIndex> {
  try {
    const parsed = JSON.parse(await readFile(indexPath, "utf8")) as Partial<ReuseIndex>;
    if (parsed.version === AUDIO_REUSE_INDEX_VERSION && parsed.entries && typeof parsed.entries === "object") {
      return { version: AUDIO_REUSE_INDEX_VERSION, entries: parsed.entries as Record<string, ReuseIndexEntry> };
    }
  } catch {
    // Missing or damaged sidecar: start over; the artifacts on disk are untouched.
  }
  return { version: AUDIO_REUSE_INDEX_VERSION, entries: {} };
}

async function writeIndex(indexPath: string, index: ReuseIndex): Promise<void> {
  await mkdir(join(indexPath, ".."), { recursive: true });
  const entries = Object.entries(index.entries);
  const bounded = entries.length > MAX_INDEX_ENTRIES
    ? Object.fromEntries(entries.sort((a, b) => (a[1].createdAt < b[1].createdAt ? 1 : -1)).slice(0, MAX_INDEX_ENTRIES))
    : index.entries;
  const serialized = `${JSON.stringify({ version: AUDIO_REUSE_INDEX_VERSION, entries: bounded }, null, 2)}\n`;
  const temporary = `${indexPath}.tmp`;
  await writeFile(temporary, serialized, { encoding: "utf8" });
  await rename(temporary, indexPath);
}

export interface ReusableAudioHit {
  readonly artifactId: string;
  /** Absolute, containment-checked path of the cached output file. */
  readonly sourcePath: string;
  /** Parsed provenance of the reused artifact (already validated to exist). */
  readonly provenance: Record<string, unknown>;
}

/**
 * Look up and VALIDATE a reusable artifact. Returns null (and prunes the
 * stale entry) when the version differs, a file is missing, or its sha256 no
 * longer matches — the caller must then recompute.
 */
export async function findReusableAudioArtifact(options: {
  readonly root: string;
  readonly kind: ReusableAudioKind;
  readonly cacheKey: string;
  readonly algorithmVersion: string;
  readonly wavFilename: string;
}): Promise<ReusableAudioHit | null> {
  const indexPath = audioReuseIndexPath(options.root, options.kind);
  const index = await readIndex(indexPath);
  const entry = index.entries[options.cacheKey];
  if (!entry) return null;
  const dropStale = async () => {
    delete index.entries[options.cacheKey];
    try {
      await writeIndex(indexPath, index);
    } catch {
      // A failed prune only costs disk; the next hit re-validates and retries.
    }
  };
  if (entry.algorithmVersion !== options.algorithmVersion) {
    await dropStale();
    return null;
  }
  const artifactDir = join(options.root, "generated-assets", options.kind, entry.artifactId);
  const contained = resolveContainedPathDetailed(artifactDir, [options.root]);
  if (contained.kind !== "ok") {
    await dropStale();
    return null;
  }
  const wavPath = join(contained.path, options.wavFilename);
  const provenancePath = join(contained.path, "provenance.json");
  try {
    const [wavInfo, provenanceInfo] = await Promise.all([stat(wavPath), stat(provenancePath)]);
    if (!wavInfo.isFile() || !provenanceInfo.isFile()) throw new Error("not a file");
    const expected = entry.files[options.wavFilename];
    if (typeof expected !== "string" || await sha256File(wavPath) !== expected) throw new Error("sha mismatch");
    const provenanceBytes = await readFile(provenancePath);
    const provenanceSha = entry.files["provenance.json"];
    if (typeof provenanceSha !== "string" || createHash("sha256").update(provenanceBytes).digest("hex") !== provenanceSha) throw new Error("provenance sha mismatch");
    const provenance = JSON.parse(provenanceBytes.toString("utf8")) as Record<string, unknown>;
    if (typeof provenance.sourceSha256 !== "string") throw new Error("provenance lacks sourceSha256");
    return { artifactId: entry.artifactId, sourcePath: wavPath, provenance };
  } catch {
    await dropStale();
    return null;
  }
}

/** Stage a validated reuse hit into the caller's staging directory. */
export async function stageReusableAudioWav(hit: ReusableAudioHit, stagedWavPath: string): Promise<void> {
  await copyFile(hit.sourcePath, stagedWavPath);
}

/** Record a freshly published artifact as reusable under its cache key. */
export async function recordReusableAudioArtifact(options: {
  readonly root: string;
  readonly kind: ReusableAudioKind;
  readonly cacheKey: string;
  readonly artifactId: string;
  readonly wavFilename: string;
  readonly wavSha256: string;
  readonly algorithmVersion: string;
}): Promise<void> {
  const indexPath = audioReuseIndexPath(options.root, options.kind);
  const index = await readIndex(indexPath);
  index.entries[options.cacheKey] = {
    artifactId: options.artifactId,
    algorithmVersion: options.algorithmVersion,
    files: {
      [options.wavFilename]: options.wavSha256,
      "provenance.json": await sha256File(join(options.root, "generated-assets", options.kind, options.artifactId, "provenance.json")),
    },
    createdAt: new Date().toISOString(),
  };
  await writeIndex(indexPath, index);
}

/** Test/diagnostic hook: current index contents for one kind. */
export async function readAudioReuseIndexForTests(root: string, kind: ReusableAudioKind): Promise<ReuseIndex> {
  return readIndex(audioReuseIndexPath(root, kind));
}

/** Remove a staged reuse copy after a failed adoption (caller recomputes). */
export async function discardStagedReuseWav(stagedWavPath: string): Promise<void> {
  await rm(stagedWavPath, { force: true });
}
