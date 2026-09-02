/**
 * Live collaboration IPC (ADR 0004): the renderer-facing handles behind
 * window.openreel.collabControl.
 *
 * Every channel is restricted to the main editor window's webContents. Agent
 * reasoning and tool calls arrive through the external live endpoint; this
 * IPC surface only controls that session and reports its status.
 */
import { ipcMain } from "electron";
import { z } from "zod";
import { CHANNELS } from "../../shared/channels";
import { liveTargetWebContents } from "../live/renderer-store-adapter";
import type { LiveSessionHost } from "../live/live-session-host";

const setModeArgsSchema = z.object({
  mode: z.enum(["observe", "assist", "autonomous"]),
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
    return host.setMode(mode);
  });
}
