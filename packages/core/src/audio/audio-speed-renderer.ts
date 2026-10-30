import type { Clip } from "../types/timeline";
import { SpeedEngine } from "../video/speed-engine";
import type { SignalsmithStretch } from "signalsmith-stretch-js";
import type { SignalsmithStretchWorkerClient } from "signalsmith-stretch-js/worker";

export type AudioSpeedTiming = Pick<Clip,
  "id" | "inPoint" | "outPoint" | "speed" | "reversed" |
  "speedKeyframes" | "freezeFrames" | "pitchCorrection">;

export const AUDIO_SPEED_CAPABILITIES = {
  constantSpeed: "Signalsmith Stretch WASM with pitch preservation by default; native varispeed when pitchCorrection is false",
  speedCurves: "shared SpeedEngine mapping; band-limited varispeed when pitchCorrection is false",
  pitchCorrection: "constant speed, including constant-valued keyframes; varying speed curves are unsupported",
  freezeAudio: "unsupported: the product has not defined sound during a video freeze",
} as const;

export class AudioSpeedCapabilityError extends Error {
  constructor(readonly code: "AUDIO_PITCH_CORRECTION_UNAVAILABLE" | "AUDIO_FREEZE_UNDEFINED" | "AUDIO_CURVE_NOT_PREPARED" | "AUDIO_SPEED_NOT_PREPARED",
    readonly clipId: string, message: string) {
    super(message);
    this.name = "AudioSpeedCapabilityError";
  }
}

export function assertAudioSpeedSupported(timing: AudioSpeedTiming): void {
  if (timing.freezeFrames?.length) {
    throw new AudioSpeedCapabilityError("AUDIO_FREEZE_UNDEFINED", timing.id,
      `Clip ${timing.id}: audio during freeze frames is not defined. Mute this clip's audio or remove the freeze to play/render audio.`);
  }
  if (constantSpeed(timing) === undefined && timing.pitchCorrection !== false) {
    throw new AudioSpeedCapabilityError("AUDIO_PITCH_CORRECTION_UNAVAILABLE", timing.id,
      `Clip ${timing.id}: pitch correction currently supports constant speed only. Use constant speed, or explicitly disable pitch correction for a speed curve.`);
  }
}

export interface PreparedAudioSpeed {
  buffer: AudioBuffer;
  timing: AudioSpeedTiming;
}

type CacheEntry = { signature: string; promise: Promise<PreparedAudioSpeed>; result?: PreparedAudioSpeed };
const prepared = new WeakMap<AudioBuffer, Map<string, CacheEntry>>();

export function prunePreparedAudioSpeed(buffer: AudioBuffer, clipIds: ReadonlySet<string>): void {
  const entries = prepared.get(buffer);
  if (!entries) return;
  for (const id of entries.keys()) if (!clipIds.has(id)) entries.delete(id);
}

function signature(timing: AudioSpeedTiming): string {
  return JSON.stringify([timing.inPoint, timing.outPoint, timing.speed ?? 1, timing.reversed ?? false,
    timing.pitchCorrection ?? true, timing.speedKeyframes ?? [], timing.freezeFrames ?? []]);
}

function constantSpeed(timing: AudioSpeedTiming): number | undefined {
  const keyframes = timing.speedKeyframes;
  if (!keyframes?.length) return timing.speed ?? 1;
  const speed = keyframes[0].speed;
  return keyframes.every((keyframe) => keyframe.speed === speed) ? speed : undefined;
}

function needsPreparation(timing: AudioSpeedTiming): boolean {
  return Boolean(timing.speedKeyframes?.length) ||
    (timing.pitchCorrection !== false && (timing.speed ?? 1) !== 1);
}

/** Pitch-preserving speed changes and varispeed curves are rendered once,
 * before the realtime clock starts. Native constant varispeed and 1x retain
 * their original buffers. Both preview and export consume the same prepared PCM.
 */
