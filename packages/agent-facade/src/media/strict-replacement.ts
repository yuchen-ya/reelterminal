import { stat } from "node:fs/promises";
import { FacadeError } from "../errors";
import { resolveContainedPathDetailed } from "./path-roots";
import { resolveToolFfmpeg } from "./ffmpeg-bin";
import { probeVideoFacts } from "./frame-exact";

/** Shared by CLI replacement and the desktop's candidate-adoption preflight. */
export async function verifyReplacementFrames(
  sourcePath: string,
  candidatePath: string,
  mediaRoots: readonly string[],
): Promise<{ frameCount: number; frameRate: number; durationSec: number }> {
  const paths = [sourcePath, candidatePath].map((file) => {
    const resolved = resolveContainedPathDetailed(file, mediaRoots);
    if (resolved.kind !== "ok")
      throw new FacadeError(
        "INVALID_PARAMS",
        "Strict replacement requires file-backed sources inside configured media roots",
      );
    return resolved.path;
  });
  const binaries = await resolveToolFfmpeg();
  if (!binaries)
    throw new FacadeError(
      "UNSUPPORTED",
      "Strict replacement requires local FFmpeg/FFprobe",
    );
  const initialStats = await Promise.all(paths.map((file) => stat(file)));
  const [before, after] = await Promise.all(
    paths.map((file) =>
      probeVideoFacts(binaries.ffprobe, file, { decodedFrameCount: true }),
    ),
  );
  const finalStats = await Promise.all(paths.map((file) => stat(file)));
  if (
    initialStats.some(
      (initial, i) =>
        initial.size !== finalStats[i].size ||
        initial.mtimeMs !== finalStats[i].mtimeMs,
    )
  ) {
    throw new FacadeError(
      "CONFLICT",
      "Source file changed during strict verification",
    );
  }
  if (
    before.timing.timing !== "cfr" ||
    after.timing.timing !== "cfr" ||
    !before.decodedFrameCount ||
    !after.decodedFrameCount ||
    !before.timing.fps ||
    !after.timing.fps
  ) {
    throw new FacadeError(
      "UNSUPPORTED",
      "Strict replacement requires complete decoded counts and verified CFR timing for both sources",
    );
  }
  if (
    before.decodedFrameCount !== after.decodedFrameCount ||
    Math.abs(before.timing.fps - after.timing.fps) > before.timing.fps * 1e-6
  ) {
    throw new FacadeError(
      "INVALID_PARAMS",
      "Strict replacement must preserve decoded frame count and frame rate",
      {
        sourceFrames: before.decodedFrameCount,
        replacementFrames: after.decodedFrameCount,
      },
    );
  }
  return {
    frameCount: before.decodedFrameCount,
    frameRate: before.timing.fps,
    durationSec: before.decodedFrameCount / before.timing.fps,
  };
}
