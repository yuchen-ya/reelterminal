import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hasInitialAutoFitRun,
  resetInitialAutoFitForTests,
  sliderPercentToZoom,
  TIMELINE_TRACK_HEADER_WIDTH_PX,
  TIMELINE_WORKSPACE_STORAGE_KEY,
  useTimelineStore,
  zoomToSliderPercent,
  ZOOM_PRESETS,
} from "./timeline-store";

describe("TimelineStore playback locking", () => {
  beforeEach(() => {
    localStorage.removeItem(TIMELINE_WORKSPACE_STORAGE_KEY);
    useTimelineStore.setState({
      playheadPosition: 0,
      playbackState: "stopped",
      playbackLockedReason: null,
      playbackRate: 1,
      pixelsPerSecond: ZOOM_PRESETS.DEFAULT,
      scrollX: 0,
      scrollY: 0,
      viewportWidth: 800,
      viewportHeight: 400,
      trackHeight: 80,
      trackHeights: {},
      loopEnabled: false,
      loopStart: 0,
      loopEnd: 0,
      isScrubbing: false,
      scrubPosition: null,
      expandedTracks: new Set<string>(),
      expandedClipKeyframes: new Set<string>(),
      keyframeEditMode: false,
    });
  });

  it("persists global and per-track density without serializing transient timeline state", () => {
    const store = useTimelineStore.getState();
    store.setTrackHeight(64);
    store.setTrackHeightById("dialogue", 112);

    const persisted = JSON.parse(
      localStorage.getItem(TIMELINE_WORKSPACE_STORAGE_KEY) ?? "{}",
    ) as { state?: Record<string, unknown> };
    expect(persisted.state).toEqual({
      trackHeight: 64,
      trackHeights: { dialogue: 112 },
    });
    expect(persisted.state).not.toHaveProperty("playheadPosition");
    expect(persisted.state).not.toHaveProperty("selectedClipIds");
  });

  it("blocks play and toggle while locked", () => {
    const store = useTimelineStore.getState();

    store.lockPlayback("Applying auto color");
    store.play();
    store.togglePlayback();

    const state = useTimelineStore.getState();
    expect(state.playbackState).toBe("stopped");
    expect(state.playbackLockedReason).toBe("Applying auto color");
  });

  it("allows playback again after unlocking", () => {
    const store = useTimelineStore.getState();

    store.lockPlayback("Applying auto color");
    store.unlockPlayback();
    store.togglePlayback();

    const state = useTimelineStore.getState();
    expect(state.playbackLockedReason).toBeNull();
    expect(state.playbackState).toBe("playing");
  });
});

describe("TimelineStore fit-to-view and zoom range", () => {
  beforeEach(() => {
    resetInitialAutoFitForTests();
    useTimelineStore.setState({
      pixelsPerSecond: ZOOM_PRESETS.DEFAULT,
      scrollX: 0,
      viewportWidth: 800,
    });
  });

  afterEach(() => {
    resetInitialAutoFitForTests();
  });

  it("fits an hour-long project without clamping to the old 10px/s floor", () => {
    const store = useTimelineStore.getState();
    // 1 hour in an 800px viewport, excluding the 170px track-header column
    // and the 100px right margin: (800-170-100)/3600 ≈ 0.147 px/s, far below 10.
    store.zoomToFit(3600);
    expect(useTimelineStore.getState().pixelsPerSecond).toBeCloseTo(
      530 / 3600,
      6,
    );
    expect(useTimelineStore.getState().pixelsPerSecond).toBeLessThan(10);
    expect(useTimelineStore.getState().scrollX).toBe(0);
  });

  it("fits within the visible time area, excluding the track header column", () => {
    const store = useTimelineStore.getState();
    const viewportWidth = 1600;
    useTimelineStore.setState({ viewportWidth });

    // Fallback path (no measurement passed): content must not exceed
    // viewport minus the track-header column.
    store.zoomToFit(3600);
    const fallbackPps = useTimelineStore.getState().pixelsPerSecond;
    expect(fallbackPps * 3600).toBeLessThanOrEqual(
      viewportWidth - TIMELINE_TRACK_HEADER_WIDTH_PX,
    );

    // Measured path: content must not exceed the passed visible width.
    const visibleTimeWidth = 1000;
    store.zoomToFit(3600, visibleTimeWidth);
    const measuredPps = useTimelineStore.getState().pixelsPerSecond;
    expect(measuredPps * 3600).toBeLessThanOrEqual(visibleTimeWidth);
    // And the fit actually uses (almost) the whole measured area.
    expect(measuredPps * 3600).toBeGreaterThan(visibleTimeWidth - 101);
  });

  it("never fits below the absolute safety floor", () => {
    const store = useTimelineStore.getState();
    store.zoomToFit(10_000_000);
    expect(useTimelineStore.getState().pixelsPerSecond).toBe(
      ZOOM_PRESETS.ABSOLUTE_MIN,
    );
  });

  it("clamps manual zoom to the shared effective range", () => {
    const store = useTimelineStore.getState();
    store.setZoom(0);
    expect(useTimelineStore.getState().pixelsPerSecond).toBe(
      ZOOM_PRESETS.ABSOLUTE_MIN,
    );
    store.setZoom(1);
    // 1 px/s is a legitimate fitted value now, not clamped up to 10.
    expect(useTimelineStore.getState().pixelsPerSecond).toBe(1);
    store.setZoom(9999);
    expect(useTimelineStore.getState().pixelsPerSecond).toBe(ZOOM_PRESETS.MAX);
  });

  it("auto-fits exactly once per session, then keeps the user's view", () => {
    const store = useTimelineStore.getState();
    expect(hasInitialAutoFitRun()).toBe(false);

    store.autoFitOnFirstLoad(3600);
    const fittedZoom = useTimelineStore.getState().pixelsPerSecond;
    expect(fittedZoom).toBeCloseTo(530 / 3600, 6);
    expect(hasInitialAutoFitRun()).toBe(true);

    // Later edits / loads must not change the view again.
    store.autoFitOnFirstLoad(30);
    expect(useTimelineStore.getState().pixelsPerSecond).toBe(fittedZoom);

    // Ignored while the project has no content yet.
    useTimelineStore.setState({ pixelsPerSecond: ZOOM_PRESETS.DEFAULT });
    store.autoFitOnFirstLoad(0);
    expect(useTimelineStore.getState().pixelsPerSecond).toBe(
      ZOOM_PRESETS.DEFAULT,
    );
  });

  it("maps the slider logarithmically over the same effective range", () => {
    expect(zoomToSliderPercent(ZOOM_PRESETS.ABSOLUTE_MIN)).toBe(0);
    expect(zoomToSliderPercent(ZOOM_PRESETS.MAX)).toBe(100);
    // Default zoom sits at ~79% (log range), not pressed against an edge.
    expect(zoomToSliderPercent(ZOOM_PRESETS.DEFAULT)).toBeGreaterThan(70);
    expect(zoomToSliderPercent(ZOOM_PRESETS.DEFAULT)).toBeLessThan(85);

    // Round trip preserves the zoom across the whole range.
    for (const pps of [0.01, 0.194, 2.9, 50, 500]) {
      expect(sliderPercentToZoom(zoomToSliderPercent(pps))).toBeCloseTo(pps, 6);
    }
  });
});
