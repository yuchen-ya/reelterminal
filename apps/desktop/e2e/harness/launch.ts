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
  LIVE_MCP_CONNECTOR_PATH,
  MAIN_BUNDLE_PATH,
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
}

function makeRunDirs(runDir?: string): {
  runDir: string;
  userDataDir: string;
  endpointFile: string;
} {
  const requestedDir = runDir ?? mkdtempSync(path.join(tmpdir(), "reelterminal-e2e-"));
  mkdirSync(requestedDir, { recursive: true });
  const dir = realpathSync(requestedDir);
  return {
    runDir: dir,
    userDataDir: path.join(dir, "user-data"),
    endpointFile: path.join(dir, "live-endpoint.json"),
  };
}

async function launch(
  paths: ReturnType<typeof makeRunDirs>,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<LaunchedApp> {
  if (!existsSync(MAIN_BUNDLE_PATH) || !existsSync(LIVE_MCP_CONNECTOR_PATH)) {
    throw new Error(
      "desktop build missing — run `pnpm --filter @reelterminal/desktop build` before test:e2e",
    );
  }

  const mainStdout: string[] = [];
  const mainStderr: string[] = [];
  const rendererConsole: string[] = [];

  const app = await electron.launch({
    args: [".", "--lang=en-US", `--user-data-dir=${paths.userDataDir}`],
    cwd: DESKTOP_DIR,
    env: {
      ...process.env,
      ...extraEnv,
      REELTERMINAL_USER_DATA_DIR: paths.userDataDir,
      REELTERMINAL_LIVE_ENDPOINT_FILE: paths.endpointFile,
      // The per-run directory is the only media root needed by import E2E;
      // every other spec simply observes the additional honest capability.
      REELTERMINAL_LIVE_MEDIA_ROOTS: paths.runDir,
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
  };
  app.on("window", capturePage);

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
  if (process.env.REELTERMINAL_E2E_SMALL_WINDOW === "1") {
    const contentSize = await app.evaluate(({ BrowserWindow }) => {
      const [window] = BrowserWindow.getAllWindows();
      if (!window) throw new Error("Electron window disappeared before resize");
      window.setContentSize(1024, 720);
      return window.getContentSize();
    });
    if (contentSize[0] !== 1024 || contentSize[1] !== 720) {
      throw new Error(
        `Could not set E2E content to 1024x720; actual content is ${contentSize[0]}x${contentSize[1]}`,
      );
    }
  }
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: PAGE_LOAD_TIMEOUT_MS });
    // Every desktop UI E2E uses English labels. The isolated profile has no
    // user preference, so explicitly seed that preference and reload before
    // a spec starts driving the UI (the host OS can be zh-CN).
    await page.evaluate(() => localStorage.setItem("openreel-locale", "en"));
    await page.reload({ waitUntil: "domcontentloaded", timeout: PAGE_LOAD_TIMEOUT_MS });
  } catch (error) {
    const pageState = await page.evaluate(() => ({
      url: `${location.origin}${location.pathname}`,
      language: document.documentElement.lang || navigator.language,
      title: document.title,
      bodyText: (document.body?.innerText ?? "").slice(0, 1_200),
    })).catch(() => null);
    const safePageState = JSON.stringify(pageState).replace(/\b[a-f0-9]{64}\b/gi, "[redacted]");
    const diagnostics = [
      `Electron page failed to load: ${error instanceof Error ? error.message : String(error)}`,
      `page=${safePageState}`,
      `main stdout tail: ${mainStdout.slice(-30).join("").replace(/\b[a-f0-9]{64}\b/gi, "[redacted]")}`,
      `main stderr tail: ${mainStderr.slice(-30).join("").replace(/\b[a-f0-9]{64}\b/gi, "[redacted]")}`,
    ].join("\n");
    const child = app.process();
    void app.close().catch(() => undefined);
    if (!hasProcessExited(child)) child.kill("SIGKILL");
    await waitForProcessExit(child, 5_000).catch(() => undefined);
    throw new Error(diagnostics);
  }

  let closePromise: Promise<void> | undefined;
  const handle: LaunchedApp = {
    app,
    page,
    runDir: paths.runDir,
    userDataDir: paths.userDataDir,
    endpointFile: paths.endpointFile,
    output: { mainStdout, mainStderr, rendererConsole },

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
      return launch(paths, extraEnv);
    },

    close(options = {}) {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 15_000;
        const child = app.process();
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
  return launch(paths, options.env);
}
