import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  app: { exit: vi.fn() },
  // protocol/net are only referenced by ./protocol at runtime; the stubs keep
  // the electron mock importable for the whole module graph under test.
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  net: { fetch: vi.fn() },
  dialog: {
    showErrorBox: vi.fn(),
    showMessageBox: vi.fn(() => Promise.resolve({ response: 0 })),
  },
}));

vi.mock("electron", () => electron);

vi.mock("./crash-reporter", () => ({
  describeError: (value: unknown): { message: string; stack?: string } => {
    if (value instanceof Error) return { message: value.message };
    return { message: String(value) };
  },
  reportError: vi.fn(),
}));

import { reportError } from "./crash-reporter";
import {
  handleStartupFailure,
  installLoadFailureRecovery,
  installPreloadFailureNotice,
} from "./startup-failures";

const APP_INDEX = "app://reelterminal/index.html";

type Handler = (...args: unknown[]) => void;

const makeWindow = () => {
  const handlers = new Map<string, Set<Handler>>();
  const contents = {
    on: vi.fn((event: string, handler: Handler) => {
      const set = handlers.get(event) ?? new Set<Handler>();
      set.add(handler);
      handlers.set(event, set);
    }),
    loadURL: vi.fn(() => Promise.resolve(undefined)),
  };
  const fire = (event: string, ...args: unknown[]): void => {
    for (const handler of handlers.get(event) ?? []) handler(...args);
  };
  return { win: { webContents: contents }, contents, fire };
};

const lastLoadUrl = (contents: { loadURL: { mock: { calls: unknown[][] } } }): string =>
  String(contents.loadURL.mock.calls.at(-1)?.[0]);

describe("handleStartupFailure (whenReady catch)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports the failure, shows an understandable dialog, and exits non-zero", () => {
    handleStartupFailure(
      new Error("EACCES: permission denied, mkdir 'C:\\Users\\x\\Videos\\ReelTerminal'"),
    );

    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "startup-failure",
        source: "main",
        message: expect.stringContaining("EACCES"),
      }),
    );
    expect(electron.dialog.showErrorBox).toHaveBeenCalledWith(
      expect.stringContaining("start"),
      expect.stringContaining("EACCES"),
    );
    expect(electron.app.exit).toHaveBeenCalledWith(1);
  });

  it("stringifies non-Error rejection values instead of failing silently", () => {
    handleStartupFailure("work-mode preference unreadable");

    expect(electron.dialog.showErrorBox).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("work-mode preference unreadable"),
    );
    expect(electron.app.exit).toHaveBeenCalledWith(1);
  });
});

describe("installLoadFailureRecovery (did-fail-load)", () => {
  const failLoad = (
    win: ReturnType<typeof makeWindow>,
    errorCode: number,
    description: string,
    url = APP_INDEX,
    isMainFrame = true,
  ): void => {
    win.fire("did-fail-load", { preventDefault: vi.fn() }, errorCode, description, url, isMainFrame);
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing on the success path (no events fired)", () => {
    const win = makeWindow();
    installLoadFailureRecovery(win.win as never);
    expect(win.contents.loadURL).not.toHaveBeenCalled();
  });

  it("ignores ERR_ABORTED (-3) cancellations", () => {
    const win = makeWindow();
    installLoadFailureRecovery(win.win as never);

    failLoad(win, -3, "ERR_ABORTED", APP_INDEX);

    expect(win.contents.loadURL).not.toHaveBeenCalled();
  });

  it("ignores subframe (non main-frame) load failures", () => {
    const win = makeWindow();
    installLoadFailureRecovery(win.win as never);

    failLoad(win, -6, "ERR_FILE_NOT_FOUND", "app://reelterminal/assets/chunk.js", false);

    expect(win.contents.loadURL).not.toHaveBeenCalled();
  });

  it("retries the app URL automatically, then shows an inline error page", () => {
    const win = makeWindow();
    installLoadFailureRecovery(win.win as never);

    failLoad(win, -6, "ERR_FILE_NOT_FOUND");
    expect(win.contents.loadURL).toHaveBeenCalledWith(APP_INDEX);

    failLoad(win, -6, "ERR_FILE_NOT_FOUND");
    expect(win.contents.loadURL).toHaveBeenCalledWith(APP_INDEX);
    expect(win.contents.loadURL).toHaveBeenCalledTimes(2);

    failLoad(win, -6, "ERR_FILE_NOT_FOUND");
    const errorPageUrl = lastLoadUrl(win.contents);
    expect(errorPageUrl.startsWith("data:text/html")).toBe(true);
    expect(decodeURIComponent(errorPageUrl)).toContain("ERR_FILE_NOT_FOUND");
    expect(decodeURIComponent(errorPageUrl)).toContain("ReelTerminal");
  });

  it("shows the error page again after each manual retry fails (unlimited manual)", () => {
    const win = makeWindow();
    installLoadFailureRecovery(win.win as never);

    for (let i = 0; i < 3; i += 1) failLoad(win, -6, "ERR_FILE_NOT_FOUND");
    expect(win.contents.loadURL).toHaveBeenCalledTimes(3);

    // User clicks "Retry" on the inline page -> renderer-initiated navigation.
    win.fire("will-navigate", { preventDefault: vi.fn() }, APP_INDEX);
    failLoad(win, -6, "ERR_FILE_NOT_FOUND");
    expect(lastLoadUrl(win.contents).startsWith("data:text/html")).toBe(true);
    expect(win.contents.loadURL).toHaveBeenCalledTimes(4);
  });

  it("does not loop when the inline error page itself fails to load", () => {
    const win = makeWindow();
    installLoadFailureRecovery(win.win as never);

    for (let i = 0; i < 3; i += 1) failLoad(win, -6, "ERR_FILE_NOT_FOUND");
    const errorPageUrl = lastLoadUrl(win.contents);

    failLoad(win, -6, "ERR_ABORTED", errorPageUrl);
    expect(win.contents.loadURL).toHaveBeenCalledTimes(3);
  });
});

describe("installPreloadFailureNotice (preload-error)", () => {
  const failPreload = (
    win: ReturnType<typeof makeWindow>,
    error: Error,
    preloadPath = "C:\\app\\dist\\preload\\index.js",
  ): void => {
    win.fire("preload-error", { preventDefault: vi.fn() }, preloadPath, error);
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing when preload loads fine (no events fired)", () => {
    const win = makeWindow();
    installPreloadFailureNotice(win.win as never);
    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it("tells the user honestly that desktop integration failed instead of the silent shell fallback", () => {
    const win = makeWindow();
    installPreloadFailureNotice(win.win as never);

    failPreload(win, new Error("Unable to load preload script: ENOENT"));

    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    const [owner, options] = electron.dialog.showMessageBox.mock.calls[0] as unknown as [
      unknown,
      { title: string; message: string; detail: string },
    ];
    expect(owner).toBe(win.win);
    expect(options.message).toContain("desktop integration");
    expect(options.detail).toContain("preload");
    expect(options.detail).toContain("ENOENT");
  });

  it("notifies only once per window even if the preload fails on every reload", () => {
    const win = makeWindow();
    installPreloadFailureNotice(win.win as never);

    failPreload(win, new Error("boom"));
    failPreload(win, new Error("boom"));

    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });
});
