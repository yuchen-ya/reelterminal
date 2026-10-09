import { app, BrowserWindow, ipcMain } from "electron";
import type { IpcMainEvent } from "electron";
import { CHANNELS } from "../shared/ipc-contract";

// Windows that have passed the guard and may close freely.
const forceClose = new WeakSet<BrowserWindow>();
// Windows whose guard is currently running, to ignore duplicate close events.
const handling = new WeakSet<BrowserWindow>();
// True once a full app quit has been requested (Cmd+Q / app.quit), so the guard
// knows to re-trigger the quit after a confirmed close rather than just hiding
// the window.
let quitting = false;

export function markQuitting(): void {
  quitting = true;
}

// Sentinel returned when the renderer does not reply within the timeout, so
// callers can distinguish "no answer" from a genuine reply.
const NO_REPLY = Symbol("no-reply");

// The renderer needs time to flush every open workspace and (optionally)
// retain versions behind the close dialog, so this is far more generous than
// the old dirty-state poll. Persistence is continuous — draft writes complete
// during editing — which is also what an OS force-kill relies on, so a
// renderer that goes silent is treated as safe to close rather than trapping
// the user in a window that can never close.
const PREPARE_CLOSE_TIMEOUT_MS = 20_000;

function requestFromRenderer(
  win: BrowserWindow,
  sendChannel: string,
  replyChannel: string,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ipcMain.removeListener(replyChannel, onReply);
      resolve(value);
    };
    const onReply = (event: IpcMainEvent, payload: unknown): void => {
      if (event.sender === win.webContents) finish(payload);
    };
    const timer = setTimeout(() => finish(NO_REPLY), timeoutMs);
    ipcMain.on(replyChannel, onReply);
    if (win.isDestroyed()) {
      finish(NO_REPLY);
      return;
    }
    win.webContents.send(sendChannel);
  });
}

function isAllowReply(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { allow?: unknown }).allow === true
  );
}

function finalizeClose(win: BrowserWindow): void {
  forceClose.add(win);
  if (quitting) {
    app.quit();
  } else if (!win.isDestroyed()) {
    win.close();
  }
}

async function handleGuardedClose(win: BrowserWindow): Promise<void> {
  // Renderer-driven prepare-close: the renderer flushes every open workspace
  // (mandatory), optionally retains versions per the user's close preference,
  // and answers { allow }. allow=true → close; allow=false → keep the window
  // (flush failed or the user cancelled the retention dialog).
  const reply = await requestFromRenderer(
    win,
    CHANNELS.lifecyclePrepareCloseQuery,
    CHANNELS.lifecyclePrepareCloseReply,
    PREPARE_CLOSE_TIMEOUT_MS,
  );

  if (reply === NO_REPLY || isAllowReply(reply)) {
    finalizeClose(win);
    return;
  }

  // Denied or malformed reply — abort any in-progress quit so a later close
  // re-prompts instead of silently closing behind the user's back.
  quitting = false;
}

export function attachUnsavedGuard(win: BrowserWindow): void {
  win.on("close", (event) => {
    if (forceClose.has(win)) return;
    event.preventDefault();
    if (handling.has(win)) return;
    handling.add(win);
    void handleGuardedClose(win).finally(() => handling.delete(win));
  });
}
