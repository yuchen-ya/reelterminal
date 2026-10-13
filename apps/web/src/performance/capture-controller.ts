/**
 * Renderer capture controller (design phase P1).
 *
 * Owns the single active capture in this renderer realm:
 * - installs a bounded collector into the core sink slot for the duration of
 *   one capture and restores the NOOP sink on every exit path (stop, budget
 *   auto-stop, renderer unload);
 * - enforces mode-aware budgets (time, ring capacity, label pool, dims caps)
 *   and turns every overflow into an explicit incomplete reason code — never
 *   into silently missing evidence;
 * - keeps exact counters at all times; stores bounded events only in
 *   light/trace modes, sampling high-frequency input./frame. phases 1/N
 *   while semantic endpoints stay full-retention in the critical store;
 * - is contractually non-throwing from the sink surface: a collector bug
 *   counts itself (collectorErrors) and must not change business behavior.
 *
 * Nothing in the product starts a capture by itself; the e2e driver (P2) or
 * an explicit local diagnostic does.
 */
import {
  NOOP_SINK,
  PERFORMANCE_EVENT_SCHEMA_VERSION,
  getPerfSink,
  resolvePerfBudgets,
  setPerfSink,
} from "@reelterminal/core";
import type {
  CaptureMode,
  CaptureStatus,
  Outcome,
  PerfBudgets,
  PerfContext,
  PerfDims,
  PerfDropStats,
  PerfEvent,
  PerfSink,
  PerfSpan,
} from "@reelterminal/core";
import { PerfRingBuffer } from "./ring-buffer";
import { createRendererClock, type RendererPerfClock } from "./renderer-clock";
import {
  INVALID_PHASE_LABEL,
  LABEL_POOL_OVERFLOW,
  defaultPrivacyLimits,
  sanitizeDims,
  sanitizeLabel,
  type PrivacyLimits,
} from "./privacy";
import { createObserverBundle, type ObserverHost, type ObserverSupport } from "./observers";

export type ActiveCaptureMode = Exclude<CaptureMode, "off">;
export type CaptureStopReason = "user_stop" | "budget:capture_seconds" | "renderer_unload";

export type PerfCaptureErrorCode =
  | "capture_already_active"
  | "no_active_capture"
  | "invalid_mode"
  | "window_not_visible"
  | "sink_slot_occupied";

export class PerfCaptureError extends Error {
  constructor(readonly code: PerfCaptureErrorCode) {
    super(`perf-capture: ${code}`);
    this.name = "PerfCaptureError";
  }
}

