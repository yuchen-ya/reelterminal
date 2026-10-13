import {
  DEFAULT_DURATION_THRESHOLDS,
  METRIC_DEFINITION_VERSION,
  PERFORMANCE_RESULT_SCHEMA,
  QUANTILE_METHOD,
  nearestRankPercentile,
} from "@reelterminal/core/performance/types";
import {
  performanceAggregationIdentityDifferences,
  validateResultDocument,
} from "../../../../../scripts/performance/result-contract.mjs";

export type PerformanceOperationOutcome =
  | "ok"
  | "failed"
  | "timeout"
  | "cancelled"
  | "superseded";

/** One requested operation. Durations are milliseconds and local to its action window. */
export interface RawPerformanceOperation {
  readonly operation_id: string;
  readonly metric: string;
  readonly outcome: PerformanceOperationOutcome;
  readonly duration_ms: number | null;
  readonly waited_ms?: number;
  /** True only after the scenario's requested target/state/frame was verified. */
  readonly target_verified: boolean;
}

export interface OperationDistribution {
  readonly status: "ok" | "failed" | "insufficient_samples";
  readonly n_requested: number;
  readonly n_completed: number;
  readonly n_censored: number;
  readonly n_failed: number;
  readonly median_ms: number | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly raw_ms: readonly number[];
  readonly quantile_method: typeof QUANTILE_METHOD;
}

export interface ResultValidity {
  readonly complete: boolean;
  readonly reason_codes: readonly string[];
  readonly events_dropped: number;
  readonly critical_endpoints_dropped: number;
  readonly probe_calibrated: boolean;
}

export interface CreatePerformanceResultOptions<TRun extends Record<string, unknown> = Record<string, unknown>> {
  readonly run: TRun;
  readonly build: Record<string, unknown>;
  readonly environment: Record<string, unknown>;
  readonly samples: readonly RawPerformanceOperation[];
  readonly correctness?: Readonly<Record<string, boolean | null>>;
  readonly structural?: Readonly<Record<string, number | null>>;
  readonly validity?: Partial<ResultValidity>;
  readonly artifacts?: readonly unknown[];
  readonly forceInvalid?: boolean;
}

const CENSORED_OUTCOMES = new Set<PerformanceOperationOutcome>([
  "timeout",
  "cancelled",
  "superseded",
]);

export const PERFORMANCE_COLLECTOR_VERSION = "p1-v1";

function assertOperation(operation: RawPerformanceOperation, index: number): void {
  if (typeof operation.operation_id !== "string" || operation.operation_id.length === 0) {
    throw new TypeError(`samples[${index}].operation_id must be a non-empty string`);
  }
  if (typeof operation.metric !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(operation.metric)) {
    throw new TypeError(`samples[${index}].metric must be a valid metric identity`);
  }
  if (!["ok", "failed", "timeout", "cancelled", "superseded"].includes(operation.outcome)) {
    throw new TypeError(`samples[${index}].outcome is invalid`);
  }
  if (
    operation.duration_ms !== null &&
    (typeof operation.duration_ms !== "number" || !Number.isFinite(operation.duration_ms) || operation.duration_ms < 0)
  ) {
    throw new TypeError(`samples[${index}].duration_ms must be null or a finite number >= 0`);
  }
  if (typeof operation.target_verified !== "boolean") {
    throw new TypeError(`samples[${index}].target_verified must be a boolean`);
  }
  if (
    operation.waited_ms !== undefined &&
    (!Number.isFinite(operation.waited_ms) || operation.waited_ms < 0)
  ) {
    throw new TypeError(`samples[${index}].waited_ms must be a finite number >= 0`);
  }
}

function usableDuration(operation: RawPerformanceOperation): number | null {
  if (operation.outcome !== "ok" || !operation.target_verified) return null;
  if (operation.duration_ms === null || !Number.isFinite(operation.duration_ms) || operation.duration_ms < 0) {
    return null;
  }
  return operation.duration_ms;
}

