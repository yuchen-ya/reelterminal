import type { Clip } from "../types/timeline";
import { SpeedEngine } from "../video/speed-engine";

export type AudioSpeedTiming = Pick<Clip,
  "id" | "inPoint" | "outPoint" | "speed" | "reversed" |
  "speedKeyframes" | "freezeFrames" | "pitchCorrection">;

export const AUDIO_SPEED_CAPABILITIES = {
  constantSpeed: "varispeed when pitchCorrection is false",
  speedCurves: "shared SpeedEngine mapping; band-limited varispeed when pitchCorrection is false",
  pitchCorrection: "unsupported: no validated time-stretch DSP is installed",
  freezeAudio: "unsupported: the product has not defined sound during a video freeze",
} as const;

export class AudioSpeedCapabilityError extends Error {
  constructor(readonly code: "AUDIO_PITCH_CORRECTION_UNAVAILABLE" | "AUDIO_FREEZE_UNDEFINED" | "AUDIO_CURVE_NOT_PREPARED",
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
  const changesPitch = timing.speedKeyframes?.length
    ? timing.speedKeyframes.some((keyframe) => keyframe.speed !== 1)
    : (timing.speed ?? 1) !== 1;
  if (changesPitch && timing.pitchCorrection !== false) {
    throw new AudioSpeedCapabilityError("AUDIO_PITCH_CORRECTION_UNAVAILABLE", timing.id,
      `Clip ${timing.id}: pitch correction requires a time-stretch renderer that is not available. Disable pitch correction for varispeed audio, or use 1x.`);
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

/** Constant speed stays on the native Web Audio resampler. Curves must be
 * prepared before the realtime clock starts, never silently approximated by
 * base speed or prepared inside a timer callback.
 */
export function getPreparedAudioSpeed(buffer: AudioBuffer, timing: AudioSpeedTiming): PreparedAudioSpeed {
  assertAudioSpeedSupported(timing);
  if (!timing.speedKeyframes?.length) return { buffer, timing };
  const entry = prepared.get(buffer)?.get(timing.id);
  if (entry?.signature === signature(timing) && entry.result) return entry.result;
  throw new AudioSpeedCapabilityError("AUDIO_CURVE_NOT_PREPARED", timing.id,
    `Clip ${timing.id}: the audio speed curve has not finished preparing. Prepare it before starting playback.`);
}

export async function prepareAudioSpeed(
  context: BaseAudioContext, buffer: AudioBuffer, timing: AudioSpeedTiming,
): Promise<PreparedAudioSpeed> {
  assertAudioSpeedSupported(timing);
  if (!timing.speedKeyframes?.length) return { buffer, timing };
  let entries = prepared.get(buffer);
  if (!entries) { entries = new Map(); prepared.set(buffer, entries); }
  const key = signature(timing);
  const cached = entries.get(timing.id);
  if (cached?.signature === key) return cached.promise;
  // One revision per clip/source. A late old preparation cannot replace the
  // new entry, and multiple clips using the same source keep distinct trims.
  const snapshot = structuredClone(timing);
  const entry: CacheEntry = { signature: key, promise: renderCurve(context, buffer, snapshot) };
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
