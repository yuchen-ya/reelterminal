import { createHash } from "node:crypto";

export const RESULT_SCHEMA = "reelterminal.performance-result/v1";
export const FIXTURE_SCHEMA = "reelterminal.performance-fixture/v1";
export const METRIC_DEFINITION_VERSION = 1;
export const COLLECTOR_VERSION = "p3-v1";
export const QUANTILE_METHOD = "nearest_rank";

const RESULT_STATUSES = new Set(["not_run", "complete", "incomplete", "aborted", "invalid"]);
const METRIC_STATUSES = new Set([
  "ok",
  "not_run",
  "unsupported",
  "not_applicable",
  "insufficient_samples",
  "indeterminate",
  "failed",
]);
const MODES = new Set(["counts", "light", "trace"]);
const OUTCOMES = new Set(["ok", "failed", "timeout", "cancelled", "superseded"]);
const SCENARIOS = new Set(["T01", "T02", "T03", "H01", "H02", "P01", "A01", "R01", "R02", "E01"]);
const HASH_PATTERN = /^[a-f0-9]{64}$/i;
const METRIC_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function fixtureManifestSha256(manifest) {
  return createHash("sha256").update(stableJson(manifest), "utf8").digest("hex");
}

function nearestRank(sortedValues, fraction) {
  if (sortedValues.length === 0) return null;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(fraction * sortedValues.length) - 1));
  return sortedValues[index];
}

function checkFixtureManifest(manifest, errors) {
  if (!isPlainObject(manifest)) {
    errors.push("run.fixture_manifest must be an object");
    return;
  }
  if (manifest.schema !== FIXTURE_SCHEMA) errors.push(`run.fixture_manifest.schema must be ${FIXTURE_SCHEMA}`);
  if (!SCENARIOS.has(manifest.scenarioId)) errors.push("run.fixture_manifest.scenarioId invalid");
  if (!Number.isInteger(manifest.version) || manifest.version < 1) errors.push("run.fixture_manifest.version must be a positive integer");
  if (!(typeof manifest.seed === "string" || (typeof manifest.seed === "number" && Number.isFinite(manifest.seed)))) {
    errors.push("run.fixture_manifest.seed must be a string or finite number");
  }
  if (!isPlainObject(manifest.parameters)) {
    errors.push("run.fixture_manifest.parameters must be an object");
  } else {
    for (const [key, value] of Object.entries(manifest.parameters)) {
      if (!key || !(typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))) {
        errors.push(`run.fixture_manifest.parameters.${key} must be a finite scalar`);
      }
    }
  }
  if (!Array.isArray(manifest.expectedSemantics) || manifest.expectedSemantics.length === 0 || manifest.expectedSemantics.some((value) => typeof value !== "string" || !value)) {
    errors.push("run.fixture_manifest.expectedSemantics must be a non-empty string[]");
  }
  if (!Array.isArray(manifest.assets)) {
    errors.push("run.fixture_manifest.assets must be an array");
  } else {
    const assetIds = new Set();
    manifest.assets.forEach((asset, index) => {
      const where = `run.fixture_manifest.assets[${index}]`;
      if (!isPlainObject(asset)) {
        errors.push(`${where} must be an object`);
        return;
      }
      for (const key of ["assetId", "kind", "mediaType"]) {
        if (typeof asset[key] !== "string" || asset[key].length === 0) errors.push(`${where}.${key} required`);
      }
      if (typeof asset.assetId === "string") {
        if (assetIds.has(asset.assetId)) errors.push(`${where}.assetId is duplicated`);
        assetIds.add(asset.assetId);
      }
      if (!Number.isInteger(asset.byteLength) || asset.byteLength < 0) errors.push(`${where}.byteLength must be a non-negative integer`);
      if (typeof asset.sha256 !== "string" || !HASH_PATTERN.test(asset.sha256)) errors.push(`${where}.sha256 must be a SHA-256 hex digest`);
    });
  }
  if (!Array.isArray(manifest.requiredCapabilities) || manifest.requiredCapabilities.some((value) => typeof value !== "string" || !value)) {
    errors.push("run.fixture_manifest.requiredCapabilities must be string[]");
  }
  if (!Number.isInteger(manifest.expectedOperations) || manifest.expectedOperations < 1) errors.push("run.fixture_manifest.expectedOperations must be a positive integer");
  if (!isFiniteNonNegative(manifest.timeBudgetMs) || manifest.timeBudgetMs === 0) errors.push("run.fixture_manifest.timeBudgetMs must be > 0");
}

