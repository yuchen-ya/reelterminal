import { expect, it, vi } from "vitest";
import path from "node:path";
import { pathToFileURL } from "node:url";

const native = vi.hoisted(() => {
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  const navigation = new Map<string, (event: { url: string; preventDefault: () => void }) => void>();
  const beforeRequest = vi.fn();
  const contents = { on: vi.fn((name, listener) => navigation.set(name, listener)), setWindowOpenHandler: vi.fn(),
    loadFile: vi.fn(async () => undefined), focus: vi.fn() };
  let present: (frame: unknown) => void = () => undefined;
  const editor = { webContents: { on: vi.fn(), once: vi.fn(), removeListener: vi.fn(), isDestroyed: () => false,
    getZoomFactor: () => 1, invalidate: vi.fn(), endFrameSubscription: vi.fn(),
    beginFrameSubscription: vi.fn((_dirty, callback: (frame: unknown) => void) => { present = callback; }) }, contentView: { addChildView: vi.fn() },
    getContentSize: () => [800, 600], once: vi.fn() };
  return { handlers, navigation, beforeRequest, contents, editor, present: (frame: unknown) => present(frame) };
});
vi.mock("electron", () => ({ app: { getPath: () => "C:\\Temp" },
  session: { fromPartition: () => ({ setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(),
    on: vi.fn(), webRequest: { onBeforeRequest: native.beforeRequest } }) },
  WebContentsView: class { webContents = native.contents; setBounds() {} setVisible() {} setBackgroundColor() {} },
}));
vi.mock("node:fs/promises", () => ({ mkdtemp: async () => "C:\\Temp\\reelterminal-board-test", mkdir: vi.fn(), writeFile: vi.fn() }));
vi.mock("../editor-window", () => ({ getEditorWindow: () => native.editor }));
vi.mock("./index", () => ({ handle: (channel: string, schema: { parse(input: unknown): unknown }, handler: (input: unknown) => Promise<unknown>) => native.handlers.set(channel, async input => handler(schema.parse(input))) }));
vi.mock("./review-files", () => ({ getReviewFileStore: vi.fn() }));

import { registerHumanBoardDocumentsIpc } from "./human-board-documents";
import { CHANNELS } from "../../shared/channels";

it("rejects malformed local navigation and always completes the web request callback", async () => {
  registerHumanBoardDocumentsIpc();
  await native.handlers.get(CHANNELS.boardDocumentOpen)!({ id: crypto.randomUUID(), source: "<p>Document</p>", bounds: { x: 0, y: 0, width: 300, height: 200 } });
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
  const local = pathToFileURL(path.join("C:\\Temp\\reelterminal-board-test", "image.png")).href;
  request({ url: local }, callback);
  expect(callback).toHaveBeenCalledExactlyOnceWith({ cancel: false });
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
  let resolved = false;
  const capture = native.handlers.get(CHANNELS.boardDocumentCaptureEditor)!({ x: 0, y: 8, width: 640, height: 448, frameToken: 0x40000002 });
  void capture.then(() => { resolved = true; }, () => undefined);
  native.present(editorFrame(0x40000001, scale, "previous document"));
  await new Promise(resolve => setImmediate(resolve));
  expect(resolved).toBe(false);
  const current = editorFrame(0x40000002, scale, "current document");
  const crop = vi.spyOn(current, "crop");
  native.present(current);
  expect(await capture).toEqual(Buffer.from("current document"));
  expect(crop.mock.calls.at(-1)?.[0].y).toBeGreaterThanOrEqual(8 * scale);
  expect(native.editor.webContents.endFrameSubscription).toHaveBeenCalledOnce();
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
