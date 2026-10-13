import { randomBytes } from "node:crypto";
import { PERFORMANCE_EVENT_SCHEMA_VERSION } from "@reelterminal/core";
import type {
  PerfContext,
  PerfDims,
  PerfEvent,
  Outcome,
  PerfSink,
  PerfSpan,
} from "@reelterminal/core";
import type { PerfMainCaptureReport, PerfSessionMode } from "../../shared/performance-contract";

export const DEFAULT_MAIN_PERFORMANCE_EVENT_CAPACITY = 4_096;
const MAX_MAIN_PERFORMANCE_OPEN_SPANS = 4_096;
const MAX_MAIN_PERFORMANCE_COUNTERS = 256;
const MAX_MAIN_PERFORMANCE_LABELS = 256;
const INVALID_LABEL = "invalid-label";
const LABEL_POOL_OVERFLOW = "label-pool-overflow";
const FALLBACK_SPAN: PerfSpan = Object.freeze({ id: 0, startedUs: 0 });

interface MainSpan extends PerfSpan {
  readonly phase: string;
  readonly context: PerfContext;
}

function createIdentity(prefix: string): string {
  return `${prefix}-${randomBytes(8).toString("hex")}`;
}

const MAIN_PROCESS_CLOCK_ID = createIdentity("main-clock");
const MAIN_PROCESS_EPOCH = createIdentity("main-epoch");

function isSafeLabel(value: string): boolean {
  return value.length > 0 && value.length <= 80 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function safeDims(dims: PerfDims | undefined): { readonly dims?: PerfDims; readonly truncatedFields: number } {
  if (!dims) return { truncatedFields: 0 };
  const cleaned: Record<string, number | boolean> = {};
  let truncatedFields = 0;
  for (const [key, value] of Object.entries(dims)) {
    if (Object.keys(cleaned).length >= 16) {
      truncatedFields += 1;
      continue;
    }
    if (!isSafeLabel(key) || key.length > 64) {
      truncatedFields += 1;
      continue;
    }
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
      cleaned[key] = value;
    } else {
      truncatedFields += 1;
    }
  }
  return {
    ...(Object.keys(cleaned).length > 0 ? { dims: cleaned } : {}),
    truncatedFields,
  };
}

/**
 * Bounded, main-clock collector for the opt-in performance session. Main and
 * renderer events retain separate clock identities and are never subtracted
 * from one another without a valid handshake estimate.
 */
export class MainPerformanceCapture implements PerfSink {
  readonly enabled = true;
  readonly mode: PerfSessionMode;
  readonly runId: string;
  readonly clockId = MAIN_PROCESS_CLOCK_ID;
  readonly processEpoch = MAIN_PROCESS_EPOCH;

  private readonly capacity: number;
  private readonly nowUs: () => number;
  private readonly spans = new Map<number, MainSpan>();
  private readonly events: PerfEvent[] = [];
  private readonly counters = new Map<string, number>();
  private nextSequence = 0;
  private nextSpanId = 0;
  private droppedEvents = 0;
  private droppedLabels = 0;
  private droppedSpans = 0;
  private truncatedFields = 0;
  private collectorErrors = 0;
  private closed = false;
  private readonly labels = new Set<string>();

  constructor(
    runId: string,
    mode: PerfSessionMode,
    private readonly startedUs: number,
    nowUs: () => number,
    capacity = DEFAULT_MAIN_PERFORMANCE_EVENT_CAPACITY,
  ) {
    this.runId = runId;
    this.mode = mode;
    this.nowUs = nowUs;
    this.capacity = capacity;
  }

  begin(phase: string, context: PerfContext): PerfSpan {
    if (this.closed) return FALLBACK_SPAN;
    try {
      const label = this.safePhase(phase);
      this.increment(`span:${label}`, 1);
      this.nextSpanId += 1;
      if (this.spans.size >= MAX_MAIN_PERFORMANCE_OPEN_SPANS) {
        this.droppedSpans += 1;
        return FALLBACK_SPAN;
      }
      const startedUs = this.mode === "counts" ? 0 : this.nowUs();
      const span: MainSpan = {
        id: this.nextSpanId,
        startedUs,
        phase: label,
        context: this.safeContext(context),
      };
      this.spans.set(span.id, span);
      if (this.mode !== "counts") {
        this.append({
          ...this.baseEvent("span_begin", label, startedUs),
          kind: "span_begin",
          spanId: span.id,
          ...(span.context.parentSpanId !== undefined ? { parentSpanId: span.context.parentSpanId } : {}),
          operationId: span.context.operationId,
        });
      }
      return span;
    } catch {
      this.collectorErrors += 1;
      return FALLBACK_SPAN;
    }
  }

