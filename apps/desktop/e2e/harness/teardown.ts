import type { ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";

const PROCESS_EXIT_TIMEOUT_MS = 5_000;
const REMOVE_MAX_RETRIES = 10;
const REMOVE_RETRY_DELAY_MS = 100;

export function hasProcessExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Wait for actual process exit; sending SIGKILL alone is not readiness. */
export async function waitForProcessExit(
  child: ChildProcess,
  timeoutMs = PROCESS_EXIT_TIMEOUT_MS,
): Promise<void> {
  if (hasProcessExited(child)) return;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const onExit = (): void => finish();
    const timer = setTimeout(
      () => finish(new Error(`Electron process did not exit within ${timeoutMs}ms`)),
      timeoutMs,
    );
    child.once("exit", onExit);
    // Close the event-registration race if exit happened between the initial
    // check and listener installation.
    if (hasProcessExited(child)) finish();
  });
}

type RemoveDirectory = typeof rm;

/**
 * Remove an owned E2E run directory with Node's bounded transient-error retry.
 * A persistent ENOTEMPTY/EBUSY/EPERM still rejects and fails the suite.
 */
export async function removeRunDirectory(
  runDir: string,
  remove: RemoveDirectory = rm,
): Promise<void> {
  await remove(runDir, {
    recursive: true,
    force: true,
    maxRetries: REMOVE_MAX_RETRIES,
    retryDelay: REMOVE_RETRY_DELAY_MS,
  });
}
