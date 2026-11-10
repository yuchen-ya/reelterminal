import { useChineseReviewLocale } from "../../../test/review-locale";
import {
  act,
  within,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FolderReviewWorkspace } from "./FolderReviewWorkspace";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("opens media on a tree double click or Enter while video controls keep their own double-click events", async () => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const entries = [
    { id: "picture", relativePath: "fish.png", kind: "file" as const, size: 100, mtimeMs: 1, review: { status: "pending" as const, note: "" } },
    { id: "movie", relativePath: "clip.mp4", kind: "file" as const, size: 100, mtimeMs: 1, review: { status: "pending" as const, note: "" } },
  ];
  const snapshot = { root: "task", taskId: "task-id", revision: 1, entries };
  const onOpenMedia = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, "reelterminal", { configurable: true, value: { folderReview: {
    open: vi.fn().mockResolvedValue(snapshot), refresh: vi.fn().mockResolvedValue(snapshot),
    preview: vi.fn().mockImplementation(async ({ id }: { id: string }) => ({ kind: id === "movie" ? "video" : "image", url: `app://preview/${id}` })),
  } } });
  render(<FolderReviewWorkspace root="task" mode="files" onOpenMedia={onOpenMedia} />);
  fireEvent.doubleClick(await screen.findByText("fish.png"));
  expect(onOpenMedia).toHaveBeenCalledWith("picture");
  const movie = screen.getByText("clip.mp4").closest('[role="treeitem"]')!;
  fireEvent.keyDown(movie, { key: "Enter" });
  expect(onOpenMedia).toHaveBeenLastCalledWith("movie");
  const video = await screen.findByTestId("folder-review-preview-video");
  fireEvent.doubleClick(video);
  expect(onOpenMedia).toHaveBeenCalledTimes(2);
});