function checkBuild(build, errors, resultStatus) {
  if (!isPlainObject(build)) {
    errors.push("build must be an object");
    return;
  }
  if (typeof build.build_verified !== "boolean") errors.push("build.build_verified must be a boolean");
  const unverified = build.build_verified === false;
  if (unverified) {
    if (resultStatus !== "invalid") errors.push("unverified build artifacts must have status invalid");
    if (typeof build.build_reason !== "string" || !build.build_reason) errors.push("unverified build requires build.build_reason");
    if (build.build_type !== null && build.build_type !== "production") errors.push("build.build_type must be production|null");
  } else if (build.build_type !== "production") {
    errors.push("build.build_type must be production");
  }

  const validateField = (key, valid, description) => {
    if (unverified && build[key] === null) return;
    if (!valid(build[key])) errors.push(`build.${key} must be ${description}`);
  };
  validateField("source_head", (value) => typeof value === "string" && /^[a-f0-9]{40,64}$/i.test(value), "a git SHA or null for an unverified build");
  validateField("app_version", (value) => typeof value === "string" && value.length > 0, "a non-empty version or null for an unverified build");
  validateField("dirty", (value) => typeof value === "boolean", "boolean or null for an unverified build");
  for (const key of ["source_digest", "lockfile_digest", "main_bundle_sha256", "preload_bundle_sha256", "renderer_manifest_sha256", "worker_manifest_sha256", "executable_sha256"]) {
    validateField(key, (value) => typeof value === "string" && HASH_PATTERN.test(value), "a SHA-256 hex digest or null for an unverified build");
  }
  validateField("dirty_diff_digest", (value) => typeof value === "string" && HASH_PATTERN.test(value), "a SHA-256 hex digest or null for an unverified build");
}

