import type {
  PerfContext,
  PerfDims,
  PerfSink,
  PerfSpan,
  Outcome,
} from "@reelterminal/core";

export const EXPORT_PERFORMANCE_PHASES = [
  "submit",
  "queue",
  "prepare",
  "render",
  "encode",
  "audio",
  "write",
  "progress",
  "status.persist",
  "cancel",
  "finalize",
] as const;

export type ExportPerformancePhase = typeof EXPORT_PERFORMANCE_PHASES[number];
export type ExportPerformanceOutcome = Extract<Outcome, "ok" | "error" | "cancelled" | "timeout">;

export interface ExportPerformanceSpan {
  readonly id: number;
  readonly phase: ExportPerformancePhase;
  readonly startedUs: number;
}

/** Explicit, per-export measurement adapter. The absent/default adapter is inert. */
export interface ExportPerformanceSink {
  readonly enabled: boolean;
  supports(phase: ExportPerformancePhase): boolean;
  begin(phase: ExportPerformancePhase): ExportPerformanceSpan | null;
  end(span: ExportPerformanceSpan, outcome: ExportPerformanceOutcome, dims?: PerfDims): void;
  mark(phase: ExportPerformancePhase, dims?: PerfDims): void;
}

export interface ExportPerformanceEvent {
  readonly kind: "span_begin" | "span_end" | "mark";
  readonly phase: ExportPerformancePhase;
  readonly tsUs: number;
  readonly spanId?: number;
  readonly durationUs?: number;
  readonly outcome?: ExportPerformanceOutcome;
  readonly dims?: PerfDims;
}

export interface ExportPerformanceReport {
  readonly status: "complete" | "incomplete" | "off";
  readonly clockStatus: "valid" | "invalid" | "not_run";
  readonly phaseStatus: Readonly<Record<ExportPerformancePhase, "supported" | "unavailable">>;
  readonly events: readonly ExportPerformanceEvent[];
  readonly eventsDropped: number;
  readonly collectorErrors: number;
  readonly openSpans: number;
}

export interface ExportPerformanceCaptureOptions {
  readonly enabled: boolean;
  readonly supportedPhases: readonly ExportPerformancePhase[];
  readonly nowUs?: () => number;
  readonly capacity?: number;
  readonly openSpanCapacity?: number;
}

const NOOP_EXPORT_PERFORMANCE_SINK: ExportPerformanceSink = Object.freeze({
  enabled: false,
  supports: () => false,
  begin: () => null,
  end: () => undefined,
  mark: () => undefined,
});

/** A bounded local collector used by deterministic export probes and tests. */
export class ExportPerformanceCapture implements ExportPerformanceSink {
  readonly enabled: boolean;
  private readonly supported = new Set<ExportPerformancePhase>();
  private readonly nowUs: () => number;
  private readonly capacity: number;
  private readonly openSpanCapacity: number;
  private readonly events: ExportPerformanceEvent[] = [];
  private readonly open = new Map<number, ExportPerformanceSpan>();
  private nextSpanId = 1;
  private dropped = 0;
  private errors = 0;
  private lastClockUs: number | null = null;
  private clockInvalid = false;

  constructor(options: ExportPerformanceCaptureOptions) {
    this.enabled = options.enabled;
    this.nowUs = options.nowUs ?? monotonicNowUs;
    this.capacity = options.capacity ?? 2_048;
    this.openSpanCapacity = options.openSpanCapacity ?? Math.min(256, this.capacity);
    if (!Number.isInteger(this.capacity) || this.capacity < 1) {
      throw new RangeError("export performance capacity must be a positive integer");
    }
    if (!Number.isInteger(this.openSpanCapacity) || this.openSpanCapacity < 1) {
      throw new RangeError("export performance open-span capacity must be a positive integer");
    }
    if (this.enabled) {
      for (const phase of options.supportedPhases) this.supported.add(phase);
    }
  }

  supports(phase: ExportPerformancePhase): boolean {
    return this.enabled && this.supported.has(phase);
  }

