import { describe, expect, it } from "vitest";
import type { PerfEvent } from "@reelterminal/core";
import type { CaptureReport } from "../../../../web/src/performance";
import { extractProductMeasurements } from "./product-metrics";

function mark(seq: number, phase: string, tsUs: number, revision?: number): PerfEvent {
  return { schemaVersion: 1, runId: "test", processRole: "renderer", processEpoch: "epoch", clockId: "clock", seq, kind: "mark", phase, tsUs, operationId: "gesture-1", ...(revision === undefined ? {} : { revision }) };
}

function report(events: PerfEvent[], status: CaptureReport["status"] = "complete"): CaptureReport {
  return { status, stopReason: "user_stop", runId: "test", mode: "light", clockId: "clock", processEpoch: "epoch", startedUs: 0, stoppedUs: 1000, wallDurationUs: 1000, events, criticalEvents: [], counters: {}, drops: { eventsDropped: 0, criticalEndpointsDropped: 0, samplesDropped: 0, labelsDropped: 0, truncatedFields: 0 }, observerCapabilities: { longTask: "unsupported", eventTiming: "unsupported" }, memory: { capability: "unsupported", samples: 0 }, strandedSpans: 0, openSpans: 0, collectorErrors: 0, reasonCodes: [] };
}

describe("product endpoint evidence", () => {
  it("selects only the canvas frame for the gesture's final revision", () => {
    const result = extractProductMeasurements(report([
      mark(1, "input.received", 100), mark(2, "gesture.final-commit", 300, 7),
      mark(3, "gesture.first-valid-frame", 400, 6), mark(4, "gesture.first-valid-frame", 600, 7),
    ]));
    expect(result.inputToFinalState[0]?.durationUs).toBe(200);
    expect(result.inputToFinalCanvasFrame[0]).toMatchObject({ status: "ok", durationUs: 500, revision: 7 });
    expect(result.actualPresented).toBe("unsupported");
  });

  it("does not report another clock or missing canvas endpoint as a zero duration", () => {
    const events = [mark(1, "input.received", 100), mark(2, "gesture.final-commit", 300, 7), { ...mark(3, "gesture.first-valid-frame", 400, 7), clockId: "other-clock" }];
    expect(extractProductMeasurements(report(events)).inputToFinalCanvasFrame[0]).toMatchObject({ status: "unavailable", durationUs: null });
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
