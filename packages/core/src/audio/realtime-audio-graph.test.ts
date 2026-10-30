import { describe, it, expect, vi, afterEach } from "vitest";
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
    createBuffer: (channels: number, length: number, sampleRate: number) => {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return { length, sampleRate, duration: length / sampleRate, numberOfChannels: channels,
        getChannelData: (channel: number) => data[channel] } as AudioBuffer;
    },
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

function makeGraph(fake: ReturnType<typeof makeContext>, time = () => 0) {
  const clock = {
    getAudioContext: () => fake.ctx,
    get currentTime() { return time(); },
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
    pitchCorrection: false,
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

describe("RealtimeAudioGraph speed scheduling", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it.each([0.5, 1, 2])("schedules source seconds and timeline boundaries separately at %sx", (speed) => {
    const fake = makeContext();
    const graph = makeGraph(fake);
    graph.scheduleClip(clipSchedule({ audioBuffer: { duration: 12 } as AudioBuffer,
      startTime: 1, endTime: 1 + 8 / speed, mediaOffset: 3, mediaEnd: 11, speed }));
    expect(fake.sources[0].playbackRate.value).toBe(speed);
    expect(fake.sources[0].start).toHaveBeenCalledWith(1, 3, 8);
    expect(fake.sources[0].stop).toHaveBeenCalledWith(1 + 8 / speed);
  });

  it.each([0.5, 1, 2])("starts mid-clip at the correct source position at %sx", (speed) => {
    const fake = makeContext();
    fake.ctx.currentTime = 10;
    const graph = makeGraph(fake, () => 2);
    graph.scheduleClip(clipSchedule({ audioBuffer: { duration: 12 } as AudioBuffer,
      startTime: 1, endTime: 1 + 8 / speed, mediaOffset: 3, mediaEnd: 11, speed }));
    expect(fake.sources[0].start).toHaveBeenCalledWith(10, 3 + speed, 8 - speed);
    expect(fake.sources[0].stop).toHaveBeenCalledWith(10 + 8 / speed - 1);
  });

  it("bounds a short decoded source and never replays it before the timeline end", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setInterval, clearInterval });
    const fake = makeContext();
    let time = 0;
    const graph = makeGraph(fake, () => time);
    const schedule = clipSchedule({ audioBuffer: { duration: 3 } as AudioBuffer,
      endTime: 2, mediaEnd: 4, speed: 2 });
    graph.startScheduler(() => [schedule]);
    expect(fake.sources[0].start).toHaveBeenCalledWith(0, 0, 3);
    expect(fake.sources[0].stop).toHaveBeenCalledWith(1.5);
    time = 1.5;
    fake.sources[0].onended!();
    vi.advanceTimersByTime(200);
    expect(fake.sources).toHaveLength(1);
    graph.stopScheduler();
  });

  it("deduplicates overlapping requests and permits seek and pause/resume to schedule again", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setInterval, clearInterval });
    const fake = makeContext();
    let time = 0;
    const graph = makeGraph(fake, () => time);
    const schedule = clipSchedule({ mediaOffset: 1, mediaEnd: 9, endTime: 4, speed: 2 });
    graph.startScheduler(() => [schedule]);
    graph.scheduleClip(schedule);
    vi.advanceTimersByTime(100);
    expect(fake.sources).toHaveLength(1);
    const old = fake.sources[0];
    time = 1;
    graph.seekTo(time);
    old.onended!(); // A stopped source's late callback must not complete the new pass.
    vi.advanceTimersByTime(100);
    expect(fake.sources[1].start).toHaveBeenCalledWith(0, 3, 6);
    graph.stopScheduler();
    time = 2;
    graph.startScheduler(() => [schedule]);
    expect(fake.sources[2].start).toHaveBeenCalledWith(0, 5, 4);
    graph.stopScheduler();
  });

  it("does not schedule a clip at or after its end", () => {
    const fake = makeContext();
    const graph = makeGraph(fake, () => 4);
    graph.scheduleClip(clipSchedule({ endTime: 4, speed: 2 }));
    expect(fake.sources).toHaveLength(0);
  });
  it("uses prepared curve PCM for a mid-clip schedule at 1x, without retiming twice", async () => {
    const fake = makeContext();
    const source = fake.ctx.createBuffer(1, 48000, 8000);
    const graph = makeGraph(fake, () => 1);
    const duration = 4 * Math.log(2);
    const schedule = clipSchedule({ audioBuffer: source, endTime: duration, mediaOffset: 1, mediaEnd: 5,
      speed: 17, speedKeyframes: [
        { id: "a", time: 0, speed: 1, easing: "linear" },
        { id: "b", time: 4, speed: 2, easing: "linear" },
      ] });
    expect(() => graph.scheduleClip(schedule)).toThrow(/not finished preparing/);
    await graph.prepareClip(schedule);
    graph.scheduleClip(schedule);
    expect(fake.sources[0].playbackRate.value).toBe(1);
    expect(fake.sources[0].buffer!.length).toBe(Math.ceil(duration * 8000));
    expect(fake.sources[0].start.mock.calls[0][1]).toBe(1);
    expect(fake.sources[0].start.mock.calls[0][2]).toBeCloseTo(duration - 1, 8);
  });

  it("reports runtime preparation failures once and stops the scheduling timer", () => {
    vi.useFakeTimers(); vi.stubGlobal("window", { setInterval, clearInterval });
    let time = 0;
    const graph = makeGraph(makeContext(), () => time);
    const failure = vi.fn();
    graph.startScheduler((queryTime) => queryTime === 0 ? [] : [clipSchedule({ startTime: 1, speed: 2, pitchCorrection: true })], failure);
    time = 1;
    vi.advanceTimersByTime(300);
    expect(failure).toHaveBeenCalledOnce();
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ code: "AUDIO_SPEED_NOT_PREPARED" }));
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not reject unsupported options on a muted track", () => {
    const fake = makeContext(); const graph = makeGraph(fake);
    graph.createTrack({ trackId: "track-1", volume: 1, pan: 0, muted: true, solo: false, effects: [] });
    expect(() => graph.scheduleClip(clipSchedule({ speed: 2, pitchCorrection: true }))).not.toThrow();
    expect(fake.sources).toHaveLength(0);
  });
  it("removes stale solo tracks before scheduling a different project", () => {
    const fake = makeContext(); const graph = makeGraph(fake);
    graph.createTrack({ trackId: "previous-project", volume: 1, pan: 0, muted: false, solo: true, effects: [] });
    graph.createTrack({ trackId: "track-1", volume: 1, pan: 0, muted: false, solo: false, effects: [] });
    graph.retainTracks(new Set(["track-1"]));
    graph.scheduleClip(clipSchedule({ speed: 2 }));
    expect(fake.sources).toHaveLength(1);
  });
});