export interface PerfTimerApi {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** Phases whose events belong to the never-sampled critical store. */
export const DEFAULT_CRITICAL_PHASE_TESTS: readonly ((phase: string) => boolean)[] = [
  (p) => p.startsWith("gesture.final-commit"),
  (p) => p.startsWith("semantic-state.committed"),
  (p) => p.startsWith("save.confirmed"),
  (p) => p.startsWith("save.storage-transaction-committed"),
  (p) => p.startsWith("node.first-valid-frame"),
  (p) => p.startsWith("node.first-frame"),
];

const DEFAULT_HIGH_FREQUENCY_PATTERN = /^(input|frame)\./;

export interface MemoryReading {
  readonly usedJSHeapSize: number;
  readonly totalJSHeapSize: number;
}

export interface CaptureStartOptions {
  mode: ActiveCaptureMode;
  runId?: string;
  budgets?: Partial<PerfBudgets>;
  criticalPhaseTests?: readonly ((phase: string) => boolean)[];
  highFrequencyPattern?: RegExp;
  clock?: RendererPerfClock;
  timers?: PerfTimerApi;
  readMemory?: () => MemoryReading | null;
  eventTarget?: { addEventListener(t: string, cb: () => void): void; removeEventListener(t: string, cb: () => void): void } | null;
  visibilityCheck?: () => boolean;
  observerHost?: ObserverHost;
  onAutoStop?: (report: CaptureReport) => void;
}

export interface CaptureHandle {
  readonly runId: string;
  readonly mode: ActiveCaptureMode;
  readonly startedUs: number;
}

export interface CaptureReport {
  readonly status: CaptureStatus;
  readonly stopReason: CaptureStopReason;
  readonly runId: string;
  readonly mode: ActiveCaptureMode;
  readonly clockId: string;
  readonly processEpoch: string;
  readonly startedUs: number;
  readonly stoppedUs: number;
  readonly wallDurationUs: number;
  readonly events: readonly PerfEvent[];
  readonly criticalEvents: readonly PerfEvent[];
  readonly counters: Readonly<Record<string, number>>;
  readonly drops: PerfDropStats;
  readonly observerCapabilities: { readonly longTask: ObserverSupport; readonly eventTiming: ObserverSupport };
  readonly memory: { readonly capability: ObserverSupport; readonly samples: number };
  readonly strandedSpans: number;
  readonly openSpans: number;
  readonly collectorErrors: number;
  readonly reasonCodes: readonly string[];
}

interface CollectorSpan extends PerfSpan {
  readonly phase: string;
  readonly critical: boolean;
  readonly record: boolean;
  readonly captureRunId: string;
  readonly ctx: PerfContext;
}

interface ActiveCapture {
  runId: string;
  mode: ActiveCaptureMode;
  budgets: PerfBudgets;
  limits: PrivacyLimits;
  clock: RendererPerfClock;
  ring: PerfRingBuffer;
  counters: Map<string, number>;
  labelPool: Set<string>;
  samplingSeen: Map<string, number>;
  criticalTests: readonly ((phase: string) => boolean)[];
  highFrequencyPattern: RegExp;
  seq: number;
  spanSeq: number;
  openSpanIds: Set<number>;
  strandedSpans: number;
  collectorErrors: number;
  labelsDropped: number;
  truncatedFields: number;
  samplesDropped: number;
  startedUs: number;
  autoStopHandle: unknown;
  memoryHandle: unknown;
  memoryCapability: ObserverSupport;
  memorySamples: number;
  observerBundle: ReturnType<typeof createObserverBundle> | null;
  eventTarget: CaptureStartOptions["eventTarget"];
  pagehideHandler: (() => void) | null;
  onAutoStop: ((report: CaptureReport) => void) | null;
  timers: PerfTimerApi;
  closed: boolean;
}

function defaultTimers(): PerfTimerApi {
  return {
    set: (callback, ms) => setInterval(callback, ms),
    clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  };
}

function defaultReadMemory(): MemoryReading | null {
  const memory = (performance as { memory?: MemoryReading }).memory;
  if (!memory) return null;
  const used = memory.usedJSHeapSize;
  const total = memory.totalJSHeapSize;
  if (typeof used !== "number" || typeof total !== "number") return null;
  if (!Number.isFinite(used) || !Number.isFinite(total)) return null;
  return { usedJSHeapSize: used, totalJSHeapSize: total };
}

function randomRunId(): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return `run-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export class CaptureController {
  private active: ActiveCapture | null = null;
  private lastReportValue: CaptureReport | null = null;

  get activeRunId(): string | null {
    return this.active?.runId ?? null;
  }

  get lastReport(): CaptureReport | null {
    return this.lastReportValue;
  }

  startCapture(options: CaptureStartOptions): CaptureHandle {
    if (this.active) throw new PerfCaptureError("capture_already_active");
    if (options.mode !== "counts" && options.mode !== "light" && options.mode !== "trace") {
      throw new PerfCaptureError("invalid_mode");
    }
    const visibilityCheck =
      options.visibilityCheck ??
      (() => (typeof document === "undefined" ? true : !document.hidden));
    if (!visibilityCheck()) throw new PerfCaptureError("window_not_visible");
    const previousSink = getPerfSink();
    if (previousSink !== NOOP_SINK) throw new PerfCaptureError("sink_slot_occupied");

    const budgets = resolvePerfBudgets(options.mode, options.budgets);
    const clock = options.clock ?? createRendererClock();
    const capture: ActiveCapture = {
      runId: options.runId ?? randomRunId(),
      mode: options.mode,
      budgets,
      limits: defaultPrivacyLimits(),
      clock,
      ring: new PerfRingBuffer({
        capacity: budgets.eventsCapacity,
        criticalCapacity: budgets.criticalEventsCapacity,
      }),
      counters: new Map(),
      labelPool: new Set(),
      samplingSeen: new Map(),
      criticalTests: options.criticalPhaseTests ?? DEFAULT_CRITICAL_PHASE_TESTS,
      highFrequencyPattern: options.highFrequencyPattern ?? DEFAULT_HIGH_FREQUENCY_PATTERN,
      seq: 0,
      spanSeq: 0,
      openSpanIds: new Set(),
      strandedSpans: 0,
      collectorErrors: 0,
      labelsDropped: 0,
      truncatedFields: 0,
      samplesDropped: 0,
      startedUs: clock.nowUs(),
      autoStopHandle: null,
      memoryHandle: null,
      memoryCapability: "unsupported",
      memorySamples: 0,
      observerBundle: null,
      eventTarget:
        options.eventTarget === undefined
          ? typeof window !== "undefined"
            ? window
            : null
          : options.eventTarget,
      pagehideHandler: null,
      onAutoStop: options.onAutoStop ?? null,
      timers: options.timers ?? defaultTimers(),
      closed: false,
    };

    this.active = capture;
    setPerfSink(this.createCollectorSink(capture));

    capture.autoStopHandle = capture.timers.set(() => {
      this.finishCapture("budget:capture_seconds");
    }, budgets.captureSeconds * 1000);

    const readMemory = options.readMemory ?? defaultReadMemory;
    if (budgets.memorySampleIntervalSeconds > 0 && capture.mode !== "counts") {
      const reading0 = readMemory();
      capture.memoryCapability = reading0 === null ? "unsupported" : "supported";
      if (reading0 !== null) {
        capture.memoryHandle = capture.timers.set(() => {
          if (capture.closed) return;
          if (capture.memorySamples >= budgets.maxMemorySamples) return;
          const reading = readMemory();
          if (reading === null) return;
          capture.memorySamples += 1;
          this.emit(capture, "mark", "memory.js-heap", capture.clock.nowUs(), {
            dims: { usedBytes: reading.usedJSHeapSize, totalBytes: reading.totalJSHeapSize },
          });
        }, budgets.memorySampleIntervalSeconds * 1000);
      }
    }

    if (capture.mode !== "counts") {
      capture.observerBundle = createObserverBundle(
        {
          onLongTask: (record) => {
            this.emit(capture, "sample", "main.longtask", record.startTimeUs, {
              dims: { durationMs: record.durationMs },
            });
          },
          onEventTiming: (record) => {
            this.emit(capture, "sample", "event.timing", record.startTimeUs, {
              dims: { durationMs: record.durationMs },
            });
          },
        },
        options.observerHost,
      );
    }

    capture.pagehideHandler = () => {
      this.finishCapture("renderer_unload");
    };
    capture.eventTarget?.addEventListener("pagehide", capture.pagehideHandler);

    return { runId: capture.runId, mode: capture.mode, startedUs: capture.startedUs };
  }

  stopCapture(): CaptureReport {
    if (!this.active) throw new PerfCaptureError("no_active_capture");
    return this.finishCapture("user_stop");
  }

  abortCapture(): CaptureReport {
    if (!this.active) throw new PerfCaptureError("no_active_capture");
    return this.finishCapture("renderer_unload");
  }

  private finishCapture(reason: CaptureStopReason): CaptureReport {
    const capture = this.active;
    if (!capture || capture.closed) {
      // Already finished (e.g. auto-stop raced the user stop).
      throw new PerfCaptureError("no_active_capture");
    }
    capture.closed = true;
    if (capture.autoStopHandle !== null) capture.timers.clear(capture.autoStopHandle);
    if (capture.memoryHandle !== null) capture.timers.clear(capture.memoryHandle);
    capture.observerBundle?.stopAll();
    if (capture.pagehideHandler) {
      capture.eventTarget?.removeEventListener("pagehide", capture.pagehideHandler);
    }
    capture.ring.freeze();
    setPerfSink(null);
    this.active = null;

    const openSpans = capture.openSpanIds.size;
    const ringStats = capture.ring.stats;
    const drops: PerfDropStats = {
      eventsDropped: ringStats.eventsDropped,
      criticalEndpointsDropped: ringStats.criticalEndpointsDropped,
      samplesDropped: capture.samplesDropped,
      labelsDropped: capture.labelsDropped,
      truncatedFields: capture.truncatedFields,
    };
    const reasonCodes: string[] = [];
    if (reason === "budget:capture_seconds") reasonCodes.push(reason);
    if (openSpans > 0) reasonCodes.push("spans_left_open");
    if (ringStats.eventsDropped > 0) reasonCodes.push("events_dropped");
    if (ringStats.criticalEndpointsDropped > 0) reasonCodes.push("critical_endpoints_dropped");
    if (capture.samplesDropped > 0) reasonCodes.push("samples_dropped");
    if (capture.labelsDropped > 0) reasonCodes.push("labels_dropped");
    if (capture.truncatedFields > 0) reasonCodes.push("truncated_fields");
    if (capture.strandedSpans > 0) reasonCodes.push("stranded_spans");
    if (capture.collectorErrors > 0) reasonCodes.push("collector_errors");

    const stoppedUs = capture.clock.nowUs();
    const status: CaptureStatus =
      reason === "renderer_unload" ? "aborted" : reasonCodes.length > 0 ? "incomplete" : "complete";
    const counters: Record<string, number> = {};
    for (const key of [...capture.counters.keys()].sort()) {
      counters[key] = capture.counters.get(key) as number;
    }
    const report: CaptureReport = {
      status,
      stopReason: reason,
      runId: capture.runId,
      mode: capture.mode,
      clockId: capture.clock.clockId,
      processEpoch: capture.clock.processEpoch,
      startedUs: capture.startedUs,
      stoppedUs,
      wallDurationUs: stoppedUs - capture.startedUs,
      events: capture.ring.exportSnapshot(),
      criticalEvents: capture.ring.criticalSnapshot(),
      counters,
      drops,
      observerCapabilities: {
        longTask: capture.observerBundle?.longTask.support ?? "unsupported",
        eventTiming: capture.observerBundle?.eventTiming.support ?? "unsupported",
      },
      memory: { capability: capture.memoryCapability, samples: capture.memorySamples },
      strandedSpans: capture.strandedSpans,
      openSpans,
      collectorErrors: capture.collectorErrors,
      reasonCodes,
    };
    this.lastReportValue = report;
    if (reason === "budget:capture_seconds") capture.onAutoStop?.(report);
    return report;
  }

  // -------------------------------------------------------------------
  // Collector internals
  // -------------------------------------------------------------------

  private createCollectorSink(capture: ActiveCapture): PerfSink {
    const internLabel = (phase: string): string => {
      const sanitized = sanitizeLabel(phase, capture.limits);
      if (sanitized.rejected) {
        capture.labelsDropped += 1;
        return INVALID_PHASE_LABEL;
      }
      if (sanitized.truncated) capture.truncatedFields += 1;
      const label = sanitized.label;
      if (!capture.labelPool.has(label)) {
        if (capture.labelPool.size >= capture.budgets.labelPoolCapacity) {
          capture.labelsDropped += 1;
          return LABEL_POOL_OVERFLOW;
        }
        capture.labelPool.add(label);
      }
      return label;
    };

    const isCritical = (label: string): boolean =>
      capture.criticalTests.some((test) => test(label));

    const shouldRecord = (label: string): boolean => {
      // counts mode stores nothing per-occurrence: exact counters only.
      if (capture.mode === "counts") return false;
      if (isCritical(label)) return true;
      if (!capture.highFrequencyPattern.test(label)) return true;
      const seen = (capture.samplingSeen.get(label) ?? 0) + 1;
      capture.samplingSeen.set(label, seen);
      const everyN = label.startsWith("input.")
        ? capture.budgets.inputSampleEveryN
        : capture.budgets.frameSampleEveryN;
      const keep = (seen - 1) % everyN === 0;
      if (!keep) capture.samplesDropped += 1;
      return keep;
    };

    const bump = (key: string, delta: number): void => {
      capture.counters.set(key, (capture.counters.get(key) ?? 0) + delta);
    };

    const sink: PerfSink = {
      enabled: true,
      mode: capture.mode,
      begin: (phase, ctx) => {
        const fallbackSpan: CollectorSpan = {
          id: 0,
          startedUs: 0,
          phase: INVALID_PHASE_LABEL,
          critical: false,
          record: false,
          captureRunId: capture.runId,
          ctx: { runId: capture.runId, operationId: "unattributed" },
        };
        try {
          if (capture.closed) return fallbackSpan;
          const label = internLabel(phase);
          bump(`span:${label}`, 1);
          const record = shouldRecord(label);
          const startedUs = capture.clock.nowUs();
          capture.spanSeq += 1;
          const span: CollectorSpan = {
            id: capture.spanSeq,
            startedUs,
            phase: label,
            critical: isCritical(label),
            record,
            captureRunId: capture.runId,
            ctx,
          };
          capture.openSpanIds.add(span.id);
          if (record) {
            this.emit(capture, "span_begin", label, startedUs, {
              spanId: span.id,
              ctx,
            });
          }
          return span;
        } catch {
          capture.collectorErrors += 1;
          return fallbackSpan;
        }
      },
      end: (span, outcome, dims) => {
        try {
          if (capture.closed) return;
          if (span.id === 0) return;
          const collectorSpan = span as CollectorSpan;
          if (collectorSpan.captureRunId !== capture.runId || !capture.openSpanIds.has(span.id)) {
            capture.strandedSpans += 1;
            return;
          }
          capture.openSpanIds.delete(span.id);
          bump(`span:${collectorSpan.phase}:${outcome}`, 1);
          if (!collectorSpan.record) return;
          const endUs = capture.clock.nowUs();
          this.emit(capture, "span_end", collectorSpan.phase, endUs, {
            spanId: span.id,
            outcome,
            spanDurationUs: Math.max(0, endUs - span.startedUs),
            ctx: collectorSpan.ctx,
            dims,
            forceCritical: collectorSpan.critical,
          });
        } catch {
          capture.collectorErrors += 1;
        }
      },
      mark: (phase, ctx, dims) => {
        try {
          if (capture.closed) return;
          const label = internLabel(phase);
          bump(`mark:${label}`, 1);
          if (!shouldRecord(label)) return;
          this.emit(capture, "mark", label, capture.clock.nowUs(), { ctx, dims });
        } catch {
          capture.collectorErrors += 1;
        }
      },
      count: (key, delta, _ctx) => {
        try {
          if (capture.closed) return;
          const sanitized = sanitizeLabel(key, capture.limits);
          if (sanitized.rejected) {
            capture.labelsDropped += 1;
            bump(`count:${INVALID_PHASE_LABEL}`, 1);
            return;
          }
          bump(sanitized.label, delta);
        } catch {
          capture.collectorErrors += 1;
        }
      },
    };
    // The sink closes with the capture regardless of who still holds it.
    return sink;
  }

  private emit(
    capture: ActiveCapture,
    kind: PerfEvent["kind"],
    phase: string,
    tsUs: number,
    extra: {
      spanId?: number;
      outcome?: Outcome;
      spanDurationUs?: number;
      ctx?: PerfContext;
      dims?: PerfDims;
      forceCritical?: boolean;
    } = {},
  ): void {
    const dimsResult = sanitizeDims(extra.dims, capture.limits);
    capture.truncatedFields += dimsResult.dropped;
    const hasDims = Object.keys(dimsResult.dims).length > 0;
    const ctx = extra.ctx;
    const base = {
      schemaVersion: PERFORMANCE_EVENT_SCHEMA_VERSION,
      runId: capture.runId,
      processRole: "renderer" as const,
      processEpoch: capture.clock.processEpoch,
      clockId: capture.clock.clockId,
      seq: (capture.seq += 1),
      kind,
      phase,
      tsUs,
      ...(hasDims ? { dims: dimsResult.dims } : {}),
      ...(ctx?.viewGeneration !== undefined ? { viewGeneration: ctx.viewGeneration } : {}),
      ...(ctx?.revision !== undefined ? { revision: ctx.revision } : {}),
      ...(ctx?.frameSeq !== undefined ? { frameSeq: ctx.frameSeq } : {}),
      ...(ctx?.frameEpoch !== undefined ? { frameEpoch: ctx.frameEpoch } : {}),
    };
    let event: PerfEvent;
    if (kind === "span_begin") {
      event = {
        ...base,
        kind: "span_begin",
        spanId: extra.spanId as number,
        ...(ctx?.parentSpanId !== undefined ? { parentSpanId: ctx.parentSpanId } : {}),
        operationId: ctx?.operationId ?? "unattributed",
      };
    } else if (kind === "span_end") {
      event = {
        ...base,
        kind: "span_end",
        spanId: extra.spanId as number,
        operationId: ctx?.operationId ?? "unattributed",
        outcome: extra.outcome as Outcome,
        spanDurationUs: extra.spanDurationUs as number,
      };
    } else {
      // mark/sample (the collector's non-span kinds); the conditional dims
      // spread cannot be proven for every union member, hence the cast.
      event = {
        ...base,
        kind,
        ...(ctx?.operationId !== undefined ? { operationId: ctx.operationId } : {}),
      } as PerfEvent;
    }
    const critical = extra.forceCritical ?? this.phaseIsCritical(capture, phase);
    capture.ring.append(event, { critical });
  }

  private phaseIsCritical(capture: ActiveCapture, phase: string): boolean {
    return capture.criticalTests.some((test) => test(phase));
  }
}

/** Single controller per renderer realm (one capture at a time). */
export const rendererCaptureController = new CaptureController();
