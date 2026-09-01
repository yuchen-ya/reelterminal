import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { rm } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  removeRunDirectory,
  waitForProcessExit,
} from "./teardown";

describe("Electron E2E teardown", () => {
  it("awaits actual process exit readiness", async () => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { exitCode: null, signalCode: null });

    let settled = false;
    const pending = waitForProcessExit(child, 1_000).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    Object.assign(child, { exitCode: 0 });
    child.emit("exit", 0, null);
    await pending;
    expect(settled).toBe(true);
  });

  it("awaits bounded recursive removal and does not swallow failure", async () => {
    let finishRemove!: () => void;
    const remove = vi.fn(
      () => new Promise<void>((resolve) => {
        finishRemove = resolve;
      }),
    );
    let settled = false;
    const pending = removeRunDirectory(
      "/tmp/owned-openreel-e2e",
      remove as typeof rm,
    ).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(remove).toHaveBeenCalledWith("/tmp/owned-openreel-e2e", {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });

    finishRemove();
    await pending;
    expect(settled).toBe(true);

    const failure = Object.assign(new Error("still busy"), { code: "ENOTEMPTY" });
    const failingRemove = vi.fn().mockRejectedValue(failure);
    await expect(
      removeRunDirectory("/tmp/owned-openreel-e2e", failingRemove as typeof rm),
    ).rejects.toBe(failure);
  });
});
