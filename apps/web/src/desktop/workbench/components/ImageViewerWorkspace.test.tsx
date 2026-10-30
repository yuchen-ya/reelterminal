import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageViewerWorkspace } from "./ImageViewerWorkspace";
import type { ImageViewerWorkspaceProps } from "./ImageViewerWorkspace";
import type { WorkbenchItemView } from "../types";

if (typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    readonly pointerId: number;
    readonly pressure: number;

    constructor(type: string, init: MouseEventInit & { pointerId?: number; pressure?: number } = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pressure = init.pressure ?? 0;
    }
  }
  Object.defineProperty(window, "PointerEvent", {
    writable: true,
    configurable: true,
    value: PointerEventPolyfill,
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function imageItem(): WorkbenchItemView {
  return {
    id: "image-1",
    batchId: "batch-1",
    orderIndex: 0,
    title: "图像",
    subtitle: "",
    type: "image",
    version: 1,
    status: "pending",
    hasManualRevision: false,
    provenanceTags: [],
    userCategoryTags: [],
    feedbacks: [],
    imagePayload: {
      originalMedia: {
        mediaId: "media-1",
        url: "blob:test-image",
        status: "ready",
        thumbnailUrl: "blob:test-thumbnail",
        displayName: "test.png",
      },
      initialDisplayMode: "original",
      naturalWidth: 100,
      naturalHeight: 50,
      annotations: [],
      strokes: [],
    },
  };
}

function recordingCanvasContext(): {
  readonly context: CanvasRenderingContext2D;
  readonly operations: string[];
  readonly drawImage: ReturnType<typeof vi.fn>;
} {
  let compositeOperation: GlobalCompositeOperation = "source-over";
  const compositeStack: GlobalCompositeOperation[] = [];
  const operations: string[] = [];
  const drawImage = vi.fn();
  const context = {
    clearRect: vi.fn(() => operations.push("clear")),
    save: vi.fn(() => compositeStack.push(compositeOperation)),
    restore: vi.fn(() => {
      compositeOperation = compositeStack.pop() ?? "source-over";
    }),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(() => operations.push(`stroke:${compositeOperation}`)),
    fill: vi.fn(() => operations.push(`fill:${compositeOperation}`)),
    arc: vi.fn(),
    drawImage,
  } as unknown as CanvasRenderingContext2D;
  Object.defineProperty(context, "globalCompositeOperation", {
    configurable: true,
    get: () => compositeOperation,
    set: (value: GlobalCompositeOperation) => {
      compositeOperation = value;
    },
  });
  return { context, operations, drawImage };
}

async function mountRepairWorkspace(
  context: CanvasRenderingContext2D,
  onSaveImageRepair: ImageViewerWorkspaceProps["onSaveImageRepair"] = async () => ({
    ok: true as const,
  }),
): Promise<{ readonly image: HTMLImageElement; readonly surface: HTMLElement }> {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => context as never,
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const height = this.dataset.testid === "image-stage" ? 200 : 300;
    return new DOMRect(0, 0, 400, height);
  });

  const item = imageItem();
  render(
    <ImageViewerWorkspace
      currentItem={item}
      batchImageItems={[item]}
      selectedIds={[]}
      onSelectItem={vi.fn()}
      onUpdateImageAnnotations={vi.fn(async () => ({ ok: true as const }))}
      onSaveImageRepair={onSaveImageRepair}
      onCommitDecision={vi.fn(async () => ({ ok: true as const }))}
      issuePanelWidth={300}
    />,
  );

  const image = screen.getByAltText("test.png") as HTMLImageElement;
  Object.defineProperty(image, "naturalWidth", { configurable: true, value: 100 });
  Object.defineProperty(image, "naturalHeight", { configurable: true, value: 50 });
  Object.defineProperty(image, "complete", { configurable: true, value: true });
  fireEvent.load(image);
  await waitFor(() => expect(screen.getByTestId("image-stage")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("image-mode-repair"));
  await waitFor(() => expect(screen.getByTestId("image-stage-pointer-surface")).toBeInTheDocument());
  return { image, surface: screen.getByTestId("image-stage-pointer-surface") };
}

describe("ImageViewerWorkspace repair painting", () => {
  it("keeps a repair stroke owned by its initiating pointer", async () => {
    const context = {
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      fill: vi.fn(),
      arc: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => context as never,
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const height = this.dataset.testid === "image-stage" ? 200 : 300;
      return new DOMRect(0, 0, 400, height);
    });

    const item = imageItem();
    let submittedStrokes: Parameters<
      ImageViewerWorkspaceProps["onSaveImageRepair"]
    >[1] | undefined;
    const onSaveImageRepair: ImageViewerWorkspaceProps["onSaveImageRepair"] = async (
      _itemId,
      strokes,
    ) => {
      submittedStrokes = strokes;
      return { ok: true };
    };
    render(
      <ImageViewerWorkspace
        currentItem={item}
        batchImageItems={[item]}
        selectedIds={[]}
        onSelectItem={vi.fn()}
        onUpdateImageAnnotations={vi.fn(async () => ({ ok: true as const }))}
        onSaveImageRepair={onSaveImageRepair}
        onCommitDecision={vi.fn(async () => ({ ok: true as const }))}
        issuePanelWidth={300}
      />,
    );

    const image = screen.getByAltText("test.png");
    Object.defineProperty(image, "naturalWidth", { configurable: true, value: 100 });
    Object.defineProperty(image, "naturalHeight", { configurable: true, value: 50 });
    fireEvent.load(image);
    await waitFor(() => expect(screen.getByTestId("image-stage")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("image-mode-repair"));
    await waitFor(() => expect(screen.getByTestId("image-stage-pointer-surface")).toBeInTheDocument());
    const surface = screen.getByTestId("image-stage-pointer-surface");

    fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 40, clientY: 40 });

    fireEvent.pointerDown(surface, { button: 0, pointerId: 2, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(surface, { pointerId: 2, clientX: 240, clientY: 120 });
    fireEvent.pointerUp(surface, { pointerId: 2, clientX: 240, clientY: 120 });
    fireEvent.pointerCancel(surface, { pointerId: 2 });
    expect(screen.getByTestId("image-mode-repair")).toHaveTextContent("画笔修补 (0)");

    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 60, clientY: 60 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 60, clientY: 60 });
    await waitFor(() =>
      expect(screen.getByTestId("image-mode-repair")).toHaveTextContent("画笔修补 (1)"),
    );

    fireEvent.click(screen.getByRole("button", { name: /保存修补/ }));
    await waitFor(() => expect(submittedStrokes).toHaveLength(1));
    expect(submittedStrokes?.[0]?.points.map(({ x, y }) => ({ x, y }))).toEqual([
      { x: 5, y: 5 },
      { x: 10, y: 10 },
      { x: 15, y: 15 },
    ]);
  });

  it("cancels only the owning pointer's unfinished repair stroke", async () => {
    const { context, operations } = recordingCanvasContext();
    let submittedStrokes: Parameters<
      ImageViewerWorkspaceProps["onSaveImageRepair"]
    >[1] | undefined;
    const onSaveImageRepair: ImageViewerWorkspaceProps["onSaveImageRepair"] = async (
      _itemId,
      strokes,
    ) => {
      submittedStrokes = strokes;
      return { ok: true };
    };
    const { surface } = await mountRepairWorkspace(context, onSaveImageRepair);

    fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 40, clientY: 40 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 40, clientY: 40 });
    await waitFor(() =>
      expect(screen.getByTestId("image-mode-repair")).toHaveTextContent("画笔修补 (1)"),
    );

    fireEvent.pointerDown(surface, { button: 0, pointerId: 2, clientX: 80, clientY: 20 });
    fireEvent.pointerMove(surface, { pointerId: 2, clientX: 120, clientY: 40 });
    fireEvent.pointerCancel(surface, { pointerId: 2 });
    expect(operations.slice(-2)).toEqual(["clear", "stroke:source-over"]);

    fireEvent.pointerMove(surface, { pointerId: 2, clientX: 160, clientY: 60 });
    fireEvent.pointerUp(surface, { pointerId: 2, clientX: 160, clientY: 60 });
    expect(screen.getByTestId("image-mode-repair")).toHaveTextContent("画笔修补 (1)");

    fireEvent.click(screen.getByRole("button", { name: /保存修补/ }));
    await waitFor(() => expect(submittedStrokes).toHaveLength(1));
    expect(submittedStrokes?.[0]?.points).toHaveLength(2);
  });

  it("rebuilds erasing and undo from the retained strokes and exports that stroke list", async () => {
    const { context, operations, drawImage } = recordingCanvasContext();
    let submittedStrokes: Parameters<
      ImageViewerWorkspaceProps["onSaveImageRepair"]
    >[1] | undefined;
    let exportedBlob: Blob | null = null;
    const onSaveImageRepair: ImageViewerWorkspaceProps["onSaveImageRepair"] = async (
      _itemId,
      strokes,
      renderPatchedImage,
    ) => {
      submittedStrokes = strokes;
      exportedBlob = await renderPatchedImage();
      return { ok: true };
    };
    const { image, surface } = await mountRepairWorkspace(context, onSaveImageRepair);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
      callback(new Blob(["png"], { type: "image/png" }));
    });

    fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 40, clientY: 40 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 40, clientY: 40 });
    await waitFor(() =>
      expect(screen.getByTestId("image-mode-repair")).toHaveTextContent("画笔修补 (1)"),
    );

    fireEvent.click(screen.getByTitle("橡皮擦(仅擦除修补层)"));
    fireEvent.pointerDown(surface, { button: 0, pointerId: 2, clientX: 80, clientY: 20 });
    fireEvent.pointerMove(surface, { pointerId: 2, clientX: 120, clientY: 40 });
    fireEvent.pointerUp(surface, { pointerId: 2, clientX: 120, clientY: 40 });
    await waitFor(() =>
      expect(screen.getByTestId("image-mode-repair")).toHaveTextContent("画笔修补 (2)"),
    );
    expect(operations.slice(-3)).toEqual([
      "clear",
      "stroke:source-over",
      "stroke:destination-out",
    ]);

    fireEvent.click(screen.getByTitle("撤销上一笔(未提交草稿)"));
    await waitFor(() =>
      expect(screen.getByTestId("image-mode-repair")).toHaveTextContent("画笔修补 (1)"),
    );
    expect(operations.slice(-2)).toEqual(["clear", "stroke:source-over"]);

    fireEvent.click(screen.getByRole("button", { name: /保存修补/ }));
    await waitFor(() => expect(submittedStrokes).toHaveLength(1));
    expect(submittedStrokes?.[0]?.tool).toBe("brush");
    expect(exportedBlob).toMatchObject({ type: "image/png" });
    expect(drawImage).toHaveBeenCalledTimes(2);
    expect(drawImage.mock.calls[0]?.[0]).toBe(image);
    expect(drawImage.mock.calls[1]?.[0]).toBeInstanceOf(HTMLCanvasElement);
  });

  it("paints each pointer segment without clearing and replaying the canvas", async () => {
    const context = {
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      fill: vi.fn(),
      arc: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => context as never,
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const height = this.dataset.testid === "image-stage" ? 200 : 300;
      return new DOMRect(0, 0, 400, height);
    });

    const item = imageItem();
    render(
      <ImageViewerWorkspace
        currentItem={item}
        batchImageItems={[item]}
        selectedIds={[]}
        onSelectItem={vi.fn()}
        onUpdateImageAnnotations={vi.fn(async () => ({ ok: true as const }))}
        onSaveImageRepair={vi.fn(async () => ({ ok: true as const }))}
        onCommitDecision={vi.fn(async () => ({ ok: true as const }))}
        issuePanelWidth={300}
      />,
    );

    const image = screen.getByAltText("test.png");
    Object.defineProperty(image, "naturalWidth", { configurable: true, value: 100 });
    Object.defineProperty(image, "naturalHeight", { configurable: true, value: 50 });
    fireEvent.load(image);
    await waitFor(() => expect(screen.getByTestId("image-stage")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("image-mode-repair"));
    await waitFor(() => expect(screen.getByTestId("image-stage-pointer-surface")).toBeInTheDocument());
    const surface = screen.getByTestId("image-stage-pointer-surface");
    const baselineClearCount = vi.mocked(context.clearRect).mock.calls.length;
    const baselineStrokeCount = vi.mocked(context.stroke).mock.calls.length;

    fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 20, clientY: 20 });
    const pointerMoves = 40;
    for (let index = 1; index <= pointerMoves; index += 1) {
      fireEvent.pointerMove(surface, {
        pointerId: 1,
        clientX: 20 + index * 4,
        clientY: 20 + index * 4,
      });
    }

    expect(vi.mocked(context.clearRect)).toHaveBeenCalledTimes(baselineClearCount);
    expect(vi.mocked(context.stroke)).toHaveBeenCalledTimes(baselineStrokeCount + pointerMoves);
    expect(screen.getByTestId("image-mode-repair")).toHaveTextContent("画笔修补 (0)");

    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 180, clientY: 180 });
    await waitFor(() =>
      expect(screen.getByTestId("image-mode-repair")).toHaveTextContent("画笔修补 (1)"),
    );
    expect(vi.mocked(context.clearRect)).toHaveBeenCalledTimes(baselineClearCount + 1);
  });
});

