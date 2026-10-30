import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioEngine } from "./audio-engine";
import type { Clip } from "../types/timeline";
import type { Project } from "../types/project";

const param = () => ({ value: 1, setValueAtTime: vi.fn(), cancelScheduledValues: vi.fn(), linearRampToValueAtTime: vi.fn() });
const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
class FakeContext {
  static renders: FakeContext[] = [];
  sampleRate = 48000;
  destination = node();
  sources: Array<{ buffer: AudioBuffer | null; playbackRate: { value: number }; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
  constructor() { FakeContext.renders.push(this); }
  createGain() { return { ...node(), gain: param() }; }
  createStereoPanner() { return { ...node(), pan: param() }; }
  createBuffer(channels: number, length: number, sampleRate: number) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { duration: length / sampleRate, length, sampleRate, numberOfChannels: channels,
      getChannelData: (channel: number) => data[channel] } as AudioBuffer;
  }
  createBufferSource() {
    const source = { ...node(), buffer: null as AudioBuffer | null, playbackRate: { value: 1 }, start: vi.fn(), stop: vi.fn() };
    this.sources.push(source);
    return source;
  }
  async startRendering() { return {} as AudioBuffer; }
}

async function render(speed: number, start: number, duration: number, overrides: Partial<Clip> = {},
  trackFlags: { muted?: boolean; hidden?: boolean } = {}, effectsEngine?: object) {
  FakeContext.renders = [];
  vi.stubGlobal("OfflineAudioContext", FakeContext);
  const engine = new AudioEngine();
  Object.assign(engine, { initialized: true, audioContext: {},
    mediaBuffers: new Map([["media:0", new FakeContext().createBuffer(1, 12 * 8000, 8000)]]) });
  if (effectsEngine) Object.assign(engine, { effectsEngine, audioContext: new FakeContext() });
  FakeContext.renders = [];
  const clip = { id: "clip", trackId: "track", mediaId: "media", startTime: 5,
    inPoint: 3, outPoint: 11, duration: 8 / speed, speed, pitchCorrection: false, volume: 1, effects: [], ...overrides } as Clip;
  const project = { settings: { sampleRate: 48000, channels: 2 },
    timeline: { tracks: [{ id: "track", type: "audio", clips: [clip], transitions: [], ...trackFlags }] },
    mediaLibrary: { items: [{ id: "media", metadata: { duration: 12 } }] } } as unknown as Project;
  await engine.renderAudio(project, start, duration);
  return FakeContext.renders[0].sources;
}

