import type { Track } from "@reelterminal/core";

/** The fullscreen transition shortcut cannot represent additional video layers. */
export function hasLayeredTransition(
  tracks: readonly Track[],
  time: number,
  transition: { clipA: { id: string }; clipB?: { id: string } | null } | null,
): boolean {
  if (!transition) return false;
  return tracks.some(track => !track.hidden && (track.type === "video" || track.type === "image") && track.clips.some(clip =>
    clip.id !== transition.clipA.id && clip.id !== transition.clipB?.id && time >= clip.startTime && time < clip.startTime + clip.duration));
}