it("draws inside an existing box, selects on click and deletes to the adjacent issue", async () => {
  const { context } = recordingCanvasContext();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => context as never);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 200));
  const base = imageItem();
  const item = { ...base, imagePayload: { ...base.imagePayload!, annotations: [
    { id: "large", color: "#f43f5e", tool: "box" as const, x: 0.1, y: 0.1, w: 0.8, h: 0.8, label: "大框" },
    { id: "next", color: "#f43f5e", tool: "box" as const, x: 0.7, y: 0.7, w: 0.1, h: 0.1, label: "相邻问题" },
  ] } };
  const onUpdate = vi.fn(async () => ({ ok: true as const }));
  render(<ImageViewerWorkspace currentItem={item} batchImageItems={[item]} selectedIds={[]}
    onSelectItem={vi.fn()} onUpdateImageAnnotations={onUpdate}
    onSaveImageRepair={vi.fn(async () => ({ ok: true as const }))}
    onCommitDecision={vi.fn(async () => ({ ok: true as const }))} issuePanelWidth={300} />);
  const image = screen.getByAltText("test.png");
  Object.defineProperty(image, "naturalWidth", { value: 100 });
  Object.defineProperty(image, "naturalHeight", { value: 50 });
  fireEvent.load(image);
  const surface = await screen.findByTestId("image-stage-pointer-surface");
  fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 80, clientY: 40 });
  fireEvent.pointerMove(surface, { pointerId: 1, clientX: 160, clientY: 80 });
  fireEvent.pointerUp(surface, { pointerId: 1, clientX: 160, clientY: 80 });
  await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
  expect(onUpdate.mock.calls[0]).toEqual(expect.arrayContaining([expect.arrayContaining([
    expect.objectContaining({ tool: "box", x: 0.2, y: 0.2, w: 0.2, h: 0.2 }),
  ])]));
  fireEvent.pointerDown(surface, { button: 0, pointerId: 2, clientX: 80, clientY: 40 });
  fireEvent.pointerUp(surface, { pointerId: 2, clientX: 80, clientY: 40 });
  expect(screen.getByLabelText("问题建议")).toHaveValue("大框");
  fireEvent.keyDown(screen.getByLabelText("问题建议"), { key: "Backspace" });
  expect(onUpdate).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(surface, { key: "Delete" });
  await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByLabelText("问题建议")).toHaveValue("相邻问题"));
});

