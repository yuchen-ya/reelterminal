import type { Clip, Track } from "@openreel/core";

export interface PreviewTrackIndex {
  readonly clipsById: ReadonlyMap<string, Clip>;
  readonly tracksById: ReadonlyMap<string, Track>;
}

export function createPreviewTrackIndex(
  tracks: readonly Track[],
): PreviewTrackIndex {
  const clipsById = new Map<string, Clip>();
  const tracksById = new Map<string, Track>();
  for (const track of tracks) {
    tracksById.set(track.id, track);
    for (const clip of track.clips) clipsById.set(clip.id, clip);
  }
  return { clipsById, tracksById };
}

export function getActiveIndexedClips(
  tracks: readonly Track[],
  time: number,
): Clip[] {
  const active: Clip[] = [];
  for (const track of tracks) {
    if (track.hidden) continue;
    for (const clip of track.clips) {
      if (time >= clip.startTime && time < clip.startTime + clip.duration) {
        active.push(clip);
      }
    }
  }
  return active;
}
