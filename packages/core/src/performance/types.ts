/**
 * Performance measurement contracts (design phase P0).
 *
 * This module is the single source of truth for the measurement vocabulary
 * shared by every process role (renderer, main, decode workers, runtime
 * pages, sidecar). It must stay dependency-free: no React, no Zustand, no
 * Electron, no Node built-ins — only types and pure functions — so it can be
 * imported from any bundle, worker or script without pulling a runtime.
 *
 * Semantic rules encoded here (see docs/performance/README.md):
 * - All timestamps are microseconds on a local monotonic clock identified by
 *   `clockId`. They are never wall-clock time and never compared across
 *   clocks without a validated sync estimate.
 * - `dims` values are numbers or booleans only. Strings, nested objects and
 *   error messages are contract violations, not sanitized inputs.
 * - A missing capability is reported as a status ("unsupported",
 *   "unavailable"), never as a zero measurement.
 */

// ---------------------------------------------------------------------------
// Schema identity
// ---------------------------------------------------------------------------

export const PERFORMANCE_EVENT_SCHEMA_VERSION = 1;
export const PERFORMANCE_RESULT_SCHEMA = "reelterminal.performance-result/v1";
export const METRIC_DEFINITION_VERSION = 1;
/** Quantile algorithm pinned by the metric definition; see nearestRankPercentile. */
export const QUANTILE_METHOD = "nearest_rank";

// ---------------------------------------------------------------------------
// Core vocabulary
// ---------------------------------------------------------------------------

/** Capture modes. "off" is the default and must do no work at all. */
export type CaptureMode = "off" | "counts" | "light" | "trace";

/** Which process a measurement originates from. */
export type ProcessRole = "renderer" | "main" | "decode-worker" | "runtime-page" | "sidecar";

/** How a measured operation ended. */
export type Outcome = "ok" | "error" | "cancelled" | "superseded" | "timeout";

/**
 * Privacy-safe error categories. Derived from error names/codes only — the
 * error message is never part of any performance output.
 */
export type PerfErrorKind =
  | "unknown"
  | "abort"
  | "timeout"
  | "quota"
  | "decode"
  | "unsupported"
  | "invalid-state"
  | "network"
  | "storage";

const CAPTURE_MODES: readonly CaptureMode[] = ["off", "counts", "light", "trace"];
const PROCESS_ROLES: readonly ProcessRole[] = [
  "renderer",
  "main",
  "decode-worker",
  "runtime-page",
  "sidecar",
];
const OUTCOMES: readonly Outcome[] = ["ok", "error", "cancelled", "superseded", "timeout"];
const ERROR_KINDS: readonly PerfErrorKind[] = [
  "unknown",
  "abort",
  "timeout",
  "quota",
  "decode",
  "unsupported",
  "invalid-state",
  "network",
  "storage",
];

export function isCaptureMode(value: unknown): value is CaptureMode {
  return typeof value === "string" && (CAPTURE_MODES as readonly string[]).includes(value);
}

export function isProcessRole(value: unknown): value is ProcessRole {
  return typeof value === "string" && (PROCESS_ROLES as readonly string[]).includes(value);
}

export function isOutcome(value: unknown): value is Outcome {
  return typeof value === "string" && (OUTCOMES as readonly string[]).includes(value);
}

