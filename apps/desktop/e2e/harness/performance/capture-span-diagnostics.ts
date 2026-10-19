import type { CaptureReport } from "../../../../web/src/performance/capture-controller";
import type { PerfSpanBeginEvent } from "@reelterminal/core";
import type { PerfStopReply } from "../../../src/shared/performance-contract";

export interface CaptureTriggerAction {
  action: "clip.move" | "history.undo" | "history.redo";
  revisionBefore: number;
  revisionAfter: number | null;
}

// Labels are diagnostics, never a predicate for waiting or declaring completion.
// Keep unknown phases as entries; redact unsafe label content, not the span.
function safePhase(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value) &&
    !/gh[pousr]_|github_pat_|AKIA[0-9A-Z]{16}/.test(value) ? value : "redacted";
}

/** Read the existing frozen snapshot. Never close spans or mutate the report. */
export function captureSpanDiagnostics(
  report: CaptureReport,
  operationId: string,
  actions: readonly CaptureTriggerAction[],
) {
  // report.events already merges the regular and critical stores.
  const begins = report.events.filter((event): event is PerfSpanBeginEvent => event.kind === "span_begin");
  const ended = new Set(report.events.filter(event => event.kind === "span_end").map(event => event.spanId));
  const byId = new Map(begins.map(event => [event.spanId, event]));
  const open = begins.filter(event => !ended.has(event.spanId));
  const selected = new Set<number>();
  for (const event of open) {
    let current: PerfSpanBeginEvent | undefined = event;
    while (current && !selected.has(current.spanId)) {
      selected.add(current.spanId);
      current = current.parentSpanId === undefined ? undefined : byId.get(current.parentSpanId);
    }
  }
  const operationGroups = new Map<string, number>();
  for (const event of begins) {
    if (!operationGroups.has(event.operationId)) operationGroups.set(event.operationId, operationGroups.size + 1);
  }
  const details = begins.filter(event => selected.has(event.spanId)).slice(0, 16);
  return {
    windowOperation: /^edit-undo-redo-\d{1,7}$/.test(operationId) ? operationId : "redacted",
    clock: "renderer_monotonic_us",
    captureStartedUs: report.startedUs,
    captureStoppedUs: report.stoppedUs,
    totalOpenSpans: report.openSpans,
    recordedOpenSpans: open.length,
    unrecordedOpenSpans: Math.max(0, report.openSpans - open.length),
    omittedDetails: Math.max(0, selected.size - details.length),
    // A trigger window is not a claim that every background span has a unique
    // causal action. Revision/group/parent evidence supports attribution later.
    triggerActions: actions.slice(0, 3).map(action => ({
      action: ["clip.move", "history.undo", "history.redo"].includes(action.action) ? action.action : "redacted",
      revisionBefore: action.revisionBefore, revisionAfter: action.revisionAfter,
    })),
    spans: details.map(event => ({
      spanId: event.spanId,
      parentSpanId: event.parentSpanId ?? null,
      parentRecorded: event.parentSpanId !== undefined && byId.has(event.parentSpanId),
      operationGroup: operationGroups.get(event.operationId)!,
      phase: safePhase(event.phase),
      phaseRedacted: safePhase(event.phase) !== event.phase,
      startedUs: event.tsUs,
      ageUs: Math.max(0, report.stoppedUs - event.tsUs),
      open: !ended.has(event.spanId),
      revision: event.revision ?? null,
      frameSeq: event.frameSeq ?? null,
    })),
  };
}

export function resourceCaptureDiagnostics(
  evidence: { report: CaptureReport; main: PerfStopReply; hiddenDuringAction: boolean },
  operationId: string,
  actions: readonly CaptureTriggerAction[],
) {
  const main = evidence.main.ok ? evidence.main.mainCapture : null;
  const ended = new Set(main?.events.filter(event => event.kind === "span_end").map(event => event.spanId));
  const open = main?.events.flatMap(event => event.kind === "span_begin" && !ended.has(event.spanId)
    ? [{ phase: event.phase === "live.ipc.main.request" ? event.phase : "other", ageUs: Math.max(0, main.stoppedUs - event.tsUs) }] : []).slice(0, 8) ?? [];
  return {
    status: evidence.report.status, reasonCodes: evidence.report.reasonCodes,
    wallDurationUs: evidence.report.wallDurationUs, hiddenDuringAction: evidence.hiddenDuringAction,
    rendererOpenSpans: evidence.report.openSpans,
    rendererSpanEvidence: captureSpanDiagnostics(evidence.report, operationId, actions),
    mainStatus: main?.status ?? "unavailable",
    mainReasonCodes: main?.reasonCodes ?? ["main_capture_unavailable"],
    mainOpenSpans: main?.openSpans ?? null,
    mainOpenPhases: open.map(detail => detail.phase),
    mainOldestOpenSpanUs: Math.max(0, ...open.map(detail => detail.ageUs)),
  };
}
