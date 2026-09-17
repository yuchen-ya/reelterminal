/**
 * MotionTrackingSection must land the tracking result as REAL project state:
 * apply converts the tracked path through the core trackingPathToKeyframes
 * and writes transform keyframes via ONE undoable executeActionBatch
 * (keyframe/setAll) — the channel the renderer and exporter consume. The
 * engine's in-memory attachment stays only as a session cache.
 *
 * The bridge is mocked (its engine simulates tracking in-memory); the store,
 * action executor, and history are the real ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Project, TrackingData, TrackingJob } from "@openreel/core";
import { useProjectStore } from "../../../stores/project-store";
import { createEmptyProject } from "../../../stores/project/project-helpers";
import { MotionTrackingSection } from "./MotionTrackingSection";
import { getMotionTrackingBridge } from "../../../bridges/motion-tracking-bridge";

const CLIP_ID = "clip-video";
const FPS = 25;

vi.mock("../../../bridges/motion-tracking-bridge", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../bridges/motion-tracking-bridge")
  >();
  return {
    ...actual,
    getMotionTrackingBridge: vi.fn(),
  };
});

const bridgeMock = {
  subscribe: vi.fn((listener: (state: unknown) => void) => {
    listener({
      isTracking: false,
      progress: 0,
      currentJob: null,
      trackingData: null,
      lostFrames: [],
      error: null,
    });
    return () => {};
  }),
  getTrackingDataForClip: vi.fn((): TrackingData[] => []),
  hasTrackingData: vi.fn(() => false),
  startTracking: vi.fn(),
  cancelTracking: vi.fn(),
  applyTrackingToClip: vi.fn(),
  setApplyScale: vi.fn(),
  removeAttachment: vi.fn(),
};

function trackedPath(): TrackingData {
  return {
    trackId: "track-1",
    clipId: CLIP_ID,
    keyframes: [
      { frame: 0, position: { x: 960, y: 540 }, scale: 1, rotation: 0 },
      { frame: 120, position: { x: 1060, y: 540 }, scale: 1, rotation: 0 },
    ],
    confidence: [1, 1],
    lostFrames: [],
    region: { x: 860, y: 440, width: 200, height: 200 },
    frameRate: FPS,
  };
}

function makeProject(): Project {
  const project = createEmptyProject("Tracking GUI");
  return {
    ...project,
    settings: { ...project.settings, frameRate: FPS, width: 1920, height: 1080 },
    mediaLibrary: {
      items: [
        {
          id: "media-video",
          name: "clip.mp4",
          type: "video",
          fileHandle: null,
          blob: new Blob(["fake"]),
          metadata: {
            duration: 10,
            width: 1920,
            height: 1080,
            frameRate: FPS,
            codec: "h264",
            sampleRate: 48000,
            channels: 2,
            fileSize: 4,
          },
        },
      ],
    },
    timeline: {
      ...project.timeline,
      duration: 5,
      tracks: [
        {
          id: "track-video-1",
          type: "video",
          name: "V1",
          clips: [
            {
              id: CLIP_ID,
              mediaId: "media-video",
              trackId: "track-video-1",
              startTime: 0,
              duration: 5,
              inPoint: 0,
              outPoint: 5,
              effects: [],
              audioEffects: [],
              transform: {
                position: { x: 0, y: 0 },
                scale: { x: 1, y: 1 },
                rotation: 0,
                anchor: { x: 0.5, y: 0.5 },
                opacity: 1,
              },
              volume: 1,
              keyframes: [],
            },
          ],
          transitions: [],
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
        },
      ],
    },
  } as unknown as Project;
}

function clipOf(project: Project) {
  return project.timeline.tracks[0]!.clips.find((clip) => clip.id === CLIP_ID)!;
}

describe("MotionTrackingSection (keyframes landing)", () => {
  beforeEach(() => {
    vi.mocked(getMotionTrackingBridge).mockReturnValue(
      bridgeMock as unknown as ReturnType<typeof getMotionTrackingBridge>,
    );
    bridgeMock.getTrackingDataForClip.mockReset();
    bridgeMock.getTrackingDataForClip.mockImplementation(() => [trackedPath()]);
    bridgeMock.hasTrackingData.mockReset();
    bridgeMock.hasTrackingData.mockImplementation(() => true);
    bridgeMock.applyTrackingToClip.mockClear();
    bridgeMock.setApplyScale.mockClear();
    bridgeMock.removeAttachment.mockClear();
    bridgeMock.startTracking.mockReset();
    useProjectStore.setState({ project: makeProject() });
  });

  afterEach(() => {
    cleanup();
    useProjectStore.setState({ project: createEmptyProject("Reset") });
    vi.restoreAllMocks();
  });

  it("starts tracking over the clip's real fps and duration, not a hardcoded window", async () => {
    // No prior data: the fresh-start panel (with "Start Tracking") shows.
    bridgeMock.getTrackingDataForClip.mockImplementation(() => []);
    bridgeMock.hasTrackingData.mockImplementation(() => false);
    const job = { id: "job-1" } as TrackingJob;
    bridgeMock.startTracking.mockResolvedValue(job);
    render(<MotionTrackingSection clipId={CLIP_ID} />);

    fireEvent.click(screen.getByRole("button", { name: /Start Tracking/ }));

    await waitFor(() => {
      expect(bridgeMock.startTracking).toHaveBeenCalled();
    });
    const [, , options] = bridgeMock.startTracking.mock.calls[0]!;
    // Project fps 25, clip duration 5s → frames 0..125 (no more 30fps/150).
    expect(options.frameRate).toBe(25);
    expect(options.startFrame).toBe(0);
    expect(options.endFrame).toBe(125);
  });

  it("applies the path as ONE undoable keyframe/setAll batch the renderer consumes", async () => {
    render(<MotionTrackingSection clipId={CLIP_ID} />);

    fireEvent.click(screen.getByRole("button", { name: /Apply Tracking to Clip/ }));

    await waitFor(() => {
      expect(clipOf(useProjectStore.getState().project).keyframes.length).toBeGreaterThan(0);
    });

    const keyframes = clipOf(useProjectStore.getState().project).keyframes;
    // 2 path points × (position.x/y + scale.x/y).
    expect(keyframes).toHaveLength(8);
    const posX = keyframes
      .filter((k) => k.property === "position.x")
      .sort((a, b) => a.time - b.time);
    // Keep-framed counter-shift in output px (fitScale 1): 0 then -100.
    expect(posX.map((k) => k.value)).toEqual([0, -100]);
    // Times fold from the 25fps tracking clock onto clip-local seconds.
    expect(posX.map((k) => k.time)).toEqual([0, 120 / FPS]);

    // The engine attachment stays a session cache only.
    expect(bridgeMock.applyTrackingToClip).toHaveBeenCalledWith(CLIP_ID, { x: 0, y: 0 });

    // ONE undo restores the whole landing.
    await useProjectStore.getState().undo();
    expect(clipOf(useProjectStore.getState().project).keyframes).toHaveLength(0);
  });

  it("Remove Tracking restores the pre-apply keyframes through the same channel", async () => {
    render(<MotionTrackingSection clipId={CLIP_ID} />);
    fireEvent.click(screen.getByRole("button", { name: /Apply Tracking to Clip/ }));
    await waitFor(() => {
      expect(clipOf(useProjectStore.getState().project).keyframes).toHaveLength(8);
    });

    fireEvent.click(screen.getByRole("button", { name: /Remove Tracking/ }));
    await waitFor(() => {
      expect(clipOf(useProjectStore.getState().project).keyframes).toHaveLength(0);
    });
    expect(bridgeMock.removeAttachment).toHaveBeenCalledWith(CLIP_ID);

    // And that removal is itself undoable.
    await useProjectStore.getState().undo();
    expect(clipOf(useProjectStore.getState().project).keyframes).toHaveLength(8);
  });

  it("changes nothing when no tracking data exists for the clip", () => {
    bridgeMock.getTrackingDataForClip.mockImplementation(() => []);
    bridgeMock.hasTrackingData.mockImplementation(() => false);
    render(<MotionTrackingSection clipId={CLIP_ID} />);

    // Without a tracked path there is no apply control to offer.
    const applyButton = screen.queryByRole("button", { name: /Apply Tracking to Clip/ });
    expect(applyButton).toBeNull();
    expect(clipOf(useProjectStore.getState().project).keyframes).toHaveLength(0);
  });
});
