import { create } from "zustand";
import { persist, subscribeWithSelector } from "zustand/middleware";

export const TIMELINE_WORKSPACE_STORAGE_KEY = "openreel-timeline-workspace";

/**
 * Single source of the effective timeline zoom range (px per second).
 * Every zoom entry point (slider, ctrl+wheel, zoomIn/Out, setZoom,
 * zoomToFit) shares this exact range.
 *
 * ABSOLUTE_MIN is a safety floor only (prevents 0/negative/sub-pixel zoom):
 * fit-to-view must be able to land far below the old 10px/s floor so 8-minute
 * and hour-long projects fit in one viewport.
 */
export const ZOOM_PRESETS = {
  ABSOLUTE_MIN: 0.01,
  DEFAULT: 50,
  MAX: 500,
} as const;

/**
 * Width of the fixed track-header column left of the ruler/track area.
 * Mirrors the `w-[170px]` ruler-spacer and track-header-column classes in
 * Timeline.tsx (which stay literal for Tailwind's static extraction) —
 * defined here so zoom fitting and the UI layout share one number.
 * Runtime measurement of the real column is preferred when available.
 */
export const TIMELINE_TRACK_HEADER_WIDTH_PX = 170;

const ZOOM_SLIDER_PERCENT_MAX = 100;

/**
 * The effective range spans ~4.7 decades, so the zoom slider is mapped
 * logarithmically: uniform perceived speed across the range instead of the
 * default zoom hugging the far left edge of a linear slider.
 */
export function zoomToSliderPercent(pixelsPerSecond: number): number {
  const { ABSOLUTE_MIN, MAX } = ZOOM_PRESETS;
  const clamped = Math.max(ABSOLUTE_MIN, Math.min(MAX, pixelsPerSecond));
  const ratio = Math.log(clamped / ABSOLUTE_MIN) / Math.log(MAX / ABSOLUTE_MIN);
  return ratio * ZOOM_SLIDER_PERCENT_MAX;
}

export function sliderPercentToZoom(percent: number): number {
  const { ABSOLUTE_MIN, MAX } = ZOOM_PRESETS;
  const ratio =
    Math.max(0, Math.min(ZOOM_SLIDER_PERCENT_MAX, percent)) /
    ZOOM_SLIDER_PERCENT_MAX;
  return ABSOLUTE_MIN * Math.pow(MAX / ABSOLUTE_MIN, ratio);
}

/**
 * View policy: zoom/scroll are NOT persisted across sessions. The very
 * first time a session sees non-empty timeline content, the view auto-fits
 * once; afterwards the user keeps their view and only an explicit
 * "Fit all" button press or Ctrl/Cmd+0 changes it. The flag is module-scoped
 * so it survives editor component remounts within the same session.
 */
let hasAutoFittedThisSession = false;

export const hasInitialAutoFitRun = (): boolean => hasAutoFittedThisSession;

/** Test seam: resets the session auto-fit guard between test cases. */
export const resetInitialAutoFitForTests = (): void => {
  hasAutoFittedThisSession = false;
};

export type PlaybackState = "stopped" | "playing" | "paused";

