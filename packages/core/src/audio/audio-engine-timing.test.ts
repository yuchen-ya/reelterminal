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
  createBufferSource() {
    const source = { ...node(), buffer: null as AudioBuffer | null, playbackRate: { value: 1 }, start: vi.fn(), stop: vi.fn() };
    this.sources.push(source);
    return source;
  }
  async startRendering() { return {} as AudioBuffer; }
}

async function render(speed: number, start: number, duration: number, overrides: Partial<Clip> = {},
  trackFlags: { muted?: boolean; hidden?: boolean } = {}) {
  FakeContext.renders = [];
  vi.stubGlobal("OfflineAudioContext", FakeContext);
  const engine = new AudioEngine();
  Object.assign(engine, { initialized: true, audioContext: {},
    mediaBuffers: new Map([["media:0", { duration: 12 } as AudioBuffer]]) });
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
  it("reports unsupported pitch preservation and freeze sound instead of rendering the wrong timing", async () => {
    await expect(render(2, 5, 1, { pitchCorrection: true })).rejects.toMatchObject({ code: "AUDIO_PITCH_CORRECTION_UNAVAILABLE" });
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
