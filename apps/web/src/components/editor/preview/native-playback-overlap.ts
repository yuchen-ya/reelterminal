export interface VideoClipRange {
  startTime: number;
  duration: number;
}

const PLAYBACK_OVERLAP_EPSILON_SECONDS = 1e-6;

/** The ranges must be ordered by startTime. */
export function hasOverlappingSortedVideoClips(
  clips: readonly VideoClipRange[],
): boolean {
  for (let index = 0; index < clips.length - 1; index += 1) {
    const current = clips[index]!;
    const next = clips[index + 1]!;
    const currentEnd = current.startTime + current.duration;
    if (next.startTime < currentEnd - PLAYBACK_OVERLAP_EPSILON_SECONDS) {
      return true;
    }
  }

  return false;
}
