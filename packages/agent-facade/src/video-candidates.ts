/**
 * Local video candidate analyses (optimization plan M1) backing the
 * media.analyze_start types `sceneCuts`, `blackFrames` and `duplicateFrames`.
 *
 * These run inside the EXISTING analysis job system (queued/running/done
 * with progress, cooperative cancellation via the AbortSignal, durable
 * analysis records and recheck linkage). Everything they return is a
 * CANDIDATE with parameters and limitations — there is deliberately no
 * pass/fail concept and no automatic timeline change.
 */
import type { MediaAnalysisType } from "./types";
import { FacadeError } from "./errors";
import { ffmpegToolPreflight } from "./media/ffmpeg-bin";
import {
  detectBlackCandidates,
  detectFreezeCandidates,
  detectSceneCandidates,
  probeVideoFacts,
  type RangeCandidate,
  type SceneCandidate,
  type VideoFacts,
} from "./media/frame-exact";

export const VIDEO_CANDIDATE_TYPES: readonly MediaAnalysisType[] = ["sceneCuts", "blackFrames", "duplicateFrames"];

/** Tuned defaults; reported verbatim in each result so reruns are comparable. */
export const SCENE_CUTS_DEFAULTS = { threshold: 0.25 } as const;
export const BLACK_FRAMES_DEFAULTS = { minDurationSec: 0.05, pixelThreshold: 0.1 } as const;
export const DUPLICATE_FRAMES_DEFAULTS = { minDurationSec: 0.3, noiseThreshold: 0.001 } as const;

export async function videoCandidatesPreflight() {
  return ffmpegToolPreflight();
}

/** Shared facts probe for the candidate detectors (one CFR/VFR assessment). */
export async function probeCandidateFacts(ffprobe: string, sourcePath: string, signal: AbortSignal): Promise<VideoFacts> {
  return probeVideoFacts(ffprobe, sourcePath, { signal });
}

export async function analyzeSceneCuts(
  ffmpeg: string,
  sourcePath: string,
  range: { startSec: number; endSec: number },
  facts: VideoFacts,
  signal: AbortSignal,
  progress: (percent: number) => void = () => {},
) {
  const { candidates, limitations } = await detectSceneCandidates(
    ffmpeg, sourcePath, range, SCENE_CUTS_DEFAULTS, facts,
    { signal, onProgress: (seconds) => progress(Math.min(1, seconds / Math.max(0.001, range.endSec - range.startSec))) },
  );
  const MAX_CANDIDATES = 2000;
  return {
    coordinateSpace: "source" as const,
    ...range,
    frameTiming: facts.timing,
    parameters: SCENE_CUTS_DEFAULTS,
    // Each candidate's frameIndex IS the representative frame: the first
    // frame of the new shot (null when timing is not verified CFR).
    candidates: candidates.slice(0, MAX_CANDIDATES),
    candidateCount: candidates.length,
    truncated: candidates.length > MAX_CANDIDATES,
    algorithm: "FFmpeg select filter scene score — inter-frame SAD over the LUMA plane only (libavfilter ff_scene_sad, shared with the framerate filter). This is a plain pixel-difference detector, NOT PySceneDetect HSV-Content: its sensitivity to chroma-only cuts and graded transitions differs. Local FFmpeg only, no model fallback",
    limitations: [...limitations,
      "Candidates, never edits: nothing is cut or marked; verify boundaries with frames.extract / a contact sheet before acting."],
  };
}

export async function analyzeBlackFrames(
  ffmpeg: string,
  sourcePath: string,
  range: { startSec: number; endSec: number },
  facts: VideoFacts,
  signal: AbortSignal,
  progress: (percent: number) => void = () => {},
) {
  const { candidates, limitations } = await detectBlackCandidates(
    ffmpeg, sourcePath, range, BLACK_FRAMES_DEFAULTS, facts,
    { signal, onProgress: (seconds) => progress(Math.min(1, seconds / Math.max(0.001, range.endSec - range.startSec))) },
  );
  const MAX_CANDIDATES = 2000;
  return {
    coordinateSpace: "source" as const,
    ...range,
    frameTiming: facts.timing,
    parameters: BLACK_FRAMES_DEFAULTS,
    candidates: candidates.slice(0, MAX_CANDIDATES),
    candidateCount: candidates.length,
    truncated: candidates.length > MAX_CANDIDATES,
    algorithm: "FFmpeg blackdetect luma-threshold ranges — local measurement, not a review verdict",
    limitations,
  };
}

