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

const fakeSender = { id: "main-window-webcontents", mainFrame: { url: "app://reelterminal/index.html" } };
vi.mock("../src/main/editor-window", () => ({
  getEditorWebContents: () => fakeSender,
}));

import { CHANNELS } from "../src/shared/channels";
import { registerLiveIpc } from "../src/main/ipc/live";
import type { LiveSessionHost } from "../src/main/live/live-session-host";

const stubHost = {
  enable: vi.fn(),
  disable: vi.fn(),
  getStatus: vi.fn(),
  setAccess: vi.fn(),
} as unknown as LiveSessionHost;

describe("collabOpenWorkspace IPC", () => {
  beforeEach(() => {
    videosDir = mkdtempSync(path.join(tmpdir(), "orel-videos-"));
    handlers.clear();
    openPath.mockClear();
    vi.mocked(stubHost.enable).mockClear();
    vi.mocked(stubHost.disable).mockClear();
    vi.mocked(stubHost.setAccess).mockClear();
    registerLiveIpc(stubHost);
  });

  afterEach(() => {
    rmSync(videosDir, { recursive: true, force: true });
  });

  it("creates jobs/shared under the workspace root and reveals it", async () => {
    const handler = handlers.get(CHANNELS.collabOpenWorkspace);
    expect(handler).toBeDefined();

    const workspace = await handler!({ sender: fakeSender, senderFrame: fakeSender.mainFrame });

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
      /main editor frame/,
    );
    expect(openPath).not.toHaveBeenCalled();
  });

  it("does not register retired collaboration-mode controls", () => {
    expect(Object.keys(CHANNELS)).not.toContain("collabSetMode");
  });

  it("routes an explicit write-access recovery to the live host", async () => {
    const handler = handlers.get(CHANNELS.collabSetAccess)!;
    await handler({ sender: fakeSender, senderFrame: fakeSender.mainFrame }, { access: "write" });
    expect(stubHost.setAccess).toHaveBeenCalledWith("write");
  });

  it("keeps the endpoint online when the legacy renderer toggle is disabled", async () => {
    const handler = handlers.get(CHANNELS.collabDisable)!;
    await handler({ sender: fakeSender, senderFrame: fakeSender.mainFrame });
    expect(stubHost.setAccess).toHaveBeenCalledWith("read-only");
    expect(stubHost.disable).not.toHaveBeenCalled();
  });

  it("rejects an unknown access value at the IPC boundary", async () => {
    const handler = handlers.get(CHANNELS.collabSetAccess)!;
    await expect(
      handler({ sender: fakeSender, senderFrame: fakeSender.mainFrame }, { access: "owner" }),
    ).rejects.toThrow();
    expect(stubHost.setAccess).not.toHaveBeenCalled();
  });
});
