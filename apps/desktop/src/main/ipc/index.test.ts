import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({ handle: vi.fn(), contents: null as unknown }));
vi.mock("electron", () => ({ ipcMain: { handle: mocks.handle } }));
vi.mock("../editor-window", () => ({ getEditorWebContents: () => mocks.contents }));
vi.mock("../protocol", () => ({ APP_INDEX: "app://reelterminal/index.html" }));
import { handle } from "./index";

describe("editor IPC boundary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("accepts a validated payload only from the editor main frame", async () => {
    const mainFrame = { url: "app://reelterminal/index.html" };
    const sender = { mainFrame };
    mocks.contents = sender;
    const operation = vi.fn((args: { path: string }) => args.path);
    handle("read-file", z.object({ path: z.string() }), operation);
    const callback = mocks.handle.mock.calls[0][1];
    expect(await callback({ sender, senderFrame: mainFrame }, { path: "chosen-file" })).toBe("chosen-file");
    await expect(callback({ sender, senderFrame: mainFrame }, { path: 7 })).rejects.toThrow("invalid payload");
    for (const event of [
      { sender: {}, senderFrame: mainFrame },
      { sender, senderFrame: { url: "app://reelterminal/index.html" } },
      { sender, senderFrame: null },
    ]) {
      await expect(callback(event, { path: "private" })).rejects.toThrow("main editor frame");
    }
    mainFrame.url = "https://example.com/";
    await expect(callback({ sender, senderFrame: mainFrame }, { path: "private" })).rejects.toThrow("editor origin");
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
