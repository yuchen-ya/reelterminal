/**
 * Electron app launcher for the live-collaboration E2E (ADR 0004).
 *
 * One temp run dir per launch: `--user-data-dir` isolates the Chromium
 * profile (IndexedDB autosave, caches) and the live-artifacts root, while
 * OPENREEL_LIVE_ENDPOINT_FILE / OPENREEL_MCP_ENDPOINT_FILE redirect both
 * endpoint descriptor files so a test run never touches the developer's real
 * ~/.openreel files. (`--user-data-dir` is honored by Electron for
 * app.getPath("userData") — verified by e2e/scratch/probe.mjs.)
 *
 * Main-process stdout/stderr and every renderer console/pageerror line are
 * captured for the token-hygiene assertion: the live endpoint token must
 * never appear in any of them.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { DESKTOP_DIR, MAIN_BUNDLE_PATH, MCP_SHIM_PATH } from "./paths";

export interface LaunchedApp {
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly runDir: string;
  readonly userDataDir: string;
  /** Live endpoint descriptor path (OPENREEL_LIVE_ENDPOINT_FILE). */
  readonly endpointFile: string;
  /** Legacy MCP endpoint redirect (kept away from the real ~/.openreel). */
  readonly legacyEndpointFile: string;
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
  legacyEndpointFile: string;
} {
  const dir = runDir ?? mkdtempSync(path.join(tmpdir(), "openreel-e2e-"));
  mkdirSync(dir, { recursive: true });
  return {
    runDir: dir,
    userDataDir: path.join(dir, "user-data"),
    endpointFile: path.join(dir, "live-endpoint.json"),
    legacyEndpointFile: path.join(dir, "legacy-mcp-endpoint.json"),
  };
}

async function launch(paths: ReturnType<typeof makeRunDirs>): Promise<LaunchedApp> {
  if (!existsSync(MAIN_BUNDLE_PATH) || !existsSync(MCP_SHIM_PATH)) {
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
      OPENREEL_MCP_ENDPOINT_FILE: paths.legacyEndpointFile,
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

  let closed = false;
  const handle: LaunchedApp = {
    app,
    page,
    runDir: paths.runDir,
    userDataDir: paths.userDataDir,
    endpointFile: paths.endpointFile,
    legacyEndpointFile: paths.legacyEndpointFile,
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

    async close(options = {}) {
      if (closed) return;
      closed = true;
      const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 15_000;
      // A dirty project pops a NATIVE unsaved-changes dialog Playwright cannot
      // answer; race the graceful close against a force kill so teardown never
      // wedges the suite. Specs that need the graceful leg (save/reopen) call
      // project_save first, which flushes autosave and keeps the guard quiet.
      await Promise.race([
        app.close().catch(() => undefined),
        new Promise<void>((resolve) => {
          setTimeout(() => {
            try {
              app.process().kill("SIGKILL");
            } catch {
              /* already gone */
            }
            resolve();
          }, gracefulTimeoutMs);
        }),
      ]);
      if (!options.keepRunDir && !paths.runDir.includes("keep")) {
        rmSync(paths.runDir, { recursive: true, force: true });
      }
    },
  };

  return handle;
}

export async function launchApp(options: LaunchOptions = {}): Promise<LaunchedApp> {
  const paths = makeRunDirs(options.runDir);
  return launch(paths);
}
