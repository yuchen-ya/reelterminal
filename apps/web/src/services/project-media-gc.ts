import type { Project } from "@openreel/core";
import { historyRetainsMediaBytes } from "@openreel/core";
import type { ActionHistory } from "@openreel/core";
import {
  deleteMediaBlob,
  getMediaIdsByProject,
} from "./media-storage";

/**
 * Lazily reclaim persisted media bytes that no longer have an owner: neither
 * the open project's media library nor a history entry that could still
 * restore them. Bytes are stored separately from the project JSON, so deletion
 * must stay deferred while an entry sits anywhere in the undo/redo history;
 * undoing a delete would otherwise be permanent data loss.
 *
 * Every trigger runs the same idempotent scan, so a skipped or failed pass is
 * corrected by the next one — there is no retry queue.
 */

/**
 * Bytes persisted by an import whose project entry is not published yet (the
 * commit is still in flight). Reconciliation must treat them as live even
 * though no item and no history entry references them yet.
 */
const uncommittedBlobIds = new Set<string>();

export function trackUncommittedMediaBlob(mediaId: string): void {
  uncommittedBlobIds.add(mediaId);
}

export function releaseUncommittedMediaBlob(mediaId: string): void {
  uncommittedBlobIds.delete(mediaId);
}

async function reclaimBytes(mediaIds: string[]): Promise<void> {
  for (const mediaId of mediaIds) {
    if (uncommittedBlobIds.has(mediaId)) continue;
    try {
      await deleteMediaBlob(mediaId);
    } catch {
      // Already gone or transiently unavailable; the next scan self-heals.
    }
  }
}

/** A failed listing keeps every byte; the next successful scan reclaims. */
async function listStoredIds(projectId: string): Promise<string[]> {
  try {
    return await getMediaIdsByProject(projectId);
  } catch {
    return [];
  }
}

function liveMediaIds(project: Project): Set<string> {
  return new Set(project.mediaLibrary.items.map((item) => item.id));
}

/**
 * Deletes bytes for `project` that no item references and no history entry can
 * still restore. Safe to call at any time; it never touches live or restorable
 * bytes.
 */
export async function reconcileProjectMediaBytes(
  project: Project,
  history: ActionHistory,
): Promise<void> {
  const liveIds = liveMediaIds(project);
  const storedIds = await listStoredIds(project.id);
  const reclaimable = storedIds.filter(
    (mediaId) =>
      !liveIds.has(mediaId) && !historyRetainsMediaBytes(history, mediaId),
  );
  await reclaimBytes(reclaimable);
}

/**
 * Final pass before a project's history is discarded (project switch or
 * close): without history nothing is restorable, so every byte outside the
 * saved items is orphaned.
 */
export async function flushProjectMediaBytes(project: Project): Promise<void> {
  const liveIds = liveMediaIds(project);
  const storedIds = await listStoredIds(project.id);
  const reclaimable = storedIds.filter((mediaId) => !liveIds.has(mediaId));
  await reclaimBytes(reclaimable);
}

/**
 * Crash-safety net run right after a project load. The freshly created session
 * history is empty, so old deletes can never be undone again and every byte
 * outside the loaded items is a leftover orphan (an interrupted import commit
 * included).
 */
export async function sweepOrphanProjectMedia(project: Project): Promise<void> {
  const liveIds = liveMediaIds(project);
  const storedIds = await listStoredIds(project.id);
  const reclaimable = storedIds.filter((mediaId) => !liveIds.has(mediaId));
  await reclaimBytes(reclaimable);
}

/**
 * Wires the eviction callback of a live project history into reconciliation.
 * Eviction means entries left the history for good, so their restorable bytes
 * become reclaimable. The project getter may briefly observe a pre-mutation
 * state while an action is still publishing; that only delays a reclaim to a
 * later scan, never deletes bytes that are still needed.
 */
export function attachProjectMediaGc(
  history: ActionHistory,
  getProject: () => Project,
): void {
  history.setEvictionListener(() => {
    void reconcileProjectMediaBytes(getProject(), history);
  });
}

const attachedHistories = new WeakSet<ActionHistory>();

/**
 * Idempotent variant for histories created outside the store slices (the
 * initial store history). Media mutations call this so the history carrying
 * their entries is always observed.
 */
export function ensureProjectMediaGc(
  history: ActionHistory,
  getProject: () => Project,
): void {
  if (attachedHistories.has(history)) return;
  attachedHistories.add(history);
  attachProjectMediaGc(history, getProject);
}
