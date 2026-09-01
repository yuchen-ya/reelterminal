/**
 * Live collaboration IPC (ADR 0004): the renderer-facing handles behind
 * window.openreel.facade / .collabControl.
 *
 * Every channel is restricted to the main editor window's webContents (the
 * embedded chat); facade.call additionally validates the verb against the
 * facade contract before it reaches the session host. The FacadeResult
 * crosses IPC in the global.d.ts wire shape ({ ok, data?, error? }).
 */
import { ipcMain } from "electron";
import { z } from "zod";
import type { FacadeResult } from "@openreel/agent-facade";
import { CHANNELS } from "../../shared/channels";
import type { LiveFacadeResultWire } from "../../shared/live";
import { liveTargetWebContents } from "../live/renderer-store-adapter";
import { isFacadeVerb, type LiveSessionHost } from "../live/live-session-host";

const facadeCallArgsSchema = z.object({
  verb: z.string(),
  params: z.unknown().optional(),
});

const setModeArgsSchema = z.object({
  mode: z.enum(["observe", "assist", "autonomous"]),
});

/** In-process { ok, value } → wire { ok, data }; errors pass verbatim. */
function toWire(result: FacadeResult<unknown>): LiveFacadeResultWire {
  return result.ok
    ? { ok: true, data: result.value }
    : { ok: false, error: result.error };
}

function assertMainWindowSender(sender: unknown): void {
  const contents = liveTargetWebContents();
  if (!contents || sender !== contents) {
    throw new Error(
      "[ipc] live collaboration channels are only available to the main editor window",
    );
  }
}

export function registerLiveIpc(host: LiveSessionHost): void {
  ipcMain.handle(CHANNELS.facadeCall, async (event, raw) => {
    assertMainWindowSender(event.sender);
    const { verb, params } = facadeCallArgsSchema.parse(raw);
    if (!isFacadeVerb(verb)) {
      throw new Error(`[ipc] unknown facade verb: ${verb}`);
    }
    return toWire(await host.callEmbedded(verb, params));
  });

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
