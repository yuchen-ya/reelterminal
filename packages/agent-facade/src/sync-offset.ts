/**
 * Multi-track sync-offset estimation (AUD-10) — the "syncOffset" analysis type.
 *
 * The target media range is correlated against a second, explicitly named
 * reference media range with a GCC-PHAT (generalized cross-correlation with
 * phase transform) kernel. The evaluation round (docs/AUDIO-MODEL-EVAL-2026-10-18.md)
 * established the decision rule used here: a peak must stand >= 6 dB above the
 * median |correlation| and the best competing local peak outside a ±50 ms
 * guard band must be >= 3 dB below the main peak, otherwise the result is
 * AMBIGUOUS or NO_MATCH instead of a guess.
 *
 * Sign contract (locked here and pinned by tests): a POSITIVE offset means the
 * TARGET is later than the reference ("target lags reference"). The raw GCC
 * lag produced by `fft(ref) * conj(fft(target))` has the opposite sign, which
 * is exactly the mix-up the evaluation round caught; `targetLagsSamples` is
 * therefore `-(rawLag + subSampleDelta)`.
 *
 * No model is involved: decoding is the same local FFmpeg subprocess path as
 * the other audio kernels, and only correlation statistics are kept. The
 * analysis never moves clips, never writes gain and never silently corrects a
 * clock drift — later windows exposing a monotonic drift produce an explicit
 * "clock-drift" verdict and a disclosure instead of one bogus fixed offset.
 */
import { stat } from "node:fs/promises";

import { FFT } from "@reelterminal/core/audio/fft";

import { FacadeError } from "./errors";
import { requireAudioBinaries, runAudioSubprocess, validateAudioRange } from "./audio-analysis";
import type { MediaSyncOffsetParams } from "./types";

/** Correlation rate: 16 kHz is plenty for ±sub-millisecond lag resolution. */
export const SYNC_OFFSET_ANALYSIS_RATE = 16000;

/** The competing-peak guard band from the evaluation round. */
export const SYNC_OFFSET_GUARD_SEC = 0.05;

/** Peak prominence and second-peak margin thresholds (dB), from the audit. */
export const SYNC_OFFSET_MIN_PROMINENCE_DB = 6;
export const SYNC_OFFSET_MIN_MARGIN_DB = 3;

export const DEFAULT_SYNC_OFFSET_PARAMS = { referenceStartSec: 0, searchRangeSec: 2, windowSec: 30 } as const;
const MIN_WINDOW_SEC = 10;
const MAX_WINDOW_SEC = 60;
const MAX_SEARCH_SEC = 5;
const MAX_WINDOWS = 12;
/** Windows quieter than this RMS (≈ -80 dBFS) carry no usable correlation. */
const MIN_WINDOW_RMS = 1e-4;
/** A drift verdict requires at least three windows and a strong linear fit. */
const DRIFT_MIN_R_SQUARED = 0.9;

export interface ResolvedSyncOffsetParams {
  readonly referenceMediaId: string;
  readonly referenceStartSec: number;
  readonly searchRangeSec: number;
  readonly windowSec: number;
  readonly guardSec: number;
}

