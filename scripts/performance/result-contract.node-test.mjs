import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  compareResultDocuments,
  fixtureManifestSha256,
  parseExactFlags,
  validateResultDocument,
} from "./result-contract.mjs";

const sha = "a".repeat(64);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function fixtureManifest(expectedOperations = 100) {
  return {
    schema: "reelterminal.performance-fixture/v1",
    scenarioId: "H02",
    version: 1,
    seed: "42",
    parameters: { clips: 500, timeline: "dense" },
    expectedSemantics: ["history_content_verified"],
    assets: [{ assetId: "font-1", kind: "synthetic-font-structure", mediaType: "font/woff2", byteLength: 128, sha256: sha }],
    requiredCapabilities: [],
    expectedOperations,
    timeBudgetMs: 60000,
  };
}

function result({ durationScale = 1, buildSha = sha, environment = {}, manifest, operationCount = 100, calibrated = true } = {}) {
  manifest ??= fixtureManifest(operationCount);
  const operations = Array.from({ length: operationCount }, (_, index) => ({
    operation_id: `op-${index}`,
    metric: "history_content_verified_ms",
    outcome: "ok",
    duration_ms: (index + 1) * durationScale,
    target_verified: true,
  }));
  const raw = operations.map((operation) => operation.duration_ms);
  const quantile = (fraction) => raw.length ? raw[Math.ceil(fraction * raw.length) - 1] : null;
  return {
    schema: "reelterminal.performance-result/v1",
    metric_definition_version: 1,
    example_only: false,
    status: "complete",
    run: {
      run_id: `run-${durationScale}`,
      scenario_id: manifest.scenarioId,
      scenario_version: manifest.version,
      seed: manifest.seed,
      fixture_manifest: manifest,
      fixture_manifest_sha256: fixtureManifestSha256(manifest),
      metric_definition_version: 1,
      collector_version: "p3-v1",
      mode: "light",
      sampling: { input_every_n: 1, frame_every_n: 1 },
      cache_state: "warm_profile",
      budgets: { capture_seconds: 30, events_capacity: 16384 },
      expected_operations: operationCount,
    },
    build: {
      source_head: "b".repeat(40),
      dirty: true,
      source_digest: sha,
      dirty_diff_digest: sha,
      lockfile_digest: sha,
      main_bundle_sha256: buildSha,
      preload_bundle_sha256: sha,
      renderer_manifest_sha256: sha,
      worker_manifest_sha256: sha,
      executable_sha256: sha,
      app_version: "1.1.1",
      build_type: "production",
      build_verified: true,
    },
    environment: {
      electron: "44.5.1",
      chrome: "140.0",
      os: { platform: "win32", release: "11.0", arch: "x64" },
      runner_class: "local",
      cpu: { model: "Example CPU", logical_cores: 8 },
      memory: { total_bytes: 32000000000, free_bytes: 16000000000 },
      gpu: { info_status: "available", devices: [], feature_status: { webgpu: "disabled" } },
      visible: true,
      focused: true,
      window_css_px: { width: 1280, height: 720 },
      window_content_dip_px: { width: 1280, height: 720 },
      device_scale_factor: 1,
      refresh_hz_estimate: 60,
      devtools_open: false,
      decode_backend: null,
      parallel_decoder_available: null,
      capabilities: {
        webgpu: false,
        wasm: true,
        shared_array_buffer: true,
        hardware_concurrency: 8,
        device_memory_gb: 16,
      },
      power_state: "unknown",
      load_state: "unknown",
      occlusion_state: "unknown",
      ...environment,
    },
    clock: { strategy: "local_monotonic_us_with_bounded_sync", sync_valid: null, uncertainty_us: null },
    validity: {
      complete: true,
      reason_codes: [],
      events_dropped: 0,
      critical_endpoints_dropped: 0,
      probe_calibrated: calibrated,
    },
    operations,
    metrics: {
      history_content_verified_ms: {
        status: operationCount >= 100 ? "ok" : "insufficient_samples",
        n_requested: operationCount,
        n_completed: operationCount,
        n_censored: 0,
        n_failed: 0,
        median_ms: quantile(0.5),
        min: raw[0],
        max: raw.at(-1),
        p50: quantile(0.5),
        p95: operationCount >= 20 ? quantile(0.95) : null,
        p99: operationCount >= 100 ? quantile(0.99) : null,
        raw_ms: raw,
        quantile_method: "nearest_rank",
      },
    },
    structural: {},
    correctness: { target_frame_verified: true },
    comparison: { status: "baseline_missing", baseline_id: null, regressions: [] },
    artifacts: [],
  };
}

