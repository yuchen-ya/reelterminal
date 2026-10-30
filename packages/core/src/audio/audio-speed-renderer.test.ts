import { describe, expect, it } from "vitest";
import { assertAudioSpeedSupported, prepareAudioSpeed, getPreparedAudioSpeed,
  prunePreparedAudioSpeed,
  type AudioSpeedTiming } from "./audio-speed-renderer";

function buffer(channels: number, length: number, sampleRate: number): AudioBuffer {
  const data = Array.from({ length: channels }, () => new Float32Array(length));
  return { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate,
    getChannelData: (channel: number) => data[channel] } as AudioBuffer;
}
const context = { createBuffer: buffer } as unknown as BaseAudioContext;
const curve: AudioSpeedTiming = { id: "curve", inPoint: 1, outPoint: 5, speed: 17, pitchCorrection: false,
  speedKeyframes: [
    { id: "a", time: 0, speed: 1, easing: "linear" },
    { id: "b", time: 4, speed: 2, easing: "linear" },
  ] };

describe("shared audio speed rendering", () => {
  it("follows the analytical linear-source curve, trim and reverse", async () => {
    const source = buffer(2, 6 * 8000, 8000);
    for (let i = 0; i < source.length; i++) {
      source.getChannelData(0)[i] = i / 8000 / 6;
      source.getChannelData(1)[i] = -i / 8000 / 6;
    }
    for (const reversed of [false, true]) {
      const timing = { ...curve, reversed };
      const rendered = await prepareAudioSpeed(context, source, timing);
      expect(rendered.buffer.length).toBe(Math.ceil(4 * Math.log(2) * 8000));
      for (const time of [0.1, 0.8, 1.6, 2.6]) {
        const movingSource = 4 * (Math.exp(time / 4) - 1);
        const expected = (1 + (reversed ? 4 - movingSource - 1 / 8000 : movingSource)) / 6;
        expect(rendered.buffer.getChannelData(0)[Math.round(time * 8000)]).toBeCloseTo(expected, 5);
        expect(rendered.buffer.getChannelData(1)[Math.round(time * 8000)]).toBeCloseTo(-expected, 5);
      }
    }
  });

  it("rejects unprepared curves and invalidates cached PCM after a curve edit", async () => {
    const source = buffer(1, 48000, 8000);
    expect(() => getPreparedAudioSpeed(source, curve)).toThrow(/not finished preparing/);
    const first = await prepareAudioSpeed(context, source, curve);
    expect(getPreparedAudioSpeed(source, curve).buffer).toBe(first.buffer);
    const changed = { ...curve, speedKeyframes: curve.speedKeyframes!.map((kf) => ({ ...kf, speed: 1 })) };
    expect(() => getPreparedAudioSpeed(source, changed)).toThrow(/not finished preparing/);
    const second = await prepareAudioSpeed(context, source, changed);
    expect(second.buffer.length).toBe(32000);
    expect(second.buffer).not.toBe(first.buffer);
  });

  it("does not let a late previous revision replace the current preparation", async () => {
    const source = buffer(1, 48000, 8000);
    const old = prepareAudioSpeed(context, source, curve);
    const changed = { ...curve, outPoint: 2, speedKeyframes: [{ id: "a", time: 0, speed: 1, easing: "linear" as const }] };
    const current = await prepareAudioSpeed(context, source, changed);
    await old;
    expect(getPreparedAudioSpeed(source, changed).buffer).toBe(current.buffer);
  });
  it("drops removed clip PCM without dropping retained clips using the same source", async () => {
    const source = buffer(1, 48000, 8000);
    await prepareAudioSpeed(context, source, curve);
    const retained = { ...curve, id: "retained" };
    const result = await prepareAudioSpeed(context, source, retained);
    prunePreparedAudioSpeed(source, new Set([retained.id]));
    expect(() => getPreparedAudioSpeed(source, curve)).toThrow(/not finished preparing/);
    expect(getPreparedAudioSpeed(source, retained).buffer).toBe(result.buffer);
  });

  it.each([2, 20])("filters high source frequencies before %sx resampling", async (speed) => {
    const source = buffer(1, 16000, 16000);
    const frequency = speed === 2 ? 6000 : 900;
    for (let i = 0; i < source.length; i++) source.getChannelData(0)[i] = 0.5 * Math.cos(2 * Math.PI * frequency * i / 16000);
    const timing = { id: "alias", inPoint: 0, outPoint: 1, pitchCorrection: false,
      speedKeyframes: [{ id: "a", time: 0, speed, easing: "linear" as const }] };
    const rendered = (await prepareAudioSpeed(context, source, timing)).buffer.getChannelData(0);
    const inner = rendered.slice(Math.ceil(rendered.length * 0.1), Math.floor(rendered.length * 0.9));
    const rms = Math.sqrt(inner.reduce((sum, x) => sum + x * x, 0) / inner.length);
    expect(rms).toBeLessThan(0.001);
  });

  it("does not read PCM outside the trim window", async () => {
    const source = buffer(1, 48000, 8000);
    source.getChannelData(0).fill(1);
    source.getChannelData(0).fill(0, 8000, 40000);
    const rendered = (await prepareAudioSpeed(context, source, curve)).buffer;
    expect(rendered.getChannelData(0).every((x) => x === 0)).toBe(true);
  });

  it("supports constant pitch correction and rejects varying curves and freeze sound explicitly", () => {
    expect(() => assertAudioSpeedSupported({ ...curve, pitchCorrection: true })).toThrow(/pitch correction/);
    expect(() => assertAudioSpeedSupported({ id: "default", inPoint: 0, outPoint: 4, speed: 2 })).not.toThrow();
    expect(() => assertAudioSpeedSupported({ ...curve, freezeFrames: [
      { id: "f", clipId: curve.id, sourceTime: 1, startTime: 1, duration: 1 },
    ] })).toThrow(/freeze frames is not defined/);
    expect(() => assertAudioSpeedSupported({ ...curve, pitchCorrection: true,
      speedKeyframes: curve.speedKeyframes!.map((kf) => ({ ...kf, speed: 1 })) })).not.toThrow();
  });
});

