/** A decoder is owned by a clip: one source can appear at different times. */
export function scrubVideoCacheKey(clipId: string, mediaId: string, stabilized: boolean): string {
  return JSON.stringify([clipId, mediaId, stabilized]);
}

/** Keep the active composition resident, while sequential seeks stay bounded. */
export function scrubVideoCacheLimit(
  tracks: readonly { type: string; hidden?: boolean; clips: readonly { id: string; mediaId: string; startTime: number; duration: number }[] }[],
  time: number,
  mediaType: (id: string) => string | undefined,
): number {
  const active = new Set<string>();
  for (const track of tracks) {
    if (track.hidden || (track.type !== "video" && track.type !== "image")) continue;
    for (const clip of track.clips) {
      if (time >= clip.startTime && time < clip.startTime + clip.duration && mediaType(clip.mediaId) === "video") active.add(clip.id);
    }
  }
  return Math.max(2, active.size);
}