/** Validate the requested tuning once at the request boundary. */
export function resolveSyncOffsetParams(params?: MediaSyncOffsetParams): ResolvedSyncOffsetParams {
  if (!params || typeof params !== "object") {
    throw new FacadeError("INVALID_PARAMS", "syncOffsetParams are required for the syncOffset analysis type");
  }
  const referenceMediaId = params.referenceMediaId;
  if (typeof referenceMediaId !== "string" || referenceMediaId.trim().length === 0) {
    throw new FacadeError("INVALID_PARAMS", "syncOffsetParams.referenceMediaId must be a non-empty media-library id");
  }
  const referenceStartSec = params.referenceStartSec ?? DEFAULT_SYNC_OFFSET_PARAMS.referenceStartSec;
  const searchRangeSec = params.searchRangeSec ?? DEFAULT_SYNC_OFFSET_PARAMS.searchRangeSec;
  const windowSec = params.windowSec ?? DEFAULT_SYNC_OFFSET_PARAMS.windowSec;
  if (!(Number.isFinite(referenceStartSec) && referenceStartSec >= 0)) {
    throw new FacadeError("INVALID_PARAMS", "syncOffsetParams.referenceStartSec must be a finite non-negative number of reference seconds");
  }
  if (!(Number.isFinite(searchRangeSec) && searchRangeSec > 0 && searchRangeSec <= MAX_SEARCH_SEC)) {
    throw new FacadeError("INVALID_PARAMS", `syncOffsetParams.searchRangeSec must be a finite number in (0, ${MAX_SEARCH_SEC}] seconds`);
  }
  if (!(Number.isFinite(windowSec) && windowSec >= MIN_WINDOW_SEC && windowSec <= MAX_WINDOW_SEC)) {
    throw new FacadeError("INVALID_PARAMS", `syncOffsetParams.windowSec must be a finite number in [${MIN_WINDOW_SEC}, ${MAX_WINDOW_SEC}] seconds`);
  }
  if (windowSec < 4 * searchRangeSec) {
    throw new FacadeError("INVALID_PARAMS", `syncOffsetParams.windowSec (${windowSec}s) must be at least 4 × searchRangeSec (${searchRangeSec}s) so the correlation keeps enough overlap`);
  }
  return { referenceMediaId, referenceStartSec, searchRangeSec, windowSec, guardSec: SYNC_OFFSET_GUARD_SEC };
}

/** Input facts validated before any job starts. */
export interface SyncOffsetReference {
  readonly mediaId: string;
  readonly name: string;
  readonly path: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly durationSec: number;
  readonly sourceFingerprint: { readonly size: number; readonly lastModified: number };
}

export type SyncOffsetVerdict = "ok" | "ambiguous" | "no-match" | "clock-drift";

export interface SyncOffsetCorrelation {
  /** Raw GCC peak lag in samples: positive means the target LEADS the reference. */
  readonly rawPeakLagSamples: number;
  readonly peakSampleLag: number;
  readonly offsetSec: number;
  readonly peakValue: number;
  readonly medianAbsValue: number;
  readonly prominenceDb: number;
  readonly marginToSecondPeakDb: number;
  readonly secondPeakLagSamples: number | null;
  readonly verdict: "ok" | "ambiguous" | "no-match";
}

