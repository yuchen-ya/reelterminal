import { beginPerfOperation, endPerfOperation, getPerfSink, markPerfOperation, type PerfOperation, type Outcome } from "@reelterminal/core";
import { registerCaptureCleanup } from "./capture-cleanup";

export type PreviewSeekKind = "frame-step" | "scrub" | "jump";
export interface PreviewSeek {
  readonly id: number;
  readonly time: number;
  readonly kind: PreviewSeekKind;
  readonly projectId: string;
  readonly workspaceId: string | null;
  readonly revision: number;
  readonly operation?: PerfOperation;
  started: boolean;
  closed: boolean;
}

let sequence = 0;
let latest: PreviewSeek | undefined;
const measured = new Set<PreviewSeek>();

export function startPreviewScrub(): void {
  if (latest && !latest.started) finishPreviewSeek(latest, "superseded");
  latest = undefined;
}

/** Intent identity exists with capture off too: continuous stepping and discrete
 * jumps have different render admission policies. It is never persisted. */
export function beginPreviewSeek(
  time: number,
  kind: PreviewSeekKind,
  identity: { projectId: string; workspaceId: string | null; revision: number },
): PreviewSeek {
  if (kind === "scrub" && latest?.kind === kind && latest.time === time &&
    latest.projectId === identity.projectId && latest.workspaceId === identity.workspaceId &&
    latest.revision === identity.revision) return latest;
  if (latest && !latest.started) finishPreviewSeek(latest, "superseded");
  const operation = beginPerfOperation(`seek.${kind}`);
  const seek: PreviewSeek = { id: ++sequence, time, kind, ...identity, operation, started: false, closed: false };
  latest = seek;
  if (operation) {
    measured.add(seek);
    markPerfOperation(operation, "seek.received", { seekId: seek.id, timelineTimeSeconds: time });
  }
  return seek;
}

export function getPreviewSeek(time: number, identity: { projectId: string; workspaceId: string | null; revision: number }): PreviewSeek | undefined {
  return latest?.time === time && latest.projectId === identity.projectId &&
    latest.workspaceId === identity.workspaceId && latest.revision === identity.revision ? latest : undefined;
}

export function finishPreviewSeek(seek: PreviewSeek | undefined, outcome: Outcome, reason?: "coalesced" | "no-op" | "same-target" | "capture-stopped"): void {
  if (!seek || seek.closed) return;
  seek.closed = true;
  measured.delete(seek);
  markPerfOperation(seek.operation, `seek.finished.${reason ?? outcome}`, { seekId: seek.id });
  endPerfOperation(seek.operation, outcome);
}

export function recordSeekCanvasFrame(seek: PreviewSeek | undefined, frame: { time: number; seq: number; epoch: number; revision: number }): void {
  if (!seek || seek.closed || seek.operation?.sink !== getPerfSink() || frame.time !== seek.time || frame.revision !== seek.revision) return;
  markPerfOperation(seek.operation, "seek.canvas-committed", {
    seekId: seek.id, timelineTimeSeconds: frame.time, frameSeq: frame.seq, frameEpoch: frame.epoch,
  });
  finishPreviewSeek(seek, "ok");
}

registerCaptureCleanup(() => {
  for (const seek of measured) finishPreviewSeek(seek, "cancelled", "capture-stopped");
});