  begin(phase: ExportPerformancePhase): ExportPerformanceSpan | null {
    if (!this.supports(phase)) return null;
    if (this.open.size >= this.openSpanCapacity || this.events.length >= this.capacity) {
      this.dropped += 1;
      return null;
    }
    const startedUs = this.readClock();
    if (startedUs === null) return null;
    const span = { id: this.nextSpanId++, phase, startedUs };
    this.open.set(span.id, span);
    this.push({ kind: "span_begin", phase, tsUs: span.startedUs, spanId: span.id });
    return span;
  }

  end(span: ExportPerformanceSpan, outcome: ExportPerformanceOutcome, dims?: PerfDims): void {
    if (!this.enabled || this.open.get(span.id) !== span) return;
    this.open.delete(span.id);
    const tsUs = this.readClock();
    if (tsUs === null) return;
    const safeDims = this.sanitizeDims(dims);
    this.push({
      kind: "span_end",
      phase: span.phase,
      tsUs,
      spanId: span.id,
      durationUs: tsUs - span.startedUs,
      outcome,
      ...(safeDims ? { dims: safeDims } : {}),
    });
  }

  mark(phase: ExportPerformancePhase, dims?: PerfDims): void {
    if (!this.supports(phase) || this.events.length >= this.capacity) {
      if (this.supports(phase)) this.dropped += 1;
      return;
    }
    if (this.events.length >= this.capacity) {
      this.dropped += 1;
      return;
    }
    const tsUs = this.readClock();
    if (tsUs === null) return;
    const safeDims = this.sanitizeDims(dims);
    this.push({ kind: "mark", phase, tsUs, ...(safeDims ? { dims: safeDims } : {}) });
  }

  report(): ExportPerformanceReport {
    const phaseStatus = Object.fromEntries(
      EXPORT_PERFORMANCE_PHASES.map((phase) => [
        phase,
        this.supports(phase) ? "supported" : "unavailable",
      ]),
    ) as Record<ExportPerformancePhase, "supported" | "unavailable">;
    const openSpans = this.open.size;
    return {
      status: !this.enabled ? "off" : this.dropped > 0 || this.errors > 0 || this.clockInvalid || openSpans > 0 ? "incomplete" : "complete",
      clockStatus: !this.enabled ? "not_run" : this.clockInvalid ? "invalid" : "valid",
      phaseStatus,
      events: this.events.map((event) => ({ ...event })),
      eventsDropped: this.dropped,
      collectorErrors: this.errors,
      openSpans,
    };
  }

  private readClock(): number | null {
    try {
      const value = this.nowUs();
      if (!Number.isFinite(value)) throw new TypeError("clock returned a non-finite value");
      if (this.lastClockUs !== null && value < this.lastClockUs) {
        this.errors += 1;
        this.clockInvalid = true;
        return null;
      }
      this.lastClockUs = value;
      return value;
    } catch {
      this.errors += 1;
      this.clockInvalid = true;
      return null;
    }
  }

  private sanitizeDims(dims: PerfDims | undefined): PerfDims | undefined {
    if (dims === undefined) return undefined;
    const output: Record<string, number | boolean> = {};
    for (const [key, value] of Object.entries(dims)) {
      if (Object.keys(output).length >= 16) {
        this.errors += 1;
        break;
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key)) {
        this.errors += 1;
        continue;
      }
      if (typeof value === "boolean") {
        output[key] = value;
      } else if (typeof value === "number" && Number.isFinite(value)) {
        output[key] = value;
      } else {
        this.errors += 1;
      }
    }
    return Object.keys(output).length > 0 ? output : undefined;
  }

  private push(event: ExportPerformanceEvent): void {
    if (this.events.length >= this.capacity) {
      this.dropped += 1;
      return;
    }
    this.events.push(event);
  }
}

