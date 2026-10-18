import { spawn } from "node:child_process";
import {
  SilenceWindowScanner,
  detectSilenceRangesInPcm,
  postprocessSilenceRanges,
} from "@reelterminal/core/audio/audio-engine";
import {
  analyzeBeatsFromOnsetEnergies,
  computeRawBeatEnergies,
} from "@reelterminal/core/audio/beat-detection-engine";
import type { TimeRange } from "@reelterminal/core/audio/types";
import { FacadeError } from "./errors";
import { resolveToolFfmpeg } from "./media/ffmpeg-bin";
import type { MediaSilenceAnalysisParams } from "./types";

/**
 * Range caps and per-process budgets for local audio analysis.
 *
 * `maxRangeSec` (AUD-11) covers the three local PCM/loudnorm analyses
 * (audioSummary, silence, beatGrid): their decodes stream through bounded
 * memory chunks, so hour-level material is bounded by the byte/stream caps
 * below rather than by a small range cap. Model-backed analyses
 * (speechActivity, speechTranscript, speakerDiarization) and syncOffset keep
 * the 120 s `maxModelRangeSec` cap — their subprocess contract buffers whole
 * ranges and is not streamable yet.
 */
export const AUDIO_LIMITS = {
  maxRangeSec: 3600,
  maxModelRangeSec: 120,
  maxConcurrentPerSession: 2,
  timeoutMs: 60000,
  maxProcessOutputBytes: 16 * 1024 * 1024,
  /**
   * Whole-stream byte ceiling for one streamed decode: 3600 s × 22050 Hz mono
   * f32le ≈ 318 MiB plus headroom. Exceeding it fails the run loudly instead
   * of buffering without bound.
   */
  maxStreamDecodeBytes: 340 * 1024 * 1024,
  maxWaveformBins: 600,
  maxEventsPerPage: 256,
} as const;

/** Wall-clock budget for one streamed decode or whole-range loudnorm pass. */
export function audioAnalysisRunBudgetMs(durationSec: number): number {
  return Math.max(AUDIO_LIMITS.timeoutMs, Math.ceil(Math.max(0, durationSec)) * 2000);
}

let running = 0;
/** Local subprocesses only: no shell, remote provider, uploads or paid dependency. */
function run(binary: string, args: string[], signal?: AbortSignal, timeoutMs: number = AUDIO_LIMITS.timeoutMs): Promise<{ out: Buffer; err: string }> {
  if (signal?.aborted) return Promise.reject(new Error("Cancelled"));
  if (running >= 4) return Promise.reject(new Error("Local audio process limit reached; retry after current jobs finish"));
  running++;
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = []; const errors: Buffer[] = [];
    let size = 0; let failure: Error | undefined;
    const stop = (message: string) => { failure = new Error(message); child.kill("SIGKILL"); };
    const abort = () => stop("Cancelled");
    const timer = setTimeout(() => stop(`Audio analysis exceeded ${(timeoutMs / 1000) | 0} second process deadline`), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    const collect = (target: Buffer[], chunk: Buffer) => {
      size += chunk.length;
      if (size > AUDIO_LIMITS.maxProcessOutputBytes) stop("Audio analysis output resource limit exceeded");
      else target.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(chunks, chunk));
    child.stderr.on("data", (chunk) => collect(errors, chunk));
    child.on("error", (error) => { failure = error; });
    child.on("close", (code) => {
      running--; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (failure || code !== 0) reject(failure ?? new Error(`Audio provider failed: ${Buffer.concat(errors).toString().slice(-2000)}`));
      else resolve({ out: Buffer.concat(chunks), err: Buffer.concat(errors).toString() });
    });
  });
}

/**
 * Streamed ffmpeg decode (AUD-11 bounded decode): ONE continuous process for
 * the whole range — identical bytes to the previous buffered decode — whose
 * stdout is consumed incrementally, so kernel memory stays bounded by the
 * consumer's derived state (windows/energies), not by the PCM length. Yields
 * byte chunks aligned to whole `frameBytes` frames; throws on non-zero exit,
 * timeout, abort or exceeding `maxStreamDecodeBytes`.
 */
