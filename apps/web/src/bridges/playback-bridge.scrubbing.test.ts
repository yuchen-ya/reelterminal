import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlaybackBridge } from "./playback-bridge";
import { useTimelineStore } from "../stores/timeline-store";

const makeController = () => ({
  startScrubbing: vi.fn(),
  scrubTo: vi.fn(async () => ({
    frame: null,
    renderTime: 0,
    fromCache: false,
    timedOut: false,
  })),
  syncClockTo: vi.fn(async (time: number) => time),
  endScrubbing: vi.fn(),
  seek: vi.fn(),
  pause: vi.fn(),
  play: vi.fn(async () => {}),
});

describe("PlaybackBridge scrubbing", () => {
  beforeEach(() => {
    useTimelineStore.setState({
      playheadPosition: 1,
      isScrubbing: false,
      scrubPosition: null,
      playbackState: "paused",
    });
  });

  it("moves the UI immediately and commits the final position once on release", async () => {
    const controller = makeController();
    const bridge = new PlaybackBridge();
    Object.assign(bridge, { playbackController: controller });

    bridge.startScrubbing();
    bridge.scrubTo(4.25);

    expect(useTimelineStore.getState().playheadPosition).toBe(4.25);
    // Pointer movement must not touch the core: no clock moves, no renders.
    expect(controller.syncClockTo).not.toHaveBeenCalled();
    expect(controller.scrubTo).not.toHaveBeenCalled();
    expect(controller.seek).not.toHaveBeenCalled();

    bridge.endScrubbing();

    // Drag state is released synchronously…
    expect(controller.endScrubbing).toHaveBeenCalledTimes(1);
    expect(useTimelineStore.getState().isScrubbing).toBe(false);

    // …and the exact release position reaches the master clock and audio.
    await vi.waitFor(() =>
      expect(controller.syncClockTo).toHaveBeenCalledTimes(1),
    );
    expect(controller.syncClockTo).toHaveBeenCalledWith(4.25);
    await vi.waitFor(() =>
      expect(useTimelineStore.getState().playheadPosition).toBe(4.25),
    );
  });

  it("cleans up drag state and still lands the final position when the clock sync fails", async () => {
    const controller = makeController();
    controller.syncClockTo.mockRejectedValue(
      new Error("audio graph disposed"),
    );
    const bridge = new PlaybackBridge();
    Object.assign(bridge, { playbackController: controller });

    bridge.startScrubbing();
    bridge.scrubTo(2.5);
    bridge.endScrubbing();

    expect(useTimelineStore.getState().isScrubbing).toBe(false);
    expect(controller.endScrubbing).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(useTimelineStore.getState().playheadPosition).toBe(2.5),
    );
  });

  it("pauses playback when a drag starts mid-play and keeps it paused after release", async () => {
    const controller = makeController();
    const bridge = new PlaybackBridge();
    Object.assign(bridge, { playbackController: controller });
    useTimelineStore.setState({ playbackState: "playing" });

    bridge.startScrubbing();
    expect(useTimelineStore.getState().playbackState).toBe("paused");

    bridge.scrubTo(3);
    bridge.endScrubbing();
    await vi.waitFor(() =>
      expect(controller.syncClockTo).toHaveBeenCalled(),
    );
    expect(useTimelineStore.getState().playbackState).toBe("paused");
  });

  it("routes one-shot seeks through the same clock commit as scrub release", async () => {
    const controller = makeController();
    const bridge = new PlaybackBridge();
    Object.assign(bridge, { playbackController: controller });

    await bridge.requestSeek(7.5);

    expect(controller.syncClockTo).toHaveBeenCalledWith(7.5);
    expect(useTimelineStore.getState().playheadPosition).toBe(7.5);
    // A user seek never triggers the controller's own frame render.
    expect(controller.scrubTo).not.toHaveBeenCalled();
    expect(controller.seek).not.toHaveBeenCalled();
  });
});
