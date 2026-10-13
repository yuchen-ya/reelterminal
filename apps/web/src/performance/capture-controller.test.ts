import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NOOP_SINK,
  getPerfSink,
  setPerfSink,
  validatePerformanceEvent,
} from "@reelterminal/core";
import type { PerfSink, PerfSpan } from "@reelterminal/core";
import { CaptureController, PerfCaptureError } from "./capture-controller";
import { createRendererClock } from "./renderer-clock";

function fakeTimers() {
  const handles: Array<{ id: number; cb: () => void; cleared: boolean }> = [];
  let next = 0;
  return {
    timers: {
      set: (cb: () => void) => {
        next += 1;
        const entry = { id: next, cb, cleared: false };
        handles.push(entry);
        return entry.id;
      },
      clear: (id: unknown) => {
        const entry = handles.find((h) => h.id === id);
        if (entry) entry.cleared = true;
      },
    },
    fire(handle: number): void {
      const entry = handles.find((h) => h.id === handle && !h.cleared);
      entry?.cb();
    },
    entryCount(): number {
      return handles.filter((h) => !h.cleared).length;
    },
    cleared(handle: number): boolean {
      return handles.find((h) => h.id === handle)?.cleared ?? false;
    },
  };
}

function fakeEventTarget() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    target: {
      addEventListener(type: string, cb: () => void): void {
        if (!listeners.has(type)) listeners.set(type, new Set());
        (listeners.get(type) as Set<() => void>).add(cb);
      },
      removeEventListener(type: string, cb: () => void): void {
        listeners.get(type)?.delete(cb);
      },
    },
    dispatch(type: string): void {
      for (const cb of [...(listeners.get(type) ?? [])]) cb();
    },
    listenerCount(type: string): number {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

function controlledClock() {
  let nowMs = 0;
  const clock = createRendererClock({ nowMs: () => nowMs, epoch: "test-epoch" });
  return { clock, advance: (ms: number) => (nowMs += ms) };
}

function baseStart(controller: CaptureController, overrides = {}) {
  const harness = {
    timers: fakeTimers(),
    events: fakeEventTarget(),
    ...controlledClock(),
  };
  const handle = controller.startCapture({
    mode: "light",
    runId: "run-test",
    timers: harness.timers.timers,
    eventTarget: harness.events.target,
    clock: harness.clock,
    observerHost: {},
    readMemory: () => null,
    ...overrides,
  });
  return { controller, handle, ...harness };
}

describe("CaptureController", () => {
  let controller: CaptureController;

  beforeEach(() => {
    controller = new CaptureController();
    setPerfSink(null);
  });

  afterEach(() => {
    if (controller.activeRunId) controller.stopCapture();
    setPerfSink(null);
  });

  it("is inert until a capture starts and installs the collector for its duration", () => {
    expect(getPerfSink()).toBe(NOOP_SINK);
    const harness = baseStart(controller);
    expect(controller.activeRunId).toBe("run-test");
    const sink = getPerfSink();
    expect(sink).not.toBe(NOOP_SINK);
    expect(sink.enabled).toBe(true);
    expect(sink.mode).toBe("light");

    const ctx = { runId: "run-test", operationId: "op-1" };
    const span = sink.begin("workspace.hydrate", ctx);
    harness.advance(5);
    sink.end(span, "ok", { clipCount: 3 });
    sink.mark("semantic-state.committed", ctx, { revision: 7 });
    sink.count("font.installs", 1);

    const report = controller.stopCapture();
    expect(getPerfSink()).toBe(NOOP_SINK);
    expect(report.status).toBe("complete");
    expect(report.stopReason).toBe("user_stop");
    expect(report.counters["span:workspace.hydrate"]).toBe(1);
    expect(report.counters["span:workspace.hydrate:ok"]).toBe(1);
    expect(report.counters["mark:semantic-state.committed"]).toBe(1);
    expect(report.counters["font.installs"]).toBe(1);
    const spanEnd = report.events.find((e) => e.kind === "span_end");
    expect(spanEnd?.spanDurationUs).toBe(5000);
    // Every stored event satisfies the wire contract.
    for (const event of report.events) {
      expect(validatePerformanceEvent(event).valid, JSON.stringify(event)).toBe(true);
    }
  });

  it("rejects duplicate starts, inactive stops and double stops", () => {
    baseStart(controller);
    expect(() => controller.startCapture({ mode: "light" })).toThrow(PerfCaptureError);
    try {
      controller.startCapture({ mode: "light" });
      throw new Error("unreachable");
    } catch (error) {
      expect((error as PerfCaptureError).code).toBe("capture_already_active");
    }
    controller.stopCapture();
    expect(() => controller.stopCapture()).toThrow(PerfCaptureError);
    try {
      controller.stopCapture();
      throw new Error("unreachable");
    } catch (error) {
      expect((error as PerfCaptureError).code).toBe("no_active_capture");
    }
  });

  it("refuses invalid modes, hidden windows and an occupied sink slot", () => {
    expect(() =>
      controller.startCapture({ mode: "off" as "light", readMemory: () => null }),
    ).toThrow(PerfCaptureError);
    expect(() =>
      controller.startCapture({
        mode: "light",
        visibilityCheck: () => false,
        readMemory: () => null,
      }),
    ).toThrow(PerfCaptureError);
    const squatter: PerfSink = {
      enabled: true,
      mode: "light",
      begin: () => ({ id: 1, startedUs: 0 }),
      end: () => undefined,
      mark: () => undefined,
      count: () => undefined,
    };
    setPerfSink(squatter);
    try {
      controller.startCapture({ mode: "light", readMemory: () => null });
      throw new Error("unreachable");
    } catch (error) {
      expect((error as PerfCaptureError).code).toBe("sink_slot_occupied");
    }
    expect(getPerfSink()).toBe(squatter);
    setPerfSink(null);
  });

  it("counts mode keeps exact counters without storing any events", () => {
    const harness = baseStart(controller, { mode: "counts" });
    const sink = getPerfSink();
    for (let i = 0; i < 5; i += 1) {
      const span = sink.begin("input.move", { runId: "run-test", operationId: "op" });
      sink.end(span, "ok");
    }
    sink.count("font.installs", 0);
    sink.mark("semantic-state.committed", { runId: "run-test", operationId: "op" });
    const report = controller.stopCapture();
    expect(report.mode).toBe("counts");
    expect(report.events).toHaveLength(0);
    expect(report.criticalEvents).toHaveLength(0);
    expect(report.counters["span:input.move"]).toBe(5);
    expect(report.counters["span:input.move:ok"]).toBe(5);
    expect(report.counters["font.installs"]).toBe(0);
    expect(report.counters["mark:semantic-state.committed"]).toBe(1);
    expect(report.memory.samples).toBe(0);
    void harness;
  });

  it("samples high-frequency phases 1/N while counters stay exact", () => {
    baseStart(controller, { budgets: { inputSampleEveryN: 3 } });
    const sink = getPerfSink();
    for (let i = 0; i < 7; i += 1) {
      const span = sink.begin("input.move", { runId: "run-test", operationId: "op" });
      sink.end(span, "ok");
    }
    const report = controller.stopCapture();
    const begins = report.events.filter(
      (e) => e.kind === "span_begin" && e.phase === "input.move",
    );
    const ends = report.events.filter(
      (e) => e.kind === "span_end" && e.phase === "input.move",
    );
    expect(begins).toHaveLength(3);
    expect(ends).toHaveLength(3);
    expect(report.drops.samplesDropped).toBe(4);
    expect(report.counters["span:input.move"]).toBe(7);
    expect(report.reasonCodes).toContain("samples_dropped");
  });

  it("keeps semantic endpoints in the critical store across main-ring overflow", () => {
    baseStart(controller, { budgets: { eventsCapacity: 4 } });
    const sink = getPerfSink();
    for (let i = 0; i < 10; i += 1) {
      sink.mark("ui.refresh", { runId: "run-test", operationId: "op" }, { i });
    }
    sink.mark("save.confirmed", { runId: "run-test", operationId: "op" }, { revision: 9 });
    const report = controller.stopCapture();
    expect(report.drops.eventsDropped).toBe(6);
    expect(report.status).toBe("incomplete");
    expect(report.reasonCodes).toContain("events_dropped");
    const save = report.criticalEvents.find((e) => e.phase === "save.confirmed");
    expect(save).toBeDefined();
    expect(report.events.some((e) => e.phase === "save.confirmed")).toBe(true);
  });

  it("reports critical endpoint drops instead of replacing them", () => {
    baseStart(controller, { budgets: { criticalEventsCapacity: 2 } });
    const sink = getPerfSink();
    sink.mark("save.confirmed", { runId: "run-test", operationId: "a" });
    sink.mark("node.first-valid-frame", { runId: "run-test", operationId: "b" });
    sink.mark("save.confirmed", { runId: "run-test", operationId: "c" });
    const report = controller.stopCapture();
    expect(report.drops.criticalEndpointsDropped).toBe(1);
    expect(report.criticalEvents).toHaveLength(2);
    expect(report.status).toBe("incomplete");
    expect(report.reasonCodes).toContain("critical_endpoints_dropped");
  });

  it("auto-stops on the capture-seconds budget and restores the sink", () => {
    const onAutoStop = vi.fn();
    const harness = baseStart(controller, { budgets: { captureSeconds: 1 }, onAutoStop });
    const autoStopHandle = 1;
    harness.timers.fire(autoStopHandle);
    expect(controller.activeRunId).toBeNull();
    expect(getPerfSink()).toBe(NOOP_SINK);
    expect(onAutoStop).toHaveBeenCalledTimes(1);
    const report = controller.lastReport;
    expect(report?.status).toBe("incomplete");
    expect(report?.stopReason).toBe("budget:capture_seconds");
    expect(report?.reasonCodes).toContain("budget:capture_seconds");
    expect(() => controller.stopCapture()).toThrow(PerfCaptureError);
  });

  it("clears timers and listeners on user stop", () => {
    const harness = baseStart(controller);
    controller.stopCapture();
    expect(harness.timers.entryCount()).toBe(0);
    expect(harness.timers.cleared(1)).toBe(true);
    expect(harness.events.listenerCount("pagehide")).toBe(0);
    harness.events.dispatch("pagehide");
    expect(controller.lastReport?.stopReason).toBe("user_stop");
  });

  it("marks the capture aborted on renderer unload", () => {
    const harness = baseStart(controller);
    harness.events.dispatch("pagehide");
    const report = controller.lastReport;
    expect(report?.status).toBe("aborted");
    expect(report?.stopReason).toBe("renderer_unload");
    expect(controller.activeRunId).toBeNull();
    expect(getPerfSink()).toBe(NOOP_SINK);
    expect(harness.events.listenerCount("pagehide")).toBe(0);
  });

  it("flags open spans instead of deleting their begin events", () => {
    baseStart(controller);
    const sink = getPerfSink();
    const span = sink.begin("node.read", { runId: "run-test", operationId: "op" });
    void span;
    const report = controller.stopCapture();
    expect(report.openSpans).toBe(1);
    expect(report.reasonCodes).toContain("spans_left_open");
    expect(report.events.some((e) => e.kind === "span_begin" && e.phase === "node.read")).toBe(
      true,
    );
    expect(report.counters["span:node.read"]).toBe(1);
    expect(report.counters["span:node.read:ok"]).toBeUndefined();
  });

  it("counts double ends and foreign spans as stranded", () => {
    baseStart(controller);
    const sink = getPerfSink();
    const span = sink.begin("phase.a", { runId: "run-test", operationId: "op" });
    sink.end(span, "ok");
    sink.end(span, "ok");
    const foreign: PerfSpan = { id: 999, startedUs: 0 };
    sink.end(foreign, "ok");
    const report = controller.stopCapture();
    expect(report.strandedSpans).toBe(2);
    expect(report.reasonCodes).toContain("stranded_spans");
  });

  it("samples memory only when the browser exposes it", () => {
    const harness = baseStart(controller, {
      budgets: { memorySampleIntervalSeconds: 1 },
      readMemory: () => ({ usedJSHeapSize: 1234, totalJSHeapSize: 5678 }),
    });
    harness.timers.fire(2);
    harness.timers.fire(2);
    const report = controller.stopCapture();
    expect(report.memory.capability).toBe("supported");
    expect(report.memory.samples).toBe(2);
    const memoryEvents = report.events.filter((e) => e.phase === "memory.js-heap");
    expect(memoryEvents).toHaveLength(2);
    expect((memoryEvents[0] as { dims?: Record<string, number | boolean> }).dims).toEqual({ usedBytes: 1234, totalBytes: 5678 });
  });

  it("reports memory capability unsupported instead of zeros", () => {
    const harness = baseStart(controller, { readMemory: () => null });
    harness.timers.fire(2);
    const report = controller.stopCapture();
    expect(report.memory.capability).toBe("unsupported");
    expect(report.memory.samples).toBe(0);
    expect(report.events.some((e) => e.phase === "memory.js-heap")).toBe(false);
  });

  it("sanitizes hostile phases and dims in the stored report", () => {
    baseStart(controller);
    const sink = getPerfSink();
    const ctx = { runId: "run-test", operationId: "op" };
    sink.mark("user-project/C:\\Users\\me\\secret.prj?token=xyz", ctx);
    sink.mark(
      "safe.phase",
      ctx,
      {
        mediaPath: "file:///C:/Users/u/private.mp4",
        token: "sk-abc123",
        clipCount: 2,
      } as unknown as Record<string, number | boolean>,
    );
    const report = controller.stopCapture();
    const serialized = JSON.stringify(report.events);
    for (const secret of ["secret.prj", "token=xyz", "private.mp4", "sk-abc123"]) {
      expect(serialized).not.toContain(secret);
    }
    const safe = report.events.find((e) => e.phase === "safe.phase");
    expect((safe as { dims?: Record<string, number | boolean> } | undefined)?.dims).toEqual({ clipCount: 2 });
    expect(report.drops.labelsDropped).toBeGreaterThan(0);
  });

  it("never throws from the sink surface, even for garbage inputs", () => {
    baseStart(controller);
    const sink = getPerfSink();
    expect(() => {
      const span = sink.begin("ok.phase", { runId: "r", operationId: "o" });
      sink.end(span, "ok");
      sink.mark("ok.phase", { runId: "r", operationId: "o" });
      // Hostile inputs: wrong types at runtime.
      (sink as unknown as { mark: (p: unknown, c: unknown, d: unknown) => void }).mark(
        42,
        undefined,
        { x: 1 },
      );
      (sink as unknown as { count: (k: unknown, d: number) => void }).count(null, 1);
      (sink as unknown as { begin: (p: unknown, c: unknown) => PerfSpan }).begin(
        { nested: "object" },
        null,
      );
      sink.end({ id: 1, startedUs: 0 }, "ok");
    }).not.toThrow();
    const report = controller.stopCapture();
    expect(report.collectorErrors).toBe(0);
    expect(report.drops.labelsDropped).toBeGreaterThan(0);
  });

  it("reports observer capabilities as unsupported on a bare host", () => {
    const harness = baseStart(controller, { observerHost: {} });
    const report = controller.stopCapture();
    expect(report.observerCapabilities.longTask).toBe("unsupported");
    expect(report.observerCapabilities.eventTiming).toBe("unsupported");
    void harness;
  });
});
