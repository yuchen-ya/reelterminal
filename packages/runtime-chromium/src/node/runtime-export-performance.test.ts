import { describe, expect, it } from "vitest";
import type { Project } from "@reelterminal/core/types/project";
import { ExportPerformanceCapture } from "./export-performance";
import { ChromiumRuntime, type ExportProgressJson, type PartFileWriter } from "./runtime";

interface RuntimeTestAccess {
  withPageLock<T>(callback: (page: never) => Promise<T>): Promise<T>;
  hydrateOnPage: (...args: never[]) => Promise<void>;
  ensureSinkBindings: (page: never) => Promise<void>;
  sinkBridge: { progress(event: ExportProgressJson): void } | null;
}

async function runPageAbort(timeout: boolean): Promise<ExportPerformanceCapture> {
  let tick = 0;
  const capture = new ExportPerformanceCapture({
    enabled: true,
    supportedPhases: ["prepare", "render"],
    nowUs: () => ++tick,
  });
  const runtime = Object.create(ChromiumRuntime.prototype) as ChromiumRuntime;
  const internals = runtime as unknown as RuntimeTestAccess;
  const page = {
    evaluate: async () => {
      internals.sinkBridge?.progress({
        phase: "rendering",
        progress: 0.25,
        currentFrame: 1,
        totalFrames: 4,
        bytesWritten: 0,
      });
      const abort = new Error("fake page aborted");
      abort.name = "AbortError";
      throw abort;
    },
  };
  internals.withPageLock = async <T>(callback: (lockedPage: never) => Promise<T>) => callback(page as never);
  internals.hydrateOnPage = async () => undefined;
  internals.ensureSinkBindings = async () => undefined;

  const writer = {} as PartFileWriter;
  const operation = runtime.exportWebcodecsStreaming(
    { id: "test-project" } as Project,
    {},
    { width: 320, height: 180, frameRate: 30, videoBitrateKbps: 1_000 },
    writer,
    () => undefined,
    { performanceSink: capture, timeoutCheck: () => timeout },
  );
  await expect(operation).rejects.toMatchObject({ name: "AbortError" });
  return capture;
}

describe("WebCodecs export interruption telemetry", () => {
  it("labels watchdog-aborted page work as timeout and explicit abort as cancellation", async () => {
    const timedOut = await runPageAbort(true);
    const cancelled = await runPageAbort(false);

    expect(timedOut.report().events).toContainEqual(expect.objectContaining({
      kind: "span_end",
      phase: "render",
      outcome: "timeout",
    }));
    expect(cancelled.report().events).toContainEqual(expect.objectContaining({
      kind: "span_end",
      phase: "render",
      outcome: "cancelled",
    }));
  });
});
