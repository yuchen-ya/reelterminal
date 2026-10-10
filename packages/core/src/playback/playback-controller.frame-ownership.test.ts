import { afterEach, describe, expect, it, vi } from "vitest";
import type { RenderedFrame } from "../video/types";
import { disposeRealtimeAudioGraph } from "../audio/realtime-audio-graph";
import { disposeMasterClock } from "./master-timeline-clock";
import { PlaybackController } from "./playback-controller";

describe("PlaybackController frame ownership", () => {
  afterEach(() => {
    disposeRealtimeAudioGraph();
    disposeMasterClock();
    vi.unstubAllGlobals();
  });

  it("closes its current frame exactly once on dispose", () => {
    const createGain = () => ({
      gain: { value: 1, setValueAtTime: vi.fn() },
      connect: vi.fn(),
      disconnect: vi.fn(),
    });
    vi.stubGlobal(
      "AudioContext",
      class {
        currentTime = 0;
        state = "running";
        destination = {};
        createGain = createGain;
      },
    );

    const controller = new PlaybackController();
    const close = vi.fn();
    const frame = {
      image: { close },
      timestamp: 0,
      width: 1,
      height: 1,
    } as unknown as RenderedFrame;
    Object.assign(controller, { currentFrame: frame });

    controller.dispose();

    expect(close).toHaveBeenCalledOnce();
  });
});
