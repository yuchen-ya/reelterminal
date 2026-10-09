// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const fixture = vi.hoisted(() => ({
  comparisonEnabled: true,
  versionCreatedAt: new Date("2026-10-09T09:32:00").getTime(),
  project: {
    settings: { frameRate: 30 },
    mediaLibrary: {
      items: [{
        id: "ref",
        name: "Reference cut",
        type: "video",
        originalUrl: "blob:reference-video",
        metadata: { duration: 8 },
      }],
    },
    referenceComparison: {
      referenceMediaId: "ref",
      refStartSec: 1,
      refEndSec: 3,
      timelineStartSec: 2,
      rate: 1,
      audioSide: "reference",
      layout: "overlay",
      overlayOpacity: 0.35,
    },
  },
  timeline: {
    playheadPosition: 2.5,
    playbackState: "paused",
    togglePlayback: vi.fn(),
    seekRelative: vi.fn(),
    seekToStart: vi.fn(),
  },
  executeAction: vi.fn().mockResolvedValue({ success: true }),
  nodes: [] as Array<Record<string, unknown>>,
  nodeRecord: null as Record<string, unknown> | null,
  nodeLookupFails: false,
  renderer: {
    projectId: "p1",
    nodeId: "node-1",
    durationSec: 6,
    width: 320,
    height: 240,
    revision: 0,
    renderAt: vi.fn(async (): Promise<"frame" | "no-frame"> => "frame"),
    isDisposed: vi.fn(() => false),
    dispose: vi.fn(),
  },
  previewState: {
    active: false,
    busy: false,
    info: null,
  } as {
    active: boolean;
    busy: boolean;
    info:
      | null
      | {
          projectId: string;
          nodeId: string | null;
          workspaceId: string | null;
          nodeName: string;
          summary: string;
          createdAt: number | null;
          missingDependencies: string[];
          agentTrial: boolean;
        };
  },
  toastError: vi.fn(),
}));

vi.mock("../../../stores/project-store", () => ({
  useProjectStore: (selector: (state: unknown) => unknown) => selector({
    ...fixture,
    project: { ...fixture.project, referenceComparison: fixture.comparisonEnabled ? fixture.project.referenceComparison : null },
  }),
}));
vi.mock("../../../stores/timeline-store", () => ({
  useTimelineStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector(fixture.timeline),
    { getState: () => fixture.timeline },
  ),
}));
vi.mock("../../../stores/notification-store", () => ({
  toast: { error: fixture.toastError, success: vi.fn() },
}));
vi.mock("../../../services/workspace-manager", () => ({
  workspaceManager: {
    getActiveTarget: vi.fn(() => ({ projectId: "p1", workspaceId: "w1" })),
    listNodes: vi.fn(async () => fixture.nodes),
    getNode: vi.fn(async () => {
      if (fixture.nodeLookupFails) return null;
      return fixture.nodeRecord;
    }),
    subscribe: vi.fn(() => () => undefined),
    getSnapshot: vi.fn(() => ({
      version: 1,
      activeProjectId: "p1",
      activeWorkspaceId: "w1",
      projects: [],
      workspaces: [],
      nodes: [],
    })),
  },
}));
vi.mock("../../../services/preview-session", () => ({
  previewSession: {
    subscribe: vi.fn(() => () => undefined),
    getSnapshot: vi.fn(() => fixture.previewState),
    enter: vi.fn(),
    exit: vi.fn(),
    adopt: vi.fn(),
    getNodeSummary: vi.fn(async () => null),
  },
  isPreviewActive: () => fixture.previewState.active,
}));
vi.mock("./history-frame-renderer", () => ({
  createHistoryFrameRenderer: vi.fn(async () => fixture.renderer),
}));

