import { spawn } from "node:child_process";
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

/** Energy onsets are candidates, never semantic events or downbeats. */
export function summarizePcm(pcm: Buffer, startSec: number) {
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
  const onsets: number[] = [], silence: { startSec: number; endSec: number }[] = [];
  let silent = -1, lastOnset = -100;
  for (let i = 0; i <= energies.length; i++) {
    const energy = energies[i] ?? 1;
    if (energy < 0.001 && silent < 0) silent = i;
    if (energy >= 0.001 && silent >= 0) {
      if (i - silent >= 20) silence.push({ startSec: startSec + silent * .01, endSec: startSec + i * .01 });
      silent = -1;
    }
    if (i >= energies.length) break;
    const history = energies.slice(Math.max(0, i - 10), i);
    const baseline = history.reduce((a, b) => a + b, 0) / Math.max(1, history.length);
    if (energy > 0.015 && energy > baseline * 2.5 && energy - (energies[i - 1] ?? 0) > 0.01 && i - lastOnset >= 8) {
      onsets.push(startSec + i * .01); lastOnset = i;
    }
  }
  const intervals = onsets.slice(1).map((t, i) => t - onsets[i]).filter((d) => d >= .25 && d <= 1.5);
  const sorted = [...intervals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const confidence = median && onsets.length >= 5 ? intervals.filter((d) => Math.abs(d - median) < .03).length / Math.max(1, onsets.length - 1) : 0;
  const waveform = [150, 600].map((limit) => {
    const stride = Math.max(1, Math.ceil(energies.length / limit));
    return { binDurationSec: stride * .01, bins: Array.from({ length: Math.ceil(energies.length / stride) }, (_, i) => ({
      rms: Math.sqrt(energies.slice(i * stride, (i + 1) * stride).reduce((a, x) => a + x * x, 0) / energies.slice(i * stride, (i + 1) * stride).length),
      peak: Math.max(...peaks.slice(i * stride, (i + 1) * stride)),
    })) };
  });
  return { waveform, onsets: onsets.slice(0, 256), onsetCount: onsets.length, silence: silence.slice(0, 256), silenceCount: silence.length,
    truncated: onsets.length > 256 || silence.length > 256,
    bpmCandidates: confidence >= .7 ? [{ bpm: 60 / median, confidence }] : [],
    beatGrid: [], downbeats: [], analysisResolutionSec: .01, detectionUncertaintySec: null,
    parameters: { analysisSampleRate: rate, analysisChannels: 2, hopSec: .01, silenceThresholdDbfs: -60, silenceMinSec: .2, onsetRatio: 2.5 },
  };
}

export async function analyzeLocalAudio(path: string, range: { startSec: number; endSec: number }, signal: AbortSignal, progress: (percent: number) => void = () => {}) {
  if (!(range.startSec >= 0 && range.endSec > range.startSec && range.endSec - range.startSec <= 120)) throw new FacadeError("INVALID_PARAMS", "Audio range must be 0–120 seconds in source coordinates");
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
  return { coordinateSpace: "source", ...range, durationSec: pcm.out.length / 8 / 8000,
    channels: stream.channels, sampleRate: Number(stream.sample_rate), channelLayout: stream.channel_layout ?? null,
    algorithm: "FFmpeg loudnorm input measurements (EBU R128); 10ms stereo RMS energy-rise onset heuristic",
    integratedLufs: finite(measured.input_i), truePeakDbtp: finite(measured.input_tp), loudnessRangeLu: finite(measured.input_lra),
    overloadRisk: finite(measured.input_tp) !== null && Number(measured.input_tp) >= 0,
    ...summarizePcm(pcm.out, range.startSec),
    limitations: ["Waveform/onsets use an 8kHz stereo analysis mix; original-channel true peak and LUFS come from FFmpeg loudnorm input measurements.", "Onsets and periodicity are candidates, not perceptual beat or bar annotations; no downbeat detector is installed.", "Null loudness means nonfinite/unmeasurable (including silence). No listening or audiovisual review has occurred.", "Source seconds only; map through clip trim/speed before editing. Results do not change gain, markers, playback, selection or project revision."],
  };
}
