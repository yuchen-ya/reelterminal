import { app, dialog, type BrowserWindow } from "electron";
import { APP_INDEX } from "./protocol";
import { describeError, reportError } from "./crash-reporter";

// Chromium net error code for "aborted": the load was cancelled because a newer
// navigation superseded it (reload, a second loadURL, window teardown). It is
// how a superseded load reports, not a real failure, so it must not trigger
// recovery. Electron does not export net error constants.
const ERR_ABORTED = -3;
// Automatic retries of the app URL after a main-frame load failure. Past this,
// the user gets an honest inline error page with a Retry action (manual
// retries are unlimited); repeated identical auto-reloads would only mask an
// installation-level problem.
const MAX_AUTO_RETRIES = 2;

/**
 * Handler for a rejected `app.whenReady()` chain: host construction
 * can throw before `createWindow()` (e.g. `mkdirSync` on an unwritable
 * userData/Videos path), which used to leave a live process with no window and
 * no dialog. Reports, tells the user, and exits with a non-zero code so the
 * failure is never silent.
 *
 * English-only copy: the main process has no i18n; every existing native
 * dialog in this process (lifecycle.ts) is English.
 */
export function handleStartupFailure(reason: unknown): void {
  const { message } = describeError(reason);
  reportError({ type: "startup-failure", source: "main", message });
  dialog.showErrorBox(
    "ReelTerminal failed to start",
    "ReelTerminal could not finish starting up and must close.\n\n" +
      `${message}\n\n` +
      "If this keeps happening, check that your user data and media folders " +
      "are writable, then reinstall the application.",
  );
  app.exit(1);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Self-contained inline failure page (no renderer assets — they may be exactly
// what is missing). Retry navigates to the app origin, which the same-origin
// navigation guard allows; the guard is not consulted for main-process
// loadURL calls, so loading this page itself cannot be blocked.
function loadErrorPageUrl(errorCode: number, errorDescription: string): string {
  const html =
    "<!doctype html><html><head><meta charset='utf-8'><title>ReelTerminal</title></head>" +
    "<body style='font-family:system-ui,sans-serif;background:#1b1b20;color:#e8e8ec;" +
    "display:flex;align-items:center;justify-content:center;height:100vh;margin:0'>" +
    "<div style='max-width:560px;padding:32px'>" +
    "<h1 style='font-size:20px;font-weight:600;margin:0 0 12px'>ReelTerminal failed to load</h1>" +
    `<p style='margin:0 0 8px'>The interface could not be loaded (error ${errorCode}: ` +
    `${escapeHtml(errorDescription)}). This usually means the installation is ` +
    "incomplete or a security tool quarantined application files.</p>" +
    "<p style='margin:0 0 20px'>If retrying does not help, reinstall the application.</p>" +
    `<button onclick='location.href="${APP_INDEX}"' style='font:inherit;padding:8px 20px;` +
    "border-radius:6px;border:1px solid #4a4a55;background:#2c2c33;color:#e8e8ec;" +
    "cursor:pointer'>Retry</button>" +
    "</div></body></html>";
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/**
 * Recovers from main-frame load failures of the editor window (missing
 * renderer assets, AV quarantine, protocol handler faults used to leave a
 * permanent white screen with only Ctrl+R). Registers `did-fail-load`
 * plus a passive `will-navigate` reset that never blocks navigation; the
 * success path is untouched. Auto-retries are limited, after which
 * an inline error page with a working Retry action is shown (manual retries
 * are unlimited).
 */
export function installLoadFailureRecovery(win: BrowserWindow): void {
  const contents = win.webContents;
  let autoRetries = 0;
  // True while the inline error page is the loaded document, so a failure of
  // the page itself can never recurse. Cleared by renderer-initiated
  // navigation (the Retry button) — plain loadURL calls do not emit
  // will-navigate, so programmatic loads never clear it.
  let showingErrorPage = false;

  contents.on("will-navigate", () => {
    showingErrorPage = false;
  });

  contents.on(
    "did-fail-load",
    (
      _event: unknown,
      errorCode: number,
      errorDescription: string,
      _validatedURL: string,
      isMainFrame: boolean,
    ) => {
      if (!isMainFrame) return;
      if (errorCode === ERR_ABORTED) return;
      if (showingErrorPage) return;
      if (autoRetries < MAX_AUTO_RETRIES) {
        autoRetries += 1;
        // The rejection is already represented by this did-fail-load event.
        void contents.loadURL(APP_INDEX).catch(() => undefined);
        return;
      }
      showingErrorPage = true;
      void contents
        .loadURL(loadErrorPageUrl(errorCode, errorDescription))
        .catch(() => undefined);
    },
  );
}

/**
 * Honest notification when the preload bridge fails to inject:
 * without `window.openreel` the renderer silently falls back to the browser
 * shell, so the user used to get a window that looked normal while native
 * menu, native export, updates, and lifecycle flush were all gone. This only
 * informs — it creates no substitute desktop API.
 *
 * `preload-error` fires both when the preload file cannot be loaded (missing
 * or quarantined) and when it throws, covering the installed-build corruption
 * cases. English-only copy: the main process has no i18n.
 */
export function installPreloadFailureNotice(win: BrowserWindow): void {
  let notified = false;
  win.webContents.on("preload-error", (_event, preloadPath: string, error: Error) => {
    if (notified) return;
    notified = true;
    void dialog
      .showMessageBox(win, {
        type: "warning",
        title: "ReelTerminal desktop integration failed",
        message:
          "ReelTerminal could not load its desktop integration layer (preload script). " +
          "The window will open without native features such as the native menu, " +
          "video export, and automatic updates.",
        detail: `Preload script: ${preloadPath}\n${describeError(error).message}`,
      })
      .catch(() => undefined);
  });
}
