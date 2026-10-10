import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  type Listener = (event: unknown, payload?: unknown) => void;
  const listeners = new Map<string, Set<Listener>>();
  const ipcMain = {
    on: vi.fn((channel: string, listener: Listener) => {
      const channelListeners = listeners.get(channel) ?? new Set<Listener>();
      channelListeners.add(listener);
      listeners.set(channel, channelListeners);
    }),
    removeListener: vi.fn((channel: string, listener: Listener) => {
      listeners.get(channel)?.delete(listener);
    }),
    emit: (channel: string, event: unknown, payload?: unknown) => {
      for (const listener of listeners.get(channel) ?? []) {
        listener(event, payload);
      }
    },
    listenerCount: (channel: string) => listeners.get(channel)?.size ?? 0,
    reset: () => listeners.clear(),
  };
  return {
    app: { quit: vi.fn() },
    dialog: { showMessageBox: vi.fn() },
    ipcMain,
  };
});

vi.mock("electron", () => electron);

import {
  attachUnsavedGuard,
  markQuitting,
  RECOVERY_DIALOG_TIMEOUT_MS,
  type UnsavedGuardOptions,
} from "./lifecycle";
import { CHANNELS } from "../shared/ipc-contract";

type CloseEvent = { preventDefault: ReturnType<typeof vi.fn> };
type ContentsListener = (payload?: unknown) => void;

const makeWindow = (guardOptions: UnsavedGuardOptions = {}) => {
  let closeHandler: ((event: CloseEvent) => void) | undefined;
  const contentsListeners = new Map<string, Set<ContentsListener>>();
  const webContents = {
    send: vi.fn(),
    once: vi.fn((event: string, handler: ContentsListener) => {
      const set = contentsListeners.get(event) ?? new Set<ContentsListener>();
      set.add(handler);
      contentsListeners.set(event, set);
    }),
    removeListener: vi.fn((event: string, handler: ContentsListener) => {
      contentsListeners.get(event)?.delete(handler);
    }),
    emit: (event: string): void => {
      for (const handler of [...(contentsListeners.get(event) ?? [])]) handler();
    },
  };
  const win = {
    on: vi.fn((event: string, handler: (event: CloseEvent) => void) => {
      if (event === "close") closeHandler = handler;
    }),
    close: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    isDestroyed: vi.fn(() => false),
    webContents,
  };
  attachUnsavedGuard(win as never, guardOptions);
  return {
    win,
    close: () => closeHandler?.({ preventDefault: vi.fn() }),
    contentsGone: (event: string) => webContents.emit(event),
  };
};

type TestWindow = ReturnType<typeof makeWindow>["win"];

/** requestId of the most recent prepare-close query sent to this window. */
function lastQueryRequestId(win: TestWindow): string {
  const calls = (win.webContents.send as ReturnType<typeof vi.fn>).mock
    .calls as Array<[string, { requestId?: string } | undefined]>;
  const query = calls.filter(([channel]) => channel === CHANNELS.lifecyclePrepareCloseQuery).at(-1);
  return query?.[1]?.requestId ?? "";
}

/** Raw renderer reply with an arbitrary payload (for stale/malformed cases). */
function emitReply(win: TestWindow, payload: unknown): void {
  electron.ipcMain.emit(
    CHANNELS.lifecyclePrepareCloseReply,
    { sender: win.webContents },
    payload,
  );
}

/**
 * Renderer that echoes the query's requestId on every prepare-close query and
 * always answers with the given allow flag (the well-behaved preload bridge).
 */
function replyAllow(win: TestWindow, allow: boolean): void {
  win.webContents.send.mockImplementation(
    (channel: string, query?: { requestId?: string }) => {
      if (channel === CHANNELS.lifecyclePrepareCloseQuery) {
        emitReply(win, { requestId: query?.requestId ?? "", allow });
      }
    },
  );
}

interface RecoveryDialogStub {
  options: UnsavedGuardOptions;
  /** Windows the dialog was opened for, in invocation order. */
  windows: unknown[];
  showRecoveryDialog: ReturnType<typeof vi.fn>;
  /** Resolves the oldest still-pending dialog invocation. */
  choose: (choice: "wait" | "cancel" | "force") => void;
  readonly pending: number;
}