  end(span: PerfSpan, outcome: Outcome, dims?: PerfDims): void {
    if (this.closed) return;
    try {
      const tracked = this.spans.get(span.id);
      if (!tracked) return;
      this.spans.delete(span.id);
      this.increment(`span:${tracked.phase}:${outcome}`, 1);
      if (this.mode === "counts") return;
      const stoppedUs = this.nowUs();
      const safe = safeDims(dims);
      this.truncatedFields += safe.truncatedFields;
      this.append({
        ...this.baseEvent("span_end", tracked.phase, stoppedUs),
        kind: "span_end",
        spanId: tracked.id,
        operationId: tracked.context.operationId,
        outcome,
        spanDurationUs: Math.max(0, stoppedUs - tracked.startedUs),
        ...(safe.dims ? { dims: safe.dims } : {}),
      });
    } catch {
      this.collectorErrors += 1;
    }
  }

  mark(phase: string, context: PerfContext, dims?: PerfDims): void {
    if (this.closed) return;
    try {
      const label = this.safePhase(phase);
      this.increment(`mark:${label}`, 1);
      if (this.mode === "counts") return;
      const safeContext = this.safeContext(context);
      const safe = safeDims(dims);
      this.truncatedFields += safe.truncatedFields;
      this.append({
        ...this.baseEvent("mark", label, this.nowUs()),
        kind: "mark",
        ...(safeContext.operationId ? { operationId: safeContext.operationId } : {}),
        ...(safe.dims ? { dims: safe.dims } : {}),
      });
    } catch {
      this.collectorErrors += 1;
    }
  }

  count(key: string, delta: number, _context?: PerfContext): void {
    if (this.closed || !Number.isFinite(delta)) return;
    try {
      this.increment(this.safePhase(key), delta);
    } catch {
      this.collectorErrors += 1;
    }
  }

  finish(stoppedUs: number, initialReasonCodes: readonly string[] = []): PerfMainCaptureReport {
    this.closed = true;
    const openSpans = this.spans.size;
    const reasonCodes = [...initialReasonCodes];
    if (this.droppedEvents > 0) reasonCodes.push("main_events_dropped");
    if (this.droppedLabels > 0) reasonCodes.push("main_labels_dropped");
    if (this.droppedSpans > 0) reasonCodes.push("main_spans_dropped");
    if (this.truncatedFields > 0) reasonCodes.push("main_fields_truncated");
    if (this.collectorErrors > 0) reasonCodes.push("main_collector_errors");
    if (openSpans > 0) reasonCodes.push("main_spans_left_open");
    const counters: Record<string, number> = {};
    for (const key of [...this.counters.keys()].sort()) counters[key] = this.counters.get(key) as number;
    return {
      runId: this.runId,
      mode: this.mode,
      clockId: this.clockId,
      processEpoch: this.processEpoch,
      startedUs: this.startedUs,
      stoppedUs,
      status: reasonCodes.length === 0 ? "complete" : "incomplete",
      events: [...this.events],
      counters,
      eventsDropped: this.droppedEvents,
      labelsDropped: this.droppedLabels,
      spansDropped: this.droppedSpans,
      truncatedFields: this.truncatedFields,
      collectorErrors: this.collectorErrors,
      openSpans,
      reasonCodes,
    };
  }

  private baseEvent(kind: PerfEvent["kind"], phase: string, tsUs: number) {
    this.nextSequence += 1;
    return {
      schemaVersion: PERFORMANCE_EVENT_SCHEMA_VERSION,
      runId: this.runId,
      processRole: "main" as const,
      processEpoch: this.processEpoch,
      clockId: this.clockId,
      seq: this.nextSequence,
      kind,
      phase,
      tsUs,
    };
  }

  private safePhase(phase: string): string {
    if (!isSafeLabel(phase)) {
      this.droppedLabels += 1;
      return INVALID_LABEL;
    }
    if (this.labels.has(phase)) return phase;
    if (this.labels.size >= MAX_MAIN_PERFORMANCE_LABELS) {
      this.droppedLabels += 1;
      return LABEL_POOL_OVERFLOW;
    }
    this.labels.add(phase);
    return phase;
  }

  private safeContext(context: PerfContext): PerfContext {
    const operationId = isSafeLabel(context.operationId) ? context.operationId : "unattributed";
    if (operationId === "unattributed" && context.operationId !== operationId) this.droppedLabels += 1;
    return {
      runId: this.runId,
      operationId,
      ...(Number.isInteger(context.parentSpanId) && context.parentSpanId! >= 0
        ? { parentSpanId: context.parentSpanId }
        : {}),
    };
  }

  private increment(key: string, delta: number): void {
    if (!this.counters.has(key) && this.counters.size >= MAX_MAIN_PERFORMANCE_COUNTERS) {
      this.droppedLabels += 1;
      return;
    }
    this.counters.set(key, (this.counters.get(key) ?? 0) + delta);
  }

  private append(event: PerfEvent): void {
    if (this.events.length >= this.capacity) {
      this.droppedEvents += 1;
      return;
    }
    this.events.push(event);
  }
}
