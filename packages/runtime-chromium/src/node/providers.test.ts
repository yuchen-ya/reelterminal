import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExportCallbacks, ExportVideoRequest } from "@reelterminal/agent-facade";
import type { Project } from "@reelterminal/core/types/project";
import {
  ChromiumExportProvider,
  type ChromiumProviderPool,
} from "./providers";
import type { ChromiumRuntime, PartFileWriter } from "./runtime";

type ExportRuntimeCall = ChromiumRuntime["exportWebcodecsStreaming"];
type Terminal = "done" | "error" | "cancelled";

interface RecordedCallbacks {
  readonly callbacks: ExportCallbacks;
  readonly running: number;
  readonly terminals: readonly Terminal[];
  readonly settled: Promise<Terminal>;
}

function recorder(): RecordedCallbacks {
  let running = 0;
  const terminals: Terminal[] = [];
  let resolveSettled!: (terminal: Terminal) => void;
  const settled = new Promise<Terminal>((resolve) => {
    resolveSettled = resolve;
  });
  const terminal = (value: Terminal): void => {
    terminals.push(value);
    resolveSettled(value);
  };

  return {
    callbacks: {
      onRunning: () => { running += 1; },
      onProgress: () => undefined,
      onDone: () => terminal("done"),
      onError: () => terminal("error"),
      onCancelled: () => terminal("cancelled"),
    },
    get running() { return running; },
    get terminals() { return terminals; },
    settled,
  };
}

function makeProvider(
  exportWebcodecsStreaming: ExportRuntimeCall,
  abortInPageExport: () => Promise<void> = vi.fn(async () => {}),
): { provider: ChromiumExportProvider; abortInPageExport: typeof abortInPageExport } {
  const runtime = {
    exportWebcodecsStreaming,
    abortInPageExport,
  } as unknown as ChromiumRuntime;
  const pool = {
    runtime,
    exportWatchdogMs: 10_000,
    exportRoute: async () => "chromium-webcodecs" as const,
  } as unknown as ChromiumProviderPool;
  return {
    provider: new ChromiumExportProvider(pool),
    abortInPageExport,
  };
}

const project = { settings: { width: 2, height: 2 } } as Project;

function request(jobId: string, jobDir: string): ExportVideoRequest {
  return {
    project,
    sourceRevision: 1,
    settings: {
      format: "mp4",
      codec: "h264",
      width: 2,
      height: 2,
      frameRate: 1,
      videoBitrateKbps: 100,
    },
    jobId,
    jobDir,
    mediaFiles: {},
  };
}

async function writeSuccessfulOutput(writer: PartFileWriter): Promise<void> {
  await writer.writeBase64(Buffer.from("test-mp4").toString("base64"));
  await writer.finalize();
}

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

let jobRoot: string;

beforeEach(async () => {
  jobRoot = await mkdtemp(join(tmpdir(), "provider-job-lifecycle-"));
});

afterEach(async () => {
  await rm(jobRoot, { recursive: true, force: true });
});

async function createJobDir(jobId: string): Promise<string> {
  const jobDir = join(jobRoot, jobId);
  await mkdir(jobDir, { recursive: true });
  return jobDir;
}

describe("ChromiumExportProvider job lifecycle", () => {
  it("settles a failed job once, removes partial output, and runs the next job", async () => {
    let calls = 0;
    const { provider } = makeProvider(async (_project, _media, _settings, writer) => {
      calls += 1;
      if (calls === 1) {
        await writer.writeBase64(Buffer.from("partial").toString("base64"));
        return { success: false, errorCode: "ENCODE_FAILED", errorMessage: "failed" };
      }
      await writeSuccessfulOutput(writer);
      return { success: true, framesRendered: 1 };
    });
    const failedDir = await createJobDir("failed");
    const successDir = await createJobDir("success");
    const failed = recorder();
    const succeeded = recorder();

    await provider.startExport(request("failed", failedDir), failed.callbacks);
    await provider.startExport(request("success", successDir), succeeded.callbacks);

    await expect(failed.settled).resolves.toBe("error");
    await expect(succeeded.settled).resolves.toBe("done");
    expect(failed.terminals).toEqual(["error"]);
    expect(succeeded.terminals).toEqual(["done"]);
    expect(failed.running).toBe(1);
    expect(succeeded.running).toBe(1);
    expect(await readdir(failedDir)).toEqual([]);
    expect(await readFile(join(successDir, "output.mp4"), "utf8")).toBe("test-mp4");

    await provider.cancel("failed");
    await provider.cancel("success");
    expect(failed.terminals).toEqual(["error"]);
    expect(succeeded.terminals).toEqual(["done"]);
  });

  it("cancels a queued job without running it, then continues to the next queued job", async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    let calls = 0;
    const { provider } = makeProvider(async (_project, _media, _settings, writer) => {
      calls += 1;
      if (calls === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      await writeSuccessfulOutput(writer);
      return { success: true, framesRendered: 1 };
    });
    const firstDir = await createJobDir("first");
    const cancelledDir = await createJobDir("cancelled");
    const lastDir = await createJobDir("last");
    const first = recorder();
    const cancelled = recorder();
    const last = recorder();

    await provider.startExport(request("first", firstDir), first.callbacks);
    await provider.startExport(request("cancelled", cancelledDir), cancelled.callbacks);
    await provider.startExport(request("last", lastDir), last.callbacks);
    await firstStarted.promise;
    await provider.cancel("cancelled");
    releaseFirst.resolve();

    await expect(first.settled).resolves.toBe("done");
    await expect(cancelled.settled).resolves.toBe("cancelled");
    await expect(last.settled).resolves.toBe("done");
    expect(first.terminals).toEqual(["done"]);
    expect(cancelled.terminals).toEqual(["cancelled"]);
    expect(last.terminals).toEqual(["done"]);
    expect(cancelled.running).toBe(0);
    expect(calls).toBe(2);
    expect(await readdir(cancelledDir)).toEqual([]);
    expect(await readFile(join(lastDir, "output.mp4"), "utf8")).toBe("test-mp4");

    await provider.cancel("cancelled");
    expect(cancelled.terminals).toEqual(["cancelled"]);
  });

  it("aborts an active job and releases its partial file exactly once", async () => {
    const started = deferred();
    const aborted = deferred();
    const abortInPageExport = vi.fn(async () => {
      aborted.resolve();
    });
    const { provider } = makeProvider(async () => {
      started.resolve();
      await aborted.promise;
      return { success: false, errorCode: "CANCELLED" };
    }, abortInPageExport);
    const jobDir = await createJobDir("active-cancel");
    const cancelled = recorder();

    await provider.startExport(request("active-cancel", jobDir), cancelled.callbacks);
    await started.promise;
    await provider.cancel("active-cancel");
    await expect(cancelled.settled).resolves.toBe("cancelled");

    expect(abortInPageExport).toHaveBeenCalledTimes(1);
    expect(cancelled.terminals).toEqual(["cancelled"]);
    expect(await readdir(jobDir)).toEqual([]);

    await provider.cancel("active-cancel");
    expect(abortInPageExport).toHaveBeenCalledTimes(1);
    expect(cancelled.terminals).toEqual(["cancelled"]);
  });
});