function checkEnvironment(environment, errors) {
  if (!isPlainObject(environment)) {
    errors.push("environment must be an object");
    return;
  }
  for (const key of ["electron", "chrome"]) {
    if (typeof environment[key] !== "string" || environment[key].length === 0) errors.push(`environment.${key} required`);
  }
  if (!isPlainObject(environment.os)) errors.push("environment.os must be an object");
  else {
    for (const key of ["platform", "release", "arch"]) {
      if (typeof environment.os[key] !== "string" || !environment.os[key]) errors.push(`environment.os.${key} required`);
    }
  }
  if (environment.runner_class !== "ci" && environment.runner_class !== "local") errors.push("environment.runner_class must be ci|local");
  if (!isPlainObject(environment.cpu)) errors.push("environment.cpu must be an object");
  else {
    if (typeof environment.cpu.model !== "string" || !environment.cpu.model) errors.push("environment.cpu.model required");
    if (!Number.isInteger(environment.cpu.logical_cores) || environment.cpu.logical_cores < 1) errors.push("environment.cpu.logical_cores must be a positive integer");
  }
  if (!isPlainObject(environment.memory)) errors.push("environment.memory must be an object");
  else {
    for (const key of ["total_bytes", "free_bytes"]) {
      if (!isFiniteNonNegative(environment.memory[key])) errors.push(`environment.memory.${key} must be finite and non-negative`);
    }
  }
  if (!isPlainObject(environment.gpu)) errors.push("environment.gpu must be an object");
  else {
    if (environment.gpu.info_status !== "available" && environment.gpu.info_status !== "unavailable") errors.push("environment.gpu.info_status invalid");
    if (!Array.isArray(environment.gpu.devices)) errors.push("environment.gpu.devices must be an array");
    else {
      environment.gpu.devices.forEach((device, index) => {
        const where = `environment.gpu.devices[${index}]`;
        if (!isPlainObject(device)) {
          errors.push(`${where} must be an object`);
          return;
        }
        if (device.vendor_id !== null && !Number.isInteger(device.vendor_id)) errors.push(`${where}.vendor_id must be integer|null`);
        if (device.device_id !== null && !Number.isInteger(device.device_id)) errors.push(`${where}.device_id must be integer|null`);
        if (device.name !== null && typeof device.name !== "string") errors.push(`${where}.name must be string|null`);
        if (device.active !== null && typeof device.active !== "boolean") errors.push(`${where}.active must be boolean|null`);
      });
    }
    if (!isPlainObject(environment.gpu.feature_status)) errors.push("environment.gpu.feature_status must be an object");
    else {
      for (const [key, value] of Object.entries(environment.gpu.feature_status)) {
        if (value !== null && typeof value !== "string") errors.push(`environment.gpu.feature_status.${key} must be string|null`);
      }
    }
  }
  for (const key of ["visible", "focused", "devtools_open"]) {
    if (environment[key] !== null && typeof environment[key] !== "boolean") errors.push(`environment.${key} must be boolean|null`);
  }
  for (const key of ["window_css_px", "window_content_dip_px"]) {
    const size = environment[key];
    if (size !== null && (!isPlainObject(size) || !isFiniteNonNegative(size.width) || !isFiniteNonNegative(size.height))) {
      errors.push(`environment.${key} must be a size object or null`);
    }
  }
  if (environment.device_scale_factor !== null && (!isFiniteNonNegative(environment.device_scale_factor) || environment.device_scale_factor === 0)) errors.push("environment.device_scale_factor must be > 0 or null");
  if (environment.refresh_hz_estimate !== null && environment.refresh_hz_estimate !== undefined && !isFiniteNonNegative(environment.refresh_hz_estimate)) {
    errors.push("environment.refresh_hz_estimate must be finite, non-negative, or null");
  }
  if (!isPlainObject(environment.capabilities)) errors.push("environment.capabilities must be an object");
  else {
    for (const key of ["webgpu", "wasm", "shared_array_buffer"]) {
      if (typeof environment.capabilities[key] !== "boolean" && environment.capabilities[key] !== null) {
        errors.push(`environment.capabilities.${key} must be boolean|null`);
      }
    }
    if (!Number.isInteger(environment.capabilities.hardware_concurrency) || environment.capabilities.hardware_concurrency < 1) {
      errors.push("environment.capabilities.hardware_concurrency must be a positive integer");
    }
    if (environment.capabilities.device_memory_gb !== null && !isFiniteNonNegative(environment.capabilities.device_memory_gb)) {
      errors.push("environment.capabilities.device_memory_gb must be finite and non-negative or null");
    }
  }
  for (const key of ["power_state", "load_state", "occlusion_state"]) {
    if (environment[key] !== "unknown") errors.push(`environment.${key} must be unknown`);
  }
  for (const key of ["decode_backend", "parallel_decoder_available"]) {
    const value = environment[key];
    if (value !== null && value !== undefined && typeof value !== "string" && typeof value !== "boolean") {
      errors.push(`environment.${key} must be string|boolean|null`);
    }
  }
}

function checkOperation(operation, index, errors) {
  const where = `operations[${index}]`;
  if (!isPlainObject(operation)) {
    errors.push(`${where} must be an object`);
    return;
  }
  if (typeof operation.operation_id !== "string" || operation.operation_id.length === 0) errors.push(`${where}.operation_id required`);
  if (typeof operation.metric !== "string" || !METRIC_PATTERN.test(operation.metric)) errors.push(`${where}.metric invalid`);
  if (!OUTCOMES.has(operation.outcome)) errors.push(`${where}.outcome invalid`);
  if (operation.duration_ms !== null && !isFiniteNonNegative(operation.duration_ms)) errors.push(`${where}.duration_ms must be null or a finite number >= 0`);
  if (operation.waited_ms !== undefined && !isFiniteNonNegative(operation.waited_ms)) errors.push(`${where}.waited_ms must be finite and >= 0`);
  if (typeof operation.target_verified !== "boolean") errors.push(`${where}.target_verified must be boolean`);
}

