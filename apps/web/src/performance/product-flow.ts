import {
  beginPerfOperation,
  endPerfOperation,
  getPerfSink,
  markPerfOperation,
  type PerfOperation,
} from "@reelterminal/core";
import { registerCaptureCleanup } from "./capture-cleanup";

interface TimelineGesture {
  operation: PerfOperation;
  pendingActions: number;
  released: boolean;
  closed: boolean;
  revision?: number;
  failed: boolean;
  project?: object;
}
let inputGesture: TimelineGesture | undefined;
let pendingFrame: { project: object; revision: number; operation: PerfOperation } | undefined;
let projectOperations = new WeakMap<object, PerfOperation>();

/** Only the foreground timeline gesture owns input correlation. */
export function beginTimelineGesture(phase: string): void {
  if (!getPerfSink().enabled) return;
  markPerfOperation(pendingFrame?.operation, "gesture.frame-superseded");
  pendingFrame = undefined;
  if (inputGesture && !inputGesture.closed) {
    endPerfOperation(inputGesture.operation, "superseded");
    inputGesture.closed = true;
  }
  const operation = beginPerfOperation(phase)!;
  inputGesture = { operation, pendingActions: 0, released: false, closed: false, failed: false };
  markPerfOperation(operation, "input.received");
}

export function getTimelinePerfOperation(): PerfOperation | undefined {
  return inputGesture?.operation.sink === getPerfSink() && !inputGesture.closed ? inputGesture.operation : undefined;
}

export function recordTimelineInput(): void {
  const operation = getTimelinePerfOperation();
  if (!operation) return;
  operation.sink.count("input.moves", 1);
  markPerfOperation(operation, "input.move-received");
}

export function finishTimelineGesture(revision: number): void {
  const operation = getTimelinePerfOperation();
  if (!operation) return;
  const gesture = inputGesture!;
  gesture.released = true;
  gesture.revision = revision;
  markPerfOperation(operation, "input.released");
  settleGesture(gesture);
}

function settleGesture(gesture: TimelineGesture): void {
  if (gesture.closed || !gesture.released || gesture.pendingActions !== 0) return;
  gesture.operation.sink.mark("gesture.final-commit", { ...gesture.operation.context, revision: gesture.revision });
  if (!gesture.failed && gesture.project && gesture.revision !== undefined) {
    const operation = { ...gesture.operation, context: { ...gesture.operation.context, revision: gesture.revision } };
    pendingFrame = { project: gesture.project, revision: gesture.revision, operation };
  }
  endPerfOperation(gesture.operation, gesture.failed ? "error" : "ok");
  gesture.closed = true;
}

/** Retain the gesture while its existing workspace queue applies the final move. */
export function beginTimelineAction(): { operation: PerfOperation; complete(revision: number, failed: boolean): void } | undefined {
  const operation = getTimelinePerfOperation();
  if (!operation) return undefined;
  const gesture = inputGesture!;
  gesture.pendingActions++;
  return {
    operation,
    complete(revision, failed) {
      gesture.pendingActions--;
      gesture.revision = revision;
      gesture.failed ||= failed;
      settleGesture(gesture);
    },
  };
}

export function cancelTimelineGesture(): void {
  endPerfOperation(getTimelinePerfOperation(), "cancelled");
  if (inputGesture) inputGesture.closed = true;
  inputGesture = undefined;
  markPerfOperation(pendingFrame?.operation, "gesture.frame-cancelled");
  pendingFrame = undefined;
}

export function resetProductPerfFlow(): void {
  cancelTimelineGesture();
  projectOperations = new WeakMap();
}
registerCaptureCleanup(resetProductPerfFlow);

export function recordGestureFrame(project: object, revision: number, frame?: { seq: number; epoch: number }): void {
  const pending = pendingFrame;
  if (!pending || pending.operation.sink !== getPerfSink()) return;
  if (project !== pending.project || revision !== pending.revision) return;
  pending.operation.sink.mark("gesture.first-valid-frame", {
    ...pending.operation.context,
    ...(frame ? { frameSeq: frame.seq, frameEpoch: frame.epoch } : {}),
  });
  pendingFrame = undefined;
}

/** Weak keys preserve correlation without retaining project snapshots. */
export function bindProjectPerfOperation(project: object, operation: PerfOperation | undefined): void {
  if (operation) projectOperations.set(project, operation);
}

export function getProjectPerfOperation(project: object): PerfOperation | undefined {
  if (!getPerfSink().enabled) return undefined;
  const operation = projectOperations.get(project);
  return operation?.sink === getPerfSink() ? operation : undefined;
}

export function recordProjectCommit(project: object, revision: number): void {
  const operation = getProjectPerfOperation(project) ?? getTimelinePerfOperation();
  if (!operation) return;
  bindProjectPerfOperation(project, operation);
  if (inputGesture?.operation.context.operationId === operation.context.operationId) {
    inputGesture.project = project;
    inputGesture.revision = revision;
  }
  operation.sink.mark("semantic-state.committed", { ...operation.context, revision });
}
