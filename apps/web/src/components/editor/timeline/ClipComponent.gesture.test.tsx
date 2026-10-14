import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { Clip, MediaItem, Project, TextClip, Track } from "@reelterminal/core";
import { CaptureController } from "../../../performance/capture-controller";
import { createEmptyProject } from "../../../stores/project/project-helpers";
import { useProjectStore } from "../../../stores/project-store";
import { useUIStore } from "../../../stores/ui-store";
import { buildClipMoveActionBatch } from "../../../utils/timeline-gesture-actions";
import { ClipComponent } from "./ClipComponent";

const trackId = "gesture-video-track";
let capture: CaptureController | undefined;
type MoveBatch = Array<{ clipId: string; startTime: number; trackId?: string }>;
type MoveCommit = (moves: MoveBatch) => boolean | Promise<boolean>;
type TrimCommit = (clipId: string, edge: "left" | "right", newTime: number) => boolean | Promise<boolean>;

function makeClip(id: string, startTime: number): Clip {
  return {
    id,
    mediaId: `media-${id}`,
    trackId,
    startTime,
    duration: 2,
    inPoint: 0,
    outPoint: 2,
    effects: [],
    audioEffects: [],
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      anchor: { x: 0.5, y: 0.5 },
      rotation: 0,
      opacity: 1,
    },
    volume: 1,
    keyframes: [],
  } as Clip;
}

function makeMediaItem(id: string): MediaItem {
  return {
    id,
    name: `${id}.mp4`,
    type: "video",
    fileHandle: null,
    blob: null,
    metadata: { duration: 10, width: 1920, height: 1080, frameRate: 30 },
    thumbnailUrl: null,
    waveformData: null,
  } as MediaItem;
}

function makeCaption(id: string, startTime: number, sourceClipId: string): TextClip {
  return {
    id,
    trackId: "gesture-caption-track",
    startTime,
    duration: 1,
    text: id,
    style: {
      fontFamily: "Arial",
      fontSize: 24,
      fontWeight: 400,
      fontStyle: "normal",
      color: "#ffffff",
      textAlign: "left",
      verticalAlign: "middle",
      lineHeight: 1,
      letterSpacing: 0,
    },
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      anchor: { x: 0.5, y: 0.5 },
      rotation: 0,
      opacity: 1,
    },
    keyframes: [],
    metadata: { captionSourceClipId: sourceClipId },
  } as TextClip;
}

function setGestureProject(textClips: TextClip[] = []): Track {
  const emptyProject = createEmptyProject("Timeline gesture test");
  const track: Track = {
    id: trackId,
    type: "video",
    name: "V1",
    clips: [makeClip("clip-primary", 0), makeClip("clip-companion", 5)],
    transitions: [],
    locked: false,
    hidden: false,
    muted: false,
    solo: false,
  } as Track;
  const project: Project = {
    ...emptyProject,
    mediaLibrary: {
      ...emptyProject.mediaLibrary,
      items: [makeMediaItem("media-clip-primary"), makeMediaItem("media-clip-companion")],
    },
    textClips,
    timeline: { ...emptyProject.timeline, tracks: [track], duration: 7 },
  };
  useProjectStore.setState({ project });
  useUIStore.getState().clearSelection();
  return track;
}

function renderClips(track: Track, callbacks: {
  onCommitMoveClips: MoveCommit;
  onTrimClip: TrimCommit;
}) {
  const timelineRef: { current: HTMLDivElement | null } = { current: null };
  const renderTrack = (currentTrack: Track) => (
    <div
      ref={(element) => {
        timelineRef.current = element;
      }}
    >
      {currentTrack.clips.map((clip) => (
        <ClipComponent
          key={clip.id}
          clip={clip}
          track={currentTrack}
          allTracks={[currentTrack]}
          pixelsPerSecond={60}
          isSelected={clip.id === "clip-primary"}
          trackHeights={new Map([[trackId, 48]])}
          timelineRef={timelineRef}
          onSelect={() => {}}
          onCommitMoveClips={callbacks.onCommitMoveClips}
          onTrimClip={callbacks.onTrimClip}
          onSnapIndicator={() => {}}
        />
      ))}
    </div>
  );
  const result = render(renderTrack(track));
  const root = timelineRef.current!;
  vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 100, width: 800, height: 100,
    toJSON: () => ({}),
  } as DOMRect);
  for (const element of root.querySelectorAll<HTMLElement>("[data-live-editor-target-kind='clip']")) {
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 120, bottom: 48, width: 120, height: 48,
      toJSON: () => ({}),
    } as DOMRect);
    if (element.parentElement) {
      vi.spyOn(element.parentElement, "getBoundingClientRect").mockReturnValue({
        x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 48, width: 800, height: 48,
        toJSON: () => ({}),
      } as DOMRect);
    }
  }
  return {
    ...result,
    root,
    rerenderTrack: (currentTrack: Track) => result.rerender(renderTrack(currentTrack)),
  };
}

