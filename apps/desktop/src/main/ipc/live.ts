/**
 * Live collaboration IPC exposes the renderer-facing handles behind
 * window.reelterminal.collabControl.
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
import { assertEditorIpcSender } from "./index";
import { agentWorkspaceRoot } from "../live/host-instance";
import type { LiveSessionHost } from "../live/live-session-host";

const setAccessArgsSchema = z.object({
  access: z.enum(["read-only", "write"]),
});

export function registerLiveIpc(host: LiveSessionHost): void {
  // Compatibility for renderers that still use the former service toggle:
  // the endpoint now follows app lifetime, while these channels only grant
  // or revoke this launch's write authorization.
  ipcMain.handle(CHANNELS.collabEnable, async (event) => {
    assertEditorIpcSender(event);
    return host.setAccess("write");
  });

  ipcMain.handle(CHANNELS.collabDisable, async (event) => {
    assertEditorIpcSender(event);
    return host.setAccess("read-only");
  });

  ipcMain.handle(CHANNELS.collabGetStatus, async (event) => {
    assertEditorIpcSender(event);
    return host.getStatus();
  });

  ipcMain.handle(CHANNELS.collabSetAccess, async (event, raw) => {
    assertEditorIpcSender(event);
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
    assertEditorIpcSender(event);
    const workspace = agentWorkspaceRoot();
    mkdirSync(path.join(workspace, "jobs"), { recursive: true });
    mkdirSync(path.join(workspace, "shared"), { recursive: true });
    await shell.openPath(workspace);
    return workspace;
  });
}
