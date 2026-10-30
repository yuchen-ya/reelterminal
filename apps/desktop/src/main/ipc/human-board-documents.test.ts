import { expect, it, vi } from "vitest";
import path from "node:path";
import { pathToFileURL } from "node:url";

const native = vi.hoisted(() => {
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  const navigation = new Map<string, (event: { url: string; preventDefault: () => void }) => void>();
  const beforeRequest = vi.fn();
  const contents = { on: vi.fn((name, listener) => navigation.set(name, listener)), setWindowOpenHandler: vi.fn(),
    loadFile: vi.fn(async () => undefined), focus: vi.fn() };
  const editor = { webContents: { on: vi.fn() }, contentView: { addChildView: vi.fn() },
    getContentSize: () => [800, 600], once: vi.fn() };
  return { handlers, navigation, beforeRequest, contents, editor };
});
vi.mock("electron", () => ({ app: { getPath: () => "C:\\Temp" },
  session: { fromPartition: () => ({ setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(),
    on: vi.fn(), webRequest: { onBeforeRequest: native.beforeRequest } }) },
  WebContentsView: class { webContents = native.contents; setBounds() {} setVisible() {} setBackgroundColor() {} },
}));
vi.mock("node:fs/promises", () => ({ mkdtemp: async () => "C:\\Temp\\reelterminal-board-test", mkdir: vi.fn(), writeFile: vi.fn() }));
vi.mock("../editor-window", () => ({ getEditorWindow: () => native.editor }));
vi.mock("./index", () => ({ handle: (channel: string, _schema: unknown, handler: (input: unknown) => Promise<unknown>) => native.handlers.set(channel, handler) }));
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
