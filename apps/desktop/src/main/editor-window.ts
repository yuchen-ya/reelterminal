import type { BrowserWindow, WebContents } from "electron";

/**
 * Explicit authority for the canonical editor window.
 *
 * Live project IPC must never infer authority from BrowserWindow enumeration:
 * a future settings/export window could otherwise become the first window and
 * receive project requests. The creation layer registers the editor once and
 * close teardown clears only the matching instance.
 */
let editorWindow: BrowserWindow | null = null;
let readyRenderer: WebContents | null = null;

export function registerEditorWindow(window: BrowserWindow): void {
  editorWindow = window;
  const contents = window.webContents;
  // A newly-created/reloading renderer must announce that its live bridge
  // listener has been installed before the main process sends store calls.
  readyRenderer = null;
  contents.on("did-start-loading", () => {
    if (readyRenderer === contents) readyRenderer = null;
  });
  window.once("closed", () => {
    if (editorWindow === window) {
      editorWindow = null;
      if (readyRenderer === contents) readyRenderer = null;
    }
  });
}

export function markEditorRendererReady(contents: WebContents): void {
  if (getEditorWebContents() === contents) readyRenderer = contents;
}

export function isEditorRendererReady(contents: WebContents): boolean {
  return readyRenderer === contents;
}

export function getEditorWindow(): BrowserWindow | null {
  return editorWindow && !editorWindow.isDestroyed() ? editorWindow : null;
}

export function getEditorWebContents(): WebContents | null {
  const contents = getEditorWindow()?.webContents;
  return contents && !contents.isDestroyed() ? contents : null;
}