function nextPowerOfTwo(value: number): number {
  let size = 1;
  while (size < value) size *= 2;
  return size;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function roundMetric(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function rms(samples: Float32Array, start: number, end: number): number {
  let sum = 0;
  const count = Math.max(0, end - start);
  for (let index = start; index < end; index++) {
    const value = samples[index]!;
    sum += value * value;
  }
  return count > 0 ? Math.sqrt(sum / count) : 0;
}

/**
 * GCC-PHAT delay estimate for one pair of equal-rate signals.
 *
 * The FFT size is padded to the linear-correlation length so the result cannot
 * wrap around, the cross spectrum is phase-normalized, and the peak is
 * interpolated to a sub-sample position. Pure and deterministic; tests pin the
 * sign convention with a deliberately delayed synthetic signal.
 */
export function gccPhatDelay(
  reference: Float32Array,
  target: Float32Array,
  options: { sampleRate: number; searchRangeSec: number; guardSec?: number },
): SyncOffsetCorrelation {
  const sampleRate = options.sampleRate;
  if (!(Number.isFinite(sampleRate) && sampleRate > 0)) throw new FacadeError("INVALID_PARAMS", "gccPhatDelay needs a positive sample rate");
  const length = reference.length;
  if (length < 2 || target.length < 2) throw new FacadeError("INVALID_PARAMS", "gccPhatDelay needs at least two samples per signal");
  const maxLag = Math.min(Math.round(options.searchRangeSec * sampleRate), length - 1, target.length - 1);
  if (maxLag < 1) throw new FacadeError("INVALID_PARAMS", "gccPhatDelay search range is shorter than one sample");
  const guardSamples = Math.max(1, Math.round((options.guardSec ?? SYNC_OFFSET_GUARD_SEC) * sampleRate));
  const fftSize = nextPowerOfTwo(Math.max(length, target.length) + maxLag + 1);
  const fft = new FFT(fftSize);

  const referenceInput = new Float32Array(fftSize);
  referenceInput.set(reference);
  const targetInput = new Float32Array(fftSize);
  targetInput.set(target);
  const referenceSpectrum = fft.forward(referenceInput);
  const targetSpectrum = fft.forward(targetInput);

  // R = ref · conj(target); PHAT divides each bin by its magnitude.
  const real = new Float32Array(fftSize);
  const imag = new Float32Array(fftSize);
  for (let index = 0; index < fftSize; index++) {
    const refReal = referenceSpectrum.real[index]!;
    const refImag = referenceSpectrum.imag[index]!;
    const tgtReal = targetSpectrum.real[index]!;
    const tgtImag = targetSpectrum.imag[index]!;
    const crossReal = refReal * tgtReal + refImag * tgtImag;
    const crossImag = refImag * tgtReal - refReal * tgtImag;
    const magnitude = Math.hypot(crossReal, crossImag) + 1e-12;
    real[index] = crossReal / magnitude;
    imag[index] = crossImag / magnitude;
  }
  const correlation = fft.inverse(real, imag);

  const valueAt = (lag: number): number =>
    lag >= 0 ? correlation[lag] ?? 0 : correlation[fftSize + lag] ?? 0;

  // Median magnitude over the search window is the noise floor the peak must
  // beat; it is also what makes a lone 17 dB peak with a 0.3 dB runner-up
  // correctly ambiguous rather than a match.
  const magnitudes = new Float32Array(2 * maxLag + 1);
  for (let lag = -maxLag; lag <= maxLag; lag++) magnitudes[lag + maxLag] = Math.abs(valueAt(lag));
  const medianAbsValue = median(Array.from(magnitudes));
  let peakIndex = 0;
  let peakMagnitude = -1;
  for (let index = 0; index < magnitudes.length; index++) {
    if (magnitudes[index]! > peakMagnitude) {
      peakMagnitude = magnitudes[index]!;
      peakIndex = index;
    }
  }
  const rawPeakLagSamples = peakIndex - maxLag;

  // Sub-sample peak via parabolic interpolation on |correlation|.
  const previous = magnitudes[Math.max(0, peakIndex - 1)]!;
  const next = magnitudes[Math.min(magnitudes.length - 1, peakIndex + 1)]!;
  const denominator = previous - 2 * peakMagnitude + next;
  const subSample = denominator !== 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (previous - next) / denominator)) : 0;
  const peakSampleLag = rawPeakLagSamples - subSample;

  // Best competing LOCAL maximum outside the guard band. A local maximum is
  // required so a broad shoulder next to the main peak is not misread as a
  // second arrival.
  let secondPeakMagnitude = 0;
  let secondPeakLagSamples: number | null = null;
  for (let index = 1; index < magnitudes.length - 1; index++) {
    const lag = index - maxLag;
    if (Math.abs(lag - rawPeakLagSamples) <= guardSamples) continue;
    const value = magnitudes[index]!;
    if (value > magnitudes[index - 1]! && value >= magnitudes[index + 1]! && value > secondPeakMagnitude) {
      secondPeakMagnitude = value;
      secondPeakLagSamples = lag;
    }
  }
  const prominenceDb = 20 * Math.log10((peakMagnitude + 1e-12) / (medianAbsValue + 1e-12));
  const marginToSecondPeakDb = 20 * Math.log10((peakMagnitude + 1e-12) / (secondPeakMagnitude + 1e-12));
  const verdict = prominenceDb < SYNC_OFFSET_MIN_PROMINENCE_DB
    ? "no-match"
    : marginToSecondPeakDb < SYNC_OFFSET_MIN_MARGIN_DB
      ? "ambiguous"
      : "ok";
  return {
    rawPeakLagSamples,
    peakSampleLag,
    // Contract: positive offset = target lags reference. The raw GCC peak
    // lags by the opposite sign, hence the negation.
    offsetSec: -peakSampleLag / sampleRate,
    peakValue: peakMagnitude,
    medianAbsValue,
    prominenceDb: roundMetric(prominenceDb, 1),
    marginToSecondPeakDb: roundMetric(marginToSecondPeakDb, 1),
    secondPeakLagSamples,
    verdict,
  };
}

