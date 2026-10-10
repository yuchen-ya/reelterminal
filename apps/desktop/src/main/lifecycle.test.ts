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
    reset: () => listeners.clear(),
  };
  return {
    app: { quit: vi.fn() },
    dialog: { showMessageBox: vi.fn() },
    ipcMain,
  };
});

vi.mock("electron", () => electron);

import { attachUnsavedGuard, markQuitting } from "./lifecycle";
import { CHANNELS } from "../shared/ipc-contract";

type CloseEvent = { preventDefault: ReturnType<typeof vi.fn> };
type ContentsListener = (payload?: unknown) => void;

const makeWindow = () => {
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
  attachUnsavedGuard(win as never);
  return {
    win,
    close: () => closeHandler?.({ preventDefault: vi.fn() }),
    contentsGone: (event: string) => webContents.emit(event),
  };
};

function replyAllow(
  win: ReturnType<typeof makeWindow>["win"],
  payload: unknown,
): void {
  win.webContents.send.mockImplementation((channel: string) => {
    if (channel === CHANNELS.lifecyclePrepareCloseQuery) {
      electron.ipcMain.emit(
        CHANNELS.lifecyclePrepareCloseReply,
        { sender: win.webContents },
        payload,
      );
    }
  });
}

// markQuitting mutates module state with no reset export, so tests that assert
// plain window-close semantics first force a denial on a throwaway window.
// That resets quitting=false and makes them independent of test order.
async function resetQuitState(): Promise<void> {
  const warmup = makeWindow();
  replyAllow(warmup.win, { allow: false });
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
    replyAllow(win, { allow: true });

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
    replyAllow(win, { allow: true });

    close();
    await vi.waitFor(() => expect(electron.app.quit).toHaveBeenCalledOnce());
    expect(win.close).not.toHaveBeenCalled();
  });

  it("keeps the window open when the renderer denies the close", async () => {
    const { win, close } = makeWindow();
    replyAllow(win, { allow: false });

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
    electron.ipcMain.emit(CHANNELS.lifecyclePrepareCloseReply, { sender: win.webContents }, { allow: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(win.close).toHaveBeenCalledOnce();
  });

  it("treats a malformed reply as a denial rather than a silent close", async () => {
    const { win, close } = makeWindow();
    replyAllow(win, "garbage");

    close();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(win.close).not.toHaveBeenCalled();
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
});
