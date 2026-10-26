import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildWorkbenchLineageGroups,
  inferParentModeFromItem,
  resolveItemCompareTargetId,
} from "./lineage-tree-utils";
import { PendingLineagePanel } from "./PendingLineagePanel";
import { AdaptiveBoardWorkspace } from "./AdaptiveBoardWorkspace";
import { VideoFrameWorkspace } from "./VideoFrameWorkspace";
import type { WorkbenchItemView } from "../types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const lineage = (groupId: string, parentNodeId?: string) => ({
  upstreamGroupId: groupId,
  upstreamGroupTitle: groupId,
  upstreamSourceNode: `source-${groupId}`,
  ...(parentNodeId ? { parentNodeId } : {}),
  basedOnLabel: "source",
  connectorEdgeLabel: "derived",
  failStreak: 0,
  steps: [],
});

const item = (
  id: string,
  groupId?: string,
  parentNodeId?: string,
  extra?: Partial<WorkbenchItemView>,
): WorkbenchItemView =>
  ({
    id,
    batchId: "batch-1",
    orderIndex: 0,
    title: id,
    subtitle: "",
    type: "image",
    version: 1,
    status: "pending",
    hasManualRevision: false,
    provenanceTags: [],
    userCategoryTags: [],
    feedbacks: [],
    ...(groupId ? { lineage: lineage(groupId, parentNodeId) } : {}),
    ...extra,
  }) as WorkbenchItemView;

describe("buildWorkbenchLineageGroups & parent modes", () => {
  it("uses real parent links, keeps ungrouped items separate, and promotes a cycle root", () => {
    const groups = buildWorkbenchLineageGroups(
      [
        item("a", "group-a"),
        item("b", "group-a", "a"),
        item("missing-parent", "group-a", "outside"),
        item("cycle-a", "group-b", "cycle-b"),
        item("cycle-b", "group-b", "cycle-a"),
        item("ungrouped"),
      ],
      { ungroupedId: "ungrouped-id", ungroupedLabel: "本批内容" },
    );

    expect(groups.map((group) => group.id)).toEqual([
      "group-a",
      "group-b",
      "ungrouped-id",
    ]);
    expect(groups[0].roots.map((root) => root.item.id)).toEqual([
      "a",
      "missing-parent",
    ]);
    expect(groups[0].roots[0].children.map((child) => child.item.id)).toEqual([
      "b",
    ]);
    expect(groups[1].roots).toHaveLength(1);
    expect(groups[1].roots[0].item.id).toBe("cycle-a");
    expect(groups[1].roots[0].children[0].item.id).toBe("cycle-b");
    expect(groups[1].roots[0].children[0].children).toHaveLength(0);
    expect(groups[2].roots.map((root) => root.item.id)).toEqual(["ungrouped"]);
  });

  it("distinguishes board parents from category parents", () => {
    const boardParent = item("board-root", "g1", undefined, {
      groupMode: "board",
      title: "九宫格分镜",
    });
    const child1 = item("shot-1", "g1", "board-root", { title: "镜头01" });
    const catParent = item("cat-root", "g2", undefined, {
      groupMode: "category",
      title: "第一幕",
    });
    const child2 = item("shot-2", "g2", "cat-root", { title: "镜头02" });

    expect(inferParentModeFromItem(boardParent)).toBe("board");
    expect(inferParentModeFromItem(catParent)).toBe("category");

    const groups = buildWorkbenchLineageGroups([
      boardParent,
      child1,
      catParent,
      child2,
    ]);
    expect(groups[0].roots[0].mode).toBe("board");
    expect(groups[1].roots[0].mode).toBe("category");
  });

  it("resolves video comparison targets from explicit field, payload, parent video, or tag", () => {
    const baseVideo = item("vid-base", "g1", undefined, {
      type: "video",
      title: "精剪v1",
    });
    const reworkByLineage = item("vid-v2", "g1", "vid-base", {
      type: "video",
      title: "精剪v2",
      version: 2,
    });
    const reworkByExplicit = item("vid-v3", "g1", undefined, {
      type: "video",
      title: "精剪v3",
      compareWithItemId: "vid-base",
    });

    const allVideos = [baseVideo, reworkByLineage, reworkByExplicit];
    expect(resolveItemCompareTargetId(reworkByLineage, allVideos)).toBe("vid-base");
    expect(resolveItemCompareTargetId(reworkByExplicit, allVideos)).toBe("vid-base");
    expect(resolveItemCompareTargetId(baseVideo, allVideos)).toBeNull();
  });
});

