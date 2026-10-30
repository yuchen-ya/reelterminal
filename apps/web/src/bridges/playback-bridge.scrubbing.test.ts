import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlaybackBridge } from "./playback-bridge";
import { useTimelineStore } from "../stores/timeline-store";
import { useProjectStore } from "../stores/project-store";

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

/**
 * Observe requestSeek's store commit. The store's endScrubbing() already
 * writes the release position synchronously, so the playhead value alone is
 * a vacuous check; seekTo is the only writer that finalizes a user seek.
 */
function observeSeekTo(): { calls: number[]; restore: () => void } {
  const realSeekTo = useTimelineStore.getState().seekTo;
  const calls: number[] = [];
  useTimelineStore.setState({
    seekTo: (position: number) => {
      calls.push(position);
      realSeekTo(position);
    },
  });
  return {
    calls,
    restore: () => useTimelineStore.setState({ seekTo: realSeekTo }),
  };
}

describe("PlaybackBridge scrubbing", () => {
  beforeEach(() => {
    useTimelineStore.setState({
      playheadPosition: 1,
      isScrubbing: false,
      scrubPosition: null,
      playbackState: "paused",
    });
  });

  it("starts the visible preview at the selected position without a second core audio owner", async () => {
    const controller = makeController();
    const bridge = new PlaybackBridge();
    Object.assign(bridge, { playbackController: controller });
    useTimelineStore.setState({ playheadPosition: 1.25 });
    await bridge.play();
    expect(useTimelineStore.getState().playbackState).toBe("playing");
    expect(useTimelineStore.getState().playheadPosition).toBe(1.25);
    expect(controller.play).not.toHaveBeenCalled();
    bridge.pause();
    expect(useTimelineStore.getState().playbackState).toBe("paused");
  });

  it.each([24, 30, 60])( "steps on the %i fps project grid and clamps at timeline boundaries", async frameRate => {
    const state = useProjectStore.getState();
    useProjectStore.setState({ project: {
      ...state.project,
      settings: { ...state.project.settings, frameRate },
      timeline: { ...state.project.timeline, duration: 10 },
    } });
    const bridge = new PlaybackBridge();
    const controller = makeController();
    Object.assign(bridge, { playbackController: controller });
    await bridge.stepFrame(1);
    expect(useTimelineStore.getState().playheadPosition).toBe((frameRate + 1) / frameRate);
    await bridge.stepFrame(-1);
    expect(useTimelineStore.getState().playheadPosition).toBe(1);
    useTimelineStore.setState({ playheadPosition: 0 });
    await bridge.stepFrame(-1);
    expect(useTimelineStore.getState().playheadPosition).toBe(0);
    useTimelineStore.setState({ playheadPosition: 10 });
    await bridge.stepFrame(1);
    expect(useTimelineStore.getState().playheadPosition).toBe(10);
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

    const seek = observeSeekTo();
    bridge.endScrubbing();

    // Drag state is released synchronously…
    expect(controller.endScrubbing).toHaveBeenCalledTimes(1);
    expect(useTimelineStore.getState().isScrubbing).toBe(false);

    // …the exact release position reaches the master clock and audio…
    await vi.waitFor(() =>
      expect(controller.syncClockTo).toHaveBeenCalledTimes(1),
    );
    expect(controller.syncClockTo).toHaveBeenCalledWith(4.25);

    // …and requestSeek's store commit ran (seekTo is the only writer that
    // finalizes a user seek; the playhead value alone would pass either way).
    await vi.waitFor(() => expect(seek.calls).toContain(4.25));
    expect(useTimelineStore.getState().playheadPosition).toBe(4.25);
    seek.restore();
  });

  it("cleans up drag state and still lands the final position when the clock sync fails", async () => {
    const controller = makeController();
    controller.syncClockTo.mockRejectedValue(
      new Error("audio graph disposed"),
    );
    const bridge = new PlaybackBridge();
    Object.assign(bridge, { playbackController: controller });

    const seek = observeSeekTo();
    bridge.startScrubbing();
    bridge.scrubTo(2.5);
    bridge.endScrubbing();

    expect(useTimelineStore.getState().isScrubbing).toBe(false);
    expect(controller.endScrubbing).toHaveBeenCalledTimes(1);
    // The requestSeek store commit still runs even though the clock sync
    // failed (the playhead value alone would pass either way).
    await vi.waitFor(() => expect(seek.calls).toContain(2.5));
    expect(useTimelineStore.getState().playheadPosition).toBe(2.5);
    seek.restore();
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

  it("commits only the newest of two overlapping seeks", async () => {
    const controller = makeController();
    let releaseSlowSync!: () => void;
    const slowSync = new Promise<void>((resolve) => {
      releaseSlowSync = resolve;
    });
    controller.syncClockTo.mockImplementation(async (time: number) => {
      if (time === 5) await slowSync;
      return time;
    });
    const bridge = new PlaybackBridge();
    Object.assign(bridge, { playbackController: controller });

    const revisionBefore =
      useTimelineStore.getState().playheadInteractionRevision;
    const staleSeek = bridge.requestSeek(5);
    const latestSeek = bridge.requestSeek(8);
    await latestSeek;

    // The fast seek committed while the slow one was still clock-syncing.
    expect(useTimelineStore.getState().playheadPosition).toBe(8);
    expect(useTimelineStore.getState().playheadInteractionRevision).toBe(
      revisionBefore + 1,
    );

    releaseSlowSync();
    await staleSeek;

    // The stale seek's late commit must not pull the playhead back to 5.
    expect(useTimelineStore.getState().playheadPosition).toBe(8);
    expect(useTimelineStore.getState().playheadInteractionRevision).toBe(
      revisionBefore + 1,
    );
  });
});