interface PlannedWindow {
  readonly startSec: number;
  readonly endSec: number;
}

/** Window planning: fixed-size windows over the target range, last one clamped. */
export function planSyncOffsetWindows(durationSec: number, windowSec: number): PlannedWindow[] {
  if (!(durationSec > 0)) return [];
  if (durationSec <= windowSec) return [{ startSec: 0, endSec: durationSec }];
  const windows: PlannedWindow[] = [];
  // Equal-length windows keep the drift regression unbiased: a longer final
  // window would otherwise average the drift over a wider span and skew the
  // slope. `ceil` plus a backward-shifted last window covers the remainder
  // with a small overlap instead of leaving a gap.
  const count = Math.min(MAX_WINDOWS, Math.max(2, Math.ceil(durationSec / windowSec - 1e-9)));
  for (let index = 0; index < count; index++) {
    const startSec = index === count - 1 ? Math.max(0, durationSec - windowSec) : index * windowSec;
    const endSec = Math.min(durationSec, startSec + windowSec);
    if (endSec - startSec <= 0) continue;
    windows.push({ startSec, endSec });
  }
  return windows;
}

interface DriftSummary {
  readonly detected: boolean;
  readonly driftPpm: number | null;
  readonly slopeSecPerSec: number | null;
  readonly rSquared: number | null;
  readonly spanSec: number | null;
  readonly firstOffsetSec: number | null;
  readonly lastOffsetSec: number | null;
  readonly residualStdSec: number | null;
  readonly windowCount: number;
}

/**
 * Linear-regression drift detection over window offsets. Reporting only: the
 * documented contract is that v1 never silently corrects a drifting track.
 */
export function summarizeSyncDrift(
  windows: ReadonlyArray<{ readonly midTimeSec: number; readonly offsetSec: number | null }>,
): DriftSummary {
  const samples = windows.filter((window): window is { midTimeSec: number; offsetSec: number } =>
    window.offsetSec !== null && Number.isFinite(window.offsetSec));
  if (samples.length < 3) {
    return {
      detected: false,
      driftPpm: null,
      slopeSecPerSec: null,
      rSquared: null,
      spanSec: null,
      firstOffsetSec: samples[0]?.offsetSec ?? null,
      lastOffsetSec: samples.at(-1)?.offsetSec ?? null,
      residualStdSec: null,
      windowCount: samples.length,
    };
  }
  const meanX = samples.reduce((sum, sample) => sum + sample.midTimeSec, 0) / samples.length;
  const meanY = samples.reduce((sum, sample) => sum + sample.offsetSec, 0) / samples.length;
  let covariance = 0;
  let varianceX = 0;
  for (const sample of samples) {
    covariance += (sample.midTimeSec - meanX) * (sample.offsetSec - meanY);
    varianceX += (sample.midTimeSec - meanX) ** 2;
  }
  if (varianceX === 0) {
    return {
      detected: false,
      driftPpm: 0,
      slopeSecPerSec: 0,
      rSquared: null,
      spanSec: 0,
      firstOffsetSec: samples[0]!.offsetSec,
      lastOffsetSec: samples.at(-1)!.offsetSec,
      residualStdSec: null,
      windowCount: samples.length,
    };
  }
  const slope = covariance / varianceX;
  let residualSum = 0;
  let totalSum = 0;
  for (const sample of samples) {
    const predicted = meanY + slope * (sample.midTimeSec - meanX);
    residualSum += (sample.offsetSec - predicted) ** 2;
    totalSum += (sample.offsetSec - meanY) ** 2;
  }
  const residualStd = Math.sqrt(residualSum / samples.length);
  const rSquared = totalSum > 0 ? Math.max(0, 1 - residualSum / totalSum) : 1;
  const spanSec = samples.at(-1)!.midTimeSec - samples[0]!.midTimeSec;
  const driftPpm = slope * 1e6;
  const changeOverSpan = Math.abs(slope) * spanSec;
  // Two independent guards: a strong linear fit AND a change larger than both
  // three residual standard deviations and two correlation samples.
  const detected = rSquared >= DRIFT_MIN_R_SQUARED && changeOverSpan >= Math.max(3 * residualStd, 2 / SYNC_OFFSET_ANALYSIS_RATE);
  return {
    detected,
    driftPpm: roundMetric(driftPpm, 1),
    slopeSecPerSec: slope,
    rSquared: roundMetric(rSquared, 3),
    spanSec: roundMetric(spanSec, 3),
    firstOffsetSec: samples[0]!.offsetSec,
    lastOffsetSec: samples.at(-1)!.offsetSec,
    residualStdSec: residualStd,
    windowCount: samples.length,
  };
}

