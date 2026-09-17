/**
 * AutoReframeSection must run the REAL analysis path: extracted frames feed
 * engine.analyzeClip, its onProgress drives the visible progress state (no
 * decorative setTimeout stages), and the result lands as ONE undoable
 * executeActionBatch ([project/updateSettings?, keyframe/setAll]) whose
 * transform keyframes the renderer consumes.
 *
 * The frame extraction and the browser engine are mocked (no video decode /
 * OffscreenCanvas in jsdom); the store, action executor, and history are the
 * real ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Project } from "@openreel/core";
import { useProjectStore } from "../../../stores/project-store";
import { createEmptyProject } from "../../../stores/project/project-helpers";
import { AutoReframeSection } from "./AutoReframeSection";
import {
  extractFramesForAnalysis,
  type FrameExtractionResult,
} from "../../../services/frame-extraction";

const CLIP_ID = "clip-video";

vi.mock("../../../services/frame-extraction", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../services/frame-extraction")
  >();
  return {
    ...actual,
    extractFramesForAnalysis: vi.fn(),
  };
});

const analyzeClipMock = vi.fn();
const engineInitializeMock = vi.fn(async (onProgress?: (p: number, m: string) => void) => {
  onProgress?.(10, "Initializing auto-reframe engine...");
  onProgress?.(100, "Auto-reframe engine ready");
});

vi.mock("@openreel/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openreel/core")>();
  return {
    ...actual,
    getAutoReframeEngine: () => ({
      isInitialized: () => true,
      initialize: engineInitializeMock,
      analyzeClip: analyzeClipMock,
    }),
    initializeAutoReframeEngine: () => ({
      isInitialized: () => true,
      initialize: engineInitializeMock,
      analyzeClip: analyzeClipMock,
    }),
  };
});

const SOURCE = { width: 1920, height: 1080 };
const OUTPUT = { width: 1080, height: 1920 };

function fakeFrame() {
  return { width: SOURCE.width, height: SOURCE.height, close: vi.fn() } as unknown as ImageBitmap;
}

function cropAt(time: number, cropX: number) {
  return { time, cropX, cropY: 0, cropWidth: 607.5, cropHeight: 1080, scale: 1 };
}

function makeProject(): Project {
  const project = createEmptyProject("Reframe GUI");
  return {
    ...project,
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
            width: SOURCE.width,
            height: SOURCE.height,
            frameRate: 30,
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

describe("AutoReframeSection (real analysis path)", () => {
  beforeEach(() => {
    vi.mocked(extractFramesForAnalysis).mockReset();
    analyzeClipMock.mockReset();
    useProjectStore.setState({ project: makeProject() });
  });

  afterEach(() => {
    cleanup();
    useProjectStore.setState({ project: createEmptyProject("Reset") });
    vi.restoreAllMocks();
  });

  function mockHappyPath() {
    vi.mocked(extractFramesForAnalysis).mockResolvedValue({
      frames: [fakeFrame(), fakeFrame(), fakeFrame()],
      frameRate: 2,
      times: [0, 0.5, 1],
    } satisfies FrameExtractionResult);
    analyzeClipMock.mockImplementation(
      async (_frames, _rate, _settings, onProgress) => {
        onProgress?.(40, "Analyzing frame 2/3");
        // Let React flush the intermediate progress state before the result
        // overwrites it.
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          keyframes: [cropAt(0, 656.25), cropAt(4, 1920 - 607.5)],
          outputWidth: OUTPUT.width,
          outputHeight: OUTPUT.height,
          success: true,
        };
      },
    );
  }

  it("analyzes real frames and lands resize + transform keyframes in ONE undo group", async () => {
    mockHappyPath();
    render(<AutoReframeSection clipId={CLIP_ID} />);
    fireEvent.click(screen.getByRole("button", { name: /Analyze & Reframe/ }));

    await waitFor(() => {
      expect(clipOf(useProjectStore.getState().project).keyframes.length).toBe(8);
    });

    // The engine received the extracted frames and the analysis rate.
    expect(extractFramesForAnalysis).toHaveBeenCalledTimes(1);
    const [, options] = vi.mocked(extractFramesForAnalysis).mock.calls[0]!;
    expect(options.inPoint).toBe(0);
    expect(options.outPoint).toBe(5);
    expect(analyzeClipMock.mock.calls[0]![0]).toHaveLength(3);
    expect(analyzeClipMock.mock.calls[0]![1]).toBe(2);
    // Frames are released after analysis.
    const frames = analyzeClipMock.mock.calls[0]![0] as ImageBitmap[];
    for (const frame of frames) {
      expect((frame as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalled();
    }

    const project = useProjectStore.getState().project;
    expect(project.settings.width).toBe(OUTPUT.width);
    expect(project.settings.height).toBe(OUTPUT.height);

    // The applied transform keyframes evaluate to the reframe camera.
    const scaleKfs = clipOf(project).keyframes.filter((k) => k.property === "scale.x");
    expect(scaleKfs[0]!.value).toBeCloseTo(3.1605, 4);

    // ONE Ctrl+Z restores BOTH the resize and the keyframes.
    await useProjectStore.getState().undo();
    const reverted = useProjectStore.getState().project;
    expect(reverted.settings.width).toBe(1920);
    expect(reverted.settings.height).toBe(1080);
    expect(clipOf(reverted).keyframes).toHaveLength(0);
  });

  it("skips the resize action when the project already has the output size", async () => {
    mockHappyPath();
    const resized = makeProject();
    useProjectStore.setState({
      project: {
        ...resized,
        settings: { ...resized.settings, width: OUTPUT.width, height: OUTPUT.height },
      } as Project,
    });

    render(<AutoReframeSection clipId={CLIP_ID} />);
    fireEvent.click(screen.getByRole("button", { name: /Analyze & Reframe/ }));

    await waitFor(() => {
      expect(clipOf(useProjectStore.getState().project).keyframes.length).toBe(8);
    });
    expect(useProjectStore.getState().project.settings.width).toBe(OUTPUT.width);

    await useProjectStore.getState().undo();
    expect(clipOf(useProjectStore.getState().project).keyframes).toHaveLength(0);
    expect(useProjectStore.getState().project.settings.width).toBe(OUTPUT.width);
  });

  it("shows progress from the real analysis callback, not decorative stages", async () => {
    mockHappyPath();
    render(<AutoReframeSection clipId={CLIP_ID} />);
    fireEvent.click(screen.getByRole("button", { name: /Analyze & Reframe/ }));

    await screen.findByText("Analyzing frame 2/3");
    await waitFor(() => {
      expect(clipOf(useProjectStore.getState().project).keyframes.length).toBe(8);
    });
  });

  it("changes nothing when the analysis fails, and says so", async () => {
    vi.mocked(extractFramesForAnalysis).mockResolvedValue({
      frames: [fakeFrame()],
      frameRate: 1,
      times: [0],
    } satisfies FrameExtractionResult);
    analyzeClipMock.mockResolvedValue({
      keyframes: [],
      outputWidth: OUTPUT.width,
      outputHeight: OUTPUT.height,
      success: false,
      message: "Engine not initialized",
    });

    render(<AutoReframeSection clipId={CLIP_ID} />);
    fireEvent.click(screen.getByRole("button", { name: /Analyze & Reframe/ }));

    await waitFor(() => {
      expect(analyzeClipMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      // No project mutation may leak from a failed analysis.
      expect(useProjectStore.getState().project.settings.width).toBe(1920);
    });
    expect(clipOf(useProjectStore.getState().project).keyframes).toHaveLength(0);
  });

  it("fails honestly when the media blob is not loaded", async () => {
    const noBlob = makeProject();
    useProjectStore.setState({
      project: {
        ...noBlob,
        mediaLibrary: {
          items: [
            {
              ...(noBlob.mediaLibrary.items[0] as unknown as Record<string, unknown>),
              blob: null,
            },
          ],
        },
      } as Project,
    });

    render(<AutoReframeSection clipId={CLIP_ID} />);
    fireEvent.click(screen.getByRole("button", { name: /Analyze & Reframe/ }));

    await waitFor(() => {
      expect(extractFramesForAnalysis).not.toHaveBeenCalled();
    });
    expect(analyzeClipMock).not.toHaveBeenCalled();
    expect(useProjectStore.getState().project.settings.width).toBe(1920);
  });
});