test("strict result validation checks the canonical manifest and raw metric identity", () => {
  const document = result();
  assert.equal(validateResultDocument(document).valid, true);
  const tamperedManifest = structuredClone(document);
  tamperedManifest.run.fixture_manifest.assets[0].sha256 = "c".repeat(64);
  assert.match(validateResultDocument(tamperedManifest).errors.join(" "), /canonical fixture manifest SHA-256/);
  const changedMetric = structuredClone(document);
  changedMetric.metrics.other_metric = structuredClone(changedMetric.metrics.history_content_verified_ms);
  assert.match(validateResultDocument(changedMetric).errors.join(" "), /metric identities do not match/);
});

test("compatible result comparison records deltas while allowing candidate build digests to change", () => {
  const baseline = result({ durationScale: 1, buildSha: "a".repeat(64) });
  const candidate = result({
    durationScale: 2,
    buildSha: "d".repeat(64),
    environment: { memory: { total_bytes: 32000000000, free_bytes: 12000000000 } },
  });
  const comparison = compareResultDocuments(baseline, candidate);
  assert.equal(comparison.status, "report_only");
  assert.equal(comparison.reason, "compatible_results");
  assert.equal(comparison.regressions[0].change_percent, 100);
});

test("warm quick runs report comparable p95 while withholding under-sampled p99", () => {
  const baseline = result({ operationCount: 25, durationScale: 1 });
  const candidate = result({ operationCount: 25, durationScale: 2 });
  const validation = validateResultDocument(baseline);
  assert.equal(validation.valid, true, validation.errors.join(" "));
  assert.equal(baseline.metrics.history_content_verified_ms.p99, null);
  const comparison = compareResultDocuments(baseline, candidate);
  assert.equal(comparison.reason, "compatible_results");
  assert.deepEqual(comparison.regressions.map(({ percentile }) => percentile), ["p50", "p95"]);
});

test("fixture assets and window identity mismatches are incompatible without percentages", () => {
  const baseline = result();
  const changedManifest = fixtureManifest();
  changedManifest.assets[0].sha256 = "c".repeat(64);
  const assetCandidate = result({ manifest: changedManifest });
  const assetComparison = compareResultDocuments(baseline, assetCandidate);
  assert.equal(assetComparison.status, "incompatible");
  assert.ok(assetComparison.fields.includes("fixture_manifest"));
  assert.deepEqual(assetComparison.regressions, []);

  const windowCandidate = result({ environment: { window_css_px: { width: 1280, height: 800 } } });
  const windowComparison = compareResultDocuments(baseline, windowCandidate);
  assert.equal(windowComparison.status, "incompatible");
  assert.deepEqual(windowComparison.regressions, []);

  const capabilityCandidate = result({
    environment: {
      capabilities: {
        webgpu: true,
        wasm: true,
        shared_array_buffer: true,
        hardware_concurrency: 8,
        device_memory_gb: 16,
      },
    },
  });
  const capabilityComparison = compareResultDocuments(baseline, capabilityCandidate);
  assert.equal(capabilityComparison.status, "incompatible");
  assert.deepEqual(capabilityComparison.regressions, []);
});

test("invalid, missing-baseline, and uncalibrated results remain report-only without deltas", () => {
  const baseline = result();
  const invalidCandidate = result();
  delete invalidCandidate.run.fixture_manifest;
  const invalidComparison = compareResultDocuments(baseline, invalidCandidate);
  assert.equal(invalidComparison.status, "report_only");
  assert.equal(invalidComparison.reason, "invalid_candidate");
  assert.deepEqual(invalidComparison.regressions, []);

  const missingBaseline = compareResultDocuments(null, baseline);
  assert.equal(missingBaseline.reason, "baseline_missing");
  assert.deepEqual(missingBaseline.regressions, []);

  const uncalibrated = compareResultDocuments(baseline, result({ calibrated: false }));
  assert.equal(uncalibrated.reason, "probe_uncalibrated");
  assert.deepEqual(uncalibrated.regressions, []);
});