export interface SyncOffsetWindowFacts {
  readonly startSec: number;
  readonly endSec: number;
  readonly offsetSec: number | null;
  readonly offsetMs: number | null;
  readonly verdict: "ok" | "ambiguous" | "no-match" | "silent";
  readonly prominenceDb: number;
  readonly marginToSecondPeakDb: number;
  readonly peakSampleLag: number | null;
  readonly skippedReason: string | null;
}

export interface SyncOffsetFacts {
  readonly coordinateSpace: "source";
  readonly startSec: number;
  readonly endSec: number;
  readonly durationSec: number;
  readonly analysisSampleRate: number;
  readonly audioStreamIndex: 0;
  readonly reference: {
    readonly mediaId: string;
    readonly name: string;
    readonly startSec: number;
    readonly endSec: number;
    readonly durationSec: number;
    readonly sourceFingerprint: { readonly size: number; readonly lastModified: number };
  };
  readonly parameters: { readonly referenceMediaId: string; readonly referenceStartSec: number; readonly searchRangeSec: number; readonly windowSec: number; readonly guardSec: number };
  readonly verdict: SyncOffsetVerdict;
  /** Median positive target-lags-reference offset; present even for clock-drift (as a summary, not a correction). */
  readonly offsetSec: number | null;
  readonly offsetMs: number | null;
  readonly fixedOffsetSupported: boolean;
  readonly peaks: {
    readonly prominenceDb: number;
    readonly marginToSecondPeakDb: number;
    readonly peaksAgree: boolean;
  };
  readonly windows: readonly SyncOffsetWindowFacts[];
  readonly drift: DriftSummary;
  readonly analyzedDurationSec: number;
  readonly truncated: boolean;
  readonly algorithm: string;
  readonly limitations: readonly string[];
}

/**
 * Pure aggregation over already-decoded, equal-rate signals. Exported so tests
 * can pin windows, verdicts and the sign contract without FFmpeg.
 */
