import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
