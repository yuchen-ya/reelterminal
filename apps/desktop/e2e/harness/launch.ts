/**
 * Electron app launcher for desktop end-to-end tests.
 *
 * One temp run dir per launch: `--user-data-dir` isolates the Chromium
 * profile (IndexedDB autosave, caches) and the live-artifacts root, while
 * REELTERMINAL_LIVE_ENDPOINT_FILE redirects the endpoint descriptor so a test run
 * never touches the developer's real ~/.reelterminal (or legacy ~/.openreel)
 * file. Electron uses `--user-data-dir` for app.getPath("userData").
 *
 * Main-process stdout/stderr and every renderer console/pageerror line are
 * captured for the token-hygiene assertion: the live endpoint token must
 * never appear in any of them.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import {
  DESKTOP_DIR,
  REELCTL_PATH,
  MAIN_BUNDLE_PATH,
  ARTIFACTS_DIR,
} from "./paths";
import {
  hasProcessExited,
  removeRunDirectory,
  waitForProcessExit,
} from "./teardown";

const FIRST_WINDOW_TIMEOUT_MS = 90_000;
const PAGE_LOAD_TIMEOUT_MS = 30_000;

export interface LaunchedApp {
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly runDir: string;
  readonly userDataDir: string;
  /** Live endpoint descriptor path (REELTERMINAL_LIVE_ENDPOINT_FILE). */
  readonly endpointFile: string;
  readonly output: {
    readonly mainStdout: string[];
    readonly mainStderr: string[];
    readonly rendererConsole: string[];
    readonly lifecycle: string[];
  };
  /** Poll (250 ms) until the live endpoint file exists. */
  waitForEndpointFile(timeoutMs?: number): Promise<void>;
  /** Full relaunch with the SAME userData (autosave recovery leg). */
  relaunch(): Promise<LaunchedApp>;
  /** Graceful close with a force-kill fallback (native unsaved dialog guard). */
  close(options?: { gracefulTimeoutMs?: number; keepRunDir?: boolean }): Promise<void>;
}

export interface LaunchOptions {
  /** Reuse a previous run dir (relaunch leg). */
  runDir?: string;
  /** Keep the temp dir after close (debugging). */
  keepRunDir?: boolean;
  /** Additional process env for hermetic provider fixtures. Isolation paths win. */
  env?: NodeJS.ProcessEnv;
  /** Prepared performance profiles already contain locale preferences; cold runs must not reload. */
  skipLocaleReload?: boolean;
}

function makeRunDirs(runDir?: string): {
  runDir: string;
  userDataDir: string;
  endpointFile: string;
} {
  const requestedDir = runDir ?? mkdtempSync(path.join(tmpdir(), "reelterminal-e2e-"));
  mkdirSync(requestedDir, { recursive: true });
  // Match production's canonical path handling, including Windows 8.3 aliases.
  const dir = realpathSync.native(requestedDir);
  mkdirSync(path.join(dir, "agent-workspace"), { recursive: true });
  return {
    runDir: dir,
    userDataDir: path.join(dir, "user-data"),
    endpointFile: path.join(dir, "live-endpoint.json"),
  };
}

