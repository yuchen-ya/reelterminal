import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginPerfOperation,
  endPerfOperation,
  getPerfSink,
  setPerfSink,
  type PerfContext,
  type Outcome,
  type PerfSink,
} from "../performance";
import { ParallelFrameDecoder } from "./parallel-frame-decoder";

describe("ParallelFrameDecoder initialization measurements", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("records a worker readiness timeout and still terminates the failed worker", async () => {
    vi.useFakeTimers();
    const events: Array<{
      phase: string;
      outcome?: Outcome;
      spanId?: number;
      parentSpanId?: number;
    }> = [];
    let nextSpanId = 0;
    const previousSink = getPerfSink();
    const sink: PerfSink = {
      enabled: true,
      mode: "trace",
      runId: "parallel-decoder-test",
      begin: (phase, context: PerfContext) => {
        const id = ++nextSpanId;
        events.push({ phase, spanId: id, parentSpanId: context.parentSpanId });
        return { id, startedUs: id };
      },
      end: (span, outcome) => {
        events.push({ spanId: span.id, phase: "span_end", outcome });
      },
      mark: (phase) => events.push({ phase }),
      count: () => undefined,
    };
    setPerfSink(sink);

    const terminateMock = vi.fn();
    class FakeWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      postMessage = vi.fn();
      terminate = terminateMock;
    }
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("navigator", { hardwareConcurrency: 2 });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:decode-worker");

    try {
      const parent = beginPerfOperation("test.parent");
      const decoder = new ParallelFrameDecoder(1);
      const initialization = decoder.initialize(parent);
      const rejection = expect(initialization).rejects.toThrow("initialization timed out");
      await vi.advanceTimersByTimeAsync(10_000);

      await rejection;

      expect(terminateMock).toHaveBeenCalledTimes(1);
      expect(events).toContainEqual({
        spanId: expect.any(Number),
        phase: "span_end",
        outcome: "timeout",
      });
      const decoderSpan = events.find((event) => event.phase === "parallel_decoder.initialize");
      const workerSpan = events.find((event) => event.phase === "parallel_decoder.worker_initialize");
      expect(decoderSpan?.parentSpanId).toBe(parent?.span.id);
      expect(workerSpan?.parentSpanId).toBe(decoderSpan?.spanId);
      expect(JSON.stringify(events)).not.toContain("blob:");
      endPerfOperation(parent, "ok");
    } finally {
      setPerfSink(previousSink);
    }
  });
});
