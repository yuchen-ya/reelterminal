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

export function registerEditorWindow(window: BrowserWindow): void {
  editorWindow = window;
  window.once("closed", () => {
    if (editorWindow === window) editorWindow = null;
  });
}

export function getEditorWindow(): BrowserWindow | null {
  return editorWindow && !editorWindow.isDestroyed() ? editorWindow : null;
}

export function getEditorWebContents(): WebContents | null {
  const contents = getEditorWindow()?.webContents;
  return contents && !contents.isDestroyed() ? contents : null;
}