it("applies a filtered selection only to visible files and keeps a failed note draft", async () => {
  const snapshot = {
    root: "task",
    taskId: "task-id",
    revision: 1,
    entries: [
      {
        id: "a",
        relativePath: "a.txt",
        kind: "file" as const,
        size: 1,
        mtimeMs: 1,
        review: { status: "pending" as const, note: "" },
      },
      {
        id: "b",
        relativePath: "b.txt",
        kind: "file" as const,
        size: 1,
        mtimeMs: 1,
        review: { status: "kept" as const, note: "" },
      },
    ],
  };
  const review = vi.fn().mockRejectedValue(new Error("write failed"));
  Object.defineProperty(window, "reelterminal", {
    configurable: true,
    value: {
      folderReview: {
        open: vi.fn().mockResolvedValue(snapshot),
        refresh: vi.fn().mockResolvedValue(snapshot),
        preview: vi.fn().mockResolvedValue({ kind: "text", text: "hello" }),
        review,
      },
    },
  });
  render(<FolderReviewWorkspace root="task" />);
  const a = await screen.findByText("a.txt");
  fireEvent.click(screen.getByText("b.txt"));
  fireEvent.click(a, { ctrlKey: true });
  fireEvent.change(screen.getByLabelText("审阅结果筛选"), {
    target: { value: "pending" },
  });
  const note = screen.getByLabelText("审阅备注") as HTMLTextAreaElement;
  fireEvent.change(note, { target: { value: "draft" } });
  fireEvent.click(screen.getByRole("button", { name: "采用" }));
  await waitFor(() =>
    expect(review).toHaveBeenCalledWith({
      root: "task",
      expectedRevision: 1,
      ids: ["a"],
      status: "kept",
      note: "draft",
    }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("write failed");
  expect(note.value).toBe("draft");
});

it("saves a draft before switching and rejects switching when saving fails", async () => {
  const snapshot = {
    root: "task",
    taskId: "task-id",
    revision: 1,
    entries: [
      {
        id: "a",
        relativePath: "a.txt",
        kind: "file" as const,
        size: 1,
        mtimeMs: 1,
        review: { status: "pending" as const, note: "" },
      },
    ],
  };
  const review = vi
    .fn()
    .mockRejectedValueOnce(new Error("disk unavailable"))
    .mockResolvedValueOnce({
      snapshot: { ...snapshot, revision: 2 },
      results: [],
    });
  Object.defineProperty(window, "reelterminal", {
    configurable: true,
    value: {
      folderReview: {
        open: vi.fn().mockResolvedValue(snapshot),
        refresh: vi.fn().mockResolvedValue(snapshot),
        preview: vi.fn().mockResolvedValue({ kind: "text", text: "hello" }),
        review,
      },
    },
  });
  let flush: () => Promise<void> = async () => {};
  render(
    <FolderReviewWorkspace
      root="task"
      onFlush={(callback) => {
        flush = callback;
      }}
    />,
  );
  fireEvent.click(await screen.findByText("a.txt"));
  fireEvent.change(screen.getByLabelText("审阅备注"), {
    target: { value: "unsaved" },
  });
  await expect(flush()).rejects.toThrow("disk unavailable");
  expect((screen.getByLabelText("审阅备注") as HTMLTextAreaElement).value).toBe(
    "unsaved",
  );
  await expect(flush()).resolves.toBeUndefined();
  expect(review).toHaveBeenLastCalledWith({
    root: "task",
    expectedRevision: 1,
    ids: ["a"],
    status: "pending",
    note: "unsaved",
  });
});

it("automatically saves a note without leaving the current file", async () => {
  const snapshot = {
    root: "task",
    taskId: "task-id",
    revision: 1,
    entries: [
      {
        id: "a",
        relativePath: "a.txt",
        kind: "file" as const,
        size: 1,
        mtimeMs: 1,
        review: { status: "pending" as const, note: "" },
      },
    ],
  };
  const review = vi
    .fn()
    .mockResolvedValue({ snapshot: { ...snapshot, revision: 2 }, results: [] });
  Object.defineProperty(window, "reelterminal", {
    configurable: true,
    value: {
      folderReview: {
        open: vi.fn().mockResolvedValue(snapshot),
        refresh: vi.fn().mockResolvedValue(snapshot),
        preview: vi.fn().mockResolvedValue({ kind: "text", text: "hello" }),
        review,
      },
    },
  });
  render(<FolderReviewWorkspace root="task" />);
  fireEvent.click(await screen.findByText("a.txt"));
  fireEvent.change(screen.getByLabelText("审阅备注"), {
    target: { value: "saved automatically" },
  });
  await waitFor(
    () =>
      expect(review).toHaveBeenCalledWith({
        root: "task",
        expectedRevision: 1,
        ids: ["a"],
        status: "pending",
        note: "saved automatically",
      }),
    { timeout: 2000 },
  );
  expect(screen.getByText("已保存")).toBeInTheDocument();
});

it("prepares the dragged selection and cancels preparation if the pointer is released first", async () => {
  const entries = ["a", "b", "c"].map((id) => ({
    id, relativePath: `${id}.txt`, kind: "file" as const, size: 1, mtimeMs: 1,
    review: { status: "pending" as const, note: "" },
  }));
  const snapshot = { root: "task", taskId: "task-id", revision: 1, entries };
  let finishPreparation!: (token: string) => void;
  let finishEscapedPreparation!: (token: string) => void;
  const prepareDrag = vi.fn().mockImplementationOnce(() => new Promise<string>((resolve) => { finishPreparation = resolve; }))
    .mockResolvedValueOnce("second-token")
    .mockImplementationOnce(() => new Promise<string>((resolve) => { finishEscapedPreparation = resolve; }))
    .mockRejectedValueOnce(new Error("prepare failed"));
  const cancelDrag = vi.fn();
  const startDrag = vi.fn().mockResolvedValue(undefined);
  const transfer = vi.fn().mockResolvedValue({ snapshot, results: [] });
  Object.defineProperty(window, "reelterminal", { configurable: true, value: { folderReview: {
    open: vi.fn().mockResolvedValue(snapshot), refresh: vi.fn().mockResolvedValue(snapshot),
    preview: vi.fn().mockResolvedValue({ kind: "text", text: "" }), prepareDrag, cancelDrag, startDrag, transfer,
  } } });
  render(<FolderReviewWorkspace root="task" />);
  const a = await screen.findByText("a.txt");
  const b = screen.getByText("b.txt");
  fireEvent.click(a);
  fireEvent.click(b, { ctrlKey: true });
  const tree = screen.getByTestId("folder-review-tree");
  vi.spyOn(tree, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 100, bottom: 100 } as DOMRect);
  const row = a.closest('[role="treeitem"]') as HTMLElement;
  row.setPointerCapture = vi.fn();
  row.hasPointerCapture = vi.fn().mockReturnValue(true);
  row.releasePointerCapture = vi.fn();
  const pointer = (target: HTMLElement, type: string, x: number, buttons: number) => {
    const event = new MouseEvent(type, { bubbles: true, button: 0, buttons, clientX: x, clientY: 10 });
    Object.defineProperty(event, "pointerId", { value: 1 });
    fireEvent(target, event);
  };
  pointer(row, "pointerdown", 10, 1);
  expect(prepareDrag).toHaveBeenCalledWith({ root: "task", ids: ["a", "b"] });
  pointer(row, "pointermove", 110, 1);
  pointer(row, "pointerup", 110, 0);
  finishPreparation("first-token");
  await waitFor(() => expect(cancelDrag).toHaveBeenCalledWith("first-token"));
  expect(startDrag).not.toHaveBeenCalled();
  const c = screen.getByText("c.txt").closest('[role="treeitem"]') as HTMLElement;
  c.setPointerCapture = vi.fn();
  c.hasPointerCapture = vi.fn().mockReturnValue(true);
  c.releasePointerCapture = vi.fn();
  pointer(c, "pointerdown", 10, 1);
  expect(prepareDrag).toHaveBeenLastCalledWith({ root: "task", ids: ["c"] });
  await waitFor(() => expect(prepareDrag).toHaveBeenCalledTimes(2));
  pointer(c, "pointermove", 110, 1);
  await waitFor(() => expect(startDrag).toHaveBeenCalledWith("second-token"));
  pointer(c, "pointerdown", 10, 1);
  pointer(c, "pointermove", 110, 1);
  fireEvent.keyDown(window, { key: "Escape" });
  finishEscapedPreparation("escaped-token");
  await waitFor(() => expect(cancelDrag).toHaveBeenCalledWith("escaped-token"));
  expect(startDrag).toHaveBeenCalledTimes(1);
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => tree });
  pointer(c, "pointerdown", 10, 1);
  await waitFor(() => expect(prepareDrag).toHaveBeenCalledTimes(4));
  pointer(c, "pointermove", 30, 1);
  pointer(c, "pointerup", 30, 0);
  await waitFor(() => expect(transfer).toHaveBeenCalledWith({ root: "task", expectedRevision: 1, ids: ["c"], destination: "", copy: false }));
  expect(startDrag).toHaveBeenCalledTimes(1);
});