import {
  ComparisonSourcePicker,
  ReferenceComparisonControl,
  ReferenceComparisonPanel,
  activateHistoryComparison,
  closeHistoryComparison,
  formatVersionTimestamp,
  getHistoryComparisonSnapshot,
  resolveReferenceMediaUrl,
} from "./ReferenceComparisonPanel";
import { workspaceManager } from "../../../services/workspace-manager";

function resetHistoryModuleState() {
  closeHistoryComparison();
  fixture.renderer.dispose.mockClear();
  fixture.renderer.renderAt.mockClear();
  fixture.renderer.isDisposed.mockClear();
  fixture.renderer.renderAt.mockImplementation(async () => "frame");
}

describe("in-player reference comparison", () => {
  beforeEach(() => {
    fixture.comparisonEnabled = true;
    fixture.timeline.playheadPosition = 2.5;
    fixture.timeline.playbackState = "paused";
    fixture.project.referenceComparison.layout = "overlay";
    fixture.project.referenceComparison.audioSide = "reference";
    fixture.project.mediaLibrary.items = [{
      id: "ref",
      name: "Reference cut",
      type: "video",
      originalUrl: "blob:reference-video",
      metadata: { duration: 8 },
    }];
    fixture.executeAction.mockClear();
    fixture.executeAction.mockResolvedValue({ success: true });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
  });

  afterEach(() => {
    resetHistoryModuleState();
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps the picture clear and places comparison in the toolbar", () => {
    fixture.comparisonEnabled = false;
    render(<><ReferenceComparisonPanel timelineCanvasRef={{ current: null }} /><ReferenceComparisonControl /></>);
    expect(screen.queryByTestId("reference-comparison-viewport")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByRole("button", { name: "Reference comparison" })).toHaveTextContent("Compare");
  });

  it("places both frames inside the player and keeps timeline transport out of the comparison UI", async () => {
    render(<ReferenceComparisonPanel timelineCanvasRef={{ current: null }} />);
    const surfaces = screen.getByTestId("comparison-surfaces");
    const video = screen.getByLabelText("Reference video");
    expect(surfaces.contains(screen.getByLabelText("Timeline video"))).toBe(true);
    expect(video.style.opacity).toBe("0.35");
    expect(screen.queryByRole("button", { name: /play|pause/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Side by side" })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Side by side" }));
      await Promise.resolve();
    });
    expect(fixture.executeAction).toHaveBeenCalledWith(expect.objectContaining({
      params: { config: expect.objectContaining({ layout: "side-by-side" }) },
    }));
  });

  it("syncs the reference from the main playhead and aligns the chosen reference frame", async () => {
    const { rerender } = render(<ReferenceComparisonPanel timelineCanvasRef={{ current: null }} />);
    const video = screen.getByLabelText<HTMLVideoElement>("Reference video");
    Object.defineProperty(video, "duration", { configurable: true, value: 8 });
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(1.5);

    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    fireEvent.change(screen.getByRole("slider", { name: "Reference position" }), { target: { value: "2.4" } });
    expect(video.currentTime).toBe(2.4);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Align this reference frame to the timeline playhead" }));
      await Promise.resolve();
    });
    expect(fixture.executeAction).toHaveBeenCalledWith(expect.objectContaining({
      params: { config: expect.objectContaining({ refStartSec: 2.4, timelineStartSec: 2.5 }) },
    }));

    fixture.timeline.playbackState = "playing";
    fixture.timeline.playheadPosition = 3.5;
    rerender(<ReferenceComparisonPanel timelineCanvasRef={{ current: null }} />);
    expect(video.currentTime).toBeCloseTo(2.5, 3);
    expect(video.muted).toBe(false);
    expect(video.play).toHaveBeenCalled();
  });

  it("honors user mute and shows a recovery state when the source cannot be resolved", async () => {
    const { rerender } = render(<ReferenceComparisonPanel timelineCanvasRef={{ current: null }} userMuted />);
    const video = screen.getByLabelText<HTMLVideoElement>("Reference video");
    Object.defineProperty(video, "duration", { configurable: true, value: 8 });
    fireEvent.loadedMetadata(video);
    expect(video.muted).toBe(true);

    fixture.project.mediaLibrary.items = [];
    rerender(<ReferenceComparisonPanel timelineCanvasRef={{ current: null }} userMuted />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Reference media is unavailable"));
  });

  it("prefers a blob URL, then the controlled path, then originalUrl", () => {
    const blob = new Blob(["video"]);
    expect(resolveReferenceMediaUrl({ blob, originalUrl: "https://media.test/ref.mp4" }, () => "blob:local")).toEqual({
      url: "blob:local",
      revoke: true,
    });
    expect(resolveReferenceMediaUrl({ originalUrl: "https://media.test/ref.mp4" })).toEqual({
      url: "https://media.test/ref.mp4",
      revoke: false,
    });
    expect(resolveReferenceMediaUrl({
      contentUrl: "C:/controlled/reference.mp4",
      originalUrl: "https://media.test/ref.mp4",
    })).toEqual({
      url: "C:/controlled/reference.mp4",
      revoke: false,
    });
    expect(resolveReferenceMediaUrl(undefined)).toEqual({ url: null, revoke: false });
  });
});

