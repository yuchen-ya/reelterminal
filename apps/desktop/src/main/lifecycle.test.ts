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

import { attachUnsavedGuard } from "./lifecycle";
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

describe("desktop unsaved changes guard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    electron.ipcMain.reset();
  });

  it("treats an unsaved-query timeout as possibly dirty", async () => {
    electron.dialog.showMessageBox.mockResolvedValue({ response: 2 });
    const { win, close } = makeWindow();

    close();
    await vi.advanceTimersByTimeAsync(1500);
    await vi.waitFor(() => expect(electron.dialog.showMessageBox).toHaveBeenCalled());

    expect(win.close).not.toHaveBeenCalled();
    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith(
      win,
      expect.objectContaining({ title: "Unsaved changes" }),
    );
  });

  it("keeps the window open when a requested flush times out", async () => {
    electron.dialog.showMessageBox
      .mockResolvedValueOnce({ response: 0 })
      .mockResolvedValueOnce({ response: 0 });
    const { win, close } = makeWindow();
    win.webContents.send.mockImplementation((channel: string) => {
      if (channel === CHANNELS.lifecycleUnsavedQuery) {
        electron.ipcMain.emit(
          CHANNELS.lifecycleUnsavedReply,
          { sender: win.webContents },
          true,
        );
      }
    });

    close();
    await vi.waitFor(() =>
      expect(win.webContents.send).toHaveBeenCalledWith(CHANNELS.lifecycleFlush),
    );
    await vi.advanceTimersByTimeAsync(8000);
    await vi.waitFor(() =>
      expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(2),
    );

    expect(win.close).not.toHaveBeenCalled();
    expect(electron.dialog.showMessageBox).toHaveBeenLastCalledWith(
      win,
      expect.objectContaining({ title: "Could not save" }),
    );
  });
});
