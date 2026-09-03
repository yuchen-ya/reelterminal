import type { Track } from "@openreel/core";

export interface IndexedTrack<T> {
  track: T;
  originalIndex: number;
}

export const isOverlayTrackType = (type: Track["type"]): boolean =>
  type === "text" || type === "graphics";

/**
 * Painter order for the paused composite. Playing and export always draw
 * text/graphics overlays above video, so the paused path must match: video
 * and image tracks paint first, overlay tracks last, preserving
 * higher-index-first painter order within each group.
 */
export function compareTracksForComposite<T extends { type: Track["type"] }>(
  a: IndexedTrack<T>,
  b: IndexedTrack<T>,
): number {
  const aOverlay = isOverlayTrackType(a.track.type) ? 1 : 0;
  const bOverlay = isOverlayTrackType(b.track.type) ? 1 : 0;
  if (aOverlay !== bOverlay) return aOverlay - bOverlay;
  return b.originalIndex - a.originalIndex;
}
