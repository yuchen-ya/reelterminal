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

  it("fails explicitly for requested/default pitch correction and freeze sound", () => {
    expect(() => assertAudioSpeedSupported({ ...curve, pitchCorrection: true })).toThrow(/pitch correction/);
    expect(() => assertAudioSpeedSupported({ id: "default", inPoint: 0, outPoint: 4, speed: 2 })).toThrow(/pitch correction/);
    expect(() => assertAudioSpeedSupported({ ...curve, freezeFrames: [
      { id: "f", clipId: curve.id, sourceTime: 1, startTime: 1, duration: 1 },
    ] })).toThrow(/freeze frames is not defined/);
    expect(() => assertAudioSpeedSupported({ ...curve, pitchCorrection: true,
      speedKeyframes: curve.speedKeyframes!.map((kf) => ({ ...kf, speed: 1 })) })).not.toThrow();
  });
});
