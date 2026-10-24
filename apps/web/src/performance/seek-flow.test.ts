import { afterEach, describe, expect, it } from "vitest";
import { CaptureController } from "./capture-controller";
import { beginPreviewSeek, finishPreviewSeek, getPreviewSeek, recordSeekCanvasFrame } from "./seek-flow";
import { beginTimelineGesture, bindTimelineSeekTarget, finishTimelineGesture, recordGestureFrame } from "./product-flow";

const identity = { projectId: "p", workspaceId: "w", revision: 7 };
let capture: CaptureController;
afterEach(() => { if (capture?.activeRunId) capture.stopCapture(); });

describe("seek frame correlation", () => {
  it("requires the exact seek target even when consecutive inputs share a revision", () => {
    capture = new CaptureController();
    capture.startCapture({ mode: "light", runId: "steps", observerHost: {}, budgets: { memorySampleIntervalSeconds: 0 } });
    const old = beginPreviewSeek(1, "frame-step", identity);
    const latest = beginPreviewSeek(2, "frame-step", identity);
    recordSeekCanvasFrame(latest, { time: 1, revision: 7, seq: 1, epoch: 1 });
    expect(latest.closed).toBe(false);
    expect(old.closed).toBe(true);
    expect(getPreviewSeek(2, { ...identity, workspaceId: "other" })).toBeUndefined();
    recordSeekCanvasFrame(latest, { time: 2, revision: 7, seq: 2, epoch: 1 });
    finishPreviewSeek(latest, "ok");
    const report = capture.stopCapture();
    expect(report.counters["mark:seek.canvas-committed"]).toBe(1);
    expect(report.strandedSpans).toBe(0);
    expect(report.openSpans).toBe(0);
  });

  it("binds pointer seeks without a project edit and rejects intermediate same-revision frames", () => {
    capture = new CaptureController();
    capture.startCapture({ mode: "light", runId: "pointer", observerHost: {}, budgets: { inputSampleEveryN: 1, frameSampleEveryN: 1, memorySampleIntervalSeconds: 0 } });
    const project = {};
    beginTimelineGesture("input.seek");
    bindTimelineSeekTarget(project, 7, 1);
    recordGestureFrame(project, 7, { time: 1, seq: 1, epoch: 1 });
    bindTimelineSeekTarget(project, 7, 2);
    finishTimelineGesture(7);
    recordGestureFrame(project, 7, { time: 1, seq: 2, epoch: 1 });
    recordGestureFrame(project, 7, { time: 2, seq: 3, epoch: 1 });
    const report = capture.stopCapture();
    const frames = report.events.filter(event => event.phase === "gesture.first-valid-frame");
    expect(frames.map(event => (event.kind === "mark" ? event.dims?.timelineTimeSeconds : undefined))).toEqual([1, 2]);
    const final = report.events.find(event => event.phase === "gesture.final-commit");
    expect(final?.kind === "mark" && final.dims?.timelineTimeSeconds).toBe(2);
  });
});
