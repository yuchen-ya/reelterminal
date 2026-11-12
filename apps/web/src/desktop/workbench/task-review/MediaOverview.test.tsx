import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChineseReviewLocale } from "../../../test/review-locale";
import type { TaskDecisionStatus, TaskReviewSnapshot } from "../../../../../desktop/src/shared/task-review";
import type { TaskMediaUnit } from "../../../../../desktop/src/shared/task-review-media";
import { emptySnapshot } from "./testing";
import { MediaOverview, type MediaOverviewOperations } from "./MediaOverview";

useChineseReviewLocale();

type FakeObserver = { callback: IntersectionObserverCallback; elements: Set<HTMLElement> };
const observers: FakeObserver[] = [];

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal("IntersectionObserver", class {
    private fake: FakeObserver;
    constructor(callback: IntersectionObserverCallback) {
      this.fake = { callback, elements: new Set() };
      observers.push(this.fake);
    }
    observe(element: HTMLElement) { this.fake.elements.add(element); }
    unobserve(element: HTMLElement) { this.fake.elements.delete(element); }
    disconnect() { this.fake.elements.clear(); }
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function showAllThumbnails() {
  for (const observer of observers) {
    for (const element of [...observer.elements]) {
      observer.callback([{ isIntersecting: true, target: element } as unknown as IntersectionObserverEntry], observer as unknown as IntersectionObserver);
    }
  }
}

function imageSnapshot(count: number, statuses: Record<number, TaskDecisionStatus> = {}, notes: Record<number, string> = {}) {
  const taskId = crypto.randomUUID();
  const units: TaskMediaUnit[] = [];
  const sources: TaskReviewSnapshot["sources"] = [];
  const sourceFiles: TaskReviewSnapshot["sourceFiles"] = [];
  for (let index = 0; index < count; index++) {
    const sourceVersionId = crypto.randomUUID();
    const entryId = crypto.randomUUID();
    const unitId = crypto.randomUUID();
    units.push({ id: unitId, sourceVersionId, ordinal: index + 1, kind: "image" });
    sources.push({ id: sourceVersionId, entryId, relativePath: `image-${index + 1}.png`, hash: `hash-${index}`, createdAt: index + 1, kind: "image", mime: "image/png", width: 400, height: 200, durationSec: 0 });
    sourceFiles.push({ entryId, relativePath: `image-${index + 1}.png`, currentVersionId: sourceVersionId, size: 100, mtimeMs: 1, status: "available" });
  }
  const decisions: TaskReviewSnapshot["decisions"] = [];
  const decisionActions: TaskReviewSnapshot["decisionActions"] = [];
  for (const [key, status] of Object.entries(statuses)) {
    const unit = units[Number(key) - 1]!;
    const id = crypto.randomUUID();
    decisions.push({ id, unitId: unit.id, sourceVersionId: unit.sourceVersionId, policyRevision: 0, purpose: "review", status, note: notes[Number(key)] ?? "", createdAt: Number(key) });
    decisionActions.push({ id: crypto.randomUUID(), kind: "decide", decisionId: id, createdAt: Number(key) });
  }
  const snapshot: TaskReviewSnapshot = { ...emptySnapshot(), root: "task-root", taskId, sources, sourceFiles, units, decisions, decisionActions };
  return { snapshot, units, sources };
}

function makeOperations() {
  return {
    thumbnailMedia: vi.fn<MediaOverviewOperations["thumbnailMedia"]>().mockImplementation(async (target) => ({ url: `app://media/${target.unitId}`, width: 400, height: 200 })),
    decideBatch: vi.fn<MediaOverviewOperations["decideBatch"]>().mockResolvedValue({ ok: true, snapshot: null, error: null, batchId: crypto.randomUUID() }),
    undoDecisionBatch: vi.fn<MediaOverviewOperations["undoDecisionBatch"]>().mockResolvedValue({ ok: true, snapshot: null, error: null }),
    redoDecisionBatch: vi.fn<MediaOverviewOperations["redoDecisionBatch"]>().mockResolvedValue({ ok: true, snapshot: null, error: null }),
  };
}

function renderTestToolCard(toolBody: ReactNode) {
  return <aside data-testid="agent-spotlight-card">{toolBody}</aside>;
}

function renderOverview(snapshot: TaskReviewSnapshot, operations = makeOperations()) {
  const onOpenUnit = vi.fn();
  const onOpenExport = vi.fn();
  const onOpenTextOverview = vi.fn();
  const onSelectionIntent = vi.fn();
  const rendered = render(<MediaOverview snapshot={snapshot} busy={false} operations={operations} onOpenUnit={onOpenUnit} onOpenExport={onOpenExport} onOpenTextOverview={onOpenTextOverview} renderToolCard={renderTestToolCard} onSelectionIntent={onSelectionIntent} />);
  return { ...rendered, operations, onOpenUnit, onOpenExport, onOpenTextOverview, onSelectionIntent };
}

describe("image media overview", () => {
  it("keeps the grid stage concise and puts only contextual tools in the card", () => {
    const { snapshot } = imageSnapshot(4, { 1: "kept" });
    renderOverview(snapshot);
    const stage = screen.getByTestId("task-review-media-overview");
    const card = screen.getByTestId("agent-spotlight-card");
    expect(stage.firstElementChild).toHaveAttribute("aria-label", "图片筛选与选择");
    expect(stage.lastElementChild).toHaveAttribute("data-testid", "task-review-media-grid");
    expect(stage).not.toContainElement(card);
    expect(within(stage).queryByTestId("task-review-media-batch-kept")).toBeNull();
    expect(within(stage).queryByTestId("task-review-media-keep-remaining")).toBeNull();
    expect(stage.querySelector("textarea")).toBeNull();
    expect(within(stage).queryByText("最近批注")).toBeNull();
    expect(within(card).getByTestId("task-review-media-keep-remaining")).toBeEnabled();
    expect(within(card).queryByTestId("task-review-media-batch-note")).toBeNull();
    expect(within(card).queryByTestId("task-review-media-batch-rework")).toBeNull();
    expect(within(card).queryByText("最近批注")).toBeNull();
  });

  it("shows filename, explicit status counts, search and all four filters", () => {
    const { snapshot } = imageSnapshot(4, { 1: "kept", 2: "rework", 3: "discarded" });
    renderOverview(snapshot);
    expect(screen.getAllByTestId("task-review-media-card")).toHaveLength(4);
    expect(screen.getByTestId("task-review-media-filter-pending")).toHaveTextContent("待审 · 1");
    expect(screen.getAllByTestId("task-review-media-card")[0]).toHaveAttribute("data-status", "kept");
    fireEvent.click(screen.getByTestId("task-review-media-filter-pending"));
    expect(screen.getAllByTestId("task-review-media-card")).toHaveLength(1);
    expect(screen.getByText("image-4.png")).toBeVisible();
    fireEvent.click(screen.getByTestId("task-review-media-filter-rework"));
    expect(screen.getAllByTestId("task-review-media-card")).toHaveLength(1);
    expect(screen.getByText("image-2.png")).toBeVisible();
    fireEvent.click(screen.getByTestId("task-review-media-filter-all"));
    fireEvent.change(screen.getByLabelText("搜索图片文件名"), { target: { value: "image-3" } });
    expect(screen.getAllByTestId("task-review-media-card")).toHaveLength(1);
    expect(screen.getByText("image-3.png")).toBeVisible();
  });

  it("sorts filenames naturally with stable display ordinals and Shift ranges", () => {
    const { snapshot, units, sources } = imageSnapshot(3);
    sources[0]!.relativePath = "10.png";
    sources[1]!.relativePath = "1.png";
    sources[2]!.relativePath = "2.png";
    snapshot.units = [units[2]!, units[0]!, units[1]!];
    renderOverview(snapshot);

    const cards = screen.getAllByTestId("task-review-media-card");
    expect(cards.map((card) => card.getAttribute("data-unit-id"))).toEqual([units[1]!.id, units[2]!.id, units[0]!.id]);
    expect(cards[0]).toHaveTextContent("#1");
    expect(cards[0]).toHaveTextContent("1.png");
    expect(cards[1]).toHaveTextContent("#2");
    expect(cards[1]).toHaveTextContent("2.png");
    expect(cards[2]).toHaveTextContent("#3");
    expect(cards[2]).toHaveTextContent("10.png");

    fireEvent.click(screen.getByRole("checkbox", { name: "选择图片 1.png" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择图片 10.png" }), { shiftKey: true });
    expect(screen.getByTestId("task-review-media-selection-count")).toHaveTextContent("已选 3 项");
    fireEvent.change(screen.getByLabelText("搜索图片文件名"), { target: { value: "2.png" } });
    expect(screen.getAllByTestId("task-review-media-card")).toHaveLength(1);
    expect(screen.getByTestId("task-review-media-card")).toHaveTextContent("#2");
  });

  it("supports Shift ranges and keeps explicit targets when the filter changes", async () => {
    const { snapshot, units } = imageSnapshot(5, { 5: "kept" });
    const { operations, onSelectionIntent } = renderOverview(snapshot);
    fireEvent.click(screen.getByRole("checkbox", { name: "选择图片 image-2.png" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择图片 image-4.png" }), { shiftKey: true });
    expect(screen.getByTestId("task-review-media-selection-count")).toHaveTextContent("已选 3 项");
    expect(screen.getByTestId("task-review-media-card-selection-count")).toHaveTextContent("已选 3 项");
    expect(onSelectionIntent).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByTestId("task-review-media-batch-rework"));
    fireEvent.change(screen.getByTestId("task-review-media-batch-note"), { target: { value: "需要统一调整边缘" } });
    fireEvent.click(screen.getByTestId("task-review-media-filter-kept"));
    expect(screen.getAllByTestId("task-review-media-card")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("task-review-media-confirm-rework"));
    await waitFor(() => expect(operations.decideBatch).toHaveBeenCalledTimes(1));
    expect(operations.decideBatch).toHaveBeenCalledWith({
      targets: units.slice(1, 4).map((unit) => ({ unitId: unit.id, sourceVersionId: unit.sourceVersionId })),
      purpose: "review",
      status: "rework",
      note: "需要统一调整边缘",
      pendingOnly: false,
    });
  });

  it("selects only the current filtered rows on demand", () => {
    const { snapshot, units } = imageSnapshot(4, { 1: "kept", 3: "kept" });
    const { operations } = renderOverview(snapshot);
    fireEvent.click(screen.getByTestId("task-review-media-filter-pending"));
    fireEvent.click(screen.getByTestId("task-review-media-select-filtered"));
    fireEvent.click(screen.getByTestId("task-review-media-batch-discarded"));
    expect(operations.decideBatch).toHaveBeenCalledWith(expect.objectContaining({
      targets: [units[1], units[3]].map((unit) => ({ unitId: unit!.id, sourceVersionId: unit!.sourceVersionId })),
      status: "discarded",
    }));
  });

  it("reuses task-local recent notes as drafts only, then submits one annotated batch", async () => {
    const { snapshot, units } = imageSnapshot(3, { 3: "rework" }, { 3: "沿用上一条返工原因" });
    const { operations, rerender, onOpenUnit, onOpenExport, onOpenTextOverview, onSelectionIntent } = renderOverview(snapshot);
    expect(screen.queryByTestId("task-review-media-batch-note-reuse-last")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "选择图片 image-1.png" }));
    fireEvent.click(screen.getByTestId("task-review-media-batch-rework"));
    fireEvent.click(screen.getByTestId("task-review-media-batch-note-reuse-last"));
    expect(screen.getByTestId("task-review-media-batch-note")).toHaveValue("沿用上一条返工原因");
    expect(operations.decideBatch).not.toHaveBeenCalled();
    expect(screen.getByText("批注仅填入草稿，请显式选择判定。")).toBeVisible();
    fireEvent.click(screen.getByTestId("task-review-media-confirm-rework"));
    await waitFor(() => expect(operations.decideBatch).toHaveBeenCalledTimes(1));
    expect(operations.decideBatch.mock.calls[0]![0]).toMatchObject({ note: "沿用上一条返工原因", targets: [{ unitId: units[0]!.id, sourceVersionId: units[0]!.sourceVersionId }] });
    const other = imageSnapshot(1).snapshot;
    rerender(<MediaOverview snapshot={other} busy={false} operations={operations} onOpenUnit={onOpenUnit} onOpenExport={onOpenExport} onOpenTextOverview={onOpenTextOverview} renderToolCard={renderTestToolCard} onSelectionIntent={onSelectionIntent} />);
    // No stored note or decision belongs to this different task identity.
    fireEvent.click(screen.getByRole("checkbox", { name: "选择图片 image-1.png" }));
    fireEvent.click(screen.getByTestId("task-review-media-batch-rework"));
    expect(screen.getByTestId("task-review-media-batch-note-reuse-last")).toBeDisabled();
  });

  it("requires an explicit rework confirmation, allows an empty note and resets after the flow", async () => {
    const { snapshot, units } = imageSnapshot(2);
    const { operations } = renderOverview(snapshot);
    fireEvent.click(screen.getByRole("checkbox", { name: "选择图片 image-1.png" }));
    fireEvent.click(screen.getByTestId("task-review-media-batch-rework"));
    expect(screen.getByTestId("task-review-media-batch-note")).toHaveValue("");
    expect(operations.decideBatch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("task-review-media-cancel-rework"));
    expect(screen.queryByTestId("task-review-media-batch-note")).toBeNull();
    expect(operations.decideBatch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("task-review-media-batch-rework"));
    fireEvent.click(screen.getByTestId("task-review-media-confirm-rework"));
    await waitFor(() => expect(operations.decideBatch).toHaveBeenCalledTimes(1));
    expect(operations.decideBatch).toHaveBeenLastCalledWith(expect.objectContaining({ status: "rework", note: "", targets: [{ unitId: units[0]!.id, sourceVersionId: units[0]!.sourceVersionId }] }));
    expect(screen.queryByTestId("task-review-media-batch-note")).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: "选择图片 image-2.png" }));
    fireEvent.click(screen.getByTestId("task-review-media-batch-kept"));
    await waitFor(() => expect(operations.decideBatch).toHaveBeenCalledTimes(2));
    expect(operations.decideBatch).toHaveBeenLastCalledWith(expect.objectContaining({ status: "kept", note: "" }));
  });

  it("confirms the exact remaining-pending count and offers atomic undo and redo", async () => {
    const { snapshot, units } = imageSnapshot(3, { 2: "kept" });
    const { operations } = renderOverview(snapshot);
    fireEvent.click(screen.getByTestId("task-review-media-keep-remaining"));
    expect(screen.getByTestId("task-review-media-keep-confirmation")).toHaveTextContent("2 个待审图片");
    fireEvent.click(screen.getByTestId("task-review-media-filter-kept"));
    fireEvent.click(screen.getByTestId("task-review-media-confirm-keep-remaining"));
    await waitFor(() => expect(operations.decideBatch).toHaveBeenCalledTimes(1));
    expect(operations.decideBatch).toHaveBeenCalledWith(expect.objectContaining({
      pendingOnly: true,
      targets: [units[0], units[2]].map((unit) => ({ unitId: unit!.id, sourceVersionId: unit!.sourceVersionId })),
    }));
    const batchId = (await operations.decideBatch.mock.results[0]!.value).batchId!;
    fireEvent.click(await screen.findByTestId("task-review-media-undo-batch"));
    await waitFor(() => expect(operations.undoDecisionBatch).toHaveBeenCalledWith(batchId));
    fireEvent.click(await screen.findByTestId("task-review-media-redo-batch"));
    await waitFor(() => expect(operations.redoDecisionBatch).toHaveBeenCalledWith(batchId));
  });

  it("keeps remaining pending images without videos while preserving explicit video decisions", async () => {
    const { snapshot, units, sources } = imageSnapshot(3);
    snapshot.units[2] = { ...units[2]!, kind: "video" };
    const videoSource = sources[2]!;
    snapshot.sources[2] = { id: videoSource.id, entryId: videoSource.entryId, hash: videoSource.hash, createdAt: videoSource.createdAt, kind: "video", relativePath: "clip.mp4", mime: "video/mp4", width: 400, height: 200, durationSec: 3 };
    const { operations } = renderOverview(snapshot);

    fireEvent.click(screen.getByRole("checkbox", { name: "选择图片 clip.mp4" }));
    fireEvent.click(screen.getByTestId("task-review-media-batch-kept"));
    await waitFor(() => expect(operations.decideBatch).toHaveBeenCalledTimes(1));
    expect(operations.decideBatch.mock.calls[0]![0].targets).toEqual([{ unitId: units[2]!.id, sourceVersionId: units[2]!.sourceVersionId }]);
    operations.decideBatch.mockClear();

    fireEvent.click(screen.getByTestId("task-review-media-keep-remaining"));
    expect(screen.getByTestId("task-review-media-keep-confirmation")).toHaveTextContent("2 个待审图片");
    fireEvent.click(screen.getByTestId("task-review-media-confirm-keep-remaining"));
    await waitFor(() => expect(operations.decideBatch).toHaveBeenCalledTimes(1));
    expect(operations.decideBatch).toHaveBeenCalledWith(expect.objectContaining({
      pendingOnly: true,
      targets: units.slice(0, 2).map((unit) => ({ unitId: unit.id, sourceVersionId: unit.sourceVersionId })),
    }));
  });

  it("does not automatically read offscreen media and caps thumbnail concurrency", async () => {
    const { snapshot } = imageSnapshot(8);
    const operations = makeOperations();
    const pending: { resolve: (value: { url: string; width: number; height: number }) => void; unitId: string }[] = [];
    operations.thumbnailMedia.mockImplementation((target) => new Promise((resolve) => { pending.push({ resolve, unitId: target.unitId }); }));
    renderOverview(snapshot, operations);
    expect(operations.thumbnailMedia).not.toHaveBeenCalled();
    act(showAllThumbnails);
    expect(operations.thumbnailMedia).toHaveBeenCalledTimes(4);
    await act(async () => {
      pending[0]!.resolve({ url: `app://media/${pending[0]!.unitId}`, width: 400, height: 200 });
      await Promise.resolve();
    });
    await waitFor(() => expect(operations.thumbnailMedia).toHaveBeenCalledTimes(5));
  });

  it("blocks confirmation until decoded pixels are ready, zooms originals and decides with next", async () => {
    const { snapshot, units } = imageSnapshot(3);
    const { operations, onOpenUnit } = renderOverview(snapshot);
    const grid = screen.getByTestId("task-review-media-overview");
    grid.scrollTop = 120;
    fireEvent.scroll(grid);
    fireEvent.click(screen.getByRole("checkbox", { name: "选择图片 image-3.png" }));
    fireEvent.click(screen.getAllByTestId("task-review-media-inspect")[0]!);
    const image = await screen.findByTestId("task-review-media-inspector-image");
    expect(screen.getByTestId("task-review-media-rework-next")).toBeDisabled();
    fireEvent.load(image);
    expect(screen.getByTestId("task-review-media-rework-next")).toBeEnabled();
    fireEvent.click(screen.getByTestId("task-review-media-original-pixels"));
    expect(image).toHaveStyle({ width: "400px", height: "200px" });
    fireEvent.click(screen.getByRole("button", { name: "放大" }));
    expect(image).toHaveStyle({ width: "800px", height: "400px" });
    fireEvent.click(screen.getByTestId("task-review-media-transparency-toggle"));
    expect(screen.getByTestId("task-review-media-inspector-viewport")).toHaveAttribute("data-background", "solid");
    expect(screen.queryByTestId("task-review-media-inspector-note")).toBeNull();
    fireEvent.click(screen.getByTestId("task-review-media-rework-next"));
    fireEvent.change(screen.getByTestId("task-review-media-inspector-note"), { target: { value: "边缘需要返工" } });
    expect(operations.decideBatch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("task-review-media-confirm-rework-next"));
    await waitFor(() => expect(operations.decideBatch).toHaveBeenCalledWith(expect.objectContaining({ status: "rework", note: "边缘需要返工", targets: [{ unitId: units[0]!.id, sourceVersionId: units[0]!.sourceVersionId }] })));
    await waitFor(() => expect(screen.getByTestId("task-review-media-inspector-image")).toHaveAttribute("alt", "image-2.png"));
    expect(screen.queryByTestId("task-review-media-inspector-note")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("task-review-media-lightbox")).toBeNull();
    expect(grid.scrollTop).toBe(120);
    expect(screen.getByRole("checkbox", { name: "选择图片 image-3.png" })).toBeChecked();
    fireEvent.click(screen.getAllByTestId("task-review-media-inspect")[0]!);
    fireEvent.click(await screen.findByTestId("task-review-media-open-detailed-tools"));
    expect(onOpenUnit).toHaveBeenCalledWith(units[0]!.id);
  });

  it("keeps the inspector closed when a delayed decide finishes after Escape", async () => {
    const { snapshot } = imageSnapshot(2);
    const operations = makeOperations();
    let finish!: (result: Awaited<ReturnType<MediaOverviewOperations["decideBatch"]>>) => void;
    operations.decideBatch.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    renderOverview(snapshot, operations);
    fireEvent.click(screen.getAllByTestId("task-review-media-inspect")[0]!);
    fireEvent.load(await screen.findByTestId("task-review-media-inspector-image"));
    fireEvent.click(screen.getByTestId("task-review-media-kept-next"));
    await waitFor(() => expect(operations.decideBatch).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("task-review-media-lightbox")).toBeNull();
    await act(async () => {
      finish({ ok: true, snapshot: null, error: null, batchId: crypto.randomUUID() });
      await Promise.resolve();
    });

    expect(screen.queryByTestId("task-review-media-lightbox")).toBeNull();
    expect(operations.decideBatch).toHaveBeenCalledTimes(1);
  });

  it("rejects an over-limit selection instead of silently splitting the commit", async () => {
    const { snapshot } = imageSnapshot(1001);
    const { operations } = renderOverview(snapshot);
    fireEvent.click(screen.getByTestId("task-review-media-select-filtered"));
    fireEvent.click(screen.getByTestId("task-review-media-batch-kept"));
    expect(await screen.findByTestId("task-review-media-action-error")).toHaveTextContent("原子提交上限为 1000");
    expect(operations.decideBatch).not.toHaveBeenCalled();
  }, 15000);
});