describe("ClipComponent timeline gesture previews", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    if (capture?.activeRunId) capture.stopCapture();
    useProjectStore.getState().createNewProject("Reset");
    useUIStore.getState().clearSelection();
  });

  it("previews a multi-selection during pointer moves and submits one final batch on release", async () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const track = setGestureProject();
    useUIStore.getState().select({ id: "clip-primary", type: "clip" });
    useUIStore.getState().select({ id: "clip-companion", type: "clip" }, true);
    const onCommitMoveClips = vi.fn<MoveCommit>().mockResolvedValue(true);
    const onTrimClip = vi.fn<TrimCommit>().mockResolvedValue(true);
    const { root } = renderClips(track, { onCommitMoveClips, onTrimClip });
    const primary = root.querySelector<HTMLElement>('[data-live-editor-target-id="clip-primary"]')!;

    act(() => fireEvent.mouseDown(primary, { button: 0, clientX: 10, clientY: 10 }));
    act(() => fireEvent.mouseMove(window, { clientX: 20, clientY: 10 }));
    act(() => fireEvent.mouseMove(window, { clientX: 70, clientY: 10 }));

    expect(onCommitMoveClips).not.toHaveBeenCalled();
    expect(primary.style.transform).toContain("translate(60px");
    expect(root.querySelector<HTMLElement>('[data-live-editor-target-id="clip-companion"]')?.style.transform)
      .toBe("translateX(360px)");

    act(() => fireEvent.mouseUp(window));
    await waitFor(() => expect(onCommitMoveClips).toHaveBeenCalledTimes(1));
    expect(onCommitMoveClips).toHaveBeenCalledWith([
      { clipId: "clip-primary", startTime: 1 },
      { clipId: "clip-companion", startTime: 6 },
    ]);
  });

  it("records mouseup before a delayed move callback resolves", () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let nowUs = 1_000;
    capture = new CaptureController();
    capture.startCapture({
      mode: "light",
      runId: "clip-mouseup-time",
      observerHost: {},
      clock: {
        clockId: "gesture-clock",
        processEpoch: "gesture-epoch",
        timeOriginUs: 0,
        nowUs: () => nowUs,
      },
      budgets: { inputSampleEveryN: 1, frameSampleEveryN: 1, memorySampleIntervalSeconds: 0 },
    });
    const track = setGestureProject();
    const onCommitMoveClips = vi.fn<MoveCommit>(() => {
      nowUs = 2_000;
      return new Promise<boolean>(() => {});
    });
    const onTrimClip = vi.fn<TrimCommit>().mockResolvedValue(true);
    const { root } = renderClips(track, { onCommitMoveClips, onTrimClip });
    const primary = root.querySelector<HTMLElement>(
      '[data-live-editor-target-id="clip-primary"]',
    )!;

    act(() => fireEvent.mouseDown(primary, { button: 0, clientX: 10, clientY: 10 }));
    act(() => fireEvent.mouseMove(window, { clientX: 20, clientY: 10 }));
    act(() => fireEvent.mouseMove(window, { clientX: 70, clientY: 10 }));
    act(() => fireEvent.mouseUp(window));

    expect(onCommitMoveClips).toHaveBeenCalledTimes(1);
    const report = capture.stopCapture();
    const release = report.events.find((event) => event.phase === "input.released");
    expect(release).toMatchObject({ tsUs: 1_000 });
    expect(report.events.some((event) => event.phase === "gesture.final-commit")).toBe(false);
    expect(report.openSpans).toBe(0);
  });

  it("keeps two successive single-clip pointer gestures in separate undo units", async () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const track = setGestureProject();
    let commitId = 0;
    const onCommitMoveClips = vi.fn<MoveCommit>(async (moves) => {
      const move = moves[0];
      if (!move) return false;
      const result = await useProjectStore.getState().submitActionBatch([{
        type: "clip/move",
        id: `gesture-commit-${++commitId}`,
        timestamp: Date.now(),
        params: { clipId: move.clipId, startTime: move.startTime },
      }], {
        groupLabel: "Move clip",
        historyOwner: "human",
        separateHistoryUnit: true,
      });
      return result.result.success;
    });
    const onTrimClip = vi.fn<TrimCommit>().mockResolvedValue(true);
    const { root, rerenderTrack } = renderClips(track, { onCommitMoveClips, onTrimClip });

    const drag = async (fromX: number, toX: number, expectedStartTime: number) => {
      const primary = root.querySelector<HTMLElement>(
        '[data-live-editor-target-id="clip-primary"]',
      )!;
      act(() => fireEvent.mouseDown(primary, { button: 0, clientX: fromX, clientY: 10 }));
      act(() => fireEvent.mouseMove(window, { clientX: fromX + 10, clientY: 10 }));
      act(() => fireEvent.mouseMove(window, { clientX: toX, clientY: 10 }));
      act(() => fireEvent.mouseUp(window));
      await waitFor(() => {
        expect(useProjectStore.getState().getClip("clip-primary")?.startTime)
          .toBe(expectedStartTime);
      });
      const currentTrack = useProjectStore.getState().project.timeline.tracks[0]!;
      rerenderTrack(currentTrack);
    };

    await drag(10, 70, 1);
    await drag(70, 130, 2);

    expect(onCommitMoveClips).toHaveBeenCalledTimes(2);
    expect((await useProjectStore.getState().undo()).success).toBe(true);
    expect(useProjectStore.getState().getClip("clip-primary")?.startTime).toBe(1);
    expect((await useProjectStore.getState().undo()).success).toBe(true);
    expect(useProjectStore.getState().getClip("clip-primary")?.startTime).toBe(0);
  });

  it("moves linked captions with a multi-selection in one undoable batch", async () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const track = setGestureProject([
      makeCaption("caption-primary", 0.2, "clip-primary"),
      makeCaption("caption-companion", 5.2, "clip-companion"),
    ]);
    useUIStore.getState().select({ id: "clip-primary", type: "clip" });
    useUIStore.getState().select({ id: "clip-companion", type: "clip" }, true);
    const onCommitMoveClips = vi.fn<MoveCommit>(async (moves) => {
      const store = useProjectStore.getState();
      const actions = buildClipMoveActionBatch(store, moves);
      const result = await store.submitActionBatch(actions, {
        groupLabel: "Move clips",
        historyOwner: "human",
        separateHistoryUnit: true,
      });
      return result.result.success;
    });
    const onTrimClip = vi.fn<TrimCommit>().mockResolvedValue(true);
    const { root } = renderClips(track, { onCommitMoveClips, onTrimClip });
    const primary = root.querySelector<HTMLElement>(
      '[data-live-editor-target-id="clip-primary"]',
    )!;

    act(() => fireEvent.mouseDown(primary, { button: 0, clientX: 10, clientY: 10 }));
    act(() => fireEvent.mouseMove(window, { clientX: 20, clientY: 10 }));
    act(() => fireEvent.mouseMove(window, { clientX: 70, clientY: 10 }));
    act(() => fireEvent.mouseUp(window));

    await waitFor(() => {
      const state = useProjectStore.getState();
      expect(state.getClip("clip-primary")?.startTime).toBe(1);
      expect(state.getClip("clip-companion")?.startTime).toBe(6);
      expect(state.getTextClip("caption-primary")?.startTime).toBe(1.2);
      expect(state.getTextClip("caption-companion")?.startTime).toBe(6.2);
    });
    expect(onCommitMoveClips).toHaveBeenCalledTimes(1);

    expect((await useProjectStore.getState().undo()).success).toBe(true);
    const undone = useProjectStore.getState();
    expect(undone.getClip("clip-primary")?.startTime).toBe(0);
    expect(undone.getClip("clip-companion")?.startTime).toBe(5);
    expect(undone.getTextClip("caption-primary")?.startTime).toBe(0.2);
    expect(undone.getTextClip("caption-companion")?.startTime).toBe(5.2);
  });

  it("commits one trim at release and cancels without a semantic call on Escape", async () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const track = setGestureProject();
    const onCommitMoveClips = vi.fn<MoveCommit>().mockResolvedValue(true);
    let completeTrim!: (committed: boolean) => void;
    const onTrimClip = vi.fn<TrimCommit>(() => new Promise<boolean>(resolve => { completeTrim = resolve; }));
    const { root } = renderClips(track, { onCommitMoveClips, onTrimClip });
    const primary = root.querySelector<HTMLElement>('[data-live-editor-target-id="clip-primary"]')!;
    const leftTrimHandle = primary.querySelector<HTMLElement>(".cursor-ew-resize")!;

    act(() => fireEvent.mouseDown(leftTrimHandle, { button: 0, clientX: 0, clientY: 10 }));
    act(() => fireEvent.mouseMove(window, { clientX: 30, clientY: 10 }));
    expect(onTrimClip).not.toHaveBeenCalled();
    expect(primary.style.width).toBe("90px");

    act(() => fireEvent.mouseUp(window));
    await waitFor(() => expect(onTrimClip).toHaveBeenCalledTimes(1));
    expect(onTrimClip).toHaveBeenCalledWith("clip-primary", "left", 0.5);
    expect(primary.style.willChange).toBe("transform, width");
    // The preview changed, but a second body drag is guarded until commit ends.
    act(() => fireEvent.mouseDown(primary, { button: 0, clientX: 30, clientY: 10 }));
    act(() => fireEvent.mouseMove(window, { clientX: 60, clientY: 10 }));
    expect(primary.style.pointerEvents).toBe("auto");
    expect(onCommitMoveClips).not.toHaveBeenCalled();
    act(() => fireEvent.mouseUp(window));
    await act(async () => { completeTrim(true); });
    await waitFor(() => expect(primary.style.willChange).toBe("auto"));

    onTrimClip.mockClear();
    act(() => fireEvent.mouseDown(leftTrimHandle, { button: 0, clientX: 0, clientY: 10 }));
    act(() => fireEvent.mouseMove(window, { clientX: 60, clientY: 10 }));
    act(() => fireEvent.keyDown(window, { key: "Escape" }));
    act(() => fireEvent.mouseUp(window));
    expect(onTrimClip).not.toHaveBeenCalled();
  });
});