export function estimateSyncOffsetFromPcm(
  referencePcm: Float32Array,
  targetPcm: Float32Array,
  input: {
    readonly targetRange: { readonly startSec: number; readonly endSec: number };
    readonly referenceRange: { readonly startSec: number; readonly endSec: number };
    readonly params: ResolvedSyncOffsetParams;
    readonly reference: SyncOffsetReference;
  },
  checkCancelled: () => void = () => {},
): SyncOffsetFacts {
  const { targetRange, params, reference } = input;
  const analyzedSamples = Math.min(referencePcm.length, targetPcm.length);
  const durationSec = analyzedSamples / SYNC_OFFSET_ANALYSIS_RATE;
  const planned = planSyncOffsetWindows(durationSec, params.windowSec);
  const windows: SyncOffsetWindowFacts[] = [];
  const usable: Array<{ midTimeSec: number; offsetSec: number }> = [];
  let maxProminence = -Infinity;
  let marginAtMaxProminence = -Infinity;

  for (const window of planned) {
    checkCancelled();
    const startSample = Math.floor(window.startSec * SYNC_OFFSET_ANALYSIS_RATE);
    const endSample = Math.min(analyzedSamples, Math.ceil(window.endSec * SYNC_OFFSET_ANALYSIS_RATE));
    const referenceStartSample = startSample;
    const referenceEndSample = Math.min(referencePcm.length, referenceStartSample + (endSample - startSample));
    const targetWindow = targetPcm.subarray(startSample, endSample);
    const referenceWindow = referencePcm.subarray(referenceStartSample, referenceEndSample);
    const targetLevel = rms(targetPcm, startSample, endSample);
    const referenceLevel = rms(referencePcm, referenceStartSample, referenceEndSample);
    if (targetWindow.length < 2 || referenceWindow.length < 2 || targetLevel < MIN_WINDOW_RMS || referenceLevel < MIN_WINDOW_RMS) {
      windows.push({
        startSec: roundMetric(targetRange.startSec + startSample / SYNC_OFFSET_ANALYSIS_RATE, 3),
        endSec: roundMetric(targetRange.startSec + endSample / SYNC_OFFSET_ANALYSIS_RATE, 3),
        offsetSec: null,
        offsetMs: null,
        verdict: "silent",
        prominenceDb: 0,
        marginToSecondPeakDb: 0,
        peakSampleLag: null,
        skippedReason: targetLevel < MIN_WINDOW_RMS && referenceLevel < MIN_WINDOW_RMS
          ? "both signals are silent in this window"
          : targetLevel < MIN_WINDOW_RMS ? "the target signal is silent in this window" : "the reference signal is silent in this window",
      });
      continue;
    }
    const correlation = gccPhatDelay(referenceWindow, targetWindow, {
      sampleRate: SYNC_OFFSET_ANALYSIS_RATE,
      searchRangeSec: params.searchRangeSec,
      guardSec: params.guardSec,
    });
    if (correlation.prominenceDb > maxProminence) {
      maxProminence = correlation.prominenceDb;
      marginAtMaxProminence = correlation.marginToSecondPeakDb;
    }
    const midTimeSec = targetRange.startSec + (startSample + endSample) / 2 / SYNC_OFFSET_ANALYSIS_RATE;
    if (correlation.verdict === "ok") usable.push({ midTimeSec, offsetSec: correlation.offsetSec });
    windows.push({
      startSec: roundMetric(targetRange.startSec + startSample / SYNC_OFFSET_ANALYSIS_RATE, 3),
      endSec: roundMetric(targetRange.startSec + endSample / SYNC_OFFSET_ANALYSIS_RATE, 3),
      offsetSec: roundMetric(correlation.offsetSec, 6),
      offsetMs: roundMetric(correlation.offsetSec * 1000, 3),
      verdict: correlation.verdict,
      prominenceDb: correlation.prominenceDb,
      marginToSecondPeakDb: correlation.marginToSecondPeakDb,
      peakSampleLag: roundMetric(correlation.peakSampleLag, 3),
      skippedReason: null,
    });
  }

  const drift = summarizeSyncDrift(planned.map((_, index) => {
    const facts = windows[index]!;
    const midTimeSec = (facts.startSec + facts.endSec) / 2;
    return { midTimeSec, offsetSec: facts.offsetSec };
  }));
  const okCount = usable.length;
  const majorityOk = okCount > 0 && (windows.length === 1 || okCount * 2 >= windows.length);
  const verdict: SyncOffsetVerdict = drift.detected ? "clock-drift"
    : majorityOk ? "ok"
      : windows.some((window) => window.prominenceDb >= SYNC_OFFSET_MIN_PROMINENCE_DB && window.verdict === "ambiguous") ? "ambiguous"
        : "no-match";
  const offsets = usable.map((window) => window.offsetSec).sort((left, right) => left - right);
  const offsetSec = offsets.length > 0 ? median(offsets) : null;
  const spread = offsets.length >= 2 ? offsets.at(-1)! - offsets[0]! : 0;
  const expectedSpread = drift.detected ? Math.abs(drift.slopeSecPerSec ?? 0) * (drift.spanSec ?? 0) : 0;
  const peaksAgree = spread <= Math.max(0.001, expectedSpread + 0.001);
  const requestedDuration = targetRange.endSec - targetRange.startSec;
  return {
    coordinateSpace: "source",
    ...targetRange,
    durationSec: roundMetric(durationSec, 3),
    analysisSampleRate: SYNC_OFFSET_ANALYSIS_RATE,
    audioStreamIndex: 0,
    reference: {
      mediaId: reference.mediaId,
      name: reference.name,
      startSec: reference.startSec,
      endSec: reference.endSec,
      durationSec: reference.durationSec,
      sourceFingerprint: reference.sourceFingerprint,
    },
    parameters: {
      referenceMediaId: params.referenceMediaId,
      referenceStartSec: params.referenceStartSec,
      searchRangeSec: params.searchRangeSec,
      windowSec: params.windowSec,
      guardSec: params.guardSec,
    },
    verdict,
    offsetSec: offsetSec === null ? null : roundMetric(offsetSec, 6),
    offsetMs: offsetSec === null ? null : roundMetric(offsetSec * 1000, 3),
    fixedOffsetSupported: verdict === "ok",
    peaks: {
      prominenceDb: Number.isFinite(maxProminence) ? roundMetric(maxProminence, 1) : 0,
      marginToSecondPeakDb: Number.isFinite(marginAtMaxProminence) ? roundMetric(marginAtMaxProminence, 1) : 0,
      peaksAgree,
    },
    windows,
    drift,
    analyzedDurationSec: roundMetric(durationSec, 3),
    truncated: requestedDuration - durationSec > 1 / SYNC_OFFSET_ANALYSIS_RATE + 1e-6,
    algorithm: `GCC-PHAT over locally decoded 16 kHz mono PCM (FFmpeg subprocess, strongest-absolute-sample stereo mix): per-window phase-transform cross-correlation (${params.windowSec}s windows, ±${params.searchRangeSec}s lag search, ±${params.guardSec}s competing-peak guard), ${SYNC_OFFSET_MIN_PROMINENCE_DB} dB peak-prominence / ${SYNC_OFFSET_MIN_MARGIN_DB} dB second-peak-margin rejection, sub-sample parabolic peak interpolation, window-median offset and linear-regression drift report`,
    limitations: [
      "A positive offset means the target is later than the reference (target lags reference); negative means the target leads.",
      "The offset is measured in source seconds at the analyzed range and is NOT applied to any clip, track or project revision.",
      "Peak prominence and second-peak margin are correlation statistics, not a calibrated probability or confidence score.",
      "No reliable common content yields no-match/ambiguous instead of a guess; repeating music can still be ambiguous.",
      "Clock drift is reported (window regression) but never silently corrected in v1; a fixed offset is not a valid correction for a drifting pair.",
      "Only the first audio stream (0:a:0) of each media is correlated; a different audio track must be analyzed separately.",
    ],
  };
}