function tone(channels = 2, seconds = 3, rate = 24000): AudioBuffer {
  const source = buffer(channels, Math.round(seconds * rate), rate);
  for (let c = 0; c < channels; c++) {
    const data = source.getChannelData(c);
    for (let i = 0; i < data.length; i++) data[i] = 0.4 * Math.sin(2 * Math.PI * (c ? 660 : 440) * i / rate);
  }
  return source;
}

function frequency(data: Float32Array, rate: number): number {
  const start = Math.round(data.length * 0.2);
  const end = Math.round(data.length * 0.8);
  const crossings: number[] = [];
  for (let i = start; i < end - 1; i++) {
    if (data[i] <= 0 && data[i + 1] > 0) crossings.push(i - data[i] / (data[i + 1] - data[i]));
  }
  return (crossings.length - 1) * rate / (crossings[crossings.length - 1] - crossings[0]);
}

const rms = (data: Float32Array) => Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);

describe("Signalsmith pitch-preserving PCM", () => {
  it("reverses the full trim including silent source overrun before stretching", async () => {
    const source = tone(1, 1);
    const rendered = await prepareAudioSpeed(context, source,
      { id: "reverse-overrun", inPoint: 0, outPoint: 2, reversed: true, speed: 2 });
    const pcm = rendered.buffer.getChannelData(0);
    const rate = source.sampleRate;
    // Reverse enters at outPoint=2, so the missing [1,2) source audio plays
    // first. Moving padding to the tail would shift audible content by 0.5s.
    expect(rms(pcm.subarray(Math.round(0.1 * rate), Math.round(0.4 * rate)))).toBeLessThan(0.005);
    expect(rms(pcm.subarray(Math.round(0.6 * rate), Math.round(0.9 * rate)))).toBeGreaterThan(0.1);
  });

  it.each([0.5, 1.5, 2, 20])("preserves independent stereo pitches and exact duration at %sx", async (speed) => {
    const source = tone();
    const timing = { id: `pitch-${speed}`, inPoint: 0.25, outPoint: 2.75, speed };
    expect(() => getPreparedAudioSpeed(source, timing)).toThrow(/not finished preparing/);
    const result = await prepareAudioSpeed(context, source, timing);
    expect(result.buffer.length).toBe(Math.ceil(2.5 / speed * source.sampleRate));
    expect(result.timing).toMatchObject({ inPoint: 0, outPoint: 2.5 / speed, speed: 1, reversed: false });
    for (const channel of [0, 1]) {
      const pcm = result.buffer.getChannelData(channel);
      expect(pcm.every(Number.isFinite)).toBe(true);
      expect(frequency(pcm, source.sampleRate)).toBeCloseTo(channel ? 660 : 440, 0);
      expect(rms(pcm)).toBeGreaterThan(0.1);
    }
    expect(getPreparedAudioSpeed(source, timing).buffer).toBe(result.buffer);
  });

  it("retains native 1x and explicit varispeed buffers", async () => {
    const source = tone(1);
    for (const timing of [
      { id: "normal", inPoint: 0, outPoint: 3 },
      { id: "varispeed", inPoint: 0, outPoint: 3, speed: 1.5, pitchCorrection: false },
    ]) expect((await prepareAudioSpeed(context, source, timing)).buffer).toBe(source);
  });

  it("accepts constant-valued keyframes and overrides the unrelated base speed", async () => {
    const source = tone(1);
    const result = await prepareAudioSpeed(context, source, { id: "constant-curve", inPoint: 0, outPoint: 3, speed: 17,
      speedKeyframes: [0, 3].map((time) => ({ id: String(time), time, speed: 1.5, easing: "linear" as const })) });
    expect(result.buffer.duration).toBe(2);
    expect(frequency(result.buffer.getChannelData(0), source.sampleRate)).toBeCloseTo(440, 0);
    expect(result.timing.speedKeyframes).toBeUndefined();
  });

  it.each([false, true])("isolates the trim and retains beat positions, including both ends (reverse %s)", async (reversed) => {
    const rate = 24000;
    const source = buffer(1, 5 * rate, rate);
    const data = source.getChannelData(0);
    // Outside the trim is deliberately loud. Inside it has five short beats.
    data.fill(1, 0, rate);
    data.fill(1, 4 * rate);
    const beats = [0.04, 0.6, 1.5, 2.4, 2.96];
    for (const beat of beats) {
      const start = Math.round((1 + beat - 0.015) * rate);
      for (let i = 0; i < 0.03 * rate; i++) data[start + i] = 0.8 * Math.sin(Math.PI * i / (0.03 * rate)) * Math.sin(2 * Math.PI * 1000 * i / rate);
    }
    const result = await prepareAudioSpeed(context, source, { id: `beats-${reversed}`, inPoint: 1, outPoint: 4, speed: 1.5, reversed });
    const pcm = result.buffer.getChannelData(0);
    for (const beat of beats) {
      const expected = (reversed ? 3 - beat : beat) / 1.5;
      const from = Math.max(0, Math.round((expected - 0.04) * rate));
      const to = Math.min(pcm.length, Math.round((expected + 0.04) * rate));
      expect(rms(pcm.subarray(from, to))).toBeGreaterThan(0.025);
    }
    expect(rms(pcm.subarray(Math.round(0.65 * rate), Math.round(0.8 * rate)))).toBeLessThan(0.005);
  });

  it("does not import adjacent audio into a silent trim and processes a very short clip", async () => {
    const source = tone(1);
    source.getChannelData(0).fill(0, 24000, 48000);
    const silent = await prepareAudioSpeed(context, source, { id: "silent", inPoint: 1, outPoint: 2, speed: 1.5 });
    expect(silent.buffer.getChannelData(0).every((value) => value === 0)).toBe(true);
    const short = await prepareAudioSpeed(context, source, { id: "short", inPoint: 0, outPoint: 0.025, speed: 1.5 });
    expect(short.buffer.length).toBe(400);
    expect(rms(short.buffer.getChannelData(0))).toBeGreaterThan(0.05);
  });

  it("invalidates constant-speed PCM for speed, trim, reverse and pitch mode edits", async () => {
    const source = tone(1);
    const timing = { id: "edited", inPoint: 0, outPoint: 3, speed: 1.5 };
    let previous = await prepareAudioSpeed(context, source, timing);
    for (const changed of [{ ...timing, speed: 2 }, { ...timing, inPoint: 0.5 }, { ...timing, reversed: true }]) {
      expect(() => getPreparedAudioSpeed(source, changed)).toThrow(/not finished preparing/);
      const current = await prepareAudioSpeed(context, source, changed);
      expect(current.buffer).not.toBe(previous.buffer);
      previous = current;
    }
    expect(getPreparedAudioSpeed(source, { ...timing, pitchCorrection: false }).buffer).toBe(source);
  });
});