export function getPreparedAudioSpeed(buffer: AudioBuffer, timing: AudioSpeedTiming): PreparedAudioSpeed {
  assertAudioSpeedSupported(timing);
  if (!needsPreparation(timing)) return { buffer, timing };
  const entry = prepared.get(buffer)?.get(timing.id);
  if (entry?.signature === signature(timing) && entry.result) return entry.result;
  throw new AudioSpeedCapabilityError(timing.speedKeyframes?.length ? "AUDIO_CURVE_NOT_PREPARED" : "AUDIO_SPEED_NOT_PREPARED", timing.id,
    `Clip ${timing.id}: audio speed processing has not finished preparing. Prepare it before starting playback.`);
}

export async function prepareAudioSpeed(
  context: BaseAudioContext, buffer: AudioBuffer, timing: AudioSpeedTiming,
): Promise<PreparedAudioSpeed> {
  assertAudioSpeedSupported(timing);
  if (!needsPreparation(timing)) return { buffer, timing };
  let entries = prepared.get(buffer);
  if (!entries) { entries = new Map(); prepared.set(buffer, entries); }
  const key = signature(timing);
  const cached = entries.get(timing.id);
  if (cached?.signature === key) return cached.promise;
  // One revision per clip/source. A late old preparation cannot replace the
  // new entry, and multiple clips using the same source keep distinct trims.
  const snapshot = structuredClone(timing);
  const entry: CacheEntry = { signature: key, promise: snapshot.pitchCorrection !== false
    ? renderConstantPitchPreserving(context, buffer, snapshot, constantSpeed(snapshot)!)
    : renderCurve(context, buffer, snapshot) };
  entries.set(timing.id, entry);
  try {
    const result = await entry.promise;
    entry.result = result;
    return result;
  } catch (error) {
    if (entries.get(timing.id) === entry) entries.delete(timing.id);
    throw error;
  }
}

let stretchEngine: Promise<Pick<SignalsmithStretch | SignalsmithStretchWorkerClient, "process">> | undefined;

function getStretchEngine() {
  // Browser preparation must keep the editor responsive. Node has no Web
  // Worker and uses the same WASM directly for offline tools and PCM tests.
  stretchEngine ??= (typeof Worker !== "undefined"
    ? import("signalsmith-stretch-js/worker").then(({ SignalsmithStretchWorkerClient }) => SignalsmithStretchWorkerClient.create())
    : import("signalsmith-stretch-js").then(({ createSignalsmithStretch }) => createSignalsmithStretch()))
    .catch((error) => {
      stretchEngine = undefined;
      throw error;
    });
  return stretchEngine;
}

async function renderConstantPitchPreserving(
  context: BaseAudioContext, source: AudioBuffer, timing: AudioSpeedTiming, speed: number,
): Promise<PreparedAudioSpeed> {
  // Constant-valued keyframes override base speed just as they do in SpeedEngine.
  if (speed === 1) return { buffer: source, timing: { ...timing, speed: 1, speedKeyframes: undefined } };
  const duration = (timing.outPoint - timing.inPoint) / speed;
  const rate = source.sampleRate;
  const length = Math.ceil(duration * rate);
  const inputLength = Math.ceil((timing.outPoint - timing.inPoint) * rate);
  if (!Number.isFinite(length) || length < 1) throw new Error(`Clip ${timing.id}: invalid audio speed duration`);
  const trimStart = Math.ceil(timing.inPoint * rate);
  const inputs = Array.from({ length: source.numberOfChannels }, (_, channel) => {
    const data = new Float32Array(inputLength);
    const first = Math.max(0, trimStart);
    const end = Math.min(source.length, trimStart + inputLength);
    if (end > first) data.set(source.getChannelData(channel).subarray(first, end), first - trimStart);
    if (timing.reversed) data.reverse();
    return data;
  });
  const engine = await getStretchEngine();
  // The library's offline exact() compensates its input/output latency and
  // flushes the tail. It also pads very short input, then returns the exact
  // requested frame count. Cropping first keeps adjacent source audio out of
  // analysis windows, and reversing first makes seek offsets timeline-relative.
  const result = await engine.process({ sampleRate: rate, channels: inputs,
    timeRatio: length / inputLength, pitchScale: 1, quality: "balanced" });
  const output = context.createBuffer(source.numberOfChannels, length, rate);
  result.channels.forEach((data, channel) => output.getChannelData(channel).set(data));
  return { buffer: output, timing: { id: timing.id, inPoint: 0, outPoint: duration,
    speed: 1, reversed: false, pitchCorrection: false } };
}

