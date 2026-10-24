import type { PerfEvent, PerfDims } from "@reelterminal/core";
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
  const dims = (event: PerfEvent | undefined): PerfDims | undefined => event && "dims" in event ? event.dims : undefined;
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
        (!requireFinalRevision || operationSucceeded && finalRevision !== undefined && "revision" in event && event.revision === finalRevision &&
          (dims(final)?.timelineTimeSeconds === undefined || dims(event)?.timelineTimeSeconds === dims(final)!.timelineTimeSeconds)));
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
    seekToCanvasFrame: events.filter(correlated).filter(event => event.phase === "seek.received").map(start => {
      const related = events.filter(event => correlated(event) && event.operationId === start.operationId &&
        event.clockId === start.clockId && event.processEpoch === start.processEpoch && event.tsUs >= start.tsUs);
      const complete = related.find(event => event.kind === "span_end" && /^seek\.(frame-step|scrub|jump)$/.test(event.phase));
      const frame = related.find(event => event.phase === "seek.canvas-committed" && dims(event)?.seekId === dims(start)?.seekId &&
        dims(event)?.timelineTimeSeconds === dims(start)?.timelineTimeSeconds);
      const outcome = complete?.kind === "span_end" ? complete.outcome : undefined;
      const finished = related.find(event => event.phase.startsWith("seek.finished."));
      return {
        operationId: start.operationId, seekId: dims(start)?.seekId,
        timelineTimeSeconds: dims(start)?.timelineTimeSeconds,
        status: report.status !== "complete" ? "incomplete" : outcome === "ok" && frame ? "ok" : outcome && outcome !== "ok" ? outcome : "unavailable",
        reason: finished?.phase.replace("seek.finished.", ""),
        durationUs: report.status === "complete" && outcome === "ok" && frame ? frame.tsUs - start.tsUs : null,
        requested: related.filter(event => event.phase === "frame.requested").length,
        started: related.filter(event => event.phase === "frame.started").length,
        committed: related.filter(event => event.phase === "frame.committed" && dims(event)?.contentAvailable === true).length,
        renderCountsComplete: report.drops.samplesDropped === 0 && report.drops.eventsDropped === 0,
      };
    }),
    frameDiagnostics: {
      requested: report.counters["mark:frame.requested"] ?? 0,
      started: report.counters["mark:frame.started"] ?? 0,
      committed: report.counters["mark:frame.committed"] ?? 0,
      superseded: report.counters["span:frame.render:superseded"] ?? 0,
      deduplicated: report.counters["frame.deduplicated"] ?? 0,
      decoderCreated: report.counters["decoder.created"] ?? 0,
      decoderReleased: report.counters["decoder.released"] ?? 0,
      decoderUses: report.counters["decoder.used"] ?? 0,
      sameTargetCacheHits: report.counters["decoder.cache-hit"] ?? 0,
      decodeTimeouts: report.counters["decoder.seek-timeout"] ?? 0,
    },
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
