import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PERF_BUDGETS,
  MAX_TRACE_CAPTURE_SECONDS,
  NOOP_SPAN,
  NOOP_SINK,
  classifyPerfError,
  getPerfSink,
  nearestRankPercentile,
  resolvePerfBudgets,
  runMeasured,
  setPerfSink,
  summarizeDurations,
  validatePerformanceEvent,
  validatePerformanceResult,
  withPerfSpan,
} from "./index";
import type { PerfSink } from "./index";

function makeFakeSink(overrides: Partial<PerfSink> = {}): PerfSink & {
  calls: string[];
} {
  const calls: string[] = [];
  const sink: PerfSink & { calls: string[] } = {
    enabled: true,
    mode: "light",
    calls,
    begin: (phase) => {
      calls.push(`begin:${phase}`);
      return { id: calls.length, startedUs: 100 };
    },
    end: (span, outcome) => {
      calls.push(`end:${span.id}:${outcome}`);
    },
    mark: (phase) => {
      calls.push(`mark:${phase}`);
    },
    count: (key, delta) => {
      calls.push(`count:${key}:${delta}`);
    },
    ...overrides,
  };
  return sink;
}

describe("performance contract (P0)", () => {
  afterEach(() => {
    setPerfSink(null);
  });

  describe("noop sink", () => {
    it("is disabled and off by default", () => {
      expect(NOOP_SINK.enabled).toBe(false);
      expect(NOOP_SINK.mode).toBe("off");
      expect(getPerfSink()).toBe(NOOP_SINK);
    });

    it("returns the shared sentinel span without allocating", () => {
      const ctx = { runId: "r", operationId: "o" };
      const a = NOOP_SINK.begin("phase", ctx);
      const b = NOOP_SINK.begin("phase", ctx);
      expect(a).toBe(NOOP_SPAN);
      expect(b).toBe(NOOP_SPAN);
      expect(a).toBe(b);
    });

    it("never throws for any arguments", () => {
      const ctx = { runId: "r", operationId: "o" };
      expect(() => {
        NOOP_SINK.end(NOOP_SPAN, "ok", { any: 1 });
        NOOP_SINK.mark("phase", ctx);
        NOOP_SINK.count("key", 1, ctx);
        NOOP_SINK.begin("phase", ctx);
      }).not.toThrow();
    });
  });

  describe("sink slot", () => {
    it("installs a valid enabled sink and restores NOOP on null", () => {
      const sink = makeFakeSink();
      setPerfSink(sink);
      expect(getPerfSink()).toBe(sink);
      setPerfSink(null);
      expect(getPerfSink()).toBe(NOOP_SINK);
    });

    it("rejects disabled, off-mode and malformed sinks", () => {
      setPerfSink(makeFakeSink({ enabled: false }));
      expect(getPerfSink()).toBe(NOOP_SINK);
      setPerfSink(makeFakeSink({ mode: "off" }));
      expect(getPerfSink()).toBe(NOOP_SINK);
      setPerfSink({} as PerfSink);
      expect(getPerfSink()).toBe(NOOP_SINK);
      setPerfSink(undefined);
      expect(getPerfSink()).toBe(NOOP_SINK);
    });
  });

  describe("runMeasured / withPerfSpan", () => {
    it("disabled path calls fn directly without touching any sink", () => {
      setPerfSink(null);
      const result = runMeasured("phase", { runId: "r", operationId: "o" }, () => 42);
      expect(result).toBe(42);
      const sink = makeFakeSink();
      setPerfSink(null);
      // The fake sink is NOT installed, so none of its calls may happen.
      const asyncResult = withPerfSpan("phase", { runId: "r", operationId: "o" }, async () => 7);
      setPerfSink(sink);
      void asyncResult;
      setPerfSink(null);
      expect(sink.calls).toHaveLength(0);
    });

    it("enabled path records begin/end with ok outcome", () => {
      const sink = makeFakeSink();
      setPerfSink(sink);
      const out = runMeasured("workspace.hydrate", { runId: "r", operationId: "o" }, () => "v");
      expect(out).toBe("v");
      expect(sink.calls).toEqual(["begin:workspace.hydrate", "end:1:ok"]);
      setPerfSink(null);
    });

    it("rethrows the original error and ends the span with a classified outcome", () => {
      const sink = makeFakeSink();
      setPerfSink(sink);
      const boom = new DOMException("secret message", "AbortError");
      expect(() =>
        runMeasured("phase", { runId: "r", operationId: "o" }, () => {
          throw boom;
        }),
      ).toThrow(boom);
      expect(sink.calls).toEqual(["begin:phase", "end:1:cancelled"]);
      setPerfSink(null);
    });

    it("async variant preserves resolution and rejection", async () => {
      const sink = makeFakeSink();
      setPerfSink(sink);
      await expect(
        withPerfSpan("p", { runId: "r", operationId: "o" }, async () => 5),
      ).resolves.toBe(5);
      const err = new Error("x");
      err.name = "TimeoutError";
      await expect(
        withPerfSpan("p", { runId: "r", operationId: "o" }, async () => {
          throw err;
        }),
      ).rejects.toBe(err);
      expect(sink.calls).toEqual(["begin:p", "end:1:ok", "begin:p", "end:3:timeout"]);
      setPerfSink(null);
    });
  });

  describe("classifyPerfError", () => {
    it("maps well-known names and codes to categories", () => {
      expect(classifyPerfError(new DOMException("m", "AbortError"))).toBe("abort");
      expect(classifyPerfError(new DOMException("m", "TimeoutError"))).toBe("timeout");
      expect(classifyPerfError(new DOMException("m", "QuotaExceededError"))).toBe("quota");
      expect(classifyPerfError(new DOMException("m", "InvalidStateError"))).toBe("invalid-state");
      expect(classifyPerfError(new DOMException("m", "NotSupportedError"))).toBe("unsupported");
      expect(classifyPerfError(new DOMException("m", "NetworkError"))).toBe("network");
      const decodeErr = new Error("m");
      decodeErr.name = "DecodingError";
      expect(classifyPerfError(decodeErr)).toBe("decode");
      const ioErr = Object.assign(new Error("m"), { code: "ENOENT" });
      expect(classifyPerfError(ioErr)).toBe("storage");
    });

    it("returns unknown for anything else without reading the message", () => {
      expect(classifyPerfError(new Error("file:///C:/Users/me/private.prj"))).toBe("unknown");
      expect(classifyPerfError("string")).toBe("unknown");
      expect(classifyPerfError(null)).toBe("unknown");
      expect(classifyPerfError(42)).toBe("unknown");
    });
  });

  describe("nearestRankPercentile", () => {
    it("uses ceil(p*n)-1 on ascending input", () => {
      const values = Array.from({ length: 100 }, (_, i) => i + 1);
      expect(nearestRankPercentile(values, 0.5)).toBe(50);
      expect(nearestRankPercentile(values, 0.95)).toBe(95);
      expect(nearestRankPercentile(values, 0.99)).toBe(99);
      expect(nearestRankPercentile([1, 2, 3, 4], 0.95)).toBe(4);
      expect(nearestRankPercentile([1, 2, 3, 4], 0)).toBe(1);
      expect(nearestRankPercentile([1, 2, 3, 4], 1)).toBe(4);
    });

    it("returns null for empty input", () => {
      expect(nearestRankPercentile([], 0.95)).toBeNull();
    });
  });

  describe("summarizeDurations", () => {
    it("produces p99 only at 100 completed samples", () => {
      const hundred = summarizeDurations(Array.from({ length: 100 }, (_, i) => i + 1));
      expect(hundred.n).toBe(100);
      expect(hundred.p99).toBe(99);
      expect(hundred.quantileMethod).toBe("nearest_rank");
      const quick = summarizeDurations(Array.from({ length: 25 }, (_, i) => i + 1));
      expect(quick.p99).toBeNull();
      expect(quick.p95).toBe(24);
      const tiny = summarizeDurations([5]);
      expect(tiny.p50).toBe(5);
      expect(tiny.p95).toBeNull();
    });

    it("excludes non-finite values", () => {
      const s = summarizeDurations([1, Number.NaN, 3, Number.POSITIVE_INFINITY]);
      expect(s.n).toBe(2);
      expect(s.max).toBe(3);
    });
  });

  describe("resolvePerfBudgets", () => {
    it("keeps defaults for light", () => {
      const b = resolvePerfBudgets("light");
      expect(b).toEqual(DEFAULT_PERF_BUDGETS);
    });

    it("clamps trace to the hard cap and disables memory sampling for counts", () => {
      const trace = resolvePerfBudgets("trace", { captureSeconds: 999 });
      expect(trace.captureSeconds).toBe(MAX_TRACE_CAPTURE_SECONDS);
      const counts = resolvePerfBudgets("counts");
      expect(counts.memorySampleIntervalSeconds).toBe(0);
      const custom = resolvePerfBudgets("light", { eventsCapacity: 8 });
      expect(custom.eventsCapacity).toBe(8);
      const invalid = resolvePerfBudgets("light", { eventsCapacity: -5 });
      expect(invalid.eventsCapacity).toBe(DEFAULT_PERF_BUDGETS.eventsCapacity);
    });
  });

  describe("validatePerformanceEvent", () => {
    const base = {
      schemaVersion: 1,
      runId: "run-1",
      processRole: "renderer",
      processEpoch: "epoch-1",
      clockId: "clock-1",
      seq: 10,
      phase: "history.media.restore",
      tsUs: 100000,
    };

    it("accepts the canonical span_begin example", () => {
      const event = {
        ...base,
        kind: "span_begin",
        spanId: 3,
        parentSpanId: 1,
        operationId: "node-open-1",
        viewGeneration: 2,
        revision: 1,
        dims: { mediaCount: 50, knownBlobBytes: 8388608 },
      };
      expect(validatePerformanceEvent(event).valid).toBe(true);
    });

    it("accepts span_end, mark, sample, error and flow_link shapes", () => {
      expect(
        validatePerformanceEvent({ ...base, kind: "span_end", spanId: 3, operationId: "o", outcome: "ok", spanDurationUs: 1500 }).valid,
      ).toBe(true);
      expect(validatePerformanceEvent({ ...base, kind: "mark", operationId: "o" }).valid).toBe(true);
      expect(validatePerformanceEvent({ ...base, kind: "sample", dims: { durationMs: 80 } }).valid).toBe(true);
      expect(validatePerformanceEvent({ ...base, kind: "error", errorKind: "timeout" }).valid).toBe(true);
      expect(validatePerformanceEvent({ ...base, kind: "flow_link", requestId: "req-1", direction: "out" }).valid).toBe(true);
      expect(validatePerformanceEvent({ ...base, kind: "counter", dims: { delta: 2 } }).valid).toBe(true);
    });

    it("rejects contract violations", () => {
      expect(validatePerformanceEvent({ ...base, kind: "mark", schemaVersion: 99 }).valid).toBe(false);
      expect(validatePerformanceEvent({ ...base, kind: "wat" }).valid).toBe(false);
      expect(
        validatePerformanceEvent({ ...base, kind: "span_end", spanId: 1, operationId: "o", outcome: "ok", spanDurationUs: -1 }).valid,
      ).toBe(false);
      expect(validatePerformanceEvent({ ...base, kind: "mark", dims: { path: "C:/secret" } }).valid).toBe(false);
      expect(
        validatePerformanceEvent({
          ...base,
          kind: "mark",
          dims: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`d${i}`, i])),
        }).valid,
      ).toBe(false);
      expect(validatePerformanceEvent({ ...base, kind: "mark", seq: 1.5 }).valid).toBe(false);
      expect(validatePerformanceEvent({ ...base, kind: "mark", phase: "" }).valid).toBe(false);
      expect(
        validatePerformanceEvent({ ...base, kind: "mark", phase: "x".repeat(129) }).valid,
      ).toBe(false);
      expect(validatePerformanceEvent(null).valid).toBe(false);
    });
  });

  describe("validatePerformanceResult", () => {
    const exampleUrl = new URL(
      "../../../../docs/performance/result-example.json",
      import.meta.url,
    );

    it("accepts the canonical documented example", () => {
      const doc = JSON.parse(readFileSync(fileURLToPath(exampleUrl), "utf8"));
      const result = validatePerformanceResult(doc);
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    });

    it("rejects corrupted documents", () => {
      const doc = JSON.parse(readFileSync(fileURLToPath(exampleUrl), "utf8"));
      expect(validatePerformanceResult({}).valid).toBe(false);
      expect(validatePerformanceResult({ ...doc, schema: "other/v9" }).valid).toBe(false);
      expect(validatePerformanceResult({ ...doc, status: "great" }).valid).toBe(false);
      expect(validatePerformanceResult({ ...doc, run: { ...doc.run, mode: "off" } }).valid).toBe(false);
      expect(
        validatePerformanceResult({ ...doc, validity: { ...doc.validity, reason_codes: "nope" } }).valid,
      ).toBe(false);
      expect(
        validatePerformanceResult({ ...doc, metrics: { broken: { n: 1 } } }).valid,
      ).toBe(false);
      expect(validatePerformanceResult({ ...doc, structural: { clones: "many" } }).valid).toBe(false);
      expect(validatePerformanceResult({ ...doc, correctness: { verified: 3 } }).valid).toBe(false);
      expect(validatePerformanceResult({ ...doc, comparison: { status: 1 } }).valid).toBe(false);
    });
  });

  describe("dependency boundary", () => {
    it("keeps the core performance module free of UI/runtime imports", () => {
      const dir = fileURLToPath(new URL(".", import.meta.url));
      const files = readdirSync(dir).filter(
        (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
      );
      expect(files.length).toBeGreaterThanOrEqual(4);
      const forbidden = /react|zustand|electron|node:|["']fs["']/i;
      for (const file of files) {
        const source = readFileSync(`${dir}${file}`, "utf8");
        const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
        for (const specifier of specifiers) {
          expect(specifier.startsWith("./")).toBe(true);
          expect(forbidden.test(specifier)).toBe(false);
        }
      }
    });
  });
});
