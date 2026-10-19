import { afterEach, describe, expect, it, vi } from "vitest";
import { getPerfSink, setPerfSink } from "@reelterminal/core";
import { CaptureController, type CaptureStartOptions } from "../../../../web/src/performance/capture-controller";
import { createRendererClock } from "../../../../web/src/performance/renderer-clock";
import { captureSpanDiagnostics } from "./capture-span-diagnostics";
import { stopCaptureAtIdle, stopCaptureWhenIdle, type StoppedCaptureEvidence } from "./idle-capture-stop";
import type { Page } from "playwright-core";

const controllers: CaptureController[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) if (controller.activeRunId) controller.stopCapture();
  setPerfSink(null);
  vi.unstubAllGlobals();
});

function setup(runId = "boundary-test", options: Partial<CaptureStartOptions> = {}) {
  let now = 1;
  let expire: (() => void) | undefined;
  const controller = new CaptureController();
  controllers.push(controller);
  controller.startCapture({
    runId, mode: "light", budgets: { memorySampleIntervalSeconds: 0 },
    clock: createRendererClock({ nowMs: () => now, epoch: "boundary" }),
    timers: { set: callback => { expire = callback; return 1; }, clear: () => {} },
    eventTarget: null, observerHost: {}, visibilityCheck: () => true,
    ...options,
  });
  const api = {
    get activeRunId() { return controller.activeRunId; },
    get pendingSpanCount() { return controller.pendingSpanCount; },
    get committedFrameCount() { return controller.committedFrameCount; },
    get completedGestureFrameCount() { return controller.completedGestureFrameCount; },
  };
  const stop = vi.fn(async (): Promise<StoppedCaptureEvidence> => ({
    report: controller.stopCapture(), firstInputUs: null, intervalsMs: [], hiddenDuringAction: false,
    main: { ok: false, error: "no_active_session" },
  }));
  vi.stubGlobal("__reelterminalPerformanceCapture", api);
  vi.stubGlobal("__reelterminalPerfDriver", { stop });
  return { controller, api, stop, advance: (ms: number) => { now += ms; }, expire: () => expire!() };
}

