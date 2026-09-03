import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let videosDir = "";

const handlers = new Map<string, (event: unknown, raw?: unknown) => unknown>();
const openPath = vi.fn(async () => "");

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name !== "videos") throw new Error(`unexpected path: ${name}`);
      return videosDir;
    },
  },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, raw?: unknown) => unknown) => {
      handlers.set(channel, handler);
    },
  },
  shell: {
    openPath: (p: string) => openPath(p),
  },
}));

const fakeSender = { id: "main-window-webcontents" };
vi.mock("../src/main/live/renderer-store-adapter", () => ({
  liveTargetWebContents: () => fakeSender,
}));

import { CHANNELS } from "../src/shared/channels";
import { registerLiveIpc } from "../src/main/ipc/live";
import type { LiveSessionHost } from "../src/main/live/live-session-host";

const stubHost = {
  enable: vi.fn(),
  disable: vi.fn(),
  getStatus: vi.fn(),
  setMode: vi.fn(),
} as unknown as LiveSessionHost;

describe("collabOpenWorkspace IPC", () => {
  beforeEach(() => {
    videosDir = mkdtempSync(path.join(tmpdir(), "orel-videos-"));
    handlers.clear();
    openPath.mockClear();
    registerLiveIpc(stubHost);
  });

  afterEach(() => {
    rmSync(videosDir, { recursive: true, force: true });
  });

  it("creates jobs/shared under the workspace root and reveals it", async () => {
    const handler = handlers.get(CHANNELS.collabOpenWorkspace);
    expect(handler).toBeDefined();

    const workspace = await handler!({ sender: fakeSender });

    const expected = path.join(videosDir, "ReelTerminal Agent Workspace");
    expect(workspace).toBe(expected);
    expect(openPath).toHaveBeenCalledWith(expected);
    const { statSync } = await import("node:fs");
    expect(statSync(path.join(expected, "jobs")).isDirectory()).toBe(true);
    expect(statSync(path.join(expected, "shared")).isDirectory()).toBe(true);
  });

  it("rejects senders other than the main editor window", async () => {
    const handler = handlers.get(CHANNELS.collabOpenWorkspace)!;
    await expect(handler({ sender: { id: "other" } })).rejects.toThrow(
      /main editor window/,
    );
    expect(openPath).not.toHaveBeenCalled();
  });
});
