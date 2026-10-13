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

  it("starts a local module worker and cancels every pending peer on failure", async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    class FakeWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      postMessage = vi.fn();
      terminate = vi.fn();
      constructor(readonly url: URL, readonly options: WorkerOptions) {
        workers.push(this);
      }
    }
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("navigator", { hardwareConcurrency: 2 });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const decoder = new ParallelFrameDecoder(2);
    const initialization = decoder.initialize();
    const rejection = expect(initialization).rejects.toMatchObject({ message: "module failed" });
    expect(workers).toHaveLength(2);
    expect(workers[0].url.pathname).toMatch(/decode-worker\.ts$/);
    expect(workers[0].options.type).toBe("module");
    workers[0].onerror?.({ message: "module failed" } as ErrorEvent);
    await rejection;
    expect(workers.every((worker) => worker.terminate.mock.calls.length === 1)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(decoder.isAvailable()).toBe(false);
    decoder.dispose();
  });

  it("cannot become available when disposed during startup", async () => {
    vi.useFakeTimers();
    let worker!: FakeWorker;
    class FakeWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      postMessage = vi.fn();
      terminate = vi.fn();
      constructor() { worker = this; }
    }
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("navigator", { hardwareConcurrency: 1 });
    const decoder = new ParallelFrameDecoder(1);
    const initialization = decoder.initialize();
    const rejection = expect(initialization).rejects.toThrow("Decoder disposed");
    // Ready was delivered, but Promise.all has not activated the pool yet.
    worker.onmessage?.({ data: { type: "ready", workerId: 1, mediabunnyAvailable: true } } as MessageEvent);
    decoder.dispose();
    await rejection;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(decoder.isAvailable()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["before pool activation", "after pool activation"])("retires a ready worker that crashes %s", async (timing) => {
    vi.useFakeTimers();
    let worker!: FakeWorker;
    class FakeWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      postMessage = vi.fn();
      terminate = vi.fn();
      constructor() { worker = this; }
    }
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("navigator", { hardwareConcurrency: 1 });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const decoder = new ParallelFrameDecoder(1);
    const initialization = decoder.initialize();
    worker.onmessage?.({ data: { type: "ready", workerId: 1, mediabunnyAvailable: true } } as MessageEvent);
    if (timing === "after pool activation") {
      await initialization;
      expect(decoder.isAvailable()).toBe(true);
    }
    worker.onerror?.({ message: "worker crashed" } as ErrorEvent);
    await initialization;
    expect(decoder.isAvailable()).toBe(false);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    decoder.dispose();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