function repairedItem(version: number, status: "loading" | "ready" | "error" = "ready"): WorkbenchItemView {
  const item = imageItem();
  return { ...item, version, imagePayload: { ...item.imagePayload!, initialDisplayMode: "repaired",
    repair: { revisionId: `revision-${version}`, mediaId: `repair-${version}`, producedVersion: version },
    repairMedia: { mediaId: `repair-${version}`, status, url: status === "ready" ? `blob:repair-${version}` : null,
      displayName: "repair.png", thumbnailUrl: null, ...(status === "error" ? { error: "cannot read file" } : {}) },
  } };
}

function renderUpdatingImage(initial: WorkbenchItemView) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 200));
  const props = { selectedIds: [], onSelectItem: vi.fn(), onUpdateImageAnnotations: vi.fn(async () => ({ ok: true as const })),
    onSaveImageRepair: vi.fn(async () => ({ ok: true as const })), onCommitDecision: vi.fn(async () => ({ ok: true as const })), issuePanelWidth: 300 };
  const view = (item: WorkbenchItemView) => <ImageViewerWorkspace {...props} currentItem={item} batchImageItems={[item]} />;
  const mounted = render(view(initial));
  return { ...mounted, update: (item: WorkbenchItemView) => mounted.rerender(view(item)) };
}

