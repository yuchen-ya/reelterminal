import { v4 as uuidv4 } from "uuid";
import type { Action, Clip } from "@reelterminal/core";
import { getLinkedCaptions, type LinkedCaptionEditStore } from "./linked-caption-edit";

export interface TimelineClipMove {
  readonly clipId: string;
  readonly startTime: number;
  readonly trackId?: string;
}

type ClipMoveActionStore = Pick<LinkedCaptionEditStore, "project" | "getAllTextClips"> & {
  getClip: (clipId: string) => Clip | undefined;
};

/** Build one atomic action batch for the final state of a timeline move gesture. */
export function buildClipMoveActionBatch(
  store: ClipMoveActionStore,
  moves: readonly TimelineClipMove[],
): Action[] {
  const uniqueMoves = new Map<string, TimelineClipMove>();
  for (const move of moves) uniqueMoves.set(move.clipId, move);

  const actions: Action[] = [];
  const changedSources: Array<{ clip: Clip; delta: number }> = [];
  for (const move of uniqueMoves.values()) {
    const clip = store.getClip(move.clipId);
    if (!clip) continue;
    const startTime = Math.max(0, move.startTime);
    if (startTime === clip.startTime && (!move.trackId || move.trackId === clip.trackId)) continue;
    actions.push({
      type: "clip/move",
      id: uuidv4(),
      timestamp: Date.now(),
      params: { clipId: move.clipId, startTime, trackId: move.trackId },
    });
    changedSources.push({ clip, delta: startTime - clip.startTime });
  }

  const captionStartTimes = new Map<string, number>();
  for (const { clip, delta } of changedSources) {
    if (delta === 0) continue;
    for (const caption of getLinkedCaptions(store, clip)) {
      captionStartTimes.set(caption.id, Math.max(0, caption.startTime + delta));
    }
  }
  for (const [clipId, startTime] of captionStartTimes) {
    actions.push({
      type: "text/update",
      id: uuidv4(),
      timestamp: Date.now(),
      params: { clipId, updates: { startTime } },
    });
  }
  return actions;
}