test("setup failure can retain zero actual operations without fabricating timeout samples", () => {
  const artifact = result();
  artifact.status = "invalid";
  artifact.validity.complete = false;
  artifact.validity.reason_codes = ["setup_failed"];
  artifact.run.expected_operations = 0;
  artifact.operations = [];
  artifact.metrics = {};
  assert.equal(validateResultDocument(artifact).valid, true);
  artifact.status = "complete";
  artifact.validity.complete = true;
  assert.equal(validateResultDocument(artifact).valid, false);
});

test("an unverified build failure artifact is valid when it contains no measured operations", () => {
  const artifact = result();
  artifact.status = "invalid";
  artifact.build.build_type = null;
  artifact.build.build_verified = false;
  artifact.build.build_reason = "stamp_missing";
  artifact.build.source_head = null;
  artifact.build.dirty = null;
  artifact.build.source_digest = null;
  artifact.build.dirty_diff_digest = null;
  artifact.build.lockfile_digest = null;
  artifact.build.main_bundle_sha256 = null;
  artifact.build.preload_bundle_sha256 = null;
  artifact.build.renderer_manifest_sha256 = null;
  artifact.build.worker_manifest_sha256 = null;
  artifact.build.executable_sha256 = null;
  artifact.build.app_version = null;
  artifact.validity.complete = false;
  artifact.validity.reason_codes = ["unverified_build"];
  artifact.operations = [];
  artifact.metrics = {};

  const validation = validateResultDocument(artifact);
  assert.equal(validation.valid, true, validation.errors.join(" "));
  const comparison = compareResultDocuments(result(), artifact);
  assert.equal(comparison.status, "report_only");
  assert.deepEqual(comparison.regressions, []);
});

test("a failed durable-readback assertion invalidates otherwise completed performance samples", () => {
  const candidate = result();
  candidate.status = "invalid";
  candidate.correctness.durable_final_revision_verified = false;
  candidate.validity.complete = false;
  candidate.validity.reason_codes = ["correctness_verification_failed"];
  const metric = candidate.metrics.history_content_verified_ms;
  metric.status = "failed";
  metric.median_ms = null;
  metric.min = null;
  metric.max = null;
  metric.p50 = null;
  metric.p95 = null;
  metric.p99 = null;

  const validation = validateResultDocument(candidate);
  assert.equal(validation.valid, true, validation.errors.join(" "));
  const comparison = compareResultDocuments(result(), candidate);
  assert.equal(comparison.status, "report_only");
  assert.deepEqual(comparison.regressions, []);
});

test("offline CLI flag parser rejects unknown, duplicate, and missing values", () => {
  assert.deepEqual(parseExactFlags(["--file", "run.json"], ["--file"]), { "--file": "run.json" });
  assert.throws(() => parseExactFlags(["--file", "run.json", "--extra", "x"], ["--file"]), /unknown flag/);
  assert.throws(() => parseExactFlags(["--file", "one.json", "--file", "two.json"], ["--file"]), /duplicate flag/);
  assert.throws(() => parseExactFlags(["--file"], ["--file"]), /missing value/);
});

test("validate and compare CLIs read result files and keep missing baselines report-only", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "reelterminal-perf-contract-"));
  try {
    const candidatePath = path.join(tempDir, "candidate.json");
    writeFileSync(candidatePath, JSON.stringify(result()), "utf8");
    const validate = spawnSync(process.execPath, [
      path.join(scriptDir, "validate-result.mjs"),
      "--file",
      candidatePath,
    ], { encoding: "utf8" });
    assert.equal(validate.status, 0, validate.stderr);
    assert.equal(JSON.parse(validate.stdout).valid, true);

    const compare = spawnSync(process.execPath, [
      path.join(scriptDir, "compare.mjs"),
      "--baseline",
      path.join(tempDir, "missing-baseline.json"),
      "--candidate",
      candidatePath,
      "--policy",
      "report-only",
    ], { encoding: "utf8" });
    assert.equal(compare.status, 0, compare.stderr);
    assert.equal(JSON.parse(compare.stdout).reason, "baseline_missing");
    assert.deepEqual(JSON.parse(compare.stdout).regressions, []);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