function loadImage(image: HTMLImageElement) {
  Object.defineProperty(image, "naturalWidth", { configurable: true, value: 100 });
  Object.defineProperty(image, "naturalHeight", { configurable: true, value: 50 });
  fireEvent.load(image);
}

it("keeps the decoded frame and focused viewport until the first repair decodes, then preserves an explicit original choice", async () => {
  const { update } = renderUpdatingImage(imageItem());
  loadImage(screen.getByTestId("image-stage-pending-image") as HTMLImageElement);
  const original = await screen.findByTestId("image-stage-image");
  const stage = screen.getByTestId("image-stage");
  const surface = screen.getByTestId("image-stage-pointer-surface");
  fireEvent.wheel(surface, { deltaY: -1 });
  surface.focus();
  let transform = stage.style.transform;

  update(repairedItem(2, "loading"));
  expect(screen.getByTestId("image-stage-image")).toBe(original);
  expect(screen.getByTestId("image-update-status")).toHaveTextContent("正在载入");
  expect(stage.style.transform).toBe(transform);
  expect(document.activeElement).toBe(surface);
  // Navigation uses the retained frame, even while writes await the new image.
  fireEvent.pointerDown(surface, { button: 1, pointerId: 10, clientX: 20, clientY: 20 });
  fireEvent.pointerMove(surface, { pointerId: 10, clientX: 45, clientY: 35 });
  fireEvent.pointerUp(surface, { pointerId: 10, clientX: 45, clientY: 35 });
  expect(stage.style.transform).toContain("translate(25px, 15px)");
  fireEvent.wheel(surface, { deltaY: -1 });
  expect(stage.style.transform).toContain("scale(1.4)");
  transform = stage.style.transform;

  update(repairedItem(2));
  const pending = screen.getByTestId("image-stage-pending-image") as HTMLImageElement;
  let finishDecode!: () => void;
  Object.defineProperty(pending, "decode", { value: () => new Promise<void>(resolve => { finishDecode = resolve; }) });
  loadImage(pending);
  expect(screen.getByTestId("image-stage-image")).toBe(original);
  await act(async () => finishDecode());
  expect(screen.getByTestId("image-stage-image")).toBe(pending);
  expect(pending).toHaveAttribute("data-display-mode", "repaired");
  expect(stage.style.transform).toBe(transform);
  expect(screen.getByTestId("image-stage-pointer-surface")).toBe(surface);
  expect(document.activeElement).toBe(surface);

  fireEvent.click(screen.getByTestId("image-display-original"));
  loadImage(screen.getByTestId("image-stage-pending-image") as HTMLImageElement);
  await waitFor(() => expect(screen.getByTestId("image-stage-image")).toHaveAttribute("data-display-mode", "original"));
  const selectedOriginal = screen.getByTestId("image-stage-image");
  update(repairedItem(3));
  expect(screen.getByTestId("image-stage-image")).toBe(selectedOriginal);
  expect(screen.queryByTestId("image-stage-pending-image")).toBeNull();
  expect(screen.queryByTestId("image-update-status")).toBeNull();
});

