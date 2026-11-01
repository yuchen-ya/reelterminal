import { expect, it, vi } from "vitest";
import path from "node:path";
import { pathToFileURL } from "node:url";

const native = vi.hoisted(() => {
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  const navigation = new Map<string, (event: { url: string; preventDefault: () => void }) => void>();
  const beforeRequest = vi.fn();
  const contents = { on: vi.fn((name, listener) => navigation.set(name, listener)), setWindowOpenHandler: vi.fn(),
    loadFile: vi.fn(async () => undefined), focus: vi.fn(), isDestroyed: () => false, close: vi.fn() };
  let present: (frame: unknown) => void = () => undefined;
  const editor = { webContents: { on: vi.fn(), once: vi.fn(), removeListener: vi.fn(), isDestroyed: vi.fn(() => false),
    focus: vi.fn(), getZoomFactor: () => 1, invalidate: vi.fn(), endFrameSubscription: vi.fn(),
    capturePage: vi.fn<() => Promise<unknown>>(),
    beginFrameSubscription: vi.fn((_dirty, callback: (frame: unknown) => void) => { present = callback; }) }, contentView: { addChildView: vi.fn(), removeChildView: vi.fn() }, isFocused: vi.fn(() => true),
    getContentSize: () => [800, 600], once: vi.fn() };
  return { handlers, navigation, beforeRequest, contents, editor, present: (frame: unknown) => present(frame) };
});
vi.mock("electron", () => ({ app: { getPath: () => path.resolve("test-temp") },
  session: { fromPartition: () => ({ setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(),
    on: vi.fn(), webRequest: { onBeforeRequest: native.beforeRequest } }) },
  WebContentsView: class { webContents = native.contents; setBounds() {} setVisible() {} setBackgroundColor() {} },
}));
vi.mock("node:fs/promises", () => ({ mkdtemp: async () => path.resolve("test-temp", "reelterminal-board-test"), mkdir: vi.fn(), writeFile: vi.fn(), rm: vi.fn() }));
vi.mock("../editor-window", () => ({ getEditorWindow: () => native.editor }));
vi.mock("./index", () => ({ handle: (channel: string, schema: { parse(input: unknown): unknown }, handler: (input: unknown) => Promise<unknown>) => native.handlers.set(channel, async input => handler(schema.parse(input))) }));
vi.mock("./review-files", () => ({ getReviewFileStore: vi.fn() }));

import { registerHumanBoardDocumentsIpc } from "./human-board-documents";
import { CHANNELS } from "../../shared/channels";

