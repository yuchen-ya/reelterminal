#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { open, readFile, unlink, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureBuildIdentity } from "../../apps/desktop/scripts/performance-build-identity.mjs";
import { parseRunOptions, PERFORMANCE_RUN_USAGE, runTimeoutMs } from "./run-options.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const desktopRoot = path.join(repositoryRoot, "apps", "desktop");
const vitestCli = path.join(desktopRoot, "node_modules", "vitest", "vitest.mjs");
const lockPath = path.join(tmpdir(), "reelterminal-performance-run.lock");

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function removeStaleLock() {
  let previousContent;
  try {
    previousContent = await readFile(lockPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }

  let previous;
  try {
    previous = JSON.parse(previousContent);
  } catch {
    return false;
  }
  if (!Number.isInteger(previous.pid) || previous.pid < 1 || processIsAlive(previous.pid)) return false;

  let currentContent;
  try {
    currentContent = await readFile(lockPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  if (currentContent !== previousContent) return false;

  try {
    await unlink(lockPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

async function acquireRunLock() {
  const lockData = JSON.stringify({ pid: process.pid, owner: randomUUID() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(lockData, "utf8");
      } catch (error) {
        await handle.close();
        await unlink(lockPath).catch((removeError) => {
          if (removeError?.code !== "ENOENT") throw removeError;
        });
        throw error;
      }
      return async () => {
        await handle.close();
        await unlink(lockPath).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (attempt === 0 && await removeStaleLock()) continue;
      throw new Error("another ReelTerminal performance run is already active");
    }
  }
  throw new Error("could not acquire the ReelTerminal performance run lock");
}

function stopProcessTree(child, signal) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    return;
  }

  const force = signal === "SIGKILL" ? ["/F"] : [];
  const taskkill = spawn(
    "taskkill",
    ["/PID", String(child.pid), "/T", ...force],
    { stdio: "ignore", windowsHide: true },
  );
  taskkill.on("error", () => child.kill(signal));
}

function runVitest(options) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [vitestCli, "run", "--config", "e2e/vitest.config.ts", "e2e/performance/scenarios.e2e.ts"],
      {
        cwd: desktopRoot,
        env: {
          ...process.env,
          REELTERMINAL_PERFORMANCE_OPTIONS: JSON.stringify(options),
        },
        stdio: "inherit",
        detached: process.platform !== "win32",
        windowsHide: true,
      },
    );

    let timedOut = false;
    let stopping = false;
    let forceTimer;
    const timeout = setTimeout(() => {
      timedOut = true;
      stop("SIGTERM");
    }, runTimeoutMs(options));

    const stop = (signal) => {
      if (stopping) return;
      stopping = true;
      stopProcessTree(child, signal);
      forceTimer = setTimeout(() => stopProcessTree(child, "SIGKILL"), 5_000);
    };
    const onInterrupt = () => stop("SIGTERM");
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onInterrupt);

    child.once("error", (error) => {
      clearTimeout(timeout);
      clearTimeout(forceTimer);
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onInterrupt);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(forceTimer);
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onInterrupt);
      if (timedOut) {
        reject(new Error("performance test exceeded its configured total timeout"));
      } else {
        resolve(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1));
      }
    });
  });
}

let releaseLock;
let options;
try {
  options = parseRunOptions(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${PERFORMANCE_RUN_USAGE}\n`);
  process.exitCode = 2;
}

if (options) {
  try {
    if (process.env.REELTERMINAL_E2E_APP_EXECUTABLE) {
      throw new Error("P2 requires the current checkout's production bundles; unset REELTERMINAL_E2E_APP_EXECUTABLE");
    }
    const identity = await captureBuildIdentity(repositoryRoot);
    if (!identity.build_verified) {
      const directory = path.join(desktopRoot, "e2e", ".artifacts", "performance");
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, `preflight-${randomUUID()}.json`), JSON.stringify({
        schema: "reelterminal.performance-preflight/v1", status: "invalid",
        reason_codes: ["unverified_build"], build: identity, options,
      }, null, 2));
      throw new Error(
        `performance E2E requires a matching production build stamp (${identity.build_reason}); run the desktop build first`,
      );
    }
    releaseLock = await acquireRunLock();
    process.exitCode = await runVitest(options);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    await releaseLock?.();
  }
}