it("discards superseded decodes and reports a failed replacement while keeping the previous frame", async () => {
  const { update } = renderUpdatingImage(repairedItem(2));
  loadImage(screen.getByTestId("image-stage-pending-image") as HTMLImageElement);
  const previous = await screen.findByTestId("image-stage-image");
  update(repairedItem(3));
  const pending = screen.getByTestId("image-stage-pending-image") as HTMLImageElement;
  let finishDecode!: () => void;
  Object.defineProperty(pending, "decode", { value: () => new Promise<void>(resolve => { finishDecode = resolve; }) });
  loadImage(pending);
  update(repairedItem(4));
  await act(async () => finishDecode());
  expect(screen.getByTestId("image-stage-image")).toBe(previous);
  fireEvent.error(screen.getByTestId("image-stage-pending-image"));
  expect(screen.getByTestId("image-stage-image")).toBe(previous);
  expect(screen.getByTestId("image-update-status")).toHaveTextContent("新版本未载入");
  expect(previous).toHaveAttribute("data-display-mode", "repaired");
  update(repairedItem(5, "error"));
  expect(screen.getByTestId("image-stage-image")).toBe(previous);
  expect(screen.getByRole("alert")).toHaveTextContent("cannot read file");
});

it.each(["item", "source"] as const)("never retains an old image across a different %s", async change => {
  const { update } = renderUpdatingImage(imageItem());
  loadImage(screen.getByTestId("image-stage-pending-image") as HTMLImageElement);
  await screen.findByTestId("image-stage-image");
  const next = imageItem();
  update(change === "item" ? { ...next, id: "another-item" } : { ...next, version: 2,
    imagePayload: { ...next.imagePayload!, originalMedia: { ...next.imagePayload!.originalMedia, mediaId: "replacement", url: "blob:replacement" } } });
  expect(screen.queryByTestId("image-stage-image")).toBeNull();
  expect(screen.queryByTestId("image-stage-pointer-surface")).toBeNull();
});