it("rejects malformed local navigation and always completes the web request callback", async () => {
  registerHumanBoardDocumentsIpc();
  const id = crypto.randomUUID();
  await native.handlers.get(CHANNELS.boardDocumentOpen)!({ id, source: "<p>Document</p>", bounds: { x: 0, y: 0, width: 300, height: 200 } });
  const request = native.beforeRequest.mock.calls[0][0] as (details: { url: string }, callback: (result: { cancel: boolean }) => void) => void;
  for (const url of ["file:///a%2Fb.png", "file:///foo.png", "not a URL"]) {
    const callback = vi.fn();
    request({ url }, callback);
    expect(callback).toHaveBeenCalledExactlyOnceWith({ cancel: true });
    const preventDefault = vi.fn();
    native.navigation.get("will-frame-navigate")!({ url, preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
  }
  const callback = vi.fn();
  const local = pathToFileURL(path.resolve("test-temp", "reelterminal-board-test", "image.png")).href;
  request({ url: local }, callback);
  expect(callback).toHaveBeenCalledExactlyOnceWith({ cancel: false });
  await native.handlers.get(CHANNELS.boardDocumentClose)!({ id });
});

it.each([true, false])("returns focus to the editor only when its native window is foreground (%s)", async focused => {
  registerHumanBoardDocumentsIpc();
  native.editor.isFocused.mockReturnValue(focused);
  const id = crypto.randomUUID();
  await native.handlers.get(CHANNELS.boardDocumentOpen)!({ id, source: "<p>Document</p>", bounds: { x: 0, y: 0, width: 300, height: 200 } });
  native.editor.webContents.focus.mockClear();
  native.contents.close.mockClear();
  native.editor.contentView.removeChildView.mockClear();
  await native.handlers.get(CHANNELS.boardDocumentClose)!({ id });
  expect(native.contents.close).toHaveBeenCalledOnce();
  expect(native.editor.contentView.removeChildView).toHaveBeenCalledOnce();
  expect(native.editor.webContents.focus).toHaveBeenCalledTimes(focused ? 1 : 0);
  native.editor.isFocused.mockReturnValue(true);
});

function editorFrame(token: number, scale: number, name: string) {
  return { isEmpty: () => false, getSize: () => ({ width: 800 * scale, height: 600 * scale }),
    crop: (bounds: { x: number; y: number; width: number; height: number }) => bounds.width === 1 && bounds.height === 1
      ? { toBitmap: () => (token >>> Math.floor(bounds.x / (8 * scale))) & 1
        ? Buffer.from([255, 255, 255, 255]) : Buffer.from([255, 0, 0, 0]) }
      : { isEmpty: () => false, toPNG: () => Buffer.from(name) } };
}

it.each([0.25, 0.67, 1, 1.25, 2])("rejects a queued document surface before accepting the current marker at scale %s", async scale => {
  registerHumanBoardDocumentsIpc();
  native.editor.webContents.endFrameSubscription.mockClear();
  native.editor.webContents.capturePage.mockReset();
  let resolved = false;
  const capture = native.handlers.get(CHANNELS.boardDocumentCaptureEditor)!({ x: 0, y: 8, width: 640, height: 448, frameToken: 0x40000002 });
  void capture.then(() => { resolved = true; }, () => undefined);
  native.present(editorFrame(0x40000001, scale, "previous document"));
  await new Promise(resolve => setImmediate(resolve));
  expect(resolved).toBe(false);
  expect(native.editor.webContents.capturePage).not.toHaveBeenCalled();
  const current = editorFrame(0x40000002, scale, "current document");
  const crop = vi.spyOn(current, "crop");
  native.editor.webContents.capturePage.mockResolvedValue(current);
  native.present(editorFrame(0x40000002, scale, "unprofiled subscription pixels"));
  expect(await capture).toEqual(Buffer.from("current document"));
  const area = crop.mock.calls.at(-1)![0];
  expect(area.y).toBeGreaterThanOrEqual(8 * scale);
  expect(area.x + area.width).toBeLessThanOrEqual(640 * scale);
  expect(area.y + area.height).toBeLessThanOrEqual((8 + 448) * scale);
  expect(native.editor.webContents.endFrameSubscription).toHaveBeenCalledOnce();
  expect(native.editor.webContents.capturePage).toHaveBeenCalledOnce();
});

it("rejects a stale copy after the matching paint receipt and keeps copies serial", async () => {
  registerHumanBoardDocumentsIpc();
  native.editor.webContents.endFrameSubscription.mockClear();
  const receipt = editorFrame(0x40000002, 1, "subscription pixels");
  native.editor.webContents.capturePage.mockReset()
    .mockResolvedValueOnce(editorFrame(0x40000001, 1, "stale copy"))
    .mockResolvedValueOnce(editorFrame(0x40000002, 1, "profiled current copy"));
  let resolved = false;
  const capture = native.handlers.get(CHANNELS.boardDocumentCaptureEditor)!({ x: 0, y: 8, width: 640, height: 448, frameToken: 0x40000002 });
  void capture.then(() => { resolved = true; }, () => undefined);
  native.present(receipt);
  native.present(receipt);
  await new Promise(resolve => setImmediate(resolve));
  expect(resolved).toBe(false);
  expect(native.editor.webContents.capturePage).toHaveBeenCalledOnce();
  expect(native.editor.webContents.endFrameSubscription).not.toHaveBeenCalled();
  native.present(receipt);
  expect(await capture).toEqual(Buffer.from("profiled current copy"));
  expect(native.editor.webContents.capturePage).toHaveBeenCalledTimes(2);
  expect(native.editor.webContents.endFrameSubscription).toHaveBeenCalledOnce();
});

it("keeps the original deadline while a page copy is pending and ignores its late result", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    let finishCopy!: (image: unknown) => void;
    registerHumanBoardDocumentsIpc();
    native.editor.webContents.endFrameSubscription.mockClear();
    native.editor.webContents.capturePage.mockReset().mockImplementation(() => new Promise(resolve => { finishCopy = resolve; }));
    const capture = native.handlers.get(CHANNELS.boardDocumentCaptureEditor)!({ x: 0, y: 8, width: 640, height: 448, frameToken: 0x40000002 });
    const failed = expect(capture).rejects.toThrow("文档预览未完成绘制");
    native.present(editorFrame(0x40000002, 1, "receipt"));
    await new Promise(resolve => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(10001);
    await failed;
    expect(native.editor.webContents.endFrameSubscription).toHaveBeenCalledOnce();
    finishCopy(editorFrame(0x40000002, 1, "late result"));
    await new Promise(resolve => setImmediate(resolve));
    expect(native.editor.webContents.endFrameSubscription).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

it("cleans up a failed page copy instead of accepting the subscription pixels", async () => {
  registerHumanBoardDocumentsIpc();
  native.editor.webContents.endFrameSubscription.mockClear();
  native.editor.webContents.capturePage.mockReset().mockRejectedValue(new Error("copy failed"));
  const capture = native.handlers.get(CHANNELS.boardDocumentCaptureEditor)!({ x: 0, y: 8, width: 640, height: 448, frameToken: 0x40000002 });
  const failed = expect(capture).rejects.toThrow("copy failed");
  native.present(editorFrame(0x40000002, 1, "receipt"));
  await failed;
  expect(native.editor.webContents.endFrameSubscription).toHaveBeenCalledOnce();
});

it("cancels a pending page copy when the editor is destroyed", async () => {
  registerHumanBoardDocumentsIpc();
  let finishCopy!: (image: unknown) => void;
  native.editor.webContents.endFrameSubscription.mockClear();
  native.editor.webContents.removeListener.mockClear();
  native.editor.webContents.capturePage.mockReset().mockImplementation(() => new Promise(resolve => { finishCopy = resolve; }));
  const capture = native.handlers.get(CHANNELS.boardDocumentCaptureEditor)!({ x: 0, y: 8, width: 640, height: 448, frameToken: 0x40000002 });
  const failed = expect(capture).rejects.toThrow("文档截图已取消");
  native.present(editorFrame(0x40000002, 1, "receipt"));
  await new Promise(resolve => setImmediate(resolve));
  const destroyed = native.editor.webContents.once.mock.calls.at(-1)!;
  expect(destroyed[0]).toBe("destroyed");
  native.editor.webContents.isDestroyed.mockReturnValue(true);
  try {
    destroyed[1]();
    await failed;
    expect(native.editor.webContents.removeListener).toHaveBeenCalledWith("destroyed", destroyed[1]);
    expect(native.editor.webContents.endFrameSubscription).not.toHaveBeenCalled();
    finishCopy(editorFrame(0x40000002, 1, "late result"));
    await new Promise(resolve => setImmediate(resolve));
  } finally { native.editor.webContents.isDestroyed.mockReturnValue(false); }
});

it("fails a capture whose current document never reaches presentation instead of returning the previous one", async () => {
  vi.useFakeTimers();
  try {
    registerHumanBoardDocumentsIpc();
    const capture = native.handlers.get(CHANNELS.boardDocumentCaptureEditor)!({ x: 0, y: 8, width: 640, height: 448, frameToken: 0x40000002 });
    const failed = expect(capture).rejects.toThrow();
    native.present(editorFrame(0x40000001, 1, "previous document"));
    await vi.advanceTimersByTimeAsync(10001);
    await failed;
  } finally { vi.useRealTimers(); }
});

it.each([-1, 0x100000000, 0.5])("rejects an invalid frame token %s", async frameToken => {
  registerHumanBoardDocumentsIpc();
  await expect(native.handlers.get(CHANNELS.boardDocumentCaptureEditor)!({ x: 0, y: 8, width: 640, height: 448, frameToken })).rejects.toThrow();
});
