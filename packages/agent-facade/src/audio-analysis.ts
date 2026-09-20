import { spawn } from "node:child_process";
import { detectSilenceRangesInPcm } from "@reelterminal/core/audio/audio-engine";
import { analyzeBeatsInPcm } from "@reelterminal/core/audio/beat-detection-engine";
import { FacadeError } from "./errors";

export const AUDIO_LIMITS = { maxRangeSec: 120, maxConcurrentPerSession: 2, timeoutMs: 60000, maxProcessOutputBytes: 16 * 1024 * 1024, maxWaveformBins: 600, maxEvents: 256 } as const;
let running = 0;
/** Local subprocesses only: no shell, remote provider, uploads or paid dependency. */
function run(binary: string, args: string[], signal?: AbortSignal): Promise<{ out: Buffer; err: string }> {
  if (signal?.aborted) return Promise.reject(new Error("Cancelled"));
  if (running >= 4) return Promise.reject(new Error("Local audio process limit reached; retry after current jobs finish"));
  running++;
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = []; const errors: Buffer[] = [];
    let size = 0; let failure: Error | undefined;
    const stop = (message: string) => { failure = new Error(message); child.kill("SIGKILL"); };
    const abort = () => stop("Cancelled");
    const timer = setTimeout(() => stop("Audio analysis exceeded 60 second process deadline"), AUDIO_LIMITS.timeoutMs);
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
export async function audioAnalysisPreflight() {
  try {
    const ff = await run("ffmpeg", ["-hide_banner", "-filters"]);
    await run("ffprobe", ["-version"]);
    if (!ff.out.toString().includes("loudnorm")) throw new Error("FFmpeg loudnorm filter missing");
    return { available: true, details: { provider: "local-ffmpeg-pcm-loudnorm", ...AUDIO_LIMITS } };
  } catch (error) { return { available: false, reason: `Local audio analysis needs ffmpeg (loudnorm) and ffprobe on PATH: ${String(error)}` }; }
}

/** Mono f32le PCM decode of the requested range at the given analysis rate. */
async function extractMonoPcm(path: string, range: { startSec: number; endSec: number }, rate: number, signal: AbortSignal) {
  const input = ["-hide_banner", "-nostdin", "-v", "info", "-ss", String(range.startSec), "-t", String(range.endSec - range.startSec), "-i", path, "-map", "0:a:0", "-vn", "-threads", "1"];
  const pcm = await run("ffmpeg", [...input, "-ar", String(rate), "-ac", "1", "-f", "f32le", "pipe:1"], signal);
  const samples = new Float32Array(pcm.out.length / 4);
  for (let i = 0; i < samples.length; i++) {
    const x = pcm.out.readFloatLE(i * 4);
    if (!Number.isFinite(x)) throw new Error("Nonfinite audio sample");
    samples[i] = x;
  }
  return samples;
}

function validateAudioRange(range: { startSec: number; endSec: number }) {
  if (!(range.startSec >= 0 && range.endSec > range.startSec && range.endSec - range.startSec <= 120)) throw new FacadeError("INVALID_PARAMS", "Audio range must be 0–120 seconds in source coordinates");
}

/** GUI silence-cut panel defaults (apps/web silence-cut-bridge DEFAULT_SILENCE_SETTINGS). */
export const DEFAULT_SILENCE_ANALYSIS_PARAMS = { thresholdDb: -40, minDurationSec: 0.5, paddingSec: 0.1 } as const;

/**
 * "silence" analysis: the shared core silence kernel over ffmpeg-extracted
 * mono PCM — the same detectSilenceRangesInPcm the GUI silence-cut bridge
 * runs, so agent and GUI agree on what counts as silent. Regions are reported
 * in source seconds after padding and minimum-duration filtering.
 */
export async function analyzeSilence(
  path: string,
  range: { startSec: number; endSec: number },
  params: { thresholdDb?: number; minDurationSec?: number; paddingSec?: number } | undefined,
  signal: AbortSignal,
  progress: (percent: number) => void = () => {},
) {
  validateAudioRange(range);
  const thresholdDb = params?.thresholdDb ?? DEFAULT_SILENCE_ANALYSIS_PARAMS.thresholdDb;
  const minDurationSec = params?.minDurationSec ?? DEFAULT_SILENCE_ANALYSIS_PARAMS.minDurationSec;
  const paddingSec = params?.paddingSec ?? DEFAULT_SILENCE_ANALYSIS_PARAMS.paddingSec;
  if (!(Number.isFinite(thresholdDb) && thresholdDb >= -120 && thresholdDb <= 0)) throw new FacadeError("INVALID_PARAMS", "silenceParams.thresholdDb must be a finite number in [-120, 0] dBFS");
  if (!(Number.isFinite(minDurationSec) && minDurationSec >= 0 && minDurationSec <= 10)) throw new FacadeError("INVALID_PARAMS", "silenceParams.minDurationSec must be a finite number in [0, 10] seconds");
  if (!(Number.isFinite(paddingSec) && paddingSec >= 0 && paddingSec <= 10)) throw new FacadeError("INVALID_PARAMS", "silenceParams.paddingSec must be a finite number in [0, 10] seconds");
  const rate = 8000;
  const pcm = await extractMonoPcm(path, range, rate, signal);
  progress(.7);
  const ranges = detectSilenceRangesInPcm(pcm, rate, thresholdDb, minDurationSec, paddingSec);
  progress(1);
  const regions = ranges.slice(0, AUDIO_LIMITS.maxEvents).map((r) => ({
    startSec: range.startSec + r.start,
    endSec: range.startSec + r.end,
    durationSec: r.end - r.start,
  }));
  return {
    coordinateSpace: "source" as const,
    ...range,
    durationSec: pcm.length / rate,
    analysisSampleRate: rate,
    parameters: { thresholdDb, minDurationSec, paddingSec },
    silentRegions: regions,
    regionCount: ranges.length,
    truncated: ranges.length > AUDIO_LIMITS.maxEvents,
    totalSilenceDurationSec: regions.reduce((sum, region) => sum + region.durationSec, 0),
    algorithm: "Shared core silence kernel (100ms max-amplitude windows, dBFS threshold, padding + minimum-duration filtering) over FFmpeg-extracted mono PCM; same detectSilenceRangesInPcm as the GUI silence-cut panel",
    limitations: ["Silence is an amplitude-threshold judgment, not a semantic pause; adjust thresholdDb/minDurationSec/paddingSec to match the material.", "Source seconds only; map through clip trim/offset before editing. Results do not change gain, markers, playback, selection or project revision."],
  };
}

/** Beat analysis runs on a higher-rate mono mix than the 8kHz summary scan. */
export const BEAT_GRID_ANALYSIS_RATE = 22050;

/**
 * "beatGrid" analysis: the shared core beat-detection engine (same
 * BeatDetectionEngine the GUI beat-sync panel uses) over ffmpeg-extracted
 * mono PCM. Returns beats + bpm + confidence in source coordinates. Downbeats
 * are intentionally absent — no downbeat detector is installed.
 */
export async function analyzeBeatGrid(
  path: string,
  range: { startSec: number; endSec: number },
  signal: AbortSignal,
  progress: (percent: number) => void = () => {},
) {
  validateAudioRange(range);
  const pcm = await extractMonoPcm(path, range, BEAT_GRID_ANALYSIS_RATE, signal);
  progress(.7);
  if (pcm.length < 2048) throw new FacadeError("INVALID_PARAMS", "beatGrid range is too short: at least ~0.1 seconds of audio is required");
  const result = await analyzeBeatsInPcm(pcm, BEAT_GRID_ANALYSIS_RATE);
  progress(1);
  const beats = result.beats.slice(0, AUDIO_LIMITS.maxEvents).map((beat) => ({
    timeSec: range.startSec + beat.time,
    strength: beat.strength,
    index: beat.index,
  }));
  return {
    coordinateSpace: "source" as const,
    ...range,
    durationSec: pcm.length / BEAT_GRID_ANALYSIS_RATE,
    analysisSampleRate: BEAT_GRID_ANALYSIS_RATE,
    bpm: result.bpm,
    confidence: result.confidence,
    beats,
    beatCount: result.beats.length,
    truncated: result.beats.length > AUDIO_LIMITS.maxEvents,
    algorithm: "Shared core BeatDetectionEngine (RMS-energy onsets, adaptive threshold, interval-histogram BPM) over FFmpeg-extracted mono PCM; same analyzer as the GUI beat-sync panel",
    limitations: ["Beats and bpm are analyzer inferences from energy periodicity, not ground truth or perceptual annotations.", "Downbeats are not reported: no downbeat detector is installed.", "Source seconds only; map through clip trim/speed before editing. Results do not change gain, markers, playback, selection or project revision."],
  };
}

/** Energy onsets are candidates, never semantic events or downbeats. */
export async function summarizePcm(pcm: Buffer, startSec: number) {
  const rate = 8000, hop = 80; // 10ms, stereo analysis mix
  const energies: number[] = [], peaks: number[] = [];
  for (let base = 0; base < pcm.length / 8; base += hop) {
    let sum = 0, peak = 0, n = 0;
    for (let i = base; i < Math.min(base + hop, pcm.length / 8); i++) {
      for (let c = 0; c < 2; c++) {
        const x = pcm.readFloatLE(i * 8 + c * 4);
        if (!Number.isFinite(x)) throw new Error("Nonfinite audio sample");
        sum += x * x; peak = Math.max(peak, Math.abs(x)); n++;
      }
    }
    energies.push(Math.sqrt(sum / n)); peaks.push(peak);
  }
  const onsets: number[] = [];
  let lastOnset = -100;
  for (let i = 0; i <= energies.length; i++) {
    const energy = energies[i] ?? 1;
    if (i >= energies.length) break;
    const history = energies.slice(Math.max(0, i - 10), i);
    const baseline = history.reduce((a, b) => a + b, 0) / Math.max(1, history.length);
    if (energy > 0.015 && energy > baseline * 2.5 && energy - (energies[i - 1] ?? 0) > 0.01 && i - lastOnset >= 8) {
      onsets.push(startSec + i * .01); lastOnset = i;
    }
  }
  // Silence and BPM come from the same shared core kernels the GUI uses —
  // the facade keeps no second silence/beat implementation of its own.
  const mono = new Float32Array(pcm.length / 8);
  for (let i = 0; i < mono.length; i++) mono[i] = pcm.readFloatLE(i * 8);
  const silenceRanges = detectSilenceRangesInPcm(mono, rate, -60, 0.2, 0);
  const silence = silenceRanges.slice(0, AUDIO_LIMITS.maxEvents)
    .map((range) => ({ startSec: startSec + range.start, endSec: startSec + range.end }));
  const silenceCount = silenceRanges.length;
  const beatAnalysis = await analyzeBeatsInPcm(mono, rate, {
    // Time-domain equivalents of the GUI's 2048/512 window/hop at 44.1kHz
    // (~46ms/~12ms) so the shared kernel keeps GUI-grade resolution on the
    // 8kHz summary mix. Same engine, only the window tuning differs.
    windowSize: 384,
    hopSize: 96,
  });
  const bpmCandidates = beatAnalysis.confidence >= .7
    ? [{ bpm: beatAnalysis.bpm, confidence: beatAnalysis.confidence }]
    : [];
  const waveform = [150, 600].map((limit) => {
    const stride = Math.max(1, Math.ceil(energies.length / limit));
    return { binDurationSec: stride * .01, bins: Array.from({ length: Math.ceil(energies.length / stride) }, (_, i) => ({
      rms: Math.sqrt(energies.slice(i * stride, (i + 1) * stride).reduce((a, x) => a + x * x, 0) / energies.slice(i * stride, (i + 1) * stride).length),
      peak: Math.max(...peaks.slice(i * stride, (i + 1) * stride)),
    })) };
  });
  return { waveform, onsets: onsets.slice(0, 256), onsetCount: onsets.length, silence, silenceCount,
    truncated: onsets.length > 256 || silenceCount > 256,
    bpmCandidates,
    analysisResolutionSec: .01, detectionUncertaintySec: null,
    parameters: { analysisSampleRate: rate, analysisChannels: 2, hopSec: .01, silenceThresholdDbfs: -60, silenceMinSec: .2, onsetRatio: 2.5, silenceAndBpmSource: "shared core kernels (detectSilenceRangesInPcm + BeatDetectionEngine)" },
  };
}

export async function analyzeLocalAudio(path: string, range: { startSec: number; endSec: number }, signal: AbortSignal, progress: (percent: number) => void = () => {}) {
  validateAudioRange(range);
  const probe = await run("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate,channels,channel_layout", "-of", "json", path], signal);
  const stream = JSON.parse(probe.out.toString()).streams?.[0];
  if (!stream) throw new FacadeError("UNSUPPORTED", "Source contains no audio stream");
  const input = ["-hide_banner", "-nostdin", "-v", "info", "-ss", String(range.startSec), "-t", String(range.endSec - range.startSec), "-i", path, "-map", "0:a:0", "-vn", "-threads", "1"];
  const pcm = await run("ffmpeg", [...input, "-ar", "8000", "-ac", "2", "-f", "f32le", "pipe:1"], signal);
  progress(.55);
  const loudness = await run("ffmpeg", [...input, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"], signal);
  progress(.9);
  const match = loudness.err.match(/\{\s*"input_i"[\s\S]*?\}/);
  if (!match) throw new Error("FFmpeg did not return measured loudness");
  const measured = JSON.parse(match[0]);
  const finite = (x: string) => Number.isFinite(Number(x)) ? Number(x) : null;
  return { coordinateSpace: "source" as const, ...range, durationSec: pcm.out.length / 8 / 8000,
    channels: stream.channels, sampleRate: Number(stream.sample_rate), channelLayout: stream.channel_layout ?? null,
    algorithm: "FFmpeg loudnorm input measurements (EBU R128); 10ms stereo RMS energy-rise onset heuristic; silence and BPM via the shared core kernels (detectSilenceRangesInPcm + BeatDetectionEngine)",
    integratedLufs: finite(measured.input_i), truePeakDbtp: finite(measured.input_tp), loudnessRangeLu: finite(measured.input_lra),
    overloadRisk: finite(measured.input_tp) !== null && Number(measured.input_tp) >= 0,
    ...await summarizePcm(pcm.out, range.startSec),
    limitations: ["Waveform/onsets use an 8kHz stereo analysis mix; original-channel true peak and LUFS come from FFmpeg loudnorm input measurements.", "Onsets and periodicity are candidates, not perceptual beat or bar annotations; request the beatGrid analysis type for beat grids — downbeats are not detected by any installed provider.", "Null loudness means nonfinite/unmeasurable (including silence). No listening or audiovisual review has occurred.", "Source seconds only; map through clip trim/speed before editing. Results do not change gain, markers, playback, selection or project revision."],
  };
}