function checkMetric(metric, name, operations, run, resultStatus, validity, errors) {
  const where = `metrics.${name}`;
  if (!METRIC_PATTERN.test(name)) errors.push(`${where}: invalid metric identity`);
  if (!isPlainObject(metric)) {
    errors.push(`${where} must be an object`);
    return;
  }
  if (!METRIC_STATUSES.has(metric.status)) errors.push(`${where}.status invalid`);
  const rows = operations.filter((operation) => operation?.metric === name);
  const completed = rows.filter((operation) => isPlainObject(operation) && operation.outcome === "ok" && operation.target_verified && isFiniteNonNegative(operation.duration_ms));
  const censored = rows.filter((operation) => isPlainObject(operation) && ["timeout", "cancelled", "superseded"].includes(operation.outcome));
  const failed = rows.length - completed.length - censored.length;
  for (const key of ["n_requested", "n_completed", "n_censored", "n_failed"]) {
    if (!Number.isInteger(metric[key]) || metric[key] < 0) errors.push(`${where}.${key} must be a non-negative integer`);
  }
  if (metric.n_requested !== rows.length || metric.n_completed !== completed.length || metric.n_censored !== censored.length || metric.n_failed !== failed) {
    errors.push(`${where} counts do not match raw operations`);
  }
  const raw = [...completed.map((operation) => operation.duration_ms)].sort((a, b) => a - b);
  if (!Array.isArray(metric.raw_ms) || metric.raw_ms.some((value) => !isFiniteNonNegative(value)) || stableJson(metric.raw_ms) !== stableJson(raw)) {
    errors.push(`${where}.raw_ms must equal sorted verified completed operation durations`);
  }
  const cold = typeof run.cache_state === "string" && /cold/i.test(run.cache_state);
  for (const key of ["median_ms", "min", "max", "p50", "p95", "p99"]) {
    if (metric[key] !== null && !isFiniteNonNegative(metric[key])) errors.push(`${where}.${key} must be finite and non-negative or null`);
  }
  if (metric.quantile_method !== QUANTILE_METHOD) errors.push(`${where}.quantile_method must be ${QUANTILE_METHOD}`);
  if (metric.median_ms !== metric.p50) errors.push(`${where}.median_ms must equal p50`);

  const blocked =
    resultStatus !== "complete" ||
    validity.complete !== true ||
    validity.events_dropped > 0 ||
    validity.critical_endpoints_dropped > 0 ||
    censored.length > 0 ||
    failed > 0;
  if (blocked && ["p50", "p95", "p99", "median_ms", "min", "max"].some((key) => metric[key] !== null)) {
    errors.push(`${where} must not report passing distribution values for invalid, incomplete, failed, or censored data`);
  }
  if (failed > 0 || censored.length > 0) {
    if (metric.status !== "failed") errors.push(`${where}.status must be failed when any request failed or was censored`);
  } else if (blocked && metric.status !== "failed") {
    errors.push(`${where}.status must be failed when the result is invalid or incomplete`);
  } else if (!blocked) {
    const expected50 = raw.length ? nearestRank(raw, 0.5) : null;
    if (metric.p50 !== expected50) errors.push(`${where}.p50 does not match nearest-rank raw values`);
    if (metric.min !== (raw[0] ?? null) || metric.max !== (raw.at(-1) ?? null)) errors.push(`${where} range does not match raw values`);
    if (cold) {
      if (metric.p95 !== null || metric.p99 !== null) errors.push(`${where} cold samples cannot report p95 or p99`);
    } else {
      const expected95 = raw.length >= 20 ? nearestRank(raw, 0.95) : null;
      const expected99 = raw.length >= 100 ? nearestRank(raw, 0.99) : null;
      if (metric.p95 !== expected95) errors.push(`${where}.p95 does not match warm sample threshold/value`);
      if (metric.p99 !== expected99) errors.push(`${where}.p99 does not match warm sample threshold/value`);
    }
    const hasP95 = raw.length >= 20;
    const hasP99 = raw.length >= 100;
    const expectedStatus = raw.length > 0 && (cold || (hasP95 && hasP99))
      ? "ok"
      : "insufficient_samples";
    if (metric.status !== expectedStatus) errors.push(`${where}.status must be ${expectedStatus} for the sample count`);
  }
  if (metric.status === "ok" && rows.length === 0) errors.push(`${where} cannot be ok without raw operations`);
}

