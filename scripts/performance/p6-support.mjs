import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  performanceAggregationIdentityDifferences,
  performanceComparisonIdentity,
  validateResultDocument,
} from "./result-contract.mjs";

export const PERFORMANCE_BASELINE_SCHEMA = "reelterminal.performance-baseline/v1";
export const PROBE_CALIBRATION_SCHEMA = "reelterminal.probe-calibration/v1";
export const MINIMUM_BASELINE_RUNS = 3;
export const MAXIMUM_BASELINE_RUNS = 20;

const RESULT_FILE = /\.result\.json$/i;
const PREFLIGHT_FILE = /\.preflight\.json$/i;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const HASH = /^[a-f0-9]{64}$/i;
const BUILD_IDENTITY_FIELDS = [
  "build_verified", "source_head", "dirty", "source_digest", "dirty_diff_digest",
  "lockfile_digest", "main_bundle_sha256", "preload_bundle_sha256",
  "renderer_manifest_sha256", "worker_manifest_sha256", "executable_sha256",
  "app_version", "build_type",
];
const DROP_FIELDS = [
  "eventsDropped", "criticalEndpointsDropped", "samplesDropped", "labelsDropped",
  "truncatedFields", "collectorErrors", "strandedSpans", "openSpans",
];
const STRUCTURAL_LIMITS = new Map([
  ["font_installs_unchanged", 0],
  ["full_font_validations_unchanged", 0],
  ["full_project_clones_per_gesture", 0],
  ["semantic_commits_per_gesture", 1],
  ["undo_entries_per_gesture", 1],
]);

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function digestJson(value) {
  return sha256(stableJson(value));
}

export function runKey(runId) {
  return sha256(String(runId));
}

export function safeToken(value) {
  return typeof value === "string" && SAFE_TOKEN.test(value) ? value : null;
}