it("file-management mode keeps real file operations and hides every legacy review entry", async () => {
  const snapshot = {
    root: "task",
    taskId: "task-id",
    revision: 1,
    entries: [
      {
        id: "a",
        relativePath: "a.txt",
        kind: "file" as const,
        size: 1,
        mtimeMs: 1,
        review: { status: "pending" as const, note: "" },
      },
    ],
  };
  const review = vi.fn();
  const bridgeMocks = {
    open: vi.fn().mockResolvedValue(snapshot),
    refresh: vi.fn().mockResolvedValue(snapshot),
    preview: vi.fn().mockResolvedValue({ kind: "text", text: "hello" }),
    review,
    transfer: vi.fn().mockResolvedValue({ snapshot, results: [] }),
  };
  Object.defineProperty(window, "reelterminal", {
    configurable: true,
    value: { folderReview: bridgeMocks },
  });
  render(<FolderReviewWorkspace root="task" mode="files" />);
  const host = await screen.findByTestId("folder-review-workspace");
  expect(host).toHaveAttribute("data-mode", "files");
  // The task domain owns decisions: no file-level verdicts, notes or filters.
  expect(screen.queryByLabelText("审阅备注")).toBeNull();
  expect(screen.queryByLabelText("审阅结果筛选")).toBeNull();
  for (const label of ["采用", "返工", "不采用", "保存备注"]) {
    expect(screen.queryByRole("button", { name: label })).toBeNull();
  }
  expect(host.textContent).not.toContain("已审");
  expect(screen.getByText("选择左侧文件预览内容")).toBeTruthy();
  // Genuine file management stays: search, create, rename task, reveal,
  // refresh, select, move/copy and preview.
  expect(screen.getByLabelText("搜索文件")).toBeTruthy();
  expect(screen.getByRole("button", { name: "新建文件夹" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "重命名任务" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "打开位置" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "刷新" })).toBeTruthy();
  fireEvent.click(screen.getByText("a.txt"));
  expect(screen.getByRole("button", { name: "在文件夹中显示" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "移动到" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "复制到" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "复制到外部…" })).toBeTruthy();
  expect(await screen.findByText("hello")).toBeTruthy();
  expect(screen.getByRole("treeitem", { selected: true })).toBeTruthy();
  // Selecting a file never writes a legacy review record.
  expect(review).not.toHaveBeenCalled();
});

