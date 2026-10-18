/**
 * Startup lifecycle hygiene for durable audio artifacts (AUD-13).
 *
 * A forced exit can strand `.<artifactId>.<pid>.<uuid>.pending` staging
 * directories under generated-assets/audio-*: they were never published,
 * nothing can reference them, and their owning task is honestly reported
 * INTERRUPTED by the durable task ledger. This sweep removes EXACTLY those
 * directories and nothing else.
 *
 * Published artifact directories — registered or not — are never touched:
 * a completed-but-unregistered job can still be registered through its
 * retained jobId, and deleting anything referenced by the project, its undo
 * history or registered media would lose user data. The reuse index sidecar
 * (`audio-artifact-reuse.ts`) is a dot-file without the `.pending` suffix
 * and does not match the staging pattern.
 */
import { readdir, rm, lstat } from "node:fs/promises";
import { join } from "node:path";

import { resolveContainedPathDetailed } from "./media/path-roots";

export const AUDIO_ARTIFACT_KIND_DIRS = ["audio-normalize", "audio-denoise", "audio-separate"] as const;

/** Legacy directories without an owner PID cannot be proven abandoned. */
export const AUDIO_ARTIFACT_STAGING_PATTERN = /^\.[A-Za-z0-9_-]{1,128}\.([1-9][0-9]*)\.[0-9a-fA-F-]{36}\.pending$/;

function ownerHasExited(pid: number): boolean {
  if (!Number.isSafeInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM and reused/live PIDs are deliberately retained.
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Remove abandoned staging directories under the configured media roots.
 * Returns the removed paths for logging; a per-entry failure skips that
 * entry rather than aborting the sweep (the next startup retries it).
 */
export async function sweepAbandonedAudioArtifactStaging(mediaRoots: readonly string[]): Promise<string[]> {
  const removed: string[] = [];
  for (const mediaRoot of mediaRoots) {
    for (const kind of AUDIO_ARTIFACT_KIND_DIRS) {
      const kindDir = join(mediaRoot, "generated-assets", kind);
      let entries: string[];
      try {
        entries = await readdir(kindDir);
      } catch {
        continue; // no artifacts of this kind yet
      }
      for (const name of entries) {
        const match = AUDIO_ARTIFACT_STAGING_PATTERN.exec(name);
        if (!match || !ownerHasExited(Number(match[1]))) continue;
        const target = join(kindDir, name);
        try {
          const info = await lstat(target);
          if (!info.isDirectory() || info.isSymbolicLink()) continue;
          if (resolveContainedPathDetailed(target, [mediaRoot]).kind !== "ok") continue;
          await rm(target, { recursive: true, force: true });
          removed.push(target);
        } catch {
          // Skipping is safe: an unremovable staging dir is only disk usage.
        }
      }
    }
  }
  return removed;
}
