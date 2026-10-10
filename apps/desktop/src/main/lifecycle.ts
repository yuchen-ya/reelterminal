import { app, BrowserWindow, dialog, ipcMain } from "electron";
import type { IpcMainEvent } from "electron";
import { CHANNELS } from "../shared/ipc-contract";
import type {
  LifecyclePrepareCloseQuery,
} from "../shared/channels";

// Windows that have passed the guard and may close freely.
const forceClose = new WeakSet<BrowserWindow>();
// Windows whose guard is currently running, to ignore duplicate close events
// (including while the recovery dialog below is in flight).
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

// A live renderer that never answers (slow or hung save) must not hold the
// close guard hostage: once the wait crosses this deadline, main offers the
// recovery dialog (continue waiting / cancel close / force close).
export const RECOVERY_DIALOG_TIMEOUT_MS = 30_000;

// Monotonic request ids: every prepare-close query carries one and the reply
// must echo it. Main drops replies whose id does not match the CURRENT
// handshake, so a late answer from an earlier (cancelled / superseded)
// handshake can never close the window.
let requestSequence = 0;
function createRequestId(): string {
  requestSequence += 1;
  return `lifecycle-close-${requestSequence}`;
}

/** The user's choice in the unresponsive-close recovery dialog. */
export type RecoveryChoice = "wait" | "cancel" | "force";

/** Injection seams for tests (defaults drive the real timer + native dialog). */
export interface UnsavedGuardOptions {
  setTimeout?: (handler: () => void, ms: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
  showRecoveryDialog?: (win: BrowserWindow) => Promise<RecoveryChoice>;
}

type GuardDeps = Required<UnsavedGuardOptions>;

const defaultSetTimeout: GuardDeps["setTimeout"] = (handler, ms) =>
  setTimeout(handler, ms);
const defaultClearTimeout: GuardDeps["clearTimeout"] = (timer) =>
  clearTimeout(timer as Parameters<typeof clearTimeout>[0]);

// Button order for the native recovery dialog. "Continue waiting" is the safe
// default (defaultId); Escape resolves cancelId (cancel close).
const WAIT_BUTTON = 0;
const CANCEL_BUTTON = 1;
const FORCE_BUTTON = 2;

// Main-process dialogs use English because the main process has no i18n
// runtime (same convention as startup-failures.ts).
async function showNativeRecoveryDialog(
  win: BrowserWindow,
): Promise<RecoveryChoice> {
  // The mocked/aborted result is tolerated via ?. and the default arm so a
  // dialog that resolves without a response can only ever mean "keep waiting".
  const result = await dialog.showMessageBox(win, {
    type: "warning",
    title: "ReelTerminal is taking a long time to close",
    message:
      "This window has not finished preparing to close. It may still be saving your work.",
    detail: "Force close skips the save handshake and can lose unsaved changes.",
    buttons: ["Continue waiting", "Cancel close", "Force close"],
    defaultId: WAIT_BUTTON,
    cancelId: CANCEL_BUTTON,
    noLink: true,
  });
  switch (result?.response) {
    case FORCE_BUTTON:
      return "force";
    case CANCEL_BUTTON:
      return "cancel";
    default:
      return "wait";
  }
}

interface PendingReply {
  reply: Promise<unknown>;
  /** Finishes the wait as NO_REPLY (idempotent). */
  detach: () => void;
}

function isReplyForRequest(payload: unknown, requestId: string): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { requestId?: unknown }).requestId === requestId
  );
}

