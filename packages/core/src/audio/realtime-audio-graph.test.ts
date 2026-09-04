import { describe, it, expect, vi } from "vitest";
import { RealtimeAudioGraph } from "./realtime-audio-graph";
import type { MasterTimelineClock } from "../playback/master-timeline-clock";
import type { AudioClipSchedule } from "./realtime-audio-graph";

// Minimal Web Audio stubs: enough surface for the graph to build its node
// chain, while recording connections so tests can assert the signal path
// actually reaches audioContext.destination (i.e. the speakers).
interface FakeParam {
  value: number;
  setValueAtTime: ReturnType<typeof vi.fn>;
  cancelScheduledValues: ReturnType<typeof vi.fn>;
  linearRampToValueAtTime: ReturnType<typeof vi.fn>;
}

function makeParam(value = 1): FakeParam {
  return {
    value,
    setValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
  };
}

interface FakeNode {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

function makeNode(): FakeNode {
  return { connect: vi.fn(), disconnect: vi.fn() };
}

function makeGain(): FakeNode & { gain: FakeParam } {
  return { ...makeNode(), gain: makeParam(1) };
}

function makeContext() {
  const destination = makeNode();
  const gains: ReturnType<typeof makeGain>[] = [];
  const sources: Array<
    FakeNode & {
      buffer: AudioBuffer | null;
      playbackRate: { value: number };
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      onended: (() => void) | null;
    }
  > = [];
  const panners: Array<FakeNode & { pan: FakeParam }> = [];
  const ctx = {
    currentTime: 0,
    sampleRate: 48000,
    state: "running" as AudioContextState,
    destination,
    createGain: vi.fn(() => {
      const g = makeGain();
      gains.push(g);
      return g;
    }),
    createStereoPanner: vi.fn(() => {
      const p = { ...makeNode(), pan: makeParam(0) };
      panners.push(p);
      return p;
    }),
    createBufferSource: vi.fn(() => {
      const s = {
        ...makeNode(),
        buffer: null as AudioBuffer | null,
        playbackRate: { value: 1 },
        start: vi.fn(),
        stop: vi.fn(),
        onended: null as (() => void) | null,
      };
      sources.push(s);
      return s;
    }),
    resume: vi.fn().mockResolvedValue(undefined),
    suspend: vi.fn().mockResolvedValue(undefined),
  };
  return { ctx, destination, gains, sources, panners };
}

function makeGraph(fake: ReturnType<typeof makeContext>) {
  const clock = {
    getAudioContext: () => fake.ctx,
    currentTime: 0,
  } as unknown as MasterTimelineClock;
  return new RealtimeAudioGraph(clock);
}

function clipSchedule(overrides: Partial<AudioClipSchedule> = {}): AudioClipSchedule {
  return {
    clipId: "clip-1",
    trackId: "track-1",
    audioBuffer: { duration: 10 } as AudioBuffer,
    startTime: 0,
    endTime: 10,
    mediaOffset: 0,
    volume: 1,
    volumeAutomation: [],
    pan: 0,
    effects: [],
    speed: 1,
    ...overrides,
  };
}

describe("RealtimeAudioGraph output wiring", () => {
  it("connects the master gain to the audio context destination on construction", () => {
    const fake = makeContext();
    makeGraph(fake);
    const masterGain = fake.gains[0];
    expect(masterGain.connect).toHaveBeenCalledWith(fake.destination);
  });

  it("drives the master gain with preview mute and master volume", () => {
    const fake = makeContext();
    const graph = makeGraph(fake);
    const masterParam = fake.gains[0].gain;

    graph.setPreviewMuted(true);
    expect(masterParam.setValueAtTime).toHaveBeenLastCalledWith(0, 0);

    graph.setPreviewMuted(false);
    expect(masterParam.setValueAtTime).toHaveBeenLastCalledWith(1, 0);

    graph.setMasterVolume(2);
    expect(masterParam.setValueAtTime).toHaveBeenLastCalledWith(2, 0);

    // mute must override the mixer volume without losing it
    graph.setPreviewMuted(true);
    expect(masterParam.setValueAtTime).toHaveBeenLastCalledWith(0, 0);
    graph.setPreviewMuted(false);
    expect(masterParam.setValueAtTime).toHaveBeenLastCalledWith(2, 0);
  });

  it("routes a scheduled clip source through the track chain into the master gain", () => {
    const fake = makeContext();
    const graph = makeGraph(fake);
    const masterGain = fake.gains[0];

    graph.scheduleClip(clipSchedule());

    // track chain: inputGain → passthrough → pan → outputGain → masterGain
    const outputGain = fake.gains.find((g) =>
      g.connect.mock.calls.some(([target]) => target === masterGain),
    );
    expect(outputGain, "track output gain must feed the master gain").toBeDefined();
    expect(outputGain!.gain.setValueAtTime).toHaveBeenCalledWith(1, 0);

    // source started and connected into the clip gain chain
    expect(fake.sources).toHaveLength(1);
    const source = fake.sources[0];
    expect(source.start).toHaveBeenCalledOnce();
    const clipGain = fake.gains.find((g) =>
      source.connect.mock.calls.some(([target]) => target === g),
    );
    expect(clipGain, "source must connect into a clip gain").toBeDefined();
  });

  it("silences a muted track at its output gain and restores it on unmute", () => {
    const fake = makeContext();
    const graph = makeGraph(fake);
    const masterGain = fake.gains[0];

    graph.createTrack({
      trackId: "track-1",
      volume: 0.8,
      pan: 0,
      muted: false,
      solo: false,
      effects: [],
    });
    const outputGain = fake.gains.find((g) =>
      g.connect.mock.calls.some(([target]) => target === masterGain),
    )!;
    expect(outputGain.gain.setValueAtTime).toHaveBeenLastCalledWith(0.8, 0);

    graph.setTrackMuted("track-1", true);
    expect(outputGain.gain.setValueAtTime).toHaveBeenLastCalledWith(0, 0);

    graph.setTrackMuted("track-1", false);
    expect(outputGain.gain.setValueAtTime).toHaveBeenLastCalledWith(0.8, 0);
  });

  it("applies mixer volume overrides at the track output gain", () => {
    const fake = makeContext();
    const graph = makeGraph(fake);
    const masterGain = fake.gains[0];

    graph.createTrack({
      trackId: "track-1",
      volume: 1,
      pan: 0,
      muted: false,
      solo: false,
      effects: [],
    });
    const outputGain = fake.gains.find((g) =>
      g.connect.mock.calls.some(([target]) => target === masterGain),
    )!;

    graph.updateTrackVolume("track-1", 0.25);
    expect(outputGain.gain.setValueAtTime).toHaveBeenLastCalledWith(0.25, 0);
  });

  it("disconnects the master gain from the destination on dispose", () => {
    const fake = makeContext();
    const graph = makeGraph(fake);
    const masterGain = fake.gains[0];
    graph.dispose();
    expect(masterGain.disconnect).toHaveBeenCalled();
  });
});