/** Strict on-disk validation used by both offline CLIs. */
export function validateResultDocument(document) {
  const errors = [];
  if (!isPlainObject(document)) return { valid: false, errors: ["result must be a JSON object"] };
  if (document.schema !== RESULT_SCHEMA) errors.push(`schema must be ${RESULT_SCHEMA}`);
  if (document.example_only !== false) errors.push("example_only must be false for a run artifact");
  if (!RESULT_STATUSES.has(document.status)) errors.push("status invalid");
  if (document.metric_definition_version !== METRIC_DEFINITION_VERSION) errors.push(`metric_definition_version must be ${METRIC_DEFINITION_VERSION}`);

  const run = document.run;
  if (!isPlainObject(run)) {
    errors.push("run must be an object");
  } else {
    if (typeof run.run_id !== "string" || run.run_id.length === 0) errors.push("run.run_id required");
    if (!SCENARIOS.has(run.scenario_id)) errors.push("run.scenario_id invalid");
    if (!Number.isInteger(run.scenario_version) || run.scenario_version < 1) errors.push("run.scenario_version must be a positive integer");
    if (!(typeof run.seed === "string" || (typeof run.seed === "number" && Number.isFinite(run.seed)))) errors.push("run.seed must be a string or finite number");
    if (!MODES.has(run.mode)) errors.push("run.mode must be counts|light|trace");
    if (run.metric_definition_version !== METRIC_DEFINITION_VERSION) errors.push(`run.metric_definition_version must be ${METRIC_DEFINITION_VERSION}`);
    if (run.collector_version !== COLLECTOR_VERSION) errors.push(`run.collector_version must be ${COLLECTOR_VERSION}`);
    if (typeof run.cache_state !== "string" || !run.cache_state.length) errors.push("run.cache_state required");
    else if (/cold/i.test(run.cache_state) === /warm/i.test(run.cache_state)) errors.push("run.cache_state must identify exactly one of cold or warm");
    if (!isPlainObject(run.sampling)) errors.push("run.sampling must be an object");
    else {
      for (const key of ["input_every_n", "frame_every_n"]) {
        if (!Number.isInteger(run.sampling[key]) || run.sampling[key] < 1) errors.push(`run.sampling.${key} must be a positive integer`);
      }
    }
    if (!isPlainObject(run.budgets)) errors.push("run.budgets must be an object");
    else {
      if (!isFiniteNonNegative(run.budgets.capture_seconds) || run.budgets.capture_seconds === 0) errors.push("run.budgets.capture_seconds must be > 0");
      if (!Number.isInteger(run.budgets.events_capacity) || run.budgets.events_capacity < 1) errors.push("run.budgets.events_capacity must be a positive integer");
    }
    const minimumOperations = document.status === "complete" ? 1 : 0;
    if (!Number.isInteger(run.expected_operations) || run.expected_operations < minimumOperations) {
      errors.push(`run.expected_operations must be an integer >= ${minimumOperations}`);
    }
    const manifest = run.fixture_manifest;
    checkFixtureManifest(manifest, errors);
    if (isPlainObject(manifest)) {
      if (run.scenario_id !== manifest.scenarioId) errors.push("run.scenario_id does not match fixture manifest");
      if (run.scenario_version !== manifest.version) errors.push("run.scenario_version does not match fixture manifest");
      if (String(run.seed) !== String(manifest.seed)) errors.push("run.seed does not match fixture manifest");
      const expectedHash = fixtureManifestSha256(manifest);
      if (run.fixture_manifest_sha256 !== expectedHash) errors.push("run.fixture_manifest_sha256 does not match canonical fixture manifest SHA-256");
    }
    if (run.mode === "trace") {
      const trace = run.trace ?? document.trace;
      if (!isPlainObject(trace)) errors.push("trace mode requires trace metadata");
      else if (!isFiniteNonNegative(trace.capture_seconds) || trace.capture_seconds === 0 || trace.capture_seconds > 30) {
        errors.push("trace.capture_seconds must be > 0 and <= 30");
      }
    }
  }
  checkBuild(document.build, errors, document.status);
  checkEnvironment(document.environment, errors);

  if (!isPlainObject(document.clock)) errors.push("clock must be an object");
  else {
    if (typeof document.clock.strategy !== "string" || document.clock.strategy.length === 0) errors.push("clock.strategy required");
    if (document.clock.sync_valid !== null && typeof document.clock.sync_valid !== "boolean") errors.push("clock.sync_valid must be boolean|null");
    if (document.clock.uncertainty_us !== null && document.clock.uncertainty_us !== undefined && !isFiniteNonNegative(document.clock.uncertainty_us)) {
      errors.push("clock.uncertainty_us must be finite and non-negative or null");
    }
  }

  const validity = document.validity;
  if (!isPlainObject(validity)) {
    errors.push("validity must be an object");
  } else {
    if (typeof validity.complete !== "boolean") errors.push("validity.complete must be boolean");
    if (!Array.isArray(validity.reason_codes) || validity.reason_codes.some((reason) => typeof reason !== "string")) errors.push("validity.reason_codes must be string[]");
    for (const key of ["events_dropped", "critical_endpoints_dropped"]) {
      if (!isFiniteNonNegative(validity[key])) errors.push(`validity.${key} must be finite and >= 0`);
    }
    if (typeof validity.probe_calibrated !== "boolean") errors.push("validity.probe_calibrated must be boolean");
  }

  const operations = document.operations;
  if (!Array.isArray(operations)) {
    errors.push("operations must be an array");
  } else {
    operations.forEach((operation, index) => checkOperation(operation, index, errors));
    const operationIds = new Set();
    operations.forEach((operation, index) => {
      if (typeof operation?.operation_id !== "string") return;
      if (operationIds.has(operation.operation_id)) errors.push(`operations[${index}].operation_id is duplicated`);
      operationIds.add(operation.operation_id);
    });
  }
  const unverifiedBuild = isPlainObject(document.build) && document.build.build_verified === false;
  if (!unverifiedBuild && Array.isArray(operations) && isPlainObject(run) && operations.length !== run.expected_operations) {
    errors.push("operations count does not match run.expected_operations");
  }

  if (!isPlainObject(document.metrics)) {
    errors.push("metrics must be an object");
  } else if (Array.isArray(operations)) {
    const operationMetrics = [...new Set(operations.map((operation) => operation?.metric).filter((metric) => typeof metric === "string"))].sort();
    const resultMetrics = Object.keys(document.metrics).sort();
    if (stableJson(operationMetrics) !== stableJson(resultMetrics)) errors.push("metric identities do not match raw operation metric identities");
    for (const [name, metric] of Object.entries(document.metrics)) {
      if (isPlainObject(run) && isPlainObject(validity)) checkMetric(metric, name, operations, run, document.status, validity, errors);
    }
  }

  if (document.status === "complete") {
    if (!isPlainObject(validity) || validity.complete !== true) errors.push("complete result requires validity.complete=true");
    if (Array.isArray(operations) && operations.some((operation) => !isPlainObject(operation) || operation.outcome !== "ok" || operation.target_verified !== true || !isFiniteNonNegative(operation.duration_ms))) {
      errors.push("complete result requires every operation to finish and verify its target");
    }
    if (isPlainObject(validity) && (validity.events_dropped !== 0 || validity.critical_endpoints_dropped !== 0)) errors.push("complete result cannot contain dropped events or endpoints");
  }

  if (!isPlainObject(document.structural)) errors.push("structural must be an object");
  else {
    for (const [key, value] of Object.entries(document.structural)) {
      if (value !== null && !Number.isFinite(value)) errors.push(`structural.${key} must be finite or null`);
    }
  }
  if (!isPlainObject(document.correctness)) errors.push("correctness must be an object");
  else {
    let failedCorrectness = false;
    for (const [key, value] of Object.entries(document.correctness)) {
      if (value !== null && typeof value !== "boolean") errors.push(`correctness.${key} must be boolean|null`);
      if (["target_frame_verified", "final_state_verified", "durable_final_revision_verified", "cancel_restored_editing_context"].includes(key) && value === false) failedCorrectness = true;
      if (key === "stale_frame_commits" && value === true) failedCorrectness = true;
    }
    if (failedCorrectness && document.status !== "invalid") errors.push("failed semantic correctness evidence requires result status invalid");
  }
  if (unverifiedBuild) {
    if (!isPlainObject(validity) || !Array.isArray(validity.reason_codes) || !validity.reason_codes.includes("unverified_build")) {
      errors.push("unverified build failure must include validity reason_code unverified_build");
    }
    if (isPlainObject(validity) && validity.complete !== false) errors.push("unverified build failure requires validity.complete=false");
    if (Array.isArray(operations) && operations.length > 0) errors.push("unverified build failure cannot contain measured operations");
    if (isPlainObject(document.metrics) && Object.keys(document.metrics).length > 0) errors.push("unverified build failure cannot contain performance metrics");
  }
  if (!isPlainObject(document.comparison)) errors.push("comparison must be an object");
  else {
    if (typeof document.comparison.status !== "string") errors.push("comparison.status must be a string");
    if (document.comparison.baseline_id !== null && typeof document.comparison.baseline_id !== "string") errors.push("comparison.baseline_id must be string|null");
    if (!Array.isArray(document.comparison.regressions)) errors.push("comparison.regressions must be an array");
  }
  if (!Array.isArray(document.artifacts)) errors.push("artifacts must be an array");
  return { valid: errors.length === 0, errors };
}

