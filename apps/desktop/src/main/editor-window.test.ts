import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow, WebContents } from "electron";
import {
  isEditorRendererReady,
  getEditorWebContents,
  getEditorWindow,
  markEditorRendererReady,
  registerEditorWindow,
} from "./editor-window";

function fakeWindow() {
  let onClosed: (() => void) | null = null;
  let onStartLoading: (() => void) | null = null;
  const contents = {
    isDestroyed: vi.fn(() => false),
    on: vi.fn((event: string, listener: () => void) => {
      if (event === "did-start-loading") onStartLoading = listener;
    }),
  } as unknown as WebContents;
  const window = {
    webContents: contents,
    isDestroyed: vi.fn(() => false),
    once: vi.fn((event: string, listener: () => void) => {
      if (event === "closed") onClosed = listener;
    }),
  } as unknown as BrowserWindow;
  return {
    window,
    contents,
    close: () => onClosed?.(),
    startLoading: () => onStartLoading?.(),
  };
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

  it("requires the active renderer to announce bridge readiness after each load", () => {
    const first = fakeWindow();
    const second = fakeWindow();
    registerEditorWindow(first.window);
    markEditorRendererReady(first.contents);
    expect(isEditorRendererReady(first.contents)).toBe(true);

    registerEditorWindow(second.window);
    expect(isEditorRendererReady(first.contents)).toBe(false);
    expect(isEditorRendererReady(second.contents)).toBe(false);
    markEditorRendererReady(second.contents);
    expect(isEditorRendererReady(second.contents)).toBe(true);

    second.startLoading();
    expect(isEditorRendererReady(second.contents)).toBe(false);
  });
});