async function decodeMono16k(path: string, range: { startSec: number; endSec: number }, signal: AbortSignal): Promise<Float32Array> {
  const binaries = await requireAudioBinaries(signal);
  const input = ["-hide_banner", "-nostdin", "-v", "info", "-ss", String(range.startSec), "-t", String(range.endSec - range.startSec), "-i", path, "-map", "0:a:0", "-vn", "-threads", "1"];
  const pcm = await runAudioSubprocess(binaries.ffmpeg, [...input, "-ar", String(SYNC_OFFSET_ANALYSIS_RATE), "-ac", "2", "-f", "f32le", "pipe:1"], signal);
  const frames = Math.floor(pcm.out.length / 8);
  const mono = new Float32Array(frames);
  for (let index = 0; index < frames; index++) {
    const left = pcm.out.readFloatLE(index * 8);
    const right = pcm.out.readFloatLE(index * 8 + 4);
    if (!Number.isFinite(left) || !Number.isFinite(right)) throw new Error("Nonfinite audio sample");
    // Same strongest-absolute-sample strategy as the VAD/silence kernels:
    // right-only content survives and anti-phase channels cannot cancel.
    mono[index] = Math.abs(left) >= Math.abs(right) ? left : right;
  }
  return mono;
}

/**
 * "syncOffset" analysis: decode the target range and the explicit reference
 * range, correlate them window by window and report the offset/verdict. The
 * reference file is re-fingerprinted before publication so a changed reference
 * cannot silently validate a stale measurement.
 */
