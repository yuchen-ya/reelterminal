import { afterEach, describe, expect, it, vi } from "vitest";
import { PlaybackController } from "./playback-controller";
import { disposeMasterClock } from "./master-timeline-clock";
import { disposeRealtimeAudioGraph } from "../audio/realtime-audio-graph";
import type { Project } from "../types/project";

function makeController(preparation: Promise<void>) {
  vi.stubGlobal("AudioContext", class {
    currentTime = 0; state = "running"; destination = {};
    createGain() { return { gain: { value: 1, setValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() }; }
  });
  const controller = new PlaybackController();
  const project = { timeline: { duration: 10, tracks: [] }, mediaLibrary: { items: [] } } as unknown as Project;
  const graph = { prepareClip: vi.fn(() => preparation), stopScheduler: vi.fn() };
  Object.assign(controller, { project, videoEngine: {}, audioEngine: {},
    preloadAudioBuffers: vi.fn().mockResolvedValue(undefined), getAudioClipsAtTime: () => [{}],
    realtimeAudioGraph: graph, startAudioPlayback: vi.fn().mockResolvedValue(undefined) });
  const clockPlay = vi.spyOn(controller.getMasterClock(), "play").mockResolvedValue(undefined);
  return { controller, project, graph, clockPlay };
}

describe("audio preparation playback lifecycle", () => {
  afterEach(() => { disposeRealtimeAudioGraph(); disposeMasterClock(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it.each(["pause", "stop", "project switch"])("does not restart the clock after %s during preparation", async (action) => {
    let ready!: () => void;
    const { controller, project, graph, clockPlay } = makeController(new Promise<void>((resolve) => { ready = resolve; }));
    const playing = controller.play();
    await Promise.resolve();
    expect(graph.prepareClip).toHaveBeenCalledOnce();
    if (action === "pause") controller.pause();
    else if (action === "stop") controller.stop();
    else controller.setProject(project);
    ready();
    await playing;
    expect(clockPlay).not.toHaveBeenCalled();
    expect(controller.getState()).toBe(action === "pause" ? "paused" : "stopped");
  });

  it("rejects an unsupported capability before starting the clock and emits an error", async () => {
    const failure = new Error("pitch correction unavailable");
    const { controller, clockPlay } = makeController(Promise.reject(failure));
    const listener = vi.fn();
    controller.addEventListener("error", listener);
    await expect(controller.play()).rejects.toBe(failure);
    expect(clockPlay).not.toHaveBeenCalled();
    expect(controller.getState()).toBe("paused");
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ error: failure, state: "paused" }));
  });
  it("honors pause while the audio context is still resuming", async () => {
    const { controller, clockPlay } = makeController(Promise.resolve());
    let resumed!: () => void;
    clockPlay.mockImplementation(() => new Promise<void>((resolve) => { resumed = resolve; }));
    const clockPause = vi.spyOn(controller.getMasterClock(), "pause");
    const playEvent = vi.fn(); controller.addEventListener("play", playEvent);
    const playing = controller.play();
    await vi.waitFor(() => expect(clockPlay).toHaveBeenCalledOnce());
    controller.pause(); resumed(); await playing;
    expect(controller.getState()).toBe("paused");
    expect(clockPause).toHaveBeenCalledTimes(2);
    expect(playEvent).not.toHaveBeenCalled();
  });
});