describe("history version comparison", () => {
  beforeEach(() => {
    fixture.comparisonEnabled = false;
    fixture.timeline.playheadPosition = 2.5;
    fixture.timeline.playbackState = "paused";
    fixture.nodeLookupFails = false;
    fixture.nodes = [{
      id: "node-1",
      projectId: "p1",
      parentNodeId: null,
      name: "初剪",
      summary: "first cut",
      createdAt: fixture.versionCreatedAt,
      formatVersion: 1,
      mediaIds: [],
      missingDependencies: [],
    }];
    fixture.nodeRecord = {
      ...fixture.nodes[0],
      project: { id: "p1", settings: { width: 320, height: 240, frameRate: 30 } },
    };
    fixture.previewState = { active: false, busy: false, info: null };
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.mocked(workspaceManager.listNodes).mockClear();
    vi.mocked(workspaceManager.getNode).mockClear();
  });

  afterEach(() => {
    resetHistoryModuleState();
    cleanup();
    vi.restoreAllMocks();
  });

  it("lists the project's nodes in the picker and activates history compare without project dispatches", async () => {
    render(<ComparisonSourcePicker onClose={() => undefined} />);

    const historySelect = (await waitFor(() => {
      const select = screen.getByRole("combobox", { name: "Historical save point" }) as HTMLSelectElement;
      expect(select.disabled).toBe(false);
      expect(screen.getByRole("option", { name: /^初剪 · / })).toBeTruthy();
      return select;
    })) as HTMLSelectElement;

    await act(async () => {
      fireEvent.change(historySelect, { target: { value: "node-1" } });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(workspaceManager.getNode).toHaveBeenCalledWith("p1", "node-1");
    expect(getHistoryComparisonSnapshot()?.nodeId).toBe("node-1");
    // History compare is UI-local: no reference/setComparison, no undo entries.
    expect(fixture.executeAction).not.toHaveBeenCalled();
  });

  it("shows the failure toast and closes the picker when the node cannot be loaded", async () => {
    fixture.nodeLookupFails = true;
    const onClose = vi.fn();
    render(<ComparisonSourcePicker onClose={onClose} />);

    const historySelect = (await waitFor(() => {
      const select = screen.getByRole("combobox", { name: "Historical save point" }) as HTMLSelectElement;
      expect(select.disabled).toBe(false);
      return select;
    })) as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(historySelect, { target: { value: "node-1" } });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(fixture.toastError).toHaveBeenCalledWith("Could not read this save point"),
    );
    expect(onClose).toHaveBeenCalled();
    expect(getHistoryComparisonSnapshot()).toBeNull();
  });

  it("renders both sides with version labels, mapped time sync and an honest no-frame notice past the version", async () => {
    act(() => {
      activateHistoryComparison({
        projectId: "p1",
        nodeId: "node-1",
        name: "初剪",
        createdAt: fixture.versionCreatedAt,
        durationSec: 6,
        width: 320,
        height: 240,
        renderer: fixture.renderer as never,
      });
    });
    const { rerender } = render(<ReferenceComparisonPanel timelineCanvasRef={{ current: null }} />);

    // Both layouts label each side; the current side is never the version name.
    expect(screen.getByLabelText(/^初剪 · /)).toBeTruthy();
    expect(screen.getByLabelText("Current editing")).toBeTruthy();

    // Same linear mapping: playhead 2.5 maps to snapshot time 2.5.
    await waitFor(() =>
      expect(fixture.renderer.renderAt).toHaveBeenCalledWith(2.5, expect.anything()),
    );
    expect(screen.queryByTestId("history-no-frame")).toBeNull();

    // Past the version duration the side honestly shows "no picture here".
    fixture.timeline.playheadPosition = 8.5;
    fixture.renderer.renderAt.mockImplementation(async () => "no-frame");
    rerender(<ReferenceComparisonPanel timelineCanvasRef={{ current: null }} />);
    await waitFor(() => expect(screen.getByTestId("history-no-frame")).toBeTruthy());
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("labels the current side as the previewed version instead of current editing during read-only preview", async () => {
    fixture.previewState = {
      active: true,
      busy: false,
      info: {
        projectId: "p1",
        nodeId: "node-1",
        workspaceId: null,
        nodeName: "初剪",
        summary: "",
        createdAt: fixture.versionCreatedAt,
        missingDependencies: [],
        agentTrial: false,
      },
    };
    act(() => {
      activateHistoryComparison({
        projectId: "p1",
        nodeId: "node-1",
        name: "初剪",
        createdAt: fixture.versionCreatedAt,
        durationSec: 6,
        width: 320,
        height: 240,
        renderer: fixture.renderer as never,
      });
    });
    render(<ReferenceComparisonPanel timelineCanvasRef={{ current: null }} />);

    const previewedLabel = /^初剪 · /;
    await waitFor(() => expect(screen.getAllByLabelText(previewedLabel).length).toBe(2));
    expect(screen.queryByLabelText("Current editing")).toBeNull();
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("disposes the history renderer when comparison closes and never reuses it after", async () => {
    act(() => {
      activateHistoryComparison({
        projectId: "p1",
        nodeId: "node-1",
        name: "初剪",
        createdAt: fixture.versionCreatedAt,
        durationSec: 6,
        width: 320,
        height: 240,
        renderer: fixture.renderer as never,
      });
    });
    const { unmount } = render(<ReferenceComparisonPanel timelineCanvasRef={{ current: null }} />);
    expect(screen.getByTestId("reference-comparison-viewport")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close reference comparison" }));
    expect(fixture.renderer.dispose).toHaveBeenCalledOnce();
    expect(getHistoryComparisonSnapshot()).toBeNull();
    await waitFor(() => expect(screen.queryByTestId("reference-comparison-viewport")).toBeNull());

    // Unmount with compare still open releases resources too.
    act(() => {
      activateHistoryComparison({
        projectId: "p1",
        nodeId: "node-1",
        name: "初剪",
        createdAt: fixture.versionCreatedAt,
        durationSec: 6,
        width: 320,
        height: 240,
        renderer: fixture.renderer as never,
      });
    });
    fixture.renderer.dispose.mockClear();
    unmount();
    expect(fixture.renderer.dispose).toHaveBeenCalledOnce();
  });

  it("formats version timestamps as localized month/day plus clock time", () => {
    const formatted = formatVersionTimestamp(fixture.versionCreatedAt, "zh-CN");
    expect(formatted).toMatch(/10月9日|10\/9/);
    expect(formatted).toContain("09:32");
    expect(formatVersionTimestamp(0)).toBe("");
  });
});