it("retries a failed image after leaving and returning to its item without remounting the workspace", async () => {
  const item = repairedItem(2);
  const { update } = renderUpdatingImage(item);
  fireEvent.error(screen.getByTestId("image-stage-pending-image"));
  expect(screen.getByText("图片解码失败")).toBeInTheDocument();
  update({ ...imageItem(), id: "another-item" });
  update(item);
  const retry = screen.getByTestId("image-stage-pending-image") as HTMLImageElement;
  loadImage(retry);
  await waitFor(() => expect(screen.getByTestId("image-stage-image")).toBe(retry));
  expect(screen.queryByTestId("image-update-status")).toBeNull();
});

it("requires the remounted image to decode when returning through an item that never became ready", async () => {
  const item = imageItem();
  const { update } = renderUpdatingImage(item);
  loadImage(screen.getByTestId("image-stage-pending-image") as HTMLImageElement);
  const initial = await screen.findByTestId("image-stage-image");
  update({ ...item, id: "another-item" });
  expect(screen.queryByTestId("image-stage-image")).toBeNull();
  update(item);
  expect(screen.queryByTestId("image-stage-image")).toBeNull();
  expect(screen.queryByTestId("image-stage-pointer-surface")).toBeNull();
  const returning = screen.getByTestId("image-stage-pending-image") as HTMLImageElement;
  expect(returning).not.toBe(initial);
  let finishDecode!: () => void;
  Object.defineProperty(returning, "decode", { value: () => new Promise<void>(resolve => { finishDecode = resolve; }) });
  loadImage(returning);
  expect(screen.queryByTestId("image-stage-image")).toBeNull();
  await act(async () => finishDecode());
  expect(screen.getByTestId("image-stage-image")).toBe(returning);
});
