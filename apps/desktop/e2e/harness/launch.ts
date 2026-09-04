/**
 * Electron app launcher for the live-collaboration E2E (ADR 0004).
 *
 * One temp run dir per launch: `--user-data-dir` isolates the Chromium
 * profile (IndexedDB autosave, caches) and the live-artifacts root, while
 * OPENREEL_LIVE_ENDPOINT_FILE redirects the endpoint descriptor so a test run
 * never touches the developer's real ~/.openreel file. (`--user-data-dir` is
 * honored by Electron for app.getPath("userData") — verified by
 * e2e/scratch/probe.mjs.)
 *
 * Main-process stdout/stderr and every renderer console/pageerror line are
 * captured for the token-hygiene assertion: the live endpoint token must
 * never appear in any of them.
 */
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
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

export interface LaunchedApp {
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly runDir: string;
  readonly userDataDir: string;
  /** Live endpoint descriptor path (OPENREEL_LIVE_ENDPOINT_FILE). */
  readonly endpointFile: string;
  /** External conversation descriptor path (isolated from the user's home). */
  readonly conversationEndpointFile: string;
  /** Main-owned visual-state image root shared only with the test adapter. */
  readonly conversationVisualStateRoot: string;
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
}

function makeRunDirs(runDir?: string): {
  runDir: string;
  userDataDir: string;
  endpointFile: string;
  conversationEndpointFile: string;
  conversationVisualStateRoot: string;
} {
  const dir = runDir ?? mkdtempSync(path.join(tmpdir(), "openreel-e2e-"));
  mkdirSync(dir, { recursive: true });
  return {
    runDir: dir,
    userDataDir: path.join(dir, "user-data"),
    endpointFile: path.join(dir, "live-endpoint.json"),
    conversationEndpointFile: path.join(dir, "conversation-endpoint.json"),
    conversationVisualStateRoot: path.join(dir, "conversation-visual-state"),
  };
}

async function launch(paths: ReturnType<typeof makeRunDirs>): Promise<LaunchedApp> {
  if (!existsSync(MAIN_BUNDLE_PATH) || !existsSync(LIVE_MCP_CONNECTOR_PATH)) {
    throw new Error(
      "desktop build missing — run `pnpm --filter @openreel/desktop build` before test:e2e",
    );
  }

  const mainStdout: string[] = [];
  const mainStderr: string[] = [];
  const rendererConsole: string[] = [];

  const app = await electron.launch({
    args: [".", `--user-data-dir=${paths.userDataDir}`],
    cwd: DESKTOP_DIR,
    env: {
      ...process.env,
      OPENREEL_LIVE_ENDPOINT_FILE: paths.endpointFile,
      // The per-run directory is the only media root needed by import E2E;
      // every other spec simply observes the additional honest capability.
      OPENREEL_LIVE_MEDIA_ROOTS: paths.runDir,
      OPENREEL_CONVERSATION_ENDPOINT_FILE: paths.conversationEndpointFile,
      OPENREEL_CONVERSATION_VISUAL_STATE_ROOT: paths.conversationVisualStateRoot,
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

  const page = await app.firstWindow();
  capturePage(page);
  await page.waitForLoadState("domcontentloaded");

  let closePromise: Promise<void> | undefined;
  const handle: LaunchedApp = {
    app,
    page,
    runDir: paths.runDir,
    userDataDir: paths.userDataDir,
    endpointFile: paths.endpointFile,
    conversationEndpointFile: paths.conversationEndpointFile,
    conversationVisualStateRoot: paths.conversationVisualStateRoot,
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
      return launch(paths);
    },

    close(options = {}) {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 15_000;
        const child = app.process();
        const errors: unknown[] = [];
        const appClosePromise = app.close();
        let forced = false;
        let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

        const killChild = (): void => {
          if (hasProcessExited(child)) return;
          const signalled = child.kill("SIGKILL");
          if (!signalled && !hasProcessExited(child)) {
            throw new Error("failed to send SIGKILL to the Electron process");
          }
        };

        // A dirty project pops a NATIVE unsaved-changes dialog Playwright cannot
        // answer; race the graceful close against a force kill so teardown never
        // wedges the suite. Specs that need the graceful leg (save/reopen) call
        // project_save first, which flushes autosave and keeps the guard quiet.
        const forceKill = new Promise<void>((resolve, reject) => {
          forceKillTimer = setTimeout(() => {
            forced = true;
            try {
              killChild();
              resolve();
            } catch (error) {
              reject(error);
            }
          }, gracefulTimeoutMs);
        });

        try {
          await Promise.race([appClosePromise, forceKill]);
        } catch (error) {
          // Preserve the real close error, but still take ownership of process
          // exit and directory cleanup before surfacing it.
          errors.push(error);
          try {
            killChild();
          } catch (killError) {
            errors.push(killError);
          }
        } finally {
          if (forceKillTimer) clearTimeout(forceKillTimer);
        }

        // A SIGKILL request is not process-exit readiness. Chromium descendants
        // can still touch the profile until Electron actually exits.
        try {
          await waitForProcessExit(child);
        } catch (error) {
          errors.push(error);
        }

        // If the force-kill path won the race, observe app.close()'s eventual
        // outcome too. This keeps a late close failure visible and is bounded.
        if (forced) {
          let settleTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              appClosePromise,
              new Promise<never>((_, reject) => {
                settleTimer = setTimeout(
                  () => reject(new Error("app.close() did not settle after Electron exited")),
                  5_000,
                );
              }),
            ]);
          } catch (error) {
            errors.push(error);
          } finally {
            if (settleTimer) clearTimeout(settleTimer);
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
  return launch(paths);
}
