import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow, WebContents } from "electron";
import {
  getEditorWebContents,
  getEditorWindow,
  registerEditorWindow,
} from "./editor-window";

function fakeWindow() {
  let onClosed: (() => void) | null = null;
  const contents = {
    isDestroyed: vi.fn(() => false),
  } as unknown as WebContents;
  const window = {
    webContents: contents,
    isDestroyed: vi.fn(() => false),
    once: vi.fn((event: string, listener: () => void) => {
      if (event === "closed") onClosed = listener;
    }),
  } as unknown as BrowserWindow;
  return { window, contents, close: () => onClosed?.() };
}

describe("canonical editor window registry", () => {
  it("keeps explicit editor authority and ignores a stale window close", () => {
    const first = fakeWindow();
    const second = fakeWindow();
    registerEditorWindow(first.window);
    registerEditorWindow(second.window);

    first.close();
    expect(getEditorWindow()).toBe(second.window);
    expect(getEditorWebContents()).toBe(second.contents);

    second.close();
    expect(getEditorWindow()).toBeNull();
    expect(getEditorWebContents()).toBeNull();
  });
});