async function launch(
  paths: ReturnType<typeof makeRunDirs>,
  extraEnv: NodeJS.ProcessEnv = {},
  skipLocaleReload = false,
): Promise<LaunchedApp> {
  if (!existsSync(MAIN_BUNDLE_PATH) || !existsSync(REELCTL_PATH)) {
    throw new Error(
      "desktop build missing — run `pnpm --filter @reelterminal/desktop build` before test:e2e",
    );
  }

  const mainStdout: string[] = [];
  const mainStderr: string[] = [];
  const rendererConsole: string[] = [];
  const lifecycle: string[] = [];
  const recordLifecycle = (event: string, detail?: unknown) =>
    lifecycle.push(JSON.stringify({ at: new Date().toISOString(), event, detail }));
  const safeUrl = (value: string): string => {
    try { const url = new URL(value); return `${url.origin}${url.pathname}`; }
    catch { return "unavailable"; }
  };

  const app = await electron.launch({
    ...(process.env.REELTERMINAL_E2E_APP_EXECUTABLE ? { executablePath: process.env.REELTERMINAL_E2E_APP_EXECUTABLE } : {}),
    args: [...(process.env.REELTERMINAL_E2E_APP_EXECUTABLE ? [] : ["."]), ...(process.env.REELTERMINAL_E2E_SOFTWARE_GL === "1" ? ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] : []), "--lang=en-US", `--user-data-dir=${paths.userDataDir}`],
    cwd: DESKTOP_DIR,
    env: {
      ...process.env,
      ...extraEnv,
      REELTERMINAL_USER_DATA_DIR: paths.userDataDir,
      REELTERMINAL_LIVE_ENDPOINT_FILE: paths.endpointFile,
      // The per-run directory is the only media root needed by import E2E;
      // every other spec simply observes the additional honest capability.
      REELTERMINAL_LIVE_MEDIA_ROOTS: [path.join(paths.runDir, "agent-workspace"), paths.runDir].join(path.delimiter),
      REELTERMINAL_AGENT_WORKSPACE_ROOT: path.join(paths.runDir, "agent-workspace"),
    },
    timeout: 120_000,
  });

  const proc = app.process();
  proc.stdout?.on("data", (chunk: Buffer) => mainStdout.push(chunk.toString("utf8")));
  proc.stderr?.on("data", (chunk: Buffer) => mainStderr.push(chunk.toString("utf8")));

  const seenPages = new WeakSet<Page>();
  const capturePage = (page: Page): void => {
    if (seenPages.has(page)) return;
    seenPages.add(page);
    page.on("console", (msg) => rendererConsole.push(`[${msg.type()}] ${msg.text()}`));
    page.on("pageerror", (error) => rendererConsole.push(`[pageerror] ${String(error)}`));
    page.on("framenavigated", frame => {
      if (frame === page.mainFrame()) recordLifecycle("navigation", { url: safeUrl(frame.url()) });
    });
    page.on("domcontentloaded", () => recordLifecycle("domcontentloaded"));
    page.on("load", () => recordLifecycle("load"));
    page.on("crash", () => recordLifecycle("renderer-crash"));
    page.on("close", () => recordLifecycle("window-close"));
    recordLifecycle("window-attached", { url: safeUrl(page.url()) });
  };
  app.on("window", capturePage);
  for (const existing of app.windows()) capturePage(existing);
  // Observation must not become a new startup gate if main is unresponsive.
  void app.evaluate(({ app, BrowserWindow }) => {
    const seen = new WeakSet();
    const observe = (contents: Electron.WebContents) => {
      if (seen.has(contents)) return;
      seen.add(contents);
      const record = (event: string, detail?: unknown) =>
        console.info("E2E_LIFECYCLE", JSON.stringify({ at: new Date().toISOString(), event, detail }));
      contents.on("did-fail-load", (_event, errorCode, _description, url, isMainFrame) => {
        let safeUrl = "unavailable";
        try { const parsed = new URL(url); safeUrl = `${parsed.origin}${parsed.pathname}`; } catch { /* no raw URL */ }
        record("did-fail-load", { errorCode, isMainFrame, url: safeUrl });
      });
      contents.on("render-process-gone", (_event, details) => record("render-process-gone", { reason: details.reason, exitCode: details.exitCode }));
      contents.on("unresponsive", () => record("unresponsive"));
      contents.on("responsive", () => record("responsive"));
    };
    app.on("web-contents-created", (_event, contents) => observe(contents));
    for (const window of BrowserWindow.getAllWindows()) observe(window.webContents);
  }).catch(() => recordLifecycle("main-observer-unavailable"));

  let page: Page;
  let firstWindowTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    page = await Promise.race([
      app.firstWindow(),
      new Promise<never>((_, reject) => {
        firstWindowTimer = setTimeout(
          () => reject(new Error(`No Electron window appeared within ${FIRST_WINDOW_TIMEOUT_MS}ms`)),
          FIRST_WINDOW_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    const diagnostics = [
      `Electron startup failed: ${error instanceof Error ? error.message : String(error)}`,
      `processId=${app.process().pid ?? "unknown"}`,
      `lifecycle tail: ${lifecycle.slice(-20).join("\n").replace(/\b[a-f0-9]{64}\b/gi, "[redacted]")}`,
      `main stdout tail: ${mainStdout.slice(-30).join("").replace(/\b[a-f0-9]{64}\b/gi, "[redacted]")}`,
      `main stderr tail: ${mainStderr.slice(-30).join("").replace(/\b[a-f0-9]{64}\b/gi, "[redacted]")}`,
    ].join("\n");
    try {
      const child = app.process();
      void app.close().catch(() => undefined);
      if (!hasProcessExited(child)) child.kill("SIGKILL");
      await waitForProcessExit(child, 5_000).catch(() => undefined);
    } catch {
      // Preserve the startup evidence; this app belongs to this E2E run.
    }
    throw new Error(diagnostics);
  } finally {
    if (firstWindowTimer) clearTimeout(firstWindowTimer);
  }
  capturePage(page);
  try {
    if (process.env.REELTERMINAL_E2E_SMALL_WINDOW === "1") {
      const contentSize = await app.evaluate(({ BrowserWindow }) => {
        const [window] = BrowserWindow.getAllWindows();
        if (!window) throw new Error("Electron window disappeared before resize");
        window.setContentSize(1024, 720);
        return window.getContentSize();
      });
      // macOS CI limits the requested height to its 700px desktop work area.
      // Fractional Windows display scaling can round the requested width down by
      // one DIP (1024 -> 1023). Keep the same bounded small-layout gate.
      // Both platforms still exercise the small layout with real pointer events.
      if (contentSize[0] < 1023 || contentSize[0] > 1024 || contentSize[1] < 700 || contentSize[1] > 720) {
        throw new Error(
          `Could not set E2E content to width 1023–1024 and height 700–720; actual content is ${contentSize[0]}x${contentSize[1]}`,
        );
      }
    }
    // firstWindow may expose about:blank before main starts loadURL. Its load
    // state is already complete, but storage is unavailable in that document.
    // Observe the renderer document directly: custom-scheme navigation can
    // finish before Playwright attaches its navigation lifecycle listener.
    await page.waitForFunction(() => location.href === "app://reelterminal/index.html" && document.readyState !== "loading", null, { timeout: PAGE_LOAD_TIMEOUT_MS });
    // Every desktop UI E2E uses English labels. The isolated profile has no
    // user preference, so explicitly seed that preference and reload before
    // a spec starts driving the UI (the host OS can be zh-CN).
    if (!skipLocaleReload) {
      await page.evaluate(() => localStorage.setItem("openreel-locale", "en"));
      await page.reload({ waitUntil: "domcontentloaded", timeout: PAGE_LOAD_TIMEOUT_MS });
    }
  } catch (error) {
    const pageState = await page.evaluate(() => ({
      url: `${location.origin}${location.pathname}`,
      language: document.documentElement.lang || navigator.language,
      title: document.title,
      bodyText: (document.body?.innerText ?? "").slice(0, 1_200),
    })).catch(() => null);
    const safePageState = JSON.stringify(pageState).replace(/\b[a-f0-9]{64}\b/gi, "[redacted]");
    const diagnostics = [
      `Electron window setup failed: ${error instanceof Error ? error.message : String(error)}`,
      `page=${safePageState}`,
      `lifecycle tail: ${lifecycle.slice(-20).join("\n").replace(/\b[a-f0-9]{64}\b/gi, "[redacted]")}`,
      `main stdout tail: ${mainStdout.slice(-30).join("").replace(/\b[a-f0-9]{64}\b/gi, "[redacted]")}`,
      `main stderr tail: ${mainStderr.slice(-30).join("").replace(/\b[a-f0-9]{64}\b/gi, "[redacted]")}`,
    ].join("\n");
    mkdirSync(ARTIFACTS_DIR, { recursive: true });
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, `launch-failure-${Date.now()}.png`), timeout: 5_000 }).catch(() => undefined);
    const child = app.process();
    // Exit the native app before killing its Windows command wrapper.
    void app.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    try {
      await waitForProcessExit(child, 5_000);
    } catch {
      if (!hasProcessExited(child)) child.kill("SIGKILL");
      await waitForProcessExit(child, 5_000);
    }
    throw new Error(diagnostics);
  }

  let closePromise: Promise<void> | undefined;
  const handle: LaunchedApp = {
    app,
    page,
    runDir: paths.runDir,
    userDataDir: paths.userDataDir,
    endpointFile: paths.endpointFile,
    output: { mainStdout, mainStderr, rendererConsole, lifecycle },

    async waitForEndpointFile(timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (existsSync(paths.endpointFile)) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(`live endpoint file not written within ${timeoutMs}ms: ${paths.endpointFile}`);
    },

    async relaunch() {
      await handle.close({ keepRunDir: true });
      return launch(paths, extraEnv, skipLocaleReload);
    },

    close(options = {}) {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 15_000;
        const child = proc;
        const errors: unknown[] = [];

        const killChild = (): void => {
          if (hasProcessExited(child)) return;
          const signalled = child.kill("SIGKILL");
          if (!signalled && !hasProcessExited(child)) {
            throw new Error("failed to send SIGKILL to the Electron process");
          }
        };

        // E2E profiles are disposable. Calling app.exit bypasses Chromium's
        // native before-unload dialog, which can block both close and relaunch.
        if (!hasProcessExited(child)) {
          void app.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
        }
        try {
          await waitForProcessExit(child, gracefulTimeoutMs);
        } catch {
          try {
            killChild();
          } catch (killError) {
            errors.push(killError);
          }
          try {
            await waitForProcessExit(child);
          } catch (error) {
            errors.push(error);
          }
        }

        if (!options.keepRunDir && !paths.runDir.includes("keep")) {
          try {
            // macOS profile helpers can finish their final directory writes just
            // after process exit. fs.rm's bounded ENOTEMPTY/EBUSY retry is awaited,
            // idempotent, and still propagates a persistent cleanup failure.
            await removeRunDirectory(paths.runDir);
          } catch (error) {
            errors.push(error);
          }
        }

        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) {
          throw new AggregateError(errors, "Electron E2E teardown failed");
        }
      })();
      return closePromise;
    },
  };

  return handle;
}

export async function launchApp(options: LaunchOptions = {}): Promise<LaunchedApp> {
  const paths = makeRunDirs(options.runDir);
  return launch(paths, options.env, options.skipLocaleReload);
}