export interface TimelineState {
  playheadPosition: number;
  /** Explicit seek/scrub intent, excluding ordinary playback clock ticks. */
  playheadInteractionRevision: number;
  playbackState: PlaybackState;
  playbackLockedReason: string | null;
  playbackRate: number;
  pixelsPerSecond: number;
  scrollX: number;
  scrollY: number;
  viewportWidth: number;
  viewportHeight: number;
  trackHeight: number;
  trackHeights: Record<string, number>;
  loopEnabled: boolean;
  loopStart: number;
  loopEnd: number;
  isScrubbing: boolean;
  scrubPosition: number | null;
  expandedTracks: Set<string>;
  expandedClipKeyframes: Set<string>;
  keyframeEditMode: boolean;
  play: () => void;
  pause: () => void;
  stop: () => void;
  togglePlayback: () => void;
  lockPlayback: (reason?: string) => void;
  unlockPlayback: () => void;
  setPlaybackRate: (rate: number) => void;
  setPlayheadPosition: (position: number) => void;
  seekTo: (position: number) => void;
  seekRelative: (delta: number) => void;
  seekToStart: () => void;
  seekToEnd: (duration: number) => void;
  startScrubbing: (position: number) => void;
  updateScrubPosition: (position: number) => void;
  endScrubbing: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  setZoom: (pixelsPerSecond: number) => void;
  zoomToFit: (duration: number, visibleTimeWidth?: number) => void;
  /**
   * Fits the view exactly once per session, the first time content exists.
   * `visibleTimeWidth` is the measured viewport width excluding the track
   * header column, when the caller has it.
   */
  autoFitOnFirstLoad: (duration: number, visibleTimeWidth?: number) => void;
  resetZoom: () => void;
  setScrollX: (scrollX: number) => void;
  setScrollY: (scrollY: number) => void;
  scrollToPlayhead: () => void;
  setViewportDimensions: (width: number, height: number) => void;
  setTrackHeight: (height: number) => void;
  setTrackHeightById: (trackId: string, height: number) => void;
  getTrackHeight: (trackId: string, trackType?: string) => number;
  setLoopEnabled: (enabled: boolean) => void;
  setLoopRange: (start: number, end: number) => void;
  timeToPixels: (time: number) => number;
  pixelsToTime: (pixels: number) => number;
  getVisibleTimeRange: () => { start: number; end: number };
  isTimeVisible: (time: number) => boolean;
  toggleTrackExpanded: (trackId: string) => void;
  setTrackExpanded: (trackId: string, expanded: boolean) => void;
  isTrackExpanded: (trackId: string) => boolean;
  toggleClipKeyframesExpanded: (clipId: string) => void;
  setClipKeyframesExpanded: (clipId: string, expanded: boolean) => void;
  isClipKeyframesExpanded: (clipId: string) => boolean;
  setKeyframeEditMode: (enabled: boolean) => void;
}

