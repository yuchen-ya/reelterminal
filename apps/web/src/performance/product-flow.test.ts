import { afterEach, describe, expect, it, vi } from "vitest";
import { CaptureController } from "./capture-controller";
import { beginTimelineAction, beginTimelineGesture, cancelTimelineGesture, finishTimelineGesture, getProjectPerfOperation, getTimelinePerfOperation, recordGestureFrame, recordProjectCommit, recordTimelineGestureRelease } from "./product-flow";

let controller: CaptureController;
afterEach(() => { if (controller?.activeRunId) controller.stopCapture(); });

describe("timeline capture correlation", () => {
  it("does not read a clock for gesture correlation when capture is off", () => {
    const readClock = vi.spyOn(performance, "now");
    readClock.mockClear();
    const project = {};
    try {
      beginTimelineGesture("input.media-drag");
      expect(beginTimelineAction()).toBeUndefined();
      finishTimelineGesture(1);
      recordProjectCommit(project, 1);
      recordGestureFrame(project, 1, { seq: 1, epoch: 1 });

      expect(readClock).not.toHaveBeenCalled();
    } finally {
      readClock.mockRestore();
    }
  });

  it("waits for the queued final action and accepts only its revision and project", () => {
    controller = new CaptureController();
    controller.startCapture({ mode: "light", runId: "queued-gesture", observerHost: {}, budgets: { inputSampleEveryN: 1, frameSampleEveryN: 1, memorySampleIntervalSeconds: 0 } });
    beginTimelineGesture("input.media-drag");
    const action = beginTimelineAction()!;
    finishTimelineGesture(2);
    expect(controller.pendingSpanCount).toBe(1);
    const project = {};
    recordProjectCommit(project, 3);
    action.complete(3, false);
    recordGestureFrame({}, 3);
    recordGestureFrame(project, 2);
    expect(controller.completedGestureFrameCount).toBe(0);
    recordGestureFrame(project, 3);
    expect(controller.completedGestureFrameCount).toBe(1);
    const report = controller.stopCapture();
    const final = report.events.find(event => event.phase === "gesture.final-commit");
    expect(final).toMatchObject({ revision: 3 });
    expect(report.status).toBe("complete");
    expect(getProjectPerfOperation(project)).toBeUndefined();
  });

  it("keeps the actual frame time when the target frame precedes the final callback", () => {
    controller = new CaptureController();
    let nowUs = 1_000;
    controller.startCapture({
      mode: "light",
      runId: "early-gesture-frame",
      observerHost: {},
      clock: {
        clockId: "gesture-clock",
        processEpoch: "gesture-epoch",
        timeOriginUs: 0,
        nowUs: () => nowUs,
      },
      budgets: { inputSampleEveryN: 1, frameSampleEveryN: 1, memorySampleIntervalSeconds: 0 },
    });
    beginTimelineGesture("input.media-drag");
    const action = beginTimelineAction()!;
    finishTimelineGesture(2);
    const project = {};
    recordProjectCommit(project, 3);

    nowUs = 1_500;
    recordGestureFrame({}, 3, { seq: 16, epoch: 4 });
    recordGestureFrame(project, 2, { seq: 16, epoch: 4 });
    expect(controller.completedGestureFrameCount).toBe(0);
    recordGestureFrame(project, 3, { seq: 17, epoch: 4 });
    expect(controller.completedGestureFrameCount).toBe(1);

    nowUs = 2_100;
    action.complete(3, false);
    recordGestureFrame(project, 3, { seq: 17, epoch: 4 });
    const report = controller.stopCapture();
    const frame = report.events.find((event) => event.phase === "gesture.first-valid-frame");
    const final = report.events.find((event) => event.phase === "gesture.final-commit");

    expect(frame).toMatchObject({ tsUs: 1_500, revision: 3, frameSeq: 17, frameEpoch: 4 });
    expect(final).toMatchObject({ tsUs: 2_100, revision: 3 });
    expect(report.events.filter((event) => event.phase === "gesture.first-valid-frame")).toHaveLength(1);
    expect(report.openSpans).toBe(0);
  });

  it("records physical release before the frame and delayed callback completion", () => {
    controller = new CaptureController();
    let nowUs = 1_000;
    controller.startCapture({
      mode: "light",
      runId: "gesture-release-order",
      observerHost: {},
      clock: {
        clockId: "gesture-clock",
        processEpoch: "gesture-epoch",
        timeOriginUs: 0,
        nowUs: () => nowUs,
      },
      budgets: { inputSampleEveryN: 1, frameSampleEveryN: 1, memorySampleIntervalSeconds: 0 },
    });
    beginTimelineGesture("input.media-drag");
    const action = beginTimelineAction()!;
    nowUs = 1_200;
    recordTimelineGestureRelease();
    recordTimelineGestureRelease();
    const project = {};
    nowUs = 1_500;
    recordProjectCommit(project, 3);
    nowUs = 1_700;
    recordGestureFrame(project, 3, { seq: 22, epoch: 4 });
    nowUs = 2_000;
    action.complete(3, false);
    nowUs = 2_300;
    finishTimelineGesture(3);

    const report = controller.stopCapture();
    const release = report.events.find((event) => event.phase === "input.released");
    const frame = report.events.find((event) => event.phase === "gesture.first-valid-frame");
    const final = report.events.find((event) => event.phase === "gesture.final-commit");
    expect(release).toMatchObject({ tsUs: 1_200 });
    expect(frame).toMatchObject({ tsUs: 1_700, revision: 3, frameSeq: 22 });
    expect(final).toMatchObject({ tsUs: 2_300, revision: 3 });
    expect(report.events.filter((event) => event.phase === "input.released")).toHaveLength(1);
  });

  it("ignores a late callback from gesture A after gesture B has started", () => {
    const offRelease = recordTimelineGestureRelease();
    expect(offRelease).toBeNull();
    controller = new CaptureController();
    controller.startCapture({
      mode: "light",
      runId: "gesture-callback-identity",
      observerHost: {},
      budgets: { inputSampleEveryN: 1, frameSampleEveryN: 1, memorySampleIntervalSeconds: 0 },
    });

    beginTimelineGesture("input.media-drag");
    const operationA = recordTimelineGestureRelease()!;
    beginTimelineGesture("input.media-drag");
    const operationB = getTimelinePerfOperation()!;
    finishTimelineGesture(4, operationA);
    cancelTimelineGesture(operationA);
    finishTimelineGesture(4, offRelease);
    cancelTimelineGesture(offRelease);
    expect(getTimelinePerfOperation()).toBe(operationB);

    const project = {};
    recordProjectCommit(project, 4);
    const releaseB = recordTimelineGestureRelease();
    recordGestureFrame(project, 4, { seq: 23, epoch: 4 });
    finishTimelineGesture(4, releaseB);
    const report = controller.stopCapture();
    const finals = report.events.filter((event) => event.phase === "gesture.final-commit");
    const gestureEnds = report.events.filter((event) => event.kind === "span_end" && event.phase === "input.media-drag");

    expect(finals).toHaveLength(1);
    const final = finals[0];
    expect(final && "operationId" in final ? final.operationId : undefined).toBe(operationB.context.operationId);
    expect(gestureEnds.map((event) => event.kind === "span_end" ? event.outcome : undefined)).toEqual([
      "superseded",
      "ok",
    ]);
  });

  it("keeps candidates for multiple revisions and finalizes only the target revision", () => {
    controller = new CaptureController();
    controller.startCapture({
      mode: "light",
      runId: "gesture-frame-revisions",
      observerHost: {},
      budgets: { inputSampleEveryN: 1, frameSampleEveryN: 1, memorySampleIntervalSeconds: 0 },
    });
    beginTimelineGesture("input.media-drag");
    const action = beginTimelineAction()!;
    finishTimelineGesture(2);
    const projectAtThree = {};
    const projectAtFour = {};
    recordProjectCommit(projectAtThree, 3);
    recordGestureFrame(projectAtThree, 3, { seq: 20, epoch: 4 });
    recordProjectCommit(projectAtFour, 4);
    recordGestureFrame(projectAtFour, 4, { seq: 21, epoch: 4 });
    action.complete(4, false);

    const report = controller.stopCapture();
    const frames = report.events.filter((event) => event.phase === "gesture.first-valid-frame");
    const final = report.events.find((event) => event.phase === "gesture.final-commit");
    expect(frames.map((event) => event.kind === "mark" ? event.revision : undefined)).toEqual([3, 4]);
    expect(frames.map((event) => event.kind === "mark" ? event.frameSeq : undefined)).toEqual([20, 21]);
    expect(final).toMatchObject({ revision: 4 });
  });

  it("does not finalize a failed gesture from an early candidate frame", () => {
    controller = new CaptureController();
    controller.startCapture({
      mode: "light",
      runId: "failed-gesture-frame",
      observerHost: {},
      budgets: { inputSampleEveryN: 1, frameSampleEveryN: 1, memorySampleIntervalSeconds: 0 },
    });
    beginTimelineGesture("input.media-drag");
    const action = beginTimelineAction()!;
    recordTimelineGestureRelease();
    const project = {};
    recordProjectCommit(project, 3);
    recordGestureFrame(project, 3, { seq: 18, epoch: 4 });
    action.complete(3, true);
    cancelTimelineGesture();

    const report = controller.stopCapture();
    expect(report.events.some((event) => event.phase === "gesture.first-valid-frame")).toBe(true);
    expect(report.events.some((event) => event.phase === "gesture.final-commit")).toBe(false);
    expect(report.events.some((event) => event.kind === "span_end" && event.phase === "input.media-drag" && event.outcome === "cancelled")).toBe(true);
    expect(report.openSpans).toBe(0);
  });

  it("does not finalize a cancelled gesture from an early candidate frame", () => {
    controller = new CaptureController();
    controller.startCapture({
      mode: "light",
      runId: "cancelled-gesture-frame",
      observerHost: {},
      budgets: { inputSampleEveryN: 1, frameSampleEveryN: 1, memorySampleIntervalSeconds: 0 },
    });
    beginTimelineGesture("input.media-drag");
    const action = beginTimelineAction()!;
    recordTimelineGestureRelease();
    const project = {};
    recordProjectCommit(project, 3);
    recordGestureFrame(project, 3, { seq: 19, epoch: 4 });
    cancelTimelineGesture();
    action.complete(3, false);

    const report = controller.stopCapture();
    expect(report.events.some((event) => event.phase === "gesture.first-valid-frame")).toBe(true);
    expect(report.events.some((event) => event.phase === "gesture.final-commit")).toBe(false);
    expect(report.openSpans).toBe(0);
  });
});