async function* streamDecodedPcm(
  binary: string,
  args: readonly string[],
  frameBytes: number,
  budgetMs: number,
  signal: AbortSignal | undefined,
  onBytes?: (consumed: number) => void,
): AsyncGenerator<Buffer> {
  if (signal?.aborted) throw new Error("Cancelled");
  if (running >= 4) throw new Error("Local audio process limit reached; retry after current jobs finish");
  running++;
  const child = spawn(binary, [...args], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const queue: Buffer[] = [];
  const stderrTail: Buffer[] = [];
  let stderrBytes = 0;
  let notify: (() => void) | null = null;
  let ended = false;
  let failure: Error | undefined;
  let exitCode: number | null = null;
  let consumed = 0;
  let carry: Buffer = Buffer.alloc(0);
  const stop = (message: string) => { failure ??= new Error(message); child.kill("SIGKILL"); };
  const abort = () => stop("Cancelled");
  const timer = setTimeout(() => stop("Audio analysis exceeded its process deadline"), budgetMs);
  signal?.addEventListener("abort", abort, { once: true });
  const stderrCap = 256 * 1024;
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    stderrTail.push(chunk);
    if (stderrBytes > stderrCap) stderrTail.splice(0, stderrTail.length - 8);
  });
  child.stdout.on("data", (chunk: Buffer) => {
    consumed += chunk.length;
    if (consumed > AUDIO_LIMITS.maxStreamDecodeBytes) {
      stop("Audio analysis streamed decode output exceeded the resource cap");
      return;
    }
    queue.push(chunk);
    notify?.();
    notify = null;
  });
  child.on("error", (error) => { failure ??= error; });
  child.on("close", (code) => { exitCode = code; ended = true; notify?.(); notify = null; });
  const drainNotify = () => new Promise<void>((resolve) => { notify = resolve; });
  try {
    while (true) {
      if (signal?.aborted) throw new Error("Cancelled");
      if (queue.length === 0 && !ended) {
        await drainNotify();
        continue;
      }
      if (queue.length > 0) {
        const chunk = queue.shift()!;
        // Re-align to whole frames across arbitrary pipe chunk boundaries.
        const merged = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
        const usable = merged.length - (merged.length % frameBytes);
        if (usable <= 0) {
          carry = merged;
        } else {
          carry = merged.subarray(usable);
          onBytes?.(consumed);
          yield merged.subarray(0, usable);
        }
        continue;
      }
      if (carry.length > 0 && ended) throw new Error("Streamed decode ended mid-frame");
      if (failure) throw failure;
      if (exitCode !== 0) throw new Error(`Audio provider failed: ${Buffer.concat(stderrTail).toString().slice(-2000)}`);
      return;
    }
  } finally {
    child.kill("SIGKILL"); // no-op once exited; guards early consumer breaks
    running--;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function decodeArgs(path: string, range: { startSec: number; endSec: number }, rate: number, channels: 1 | 2): string[] {
  return ["-hide_banner", "-nostdin", "-v", "info", "-ss", String(range.startSec), "-t", String(range.endSec - range.startSec), "-i", path, "-map", "0:a:0", "-vn", "-threads", "1", "-ar", String(rate), "-ac", String(channels), "-f", "f32le", "pipe:1"];
}

/** Convert one aligned mono f32le chunk, rejecting nonfinite samples. */
function monoChunk(chunk: Buffer): Float32Array {
  const samples = new Float32Array(chunk.length / 4);
  for (let i = 0; i < samples.length; i++) {
    const x = chunk.readFloatLE(i * 4);
    if (!Number.isFinite(x)) throw new Error("Nonfinite audio sample");
    samples[i] = x;
  }
  return samples;
}

/**
 * Raw RMS energy frames for a CONTINUOUS sample stream, split into arbitrary
 * chunks (AUD-11). Frame k covers global samples [k*hop, k*hop+window); the
 * buffer invariant keeps every emitted frame's window identical to a
 * single-pass decode over the concatenated samples, so the downstream
 * analysis matches analyzeBeatsInPcm exactly — no chunk-boundary onsets are
 * lost or duplicated. Exported for equivalence tests.
 */
export class BeatEnergyAccumulator {
  private buffer = new Float32Array(0);
  /** Global sample index of buffer[0]; always a multiple of hopSize. */
  private bufferStartSample = 0;
  private lastEmittedFrame = -1;
  private readonly frames: number[] = [];

  constructor(private readonly windowSize: number, private readonly hopSize: number) {}

  push(chunk: Float32Array): void {
    if (chunk.length === 0) return;
    const merged = new Float32Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    const energies = computeRawBeatEnergies(merged, { windowSize: this.windowSize, hopSize: this.hopSize });
    for (let i = 0; i < energies.length; i++) this.frames.push(energies[i]!);
    if (energies.length > 0) this.lastEmittedFrame = this.bufferStartSample / this.hopSize + energies.length - 1;
    const keepFromGlobal = (this.lastEmittedFrame + 1) * this.hopSize;
    const keepFromLocal = keepFromGlobal - this.bufferStartSample;
    this.buffer = merged.slice(keepFromLocal);
    this.bufferStartSample = keepFromGlobal;
  }

  finish(): Float32Array {
    return Float32Array.from(this.frames);
  }
}

/** 10 ms stereo RMS/peak windows at absolute frame indices (audioSummary mix). */
class StereoEnergyAccumulator {
  readonly energies: number[] = [];
  readonly peaks: number[] = [];
  private totalFrames = 0;
  private windowStart = 0;
  private sum = 0;
  private peak = 0;
  private n = 0;

  constructor(private readonly hopFrames = 80) {}

  /** Chunk must be aligned to whole 8-byte stereo frames; also yields the strongest-channel mono samples. */
  push(chunk: Buffer, mono: Float32Array): void {
    for (let base = 0; base < chunk.length; base += 8) {
      const left = chunk.readFloatLE(base);
      const right = chunk.readFloatLE(base + 4);
      if (!Number.isFinite(left) || !Number.isFinite(right)) throw new Error("Nonfinite audio sample");
      this.sum += left * left;
      this.peak = Math.max(this.peak, Math.abs(left));
      this.sum += right * right;
      this.peak = Math.max(this.peak, Math.abs(right));
      this.n += 2;
      // Select the strongest channel at each sample, preserving its sign. Both
      // kernels operate on amplitude/energy: this retains right-only activity
      // and avoids cancellation of anti-phase channels in an arithmetic downmix.
      mono[base / 8] = Math.abs(left) >= Math.abs(right) ? left : right;
      this.totalFrames++;
      if (this.totalFrames - this.windowStart === this.hopFrames) this.closeWindow();
    }
  }

  finish(): void {
    if (this.totalFrames > this.windowStart) this.closeWindow();
  }

  get frames(): number {
    return this.totalFrames;
  }

  private closeWindow(): void {
    this.energies.push(Math.sqrt(this.sum / this.n));
    this.peaks.push(this.peak);
    this.windowStart = this.totalFrames;
    this.sum = 0;
    this.peak = 0;
    this.n = 0;
  }
}

async function requireAudioBinaries(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("Cancelled");
  const binaries = await resolveToolFfmpeg();
  if (!binaries) throw new FacadeError("UNSUPPORTED", "Local audio analysis needs ffmpeg and ffprobe on PATH or REELTERMINAL_FFMPEG_PATH / REELTERMINAL_FFPROBE_PATH");
  return binaries;
}

/** Shared bounded-subprocess helpers for the audio analysis kernels (incl. VAD). */
export { run as runAudioSubprocess, requireAudioBinaries, validateAudioRange, validateLongAudioRange };

export async function audioAnalysisPreflight() {
  try {
    const binaries = await requireAudioBinaries();
    const ff = await run(binaries.ffmpeg, ["-hide_banner", "-filters"]);
    if (!ff.out.toString().includes("loudnorm")) throw new Error("FFmpeg loudnorm filter missing");
    return { available: true, details: { provider: "local-ffmpeg-pcm-loudnorm", ...AUDIO_LIMITS } };
  } catch (error) { return { available: false, reason: `Local audio analysis needs ffmpeg (loudnorm) and ffprobe on PATH or REELTERMINAL_FFMPEG_PATH / REELTERMINAL_FFPROBE_PATH: ${String(error)}` }; }
}

/** Range guard for model-backed/buffered kernels (speech, syncOffset): ≤120 s. */
function validateAudioRange(range: { startSec: number; endSec: number }) {
  if (!(Number.isFinite(range.startSec) && Number.isFinite(range.endSec) && range.startSec >= 0 && range.endSec > range.startSec && range.endSec - range.startSec <= AUDIO_LIMITS.maxModelRangeSec)) throw new FacadeError("INVALID_PARAMS", `Audio range must be 0–${AUDIO_LIMITS.maxModelRangeSec} seconds in source coordinates`);
}

/** Range guard for the streamed local kernels (audioSummary, silence, beatGrid): ≤3600 s. */
function validateLongAudioRange(range: { startSec: number; endSec: number }) {
  if (!(Number.isFinite(range.startSec) && Number.isFinite(range.endSec) && range.startSec >= 0 && range.endSec > range.startSec && range.endSec - range.startSec <= AUDIO_LIMITS.maxRangeSec)) throw new FacadeError("INVALID_PARAMS", `Audio range must be 0–${AUDIO_LIMITS.maxRangeSec} seconds in source coordinates`);
}

/** GUI silence-cut panel defaults (apps/web silence-cut-bridge DEFAULT_SILENCE_SETTINGS). */
export const DEFAULT_SILENCE_ANALYSIS_PARAMS = { thresholdDb: -40, minDurationSec: 0.5, paddingSec: 0.1 } as const;

/** Resolve the effective tuning once at the request boundary and in direct calls. */
export function resolveSilenceAnalysisParams(params?: MediaSilenceAnalysisParams) {
  const thresholdDb = params?.thresholdDb ?? DEFAULT_SILENCE_ANALYSIS_PARAMS.thresholdDb;
  const minDurationSec = params?.minDurationSec ?? DEFAULT_SILENCE_ANALYSIS_PARAMS.minDurationSec;
  const paddingSec = params?.paddingSec ?? DEFAULT_SILENCE_ANALYSIS_PARAMS.paddingSec;
  if (!(Number.isFinite(thresholdDb) && thresholdDb >= -120 && thresholdDb <= 0)) throw new FacadeError("INVALID_PARAMS", "silenceParams.thresholdDb must be a finite number in [-120, 0] dBFS");
  if (!(Number.isFinite(minDurationSec) && minDurationSec >= 0 && minDurationSec <= 10)) throw new FacadeError("INVALID_PARAMS", "silenceParams.minDurationSec must be a finite number in [0, 10] seconds");
  if (!(Number.isFinite(paddingSec) && paddingSec >= 0 && paddingSec <= 10)) throw new FacadeError("INVALID_PARAMS", "silenceParams.paddingSec must be a finite number in [0, 10] seconds");
  return { thresholdDb, minDurationSec, paddingSec };
}

/**
 * "silence" analysis: the shared core silence kernel over ffmpeg-extracted
 * mono PCM — the same 100 ms window detector the GUI silence-cut bridge runs,
 * so agent and GUI agree on what counts as silent. The decode is one streamed
 * ffmpeg process consumed in bounded chunks; the incremental scanner places
 * windows at absolute sample indices, so results equal the whole-buffer
 * kernel exactly and no silence region is lost or duplicated across chunk
 * boundaries. Regions are reported in source seconds after padding and
 * minimum-duration filtering.
 */
export async function analyzeSilence(
  path: string,
  range: { startSec: number; endSec: number },
  params: MediaSilenceAnalysisParams | undefined,
  signal: AbortSignal,
  progress: (percent: number) => void = () => {},
) {
  validateLongAudioRange(range);
  const { thresholdDb, minDurationSec, paddingSec } = resolveSilenceAnalysisParams(params);
  const rate = 8000;
  const binaries = await requireAudioBinaries(signal);
  const scanner = new SilenceWindowScanner(rate, thresholdDb);
  const expectedBytes = (range.endSec - range.startSec) * rate * 4;
  const budgetMs = audioAnalysisRunBudgetMs(range.endSec - range.startSec);
  for await (const chunk of streamDecodedPcm(binaries.ffmpeg, decodeArgs(path, range, rate, 1), 4, budgetMs, signal, (consumed) => {
    progress(Math.min(0.69, 0.69 * (expectedBytes > 0 ? consumed / expectedBytes : 1)));
  })) {
    scanner.push(monoChunk(chunk));
  }
  progress(0.7);
  const durationSec = scanner.totalSamples / rate;
  const ranges = postprocessSilenceRanges(scanner.finish(), durationSec, minDurationSec, paddingSec);
  progress(1);
  const regions = ranges.map((r) => ({
    startSec: range.startSec + r.start,
    endSec: range.startSec + r.end,
    durationSec: r.end - r.start,
  }));
  return {
    coordinateSpace: "source" as const,
    ...range,
    durationSec,
    analysisSampleRate: rate,
    parameters: { thresholdDb, minDurationSec, paddingSec },
    silentRegions: regions,
    regionCount: ranges.length,
    truncated: false,
    totalSilenceDurationSec: ranges.reduce((sum, region) => sum + region.end - region.start, 0),
    algorithm: "Shared core silence kernel (100ms max-amplitude windows, dBFS threshold, padding + minimum-duration filtering) over FFmpeg-extracted mono PCM; same detectSilenceRangesInPcm as the GUI silence-cut panel",
    limitations: ["Silence is an amplitude-threshold judgment, not a semantic pause; adjust thresholdDb/minDurationSec/paddingSec to match the material.", "Source seconds only; map through clip trim/offset before editing. Results do not change gain, markers, playback, selection or project revision."],
  };
}

/** Beat analysis runs on a higher-rate mono mix than the 8kHz summary scan. */
export const BEAT_GRID_ANALYSIS_RATE = 22050;

/**
 * "beatGrid" analysis: the shared core beat-detection engine (same
 * BeatDetectionEngine the GUI beat-sync panel uses) over ffmpeg-extracted
 * mono PCM. The decode streams in bounded chunks whose RMS energy frames are
 * accumulated at absolute frame indices, so the analysis equals
 * analyzeBeatsInPcm over the whole buffer. Returns beats + bpm + confidence
 * in source coordinates. Downbeats are intentionally absent — no downbeat
 * detector is installed.
 */
export async function analyzeBeatGrid(
  path: string,
  range: { startSec: number; endSec: number },
  signal: AbortSignal,
  progress: (percent: number) => void = () => {},
) {
  validateLongAudioRange(range);
  const binaries = await requireAudioBinaries(signal);
  const energies = new BeatEnergyAccumulator(2048, 512);
  let totalSamples = 0;
  const expectedBytes = (range.endSec - range.startSec) * BEAT_GRID_ANALYSIS_RATE * 4;
  const budgetMs = audioAnalysisRunBudgetMs(range.endSec - range.startSec);
  for await (const chunk of streamDecodedPcm(binaries.ffmpeg, decodeArgs(path, range, BEAT_GRID_ANALYSIS_RATE, 1), 4, budgetMs, signal, (consumed) => {
    progress(Math.min(0.69, 0.69 * (expectedBytes > 0 ? consumed / expectedBytes : 1)));
  })) {
    const samples = monoChunk(chunk);
    totalSamples += samples.length;
    energies.push(samples);
  }
  progress(0.7);
  if (totalSamples < 2048) throw new FacadeError("INVALID_PARAMS", "beatGrid range is too short: at least ~0.1 seconds of audio is required");
  const durationSec = totalSamples / BEAT_GRID_ANALYSIS_RATE;
  const result = await analyzeBeatsFromOnsetEnergies(energies.finish(), BEAT_GRID_ANALYSIS_RATE, durationSec);
  progress(1);
  const beats = result.beats.map((beat) => ({
    timeSec: range.startSec + beat.time,
    strength: beat.strength,
    index: beat.index,
  }));
  return {
    coordinateSpace: "source" as const,
    ...range,
    durationSec,
    analysisSampleRate: BEAT_GRID_ANALYSIS_RATE,
    bpm: result.bpm,
    confidence: result.confidence,
    beats,
    beatCount: result.beats.length,
    truncated: false,
    algorithm: "Shared core BeatDetectionEngine (RMS-energy onsets, adaptive threshold, interval-histogram BPM) over FFmpeg-extracted mono PCM; same analyzer as the GUI beat-sync panel",
    limitations: ["Beats and bpm are analyzer inferences from energy periodicity, not ground truth or perceptual annotations.", "Downbeats are not reported: no downbeat detector is installed.", "Source seconds only; map through clip trim/speed before editing. Results do not change gain, markers, playback, selection or project revision."],
  };
}

/** Onset heuristic over the 10ms stereo energy windows — verbatim summary logic. */
function detectSummaryOnsets(energies: number[], startSec: number): number[] {
  const onsets: number[] = [];
  let lastOnset = -100;
  for (let i = 0; i < energies.length; i++) {
    const energy = energies[i] ?? 1;
    const history = energies.slice(Math.max(0, i - 10), i);
    const baseline = history.reduce((a, b) => a + b, 0) / Math.max(1, history.length);
    if (energy > 0.015 && energy > baseline * 2.5 && energy - (energies[i - 1] ?? 0) > 0.01 && i - lastOnset >= 8) {
      onsets.push(startSec + i * .01); lastOnset = i;
    }
  }
  return onsets;
}

/**
 * Assemble the audioSummary observation facts from the accumulated stream
 * state. One code path serves the buffered `summarizePcm` helper and the
 * streamed long-range decode, so both produce identical facts for identical
 * samples.
 */
async function assembleSummary(input: {
  startSec: number;
  energies: number[];
  peaks: number[];
  durationSec: number;
  silence: TimeRange[];
  beatEnergies: Float32Array;
}) {
  const onsets = detectSummaryOnsets(input.energies, input.startSec);
  // Time-domain equivalents of the GUI's 2048/512 window/hop at 44.1kHz
  // (~46ms/~12ms) so the shared kernel keeps GUI-grade resolution on the
  // 8kHz summary mix. Same engine, only the window tuning differs.
  const beatAnalysis = await analyzeBeatsFromOnsetEnergies(input.beatEnergies, 8000, input.durationSec, { windowSize: 384, hopSize: 96 });
  const bpmCandidates = beatAnalysis.confidence >= .7
    ? [{ bpm: beatAnalysis.bpm, confidence: beatAnalysis.confidence }]
    : [];
  const waveform = [150, 600].map((limit) => {
    const stride = Math.max(1, Math.ceil(input.energies.length / limit));
    return { binDurationSec: stride * .01, bins: Array.from({ length: Math.ceil(input.energies.length / stride) }, (_, i) => ({
      rms: Math.sqrt(input.energies.slice(i * stride, (i + 1) * stride).reduce((a, x) => a + x * x, 0) / input.energies.slice(i * stride, (i + 1) * stride).length),
      peak: Math.max(...input.peaks.slice(i * stride, (i + 1) * stride)),
    })) };
  });
  const totalSilenceDurationSec = input.silence.reduce((sum, range) => sum + range.end - range.start, 0);
  return { waveform, onsets, onsetCount: onsets.length,
    silence: input.silence.map((range) => ({ startSec: input.startSec + range.start, endSec: input.startSec + range.end })),
    silenceCount: input.silence.length,
    totalSilenceDurationSec,
    truncated: false,
    bpmCandidates,
    analysisResolutionSec: .01, detectionUncertaintySec: null,
    parameters: { analysisSampleRate: 8000, analysisChannels: 2, hopSec: .01, silenceThresholdDbfs: -60, silenceMinSec: .2, onsetRatio: 2.5, silenceAndBpmChannelStrategy: "strongest absolute sample across stereo channels, preserving sign", silenceAndBpmSource: "shared core kernels (detectSilenceRangesInPcm + BeatDetectionEngine)" },
  };
}

/** Energy onsets are candidates, never semantic events or downbeats. */
export async function summarizePcm(pcm: Buffer, startSec: number) {
  const energy = new StereoEnergyAccumulator(80);
  const frames = pcm.length / 8;
  const mono = new Float32Array(frames);
  energy.push(pcm, mono);
  energy.finish();
  const silenceRanges = detectSilenceRangesInPcm(mono, 8000, -60, 0.2, 0);
  const beatEnergies = computeRawBeatEnergies(mono, { windowSize: 384, hopSize: 96 });
  return assembleSummary({
    startSec,
    energies: energy.energies,
    peaks: energy.peaks,
    durationSec: frames / 8000,
    silence: silenceRanges,
    beatEnergies,
  });
}
/**
 * "audioSummary": streamed 8 kHz stereo analysis mix + one whole-range
 * loudnorm measurement. The integrated LUFS/true-peak/LRA always come from a
 * single whole-range pass (EBU R128 over the exact requested window) — never
 * an average of chunk measurements. Waveform/onset/silence/BPM facts come
 * from the streamed accumulators above.
 */
export async function analyzeLocalAudio(path: string, range: { startSec: number; endSec: number }, signal: AbortSignal, progress: (percent: number) => void = () => {}) {
  validateLongAudioRange(range);
  const binaries = await requireAudioBinaries(signal);
  const probe = await run(binaries.ffprobe, ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate,channels,channel_layout", "-of", "json", path], signal);
  const stream = JSON.parse(probe.out.toString()).streams?.[0];
  if (!stream) throw new FacadeError("UNSUPPORTED", "Source contains no audio stream");
  const input = ["-hide_banner", "-nostdin", "-v", "info", "-ss", String(range.startSec), "-t", String(range.endSec - range.startSec), "-i", path, "-map", "0:a:0", "-vn", "-threads", "1"];
  const duration = range.endSec - range.startSec;
  const expectedBytes = duration * 8000 * 2 * 4;
  const energy = new StereoEnergyAccumulator(80);
  const scanner = new SilenceWindowScanner(8000, -60);
  const beatEnergies = new BeatEnergyAccumulator(384, 96);
  for await (const chunk of streamDecodedPcm(binaries.ffmpeg, decodeArgs(path, range, 8000, 2), 8, audioAnalysisRunBudgetMs(duration), signal, (consumed) => {
    progress(Math.min(0.55, 0.55 * (expectedBytes > 0 ? consumed / expectedBytes : 1)));
  })) {
    const chunkMono = new Float32Array(chunk.length / 8);
    energy.push(chunk, chunkMono);
    scanner.push(chunkMono);
    beatEnergies.push(chunkMono);
  }
  energy.finish();
  const frames = energy.frames;
  const durationSec = frames / 8000;
  const summary = await assembleSummary({
    startSec: range.startSec,
    energies: energy.energies,
    peaks: energy.peaks,
    durationSec,
    silence: postprocessSilenceRanges(scanner.finish(), durationSec, 0.2, 0),
    beatEnergies: beatEnergies.finish(),
  });
  progress(0.55);
  const loudness = await run(binaries.ffmpeg, [...input, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"], signal, audioAnalysisRunBudgetMs(duration));
  progress(0.9);
  const match = loudness.err.match(/\{\s*"input_i"[\s\S]*?\}/);
  if (!match) throw new Error("FFmpeg did not return measured loudness");
  const measured = JSON.parse(match[0]);
  const finite = (x: string) => Number.isFinite(Number(x)) ? Number(x) : null;
  return { coordinateSpace: "source" as const, ...range, durationSec,
    channels: stream.channels, sampleRate: Number(stream.sample_rate), channelLayout: stream.channel_layout ?? null,
    algorithm: "FFmpeg loudnorm input measurements (EBU R128); 10ms stereo RMS energy-rise onset heuristic; silence and BPM via the shared core kernels (detectSilenceRangesInPcm + BeatDetectionEngine)",
    integratedLufs: finite(measured.input_i), truePeakDbtp: finite(measured.input_tp), loudnessRangeLu: finite(measured.input_lra),
    overloadRisk: finite(measured.input_tp) !== null && Number(measured.input_tp) >= 0,
    ...summary,
    limitations: ["Waveform/onsets use an 8kHz stereo analysis mix; original-channel true peak and LUFS come from FFmpeg loudnorm input measurements.", "Onsets and periodicity are candidates, not perceptual beat or bar annotations; request the beatGrid analysis type for beat grids — downbeats are not detected by any installed provider.", "Null loudness means nonfinite/unmeasurable (including silence). No listening or audiovisual review has occurred.", "Source seconds only; map through clip trim/speed before editing. Results do not change gain, markers, playback, selection or project revision."],
  };
}