export const useTimelineStore = create<TimelineState>()(
  subscribeWithSelector(
    persist(
      (set, get) => ({
    playheadPosition: 0,
    playheadInteractionRevision: 0,
    playbackState: "stopped",
    playbackLockedReason: null,
    playbackRate: 1.0,

    pixelsPerSecond: ZOOM_PRESETS.DEFAULT,
    scrollX: 0,
    scrollY: 0,

    viewportWidth: 800,
    viewportHeight: 400,
    trackHeight: 62,
    trackHeights: {},

    loopEnabled: false,
    loopStart: 0,
    loopEnd: 0,

    isScrubbing: false,
    scrubPosition: null,

    expandedTracks: new Set<string>(),
    expandedClipKeyframes: new Set<string>(),
    keyframeEditMode: false,

    play: () => {
      if (get().playbackLockedReason) {
        return;
      }
      set({ playbackState: "playing" });
    },

    pause: () => {
      set({ playbackState: "paused" });
    },

    stop: () => {
      set({ playbackState: "stopped" });
    },

    togglePlayback: () => {
      const { playbackLockedReason, playbackState } = get();
      if (playbackLockedReason) {
        return;
      }
      if (playbackState === "playing") {
        set({ playbackState: "paused" });
      } else {
        set({ playbackState: "playing" });
      }
    },

    lockPlayback: (reason?: string) => {
      set({ playbackLockedReason: reason ?? "Applying effect" });
    },

    unlockPlayback: () => {
      set({ playbackLockedReason: null });
    },

    setPlaybackRate: (rate: number) => {
      set({ playbackRate: Math.max(0.1, Math.min(4.0, rate)) });
    },

    setPlayheadPosition: (position: number) => {
      const clampedPosition = Math.max(0, position);
      if (clampedPosition === get().playheadPosition) return;
      // PlaybackBridge and the preview clock use this method for ordinary
      // frame ticks; those must not invalidate editor-context CAS guards.
      set({ playheadPosition: clampedPosition });
    },

    seekTo: (position: number) => {
      const clampedPosition = Math.max(0, position);
      if (clampedPosition === get().playheadPosition) return;
      set((state) => ({
        playheadPosition: clampedPosition,
        playheadInteractionRevision: state.playheadInteractionRevision + 1,
      }));
    },

    seekRelative: (delta: number) => {
      const { playheadPosition } = get();
      const newPosition = Math.max(0, playheadPosition + delta);
      get().seekTo(newPosition);
    },

    seekToStart: () => {
      get().seekTo(0);
    },

    seekToEnd: (duration: number) => {
      get().seekTo(duration);
    },

    startScrubbing: (position: number) => {
      const clampedPosition = Math.max(0, position);
      set((state) => ({
        isScrubbing: true,
        scrubPosition: clampedPosition,
        playheadPosition: clampedPosition,
        playheadInteractionRevision: state.playheadInteractionRevision + 1,
      }));
    },

    updateScrubPosition: (position: number) => {
      const { isScrubbing } = get();
      if (isScrubbing) {
        const clampedPosition = Math.max(0, position);
        set({
          scrubPosition: clampedPosition,
          playheadPosition: clampedPosition,
        });
      }
    },

    endScrubbing: () => {
      const { scrubPosition } = get();
      set({
        isScrubbing: false,
        scrubPosition: null,
        playheadPosition: scrubPosition ?? get().playheadPosition,
      });
    },

    zoomIn: () => {
      const { pixelsPerSecond } = get();
      // Scale zoom by 1.5x but never exceed max to prevent performance issues at extreme zoom
      const newZoom = Math.min(pixelsPerSecond * 1.5, ZOOM_PRESETS.MAX);
      set({ pixelsPerSecond: newZoom });
    },

    zoomOut: () => {
      const { pixelsPerSecond } = get();
      // Scale zoom down by 1.5x, stopping at the absolute floor. Fit-to-view
      // may sit far below the old 10px/s floor, so zoomOut must stay usable
      // down to that fitted level.
      const newZoom = Math.max(pixelsPerSecond / 1.5, ZOOM_PRESETS.ABSOLUTE_MIN);
      set({ pixelsPerSecond: newZoom });
    },

    setZoom: (pixelsPerSecond: number) => {
      // Clamp zoom to the shared effective range to ensure consistent
      // rendering and prevent sub-pixel issues
      const clampedZoom = Math.max(
        ZOOM_PRESETS.ABSOLUTE_MIN,
        Math.min(ZOOM_PRESETS.MAX, pixelsPerSecond),
      );
      set({ pixelsPerSecond: clampedZoom });
    },

    zoomToFit: (duration: number, visibleTimeWidth?: number) => {
      const { viewportWidth } = get();
      if (duration > 0) {
        // Calculate zoom that fits entire timeline in the VISIBLE time area,
        // i.e. the viewport minus the track-header column (the stored
        // viewportWidth covers the whole container including that column).
        // Formula: pixels_per_second = available_width / duration_seconds.
        // Only the absolute floor applies — hour-long projects must fit, so
        // this deliberately bypasses any "practical minimum" zoom. A 100px
        // margin keeps the fitted content clear of the right edge.
        const measuredWidth =
          visibleTimeWidth && visibleTimeWidth > 0
            ? visibleTimeWidth
            : viewportWidth - TIMELINE_TRACK_HEADER_WIDTH_PX;
        const availableWidth = Math.max(0, measuredWidth - 100);
        const newZoom = Math.max(
          ZOOM_PRESETS.ABSOLUTE_MIN,
          Math.min(ZOOM_PRESETS.MAX, availableWidth / duration),
        );
        set({
          pixelsPerSecond: newZoom,
          scrollX: 0, // Reset scroll to show beginning of timeline
        });
      }
    },

    autoFitOnFirstLoad: (duration: number, visibleTimeWidth?: number) => {
      if (hasAutoFittedThisSession || duration <= 0) return;
      hasAutoFittedThisSession = true;
      get().zoomToFit(duration, visibleTimeWidth);
    },

    resetZoom: () => {
      set({
        pixelsPerSecond: ZOOM_PRESETS.DEFAULT,
        scrollX: 0,
      });
    },

    setScrollX: (scrollX: number) => {
      set({ scrollX: Math.max(0, scrollX) });
    },

    setScrollY: (scrollY: number) => {
      set({ scrollY: Math.max(0, scrollY) });
    },

    scrollToPlayhead: () => {
      const { playheadPosition, pixelsPerSecond, viewportWidth, scrollX } =
        get();
      // Convert playhead time to pixel position using current zoom level
      const playheadPixels = playheadPosition * pixelsPerSecond;

      // Only scroll if playhead is outside visible viewport range
      // Check: playheadPixels < scrollX (left boundary) OR playheadPixels > scrollX + viewportWidth (right boundary)
      if (
        playheadPixels < scrollX ||
        playheadPixels > scrollX + viewportWidth
      ) {
        // Center playhead in viewport by placing it at 50% width from left edge
        const newScrollX = Math.max(0, playheadPixels - viewportWidth / 2);
        set({ scrollX: newScrollX });
      }
    },

    setViewportDimensions: (width: number, height: number) => {
      set({
        viewportWidth: width,
        viewportHeight: height,
      });
    },

    setTrackHeight: (height: number) => {
      // Update default track height within valid bounds (40px min for usability, 200px max for space)
      set({ trackHeight: Math.max(40, Math.min(200, height)) });
    },

    setTrackHeightById: (trackId: string, height: number) => {
      // Clamp individual track height to prevent extreme values affecting layout calculations
      const clampedHeight = Math.max(40, Math.min(200, height));
      // Use spread operator on trackHeights Map to trigger reactivity in Zustand
      set((state) => ({
        trackHeights: { ...state.trackHeights, [trackId]: clampedHeight },
      }));
    },

    getTrackHeight: (trackId: string, _trackType?: string) => {
      const { trackHeights, trackHeight } = get();
      const override = trackHeights[trackId];
      if (override !== undefined) return override;
      return trackHeight;
    },

    setLoopEnabled: (enabled: boolean) => {
      set({ loopEnabled: enabled });
    },

    setLoopRange: (start: number, end: number) => {
      if (start < end) {
        set({
          loopStart: Math.max(0, start),
          loopEnd: end,
        });
      }
    },

    timeToPixels: (time: number) => {
      const { pixelsPerSecond } = get();
      // Convert seconds to pixel distance: pixels = time * pixels_per_second
      return time * pixelsPerSecond;
    },

    pixelsToTime: (pixels: number) => {
      const { pixelsPerSecond } = get();
      // Convert pixel distance to seconds: time = pixels / pixels_per_second
      return pixels / pixelsPerSecond;
    },

    getVisibleTimeRange: () => {
      const { scrollX, viewportWidth, pixelsPerSecond } = get();
      // Calculate which time span is visible in the current viewport
      // start: leftmost pixel (scrollX) converted to time
      // end: rightmost pixel (scrollX + viewportWidth) converted to time
      return {
        start: scrollX / pixelsPerSecond,
        end: (scrollX + viewportWidth) / pixelsPerSecond,
      };
    },

    isTimeVisible: (time: number) => {
      const { start, end } = get().getVisibleTimeRange();
      return time >= start && time <= end;
    },

    toggleTrackExpanded: (trackId: string) => {
      set((state) => {
        const newSet = new Set(state.expandedTracks);
        if (newSet.has(trackId)) {
          newSet.delete(trackId);
        } else {
          newSet.add(trackId);
        }
        return { expandedTracks: newSet };
      });
    },

    setTrackExpanded: (trackId: string, expanded: boolean) => {
      set((state) => {
        const newSet = new Set(state.expandedTracks);
        if (expanded) {
          newSet.add(trackId);
        } else {
          newSet.delete(trackId);
        }
        return { expandedTracks: newSet };
      });
    },

    isTrackExpanded: (trackId: string) => {
      return get().expandedTracks.has(trackId);
    },

    toggleClipKeyframesExpanded: (clipId: string) => {
      set((state) => {
        const newSet = new Set(state.expandedClipKeyframes);
        if (newSet.has(clipId)) {
          newSet.delete(clipId);
        } else {
          newSet.add(clipId);
        }
        return { expandedClipKeyframes: newSet };
      });
    },

    setClipKeyframesExpanded: (clipId: string, expanded: boolean) => {
      set((state) => {
        const newSet = new Set(state.expandedClipKeyframes);
        if (expanded) {
          newSet.add(clipId);
        } else {
          newSet.delete(clipId);
        }
        return { expandedClipKeyframes: newSet };
      });
    },

    isClipKeyframesExpanded: (clipId: string) => {
      return get().expandedClipKeyframes.has(clipId);
    },

    setKeyframeEditMode: (enabled: boolean) => {
      set({ keyframeEditMode: enabled });
    },
      }),
      {
        name: TIMELINE_WORKSPACE_STORAGE_KEY,
        partialize: (state) => ({
          trackHeight: state.trackHeight,
          trackHeights: state.trackHeights,
        }),
      },
    ),
  ),
);
