import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskMediaOpenResult, TaskMediaUnit, TaskRegionCandidate, TaskReviewMediaBridge } from "../../../../../desktop/src/shared/task-review-media";
import type { TaskReviewController } from "./useTaskReviewController";
import { emptySnapshot } from "./testing";
import { MediaScene } from "./MediaScene";
import { normalizedMediaPoint } from "./media-view";

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

function setup(kind: "image" | "video" = "image", limit = 32) {
  const unit: TaskMediaUnit = { id: "image-unit", sourceVersionId: "media-source", ordinal: 1, kind };
  const source = { id: "media-source", entryId: "media-file", relativePath: kind === "image" ? "fish.jpg" : "clip.mp4", hash: "source-hash", createdAt: 1, kind, mime: kind === "image" ? "image/jpeg" : "video/mp4", width: 400, height: 200, durationSec: kind === "video" ? 10 : 0 };
  const snapshot = { ...emptySnapshot(), sources: [source], sourceFiles: [{ entryId: source.entryId, relativePath: source.relativePath, currentVersionId: source.id, size: 100, mtimeMs: 1, status: "available" as const }], units: [unit] };
  const opened: TaskMediaOpenResult = { snapshot, source, unit, url: "app://reelterminal/task-media/task-1/pixels", width: 400, height: 200, promptTokenLimit: limit,
    asset: { id: "pixels", sourceVersionId: source.id, unitId: unit.id, kind: "normalized-image", relativePath: "normalized.png", hash: "asset-hash", size: 100, width: 400, height: 200, pixelRevision: "actual-pixels", status: "ready" } };
  const savedRegion: TaskMediaUnit = { id: "new-region", sourceVersionId: source.id, ordinal: 2, kind: "region", parentUnitId: unit.id, maskAssetId: "accepted-mask", cutoutAssetId: "accepted-cutout", width: 400, height: 200, label: "蓝色的鱼", pixelRevision: "actual-pixels", modelVersion: "fixture-model", prompts: { points: [{ x: 0.5, y: 0.5, foreground: true }] } };
  const acceptedSnapshot = { ...snapshot, units: [...snapshot.units, savedRegion] };
  const resultFor = (input: Parameters<TaskReviewMediaBridge["segment"]>[0]): TaskRegionCandidate => ({
    generationId: input.generationId, sourceVersionId: source.id, unitId: unit.id, assetId: "mask", url: `app://reelterminal/task-media/task-1/${input.generationId}`, width: 400, height: 200, pixelRevision: "actual-pixels", modelVersion: "fixture-model", predictedIou: 1.2,
  });
  const operations = {
    openMedia: vi.fn().mockResolvedValue(opened),
    segmentMedia: vi.fn<TaskReviewController["segmentMedia"]>().mockImplementation(async (input) => resultFor(input)),
    cancelMedia: vi.fn().mockResolvedValue(undefined),
    captureMediaFrame: vi.fn().mockResolvedValue({ snapshot, unitId: "real-frame", assetId: "real-frame-pixels", frameIndex: 47, ptsTimeSec: 2.004, timeBase: "1/1000" }),
    acceptMediaRegion: vi.fn().mockResolvedValue({ snapshot: acceptedSnapshot, unitId: "new-region", assetId: "accepted-mask" }),
    decide: vi.fn<TaskReviewController["decide"]>().mockImplementation(async (_input, check) => {
      check?.(acceptedSnapshot);
      return { ok: true, snapshot: acceptedSnapshot, error: null };
    }),
  };
  const onOpenUnit = vi.fn();
  const onDecide = vi.fn();
  const onReportError = vi.fn();
  const props = { snapshot, unit, operations, draft: { sourceVersionId: source.id, text: "人工媒体意见", selectionStart: 1, selectionEnd: 3, savedText: "人工媒体意见", status: "saved" as const, error: null },
    onUpdateDraft: vi.fn(), onOpenUnit, onDecide, onReportError, onUndo: vi.fn(), onRedo: vi.fn(), busy: false };
  const rendered = render(<MediaScene {...props} />);
  const picture = async () => {
    const element = await screen.findByTestId("task-review-media-picture");
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({ left: 100, top: 50, width: 200, height: 100, right: 300, bottom: 150, x: 100, y: 50, toJSON() {} });
    Object.assign(element, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() });
    return element;
  };
  return { ...rendered, props, operations, picture, onOpenUnit, onDecide, onReportError, resultFor, acceptedSnapshot };
}