describe("PendingLineagePanel compact node UI & board vs category parents", () => {
  it("collapses board parent nodes by default and opens AdaptiveBoard on click, while keeping category parents expanded", () => {
    const onSelectItem = vi.fn();
    const onSelectBoard = vi.fn();

    const boardParent = item("board-1", "g-board", undefined, {
      groupMode: "board",
      title: "分镜画板",
    });
    const boardChild = item("board-child-1", "g-board", "board-1", {
      title: "特写A",
    });
    const categoryParent = item("cat-1", "g-cat", undefined, {
      groupMode: "category",
      title: "音频分类",
    });
    const categoryChild = item("cat-child-1", "g-cat", "cat-1", {
      title: "旁白01",
      version: 2,
    });

    render(
      <PendingLineagePanel
        items={[boardParent, boardChild, categoryParent, categoryChild]}
        currentItem={boardParent}
        selectedIds={[]}
        onSelectItem={onSelectItem}
        onSelectBoard={onSelectBoard}
        onRetrieveItem={vi.fn()}
      />,
    );

    // Board child is collapsed under boardParent by default
    expect(screen.getByText("分镜画板")).toBeInTheDocument();
    expect(screen.queryByText("特写A")).not.toBeInTheDocument();

    // Category child is expanded by default and shows v2 badge (while v1 items hide v1)
    expect(screen.getByText("音频分类")).toBeInTheDocument();
    expect(screen.getByText("旁白01")).toBeInTheDocument();
    expect(screen.getByText("v2")).toBeInTheDocument();
    expect(screen.queryByText("v1")).not.toBeInTheDocument();

    // Clicking the board parent opens the AdaptiveBoard with all subtree item IDs
    fireEvent.click(screen.getByText("分镜画板"));
    expect(onSelectBoard).toHaveBeenCalledWith({
      id: "node:board-1",
      title: "分镜画板",
      itemIds: ["board-1", "board-child-1"],
    });
  });
});

describe("AdaptiveBoardWorkspace", () => {
  it("renders multi-image, text, and data cards together and supports drill-down and batch verdicts", () => {
    const onSelectItem = vi.fn();
    const onOpenChildItem = vi.fn();
    const onCommitDecision = vi.fn();

    const imgCard = item("img-1", "g1", undefined, {
      type: "image",
      title: "早晨街景",
      imagePayload: {
        originalMedia: {
          mediaId: "m-1",
          url: "blob:img-1",
          status: "ready",
          thumbnailUrl: "blob:img-1",
          displayName: "street.png",
        },
        initialDisplayMode: "original",
        naturalWidth: 800,
        naturalHeight: 600,
        annotations: [],
        strokes: [],
      },
    });
    const textCard = item("txt-1", "g1", undefined, {
      type: "text",
      title: "旁白台词",
      textPayload: {
        entryId: "e-1",
        title: "旁白台词",
        speakerOrContext: "旁白",
        originalText: "清晨的阳光洒在街道上。",
        currentText: "清晨的阳光洒在街道上。",
        originalVersion: 1,
        currentVersion: 1,
        rangeComments: [],
      },
    });

    render(
      <AdaptiveBoardWorkspace
        boardTitle="第一幕多模态画板"
        items={[imgCard, textCard]}
        currentItem={imgCard}
        selectedIds={[]}
        onSelectItem={onSelectItem}
        onOpenChildItem={onOpenChildItem}
        onCommitDecision={onCommitDecision}
      />,
    );

    expect(screen.getByTestId("adaptive-board-workspace")).toBeInTheDocument();
    expect(screen.getByText("早晨街景")).toBeInTheDocument();
    expect(screen.getByText("清晨的阳光洒在街道上。")).toBeInTheDocument();

    // Double clicking a card drills into its single-item workspace
    fireEvent.doubleClick(screen.getByTestId("board-card-img-1"));
    expect(onOpenChildItem).toHaveBeenCalledWith("img-1");

    // Clicking "整板保留" commits kept for all items on the board
    fireEvent.click(screen.getByTestId("board-keep-all"));
    expect(onCommitDecision).toHaveBeenCalledWith("kept", ["img-1", "txt-1"]);
  });
});

describe("VideoFrameWorkspace side-by-side comparison", () => {
  it("auto-opens side-by-side reference pane when compareWithItemId is bound", () => {
    const baseVideo = item("vid-1", "g1", undefined, {
      type: "video",
      title: "粗剪基线",
      version: 1,
      videoPayload: {
        media: {
          mediaId: "mv-1",
          url: "blob:vid-1",
          status: "ready",
          thumbnailUrl: null,
          displayName: "v1.mp4",
        },
        durationSec: 5,
        resolution: "1920x1080",
        markers: [],
      },
    });
    const currentVideo = item("vid-2", "g1", "vid-1", {
      type: "video",
      title: "调色返工版",
      version: 2,
      compareWithItemId: "vid-1",
      videoPayload: {
        media: {
          mediaId: "mv-2",
          url: "blob:vid-2",
          status: "ready",
          thumbnailUrl: null,
          displayName: "v2.mp4",
        },
        durationSec: 5,
        resolution: "1920x1080",
        markers: [],
      },
    });

    render(
      <VideoFrameWorkspace
        item={currentVideo}
        batchVideoItems={[baseVideo, currentVideo]}
        onUpdateVideoMarkers={vi.fn(async () => ({ ok: true as const }))}
        issuePanelWidth={280}
      />,
    );

    expect(screen.getByTestId("video-compare-reference-pane")).toBeInTheDocument();
    expect(screen.getByTestId("video-compare-toggle")).toHaveTextContent("并排对比");
  });
});
