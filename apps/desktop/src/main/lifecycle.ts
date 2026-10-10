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

// A destroyed window cannot authorize closing any other window.
const NO_REPLY = Symbol("no-reply");

function requestFromRenderer(
  win: BrowserWindow,
  sendChannel: string,
  replyChannel: string,
): Promise<unknown> {
  return new Promise((resolve) => {
    let settled = false;
    // Hold the webContents reference up front: the property getter throws on
    // a destroyed window, so finish() must use the captured reference.
    const webContents = win.isDestroyed() ? null : win.webContents;
    const finish = (value: unknown): void => {
      if (settled) return;
      settled = true;
      win.removeListener("closed", onClosed);
      webContents?.removeListener("destroyed", onContentsGone);
      webContents?.removeListener("render-process-gone", onContentsGone);
      ipcMain.removeListener(replyChannel, onReply);
      resolve(value);
    };
    const onReply = (event: IpcMainEvent, payload: unknown): void => {
      if (webContents && event.sender === webContents) finish(payload);
    };
    const onClosed = (): void => finish(NO_REPLY);
    // A renderer that never loaded or crashed never replies; settle instead
    // of leaving the guard stuck and the ipcMain listener leaking.
    const onContentsGone = (): void => finish(NO_REPLY);
    win.once("closed", onClosed);
    webContents?.once("destroyed", onContentsGone);
    webContents?.once("render-process-gone", onContentsGone);
    ipcMain.on(replyChannel, onReply);
    if (!webContents) {
      finish(NO_REPLY);
      return;
    }
    webContents.send(sendChannel);
  });
}

function isAllowReply(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { allow?: unknown }).allow === true
  );
}

function finalizeClose(win: BrowserWindow, quitIntent: boolean): void {
  forceClose.add(win);
  if (quitIntent) {
    app.quit();
  } else if (!win.isDestroyed()) {
    win.close();
  }
}

async function handleGuardedClose(
  win: BrowserWindow,
  quitIntent: boolean,
): Promise<void> {
  // Renderer-driven prepare-close: the renderer flushes every open workspace
  // (mandatory), optionally retains versions per the user's close preference,
  // and answers { allow }. allow=true → close; allow=false → keep the window
  // (flush failed or the user cancelled the retention dialog).
  const reply = await requestFromRenderer(
    win,
    CHANNELS.lifecyclePrepareCloseQuery,
    CHANNELS.lifecyclePrepareCloseReply,
  );

  if (isAllowReply(reply)) {
    finalizeClose(win, quitIntent);
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
    // Capture the quit intent now: another window's denial resets the global
    // flag while this close is still in flight, and finalize must still
    // re-trigger the quit that was in progress when THIS close started.
    const quitIntent = quitting;
    void handleGuardedClose(win, quitIntent).finally(() => handling.delete(win));
  });
}