export function isPerfErrorKind(value: unknown): value is PerfErrorKind {
  return typeof value === "string" && (ERROR_KINDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

/** Numeric/boolean measurement dimensions. Units live in the metric definition. */
export type PerfDimValue = number | boolean;
export type PerfDims = Readonly<Record<string, PerfDimValue>>;

// ---------------------------------------------------------------------------
// Clock, context, span, sink
// ---------------------------------------------------------------------------

/**
 * A local monotonic clock. `nowUs()` is microseconds since an arbitrary
 * fixed origin owned by `clockId`; two different clockIds are not comparable.
 */
export interface PerfClock {
  readonly clockId: string;
  nowUs(): number;
}

/** Correlation identity for one measurement. */
export interface PerfContext {
  /** Benchmark/diagnostic run identity. Not a durable user id. */
  readonly runId: string;
  /** One gesture / node-open / save / export instance. */
  readonly operationId: string;
  readonly parentSpanId?: number;
  readonly viewGeneration?: number;
  readonly revision?: number;
  readonly frameSeq?: number;
  readonly frameEpoch?: number;
}

/** Handle returned by PerfSink.begin; only meaningful with the same sink. */
export interface PerfSpan {
  readonly id: number;
  readonly startedUs: number;
}

/**
 * Measurement sink. Implementations must never throw, never perform async I/O
 * and never mutate application state — a collector failure must not change
 * business behavior. When `enabled` is false the implementation must do no
 * work (no clock reads, no label construction, no observers).
 */
export interface PerfSink {
  readonly enabled: boolean;
  readonly mode: CaptureMode;
  begin(phase: string, ctx: PerfContext): PerfSpan;
  end(span: PerfSpan, outcome: Outcome, dims?: PerfDims): void;
  mark(phase: string, ctx: PerfContext, dims?: PerfDims): void;
  count(key: string, delta: number, ctx?: PerfContext): void;
}

// ---------------------------------------------------------------------------
// Wire events
// ---------------------------------------------------------------------------

export type PerfEventKind =
  | "span_begin"
  | "span_end"
  | "mark"
  | "counter"
  | "sample"
  | "error"
  | "flow_link";

export interface PerfEventBase {
  readonly schemaVersion: number;
  readonly runId: string;
  readonly processRole: ProcessRole;
  readonly processEpoch: string;
  readonly clockId: string;
  /** Monotonic per-capture sequence; ordering within one clock only. */
  readonly seq: number;
  readonly kind: PerfEventKind;
  readonly phase: string;
  readonly tsUs: number;
}

export interface PerfSpanBeginEvent extends PerfEventBase {
  readonly kind: "span_begin";
  readonly spanId: number;
  readonly parentSpanId?: number;
  readonly operationId: string;
  readonly viewGeneration?: number;
  readonly revision?: number;
  readonly frameSeq?: number;
  readonly frameEpoch?: number;
  readonly dims?: PerfDims;
}

export interface PerfSpanEndEvent extends PerfEventBase {
  readonly kind: "span_end";
  readonly spanId: number;
  readonly operationId: string;
  readonly outcome: Outcome;
  /** Computed with the same clock as the paired span_begin. */
  readonly spanDurationUs: number;
  readonly dims?: PerfDims;
}

export interface PerfMarkEvent extends PerfEventBase {
  readonly kind: "mark";
  readonly operationId?: string;
  readonly viewGeneration?: number;
  readonly revision?: number;
  readonly frameSeq?: number;
  readonly frameEpoch?: number;
  readonly dims?: PerfDims;
}

export interface PerfCounterEvent extends PerfEventBase {
  readonly kind: "counter";
  readonly dims: Readonly<{ delta: number }>;
}

export interface PerfSampleEvent extends PerfEventBase {
  readonly kind: "sample";
  readonly dims?: PerfDims;
}

export interface PerfErrorEvent extends PerfEventBase {
  readonly kind: "error";
  readonly errorKind: PerfErrorKind;
  readonly operationId?: string;
}

export interface PerfFlowLinkEvent extends PerfEventBase {
  readonly kind: "flow_link";
  /** Advisory correlation id; never changes CAS/idempotency semantics. */
  readonly requestId: string;
  readonly direction: "out" | "in";
  readonly dims?: PerfDims;
}

export type PerfEvent =
  | PerfSpanBeginEvent
  | PerfSpanEndEvent
  | PerfMarkEvent
  | PerfCounterEvent
  | PerfSampleEvent
  | PerfErrorEvent
  | PerfFlowLinkEvent;

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

export interface PerfBudgets {
  readonly captureSeconds: number;
  readonly eventsCapacity: number;
  readonly criticalEventsCapacity: number;
  readonly labelPoolCapacity: number;
  readonly maxLabelLength: number;
  readonly maxDimKeyLength: number;
  readonly maxDimsPerEvent: number;
  readonly inputSampleEveryN: number;
  readonly frameSampleEveryN: number;
  /** 0 disables memory sampling. */
  readonly memorySampleIntervalSeconds: number;
  readonly maxMemorySamples: number;
}

export const MAX_TRACE_CAPTURE_SECONDS = 30;

export const DEFAULT_PERF_BUDGETS: Readonly<PerfBudgets> = Object.freeze({
  captureSeconds: 30,
  eventsCapacity: 16384,
  criticalEventsCapacity: 256,
  labelPoolCapacity: 256,
  maxLabelLength: 128,
  maxDimKeyLength: 64,
  maxDimsPerEvent: 16,
  inputSampleEveryN: 10,
  frameSampleEveryN: 10,
  memorySampleIntervalSeconds: 15,
  maxMemorySamples: 64,
});

type MutablePerfBudgets = { -readonly [K in keyof PerfBudgets]: number };

/**
 * Mode-aware budget resolution. "trace" is a short capture with a hard cap;
 * "counts" keeps exact counters only, so memory sampling and high-frequency
 * event sampling are meaningless and disabled.
 */

export function resolvePerfBudgets(
  mode: CaptureMode,
  overrides?: Partial<PerfBudgets>,
): PerfBudgets {
  const defaults: MutablePerfBudgets = { ...DEFAULT_PERF_BUDGETS };
  if (mode === "trace") defaults.captureSeconds = Math.min(defaults.captureSeconds, 10);
  if (mode === "counts") defaults.memorySampleIntervalSeconds = 0;
  const o = overrides ?? {};
  const pick = (key: keyof PerfBudgets, allowZero: boolean): number => {
    const value = o[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return allowZero || value > 0 ? value : defaults[key];
    }
    return defaults[key];
  };
  const merged: MutablePerfBudgets = {
    captureSeconds: Math.floor(pick("captureSeconds", false)),
    eventsCapacity: Math.floor(pick("eventsCapacity", false)),
    criticalEventsCapacity: Math.floor(pick("criticalEventsCapacity", false)),
    labelPoolCapacity: Math.floor(pick("labelPoolCapacity", false)),
    maxLabelLength: Math.floor(pick("maxLabelLength", false)),
    maxDimKeyLength: Math.floor(pick("maxDimKeyLength", false)),
    maxDimsPerEvent: Math.floor(pick("maxDimsPerEvent", false)),
    inputSampleEveryN: Math.floor(pick("inputSampleEveryN", false)),
    frameSampleEveryN: Math.floor(pick("frameSampleEveryN", false)),
    memorySampleIntervalSeconds: pick("memorySampleIntervalSeconds", true),
    maxMemorySamples: Math.floor(pick("maxMemorySamples", false)),
  };
  if (mode === "trace") {
    merged.captureSeconds = Math.min(merged.captureSeconds, MAX_TRACE_CAPTURE_SECONDS);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Capture outcome bookkeeping
// ---------------------------------------------------------------------------

export type CaptureStatus = "complete" | "incomplete" | "aborted";

export interface PerfDropStats {
  /** Structured events lost because the bounded ring overwrote them. */
  readonly eventsDropped: number;
  /** Semantic-endpoint events lost; such a result must not claim speed wins. */
  readonly criticalEndpointsDropped: number;
  /** Events intentionally skipped by the deterministic sampling rule. */
  readonly samplesDropped: number;
  /** Labels rejected by the privacy/pattern rules or a full label pool. */
  readonly labelsDropped: number;
  /** Fields truncated or removed during sanitization. */
  readonly truncatedFields: number;
}

export const EMPTY_PERF_DROP_STATS: Readonly<PerfDropStats> = Object.freeze({
  eventsDropped: 0,
  criticalEndpointsDropped: 0,
  samplesDropped: 0,
  labelsDropped: 0,
  truncatedFields: 0,
});

// ---------------------------------------------------------------------------
// Error classification (privacy-safe)
// ---------------------------------------------------------------------------

/**
 * Map an unknown error to a category using only its name/code. The message,
 * stack and properties are never read, so secrets inside them cannot leak
 * into performance output.
 */
export function classifyPerfError(error: unknown): PerfErrorKind {
  if (error === null || error === undefined) return "unknown";
  if (typeof error !== "object" && typeof error !== "function") return "unknown";
  const name = typeof (error as { name?: unknown }).name === "string"
    ? (error as { name: string }).name
    : "";
  const code = typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : typeof (error as { code?: unknown }).code === "number"
      ? String((error as { code: number }).code)
      : "";
  if (name === "AbortError" || code === "ABORT_ERR") return "abort";
  if (
    name === "TimeoutError" ||
    code === "TIMEOUT" ||
    code === "ETIMEDOUT" ||
    name.endsWith("TimeoutError")
  ) {
    return "timeout";
  }
  if (name === "QuotaExceededError" || code === "QuotaExceeded") return "quota";
  if (name === "DecodingError" || name === "DecodeError" || name === "EncodingError") {
    return "decode";
  }
  if (name === "NotSupportedError") return "unsupported";
  if (name === "InvalidStateError" || name === "DataError") return "invalid-state";
  if (name === "NetworkError" || code === "ECONNRESET" || code === "ECONNREFUSED") {
    return "network";
  }
  if (code === "ENOENT" || code === "EACCES" || code === "EROFS" || code === "EIO") {
    return "storage";
  }
  return "unknown";
}

/**
 * Coarse span outcome for a failed operation: aborts count as cancellations,
 * timeouts keep their outcome, everything else is a plain error. The fine
 * PerfErrorKind detail is carried separately by error events, not by spans.
 */
export function errorKindToOutcome(kind: PerfErrorKind): Outcome {
  if (kind === "abort") return "cancelled";
  if (kind === "timeout") return "timeout";
  return "error";
}

// ---------------------------------------------------------------------------
// Quantiles
// ---------------------------------------------------------------------------

/**
 * Nearest-rank percentile over ascending-sorted values: index ceil(p*n)-1,
 * clamped into bounds for indexing only. Returns null for empty input.
 * Pinned by METRIC_DEFINITION_VERSION — changing the algorithm invalidates
 * baselines.
 */
export function nearestRankPercentile(
  sortedAscending: readonly number[],
  p: number,
): number | null {
  if (sortedAscending.length === 0) return null;
  const clamped = Math.min(1, Math.max(0, p));
  const index = Math.min(
    sortedAscending.length - 1,
    Math.max(0, Math.ceil(clamped * sortedAscending.length) - 1),
  );
  return sortedAscending[index];
}

export interface DurationSummary {
  readonly n: number;
  readonly max: number | null;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly quantileMethod: typeof QUANTILE_METHOD;
}

export interface DurationSummaryThresholds {
  readonly minSamplesForP50: number;
  readonly minSamplesForP95: number;
  readonly minSamplesForP99: number;
}

/**
 * Defaults per the baseline policy: quick PR runs (25 samples) get p50/p95
 * but p99 is null ("insufficient_samples" when reported); warm distribution
 * runs reach the 100 completed samples p99 requires.
 */
export const DEFAULT_DURATION_THRESHOLDS: Readonly<DurationSummaryThresholds> = Object.freeze({
  minSamplesForP50: 1,
  minSamplesForP95: 20,
  minSamplesForP99: 100,
});

/** Summarize completed-operation durations. Non-finite values are excluded. */
export function summarizeDurations(
  values: readonly number[],
  thresholds?: Partial<DurationSummaryThresholds>,
): DurationSummary {
  const t: DurationSummaryThresholds = { ...DEFAULT_DURATION_THRESHOLDS, ...thresholds };
  const finite = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const q = (p: number, min: number): number | null =>
    finite.length >= min ? nearestRankPercentile(finite, p) : null;
  return {
    n: finite.length,
    max: finite.length > 0 ? finite[finite.length - 1] : null,
    p50: q(0.5, t.minSamplesForP50),
    p95: q(0.95, t.minSamplesForP95),
    p99: q(0.99, t.minSamplesForP99),
    quantileMethod: QUANTILE_METHOD,
  };
}

// ---------------------------------------------------------------------------
// Wire validation
// ---------------------------------------------------------------------------

export interface SchemaValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

const EVENT_KINDS: readonly PerfEventKind[] = [
  "span_begin",
  "span_end",
  "mark",
  "counter",
  "sample",
  "error",
  "flow_link",
];

function isPerfDims(value: unknown, maxDims: number, errors: string[], where: string): boolean {
  if (value === undefined) return true;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${where}: dims must be an object`);
    return false;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > maxDims) {
    errors.push(`${where}: dims exceed ${maxDims} entries`);
    return false;
  }
  let ok = true;
  for (const [key, dim] of entries) {
    if (typeof dim === "number" && !Number.isFinite(dim)) {
      errors.push(`${where}: dims.${key} is not finite`);
      ok = false;
    } else if (typeof dim !== "number" && typeof dim !== "boolean") {
      errors.push(`${where}: dims.${key} must be number|boolean`);
      ok = false;
    }
  }
  return ok;
}

function validateCommonFields(
  value: Record<string, unknown>,
  maxLabelLength: number,
  maxDims: number,
  errors: string[],
): void {
  if (value.schemaVersion !== PERFORMANCE_EVENT_SCHEMA_VERSION) {
    errors.push("schemaVersion mismatch");
  }
  if (typeof value.runId !== "string" || value.runId.length === 0) {
    errors.push("runId must be a non-empty string");
  }
  if (!isProcessRole(value.processRole)) errors.push("processRole invalid");
  if (typeof value.processEpoch !== "string" || value.processEpoch.length === 0) {
    errors.push("processEpoch must be a non-empty string");
  }
  if (typeof value.clockId !== "string" || value.clockId.length === 0) {
    errors.push("clockId must be a non-empty string");
  }
  if (typeof value.seq !== "number" || !Number.isInteger(value.seq) || value.seq < 0) {
    errors.push("seq must be a non-negative integer");
  }
  if (typeof value.tsUs !== "number" || !Number.isFinite(value.tsUs)) {
    errors.push("tsUs must be a finite number");
  }
  if (typeof value.phase !== "string" || value.phase.length === 0) {
    errors.push("phase must be a non-empty string");
  } else if (value.phase.length > maxLabelLength) {
    errors.push(`phase exceeds max label length ${maxLabelLength}`);
  }
  isPerfDims(value.dims, maxDims, errors, "dims");
}

function isPerfEventValue(value: unknown, errors: string[]): boolean {
  if (value === null || typeof value !== "object") {
    errors.push("event must be an object");
    return false;
  }
  return true;
}

/**
 * Structural validation for a single wire event. This is the machine-checked
 * version of the event contract: common fields, kind-specific fields, label
 * length cap and the numeric/boolean-only dims rule.
 */
export function validatePerformanceEvent(event: unknown): SchemaValidationResult {
  const errors: string[] = [];
  if (!isPerfEventValue(event, errors)) return { valid: false, errors };
  const value = event as Record<string, unknown>;
  const maxLabelLength = DEFAULT_PERF_BUDGETS.maxLabelLength;
  const maxDims = DEFAULT_PERF_BUDGETS.maxDimsPerEvent;
  validateCommonFields(value, maxLabelLength, maxDims, errors);
  const kind = value.kind;
  if (typeof kind !== "string" || !(EVENT_KINDS as readonly string[]).includes(kind)) {
    errors.push("kind invalid");
    return { valid: false, errors };
  }
  switch (kind as PerfEventKind) {
    case "span_begin":
      if (typeof value.spanId !== "number" || !Number.isInteger(value.spanId)) {
        errors.push("span_begin: spanId must be an integer");
      }
      if (typeof value.operationId !== "string" || value.operationId.length === 0) {
        errors.push("span_begin: operationId required");
      }
      break;
    case "span_end":
      if (typeof value.spanId !== "number" || !Number.isInteger(value.spanId)) {
        errors.push("span_end: spanId must be an integer");
      }
      if (!isOutcome(value.outcome)) errors.push("span_end: outcome invalid");
      if (
        typeof value.spanDurationUs !== "number" ||
        !Number.isFinite(value.spanDurationUs) ||
        value.spanDurationUs < 0
      ) {
        errors.push("span_end: spanDurationUs must be >= 0 (never clamp negative)");
      }
      break;
    case "counter":
      if (
        value.dims === null ||
        typeof value.dims !== "object" ||
        typeof (value.dims as { delta?: unknown })?.delta !== "number" ||
        !Number.isFinite((value.dims as { delta: number }).delta)
      ) {
        errors.push("counter: dims.delta must be a finite number");
      }
      break;
    case "error":
      if (!isPerfErrorKind(value.errorKind)) errors.push("error: errorKind invalid");
      break;
    case "flow_link":
      if (typeof value.requestId !== "string" || value.requestId.length === 0) {
        errors.push("flow_link: requestId required");
      }
      if (value.direction !== "out" && value.direction !== "in") {
        errors.push("flow_link: direction must be out|in");
      }
      break;
    case "mark":
    case "sample":
      break;
  }
  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Result document schema
// ---------------------------------------------------------------------------

export type MetricStatus =
  | "ok"
  | "not_run"
  | "unsupported"
  | "not_applicable"
  | "insufficient_samples"
  | "indeterminate"
  | "failed";

const METRIC_STATUSES: readonly MetricStatus[] = [
  "ok",
  "not_run",
  "unsupported",
  "not_applicable",
  "insufficient_samples",
  "indeterminate",
  "failed",
];

const RESULT_STATUSES: readonly string[] = [
  "not_run",
  "complete",
  "incomplete",
  "aborted",
  "invalid",
];

export interface PerformanceMetricBase {
  readonly status: MetricStatus;
}

export interface PerformanceDistributionMetric extends PerformanceMetricBase {
  readonly n_requested?: number;
  readonly n_completed?: number;
  readonly n_censored?: number;
  readonly n_failed?: number;
  readonly p50?: number | null;
  readonly p95?: number | null;
  readonly p99?: number | null;
  readonly max?: number | null;
  readonly quantile_method?: string;
}

export interface PerformanceScalarMetric extends PerformanceMetricBase {
  readonly value?: number | boolean | null;
}

export type PerformanceMetric = PerformanceDistributionMetric | PerformanceScalarMetric;

/** Loose structural mirror of the v1 result document (see docs/performance). */
export interface PerformanceResultDocument {
  readonly schema: typeof PERFORMANCE_RESULT_SCHEMA;
  readonly status: string;
  readonly run: Record<string, unknown>;
  readonly build: Record<string, unknown>;
  readonly environment: Record<string, unknown>;
  readonly clock: Record<string, unknown>;
  readonly validity: {
    readonly complete: boolean;
    readonly reason_codes: readonly string[];
    readonly events_dropped: number;
    readonly critical_endpoints_dropped: number;
    readonly probe_calibrated: boolean;
  };
  readonly metrics: Readonly<Record<string, PerformanceMetric>>;
  readonly structural: Readonly<Record<string, number | null>>;
  readonly correctness: Readonly<Record<string, boolean | null>>;
  readonly comparison: {
    readonly status: string;
    readonly baseline_id: string | null;
    readonly regressions: readonly unknown[];
  };
  readonly artifacts: readonly unknown[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeNumber(value: unknown, errors: string[], where: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    errors.push(`${where} must be a finite number >= 0`);
  }
}

function validateMetric(value: unknown, name: string, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push(`metrics.${name} must be an object`);
    return;
  }
  if (
    typeof value.status !== "string" ||
    !(METRIC_STATUSES as readonly string[]).includes(value.status)
  ) {
    errors.push(`metrics.${name}.status invalid`);
    return;
  }
  for (const key of ["n_requested", "n_completed", "n_censored", "n_failed", "p50", "p95", "p99", "max"] as const) {
    const v = value[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      errors.push(`metrics.${name}.${key} must be a finite number or null`);
    } else if (key.startsWith("n_") && v < 0) {
      errors.push(`metrics.${name}.${key} must be >= 0`);
    }
  }
  if (value.quantile_method !== undefined && typeof value.quantile_method !== "string") {
    errors.push(`metrics.${name}.quantile_method must be a string`);
  }
}

/**
 * Structural validation for a v1 performance result document. Unknown extra
 * fields are allowed (forwards compatibility), required sections and their
 * types are not.
 */
export function validatePerformanceResult(doc: unknown): SchemaValidationResult {
  const errors: string[] = [];
  if (!isPlainObject(doc)) {
    return { valid: false, errors: ["result must be an object"] };
  }
  if (doc.schema !== PERFORMANCE_RESULT_SCHEMA) {
    errors.push(`schema must be ${PERFORMANCE_RESULT_SCHEMA}`);
  }
  if (typeof doc.status !== "string" || !RESULT_STATUSES.includes(doc.status)) {
    errors.push("status invalid");
  }
  for (const section of ["run", "build", "environment"] as const) {
    if (!isPlainObject(doc[section])) errors.push(`${section} must be an object`);
  }
  if (isPlainObject(doc.run)) {
    if (typeof doc.run.run_id !== "string" || doc.run.run_id.length === 0) {
      errors.push("run.run_id required");
    }
    if (typeof doc.run.scenario_id !== "string" || doc.run.scenario_id.length === 0) {
      errors.push("run.scenario_id required");
    }
    if (!isCaptureMode(doc.run.mode) || doc.run.mode === "off") {
      errors.push("run.mode must be counts|light|trace");
    }
  }
  if (isPlainObject(doc.build) && typeof doc.build.build_verified !== "boolean") {
    errors.push("build.build_verified must be a boolean");
  }
  if (isPlainObject(doc.clock)) {
    if (doc.clock.sync_valid !== null && typeof doc.clock.sync_valid !== "boolean") {
      errors.push("clock.sync_valid must be boolean|null");
    }
    if (doc.clock.uncertainty_us !== null && doc.clock.uncertainty_us !== undefined) {
      nonNegativeNumber(doc.clock.uncertainty_us, errors, "clock.uncertainty_us");
    }
  }
  if (!isPlainObject(doc.validity)) {
    errors.push("validity must be an object");
  } else {
    if (typeof doc.validity.complete !== "boolean") {
      errors.push("validity.complete must be a boolean");
    }
    if (
      !Array.isArray(doc.validity.reason_codes) ||
      doc.validity.reason_codes.some((c) => typeof c !== "string")
    ) {
      errors.push("validity.reason_codes must be string[]");
    }
    nonNegativeNumber(doc.validity.events_dropped, errors, "validity.events_dropped");
    nonNegativeNumber(
      doc.validity.critical_endpoints_dropped,
      errors,
      "validity.critical_endpoints_dropped",
    );
    if (typeof doc.validity.probe_calibrated !== "boolean") {
      errors.push("validity.probe_calibrated must be a boolean");
    }
  }
  if (!isPlainObject(doc.metrics)) {
    errors.push("metrics must be an object");
  } else {
    for (const [name, metric] of Object.entries(doc.metrics)) {
      validateMetric(metric, name, errors);
    }
  }
  if (!isPlainObject(doc.structural)) {
    errors.push("structural must be an object");
  } else {
    for (const [name, v] of Object.entries(doc.structural)) {
      if (v === null) continue;
      if (typeof v !== "number" || !Number.isFinite(v)) {
        errors.push(`structural.${name} must be a finite number or null`);
      }
    }
  }
  if (!isPlainObject(doc.correctness)) {
    errors.push("correctness must be an object");
  } else {
    for (const [name, v] of Object.entries(doc.correctness)) {
      if (v === null) continue;
      if (typeof v !== "boolean") errors.push(`correctness.${name} must be boolean|null`);
    }
  }
  if (!isPlainObject(doc.comparison)) {
    errors.push("comparison must be an object");
  } else {
    if (typeof doc.comparison.status !== "string") {
      errors.push("comparison.status must be a string");
    }
    if (doc.comparison.baseline_id !== null && typeof doc.comparison.baseline_id !== "string") {
      errors.push("comparison.baseline_id must be string|null");
    }
    if (!Array.isArray(doc.comparison.regressions)) {
      errors.push("comparison.regressions must be an array");
    }
  }
  if (!Array.isArray(doc.artifacts)) errors.push("artifacts must be an array");
  return { valid: errors.length === 0, errors };
}
