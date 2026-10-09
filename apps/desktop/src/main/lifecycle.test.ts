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

const makeWindow = () => {
  let closeHandler: ((event: CloseEvent) => void) | undefined;
  const win = {
    on: vi.fn((event: string, handler: (event: CloseEvent) => void) => {
      if (event === "close") closeHandler = handler;
    }),
    close: vi.fn(),
    isDestroyed: vi.fn(() => false),
    webContents: {
      send: vi.fn(),
    },
  };
  attachUnsavedGuard(win as never);
  return {
    win,
    close: () => closeHandler?.({ preventDefault: vi.fn() }),
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

describe("desktop prepare-close guard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    electron.ipcMain.reset();
  });

  it("closes the window when the renderer allows the close", async () => {
    const { win, close } = makeWindow();
    replyAllow(win, { allow: true });

    close();
    await vi.waitFor(() => expect(win.close).toHaveBeenCalledOnce());

    expect(electron.app.quit).not.toHaveBeenCalled();
    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it("finishes a quit through app.quit once the renderer allows it", async () => {
    // markQuitting mutates module state with no reset export; the deny test
    // right after this one resets quitting=false, keeping later assertions
    // (window close instead of app.quit) valid.
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

  it("proceeds with the close when the renderer never replies (20s timeout)", async () => {
    // Silence means persistence is continuous (drafts are written during
    // editing); a wedged renderer must not trap the user in an uncloseable
    // window.
    const { win, close } = makeWindow();

    close();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(win.close).toHaveBeenCalledOnce();
  });

  it("treats a malformed reply as a denial rather than a silent close", async () => {
    const { win, close } = makeWindow();
    replyAllow(win, "garbage");

    close();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(win.close).not.toHaveBeenCalled();
  });
});