export async function analyzeSyncOffset(
  targetPath: string,
  targetRange: { startSec: number; endSec: number },
  referencePath: string,
  params: ResolvedSyncOffsetParams,
  reference: SyncOffsetReference,
  signal: AbortSignal,
  progress: (percent: number) => void = () => {},
): Promise<SyncOffsetFacts> {
  validateAudioRange(targetRange);
  if (signal.aborted) throw new Error("Cancelled");
  const referenceRange = { startSec: reference.startSec, endSec: reference.endSec };
  if (!(referenceRange.endSec > referenceRange.startSec)) {
    throw new FacadeError("INVALID_PARAMS", "syncOffset reference range must have endSec > startSec");
  }
  const before = await stat(referencePath).catch(() => null);
  if (!before?.isFile()) throw new FacadeError("UNSUPPORTED", "syncOffset reference media is not a readable regular file");
  if (before.size !== reference.sourceFingerprint.size || Math.round(before.mtimeMs) !== reference.sourceFingerprint.lastModified) {
    throw new FacadeError("CONFLICT", "syncOffset reference media changed after the request was prepared; retry against its current version");
  }
  const [referencePcm, targetPcm] = await Promise.all([
    decodeMono16k(referencePath, referenceRange, signal),
    decodeMono16k(targetPath, targetRange, signal),
  ]);
  if (signal.aborted) throw new Error("Cancelled");
  progress(0.5);
  const facts = estimateSyncOffsetFromPcm(referencePcm, targetPcm, {
    targetRange,
    referenceRange,
    params,
    reference,
  }, () => {
    if (signal.aborted) throw new Error("Cancelled");
  });
  progress(0.9);
  const after = await stat(referencePath);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new FacadeError("CONFLICT", "syncOffset reference media changed during analysis; retry");
  }
  progress(1);
  return facts;
}

/** Capability probe: this kernel only needs local FFmpeg/FFprobe. */
export function syncOffsetPreflight() {
  return requireAudioBinaries().then(
    () => ({ available: true as const, details: { provider: "local-ffmpeg-pcm-gcc-phat", sampleRate: SYNC_OFFSET_ANALYSIS_RATE, guardSec: SYNC_OFFSET_GUARD_SEC, minProminenceDb: SYNC_OFFSET_MIN_PROMINENCE_DB, minMarginDb: SYNC_OFFSET_MIN_MARGIN_DB } }),
    (error: unknown) => ({ available: false as const, reason: `syncOffset needs local ffmpeg/ffprobe on PATH or REELTERMINAL_FFMPEG_PATH / REELTERMINAL_FFPROBE_PATH: ${error instanceof Error ? error.message : String(error)}` }),
  );
}