export async function analyzeDuplicateFrames(
  ffmpeg: string,
  sourcePath: string,
  range: { startSec: number; endSec: number },
  facts: VideoFacts,
  signal: AbortSignal,
  progress: (percent: number) => void = () => {},
) {
  const { candidates, limitations } = await detectFreezeCandidates(
    ffmpeg, sourcePath, range, DUPLICATE_FRAMES_DEFAULTS, facts,
    { signal, onProgress: (seconds) => progress(Math.min(1, seconds / Math.max(0.001, range.endSec - range.startSec))) },
  );
  const MAX_CANDIDATES = 2000;
  return {
    coordinateSpace: "source" as const,
    ...range,
    frameTiming: facts.timing,
    parameters: DUPLICATE_FRAMES_DEFAULTS,
    candidates: candidates.slice(0, MAX_CANDIDATES),
    candidateCount: candidates.length,
    truncated: candidates.length > MAX_CANDIDATES,
    algorithm: "FFmpeg freezedetect noise-threshold repetition ranges — FROZEN/near-static INTERVAL candidates (consecutive near-identical frames), NOT arbitrary duplicate-frame retrieval: two identical frames far apart in time, or similar-but-not-consecutive frames, are not found by this detector",
    limitations: [...limitations,
      "Duplicate/repetition semantics: these are frozen/near-static interval candidates only (freezedetect compares consecutive frames). Non-consecutive duplicate retrieval is a different, unsupported capability.",
      "Intentional freeze frames, static graphics and still shots repeat legitimately — these are review candidates, never failures."],
  };
}

/** Run every requested video-candidate analysis in one pass over shared facts. */
export async function runVideoCandidateAnalyses(
  binaries: { ffmpeg: string; ffprobe: string },
  sourcePath: string,
  range: { startSec: number; endSec: number },
  analysisTypes: readonly MediaAnalysisType[],
  signal: AbortSignal,
  progress: (percent: number) => void = () => {},
): Promise<{
  sceneCuts?: Awaited<ReturnType<typeof analyzeSceneCuts>>;
  blackFrames?: Awaited<ReturnType<typeof analyzeBlackFrames>>;
  duplicateFrames?: Awaited<ReturnType<typeof analyzeDuplicateFrames>>;
  facts: VideoFacts;
}> {
  const wanted = VIDEO_CANDIDATE_TYPES.filter((type) => analysisTypes.includes(type));
  if (wanted.length === 0) throw new FacadeError("INVALID_PARAMS", "no video-candidate analysis types requested");
  const ready = await videoCandidatesPreflight();
  if (!ready.available) throw new FacadeError("UNSUPPORTED", ready.reason);
  const facts = await probeCandidateFacts(binaries.ffprobe, sourcePath, signal);
  const share = (index: number) => (percent: number) => progress((index + percent) / wanted.length);
  const results: Awaited<ReturnType<typeof runVideoCandidateAnalyses>> = { facts };
  for (const [index, type] of wanted.entries()) {
    if (signal.aborted) throw new FacadeError("JOB_FAILED", "Cancelled");
    if (type === "sceneCuts") {
      results.sceneCuts = await analyzeSceneCuts(binaries.ffmpeg, sourcePath, range, facts, signal, share(index));
    } else if (type === "blackFrames") {
      results.blackFrames = await analyzeBlackFrames(binaries.ffmpeg, sourcePath, range, facts, signal, share(index));
    } else if (type === "duplicateFrames") {
      results.duplicateFrames = await analyzeDuplicateFrames(binaries.ffmpeg, sourcePath, range, facts, signal, share(index));
    }
  }
  return results;
}

/** Type used by the session bodies to merge results into the job summary. */
export type VideoCandidateBundle = Awaited<ReturnType<typeof runVideoCandidateAnalyses>>;

export type { RangeCandidate, SceneCandidate };