function identityProjection(document) {
  const { run, build, environment } = document;
  const comparableEnvironment = {
    electron: environment.electron,
    chrome: environment.chrome,
    os: environment.os,
    runner_class: environment.runner_class,
    cpu: environment.cpu,
    total_memory_bytes: environment.memory.total_bytes,
    gpu: environment.gpu,
    visible: environment.visible,
    focused: environment.focused,
    window_css_px: environment.window_css_px,
    window_content_dip_px: environment.window_content_dip_px,
    device_scale_factor: environment.device_scale_factor,
    refresh_hz_estimate: environment.refresh_hz_estimate ?? null,
    devtools_open: environment.devtools_open,
    capabilities: environment.capabilities,
    decode_backend: environment.decode_backend ?? null,
    parallel_decoder_available: environment.parallel_decoder_available ?? null,
    power_state: environment.power_state,
    load_state: environment.load_state,
    occlusion_state: environment.occlusion_state,
  };
  const metricIdentities = Object.keys(document.metrics).sort();
  return {
    schema: document.schema,
    metric_definition_version: document.metric_definition_version,
    collector_version: run.collector_version,
    scenario_id: run.scenario_id,
    scenario_version: run.scenario_version,
    seed: run.seed,
    fixture_manifest_sha256: run.fixture_manifest_sha256,
    fixture_manifest: run.fixture_manifest,
    mode: run.mode,
    sampling: run.sampling,
    budgets: run.budgets,
    cache_state: run.cache_state,
    expected_operations: run.expected_operations ?? null,
    cold_launches: run.cold_launches ?? null,
    build_type: build.build_type,
    environment: comparableEnvironment,
    trace: document.trace ?? run.trace ?? null,
    metric_identities: metricIdentities,
  };
}

