/**
 * Browser process cleanup probe.
 *
 * Decision 7 gives the transport ownership of signals; the residue row for
 * SIGKILL/hard-crash relies on Chromium dying with the process. Upstream
 * marks Playwright's zombie protection 未验证 per platform — this probe
 * verifies process cleanup on the running host and reports the result in
 * `doctor`'s JSON.
 *
 * Method: a child process launches Chromium through playwright-core
 * exactly as the runtime does (headless, pipe transport, signal handlers
 * disabled — the embedder owns signals), prints the browser's OS pid, then
 * SIGKILLs ITSELF (the browser's parent). The parent of the probe (doctor)
 * then watches whether the orphaned browser process actually disappears.
 *
 * Caveat, reported with the finding: a zombie that no one reaps would
 * still answer `kill(pid, 0)`; on macOS orphans are re-parented to launchd
 * which reaps promptly, on Linux to init. A pid that survives the wait
 * window is reported as NOT reaped.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { logDebug } from "./log";

export interface ReaperFinding {
  /** False when the probe could not run at all (see reason). */
  readonly verified: boolean;
  /** null when not verified. */
  readonly reaped: boolean | null;
  readonly platform: string;
  readonly method: string;
  readonly waitMs: number;
  readonly browserPid?: number;
  readonly reason?: string;
}

/** Resolve playwright-core from the workspace's runtime-chromium package. */
export function resolvePlaywrightCore(): string | null {
  // Both src/ (tests) and dist/ (built binary) sit exactly one directory
  // below the package root, so ../.. is the workspace packages/ directory.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const runtimePkg = path.resolve(here, "..", "..", "runtime-chromium", "package.json");
  try {
    const req = createRequire(runtimePkg);
    return path.dirname(req.resolve("playwright-core/package.json"));
  } catch {
    return null;
  }
}

const CHILD_SCRIPT = `
const req = require("module").createRequire(process.env.REAPER_RUNTIME_PKG + "/package.json");
const { chromium } = req("playwright-core");
const cp = require("child_process");
(async () => {
  try {
    const browser = await chromium.launch({
      headless: true,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
    let pids = [];
    try {
      const proc = browser.process();
      if (proc && proc.pid) pids = [proc.pid];
    } catch (e) { /* process() unavailable on this playwright build */ }
    if (pids.length === 0) {
      // Fallback: direct children of this probe process include the browser
      // process (plus helpers); report them all.
      try {
        pids = cp.execSync("pgrep -P " + process.pid).toString().trim()
          .split("\\n").map(Number).filter(Number.isFinite);
      } catch (e) { pids = []; }
    }
    process.stdout.write(JSON.stringify({ pids }) + "\\n");
    // Hard-kill SELF (the browser's parent) — nothing in-process can run.
    setTimeout(() => process.kill(process.pid, "SIGKILL"), 100);
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: String((error && error.message) || error) }) + "\\n");
    process.exit(3);
  }
})();
`;

const REAPER_WAIT_MS = 10_000;
const POLL_MS = 250;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function verifyBrowserReaper(): Promise<ReaperFinding> {
  const platform = process.platform;
  const method = "SIGKILL the parent of a launched Chromium; watch the child pid";
  const runtimePkgDir = resolvePlaywrightCore();
  if (runtimePkgDir === null) {
    return {
      verified: false,
      reaped: null,
      platform,
      method,
      waitMs: REAPER_WAIT_MS,
      reason: "playwright-core could not be resolved from @reelterminal/runtime-chromium",
    };
  }

  const child = spawn(process.execPath, ["-e", CHILD_SCRIPT], {
    env: { ...process.env, REAPER_RUNTIME_PKG: runtimePkgDir },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const finding = await new Promise<ReaperFinding>((resolveProbe) => {
    let stdout = "";
    let childDied = false;
    const timer = setTimeout(() => {
      if (!childDied) child.kill("SIGKILL");
      resolveProbe({
        verified: false,
        reaped: null,
        platform,
        method,
        waitMs: REAPER_WAIT_MS,
        reason: "reaper probe child timed out",
      });
    }, REAPER_WAIT_MS + 5_000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("close", async (code) => {
      childDied = true;
      const line = stdout.split("\n").find((candidate) => candidate.trim().length > 0);
      let parsed: { pids?: number[]; error?: string } = {};
      try {
        parsed = line === undefined ? {} : (JSON.parse(line) as typeof parsed);
      } catch {
        // fallthrough
      }
      if (parsed.error !== undefined) {
        clearTimeout(timer);
        resolveProbe({
          verified: false,
          reaped: null,
          platform,
          method,
          waitMs: REAPER_WAIT_MS,
          reason: `probe child failed to launch Chromium: ${parsed.error}`,
        });
        return;
      }
      const pids = Array.isArray(parsed.pids) ? parsed.pids.filter((p) => Number.isFinite(p)) : [];
      if (pids.length === 0) {
        clearTimeout(timer);
        resolveProbe({
          verified: false,
          reaped: null,
          platform,
          method,
          waitMs: REAPER_WAIT_MS,
          reason: `probe child produced no browser pid (exit code ${code})`,
        });
        return;
      }
      // The parent is dead; watch the orphaned browser pid(s).
      const deadline = Date.now() + REAPER_WAIT_MS;
      const alive = (): boolean => pids.some(pidAlive);
      while (Date.now() < deadline && alive()) {
        await new Promise((resolveSleep) => setTimeout(resolveSleep, POLL_MS));
      }
      const reaped = !alive();
      logDebug("doctor", "reaper probe observed browser pids", { pids, reaped });
      clearTimeout(timer);
      resolveProbe({
        verified: true,
        reaped,
        platform,
        method,
        waitMs: REAPER_WAIT_MS,
        browserPid: pids[0],
        ...(reaped
          ? {}
          : {
              reason:
                "browser process outlived its SIGKILLed parent — orphaned Chromium children are possible here; explicit reaping belongs on the Desktop-MCP track",
            }),
      });
    });
  });

  return finding;
}