describe("owned idle capture boundary", () => {
  it("reproduces the old two-call race and retains exact nested span evidence", async () => {
    const h = setup();
    // The previous page.waitForFunction succeeded in one renderer turn.
    expect(h.api.pendingSpanCount).toBe(0);
    const sink = getPerfSink();
    const parent = sink.begin("save.workspace-queue", { runId: "boundary-test", operationId: "secret-parent", revision: 42 });
    h.advance(0.2);
    const child = sink.begin("save.storage-transaction", { runId: "boundary-test", operationId: "secret-parent", parentSpanId: parent.id, revision: 42 });
    h.advance(0.3);
    // New product work began before the independent page.evaluate(stop).
    const evidence = await h.stop();
    expect(evidence.report).toMatchObject({ status: "incomplete", openSpans: 2, reasonCodes: ["spans_left_open"] });
    const before = structuredClone(evidence.report);
    const diagnostic = captureSpanDiagnostics(evidence.report, "edit-undo-redo-300", [
      { action: "history.redo", revisionBefore: 41, revisionAfter: 42 },
    ]);
    expect(diagnostic).toMatchObject({ totalOpenSpans: 2, recordedOpenSpans: 2, omittedDetails: 0, windowOperation: "edit-undo-redo-300" });
    expect(diagnostic.spans).toEqual([
      expect.objectContaining({ spanId: parent.id, parentSpanId: null, operationGroup: 1, phase: "save.workspace-queue", startedUs: 1000, ageUs: 500, open: true, revision: 42 }),
      expect.objectContaining({ spanId: child.id, parentSpanId: parent.id, parentRecorded: true, operationGroup: 1, phase: "save.storage-transaction", startedUs: 1200, ageUs: 300, open: true, revision: 42 }),
    ]);
    expect(JSON.stringify(diagnostic)).not.toContain("secret-parent");
    sink.end(child, "ok"); sink.end(parent, "ok");
    expect(evidence.report).toEqual(before); // late completion cannot repair a frozen incomplete capture
  });

  it("waits for new intervening work, then checks and freezes in the same renderer call", async () => {
    const h = setup();
    expect(h.api.pendingSpanCount).toBe(0);
    const sink = getPerfSink();
    const parent = sink.begin("save.workspace-queue", { runId: "boundary-test", operationId: "op" });
    const child = sink.begin("save.storage-transaction", { runId: "boundary-test", operationId: "op", parentSpanId: parent.id });
    expect(stopCaptureAtIdle({ runId: "boundary-test" })).toBe(false);
    expect(h.stop).not.toHaveBeenCalled();
    sink.end(child, "ok"); sink.end(parent, "ok");
    const result = stopCaptureAtIdle({ runId: "boundary-test" });
    expect(h.controller.activeRunId).toBeNull(); // frozen synchronously, before awaiting main/IPC
    expect((await result as StoppedCaptureEvidence).report).toMatchObject({ status: "complete", openSpans: 0 });
    expect(h.stop).toHaveBeenCalledTimes(1);
  });

  it("never ignores an unknown genuinely hanging span or reuses its expired report", () => {
    const h = setup();
    getPerfSink().begin("unknown.new-work", { runId: "boundary-test", operationId: "unknown" });
    for (let i = 0; i < 3; i++) expect(stopCaptureAtIdle({ runId: "boundary-test" })).toBe(false);
    expect(h.stop).not.toHaveBeenCalled();
    h.expire();
    expect(h.controller.lastReport).toMatchObject({ status: "incomplete", openSpans: 1 });
    expect(h.controller.lastReport!.reasonCodes).toContain("budget:capture_seconds");
    expect(stopCaptureAtIdle.bind(null, { runId: "boundary-test" })).toThrow("capture ended before idle stop");
    expect(captureSpanDiagnostics(h.controller.lastReport!, "edit-undo-redo-0", []).spans[0]!.phase).toBe("unknown.new-work");
  });

  it("rejects an already stopped complete capture and another capture owner", () => {
    const h = setup();
    expect(stopCaptureAtIdle.bind(null, { runId: "other" })).toThrow("capture owner changed");
    expect(h.stop).not.toHaveBeenCalled();
    h.controller.stopCapture();
    expect(h.controller.lastReport!.status).toBe("complete");
    expect(stopCaptureAtIdle.bind(null, { runId: "boundary-test" })).toThrow("capture ended before idle stop");
    expect(h.stop).not.toHaveBeenCalled();
  });

  it("preserves frame prerequisites and serializes without a module closure", async () => {
    const h = setup();
    const serialized = new Function(`return (${stopCaptureAtIdle.toString()})`)() as typeof stopCaptureAtIdle;
    const request = { runId: "boundary-test", requireGestureFrame: true, requireFrame: true };
    expect(serialized(request)).toBe(false);
    const sink = getPerfSink();
    sink.mark("gesture.first-valid-frame", { runId: "boundary-test", operationId: "frame" });
    expect(serialized(request)).toBe(false);
    sink.mark("frame.committed", { runId: "boundary-test", operationId: "frame" });
    expect((await serialized(request) as StoppedCaptureEvidence).report.status).toBe("complete");
    expect(h.stop).toHaveBeenCalledTimes(1);
  });

  it("keeps the existing poll timeout and disposes its returned evidence handle", async () => {
    setup();
    const dispose = vi.fn();
    const waitForFunction = vi.fn(async (predicate, request) => ({ jsonValue: async () => predicate(request), dispose }));
    const evidence = await stopCaptureWhenIdle({ waitForFunction } as unknown as Page, { runId: "boundary-test" }, 1234);
    expect(evidence.report.status).toBe("complete");
    expect(waitForFunction).toHaveBeenCalledWith(stopCaptureAtIdle, { runId: "boundary-test" }, { timeout: 1234 });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("does not mistake unavailable frame counts for completed frames", () => {
    const h = setup();
    vi.spyOn(h.api, "committedFrameCount", "get").mockReturnValue(Number.NaN);
    expect(stopCaptureAtIdle({ runId: "boundary-test", requireFrame: true })).toBe(false);
    vi.spyOn(h.api, "completedGestureFrameCount", "get").mockReturnValue(Number.NaN);
    expect(stopCaptureAtIdle({ runId: "boundary-test", requireGestureFrame: true })).toBe(false);
    expect(h.stop).not.toHaveBeenCalled();
  });

  it("propagates a real-work poll timeout without stopping or declaring completion", async () => {
    const h = setup();
    getPerfSink().begin("unknown.hanging", { runId: "boundary-test", operationId: "pending" });
    const waitForFunction = vi.fn(async (predicate, request) => {
      expect(predicate(request)).toBe(false);
      throw new Error("poll timeout");
    });
    await expect(stopCaptureWhenIdle({ waitForFunction } as unknown as Page, { runId: "boundary-test" }, 1234)).rejects.toThrow("poll timeout");
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.controller.pendingSpanCount).toBe(1);
  });

  it("does not repair dropped events when the capture is idle", async () => {
    setup("boundary-test", { budgets: { eventsCapacity: 2, criticalEventsCapacity: 1, memorySampleIntervalSeconds: 0 } });
    const sink = getPerfSink();
    for (let i = 0; i < 8; i++) {
      const span = sink.begin("unknown.work", { runId: "boundary-test", operationId: `op-${i}` });
      sink.end(span, "ok");
    }
    const evidence = await stopCaptureAtIdle({ runId: "boundary-test" }) as StoppedCaptureEvidence;
    expect(evidence.report.status).toBe("incomplete");
    expect(evidence.report.drops.eventsDropped).toBeGreaterThan(0);
  });

  it("retains closed ancestors and explicitly bounds excess unknown-span details", () => {
    const h = setup();
    const sink = getPerfSink();
    const parent = sink.begin("unknown.parent", { runId: "boundary-test", operationId: "private-parent" });
    const child = sink.begin("unknown.child", { runId: "boundary-test", operationId: "private-parent", parentSpanId: parent.id });
    sink.end(parent, "ok");
    for (let i = 0; i < 18; i++) sink.begin("unknown.future", { runId: "boundary-test", operationId: `private-${i}` });
    const report = h.controller.stopCapture();
    const diagnostic = captureSpanDiagnostics(report, "edit-undo-redo-3", []);
    expect(diagnostic.totalOpenSpans).toBe(19);
    expect(diagnostic.recordedOpenSpans).toBe(19);
    expect(diagnostic.spans).toHaveLength(16);
    expect(diagnostic.omittedDetails).toBe(4);
    expect(diagnostic.spans[0]).toMatchObject({ spanId: parent.id, phase: "unknown.parent", open: false });
    expect(diagnostic.spans[1]).toMatchObject({ spanId: child.id, parentSpanId: parent.id, phase: "unknown.child", open: true });
    expect(report.status).toBe("incomplete");
  });

  it("keeps cyclic ancestry bounded without dropping unknown open spans", () => {
    const h = setup();
    const sink = getPerfSink();
    sink.begin("unknown.first", { runId: "boundary-test", operationId: "one", parentSpanId: 2 });
    sink.begin("unknown.second", { runId: "boundary-test", operationId: "two", parentSpanId: 1 });
    const report = h.controller.stopCapture();
    const diagnostic = captureSpanDiagnostics(report, "edit-undo-redo-1", []);
    expect(diagnostic.totalOpenSpans).toBe(2);
    expect(diagnostic.spans).toHaveLength(2);
    expect(diagnostic.spans.map(span => span.parentSpanId)).toEqual([2, 1]);
    expect(report.status).toBe("incomplete");
  });
});