/** Comparison identity without source/build digests, for safe baseline lookup. */
export function performanceComparisonIdentity(document) {
  return identityProjection(document);
}

/** Exact identity check for repeated samples within one run group.
 * Build digests and all run metadata stay fixed. Environment projection reuses
 * the comparison identity, which excludes only volatile free-RAM readings.
 */
export function performanceAggregationIdentityDifferences(first, candidate) {
  const ignoredRunKeys = new Set([
    "run_id",
    "repeat",
    "cold_launch_index",
    "cold_launches",
    "constituent_run_ids",
    "constituent_runs",
  ]);
  const stableRunMetadata = (document) => Object.fromEntries(
    Object.entries(document.run)
      .filter(([key]) => !ignoredRunKeys.has(key))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  const left = {
    comparison_identity: identityProjection(first),
    build: first.build,
    run: stableRunMetadata(first),
  };
  const right = {
    comparison_identity: identityProjection(candidate),
    build: candidate.build,
    run: stableRunMetadata(candidate),
  };
  return Object.keys(left).filter((key) => stableJson(left[key]) !== stableJson(right[key]));
}

function distributionsEligible(document) {
  return document.status === "complete" &&
    document.validity.complete &&
    document.validity.events_dropped === 0 &&
    document.validity.critical_endpoints_dropped === 0 &&
    document.validity.probe_calibrated === true &&
    document.environment.visible === true &&
    document.environment.focused === true &&
    document.environment.devtools_open === false &&
    document.environment.window_css_px !== null &&
    document.environment.window_content_dip_px !== null &&
    Object.values(document.metrics).every((metric) =>
      ["ok", "insufficient_samples"].includes(metric.status) && metric.n_censored === 0 && metric.n_failed === 0,
    );
}

function reportOnly(reason, extra = {}) {
  return { status: "report_only", reason, regressions: [], ...extra };
}

/** Compare only compatible, complete, probe-calibrated results; never enforces thresholds. */
export function compareResultDocuments(baseline, candidate, policy = "report-only") {
  if (policy !== "report-only") throw new TypeError("only --policy report-only is supported");
  const candidateCheck = validateResultDocument(candidate);
  if (!candidateCheck.valid) return reportOnly("invalid_candidate", { errors: candidateCheck.errors });
  if (!baseline) return reportOnly("baseline_missing");
  const baselineCheck = validateResultDocument(baseline);
  if (!baselineCheck.valid) return reportOnly("invalid_baseline", { errors: baselineCheck.errors });
  if (!distributionsEligible(baseline) || !distributionsEligible(candidate)) {
    const reason = !baseline.validity.probe_calibrated || !candidate.validity.probe_calibrated
      ? "probe_uncalibrated"
      : "invalid_or_incomplete_distribution";
    return reportOnly(reason, { baseline_id: baseline.run.run_id });
  }
  const left = identityProjection(baseline);
  const right = identityProjection(candidate);
  const incompatibleFields = Object.keys(left).filter((key) => stableJson(left[key]) !== stableJson(right[key]));
  if (incompatibleFields.length) return { status: "incompatible", reason: "identity_mismatch", fields: incompatibleFields, regressions: [] };

  const regressions = [];
  for (const name of Object.keys(baseline.metrics).sort()) {
    const base = baseline.metrics[name];
    const next = candidate.metrics[name];
    const cold = /cold/i.test(candidate.run.cache_state);
    for (const percentile of cold ? ["p50"] : ["p50", "p95", "p99"]) {
      const before = base[percentile];
      const after = next[percentile];
      if (typeof before !== "number" || typeof after !== "number" || before === 0) continue;
    regressions.push({
        metric: name,
        percentile,
        baseline_ms: before,
        candidate_ms: after,
        change_percent: ((after - before) / before) * 100,
      });
    }
  }
  return {
    status: "report_only",
    reason: regressions.length ? "compatible_results" : "no_comparable_quantiles",
    baseline_id: baseline.run.run_id,
    regressions,
  };
}

export function parseExactFlags(args, requiredFlags) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!flag.startsWith("--")) throw new Error(`unexpected argument: ${flag}`);
    if (!requiredFlags.includes(flag)) throw new Error(`unknown flag: ${flag}`);
    if (Object.hasOwn(parsed, flag)) throw new Error(`duplicate flag: ${flag}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    parsed[flag] = value;
    index += 1;
  }
  const missing = requiredFlags.filter((flag) => !Object.hasOwn(parsed, flag));
  if (missing.length) throw new Error(`missing required flag${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
  return parsed;
}

export async function readResultFile(filePath) {
  const { readFile } = await import("node:fs/promises");
  try {
    const contents = await readFile(filePath, "utf8");
    return { document: JSON.parse(contents), error: null };
  } catch (error) {
    if (error instanceof SyntaxError) return { document: null, error: "invalid_json" };
    if (error && typeof error === "object" && error.code === "ENOENT") return { document: null, error: "file_not_found" };
    throw error;
  }
}