describe("offline audio timeline/source timing", () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([0.5, 1, 2])("renders a complete trimmed clip at %sx", async (speed) => {
    const [source] = await render(speed, 0, 24);
    expect(source.playbackRate.value).toBe(speed);
    expect(source.start).toHaveBeenCalledWith(5, 3, 8);
    expect(source.stop).toHaveBeenCalledWith(5 + 8 / speed);
  });
  it.each([0.5, 1, 2])("maps mid-clip render ranges at %sx", async (speed) => {
    const [source] = await render(speed, 6, 1);
    expect(source.start).toHaveBeenCalledWith(0, 3 + speed, speed);
    expect(source.stop).toHaveBeenCalledWith(1);
  });
  it("continues at the correct source offset across render chunks", async () => {
    const [first] = await render(2, 0, 7);
    const [second] = await render(2, 7, 2);
    expect(first.start).toHaveBeenCalledWith(5, 3, 4);
    expect(second.start).toHaveBeenCalledWith(0, 7, 4);
  });
  it("does not consume samples beyond outPoint even when timeline coverage is longer", async () => {
    const [source] = await render(2, 5, 6, { duration: 6 });
    expect(source.start).toHaveBeenCalledWith(0, 3, 8);
    expect(await render(2, 9, 2, { duration: 6 })).toHaveLength(0);
  });
  it("plays prepared pitch-preserving PCM at 1x and maps render ranges without applying speed twice", async () => {
    const [source] = await render(2, 6, 1, { pitchCorrection: true });
    expect(source.buffer!.duration).toBe(4);
    expect(source.playbackRate.value).toBe(1);
    expect(source.start).toHaveBeenCalledWith(0, 1, 1);
    expect(source.stop).toHaveBeenCalledWith(1);
  });
  it("applies source noise profiles before speed processing and remaining effects on prepared timeline PCM", async () => {
    const clean = new FakeContext().createBuffer(1, 12 * 8000, 8000);
    for (let i = 0; i < clean.length; i++) clean.getChannelData(0)[i] = 0.4 * Math.sin(2 * Math.PI * 440 * i / 8000);
    const profile = { frequencyBins: [0, 4000], magnitudes: [0.01, 0.01], sampleRate: 8000 };
    const noise = { id: "noise", type: "noiseReduction", enabled: true, params: { profile, reduction: 0.5 } };
    const gain = { id: "gain", type: "gain", enabled: true, params: { value: 0.5 } };
    const applyNoiseReductionWithProfileData = vi.fn(async (source: AudioBuffer) => {
      expect(source.duration).toBe(12);
      return clean;
    });
    const applyEffectChain = vi.fn(async (source: AudioBuffer, effects: unknown[]) => {
      expect(source.duration).toBe(1);
      expect(effects).toEqual([gain]);
      expect(Math.max(...source.getChannelData(0))).toBeGreaterThan(0.2);
      return { buffer: source };
    });
    const [source] = await render(2, 6, 1, { pitchCorrection: true, audioEffects: [noise, gain] as Clip["audioEffects"] }, {},
      { applyNoiseReductionWithProfileData, applyEffectChain });
    expect(applyNoiseReductionWithProfileData).toHaveBeenCalledOnce();
    expect(applyEffectChain).toHaveBeenCalledOnce();
    expect(source.playbackRate.value).toBe(1);
    expect(source.start).toHaveBeenCalledWith(0, 0, 1);
  });
  it("retries source noise processing after a failed render and caches the successful result", async () => {
    vi.stubGlobal("OfflineAudioContext", FakeContext);
    const audioContext = new FakeContext();
    const clean = audioContext.createBuffer(1, 8000, 8000);
    const applyNoiseReductionWithProfileData = vi.fn().mockRejectedValueOnce(new Error("profile unavailable"))
      .mockResolvedValue(clean);
    const engine = new AudioEngine();
    Object.assign(engine, { initialized: true, audioContext,
      mediaBuffers: new Map([["media:0", audioContext.createBuffer(1, 8000, 8000)]]),
      effectsEngine: { applyNoiseReductionWithProfileData } });
    const clip = { id: "clip", trackId: "track", mediaId: "media", startTime: 0, inPoint: 0, outPoint: 1,
      duration: 1, speed: 1, volume: 1, effects: [], audioEffects: [{ id: "noise", type: "noiseReduction", enabled: true,
        params: { profile: { frequencyBins: [0, 4000], magnitudes: [0.01, 0.01], sampleRate: 8000 } } }] } as unknown as Clip;
    const project = { settings: { sampleRate: 8000, channels: 1 },
      timeline: { tracks: [{ id: "track", type: "audio", clips: [clip], transitions: [] }] },
      mediaLibrary: { items: [{ id: "media", metadata: { duration: 1 } }] } } as unknown as Project;
    await expect(engine.renderAudio(project, 0, 1)).rejects.toThrow("profile unavailable");
    await engine.renderAudio(project, 0, 1);
    await engine.renderAudio(project, 0, 1);
    expect(applyNoiseReductionWithProfileData).toHaveBeenCalledTimes(2);
    expect(FakeContext.renders.at(-1)!.sources[0].buffer).toBe(clean);
  });

  it("reports unsupported varying-curve pitch preservation and freeze sound", async () => {
    await expect(render(2, 5, 1, { pitchCorrection: true, speedKeyframes: [
      { id: "a", time: 0, speed: 1, easing: "linear" }, { id: "b", time: 8, speed: 2, easing: "linear" },
    ] })).rejects.toMatchObject({ code: "AUDIO_PITCH_CORRECTION_UNAVAILABLE" });
    await expect(render(1, 13.5, 1, { duration: 10, freezeFrames: [
      { id: "f", clipId: "clip", sourceTime: 2, startTime: 1, duration: 2 },
    ] })).rejects.toMatchObject({ code: "AUDIO_FREEZE_UNDEFINED" });
  });
  it("does not block silent or hidden audio for unsupported speed options", async () => {
    expect(await render(2, 5, 1, { pitchCorrection: true, volume: 0 })).toHaveLength(0);
    expect(await render(2, 5, 1, { pitchCorrection: true }, { muted: true })).toHaveLength(0);
    expect(await render(2, 5, 1, { pitchCorrection: true }, { hidden: true })).toHaveLength(0);
  });
});
