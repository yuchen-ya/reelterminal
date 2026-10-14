import { beforeEach, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
const mocks = vi.hoisted(() => ({
  getSources: vi.fn(), buildFromTemplate: vi.fn(), popup: vi.fn(), setHandler: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { getLocale: () => "en-US" },
  desktopCapturer: { getSources: mocks.getSources },
  Menu: { buildFromTemplate: mocks.buildFromTemplate },
}));
import { installScreenCapture } from "./screen-capture";

const frame = { url: "app://reelterminal/index.html", detached: false };
const win = { isDestroyed: () => false, webContents: {
  mainFrame: frame, session: { setDisplayMediaRequestHandler: mocks.setHandler },
} } as unknown as BrowserWindow;
const source = { id: "screen:1:0", name: "Screen 1" };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSources.mockResolvedValue([source]);
  mocks.buildFromTemplate.mockReturnValue({ popup: mocks.popup });
  installScreenCapture(win);
});
const request = { frame, userGesture: true, audioRequested: false };
it("waits for an explicit source choice before granting capture", async () => {
  const callback = vi.fn();
  await mocks.setHandler.mock.calls[0][0](request, callback);
  expect(callback).not.toHaveBeenCalled();
  mocks.buildFromTemplate.mock.calls[0][0][2].click();
  mocks.popup.mock.calls[0][0].callback();
  expect(callback).toHaveBeenCalledExactlyOnceWith({ video: source });
});
it("rejects dismissal rather than silently selecting a screen", async () => {
  const callback = vi.fn();
  await mocks.setHandler.mock.calls[0][0](request, callback);
  mocks.popup.mock.calls[0][0].callback();
  expect(callback).toHaveBeenCalledExactlyOnceWith({});
});
it("rejects untrusted frames and requests without a user gesture", async () => {
  const callback = vi.fn();
  const handler = mocks.setHandler.mock.calls[0][0];
  await handler({ ...request, frame: { url: "https://example.com" } }, callback);
  await handler({ ...request, userGesture: false }, callback);
  expect(mocks.getSources).not.toHaveBeenCalled();
  expect(callback.mock.calls).toEqual([[{}], [{}]]);
});
it("rejects failed source enumeration so the renderer gets an error", async () => {
  mocks.getSources.mockRejectedValue(new Error("Access denied"));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const callback = vi.fn();
    await mocks.setHandler.mock.calls[0][0](request, callback);
    expect(callback).toHaveBeenCalledExactlyOnceWith({});
  } finally { log.mockRestore(); }
});
