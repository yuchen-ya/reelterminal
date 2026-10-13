import { DEFAULT_DURATION_THRESHOLDS, nearestRankPercentile } from "@reelterminal/core/performance/types";

export type PlaybackAvMetricStatus =
  | "ok"
  | "unsupported"
  | "not_applicable"
  | "insufficient_samples";

export interface PlaybackAvDistribution {
  readonly status: PlaybackAvMetricStatus;
  readonly n: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
}

export interface OutputTimestampEstimate {
  readonly status: "ok" | "unsupported";
  readonly reason?: "api_unavailable" | "invalid_timestamp";
  readonly outputContextTimeSec: number | null;
  readonly masterPtsSec: number | null;
}

export interface OutputTimelineAnchor {
  readonly contextTimeSec: number;
  readonly masterPtsSec: number;
  readonly masterRate: number;
}

export interface AudioOutputTimestampSample {
  readonly contextTime?: number;
  readonly performanceTime?: number;
}

export const PCM_MARKER_INTERVAL_SECONDS = 0.25;
export const PCM_MARKER_LEVEL_COUNT = 32;
export const VIDEO_MARKER_INTERVAL_SECONDS = 0.2;
export const VIDEO_MARKER_LEVEL_COUNT = 40;
const PCM_MARKER_BASE_LEVEL = 0.08;
const PCM_MARKER_LEVEL_STEP = 0.018;
const VIDEO_MARKER_BASE_GRAY = 32;
const VIDEO_MARKER_GRAY_STEP = 5;

/** Encode the source-time bucket in a low-level amplitude envelope for PCM evidence. */
export function pcmMarkerAmplitude(sourcePtsSec: number): number {
  if (!Number.isFinite(sourcePtsSec) || sourcePtsSec < 0) {
    throw new RangeError("source PTS must be finite and non-negative");
  }
  const bucket = Math.floor((sourcePtsSec + 1e-9) / PCM_MARKER_INTERVAL_SECONDS);
  if (bucket >= PCM_MARKER_LEVEL_COUNT) throw new RangeError("PCM marker is outside its eight-second fixture");
  return PCM_MARKER_BASE_LEVEL + bucket * PCM_MARKER_LEVEL_STEP;
}

/** Deterministic grayscale level for one source-time bucket in the synthetic video fixture. */
export function videoMarkerGray(sourcePtsSec: number): number {
  if (!Number.isFinite(sourcePtsSec) || sourcePtsSec < 0) {
    throw new RangeError("source PTS must be finite and non-negative");
  }
  const bucket = Math.floor((sourcePtsSec + 1e-9) / VIDEO_MARKER_INTERVAL_SECONDS);
  if (bucket >= VIDEO_MARKER_LEVEL_COUNT) throw new RangeError("video marker is outside its eight-second fixture");
  return VIDEO_MARKER_BASE_GRAY + bucket * VIDEO_MARKER_GRAY_STEP;
}

/** Recover the time-coded synthetic video PTS from its decoded center-pixel luma. */
export function decodeVideoMarkerSourcePts(gray: number): number | null {
  if (!Number.isFinite(gray)) return null;
  const bucketFloat = (gray - VIDEO_MARKER_BASE_GRAY) / VIDEO_MARKER_GRAY_STEP;
  const bucket = Math.round(bucketFloat);
  if (bucket < 0 || bucket >= VIDEO_MARKER_LEVEL_COUNT || Math.abs(bucketFloat - bucket) > 0.35) return null;
  return (bucket + 0.5) * VIDEO_MARKER_INTERVAL_SECONDS;
}

/** Decode one unique RMS level without using expected PTS to disambiguate it. */
export function decodePcmMarkerSourcePts(rms: number): number | null {
  if (!Number.isFinite(rms) || rms <= 0) {
    return null;
  }
  const amplitude = rms / Math.SQRT1_2;
  const bucketFloat = (amplitude - PCM_MARKER_BASE_LEVEL) / PCM_MARKER_LEVEL_STEP;
  const bucket = Math.round(bucketFloat);
  if (bucket < 0 || bucket >= PCM_MARKER_LEVEL_COUNT || Math.abs(bucketFloat - bucket) > 0.3) {
    return null;
  }

  return (bucket + 0.5) * PCM_MARKER_INTERVAL_SECONDS;
}

/** Estimate master PTS at the callback's wall-clock time from Web Audio's output clock pair. */
export function estimateOutputTimestampMasterPts(
  timestamp: AudioOutputTimestampSample | null | undefined,
  nowPerformanceTimeMs: number,
  anchor: OutputTimelineAnchor,
): OutputTimestampEstimate {
  const unavailable = (reason: OutputTimestampEstimate["reason"]): OutputTimestampEstimate => ({
    status: "unsupported",
    reason,
    outputContextTimeSec: null,
    masterPtsSec: null,
  });
  if (!timestamp) return unavailable("api_unavailable");
  if (
    (timestamp.contextTime === 0 && timestamp.performanceTime === 0) ||
    typeof timestamp.contextTime !== "number" || !Number.isFinite(timestamp.contextTime) || timestamp.contextTime < 0 ||
    typeof timestamp.performanceTime !== "number" || !Number.isFinite(timestamp.performanceTime) || timestamp.performanceTime < 0 ||
    !Number.isFinite(nowPerformanceTimeMs) || nowPerformanceTimeMs < 0 ||
    !Number.isFinite(anchor.contextTimeSec) || anchor.contextTimeSec < 0 ||
    !Number.isFinite(anchor.masterPtsSec) || anchor.masterPtsSec < 0 ||
    !Number.isFinite(anchor.masterRate) || anchor.masterRate <= 0
  ) {
    return unavailable("invalid_timestamp");
  }

  const outputContextTimeSec = timestamp.contextTime +
    (nowPerformanceTimeMs - timestamp.performanceTime) / 1000;
  const masterPtsSec = anchor.masterPtsSec +
    (outputContextTimeSec - anchor.contextTimeSec) * anchor.masterRate;
  if (!Number.isFinite(outputContextTimeSec) || !Number.isFinite(masterPtsSec)) {
    return unavailable("invalid_timestamp");
  }
  return { status: "ok", outputContextTimeSec, masterPtsSec };
}

/** Summarize finite non-negative PTS error samples without turning missing capability into zero. */
export function summarizePlaybackAvErrors(
  valuesMs: readonly number[],
  unavailableStatus: "unsupported" | "not_applicable" | "insufficient_samples" = "unsupported",
): PlaybackAvDistribution {
  if (!(["unsupported", "not_applicable", "insufficient_samples"] as const).includes(unavailableStatus)) {
    throw new TypeError("unavailableStatus is invalid");
  }
  if (valuesMs.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new RangeError("playback AV errors must be finite and non-negative");
  }
  if (valuesMs.length === 0) {
    return { status: unavailableStatus, n: 0, p50Ms: null, p95Ms: null };
  }
  const sorted = [...valuesMs].sort((left, right) => left - right);
  return {
    status: sorted.length >= DEFAULT_DURATION_THRESHOLDS.minSamplesForP95 ? "ok" : "insufficient_samples",
    n: sorted.length,
    p50Ms: nearestRankPercentile(sorted, 0.5),
    p95Ms: sorted.length >= DEFAULT_DURATION_THRESHOLDS.minSamplesForP95 ? nearestRankPercentile(sorted, 0.95) : null,
  };
}
