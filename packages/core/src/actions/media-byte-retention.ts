import type { Action } from "../types/actions";
import type { HistoryEntry } from "./action-history";

/**
 * Whether persisted media bytes for `mediaId` must be kept because the undo
 * history can still bring their project entry back. Media bytes live in a
 * separate store from the project JSON, so reclaiming them eagerly would turn
 * every undone delete into permanent data loss.
 *
 * An entry on EITHER stack retains bytes: undo() moves the same entry from the
 * undo stack to the redo stack, and redo() moves it back, so a delete that was
 * undone keeps its bytes until the entry leaves the history entirely.
 */
export function entryRetainsMediaBytes(
  entry: HistoryEntry,
  mediaId: string,
): boolean {
  if (entryRetainedByAction(entry.action, mediaId)) return true;
  const inverse = entry.inverseAction;
  return inverse !== null && entryRetainedByInverse(inverse, mediaId);
}

function entryRetainedByAction(action: Action, mediaId: string): boolean {
  const params = action.params as Record<string, unknown>;
  if (action.type === "media/delete") {
    return params.mediaId === mediaId;
  }
  if (action.type === "media/import") {
    // An import that sits on the redo stack (it was undone) still needs its
    // bytes for a redo. The full item rides in the action params, so match on
    // its stable id instead of resolving the "__LAST_ADDED__" marker that the
    // inverse delete action carries.
    const mediaItem = params.mediaItem as { id?: unknown } | undefined;
    return mediaItem?.id === mediaId;
  }
  return false;
}

function entryRetainedByInverse(inverse: Action, mediaId: string): boolean {
  if (inverse.type !== "media/restore") return false;
  const params = inverse.params as Record<string, unknown>;
  const mediaItem = params.mediaItem as { id?: unknown } | undefined;
  return mediaItem?.id === mediaId;
}

/**
 * Convenience scan over a full history. Returns true as soon as any entry on
 * the undo or redo stack retains bytes for `mediaId`.
 */
export function historyRetainsMediaBytes(
  history: {
    getHistoryEntries(): HistoryEntry[];
    getRedoEntries(): HistoryEntry[];
  },
  mediaId: string,
): boolean {
  for (const entry of history.getHistoryEntries()) {
    if (entryRetainsMediaBytes(entry, mediaId)) return true;
  }
  for (const entry of history.getRedoEntries()) {
    if (entryRetainsMediaBytes(entry, mediaId)) return true;
  }
  return false;
}