function summarizeGroup(
  operations: readonly RawPerformanceOperation[],
  cacheState: string,
  allowTails: boolean,
): OperationDistribution {
  const durations = operations
    .map(usableDuration)
    .filter((duration): duration is number => duration !== null)
    .sort((a, b) => a - b);
  const nCensored = operations.filter((operation) => CENSORED_OUTCOMES.has(operation.outcome)).length;
  const nFailed = operations.length - durations.length - nCensored;
  const hasBadOutcome = nCensored > 0 || nFailed > 0;
  const isCold = /cold/i.test(cacheState);

  // A censored, failed, unverified, or incomplete sample set has no passing tail.
  const canReport = allowTails && !hasBadOutcome;
  const p50 = canReport && durations.length >= DEFAULT_DURATION_THRESHOLDS.minSamplesForP50
    ? nearestRankPercentile(durations, 0.5)
    : null;
  const p95 = canReport && !isCold && durations.length >= DEFAULT_DURATION_THRESHOLDS.minSamplesForP95
    ? nearestRankPercentile(durations, 0.95)
    : null;
  const p99 = canReport && !isCold && durations.length >= DEFAULT_DURATION_THRESHOLDS.minSamplesForP99
    ? nearestRankPercentile(durations, 0.99)
    : null;
  const hasInsufficientWarmTail = canReport && !isCold && (p95 === null || p99 === null);

  return {
    status: hasBadOutcome || !allowTails
      ? "failed"
      : durations.length === 0 || hasInsufficientWarmTail
        ? "insufficient_samples"
        : "ok",
    n_requested: operations.length,
    n_completed: durations.length,
    n_censored: nCensored,
    n_failed: nFailed,
    median_ms: p50,
    min: canReport && durations.length > 0 ? durations[0] : null,
    max: canReport && durations.length > 0 ? durations[durations.length - 1] : null,
    p50,
    p95,
    p99,
    raw_ms: durations,
    quantile_method: QUANTILE_METHOD,
  };
}

/** Summarize all requested operations grouped by their declared metric identity. */
export function summarizeOperations(
  samples: readonly RawPerformanceOperation[],
  cacheState: string,
  allowTails = true,
): Readonly<Record<string, OperationDistribution>> {
  if (typeof cacheState !== "string" || cacheState.length === 0) {
    throw new TypeError("cacheState must be a non-empty string");
  }
  if (/cold/i.test(cacheState) === /warm/i.test(cacheState)) {
    throw new TypeError("cacheState must identify exactly one of cold or warm");
  }
  samples.forEach(assertOperation);
  const groups = new Map<string, RawPerformanceOperation[]>();
  for (const sample of samples) {
    const group = groups.get(sample.metric) ?? [];
    group.push(sample);
    groups.set(sample.metric, group);
  }
  return Object.fromEntries(
    [...groups].sort(([left], [right]) => left.localeCompare(right)).map(([metric, operations]) => [
      metric,
      summarizeGroup(operations, cacheState, allowTails),
    ]),
  );
}

