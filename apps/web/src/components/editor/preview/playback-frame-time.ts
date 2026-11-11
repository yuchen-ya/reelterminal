/** Video samples use project frame heads; transport and audio keep full time. */
export function playbackFrameTime(transportTime: number, frameRate: number): number {
  return Math.floor(transportTime * frameRate) / frameRate;
}

/** Native PTS reuse requires matching source and output frame cadence. */
export function hasMatchingNativeFrameRate(
  sourceFrameRate: number | undefined,
  projectFrameRate: number,
): boolean {
  return sourceFrameRate !== undefined &&
    Number.isFinite(sourceFrameRate) && sourceFrameRate > 0 &&
    Math.abs(sourceFrameRate - projectFrameRate) < 0.000001;
}
