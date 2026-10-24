import { describe, expect, it } from "vitest";
import type { PerfEvent } from "@reelterminal/core";
import type { Outcome } from "@reelterminal/core";
import type { CaptureReport } from "../../../../web/src/performance";
import { extractProductMeasurements } from "./product-metrics";

function mark(seq: number, phase: string, tsUs: number, revision?: number): Extract<PerfEvent, { kind: "mark" }> & { operationId: string } {
  return { schemaVersion: 1, runId: "test", processRole: "renderer", processEpoch: "epoch", clockId: "clock", seq, kind: "mark", phase, tsUs, operationId: "gesture-1", ...(revision === undefined ? {} : { revision }) };
}

function report(events: PerfEvent[], status: CaptureReport["status"] = "complete"): CaptureReport {
  return { status, stopReason: "user_stop", runId: "test", mode: "light", clockId: "clock", processEpoch: "epoch", startedUs: 0, stoppedUs: 1000, wallDurationUs: 1000, events, criticalEvents: [], counters: {}, drops: { eventsDropped: 0, criticalEndpointsDropped: 0, samplesDropped: 0, labelsDropped: 0, truncatedFields: 0 }, observerCapabilities: { longTask: "unsupported", eventTiming: "unsupported" }, memory: { capability: "unsupported", samples: 0 }, strandedSpans: 0, openSpans: 0, collectorErrors: 0, reasonCodes: [] };
}

function completedGesture(events: PerfEvent[], outcome: Outcome = "ok"): PerfEvent[] {
  return [
    { ...mark(0, "input.media-drag", 80), kind: "span_begin", spanId: 1 },
    ...events,
    { ...mark(events.length + 1, "input.media-drag", 700), kind: "span_end", spanId: 1, outcome, spanDurationUs: 620 },
  ];
}

describe("product endpoint evidence", () => {
  it("measures keyboard seek latency and reports coalesced inputs explicitly", () => {
    const events: PerfEvent[] = [
      { ...mark(0, "seek.frame-step", 80), kind: "span_begin", spanId: 1 },
      { ...mark(1, "seek.received", 100), dims: { seekId: 1, timelineTimeSeconds: 2 } },
      { ...mark(2, "seek.canvas-committed", 200), dims: { seekId: 1, timelineTimeSeconds: 1 } },
      { ...mark(3, "seek.canvas-committed", 300), dims: { seekId: 1, timelineTimeSeconds: 2 } },
      { ...mark(4, "seek.frame-step", 310), kind: "span_end", spanId: 1, outcome: "ok", spanDurationUs: 230 },
      { ...mark(5, "seek.frame-step", 400), kind: "span_begin", spanId: 2, operationId: "step-2" },
      { ...mark(6, "seek.received", 410), operationId: "step-2", dims: { seekId: 2, timelineTimeSeconds: 3 } },
      { ...mark(7, "seek.finished.coalesced", 420), operationId: "step-2" },
      { ...mark(8, "seek.frame-step", 430), kind: "span_end", spanId: 2, operationId: "step-2", outcome: "superseded", spanDurationUs: 30 },
    ];
    const measurements = extractProductMeasurements(report(events)).seekToCanvasFrame;
    expect(measurements[0]).toMatchObject({ status: "ok", durationUs: 200 });
    expect(measurements[1]).toMatchObject({ status: "superseded", reason: "coalesced", durationUs: null });
  });

  it("requires the final seek time as well as revision for a pointer gesture", () => {
    const events = completedGesture([
      mark(1, "input.received", 100),
      { ...mark(2, "gesture.first-valid-frame", 200, 7), dims: { timelineTimeSeconds: 1 } },
      { ...mark(3, "gesture.final-commit", 300, 7), dims: { timelineTimeSeconds: 2 } },
      { ...mark(4, "gesture.first-valid-frame", 400, 7), dims: { timelineTimeSeconds: 2 } },
    ]);
    expect(extractProductMeasurements(report(events)).inputToFinalCanvasFrame[0]).toMatchObject({ durationUs: 300 });
  });

  it("selects only the canvas frame for the gesture's final revision", () => {
    const result = extractProductMeasurements(report(completedGesture([
      mark(1, "input.received", 100), mark(2, "gesture.final-commit", 300, 7),
      mark(3, "gesture.first-valid-frame", 400, 6), mark(4, "gesture.first-valid-frame", 600, 7),
    ])));
    expect(result.inputToFinalState[0]?.durationUs).toBe(200);
    expect(result.inputToFinalCanvasFrame[0]).toMatchObject({ status: "ok", durationUs: 500, revision: 7 });
    expect(result.actualPresented).toBe("unsupported");
  });

  it("does not report another clock or missing canvas endpoint as a zero duration", () => {
    const events = completedGesture([mark(1, "input.received", 100), mark(2, "gesture.final-commit", 300, 7), { ...mark(3, "gesture.first-valid-frame", 400, 7), clockId: "other-clock" }]);
    expect(extractProductMeasurements(report(events)).inputToFinalCanvasFrame[0]).toMatchObject({ status: "unavailable", durationUs: null });
  });

  it.each(["cancelled", "error"] as const)("withholds an early candidate frame when the gesture completes as %s", (outcome) => {
    const events = completedGesture([
      mark(1, "input.received", 100),
      mark(2, "gesture.first-valid-frame", 200, 7),
      mark(3, "gesture.final-commit", 300, 7),
    ], outcome);
    expect(extractProductMeasurements(report(events)).inputToFinalCanvasFrame[0])
      .toMatchObject({ status: "unavailable", durationUs: null });
  });

  it("keeps the observed early-frame time when final completion verifies its revision", () => {
    const events = completedGesture([
      mark(1, "input.received", 100),
      mark(2, "gesture.first-valid-frame", 200, 7),
      mark(3, "gesture.final-commit", 300, 7),
    ]);
    expect(extractProductMeasurements(report(events)).inputToFinalCanvasFrame[0])
      .toMatchObject({ status: "ok", durationUs: 100, revision: 7 });
  });

  it("does not count ready state from a cancelled historical request as successful loading", () => {
    const events: PerfEvent[] = [
      { ...mark(0, "node.preview", 80), kind: "span_begin", spanId: 1 },
      mark(1, "node.preview.requested", 100),
      mark(2, "node.preview.ready", 200),
      { ...mark(3, "node.preview", 300), kind: "span_end", spanId: 1, outcome: "cancelled", spanDurationUs: 220 },
    ];
    expect(extractProductMeasurements(report(events)).nodeToReadyState[0])
      .toMatchObject({ status: "unavailable", durationUs: null });
  });

  it("withholds endpoint durations from incomplete captures", () => {
    const events = [mark(1, "node.preview.requested", 100), mark(2, "node.first-valid-frame", 600)];
    expect(extractProductMeasurements(report(events, "incomplete")).nodeToFirstCanvasFrame[0]).toMatchObject({ status: "incomplete", durationUs: null });
  });

  it("does not count an inner save confirmation when the outer save fails", () => {
    const start: PerfEvent = { ...mark(1, "save.node", 100), kind: "span_begin", spanId: 1, operationId: "gesture-1" };
    const end: PerfEvent = { ...mark(3, "save.node", 300), kind: "span_end", spanId: 1, operationId: "gesture-1", outcome: "error", spanDurationUs: 200 };
    const events = [start, mark(2, "save.confirmed", 200), end];
    expect(extractProductMeasurements(report(events)).saveToConfirmed[0]).toMatchObject({ status: "unavailable", durationUs: null });
  });
});