/** Build a v1 result while keeping raw operations alongside their summaries. */
export function createPerformanceResult<TRun extends Record<string, unknown>>(
  options: CreatePerformanceResultOptions<TRun>,
) {
  const { run, build, environment, samples } = options;
  const validity: ResultValidity = {
    complete: options.validity?.complete ?? true,
    reason_codes: options.validity?.reason_codes ?? [],
    events_dropped: options.validity?.events_dropped ?? 0,
    critical_endpoints_dropped: options.validity?.critical_endpoints_dropped ?? 0,
    probe_calibrated: options.validity?.probe_calibrated ?? false,
  };
  const correctness = options.correctness ?? {};
  const hasDrops = validity.events_dropped > 0 || validity.critical_endpoints_dropped > 0;
  const allTargetsVerified = samples.every(
    (sample) => sample.outcome !== "ok" || sample.target_verified,
  );
  const hasFailedOperations = samples.some(
    (sample) => sample.outcome === "failed" || (sample.outcome === "ok" && usableDuration(sample) === null),
  ) || !allTargetsVerified;
  const hasCensoredOperations = samples.some((sample) => CENSORED_OUTCOMES.has(sample.outcome));
  const hasCorrectnessFailure =
    correctness.target_frame_verified === false ||
    correctness.final_state_verified === false ||
    correctness.durable_final_revision_verified === false ||
    correctness.cancel_restored_editing_context === false ||
    correctness.stale_frame_commits === true;
  const hasUnverifiedBuild = build.build_verified !== true;
  const hasForcedInvalid = options.forceInvalid === true;
  const complete = validity.complete && !hasDrops && !hasCensoredOperations && !hasFailedOperations &&
    !hasCorrectnessFailure && !hasUnverifiedBuild && !hasForcedInvalid;
  const validForTails = complete && (options.validity?.complete ?? true);
  const cacheState = typeof run.cache_state === "string" ? run.cache_state : "unknown";
  const metrics = summarizeOperations(samples, cacheState, validForTails);
  const status = hasFailedOperations || hasCorrectnessFailure || hasUnverifiedBuild || hasForcedInvalid
    ? "invalid"
    : !complete
      ? "incomplete"
      : samples.length === 0
        ? "not_run"
        : "complete";

  const reasonCodes = new Set(validity.reason_codes);
  if (hasDrops) reasonCodes.add("capture_incomplete");
  if (hasFailedOperations) reasonCodes.add("semantic_verification_failed");
  if (hasCorrectnessFailure) reasonCodes.add("correctness_verification_failed");
  if (hasUnverifiedBuild) reasonCodes.add("unverified_build");
  if (hasForcedInvalid) reasonCodes.add("child_result_invalid");
  if (hasCensoredOperations) reasonCodes.add("operations_censored");
  if (!validity.complete) reasonCodes.add("capture_incomplete");

  return {
    schema: PERFORMANCE_RESULT_SCHEMA,
    example_only: false,
    metric_definition_version: METRIC_DEFINITION_VERSION,
    status,
    run: {
      ...run,
      metric_definition_version: METRIC_DEFINITION_VERSION,
      collector_version: PERFORMANCE_COLLECTOR_VERSION,
    } as TRun & {
      readonly metric_definition_version: typeof METRIC_DEFINITION_VERSION;
      readonly collector_version: typeof PERFORMANCE_COLLECTOR_VERSION;
    },
    build: { ...build },
    environment: { ...environment },
    clock: { strategy: "local_monotonic_us_with_bounded_sync", sync_valid: null, uncertainty_us: null },
    validity: {
      ...validity,
      complete,
      reason_codes: [...reasonCodes].sort(),
    },
    operations: samples.map((sample) => ({ ...sample })),
    metrics,
    structural: options.structural ?? {},
    correctness,
    comparison: { status: "baseline_missing", baseline_id: null, regressions: [] },
    artifacts: options.artifacts ?? [],
  } as const;
}

interface ColdPerformanceResultDocument {
  readonly status: string;
  readonly run: ColdPerformanceRunMetadata;
  readonly build: Record<string, unknown>;
  readonly environment: Record<string, unknown>;
  readonly validity: ResultValidity;
  readonly operations: readonly RawPerformanceOperation[];
  readonly correctness: Readonly<Record<string, boolean | null>>;
  readonly structural: Readonly<Record<string, number | null>>;
  readonly artifacts: readonly unknown[];
  readonly action_windows?: unknown;
}

interface PerformanceFixtureManifestMetadata extends Record<string, unknown> {
  readonly assets: readonly { readonly sha256: string }[];
}

interface ColdPerformanceRunMetadata extends Record<string, unknown> {
  readonly run_id: string;
  readonly scenario_id: string;
  readonly seed: string | number;
  readonly mode: string;
  readonly cache_state: string;
  readonly cold_launch_index: number;
  readonly fixture_manifest_sha256: string;
  readonly fixture_manifest: PerformanceFixtureManifestMetadata;
}

function isVerifiedOperationDocument(value: unknown): ColdPerformanceResultDocument {
  const validation = validateResultDocument(value);
  if (!validation.valid) {
    throw new TypeError(`cold result is invalid: ${validation.errors.join("; ")}`);
  }
  return value as ColdPerformanceResultDocument;
}

function mergeCorrectness(
  documents: readonly ColdPerformanceResultDocument[],
): Readonly<Record<string, boolean | null>> {
  const keys = new Set(documents.flatMap((document) => Object.keys(document.correctness)));
  const merged: Record<string, boolean | null> = {};
  for (const key of keys) {
    const values = documents.map((document) => document.correctness[key] ?? null);
    if (key === "stale_frame_commits") {
      merged[key] = values.includes(true) ? true : values.every((value) => value === false) ? false : null;
    } else if (
      key.endsWith("_verified") ||
      key === "cancel_restored_editing_context"
    ) {
      merged[key] = values.includes(false) ? false : values.every((value) => value === true) ? true : null;
    } else {
      merged[key] = values.every((value) => value === values[0]) ? values[0]! : null;
    }
  }
  return merged;
}

function mergeStructural(
  documents: readonly ColdPerformanceResultDocument[],
): Readonly<Record<string, number | null>> {
  const keys = new Set(documents.flatMap((document) => Object.keys(document.structural)));
  const merged: Record<string, number | null> = {};
  for (const key of keys) {
    const values = documents.map((document) => document.structural[key] ?? null);
    merged[key] = values.every((value) => value === values[0]) ? values[0]! : null;
  }
  return merged;
}

