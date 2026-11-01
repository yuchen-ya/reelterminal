import { beforeEach, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
const mocks = vi.hoisted(() => ({
  getLocale: vi.fn(), getSources: vi.fn(), buildFromTemplate: vi.fn(), popup: vi.fn(), setHandler: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { getLocale: mocks.getLocale },
  desktopCapturer: { getSources: mocks.getSources },
  Menu: { buildFromTemplate: mocks.buildFromTemplate },
}));
import { installScreenCapture } from "./screen-capture";
import { setUiLocale } from "./ui-locale";

const frame = { url: "app://reelterminal/index.html", detached: false };
const win = { isDestroyed: () => false, webContents: {
  mainFrame: frame, session: { setDisplayMediaRequestHandler: mocks.setHandler },
} } as unknown as BrowserWindow;
const source = { id: "screen:1:0", name: "Screen 1" };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getLocale.mockReturnValue("en-US");
  setUiLocale("en");
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

it.each([
  { system: "zh-CN", chosen: "en" as const, title: "Choose a screen or window to record", cancel: "Cancel" },
  { system: "en-US", chosen: "zh-CN" as const, title: "选择要录制的屏幕或窗口", cancel: "取消" },
])("uses the chosen $chosen UI locale on a $system system for the app fallback menu", async ({ system, chosen, title, cancel }) => {
  mocks.getLocale.mockReturnValue(system);
  setUiLocale(chosen);
  await mocks.setHandler.mock.calls[0][0](request, vi.fn());
  const menu = mocks.buildFromTemplate.mock.calls[0][0];
  expect(menu[0].label).toBe(title);
  expect(menu.at(-1).label).toBe(cancel);
  expect(menu[2].label).toBe(source.name); // OS source/window names are data.
});