export function parseCliOptions(args, definitions) {
  const parsed = {};
  const allowed = new Set(Object.keys(definitions));
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!allowed.has(flag)) throw new Error(`unknown flag: ${flag}`);
    if (Object.hasOwn(parsed, flag)) throw new Error(`duplicate flag: ${flag}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    parsed[flag] = value;
    index += 1;
  }
  for (const [flag, definition] of Object.entries(definitions)) {
    if (definition.required && !Object.hasOwn(parsed, flag)) throw new Error(`missing required flag: ${flag}`);
    if (Object.hasOwn(parsed, flag) && definition.validate && !definition.validate(parsed[flag])) {
      throw new Error(`invalid value for ${flag}`);
    }
  }
  return parsed;
}

async function walkJsonFiles(directory, include) {
  const files = [];
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && include(entry.name)) files.push(file);
    }
  }
  await visit(directory);
  return files;
}

async function parseJsonFile(filePath) {
  try {
    return { value: JSON.parse(await readFile(filePath, "utf8")), error: null };
  } catch (error) {
    if (error instanceof SyntaxError) return { value: null, error: "invalid_json" };
    if (error?.code === "ENOENT") return { value: null, error: "file_not_found" };
    throw error;
  }
}

/** Collect only the result and preflight artifact classes; never expose source paths. */
export async function collectPerformanceArtifacts(directory) {
  let files;
  try {
    files = await walkJsonFiles(directory, (name) => RESULT_FILE.test(name) || PREFLIGHT_FILE.test(name));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return { results: [], preflights: [], errors: ["artifact_directory_missing"] };
    }
    throw error;
  }

  const results = [];
  const preflights = [];
  const errors = [];
  for (const filePath of files) {
    const isResult = RESULT_FILE.test(filePath);
    const { value, error } = await parseJsonFile(filePath);
    const item = { filePath, document: value, error };
    if (isResult) results.push(item);
    else preflights.push(item);
  }
  if (results.length === 0) errors.push("no_result_artifacts");
  return { results, preflights, errors };
}

export async function loadCalibrationDocuments(inputPath) {
  if (!inputPath) return { documents: [], error: "calibration_missing" };
  let files;
  try {
    const absolutePath = path.resolve(inputPath);
    const info = await import("node:fs/promises").then(({ stat }) => stat(absolutePath));
    files = info.isDirectory()
      ? await walkJsonFiles(absolutePath, (name) => /^probe-calibration-.*\.json$/i.test(name))
      : [absolutePath];
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return { documents: [], error: "calibration_missing" };
    }
    throw error;
  }

  const documents = [];
  for (const filePath of files) {
    const parsed = await parseJsonFile(filePath);
    documents.push({ document: parsed.value, error: parsed.error });
  }
  return {
    documents,
    error: documents.length === 0 ? "calibration_missing" : null,
  };
}

function buildProjection(build) {
  return Object.fromEntries(BUILD_IDENTITY_FIELDS.map((key) => [key, build?.[key] ?? null]));
}

function environmentProjection(environment) {
  return {
    electron: environment?.electron ?? null,
    chrome: environment?.chrome ?? null,
    os: environment?.os ?? null,
    runner_class: environment?.runner_class ?? null,
    cpu: environment?.cpu ?? null,
    total_memory_bytes: environment?.memory?.total_bytes ?? null,
    gpu: environment?.gpu ?? null,
    window_css_px: environment?.window_css_px ?? null,
    window_content_dip_px: environment?.window_content_dip_px ?? null,
    device_scale_factor: environment?.device_scale_factor ?? null,
    refresh_hz_estimate: environment?.refresh_hz_estimate ?? null,
    devtools_open: environment?.devtools_open ?? null,
    capabilities: environment?.capabilities ?? null,
    decode_backend: environment?.decode_backend ?? null,
    parallel_decoder_available: environment?.parallel_decoder_available ?? null,
    power_state: environment?.power_state ?? null,
    load_state: environment?.load_state ?? null,
    occlusion_state: environment?.occlusion_state ?? null,
  };
}

function hasNoDrops(report) {
  return DROP_FIELDS.every((key) => report?.[key] === undefined || report[key] === 0);
}

function calibrationControlsQualified(controls) {
  const blocking = controls?.blocking;
  const blockingEvents = [
    ...(Array.isArray(blocking?.events) ? blocking.events : []),
    ...(Array.isArray(blocking?.criticalEvents) ? blocking.criticalEvents : []),
  ];
  const caughtBlocking = blockingEvents.some((event) =>
    event?.phase === "main.longtask" && event?.kind === "sample" && event?.dims?.durationMs >= 70,
  );
  const asyncControl = controls?.async;
  const asyncReport = asyncControl?.report;
  return blocking?.status === "complete" &&
    blocking?.observerCapabilities?.longTask === "supported" &&
    caughtBlocking && hasNoDrops(blocking?.drops) &&
    asyncReport?.status === "complete" &&
    Number.isFinite(asyncReport?.wallDurationUs) && asyncReport.wallDurationUs >= 140_000 &&
    Number.isFinite(asyncControl?.taskMs) && asyncControl.taskMs < 80 &&
    hasNoDrops(asyncReport?.drops);
}

function medianUpper(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

function closeEnough(actual, expected) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= Math.max(0.000001, Math.abs(expected) * 0.000001);
}

function calibrationRunsQualified(calibration) {
  const modes = ["off", "light", "light", "off"];
  const runs = calibration.runs;
  if (!Array.isArray(runs) || runs.length !== 20) return false;
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    const expectedMode = modes[index % modes.length];
    if (run?.mode !== expectedMode) return false;
    for (const key of ["durationMs", "taskSeconds", "heapBytesBefore", "heapBytesAfter", "rssBytes", "exportMs"]) {
      if (!Number.isFinite(run[key]) || run[key] < 0) return false;
    }
    if (run.durationMs === 0 || !Number.isInteger(run.events) || run.events < 0) return false;
    if (run.mode === "off" && run.events !== 0) return false;
    if (run.mode === "light" && run.events === 0) return false;
  }
  const offValues = runs.filter((run) => run.mode === "off").map((run) => run.durationMs);
  const lightValues = runs.filter((run) => run.mode === "light").map((run) => run.durationMs);
  const offMedianMs = medianUpper(offValues);
  const lightMedianMs = medianUpper(lightValues);
  const toleranceMs = Math.max(offMedianMs * 0.02, 30);
  const comparison = calibration.comparison;
  return comparison?.method === "five_ABBA_blocks_same_instance_six_real_gestures" &&
    closeEnough(comparison.offMedianMs, offMedianMs) &&
    closeEnough(comparison.lightMedianMs, lightMedianMs) &&
    closeEnough(comparison.toleranceMs, toleranceMs) &&
    closeEnough(comparison.overheadPercent, (lightMedianMs / offMedianMs - 1) * 100) &&
    lightMedianMs - offMedianMs <= toleranceMs;
}

export function safeCalibrationEvidence(item, index) {
  const calibration = item.document;
  const evidenceValid = calibration?.schema === PROBE_CALIBRATION_SCHEMA &&
    calibration.status === "qualified" &&
    calibrationControlsQualified(calibration.controls) &&
    calibrationRunsQualified(calibration) &&
    calibration.environment?.visible === true &&
    calibration.environment?.focused === true &&
    calibration.environment?.devtools_open === false;
  const reason = item.error
    ? item.error
    : calibration?.schema !== PROBE_CALIBRATION_SCHEMA
      ? "calibration_schema_invalid"
      : calibration.status !== "qualified"
        ? "calibration_unqualified"
        : evidenceValid
          ? null
          : "calibration_evidence_invalid";
  const comparison = calibration?.comparison;
  return {
    index,
    schema: calibration?.schema === PROBE_CALIBRATION_SCHEMA ? PROBE_CALIBRATION_SCHEMA : null,
    status: safeToken(calibration?.status),
    reason_codes: reason ? [reason] : [],
    run_count: Array.isArray(calibration?.runs) ? calibration.runs.length : 0,
    comparison: {
      method: safeToken(comparison?.method),
      off_median_ms: Number.isFinite(comparison?.offMedianMs) ? comparison.offMedianMs : null,
      light_median_ms: Number.isFinite(comparison?.lightMedianMs) ? comparison.lightMedianMs : null,
      tolerance_ms: Number.isFinite(comparison?.toleranceMs) ? comparison.toleranceMs : null,
      overhead_percent: Number.isFinite(comparison?.overheadPercent) ? comparison.overheadPercent : null,
    },
  };
}

export function calibrationMatches(document, calibrations) {
  if (document?.run?.scenario_id === "E01") {
    return { matched: false, reason: "calibration_unavailable_non_renderer" };
  }
  if (!Array.isArray(calibrations) || calibrations.length === 0) return { matched: false, reason: "calibration_missing" };
  let sawQualified = false;
  let sawControls = false;
  for (const calibration of calibrations) {
    if (calibration?.schema !== PROBE_CALIBRATION_SCHEMA || calibration?.status !== "qualified") continue;
    sawQualified = true;
    if (!calibrationControlsQualified(calibration.controls) || !calibrationRunsQualified(calibration)) continue;
    if (calibration.environment?.visible !== true || calibration.environment?.focused !== true || calibration.environment?.devtools_open !== false) continue;
    sawControls = true;
    if (stableJson(buildProjection(calibration.build)) !== stableJson(buildProjection(document.build))) continue;
    if (stableJson(environmentProjection(calibration.environment)) !== stableJson(environmentProjection(document.environment))) continue;
    return { matched: true, reason: null };
  }
  if (!sawQualified) return { matched: false, reason: "calibration_unqualified" };
  if (!sawControls) return { matched: false, reason: "calibration_controls_invalid" };
  return { matched: false, reason: "calibration_identity_mismatch" };
}

async function resolveActionWindowArtifact(resultFile, reference, expectedRunId) {
  if (!reference || reference.field !== "action_windows" || typeof reference.artifact !== "string" ||
      path.basename(reference.artifact) !== reference.artifact || !/^[A-Za-z0-9._-]+\.json$/i.test(reference.artifact)) {
    return { windows: [], error: "action_window_reference_invalid" };
  }
  const siblingPath = path.join(path.dirname(resultFile), reference.artifact);
  try {
    const [safePath, actualPath] = await Promise.all([realpath(path.dirname(resultFile)), realpath(siblingPath)]);
    if (path.dirname(actualPath) !== safePath) return { windows: [], error: "action_window_reference_invalid" };
    const parsed = await parseJsonFile(actualPath);
    if (parsed.error) return { windows: [], error: "action_window_artifact_invalid" };
    const bundle = parsed.value;
    if (bundle?.schema !== "reelterminal.performance-action-windows/v1" || !Array.isArray(bundle.action_windows)) {
      return { windows: [], error: "action_window_artifact_invalid" };
    }
    if (bundle.run_id !== expectedRunId) {
      return { windows: [], error: "action_window_artifact_invalid" };
    }
    return { windows: bundle.action_windows, error: null };
  } catch (error) {
    if (error?.code === "ENOENT") return { windows: [], error: "action_window_artifact_missing" };
    throw error;
  }
}

export async function readActionWindows(document, resultFile) {
  if (!Object.hasOwn(document, "action_windows") || document.action_windows === null) {
    const constituentRuns = document.run?.constituent_runs;
    if (!Array.isArray(constituentRuns)) return { windows: [], present: false, error: null };
    const windows = [];
    for (const constituent of constituentRuns) {
      const reference = constituent?.action_windows;
      if (!reference || reference.field !== "action_windows" || typeof reference.artifact !== "string" ||
          path.basename(reference.artifact) !== reference.artifact || !/^[A-Za-z0-9._-]+\.result\.json$/i.test(reference.artifact) ||
          typeof constituent.run_id !== "string") {
        return { windows: [], present: true, error: "constituent_action_windows_missing" };
      }
      const childPath = path.join(path.dirname(resultFile), reference.artifact);
      try {
        const [safePath, actualPath] = await Promise.all([realpath(path.dirname(resultFile)), realpath(childPath)]);
        if (path.dirname(actualPath) !== safePath) return { windows: [], present: true, error: "constituent_action_windows_invalid" };
        const parsed = await parseJsonFile(actualPath);
        if (parsed.error || parsed.value?.run?.run_id !== constituent.run_id ||
            (constituent.scenario_id !== undefined && parsed.value?.run?.scenario_id !== constituent.scenario_id)) {
          return { windows: [], present: true, error: "constituent_action_windows_invalid" };
        }
        const child = await readActionWindows(parsed.value, actualPath);
        if (child.error || !child.present) return { windows: [], present: true, error: child.error ?? "constituent_action_windows_missing" };
        windows.push(...child.windows);
      } catch (error) {
        if (error?.code === "ENOENT") return { windows: [], present: true, error: "constituent_action_windows_missing" };
        throw error;
      }
    }
    return { windows, present: true, error: null };
  }
  if (Array.isArray(document.action_windows)) return { windows: document.action_windows, present: true, error: null };
  const references = document.action_windows?.artifacts;
  if (!Array.isArray(references) || references.length === 0 || !resultFile) {
    return { windows: [], present: true, error: "action_window_reference_invalid" };
  }
  const parts = [];
  for (const reference of references) {
    const loaded = await resolveActionWindowArtifact(resultFile, reference, document.run?.run_id);
    if (loaded.error) return { windows: [], present: true, error: loaded.error };
    parts.push({ reference, windows: loaded.windows });
  }
  parts.sort((left, right) => left.reference.part - right.reference.part);
  const windows = [];
  let expectedStart = 0;
  for (const { reference, windows: partWindows } of parts) {
    if (reference.window_start !== expectedStart || reference.window_count !== partWindows.length) {
      return { windows: [], present: true, error: "action_window_artifact_invalid" };
    }
    expectedStart += partWindows.length;
    windows.push(...partWindows);
  }
  return { windows, present: true, error: null };
}

function summarizeActionWindow(window) {
  const report = window?.report;
  const mainReply = window?.main;
  const mainCapture = mainReply?.ok === true ? mainReply.mainCapture : null;
  const events = Array.isArray(report?.events) ? report.events : [];
  const commits = events.filter((event) => event?.phase === "semantic-state.committed").length;
  const finalCommits = events.filter((event) => event?.phase === "gesture.final-commit").length;
  const counters = report?.counters && typeof report.counters === "object" ? report.counters : {};
  const mainCounters = mainCapture?.counters && typeof mainCapture.counters === "object" ? mainCapture.counters : {};
  return {
    hidden: window?.hiddenDuringAction === true,
    renderer_status: safeToken(report?.status),
    renderer_wall_duration_us: Number.isFinite(report?.wallDurationUs) ? report.wallDurationUs : null,
    renderer_drops: Object.fromEntries(DROP_FIELDS.map((key) => [key, Number.isFinite(report?.drops?.[key]) ? report.drops[key] : 0])),
    main_status: safeToken(mainCapture?.status),
    main_drops: Object.fromEntries([
      ["eventsDropped", mainCapture?.eventsDropped],
      ["labelsDropped", mainCapture?.labelsDropped],
      ["spansDropped", mainCapture?.spansDropped],
      ["truncatedFields", mainCapture?.truncatedFields],
      ["collectorErrors", mainCapture?.collectorErrors],
      ["openSpans", mainCapture?.openSpans],
    ].map(([key, value]) => [key, Number.isFinite(value) ? value : 0])),
    gesture_counts: {
      semantic_commits: commits,
      final_commits: finalCommits,
      full_json_copies: Number(counters["project.full-json-copies"] ?? mainCounters["project.full-json-copies"] ?? 0),
      full_structured_clones: Number(counters["project.full-structured-clones"] ?? mainCounters["project.full-structured-clones"] ?? 0),
    },
  };
}

function inspectActionWindows(windows, present, loadError, operations) {
  const failures = [];
  if (loadError) failures.push(loadError);
  const summaries = windows.map(summarizeActionWindow);
  summaries.forEach((summary, index) => {
    if (summary.hidden) failures.push("window_hidden");
    if (summary.renderer_status !== "complete" || Object.values(summary.renderer_drops).some((value) => value > 0)) {
      failures.push("action_capture_incomplete");
    }
    if (summary.main_status !== "complete" || Object.values(summary.main_drops).some((value) => value > 0)) {
      failures.push("main_capture_incomplete");
    }
    const operation = operations[index];
    if (typeof operation?.metric === "string" && /timeline_.*_(drag|trim)_verified/.test(operation.metric)) {
      if (summary.gesture_counts.semantic_commits !== 1 || summary.gesture_counts.final_commits !== 1) {
        failures.push("gesture_commit_count_invalid");
      }
      if (summary.gesture_counts.full_json_copies !== 0 || summary.gesture_counts.full_structured_clones !== 0) {
        failures.push("full_project_copy_detected");
      }
    }
  });
  if (present && windows.length === 0 && !loadError) failures.push("action_windows_empty");
  return { summaries, failures: [...new Set(failures)] };
}

function inspectDeterministicResult(document, validation, actionEvidence) {
  const failures = [];
  if (!validation.valid) failures.push("invalid_result_contract");
  if (document?.status !== "complete" || document?.validity?.complete !== true) failures.push("run_not_complete");
  if (document?.validity?.events_dropped > 0 || document?.validity?.critical_endpoints_dropped > 0) {
    failures.push("result_events_dropped");
  }
  if (document?.run?.scenario_id !== "E01" &&
      (document?.environment?.visible !== true || document?.environment?.focused !== true || document?.environment?.devtools_open !== false)) {
    failures.push("invalid_window_state");
  }
  if (Array.isArray(document?.operations) && document.operations.some((operation) =>
    operation?.outcome !== "ok" || operation?.target_verified !== true || typeof operation?.duration_ms !== "number",
  )) failures.push("operation_failed_or_unverified");
  if (document?.correctness && typeof document.correctness === "object") {
    for (const [key, value] of Object.entries(document.correctness)) {
      if ((key.endsWith("_verified") || key === "cancel_restored_editing_context") && value === false) failures.push("correctness_failed");
      if (key === "stale_frame_commits" && value === true) failures.push("stale_frame_committed");
    }
  }
  const requiredCorrectness = {
    T01: ["target_frame_verified", "final_state_verified", "single_revision_per_gesture_verified", "single_transaction_per_gesture_verified", "no_full_project_copy_for_gesture_transaction_verified"],
    T02: ["target_frame_verified", "final_state_verified", "single_revision_per_gesture_verified", "single_transaction_per_gesture_verified", "no_full_project_copy_for_gesture_transaction_verified"],
    T03: ["target_frame_verified", "final_state_verified", "single_revision_per_gesture_verified", "single_transaction_per_gesture_verified", "no_full_project_copy_for_gesture_transaction_verified", "multiselection_transaction_verified"],
    H01: ["target_frame_verified"],
    H02: ["target_frame_verified"],
    P01: ["final_state_verified", "single_revision_per_gesture_verified", "single_transaction_per_gesture_verified", "no_full_project_copy_for_gesture_transaction_verified", "durable_final_revision_verified"],
    A01: ["frame_markers_verified", "scheduled_audio_pcm_markers_verified", "segment_seek_pcm_marker_verified", "reverse_freeze_visual_mapping_verified"],
    R01: ["final_state_verified", "target_frame_verified", "resources_returned_verified", "save_queue_drained_verified"],
    R02: ["final_state_verified", "target_frame_verified", "resources_returned_verified", "save_queue_drained_verified"],
    E01: ["fixed_input_immutable_verified", "progress_status_persisted_verified", "successful_export_verified", "failed_export_cleanup_verified", "cancellation_cleanup_verified"],
  }[document?.run?.scenario_id] ?? [];
  if (requiredCorrectness.some((key) => document?.correctness?.[key] !== true)) failures.push("required_correctness_missing");
  if (document?.structural && typeof document.structural === "object") {
    for (const [key, expected] of STRUCTURAL_LIMITS) {
      const actual = document.structural[key];
      if (typeof actual === "number" && actual !== expected) failures.push("structural_invariant_failed");
    }
  }
  failures.push(...actionEvidence.failures);
  return [...new Set(failures)];
}

export async function evaluateResultArtifact(item, calibrations) {
  if (item.error || !item.document || typeof item.document !== "object") {
    return { document: null, validation: { valid: false, errors: [] }, calibration: { matched: false, reason: item.error ?? "invalid_result_json" }, hardFailures: ["invalid_result_json"], actionWindows: [] };
  }
  const document = item.document;
  const validation = validateResultDocument(document);
  const actionRead = await readActionWindows(document, item.filePath);
  const actionEvidence = inspectActionWindows(actionRead.windows, actionRead.present, actionRead.error, Array.isArray(document.operations) ? document.operations : []);
  const hardFailures = inspectDeterministicResult(document, validation, actionEvidence);
  const calibration = calibrationMatches(document, calibrations);
  const derivedDocument = calibration.matched
    ? { ...document, validity: { ...document.validity, probe_calibrated: true } }
    : document;
  const eligible = validation.valid &&
    hardFailures.length === 0 &&
    calibration.matched &&
    document.run?.mode !== "trace" &&
    derivedDocument.status === "complete" &&
    derivedDocument.validity?.complete === true &&
    derivedDocument.validity.events_dropped === 0 &&
    derivedDocument.validity.critical_endpoints_dropped === 0 &&
    derivedDocument.environment?.visible === true &&
    derivedDocument.environment?.focused === true &&
    derivedDocument.environment?.devtools_open === false &&
    Object.values(derivedDocument.metrics ?? {}).every((metric) =>
      ["ok", "insufficient_samples"].includes(metric?.status) && metric?.n_censored === 0 && metric?.n_failed === 0,
    );
  const ineligibleReasons = [...hardFailures];
  if (document.run?.mode === "trace") ineligibleReasons.push("trace_mode_not_baseline");
  if (!calibration.matched) ineligibleReasons.push(calibration.reason);
  if (validation.valid && !eligible && hardFailures.length === 0 && document.run?.mode !== "trace" && calibration.matched) {
    ineligibleReasons.push("invalid_or_incomplete_distribution");
  }
  return {
    document,
    derivedDocument,
    validation,
    calibration,
    hardFailures,
    eligible,
    ineligibleReasons: [...new Set(ineligibleReasons)],
    actionWindows: actionEvidence.summaries,
  };
}

export function baselineGroupDescriptor(document) {
  const metricIdentities = Object.keys(document.metrics).sort();
  const workload = {
    metric_definition_version: document.metric_definition_version,
    collector_version: document.run.collector_version,
    scenario_id: document.run.scenario_id,
    scenario_version: document.run.scenario_version,
    fixture_manifest_sha256: document.run.fixture_manifest_sha256,
    mode: document.run.mode,
    cache_state: document.run.cache_state,
    metric_identities: metricIdentities,
  };
  const comparisonIdentitySha256 = digestJson(performanceComparisonIdentity(document));
  const workloadKey = digestJson(workload);
  return {
    ...workload,
    workload_key: workloadKey,
    comparison_identity_sha256: comparisonIdentitySha256,
    group_id: digestJson({ workload_key: workloadKey, comparison_identity_sha256: comparisonIdentitySha256 }),
  };
}

function safeFixtureManifest(manifest) {
  if (!manifest || typeof manifest !== "object") return null;
  const parameters = {};
  for (const [key, value] of Object.entries(manifest.parameters ?? {})) {
    if (safeToken(key) && (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))) parameters[key] = value;
  }
  return {
    schema: manifest.schema === "reelterminal.performance-fixture/v1" ? manifest.schema : null,
    scenarioId: safeToken(manifest.scenarioId),
    version: Number.isInteger(manifest.version) ? manifest.version : null,
    seed: typeof manifest.seed === "number" && Number.isFinite(manifest.seed)
      ? manifest.seed
      : safeToken(manifest.seed) ?? null,
    parameters,
    expectedSemantics: Array.isArray(manifest.expectedSemantics)
      ? manifest.expectedSemantics.filter((value) => safeToken(value))
      : [],
    assets: Array.isArray(manifest.assets) ? manifest.assets.map((asset) => ({
      assetId: safeToken(asset?.assetId),
      kind: safeToken(asset?.kind),
      mediaType: safeToken(asset?.mediaType),
      byteLength: Number.isInteger(asset?.byteLength) ? asset.byteLength : null,
      sha256: HASH.test(asset?.sha256 ?? "") ? asset.sha256 : null,
    })) : [],
    requiredCapabilities: Array.isArray(manifest.requiredCapabilities)
      ? manifest.requiredCapabilities.filter((value) => safeToken(value))
      : [],
    expectedOperations: Number.isInteger(manifest.expectedOperations) ? manifest.expectedOperations : null,
    timeBudgetMs: Number.isFinite(manifest.timeBudgetMs) ? manifest.timeBudgetMs : null,
  };
}

export function safeRunEvidence(evaluation, index) {
  const document = evaluation.document;
  if (!document) {
    return {
      index,
      run_key: null,
      scenario_id: null,
      status: "invalid",
      hard_failures: evaluation.hardFailures,
      calibration: evaluation.calibration,
      metrics: {},
      operations: [],
      action_windows: [],
    };
  }
  const operations = Array.isArray(document.operations) ? document.operations.map((operation) => ({
    metric: safeToken(operation?.metric),
    outcome: ["ok", "failed", "timeout", "cancelled", "superseded"].includes(operation?.outcome) ? operation.outcome : "invalid",
    duration_ms: Number.isFinite(operation?.duration_ms) ? operation.duration_ms : null,
    target_verified: operation?.target_verified === true,
  })) : [];
  const metrics = {};
  for (const [name, metric] of Object.entries(document.metrics ?? {})) {
    const key = safeToken(name);
    if (!key || !metric || typeof metric !== "object") continue;
    metrics[key] = {
      status: safeToken(metric.status),
      n_requested: Number.isInteger(metric.n_requested) ? metric.n_requested : null,
      n_completed: Number.isInteger(metric.n_completed) ? metric.n_completed : null,
      n_censored: Number.isInteger(metric.n_censored) ? metric.n_censored : null,
      n_failed: Number.isInteger(metric.n_failed) ? metric.n_failed : null,
      p50_ms: Number.isFinite(metric.p50) ? metric.p50 : null,
      p95_ms: Number.isFinite(metric.p95) ? metric.p95 : null,
      p99_ms: Number.isFinite(metric.p99) ? metric.p99 : null,
      max_ms: Number.isFinite(metric.max) ? metric.max : null,
      raw_ms: Array.isArray(metric.raw_ms) ? metric.raw_ms.filter((value) => Number.isFinite(value)) : [],
      quantile_method: safeToken(metric.quantile_method),
    };
  }
  const sourceHead = HASH.test(document.build?.source_head ?? "") || /^[a-f0-9]{40}$/i.test(document.build?.source_head ?? "")
    ? document.build.source_head
    : null;
  return {
    index,
    run_key: typeof document.run?.run_id === "string" ? runKey(document.run.run_id) : null,
    scenario_id: safeToken(document.run?.scenario_id),
    scenario_version: Number.isInteger(document.run?.scenario_version) ? document.run.scenario_version : null,
    seed: typeof document.run?.seed === "number" ? document.run.seed : safeToken(document.run?.seed),
    mode: safeToken(document.run?.mode),
    cache_state: safeToken(document.run?.cache_state),
    fixture_manifest_sha256: HASH.test(document.run?.fixture_manifest_sha256 ?? "") ? document.run.fixture_manifest_sha256 : null,
    fixture_manifest: safeFixtureManifest(document.run?.fixture_manifest),
    status: safeToken(document.status),
    source_head: sourceHead,
    build_digests: {
      main_bundle_sha256: HASH.test(document.build?.main_bundle_sha256 ?? "") ? document.build.main_bundle_sha256 : null,
      preload_bundle_sha256: HASH.test(document.build?.preload_bundle_sha256 ?? "") ? document.build.preload_bundle_sha256 : null,
      renderer_manifest_sha256: HASH.test(document.build?.renderer_manifest_sha256 ?? "") ? document.build.renderer_manifest_sha256 : null,
      worker_manifest_sha256: HASH.test(document.build?.worker_manifest_sha256 ?? "") ? document.build.worker_manifest_sha256 : null,
      executable_sha256: HASH.test(document.build?.executable_sha256 ?? "") ? document.build.executable_sha256 : null,
    },
    build: {
      source_digest: HASH.test(document.build?.source_digest ?? "") ? document.build.source_digest : null,
      dirty_diff_digest: HASH.test(document.build?.dirty_diff_digest ?? "") ? document.build.dirty_diff_digest : null,
      lockfile_digest: HASH.test(document.build?.lockfile_digest ?? "") ? document.build.lockfile_digest : null,
      dirty: typeof document.build?.dirty === "boolean" ? document.build.dirty : null,
      build_type: safeToken(document.build?.build_type),
      app_version: safeToken(document.build?.app_version),
    },
    clock: {
      strategy: safeToken(document.clock?.strategy),
      sync_valid: typeof document.clock?.sync_valid === "boolean" ? document.clock.sync_valid : null,
      uncertainty_us: Number.isFinite(document.clock?.uncertainty_us) ? document.clock.uncertainty_us : null,
    },
    validity: {
      complete: document.validity?.complete === true,
      events_dropped: Number.isFinite(document.validity?.events_dropped) ? document.validity.events_dropped : null,
      critical_endpoints_dropped: Number.isFinite(document.validity?.critical_endpoints_dropped) ? document.validity.critical_endpoints_dropped : null,
      source_probe_calibrated: document.validity?.probe_calibrated === true,
      reason_codes: Array.isArray(document.validity?.reason_codes) ? document.validity.reason_codes.filter((value) => safeToken(value)) : [],
    },
    correctness: Object.fromEntries(Object.entries(document.correctness ?? {}).filter(([key, value]) => safeToken(key) && (typeof value === "boolean" || value === null))),
    structural: Object.fromEntries(Object.entries(document.structural ?? {}).filter(([key, value]) => safeToken(key) && (typeof value === "number" || value === null))),
    calibration: { matched: evaluation.calibration.matched, reason: evaluation.calibration.reason },
    comparison_identity_sha256: document.run && document.metrics && evaluation.validation.valid
      ? digestJson(performanceComparisonIdentity(document))
      : null,
    metrics,
    operations,
    action_windows: evaluation.actionWindows,
    hard_failures: evaluation.hardFailures,
  };
}

export function safePreflightEvidence(item, index) {
  const document = item.document;
  const reasons = Array.isArray(document?.reason_codes) ? document.reason_codes.filter((value) => safeToken(value)) : [];
  return {
    index,
    status: document?.status === "invalid" ? "invalid" : "unknown",
    schema: document?.schema === "reelterminal.performance-preflight/v1" ? document.schema : null,
    run_key: typeof document?.run_id === "string" ? runKey(document.run_id) : null,
    reason_codes: item.error ? [item.error] : reasons,
  };
}

function baselineMetricValues(metrics) {
  return Object.fromEntries(Object.entries(metrics).map(([name, metric]) => [name, {
    n_requested: metric.n_requested,
    n_completed: metric.n_completed,
    n_censored: metric.n_censored,
    n_failed: metric.n_failed,
    p50_ms: metric.p50_ms,
    p95_ms: metric.p95_ms,
    p99_ms: metric.p99_ms,
  }]));
}

export function baselineRunSummary(evaluation, reason, recordedAt = new Date().toISOString()) {
  const evidence = safeRunEvidence(evaluation, 0);
  return {
    run_key: evidence.run_key,
    recorded_at: recordedAt,
    reason,
    source_head: evidence.source_head,
    build_digests: evidence.build_digests,
    metrics: baselineMetricValues(evidence.metrics),
  };
}

export function compareAggregationIdentity(first, candidate) {
  return performanceAggregationIdentityDifferences(first, candidate);
}

export function validateBaselineManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return ["baseline_manifest_invalid"];
  if (manifest.schema !== PERFORMANCE_BASELINE_SCHEMA) errors.push("baseline_schema_invalid");
  if (manifest.status !== "ready") errors.push("baseline_not_accepted");
  if (!manifest.review || typeof manifest.review !== "object" ||
      !safeToken(manifest.review.accepted_by) || typeof manifest.review.reason !== "string" ||
      !manifest.review.reason.trim() || !Number.isFinite(Date.parse(manifest.review.accepted_at))) {
    errors.push("baseline_review_metadata_missing");
  }
  if (manifest.minimum_qualified_runs !== MINIMUM_BASELINE_RUNS || manifest.maximum_runs_per_group !== MAXIMUM_BASELINE_RUNS) {
    errors.push("baseline_policy_invalid");
  }
  if (!Array.isArray(manifest.groups)) errors.push("baseline_groups_invalid");
  else if (manifest.groups.length === 0) errors.push("baseline_groups_invalid");
  else {
    const groupIds = new Set();
    const runKeys = new Set();
    for (const group of manifest.groups) {
      const workloadIdentity = {
        metric_definition_version: group?.metric_definition_version,
        collector_version: group?.collector_version,
        scenario_id: group?.scenario_id,
        scenario_version: group?.scenario_version,
        fixture_manifest_sha256: group?.fixture_manifest_sha256,
        mode: group?.mode,
        cache_state: group?.cache_state,
        metric_identities: group?.metric_identities,
      };
      if (!group || typeof group !== "object" || group.group_id !== digestJson({
        workload_key: group.workload_key,
        comparison_identity_sha256: group.comparison_identity_sha256,
      })) errors.push("baseline_group_identity_invalid");
      if (groupIds.has(group?.group_id)) errors.push("baseline_group_duplicate");
      groupIds.add(group?.group_id);
      if (!HASH.test(group?.workload_key ?? "") || !HASH.test(group?.comparison_identity_sha256 ?? "")) errors.push("baseline_identity_invalid");
      if (!Array.isArray(group?.metric_identities) || group.metric_identities.some((name) => !safeToken(name)) ||
          digestJson(workloadIdentity) !== group?.workload_key) errors.push("baseline_workload_identity_invalid");
      if (!Array.isArray(group?.runs) || group.runs.length < MINIMUM_BASELINE_RUNS || group.runs.length > MAXIMUM_BASELINE_RUNS) {
        errors.push("baseline_run_count_invalid");
        continue;
      }
      for (const run of group.runs) {
        if (!HASH.test(run?.run_key ?? "") || runKeys.has(run.run_key) || !run.metrics || typeof run.metrics !== "object" ||
            typeof run.reason !== "string" || !run.reason.trim() || !Number.isFinite(Date.parse(run.recorded_at)) ||
            (run.source_head !== null && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(run.source_head))) {
          errors.push("baseline_run_invalid");
        }
        runKeys.add(run?.run_key);
        if (stableJson(Object.keys(run?.metrics ?? {}).sort()) !== stableJson(group.metric_identities)) errors.push("baseline_metric_identities_invalid");
        for (const metric of Object.values(run?.metrics ?? {})) {
          if (!metric || typeof metric !== "object" || ["n_requested", "n_completed", "n_censored", "n_failed"].some((key) => !Number.isInteger(metric[key]) || metric[key] < 0)) {
            errors.push("baseline_metric_invalid");
            break;
          }
          if (["p50_ms", "p95_ms", "p99_ms"].some((key) => metric[key] !== null && (!Number.isFinite(metric[key]) || metric[key] < 0))) {
            errors.push("baseline_metric_invalid");
            break;
          }
        }
      }
    }
  }
  return [...new Set(errors)];
}

export function proposalGroup(groupDescriptor, evaluations, reason, previousGroup = null, recordedAt = new Date().toISOString()) {
  const oldRuns = previousGroup?.runs ?? [];
  const nextRuns = evaluations.map((evaluation) => baselineRunSummary(evaluation, reason, recordedAt));
  const unique = new Map();
  for (const run of [...oldRuns, ...nextRuns]) unique.set(run.run_key, run);
  const runs = [...unique.values()].sort((left, right) => left.recorded_at.localeCompare(right.recorded_at)).slice(-MAXIMUM_BASELINE_RUNS);
  return {
    ...groupDescriptor,
    runs,
  };
}

export function compareCandidateToBaseline(candidate, baselineGroup) {
  const metricResults = [];
  const cold = /cold/i.test(candidate.run.cache_state);
  const percentile = cold ? "p50" : "p95";
  for (const [metricName, metric] of Object.entries(candidate.metrics)) {
    const baselineValues = baselineGroup.runs
      .map((run) => run.metrics?.[metricName]?.[`${percentile}_ms`])
      .filter((value) => Number.isFinite(value));
    const value = metric[percentile];
    if (baselineValues.length < MINIMUM_BASELINE_RUNS || !Number.isFinite(value)) {
      metricResults.push({ metric: metricName, percentile, status: "insufficient_samples", baseline_run_count: baselineValues.length, candidate_ms: Number.isFinite(value) ? value : null });
      continue;
    }
    const sorted = baselineValues.sort((left, right) => left - right);
    const midpoint = sorted.length % 2 === 0
      ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : sorted[Math.floor(sorted.length / 2)];
    const delta = value - midpoint;
    const changePercent = midpoint === 0 ? null : delta / midpoint * 100;
    const regression = delta > 10 && changePercent !== null && changePercent > 20;
    metricResults.push({
      metric: metricName,
      percentile,
      status: regression ? "regression_warning" : "within_threshold",
      baseline_ms: midpoint,
      candidate_ms: value,
      absolute_delta_ms: delta,
      change_percent: changePercent,
      threshold: { absolute_delta_ms: 10, change_percent: 20, both_required: true },
      baseline_run_count: baselineValues.length,
    });
  }
  return metricResults;
}
