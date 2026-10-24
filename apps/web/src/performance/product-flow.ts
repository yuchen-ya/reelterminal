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
  releaseRecorded: boolean;
  released: boolean;
  closed: boolean;
  revision?: number;
  failed: boolean;
  project?: object;
  targetTime?: number;
  markedFrames: WeakMap<object, Set<string>>;
}
let inputGesture: TimelineGesture | undefined;
let pendingFrame: { project: object; revision: number; targetTime?: number; operation: PerfOperation } | undefined;
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
  inputGesture = {
    operation,
    pendingActions: 0,
    releaseRecorded: false,
    released: false,
    closed: false,
    failed: false,
    markedFrames: new WeakMap(),
  };
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

export function finishTimelineGesture(revision: number, expectedOperation?: PerfOperation | null): void {
  if (arguments.length > 1 && (!expectedOperation || inputGesture?.operation !== expectedOperation)) return;
  const operation = getTimelinePerfOperation();
  if (!operation) return;
  recordTimelineGestureRelease();
  const gesture = inputGesture!;
  gesture.released = true;
  gesture.revision = revision;
  settleGesture(gesture);
}

/** Record the physical pointer release without completing the async commit. */
export function recordTimelineGestureRelease(): PerfOperation | null {
  const operation = getTimelinePerfOperation();
  if (!operation) return null;
  const gesture = inputGesture!;
  if (!gesture.releaseRecorded) {
    gesture.releaseRecorded = true;
    markPerfOperation(operation, "input.released");
  }
  return operation;
}

function settleGesture(gesture: TimelineGesture): void {
  if (gesture.closed || !gesture.released || gesture.pendingActions !== 0) return;
  if (!gesture.failed && gesture.project && gesture.revision !== undefined) {
    if (!hasMarkedFrame(gesture, gesture.project, gesture.revision)) {
      const operation = { ...gesture.operation, context: { ...gesture.operation.context, revision: gesture.revision } };
      pendingFrame = { project: gesture.project, revision: gesture.revision, targetTime: gesture.targetTime, operation };
    }
  }
  if (!gesture.failed) {
    gesture.operation.sink.mark("gesture.final-commit", {
      ...gesture.operation.context,
      ...(gesture.revision !== undefined ? { revision: gesture.revision } : {}),
    }, gesture.targetTime === undefined ? undefined : { timelineTimeSeconds: gesture.targetTime });
  }
  endPerfOperation(gesture.operation, gesture.failed ? "error" : "ok");
  gesture.closed = true;
}

function hasMarkedFrame(gesture: TimelineGesture, project: object, revision: number): boolean {
  return gesture.markedFrames.get(project)?.has(`${revision}:${gesture.targetTime ?? ""}`) ?? false;
}

function markGestureFrame(
  gesture: TimelineGesture,
  project: object,
  revision: number,
  frame?: { seq: number; epoch: number; time?: number },
): void {
  let revisions = gesture.markedFrames.get(project);
  if (!revisions) {
    revisions = new Set();
    gesture.markedFrames.set(project, revisions);
  }
  const key = `${revision}:${gesture.targetTime ?? ""}`;
  if (revisions.has(key)) return;
  revisions.add(key);
  gesture.operation.sink.mark("gesture.first-valid-frame", {
    ...gesture.operation.context,
    revision,
    ...(frame ? { frameSeq: frame.seq, frameEpoch: frame.epoch } : {}),
  }, frame?.time === undefined ? undefined : { timelineTimeSeconds: frame.time });
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

export function cancelTimelineGesture(expectedOperation?: PerfOperation | null): void {
  if (arguments.length > 0 && (!expectedOperation || inputGesture?.operation !== expectedOperation)) return;
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

export function recordGestureFrame(project: object, revision: number, frame?: { seq: number; epoch: number; time?: number }): void {
  const sink = getPerfSink();
  if (!sink.enabled) return;
  const gesture = inputGesture;
  if (
    gesture &&
    !gesture.closed &&
    gesture.operation.sink === sink &&
    gesture.project === project &&
    gesture.revision === revision
  ) {
    if (gesture.targetTime !== undefined && gesture.targetTime !== frame?.time) return;
    markGestureFrame(gesture, project, revision, frame);
    return;
  }

  const pending = pendingFrame;
  if (!pending || pending.operation.sink !== sink) return;
  if (project !== pending.project || revision !== pending.revision ||
    (pending.targetTime !== undefined && pending.targetTime !== frame?.time)) return;
  pending.operation.sink.mark("gesture.first-valid-frame", {
    ...pending.operation.context,
    ...(frame ? { frameSeq: frame.seq, frameEpoch: frame.epoch } : {}),
  }, frame?.time === undefined ? undefined : { timelineTimeSeconds: frame.time });
  pendingFrame = undefined;
}

/** Seek changes transient timeline state, so it has no project mutation to
 * establish the gesture's project/revision/frame target. Bind it explicitly. */
export function bindTimelineSeekTarget(project: object, revision: number, time: number): void {
  if (!getTimelinePerfOperation()) return;
  inputGesture!.project = project;
  inputGesture!.revision = revision;
  inputGesture!.targetTime = time;
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