function stubRecoveryDialog(): RecoveryDialogStub {
  const windows: unknown[] = [];
  const resolvers: Array<(choice: "wait" | "cancel" | "force") => void> = [];
  const showRecoveryDialog = vi.fn((win: unknown) => {
    windows.push(win);
    return new Promise<"wait" | "cancel" | "force">((resolve) => {
      resolvers.push(resolve);
    });
  });
  return {
    options: { showRecoveryDialog },
    windows,
    showRecoveryDialog,
    choose: (choice) => {
      const resolve = resolvers.shift();
      if (!resolve) throw new Error("no pending recovery dialog to resolve");
      resolve(choice);
    },
    get pending() {
      return resolvers.length;
    },
  };
}

// markQuitting mutates module state with no reset export, so tests that assert
// plain window-close semantics first force a denial on a throwaway window.
// That resets quitting=false and makes them independent of test order.
async function resetQuitState(): Promise<void> {
  const warmup = makeWindow();
  replyAllow(warmup.win, false);
  warmup.close();
  await vi.advanceTimersByTimeAsync(0);
}

describe("desktop prepare-close guard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    electron.ipcMain.reset();
  });

  it("closes the window when the renderer allows the close", async () => {
    await resetQuitState();
    const { win, close } = makeWindow();
    replyAllow(win, true);

    close();
    await vi.waitFor(() => expect(win.close).toHaveBeenCalledOnce());

    expect(electron.app.quit).not.toHaveBeenCalled();
    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it("finishes a quit through app.quit once the renderer allows it", async () => {
    // The intent is captured at close-event time; later tests reset the
    // module-global flag themselves via resetQuitState.
    markQuitting();
    const { win, close } = makeWindow();
    replyAllow(win, true);

    close();
    await vi.waitFor(() => expect(electron.app.quit).toHaveBeenCalledOnce());
    expect(win.close).not.toHaveBeenCalled();
  });

  it("keeps the window open when the renderer denies the close", async () => {
    const { win, close } = makeWindow();
    replyAllow(win, false);

    close();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(win.close).not.toHaveBeenCalled();
    expect(electron.app.quit).not.toHaveBeenCalled();
  });

  it("keeps waiting past 20s and honors the eventual renderer decision", async () => {
    await resetQuitState();
    const { win, close } = makeWindow();

    close();
    await vi.advanceTimersByTimeAsync(60_000);
    close();
    expect(win.webContents.send).toHaveBeenCalledOnce();
    expect(win.close).not.toHaveBeenCalled();
    emitReply(win, { requestId: lastQueryRequestId(win), allow: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(win.close).toHaveBeenCalledOnce();
  });

  it("ignores replies without the current request id and keeps the handshake alive", async () => {
    await resetQuitState();
    const { win, close } = makeWindow();

    close();
    // A garbage payload and a pre-request-id { allow } both carry no matching
    // id: neither may settle the handshake, and neither may close the window.
    emitReply(win, "garbage");
    emitReply(win, { allow: true });
    await vi.advanceTimersByTimeAsync(20_000);

    expect(win.close).not.toHaveBeenCalled();
    expect(electron.app.quit).not.toHaveBeenCalled();

    // The handshake is still alive: a properly echoed reply still closes.
    emitReply(win, { requestId: lastQueryRequestId(win), allow: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(win.close).toHaveBeenCalledOnce();
  });

  it("settles the guard when the renderer dies mid-close and re-arms", async () => {
    const { win, close, contentsGone } = makeWindow();

    close();
    expect(win.webContents.send).toHaveBeenCalledOnce();

    contentsGone("render-process-gone");
    await vi.advanceTimersByTimeAsync(0);

    // The stalled guard settled, so a later close queries the renderer again
    // instead of hanging behind a permanently-busy handling flag.
    close();
    expect(win.webContents.send).toHaveBeenCalledTimes(2);
    expect(win.close).not.toHaveBeenCalled();
    expect(electron.app.quit).not.toHaveBeenCalled();
  });

  it("clears the countdown timer and ipcMain listener when the renderer dies mid-wait", async () => {
    const { close, contentsGone } = makeWindow();

    close();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.getTimerCount()).toBe(1);

    contentsGone("destroyed");
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.getTimerCount()).toBe(0);
    expect(
      electron.ipcMain.listenerCount(CHANNELS.lifecyclePrepareCloseReply),
    ).toBe(0);
  });

  describe("30s unresponsive-renderer recovery dialog", () => {
    it("offers the recovery dialog after 30s of renderer silence", async () => {
      await resetQuitState();
      const dlg = stubRecoveryDialog();
      const { win, close } = makeWindow(dlg.options);

      close();
      await vi.advanceTimersByTimeAsync(RECOVERY_DIALOG_TIMEOUT_MS - 1);
      expect(dlg.showRecoveryDialog).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(dlg.showRecoveryDialog).toHaveBeenCalledTimes(1);
      expect(dlg.windows[0]).toBe(win);
      expect(win.close).not.toHaveBeenCalled();
      expect(electron.app.quit).not.toHaveBeenCalled();
    });

    it("continue waiting keeps the handshake alive and re-offers the dialog after another 30s", async () => {
      await resetQuitState();
      const dlg = stubRecoveryDialog();
      const { win, close } = makeWindow(dlg.options);

      close();
      await vi.advanceTimersByTimeAsync(RECOVERY_DIALOG_TIMEOUT_MS);
      dlg.choose("wait");
      await vi.advanceTimersByTimeAsync(0);

      // "Wait" restarts nothing: the same single query is still in flight.
      expect(win.webContents.send).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(RECOVERY_DIALOG_TIMEOUT_MS);
      expect(dlg.showRecoveryDialog).toHaveBeenCalledTimes(2);

      // A later reply still works after two rounds of waiting.
      emitReply(win, { requestId: lastQueryRequestId(win), allow: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(win.close).toHaveBeenCalledOnce();
    });

    it("cancel close aborts the close, keeps the window open, and resets quit intent", async () => {
      await resetQuitState();
      const dlg = stubRecoveryDialog();
      const { win, close } = makeWindow(dlg.options);

      markQuitting();
      close();
      await vi.advanceTimersByTimeAsync(RECOVERY_DIALOG_TIMEOUT_MS);
      dlg.choose("cancel");
      await vi.advanceTimersByTimeAsync(0);

      expect(win.close).not.toHaveBeenCalled();
      expect(electron.app.quit).not.toHaveBeenCalled();

      // Quit intent was reset: the next confirmed close is a plain close.
      const second = makeWindow();
      replyAllow(second.win, true);
      second.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(second.win.close).toHaveBeenCalledOnce();
      expect(electron.app.quit).not.toHaveBeenCalled();
    });

    it("force close skips the handshake and closes the window; a late reply is ignored", async () => {
      await resetQuitState();
      const dlg = stubRecoveryDialog();
      const { win, close } = makeWindow(dlg.options);

      close();
      await vi.advanceTimersByTimeAsync(RECOVERY_DIALOG_TIMEOUT_MS);
      dlg.choose("force");
      await vi.advanceTimersByTimeAsync(0);

      expect(win.close).toHaveBeenCalledOnce();
      expect(electron.app.quit).not.toHaveBeenCalled();

      // The handshake was abandoned: even a well-formed allowing reply for the
      // CURRENT request id must not trigger a second decision.
      emitReply(win, { requestId: lastQueryRequestId(win), allow: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(win.close).toHaveBeenCalledOnce();
    });

    it("force close during a quit finishes the quit through app.quit", async () => {
      await resetQuitState();
      const dlg = stubRecoveryDialog();
      const { win, close } = makeWindow(dlg.options);

      markQuitting();
      close();
      await vi.advanceTimersByTimeAsync(RECOVERY_DIALOG_TIMEOUT_MS);
      dlg.choose("force");
      await vi.advanceTimersByTimeAsync(0);

      expect(electron.app.quit).toHaveBeenCalledOnce();
      expect(win.close).not.toHaveBeenCalled();
    });

    it("an allowing reply during the dialog finalizes the close and the dialog choice becomes a no-op", async () => {
      await resetQuitState();
      const dlg = stubRecoveryDialog();
      const { win, close } = makeWindow(dlg.options);

      close();
      await vi.advanceTimersByTimeAsync(RECOVERY_DIALOG_TIMEOUT_MS);
      expect(dlg.pending).toBe(1);

      emitReply(win, { requestId: lastQueryRequestId(win), allow: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(win.close).toHaveBeenCalledOnce();

      // The user's eventual dialog click must not execute a second decision.
      dlg.choose("force");
      await vi.advanceTimersByTimeAsync(0);
      expect(win.close).toHaveBeenCalledOnce();
      expect(electron.app.quit).not.toHaveBeenCalled();
    });

    it("a dialog decision that precedes the reply wins and a late reply is ignored", async () => {
      await resetQuitState();
      const dlg = stubRecoveryDialog();
      const { win, close } = makeWindow(dlg.options);

      close();
      await vi.advanceTimersByTimeAsync(RECOVERY_DIALOG_TIMEOUT_MS);
      dlg.choose("cancel");
      await vi.advanceTimersByTimeAsync(0);
      expect(win.close).not.toHaveBeenCalled();

      // Late allowing reply for the same handshake: the reply listener was
      // detached by the cancel decision, so the close stays aborted.
      emitReply(win, { requestId: lastQueryRequestId(win), allow: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(win.close).not.toHaveBeenCalled();
      expect(electron.app.quit).not.toHaveBeenCalled();
    });

    it("duplicate close events during a pending dialog do not re-query or stack dialogs", async () => {
      await resetQuitState();
      const dlg = stubRecoveryDialog();
      const { win, close } = makeWindow(dlg.options);

      close();
      await vi.advanceTimersByTimeAsync(RECOVERY_DIALOG_TIMEOUT_MS);
      close();
      close();
      await vi.advanceTimersByTimeAsync(RECOVERY_DIALOG_TIMEOUT_MS);

      expect(win.webContents.send).toHaveBeenCalledOnce();
      expect(dlg.showRecoveryDialog).toHaveBeenCalledOnce();
      expect(win.close).not.toHaveBeenCalled();
    });

    it("a stale request id from an earlier handshake is ignored", async () => {
      await resetQuitState();
      const dlg = stubRecoveryDialog();
      const { win, close } = makeWindow(dlg.options);

      close();
      const staleId = lastQueryRequestId(win);
      await vi.advanceTimersByTimeAsync(RECOVERY_DIALOG_TIMEOUT_MS);
      dlg.choose("cancel");
      await vi.advanceTimersByTimeAsync(0);

      // Cancel re-arms the guard: the next close starts a fresh handshake.
      close();
      const currentId = lastQueryRequestId(win);
      expect(currentId).not.toBe(staleId);

      emitReply(win, { requestId: staleId, allow: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(win.close).not.toHaveBeenCalled();

      emitReply(win, { requestId: currentId, allow: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(win.close).toHaveBeenCalledOnce();
    });

    it("renderer destroyed while the dialog is open settles and the dialog result is a no-op", async () => {
      const dlg = stubRecoveryDialog();
      const { win, close, contentsGone } = makeWindow(dlg.options);

      close();
      await vi.advanceTimersByTimeAsync(RECOVERY_DIALOG_TIMEOUT_MS);
      expect(dlg.pending).toBe(1);

      contentsGone("destroyed");
      await vi.advanceTimersByTimeAsync(0);

      expect(
        electron.ipcMain.listenerCount(CHANNELS.lifecyclePrepareCloseReply),
      ).toBe(0);
      expect(win.close).not.toHaveBeenCalled();
      expect(electron.app.quit).not.toHaveBeenCalled();

      // The abandoned dialog's later choice must not close anything.
      dlg.choose("force");
      await vi.advanceTimersByTimeAsync(0);
      expect(win.close).not.toHaveBeenCalled();
      expect(electron.app.quit).not.toHaveBeenCalled();
    });

    it("two windows closing concurrently stay isolated", async () => {
      await resetQuitState();
      const dlg = stubRecoveryDialog();
      const a = makeWindow(dlg.options);
      const b = makeWindow(dlg.options);

      a.close();
      b.close();
      expect(a.win.webContents.send).toHaveBeenCalledOnce();
      expect(b.win.webContents.send).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(RECOVERY_DIALOG_TIMEOUT_MS);
      expect(dlg.pending).toBe(2);
      expect(dlg.windows).toContain(a.win);
      expect(dlg.windows).toContain(b.win);

      // Force the first-asked window only.
      dlg.choose("force");
      await vi.advanceTimersByTimeAsync(0);
      expect(a.win.close).toHaveBeenCalledOnce();
      expect(b.win.close).not.toHaveBeenCalled();

      // a's force must not bypass b's handshake: b still needs its own reply.
      emitReply(b.win, { requestId: lastQueryRequestId(b.win), allow: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(b.win.close).toHaveBeenCalledOnce();
    });
  });
});
