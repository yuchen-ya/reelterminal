/**
 * Live collaboration IPC (ADR 0004): the renderer-facing handles behind
 * window.openreel.collabControl.
 *
 * Every channel is restricted to the main editor window's webContents. Agent
 * reasoning and tool calls arrive through the external live endpoint; this
 * IPC surface only controls that session and reports its status.
 */
import { ipcMain, shell } from "electron";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CHANNELS } from "../../shared/channels";
import { liveTargetWebContents } from "../live/renderer-store-adapter";
import { agentWorkspaceRoot } from "../live/host-instance";
import type { LiveSessionHost } from "../live/live-session-host";

const setModeArgsSchema = z.object({
  mode: z.enum(["guided", "collaborative", "autonomous"]),
});
const setAccessArgsSchema = z.object({
  access: z.enum(["read-only", "write"]),
});

function assertMainWindowSender(sender: unknown): void {
  const contents = liveTargetWebContents();
  if (!contents || sender !== contents) {
    throw new Error(
      "[ipc] live collaboration channels are only available to the main editor window",
    );
  }
}

export function registerLiveIpc(host: LiveSessionHost): void {
  ipcMain.handle(CHANNELS.collabEnable, async (event) => {
    assertMainWindowSender(event.sender);
    return host.enable();
  });

  ipcMain.handle(CHANNELS.collabDisable, async (event) => {
    assertMainWindowSender(event.sender);
    return host.disable();
  });

  ipcMain.handle(CHANNELS.collabGetStatus, async (event) => {
    assertMainWindowSender(event.sender);
    return host.getStatus();
  });

  ipcMain.handle(CHANNELS.collabSetMode, async (event, raw) => {
    assertMainWindowSender(event.sender);
    const { mode } = setModeArgsSchema.parse(raw);
    return host.setWorkMode(mode);
  });

  ipcMain.handle(CHANNELS.collabSetAccess, async (event, raw) => {
    assertMainWindowSender(event.sender);
    const { access } = setAccessArgsSchema.parse(raw);
    return host.setAccess(access);
  });

  /**
   * "Open Agent Workspace" (GUI discoverability): reveal the workspace root
   * (jobs/shared — where Agent-imported media and exported deliverables live)
   * in the OS file manager. Created on demand so the entry works before any
   * Agent ran. Returns the absolute path so the UI can show it.
   */
  ipcMain.handle(CHANNELS.collabOpenWorkspace, async (event) => {
    assertMainWindowSender(event.sender);
    const workspace = agentWorkspaceRoot();
    mkdirSync(path.join(workspace, "jobs"), { recursive: true });
    mkdirSync(path.join(workspace, "shared"), { recursive: true });
    await shell.openPath(workspace);
    return workspace;
  });
}
