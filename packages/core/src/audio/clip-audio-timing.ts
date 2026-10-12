import type { Clip } from "../types/timeline";
import { SpeedEngine } from "../video/speed-engine";

export interface ConstantSpeedAudioTiming {
  inPoint: number;
  outPoint: number;
  speed?: number;
  reversed?: boolean;
}

export interface AudioSourceRange {
  /** Source-buffer seconds, at the entering edge (the high edge for reverse). */
  sourceTime: number;
  /** Seconds of source PCM to consume, not seconds on the timeline. */
  sourceDuration: number;
  playbackDuration: number;
  speed: number;
}

/** Use the canonical speed kernel for constant-speed audio trim/seek mapping.
 * Curves and freeze frames require a variable-rate audio renderer; they are
 * deliberately not represented by this constant-rate Web Audio schedule.
 */
export function getConstantSpeedAudioRange(
  timing: ConstantSpeedAudioTiming,
  clipOffset: number,
  playbackDuration: number,
): AudioSourceRange | null {
  if (timing.outPoint <= timing.inPoint || playbackDuration <= 0) return null;
  const clip = { id: "audio-timing", inPoint: timing.inPoint, outPoint: timing.outPoint,
    speed: timing.speed, reversed: timing.reversed } as Clip;
  const engine = new SpeedEngine();
  engine.loadClips([clip]);
  const start = Math.max(0, clipOffset);
  const end = Math.min(start + playbackDuration, engine.getEffectiveDuration(clip.id));
  if (end <= start) return null;
  const sourceTime = timing.inPoint + engine.getSourceTimeAtPlaybackTime(clip.id, start);
  const sourceEnd = timing.inPoint + engine.getSourceTimeAtPlaybackTime(clip.id, end);
  return {
    sourceTime,
    sourceDuration: Math.abs(sourceEnd - sourceTime),
    playbackDuration: end - start,
    speed: engine.getClipSpeed(clip.id),
  };
}

const reversedBuffers = new WeakMap<AudioBuffer, AudioBuffer>();

/** Web Audio buffer playback uses a positive rate; reverse PCM explicitly. */
export function getReversedAudioBuffer(
  context: BaseAudioContext,
  buffer: AudioBuffer,
): AudioBuffer {
  const cached = reversedBuffers.get(buffer);
  if (cached) return cached;
  const reversed = context.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const input = buffer.getChannelData(channel);
    const output = reversed.getChannelData(channel);
    for (let i = 0; i < input.length; i++) output[i] = input[input.length - 1 - i];
  }
  reversedBuffers.set(buffer, reversed);
  return reversed;
}