const RADIUS = 16;
const PHASES = 64;
type Kernel = { radius: number; taps: number; values: Float32Array };
const kernels = new Map<number, Kernel>();

// Windowed sinc interpolation with a rate-dependent low-pass cutoff. A
// downsample must reject frequencies above the output Nyquist frequency;
// linear interpolation alone aliases them into the speech/music band.
function kernelFor(step: number): Kernel {
  const rate = Math.max(16, Math.min(320, Math.ceil(step * 16)));
  const cached = kernels.get(rate);
  if (cached) return cached;
  const cutoff = 16 / rate;
  // Keep a fixed transition width in output-frequency space at high speeds.
  // A fixed short kernel would let low source frequencies alias at 20x.
  const radius = Math.ceil(RADIUS * rate / 16);
  const taps = radius * 2;
  const table = new Float32Array(PHASES * taps);
  for (let phase = 0; phase < PHASES; phase++) {
    let sum = 0;
    for (let tap = 0; tap < taps; tap++) {
      const distance = tap - radius + 1 - phase / PHASES;
      const angle = Math.PI * distance * cutoff;
      const sinc = Math.abs(angle) < 1e-12 ? 1 : Math.sin(angle) / angle;
      const weight = Math.abs(distance) < radius
        ? cutoff * sinc * (0.5 + 0.5 * Math.cos(Math.PI * distance / radius)) : 0;
      table[phase * taps + tap] = weight;
      sum += weight;
    }
    for (let tap = 0; tap < taps; tap++) table[phase * taps + tap] /= sum;
  }
  const kernel = { radius, taps, values: table };
  kernels.set(rate, kernel);
  return kernel;
}

async function renderCurve(context: BaseAudioContext, source: AudioBuffer, timing: AudioSpeedTiming): Promise<PreparedAudioSpeed> {
  const engine = new SpeedEngine();
  engine.loadClips([timing as Clip]);
  const duration = engine.getEffectiveDuration(timing.id);
  const rate = source.sampleRate;
  const length = Math.ceil(duration * rate);
  if (!Number.isFinite(length) || length < 1) throw new Error(`Clip ${timing.id}: invalid audio speed-curve duration`);
  const output = context.createBuffer(source.numberOfChannels, length, rate);
  const inputs = Array.from({ length: source.numberOfChannels }, (_, channel) => source.getChannelData(channel));
  const outputs = inputs.map((_, channel) => output.getChannelData(channel));
  const trimStart = Math.max(0, Math.ceil(timing.inPoint * rate));
  const trimEnd = Math.min(source.length, Math.ceil(timing.outPoint * rate));
  const positionAt = (frame: number) => (timing.inPoint + engine.getSourceTimeAtPlaybackTime(timing.id, frame / rate)) * rate
    - (timing.reversed ? 1 : 0);
  let position = positionAt(0);
  for (let frame = 0; frame < length; frame++) {
    const next = positionAt(frame + 1);
    const kernel = kernelFor(Math.abs(next - position));
    const center = Math.floor(position);
    const phase = Math.min(PHASES - 1, Math.floor((position - center) * PHASES));
    for (let channel = 0; channel < inputs.length; channel++) {
      let value = 0;
      for (let tap = 0; tap < kernel.taps; tap++) {
        const index = center + tap - kernel.radius + 1;
        if (index >= trimStart && index < trimEnd) value += inputs[channel][index] * kernel.values[phase * kernel.taps + tap];
      }
      outputs[channel][frame] = value;
    }
    position = next;
    if (frame > 0 && frame % 8192 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return { buffer: output, timing: { id: timing.id, inPoint: 0, outPoint: duration, speed: 1, reversed: false, pitchCorrection: false } };
}