/** Combine one cold operation result from each isolated launch into one cold distribution. */
export function combineColdPerformanceResults(
  input: readonly unknown[],
) {
  if (input.length === 0) throw new TypeError("at least one cold performance result is required");
  const documents = input.map(isVerifiedOperationDocument);
  const runIds = new Set<string>();
  const launchIndexes = new Set<number>();
  for (const document of documents) {
    const runId = document.run.run_id;
    const launchIndex = document.run.cold_launch_index;
    if (typeof runId !== "string" || runId.length === 0) throw new TypeError("cold result run_id is required");
    if (runIds.has(runId)) throw new TypeError(`duplicate cold result run_id: ${runId}`);
    runIds.add(runId);
    if (typeof launchIndex !== "number" || !Number.isInteger(launchIndex) || launchIndex < 0) {
      throw new TypeError(`cold result ${runId} requires a non-negative cold_launch_index`);
    }
    if (launchIndexes.has(launchIndex)) throw new TypeError(`duplicate cold_launch_index: ${launchIndex}`);
    launchIndexes.add(launchIndex);
    if (document.run.mode !== "light" || typeof document.run.cache_state !== "string" || !/cold/i.test(document.run.cache_state)) {
      throw new TypeError(`cold result ${runId} must be a light-mode cold-cache run`);
    }
    const unverifiedBuild = document.build.build_verified === false;
    const expectedOperationCount = unverifiedBuild ? 0 : 1;
    if (document.operations.length !== expectedOperationCount) {
      throw new TypeError(`cold result ${runId} must contain exactly ${expectedOperationCount} operation row(s)`);
    }
  }

  const ordered = [...documents].sort((left, right) =>
    Number(left.run.cold_launch_index) - Number(right.run.cold_launch_index),
  );
  ordered.forEach((document, index) => {
    if (document.run.cold_launch_index !== index) {
      throw new TypeError("cold_launch_index values must be contiguous and start at zero");
    }
  });
  const first = ordered[0]!;
  for (const candidate of ordered.slice(1)) {
    const differences = performanceAggregationIdentityDifferences(first, candidate);
    if (differences.length > 0) {
      throw new TypeError(`cold result identity mismatch: ${differences.join(", ")}`);
    }
  }

  const samples = ordered.flatMap((document) => {
    const runId = String(document.run.run_id);
    return document.operations.map((operation) => ({
      ...operation,
      operation_id: `${runId}:${operation.operation_id}`,
    }));
  });
  const baseRun = Object.fromEntries(
    Object.entries(first.run).filter(([key]) => key !== "run_id" && key !== "cold_launch_index"),
  );
  const constituentRuns = ordered.map((document) => ({
    run_id: document.run.run_id,
    cold_launch_index: document.run.cold_launch_index,
    fixture_manifest_sha256: document.run.fixture_manifest_sha256,
    fixture_manifest: document.run.fixture_manifest,
    build: document.build,
    environment: document.environment,
    action_windows: document.action_windows ?? null,
  }));
  const reasons = new Set(ordered.flatMap((document) => document.validity.reason_codes));
  const anyInvalid = ordered.some((document) => document.status === "invalid");
  const allComplete = ordered.every((document) => document.status === "complete" && document.validity.complete);

  return createPerformanceResult({
    run: {
      ...baseRun,
      run_id: `${String(first.run.run_id)}.cold-summary`,
      cold_launches: ordered.length,
      expected_operations: samples.length || ordered.length,
      constituent_run_ids: ordered.map((document) => document.run.run_id),
      constituent_runs: constituentRuns,
    },
    build: first.build,
    environment: first.environment,
    samples,
    correctness: mergeCorrectness(ordered),
    structural: mergeStructural(ordered),
    validity: {
      complete: allComplete,
      reason_codes: [...reasons],
      events_dropped: ordered.reduce((sum, document) => sum + document.validity.events_dropped, 0),
      critical_endpoints_dropped: ordered.reduce((sum, document) => sum + document.validity.critical_endpoints_dropped, 0),
      probe_calibrated: ordered.every((document) => document.validity.probe_calibrated),
    },
    artifacts: ordered.flatMap((document) => document.artifacts),
    forceInvalid: anyInvalid,
  });
}
