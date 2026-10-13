import type { PerfEvent } from "@reelterminal/core";
import type { CaptureReport } from "../../../../web/src/performance";

interface ProductInterval {
  operationId: string;
  status: "ok" | "unavailable" | "incomplete";
  durationUs: number | null;
  revision?: number;
}

/** Derive only same-clock, same-operation endpoints from a frozen capture. */
export function extractProductMeasurements(report: CaptureReport) {
  const events = report.events;
  const correlated = (event: PerfEvent): event is PerfEvent & { operationId: string } =>
    "operationId" in event && typeof event.operationId === "string";
  const intervals = (startPhase: string, endPhase: string, requireFinalRevision = false, completionPhase?: string): ProductInterval[] =>
    events.filter(event => event.phase === startPhase && correlated(event)).map(start => {
      const operationId = (start as PerfEvent & { operationId: string }).operationId;
      const final = requireFinalRevision ? events.find(event => event.phase === "gesture.final-commit" && correlated(event) && event.operationId === operationId) : undefined;
      const finalRevision = final && "revision" in final ? final.revision : undefined;
      const requiresCompletion = requireFinalRevision || completionPhase !== undefined;
      const operationStart = requiresCompletion ? events.find(event =>
        event.kind === "span_begin" && correlated(event) && event.operationId === operationId &&
        event.clockId === start.clockId && event.processEpoch === start.processEpoch &&
        (completionPhase ? event.phase === completionPhase : event.phase.startsWith("input.")),
      ) : undefined;
      const completion = operationStart?.kind === "span_begin" ? events.find(event =>
        event.kind === "span_end" && event.spanId === operationStart.spanId &&
        event.clockId === start.clockId && event.processEpoch === start.processEpoch,
      ) : undefined;
      const operationSucceeded = completion?.kind === "span_end" && completion.outcome === "ok";
      const end = events.find(event => event.phase === endPhase && correlated(event) &&
        event.operationId === operationId && event.clockId === start.clockId && event.processEpoch === start.processEpoch && event.tsUs >= start.tsUs &&
        (!completionPhase || operationSucceeded) &&
        (!requireFinalRevision || operationSucceeded && finalRevision !== undefined && "revision" in event && event.revision === finalRevision));
      return {
        operationId,
        status: report.status !== "complete" ? "incomplete" : end ? "ok" : "unavailable",
        durationUs: report.status === "complete" && end ? end.tsUs - start.tsUs : null,
        ...(finalRevision !== undefined ? { revision: finalRevision } : {}),
      };
    });

  return {
    unit: "us",
    actualPresented: "unsupported",
    inputToFinalState: intervals("input.received", "gesture.final-commit"),
    inputToFinalCanvasFrame: intervals("input.received", "gesture.first-valid-frame", true),
    nodeToReadyState: intervals("node.preview.requested", "node.preview.ready", false, "node.preview"),
    nodeToFirstCanvasFrame: intervals("node.preview.requested", "node.first-valid-frame", false, "node.preview"),
    saveToConfirmed: events.filter(event => event.kind === "span_begin").filter(event => event.phase === "save.node" || event.phase === "save.workspace-snapshot").map(start => {
      const completed = events.find(event => event.kind === "span_end" && event.spanId === start.spanId && event.clockId === start.clockId && event.processEpoch === start.processEpoch);
      const confirmed = completed?.kind === "span_end" && completed.outcome === "ok"
        ? events.filter(event => event.phase === "save.confirmed" && correlated(event) && event.operationId === start.operationId && event.clockId === start.clockId && event.processEpoch === start.processEpoch && event.tsUs >= start.tsUs && event.tsUs <= completed.tsUs).at(-1)
        : undefined;
      return {
        operationId: start.operationId,
        status: report.status !== "complete" ? "incomplete" : confirmed ? "ok" : "unavailable",
        durationUs: report.status === "complete" && confirmed ? confirmed.tsUs - start.tsUs : null,
      };
    }),
    phases: events.filter(event => event.kind === "span_end").map(event => ({ phase: event.phase, operationId: event.operationId, outcome: event.outcome, durationUs: event.spanDurationUs })),
    counters: report.counters,
  };
}