function requestPrepareCloseReply(
  win: BrowserWindow,
  requestId: string,
): PendingReply {
  // Capture the webContents reference up front: the property getter throws on
  // a destroyed window, so cleanup must use the captured reference.
  const webContents = win.isDestroyed() ? null : win.webContents;
  let settled = false;
  let resolveReply: (value: unknown) => void = () => {};
  const reply = new Promise<unknown>((resolve) => {
    resolveReply = resolve;
  });
  const finish = (value: unknown): void => {
    if (settled) return;
    settled = true;
    win.removeListener("closed", onClosed);
    webContents?.removeListener("destroyed", onContentsGone);
    webContents?.removeListener("render-process-gone", onContentsGone);
    ipcMain.removeListener(CHANNELS.lifecyclePrepareCloseReply, onReply);
    resolveReply(value);
  };
  const onReply = (event: IpcMainEvent, payload: unknown): void => {
    if (!webContents || event.sender !== webContents) return;
    // Replies that do not echo THIS handshake's request id come from an
    // earlier (superseded) handshake and must never settle it.
    if (!isReplyForRequest(payload, requestId)) return;
    finish(payload);
  };
  const onClosed = (): void => finish(NO_REPLY);
  // A renderer that never loaded or crashed never replies; settle instead
  // of leaving the guard stuck and the ipcMain listener leaking.
  const onContentsGone = (): void => finish(NO_REPLY);
  win.once("closed", onClosed);
  webContents?.once("destroyed", onContentsGone);
  webContents?.once("render-process-gone", onContentsGone);
  ipcMain.on(CHANNELS.lifecyclePrepareCloseReply, onReply);
  if (!webContents) {
    finish(NO_REPLY);
  } else {
    const query: LifecyclePrepareCloseQuery = { requestId };
    webContents.send(CHANNELS.lifecyclePrepareCloseQuery, query);
  }
  return {
    reply,
    detach: () => finish(NO_REPLY),
  };
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

type ReplyOutcome = { kind: "reply"; payload: unknown };
type TimeoutOutcome = { kind: "timeout" };
type DialogOutcome = { kind: "dialog"; choice: RecoveryChoice };
type WaitOutcome = ReplyOutcome | TimeoutOutcome | DialogOutcome;

// Close-guard state machine for ONE handshake:
//
//   query (with requestId) → wait for the echoed reply
//     ├─ allow reply (id matches)         → finalizeClose (close / app.quit)
//     ├─ deny / malformed reply (id match)→ abort quit; next close re-prompts
//     ├─ 30s silence → recovery dialog ──┐
//     │    ├─ 继续等待 (wait)            → loop: fresh 30s countdown, reply
//     │    │                               wait stays OPEN (nothing restarts)
//     │    ├─ 取消关闭 (cancel)          → keep window, reset quit intent
//     │    └─ 强制关闭 (force)           → skip THIS window's handshake, close
//     └─ renderer gone / window closed   → settle NO_REPLY (no close)
//
// Single-decision guarantee: every iteration races exactly two sources (reply
// vs countdown, then reply vs dialog) and only the winner's branch executes a
// decision, after which the function returns. Returning runs the `finally`,
// which detaches the reply listener — so once a decision executed, neither a
// late reply nor the losing dialog's eventual result can trigger a second one.
async function handleGuardedClose(
  win: BrowserWindow,
  quitIntent: boolean,
  deps: GuardDeps,
): Promise<void> {
  const requestId = createRequestId();
  const pending = requestPrepareCloseReply(win, requestId);
  const replyOutcome = pending.reply.then(
    (payload): ReplyOutcome => ({ kind: "reply", payload }),
  );

  try {
    while (true) {
      // Fresh countdown each pass. "Continue waiting" loops back here without
      // restarting the renderer handshake — the reply wait stays open.
      let fireTimeout: () => void = () => {};
      const timeout = new Promise<TimeoutOutcome>((resolve) => {
        fireTimeout = () => resolve({ kind: "timeout" });
      });
      const timer = deps.setTimeout(() => fireTimeout(), RECOVERY_DIALOG_TIMEOUT_MS);
      let outcome: WaitOutcome = await Promise.race([replyOutcome, timeout]);
      deps.clearTimeout(timer);

      if (outcome.kind === "timeout") {
        // Deadline hit with no answer: offer the recovery dialog, but keep
        // racing it against the reply — whichever settles first decides.
        // Electron has no API to dismiss a message box programmatically, so a
        // losing dialog's later result is simply ignored; the race already
        // attached handlers to it, so it can never become an unhandled
        // rejection.
        const dialogOutcome = deps
          .showRecoveryDialog(win)
          .then(
            (choice): DialogOutcome => ({ kind: "dialog", choice }),
            (): DialogOutcome => ({ kind: "dialog", choice: "wait" }),
          );
        outcome = await Promise.race([replyOutcome, dialogOutcome]);
      }

      if (outcome.kind === "reply") {
        if (isAllowReply(outcome.payload)) {
          finalizeClose(win, quitIntent);
          return;
        }
        // Denied or malformed reply — abort any in-progress quit so a later
        // close re-prompts instead of silently closing behind the user's back.
        quitting = false;
        return;
      }

      if (outcome.choice === "force") {
        // The only path that skips the save handshake, and only via the
        // user's explicit choice in the recovery dialog.
        finalizeClose(win, quitIntent);
        return;
      }
      if (outcome.choice === "cancel") {
        // Same re-prompt contract as a denial: the window stays open and the
        // next close starts a fresh handshake.
        quitting = false;
        return;
      }
      // "wait": fall through; the loop schedules the next countdown.
    }
  } finally {
    // Inert once the wait settled on its own; crucial after force/cancel and
    // after teardown (renderer gone / window closed): no late reply may fire.
    pending.detach();
  }
}

export function attachUnsavedGuard(
  win: BrowserWindow,
  options: UnsavedGuardOptions = {},
): void {
  const deps: GuardDeps = {
    setTimeout: options.setTimeout ?? defaultSetTimeout,
    clearTimeout: options.clearTimeout ?? defaultClearTimeout,
    showRecoveryDialog: options.showRecoveryDialog ?? showNativeRecoveryDialog,
  };
  win.on("close", (event) => {
    if (forceClose.has(win)) return;
    event.preventDefault();
    if (handling.has(win)) return;
    handling.add(win);
    // Capture the quit intent now: another window's denial resets the global
    // flag while this close is still in flight, and finalize must still
    // re-trigger the quit that was in progress when THIS close started.
    const quitIntent = quitting;
    void handleGuardedClose(win, quitIntent, deps).finally(() => handling.delete(win));
  });
}