describe("task media scene", () => {
  it("maps the visible zoomed/normalized picture to source coordinates", () => {
    expect(normalizedMediaPoint(250, 200, { left: 50, top: 100, width: 400, height: 200 })).toEqual({ x: 0.5, y: 0.5 });
    expect(normalizedMediaPoint(450, 300, { left: 50, top: 100, width: 800, height: 400 })).toEqual({ x: 0.5, y: 0.5 });
  });

  it("keeps refinement stable for added points, ignores old generations and resets prior on deletion", async () => {
    const { operations, picture, resultFor } = setup();
    const resolves: ((result: TaskRegionCandidate) => void)[] = [];
    operations.segmentMedia.mockImplementation(() => new Promise((resolve) => { resolves.push(resolve); }));
    const image = await picture();
    fireEvent.pointerDown(image, { clientX: 150, clientY: 75, button: 0 });
    await waitFor(() => expect(operations.segmentMedia).toHaveBeenCalledTimes(1));
    const first = operations.segmentMedia.mock.calls[0]![0];
    expect(first.prompts.points).toEqual([{ x: 0.25, y: 0.25, foreground: true }]);
    fireEvent.pointerDown(image, { clientX: 250, clientY: 125, button: 2 });
    await waitFor(() => expect(operations.segmentMedia).toHaveBeenCalledTimes(2));
    const second = operations.segmentMedia.mock.calls[1]![0];
    expect(second.refinementId).toBe(first.refinementId);
    expect(second.generationId).not.toBe(first.generationId);
    expect(second.prompts.points[1]).toEqual({ x: 0.75, y: 0.75, foreground: false });
    await act(async () => { resolves[0]!(resultFor(first)); });
    expect(screen.queryByTestId("task-review-media-accept")).toBeNull();
    await act(async () => { resolves[1]!(resultFor(second)); });
    expect(screen.getByTestId("task-review-media-mask").style.maskMode).toBe("luminance");
    expect((screen.getByTestId("task-review-unit-note") as HTMLTextAreaElement).value).toBe("人工媒体意见");
    fireEvent.click(screen.getByRole("button", { name: "撤销点" }));
    await waitFor(() => expect(operations.segmentMedia).toHaveBeenCalledTimes(3));
    expect(operations.segmentMedia.mock.calls[2]![0].refinementId).not.toBe(first.refinementId);
    expect(operations.cancelMedia).toHaveBeenCalledWith(expect.objectContaining({ generationId: second.generationId }));
  });

  it("sends a normalized box, enforces the advertised token cap and never truncates prompts", async () => {
    const { operations, picture } = setup("image", 2);
    const image = await picture();
    fireEvent.click(screen.getByRole("button", { name: "框选" }));
    fireEvent.pointerDown(image, { clientX: 140, clientY: 70, button: 0 });
    fireEvent.pointerUp(image, { clientX: 260, clientY: 130, button: 0 });
    await waitFor(() => expect(operations.segmentMedia).toHaveBeenCalledTimes(1));
    expect(operations.segmentMedia.mock.calls[0]![0].prompts).toEqual({ points: [], box: { left: 0.2, top: 0.2, right: 0.8, bottom: 0.8 } });
    fireEvent.click(screen.getByRole("button", { name: "目标点" }));
    fireEvent.pointerDown(image, { clientX: 200, clientY: 100, button: 0 });
    expect(screen.getByTestId("task-review-media-error").textContent).toContain("提示上限为 2");
    expect(screen.queryAllByTestId("task-review-media-point")).toHaveLength(0);
    expect(operations.segmentMedia).toHaveBeenCalledTimes(1);
  });

  it("accepts a labeled region without making a human review decision", async () => {
    const { operations, picture, onOpenUnit, onDecide } = setup();
    fireEvent.pointerDown(await picture(), { clientX: 200, clientY: 100, button: 0 });
    const accept = await screen.findByTestId("task-review-media-accept");
    expect(accept).toBeDisabled();
    expect(screen.getByTestId("task-review-decide-kept")).toBeDisabled();
    fireEvent.click(screen.getByTestId("task-review-decide-kept"));
    expect(onDecide).not.toHaveBeenCalled();
    expect(operations.decide).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("区域标签"), { target: { value: "蓝色的鱼" } });
    fireEvent.click(accept);
    await waitFor(() => expect(onOpenUnit).toHaveBeenCalledWith("new-region"));
    expect(operations.acceptMediaRegion).toHaveBeenCalledWith(expect.objectContaining({ unitId: "image-unit", label: "蓝色的鱼" }));
    expect(onDecide).not.toHaveBeenCalled();
    expect(screen.queryByTestId("task-review-complete-request")).toBeNull();
  });

  it("saves and explicitly keeps only the returned new region in the primary action", async () => {
    const { picture, operations, onDecide, onOpenUnit } = setup();
    const viewport = screen.getByTestId("task-review-media-viewport");
    expect(viewport.style.height).toContain("65vh");
    fireEvent.pointerDown(await picture(), { clientX: 200, clientY: 100, button: 0 });
    const acceptKeep = await screen.findByRole("button", { name: "保存并保留此区域" });
    expect(viewport.style.height).toContain("48vh");
    expect(viewport.style.height).toContain("560px");
    expect(viewport.style.height).not.toContain("65vh");
    expect(screen.getByRole("button", { name: "仅保存区域" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "重新计算区域" })).toBeEnabled();
    fireEvent.change(screen.getByLabelText("区域标签"), { target: { value: "蓝色的鱼" } });
    expect(acceptKeep).toBeEnabled();
    fireEvent.click(acceptKeep);
    await waitFor(() => expect(onOpenUnit).toHaveBeenCalledWith("new-region"));
    expect(operations.decide).toHaveBeenCalledWith({ unitId: "new-region", sourceVersionId: "media-source", purpose: "review", status: "kept", note: "人工媒体意见" }, expect.any(Function));
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("reports a saved region with an unfinished decision rather than approving its parent on partial failure", async () => {
    const { picture, operations, onDecide, onOpenUnit, onReportError } = setup();
    operations.decide.mockResolvedValue({ ok: false, snapshot: null, error: "disk full" });
    fireEvent.pointerDown(await picture(), { clientX: 200, clientY: 100, button: 0 });
    await screen.findByTestId("task-review-media-accept-keep");
    fireEvent.change(screen.getByLabelText("区域标签"), { target: { value: "蓝色的鱼" } });
    fireEvent.click(screen.getByTestId("task-review-media-accept-keep"));
    await waitFor(() => expect(onReportError).toHaveBeenCalledWith(expect.stringContaining("区域已保存，判定未完成")));
    expect(onOpenUnit).toHaveBeenCalledWith("new-region");
    expect(onDecide).not.toHaveBeenCalled();
    expect(operations.decide.mock.calls[0]![0].unitId).toBe("new-region");
  });

  it("refuses the combined decision if the queued operation belongs to a changed task", async () => {
    const { picture, operations, onReportError, acceptedSnapshot } = setup();
    operations.decide.mockImplementation(async (_input, check) => {
      check?.({ ...acceptedSnapshot, taskId: "changed-task" });
      throw new Error("decision must not be reached");
    });
    fireEvent.pointerDown(await picture(), { clientX: 200, clientY: 100, button: 0 });
    await screen.findByTestId("task-review-media-accept-keep");
    fireEvent.change(screen.getByLabelText("区域标签"), { target: { value: "蓝色的鱼" } });
    fireEvent.click(screen.getByTestId("task-review-media-accept-keep"));
    await waitFor(() => expect(onReportError).toHaveBeenCalledWith(expect.stringContaining("任务、来源或判断口径已变化")));
  });

  it("opens a region as its real transparent cutout and uses the separate parent and mask when refining", async () => {
    const context = setup();
    await context.picture();
    const base = await context.operations.openMedia.mock.results[0]!.value as TaskMediaOpenResult;
    const region: TaskMediaUnit = { id: "region", sourceVersionId: "media-source", ordinal: 2, kind: "region", parentUnitId: "image-unit", maskAssetId: "mask", cutoutAssetId: "cutout", pixelRevision: "actual-pixels", width: 400, height: 200, label: "蓝色的鱼", modelVersion: "fixture-model", prompts: { points: [{ x: 0.5, y: 0.5, foreground: true }] } };
    const snapshot = { ...context.props.snapshot, units: [context.props.unit, region] };
    context.operations.openMedia.mockImplementation(async (target) => target.unitId === "region"
      ? { ...base, snapshot, unit: region, url: "app://reelterminal/task-media/task-1/cutout", cutoutUrl: "app://reelterminal/task-media/task-1/cutout", maskUrl: "app://reelterminal/task-media/task-1/mask" }
      : { ...base, snapshot });
    context.rerender(<MediaScene {...context.props} key={region.id} snapshot={snapshot} unit={region} draft={undefined} />);
    expect((await screen.findByTestId("task-review-region-cutout")).getAttribute("src")).toContain("/cutout");
    expect(screen.queryByTestId("task-review-media-mask")).toBeNull();
    expect(screen.getByTestId("task-review-media-status").textContent).toBe("待审");
    fireEvent.click(screen.getByTestId("task-review-region-view-toggle"));
    await screen.findByTestId("task-review-media-picture");
    expect(screen.getByTestId("task-review-media-mask").style.maskImage).toContain("/mask");
    expect(context.operations.segmentMedia).not.toHaveBeenCalled();
    expect(context.onDecide).not.toHaveBeenCalled();
  });

  it("freezes video through the service timestamp selection and pauses the real video element on leaving", async () => {
    const { operations, onOpenUnit, unmount } = setup("video");
    const video = await screen.findByTestId("task-review-media-video") as HTMLVideoElement;
    video.currentTime = 2.003;
    fireEvent.click(screen.getByTestId("task-review-freeze-frame"));
    await waitFor(() => expect(onOpenUnit).toHaveBeenCalledWith("real-frame"));
    expect(operations.captureMediaFrame).toHaveBeenCalledWith(expect.objectContaining({ selection: { timeSec: 2.003 } }));
    expect(operations.captureMediaFrame.mock.calls[0]![0]).not.toHaveProperty("frameIndex");
    unmount();
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    setup("video");
    const returned = await screen.findByTestId("task-review-media-video") as HTMLVideoElement;
    fireEvent.loadedMetadata(returned);
    expect(returned.currentTime).toBe(2.003);
    expect(returned.paused).toBe(true);
  });

  it("shows inference failure and preserves feedback instead of presenting a successful candidate", async () => {
    const { operations, picture, unmount } = setup();
    operations.segmentMedia.mockRejectedValue(new Error("model resources unavailable"));
    fireEvent.pointerDown(await picture(), { clientX: 200, clientY: 100, button: 0 });
    await waitFor(() => expect(screen.getByTestId("task-review-media-error").textContent).toContain("model resources unavailable"));
    expect(screen.queryByTestId("task-review-media-accept")).toBeNull();
    expect((screen.getByTestId("task-review-unit-note") as HTMLTextAreaElement).value).toBe("人工媒体意见");
    unmount();
    expect(operations.cancelMedia).toHaveBeenCalled();
  });
});
