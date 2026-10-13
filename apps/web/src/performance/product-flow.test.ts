import { afterEach, describe, expect, it } from "vitest";
import { CaptureController } from "./capture-controller";
import { beginTimelineAction, beginTimelineGesture, finishTimelineGesture, getProjectPerfOperation, recordGestureFrame, recordProjectCommit } from "./product-flow";

let controller: CaptureController;
afterEach(() => { if (controller?.activeRunId) controller.stopCapture(); });

describe("timeline capture correlation", () => {
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
});