it("pauses polling and preview media while covered and restores selection on return", async () => {
  const snapshot = {
    root: "task",
    taskId: "task-id",
    revision: 1,
    entries: [
      {
        id: "a",
        relativePath: "clip.mp4",
        kind: "file" as const,
        size: 1,
        mtimeMs: 1,
        review: { status: "pending" as const, note: "" },
      },
    ],
  };
  const refresh = vi.fn().mockResolvedValue(snapshot);
  Object.defineProperty(window, "reelterminal", {
    configurable: true,
    value: {
      folderReview: {
        open: vi.fn().mockResolvedValue(snapshot),
        refresh,
        preview: vi.fn().mockResolvedValue({ kind: "video", url: "blob:clip" }),
      },
    },
  });
  vi.useFakeTimers();
  const { rerender } = render(
    <FolderReviewWorkspace root="task" mode="files" sceneVisible={false} />,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  screen.getByText("clip.mp4");
  // A covered scene does no background work at all.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(7000);
  });
  expect(refresh).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("clip.mp4"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const video = screen.getByTestId("folder-review-preview-video") as HTMLVideoElement;
  const pause = vi.spyOn(video, "pause").mockImplementation(() => undefined);
  // Returning catches external file changes up exactly once, then polls.
  rerender(<FolderReviewWorkspace root="task" mode="files" sceneVisible={true} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(refresh).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(refresh).toHaveBeenCalledTimes(2);
  pause.mockRestore();
  // Covering the scene again pauses the still-open media element.
  const pauseAgain = vi
    .spyOn(video, "pause")
    .mockImplementation(() => undefined);
  rerender(<FolderReviewWorkspace root="task" mode="files" sceneVisible={false} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(pauseAgain).toHaveBeenCalledTimes(1);
  pauseAgain.mockRestore();
  // The directory position survives the round trip for instant return.
  rerender(<FolderReviewWorkspace root="task" mode="files" sceneVisible={true} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(
    within(screen.getByTestId("folder-review-tree"))
      .getByText("clip.mp4")
      .closest('[role="treeitem"]'),
  ).toHaveAttribute("aria-selected", "true");
});

it("opens right click context menu on row, reveals in folder, and trashes selected files", async () => {
  const snapshot = {
    root: "task",
    taskId: "task-id",
    revision: 1,
    entries: [
      { id: "file-1", relativePath: "doc.txt", kind: "file" as const, size: 10, mtimeMs: 1, review: { status: "pending" as const, note: "" } },
      { id: "file-2", relativePath: "image.png", kind: "file" as const, size: 20, mtimeMs: 1, review: { status: "pending" as const, note: "" } },
    ],
  };
  const showInFolder = vi.fn().mockResolvedValue(undefined);
  const trash = vi.fn().mockResolvedValue({
    ...snapshot,
    revision: 2,
    entries: [snapshot.entries[1]],
  });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  Object.defineProperty(window, "reelterminal", {
    configurable: true,
    value: {
      folderReview: {
        open: vi.fn().mockResolvedValue(snapshot),
        refresh: vi.fn().mockResolvedValue(snapshot),
        preview: vi.fn().mockResolvedValue({ kind: "text", text: "doc" }),
        showInFolder,
        trash,
      },
    },
  });

  render(<FolderReviewWorkspace root="task" mode="files" />);
  const row = (await screen.findByText("doc.txt")).closest('[role="treeitem"]')!;
  fireEvent.contextMenu(row);

  const menu = screen.getByRole("menu");
  expect(menu).toBeInTheDocument();
  expect(within(menu).getByText("在文件夹中显示")).toBeInTheDocument();
  expect(within(menu).getByText("重命名")).toBeInTheDocument();
  expect(within(menu).getByText("移入回收站")).toBeInTheDocument();

  fireEvent.click(within(menu).getByText("在文件夹中显示"));
  expect(showInFolder).toHaveBeenCalledWith({ root: "task", id: "file-1" });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();

  // Test row trash via context menu
  fireEvent.contextMenu(row);
  fireEvent.click(within(screen.getByRole("menu")).getByText("移入回收站"));
  await waitFor(() => {
    expect(trash).toHaveBeenCalledWith({ root: "task", ids: ["file-1"] });
  });

  // Test action bar "移入回收站" button
  const imageRow = screen.getByText("image.png").closest('[role="treeitem"]')!;
  fireEvent.click(imageRow);
  const trashBtn = screen.getByRole("button", { name: "移入回收站" });
  fireEvent.click(trashBtn);
  await waitFor(() => {
    expect(trash).toHaveBeenCalledWith({ root: "task", ids: ["file-2"] });
  });
});

useChineseReviewLocale();