/** Map the export-specific phases to an active core capture without global state. */
export function adaptPerfSinkForExport(
  sink: PerfSink | null | undefined,
  context: PerfContext,
): ExportPerformanceSink {
  if (sink === null || sink === undefined || !isEnabled(sink)) return NOOP_EXPORT_PERFORMANCE_SINK;
  return {
    enabled: true,
    supports: () => isEnabled(sink),
    begin: (phase) => {
      try {
        if (!isEnabled(sink)) return null;
        const span: PerfSpan = sink.begin(`export.${phase}`, context);
        return { id: span.id, phase, startedUs: span.startedUs };
      } catch {
        return null;
      }
    },
    end: (span, outcome, dims) => {
      try {
        if (isEnabled(sink)) sink.end({ id: span.id, startedUs: span.startedUs }, outcome, safeDims(dims));
      } catch {
        // The adapter is observational and must not alter export behavior.
      }
    },
    mark: (phase, dims) => {
      try {
        if (isEnabled(sink)) sink.mark(`export.${phase}`, context, safeDims(dims));
      } catch {
        // The adapter is observational and must not alter export behavior.
      }
    },
  };
}

export function beginExportPerformanceSpan(
  sink: ExportPerformanceSink | null | undefined,
  phase: ExportPerformancePhase,
): ExportPerformanceSpan | null {
  if (!isEnabled(sink)) return null;
  try {
    return sink.supports(phase) ? sink.begin(phase) : null;
  } catch {
    return null;
  }
}

export function endExportPerformanceSpan(
  sink: ExportPerformanceSink | null | undefined,
  span: ExportPerformanceSpan | null,
  outcome: ExportPerformanceOutcome,
  dims?: PerfDims,
): void {
  if (!isEnabled(sink) || !span) return;
  try {
    sink.end(span, outcome, safeDims(dims));
  } catch {
    // A probe must not change whether an export succeeds or how it is cancelled.
  }
}

export function markExportPerformance(
  sink: ExportPerformanceSink | null | undefined,
  phase: ExportPerformancePhase,
  dims?: PerfDims,
): void {
  if (!isEnabled(sink)) return;
  try {
    if (sink.supports(phase)) sink.mark(phase, safeDims(dims));
  } catch {
    // A probe must not change whether an export succeeds or how it is cancelled.
  }
}

export async function withExportPerformanceSpan<T>(
  sink: ExportPerformanceSink | null | undefined,
  phase: ExportPerformancePhase,
  action: () => Promise<T>,
): Promise<T> {
  if (!isEnabled(sink)) return action();
  const span = beginExportPerformanceSpan(sink, phase);
  if (!span) return action();
  try {
    const result = await action();
    endExportPerformanceSpan(sink, span, "ok");
    return result;
  } catch (error) {
    endExportPerformanceSpan(sink, span, isAbortError(error) ? "cancelled" : "error");
    throw error;
  }
}

export function withExportPerformance<T>(
  sink: ExportPerformanceSink | null | undefined,
  phase: ExportPerformancePhase,
  action: () => T,
): T {
  if (!isEnabled(sink)) return action();
  const span = beginExportPerformanceSpan(sink, phase);
  if (!span) return action();
  try {
    const result = action();
    endExportPerformanceSpan(sink, span, "ok");
    return result;
  } catch (error) {
    endExportPerformanceSpan(sink, span, isAbortError(error) ? "cancelled" : "error");
    throw error;
  }
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "name" in error && (error as { name?: unknown }).name === "AbortError";
}

function isEnabled(sink: ExportPerformanceSink | null | undefined): sink is ExportPerformanceSink;
function isEnabled(sink: PerfSink | null | undefined): sink is PerfSink;
function isEnabled(sink: ExportPerformanceSink | PerfSink | null | undefined): boolean {
  try {
    return sink?.enabled === true;
  } catch {
    return false;
  }
}

function safeDims(dims: PerfDims | undefined): PerfDims | undefined {
  if (dims === undefined) return undefined;
  const output: Record<string, number | boolean> = {};
  for (const [key, value] of Object.entries(dims)) {
    if (Object.keys(output).length >= 16) break;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key)) continue;
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
      output[key] = value;
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

let processStartNs: bigint | null = null;

function monotonicNowUs(): number {
  const nowNs = process.hrtime.bigint();
  processStartNs ??= nowNs;
  return Number((nowNs - processStartNs) / 1_000n);
}
