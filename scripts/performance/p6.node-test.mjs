import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fixtureManifestSha256 } from "./result-contract.mjs";
import { readActionWindows, runKey } from "./p6-support.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const baselineCli = path.join(here, "manage-baseline.mjs");
const reportCli = path.join(here, "ci-report.mjs");
const sha = "a".repeat(64);

test("stability reporting needs no calibration and never claims performance qualification, while correctness still fails", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "reelterminal-stability-report-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runs = fixtureDirectory(root, "runs");
  const result = performanceResult({ runId: "stability", durationScale: 100 });
  writeResult(runs, result);
  const output = path.join(root, "report.json");
  const markdown = path.join(root, "report.md");
  const args = ["--directory", runs, "--purpose", "stability", "--policy", "report-only", "--fixed-runner", "false", "--json", output, "--markdown", markdown];
  assert.equal(runCli(reportCli, args).status, 0);
  const report = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(report.status, "stability_passed");
  assert.equal(report.performance_qualified, false);
  assert.equal(report.calibration.input_count, 0);
  assert.equal(report.runs[0].comparison.status, "stability_verified");
  assert.deepEqual(report.runs[0].comparison.metrics, []);
  assert.match(readFileSync(markdown, "utf8"), /No performance qualification/);
  result.correctness.target_frame_verified = false;
  writeResult(runs, result);
  assert.equal(runCli(reportCli, args).status, 1);
  assert.equal(JSON.parse(readFileSync(output, "utf8")).status, "failed");
});

function fixtureManifest(scenarioId = "H02") {
  return {
    schema: "reelterminal.performance-fixture/v1",
    scenarioId,
    version: 1,
    seed: "42",
    parameters: { clips: 500, timeline: "dense" },
    expectedSemantics: ["history_content_verified"],
    assets: [{ assetId: "fixture-asset", kind: "synthetic-media", mediaType: "video/mp4", byteLength: 32, sha256: sha }],
    requiredCapabilities: [],
    expectedOperations: 25,
    timeBudgetMs: 30_000,
  };
}

function performanceResult({ runId, repeat = 0, durationScale = 1, mode = "light", scenarioId = "H02", hidden = false, dropped = 0 } = {}) {
  const manifest = fixtureManifest(scenarioId);
  const operations = Array.from({ length: 25 }, (_, index) => ({
    operation_id: `operation-${index}`,
    metric: "history_content_verified_ms",
    outcome: "ok",
    duration_ms: (index + 1) * durationScale,
    target_verified: true,
  }));
  const raw = operations.map((operation) => operation.duration_ms);
  const quantile = (fraction) => raw[Math.ceil(fraction * raw.length) - 1];
  const report = {
    status: dropped ? "incomplete" : "complete",
    wallDurationUs: 120_000,
    events: [],
    criticalEvents: [],
    counters: {},
    drops: { eventsDropped: dropped, criticalEndpointsDropped: 0, samplesDropped: 0, labelsDropped: 0, truncatedFields: 0 },
    observerCapabilities: { longTask: "supported", eventTiming: "unsupported" },
    strandedSpans: 0,
    openSpans: 0,
    collectorErrors: 0,
  };
  return {
    schema: "reelterminal.performance-result/v1",
    example_only: false,
    metric_definition_version: 1,
    status: "complete",
    run: {
      run_id: runId,
      scenario_id: scenarioId,
      scenario_version: 1,
      seed: "42",
      fixture_manifest: manifest,
      fixture_manifest_sha256: fixtureManifestSha256(manifest),
      metric_definition_version: 1,
      collector_version: "p3-v1",
      mode,
      sampling: { input_every_n: 1, frame_every_n: 1 },
      cache_state: "warm_fixed_profile",
      budgets: { capture_seconds: 30, events_capacity: 16384 },
      expected_operations: operations.length,
      repeat,
      ...(mode === "trace" ? { trace: { capture_seconds: 10 } } : {}),
    },
    build: {
      source_head: "b".repeat(40),
      dirty: false,
      source_digest: sha,
      dirty_diff_digest: sha,
      lockfile_digest: sha,
      main_bundle_sha256: sha,
      preload_bundle_sha256: sha,
      renderer_manifest_sha256: sha,
      worker_manifest_sha256: sha,
      executable_sha256: sha,
      app_version: "1.0.0",
      build_type: "production",
      build_verified: true,
    },
    environment: {
      electron: "44.5.1",
      chrome: "140.0",
      os: { platform: "win32", release: "11.0", arch: "x64" },
      runner_class: "ci",
      cpu: { model: "Test CPU", logical_cores: 8 },
      memory: { total_bytes: 32_000_000_000, free_bytes: 16_000_000_000 },
      gpu: { info_status: "available", devices: [], feature_status: { webgpu: "disabled" } },
      visible: scenarioId === "E01" ? null : true,
      focused: scenarioId === "E01" ? null : true,
      window_css_px: { width: 1280, height: 720 },
      window_content_dip_px: { width: 1280, height: 720 },
      device_scale_factor: 1,
      refresh_hz_estimate: 60,
      devtools_open: scenarioId === "E01" ? null : false,
      decode_backend: null,
      parallel_decoder_available: null,
      capabilities: { webgpu: false, wasm: true, shared_array_buffer: true, hardware_concurrency: 8, device_memory_gb: 16 },
      power_state: "unknown",
      load_state: "unknown",
      occlusion_state: "unknown",
    },
    clock: { strategy: "local_monotonic_us_with_bounded_sync", sync_valid: null, uncertainty_us: null },
    validity: { complete: true, reason_codes: [], events_dropped: 0, critical_endpoints_dropped: 0, probe_calibrated: false },
    operations,
    metrics: {
      history_content_verified_ms: {
        status: "insufficient_samples",
        n_requested: operations.length,
        n_completed: operations.length,
        n_censored: 0,
        n_failed: 0,
        median_ms: quantile(0.5),
        min: raw[0],
        max: raw.at(-1),
        p50: quantile(0.5),
        p95: quantile(0.95),
        p99: null,
        raw_ms: raw,
        quantile_method: "nearest_rank",
      },
    },
    structural: {},
    correctness: scenarioId === "E01"
      ? {
        fixed_input_immutable_verified: true,
        progress_status_persisted_verified: true,
        successful_export_verified: true,
        failed_export_cleanup_verified: true,
        cancellation_cleanup_verified: true,
      }
      : { target_frame_verified: true, final_state_verified: true },
    comparison: { status: "baseline_missing", baseline_id: null, regressions: [] },
    artifacts: [],
    ...(hidden ? { action_windows: [{ hiddenDuringAction: true, report, main: { ok: true, mainCapture: { status: "complete" } } }] } : {}),
    ...(dropped ? { action_windows: [{ hiddenDuringAction: false, report, main: { ok: true, mainCapture: { status: "complete" } } }] } : {}),
  };
}

function calibration() {
  const runs = [];
  for (let block = 0; block < 5; block += 1) {
    for (const mode of ["off", "light", "light", "off"]) {
      runs.push({
        mode,
        durationMs: mode === "off" ? 100 : 101,
        taskSeconds: 0.1,
        heapBytesBefore: 1_000,
        heapBytesAfter: 1_100,
        rssBytes: 10_000,
        exportMs: 1,
        events: mode === "off" ? 0 : 24,
      });
    }
  }
  return {
    schema: "reelterminal.probe-calibration/v1",
    status: "qualified",
    build: performanceResult({ runId: "calibration" }).build,
    environment: performanceResult({ runId: "environment" }).environment,
    runs,
    comparison: {
      offMedianMs: 100,
      lightMedianMs: 101,
      toleranceMs: 30,
      overheadPercent: 1,
      method: "five_ABBA_blocks_same_instance_six_real_gestures",
    },
    controls: {
      blocking: {
        status: "complete",
        observerCapabilities: { longTask: "supported" },
        events: [{ phase: "main.longtask", kind: "sample", dims: { durationMs: 80 } }],
        criticalEvents: [],
        drops: { eventsDropped: 0, criticalEndpointsDropped: 0, samplesDropped: 0, labelsDropped: 0, truncatedFields: 0 },
      },
      async: {
        report: {
          status: "complete",
          wallDurationUs: 150_000,
          drops: { eventsDropped: 0, criticalEndpointsDropped: 0, samplesDropped: 0, labelsDropped: 0, truncatedFields: 0 },
        },
        taskMs: 12,
      },
    },
  };
}

function fixtureDirectory(root, name) {
  const directory = path.join(root, name);
  mkdirSync(directory, { recursive: true });
  return directory;
}

function writeResult(directory, result, name = `${result.run.run_id}.result.json`) {
  const file = path.join(directory, name);
  writeFileSync(file, JSON.stringify(result, null, 2));
  return file;
}

function runCli(script, args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

test("baseline proposal requires three same-build qualified runs and CI reports run-level warnings safely", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "reelterminal-p6-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const baselineRuns = fixtureDirectory(root, "baseline-runs");
  const candidateRuns = fixtureDirectory(root, "candidate-runs");
  const calibrationFile = path.join(root, "probe-calibration.json");
  const proposalFile = path.join(root, "proposal.json");
  const acceptedFile = path.join(root, "accepted.json");
  writeFileSync(calibrationFile, JSON.stringify(calibration()));
  for (let repeat = 0; repeat < 3; repeat++) {
    writeResult(baselineRuns, performanceResult({ runId: `base-${repeat}`, repeat }));
  }

  const proposalCommand = runCli(baselineCli, [
    "--directory", baselineRuns,
    "--calibration", calibrationFile,
    "--fixed-runner", "true",
    "--reason", "initial stable synthetic baseline",
    "--output", proposalFile,
  ]);
  assert.equal(proposalCommand.status, 0, proposalCommand.stderr);
  const proposal = JSON.parse(readFileSync(proposalFile, "utf8"));
  assert.equal(proposal.status, "proposal");
  assert.equal(proposal.proposal.state, "ready_for_review");
  assert.equal(proposal.groups.length, 1);
  assert.equal(proposal.groups[0].runs.length, 3);
  assert.equal("operations" in proposal.groups[0].runs[0], false);

  proposal.status = "ready";
  proposal.review = { accepted_by: "test-reviewer", accepted_at: new Date().toISOString(), reason: "reviewed synthetic baseline" };
  writeFileSync(acceptedFile, JSON.stringify(proposal));
  writeResult(candidateRuns, performanceResult({ runId: "candidate-0", durationScale: 2 }));
  const reportFile = path.join(root, "report.json");
  const markdownFile = path.join(root, "report.md");
  const reportCommand = runCli(reportCli, [
    "--directory", candidateRuns,
    "--baseline", acceptedFile,
    "--calibration", calibrationFile,
    "--policy", "warning",
    "--fixed-runner", "true",
    "--json", reportFile,
    "--markdown", markdownFile,
  ]);
  assert.equal(reportCommand.status, 0, reportCommand.stderr);
  const report = JSON.parse(readFileSync(reportFile, "utf8"));
  assert.equal(report.status, "warning");
  assert.equal(report.runs[0].comparison.status, "warning");
  assert.equal(report.runs[0].comparison.metrics[0].percentile, "p95");
  assert.equal(report.runs[0].calibration.matched, true);
  assert.equal(report.runs[0].validity.source_probe_calibrated, false);
  assert.equal("operation_id" in report.runs[0].operations[0], false);
  assert.doesNotMatch(JSON.stringify(report), /operation-0|Test CPU|C:\\|error message/i);
  assert.match(readFileSync(markdownFile, "utf8"), /duration regression warning|Hard failures|warning/i);
});

test("proposal stays pending without fixed runner or three qualified same-build runs", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "reelterminal-p6-pending-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runs = fixtureDirectory(root, "runs");
  const calibrationFile = path.join(root, "probe-calibration.json");
  writeFileSync(calibrationFile, JSON.stringify(calibration()));
  writeResult(runs, performanceResult({ runId: "one-run" }));
  const output = path.join(root, "proposal.json");
  const command = runCli(baselineCli, [
    "--directory", runs,
    "--calibration", calibrationFile,
    "--fixed-runner", "true",
    "--reason", "should remain pending",
    "--output", output,
  ]);
  assert.equal(command.status, 0, command.stderr);
  const proposal = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(proposal.proposal.state, "pending");
  assert.deepEqual(proposal.groups, []);
  assert.equal(proposal.pending_groups[0].qualified_run_count, 1);

  const noFixedOutput = path.join(root, "no-fixed.json");
  const noFixedCommand = runCli(baselineCli, [
    "--directory", runs,
    "--calibration", calibrationFile,
    "--fixed-runner", "false",
    "--reason", "hosted runner cannot calibrate",
    "--output", noFixedOutput,
  ]);
  assert.equal(noFixedCommand.status, 0, noFixedCommand.stderr);
  assert.equal(JSON.parse(readFileSync(noFixedOutput, "utf8")).proposal.state, "pending");
});

test("a qualified label cannot bypass corrupted ABBA calibration measurements", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "reelterminal-p6-calibration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runs = fixtureDirectory(root, "runs");
  const calibrationFile = path.join(root, "probe-calibration.json");
  const output = path.join(root, "proposal.json");
  const corrupted = calibration();
  corrupted.runs[0].mode = "light";
  writeFileSync(calibrationFile, JSON.stringify(corrupted));
  for (let repeat = 0; repeat < 3; repeat++) writeResult(runs, performanceResult({ runId: `run-${repeat}`, repeat }));

  const command = runCli(baselineCli, [
    "--directory", runs,
    "--calibration", calibrationFile,
    "--fixed-runner", "true",
    "--reason", "reject altered calibration evidence",
    "--output", output,
  ]);
  assert.equal(command.status, 0, command.stderr);
  const proposal = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(proposal.proposal.state, "pending");
  assert.equal(proposal.groups.length, 0);
  assert.ok(proposal.excluded.every((item) => item.reason_codes.includes("calibration_controls_invalid")));
});

test("accepted proposal retains no more than twenty qualified runs per group", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "reelterminal-p6-retention-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runs = fixtureDirectory(root, "runs");
  const calibrationFile = path.join(root, "probe-calibration.json");
  const output = path.join(root, "proposal.json");
  writeFileSync(calibrationFile, JSON.stringify(calibration()));
  for (let repeat = 0; repeat < 21; repeat++) writeResult(runs, performanceResult({ runId: `run-${repeat}`, repeat }));

  const command = runCli(baselineCli, [
    "--directory", runs,
    "--calibration", calibrationFile,
    "--fixed-runner", "true",
    "--reason", "review the retained stable sample set",
    "--output", output,
  ]);
  assert.equal(command.status, 0, command.stderr);
  const proposal = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(proposal.groups[0].runs.length, 20);
  assert.equal(proposal.groups[0].runs.some((run) => run.run_key === runKey("run-0")), false);
  assert.equal(proposal.groups[0].runs.some((run) => run.run_key === runKey("run-20")), true);
});

test("CI keeps duration report-only without calibration and hard-fails hidden or dropped action evidence", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "reelterminal-p6-gates-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runs = fixtureDirectory(root, "runs");
  const missingCalibration = path.join(root, "missing-calibration");
  const output = path.join(root, "report.json");
  const markdown = path.join(root, "report.md");
  writeResult(runs, performanceResult({ runId: "hidden-run", hidden: true }));
  const command = runCli(reportCli, [
    "--directory", runs,
    "--calibration", missingCalibration,
    "--policy", "warning",
    "--fixed-runner", "true",
    "--json", output,
    "--markdown", markdown,
  ]);
  assert.equal(command.status, 1);
  const report = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(report.policy.effective, "warning");
  assert.equal(report.runs[0].comparison.status, "hard_failure");
  assert.ok(report.runs[0].hard_failures.includes("window_hidden"));

  const emptyRoot = path.join(root, "does-not-exist");
  const emptyOutput = path.join(root, "empty.json");
  const emptyMarkdown = path.join(root, "empty.md");
  const emptyCommand = runCli(reportCli, [
    "--directory", emptyRoot,
    "--policy", "report-only",
    "--fixed-runner", "false",
    "--json", emptyOutput,
    "--markdown", emptyMarkdown,
  ]);
  assert.equal(emptyCommand.status, 1);
  const emptyReport = JSON.parse(readFileSync(emptyOutput, "utf8"));
  assert.equal(emptyReport.counts.results, 0);
  assert.equal(emptyReport.status, "failed");
  assert.ok(emptyReport.collection_errors.includes("artifact_directory_missing"));
});

test("a missing baseline is explicit and report-only without weakening correctness failures", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "reelterminal-p6-missing-baseline-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runs = fixtureDirectory(root, "runs");
  const calibrationFile = path.join(root, "probe-calibration.json");
  const output = path.join(root, "report.json");
  const markdown = path.join(root, "report.md");
  writeFileSync(calibrationFile, JSON.stringify(calibration()));
  const result = performanceResult({ runId: "no-baseline" });
  writeResult(runs, result);
  const args = ["--directory", runs, "--baseline", path.join(root, "missing.json"),
    "--calibration", calibrationFile, "--policy", "report-only", "--fixed-runner", "false",
    "--json", output, "--markdown", markdown];
  assert.equal(runCli(reportCli, args).status, 0);
  const report = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(report.baseline.status, "missing");
  assert.equal(report.status, "report_only");
  assert.equal(report.performance_qualified, false);
  assert.deepEqual(report.runs[0].comparison.reason_codes, ["baseline_missing"]);
  assert.match(readFileSync(markdown, "utf8"), /No accepted baseline: timings are report-only/);
  result.correctness.target_frame_verified = false;
  writeResult(runs, result);
  assert.equal(runCli(reportCli, args).status, 1);
  assert.equal(JSON.parse(readFileSync(output, "utf8")).status, "failed");
});

test("renderer calibration never applies to E01 and a fake-backend result remains report-only", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "reelterminal-p6-export-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runs = fixtureDirectory(root, "runs");
  const calibrationFile = path.join(root, "probe-calibration.json");
  const output = path.join(root, "report.json");
  const markdown = path.join(root, "report.md");
  writeFileSync(calibrationFile, JSON.stringify(calibration()));
  writeResult(runs, performanceResult({ runId: "fake-export", scenarioId: "E01" }));
  const command = runCli(reportCli, [
    "--directory", runs,
    "--calibration", calibrationFile,
    "--policy", "warning",
    "--fixed-runner", "true",
    "--json", output,
    "--markdown", markdown,
  ]);
  assert.equal(command.status, 0, command.stderr);
  const report = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(report.runs[0].comparison.status, "report_only");
  assert.deepEqual(report.runs[0].comparison.reason_codes, ["calibration_unavailable_non_renderer"]);
  assert.deepEqual(report.runs[0].hard_failures, []);
});

test("cold summary constituent action-window references are read and validated against the child run", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "reelterminal-p6-cold-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = fixtureDirectory(root, "runs");
  const actionWindow = {
    hiddenDuringAction: false,
    report: {
      status: "complete",
      wallDurationUs: 120_000,
      events: [],
      counters: {},
      drops: { eventsDropped: 0, criticalEndpointsDropped: 0, samplesDropped: 0, labelsDropped: 0, truncatedFields: 0 },
    },
    main: { ok: true, mainCapture: { status: "complete", eventsDropped: 0, labelsDropped: 0, spansDropped: 0, truncatedFields: 0, collectorErrors: 0, openSpans: 0 } },
  };
  const child = performanceResult({ runId: "cold-child" });
  child.action_windows = [actionWindow];
  writeResult(directory, child);
  const summary = performanceResult({ runId: "cold-summary" });
  summary.run.constituent_runs = [{ run_id: child.run.run_id, action_windows: { artifact: "cold-child.result.json", field: "action_windows" } }];
  const summaryFile = writeResult(directory, summary);
  const loaded = await readActionWindows(summary, summaryFile);
  assert.equal(loaded.present, true);
  assert.equal(loaded.error, null);
  assert.equal(loaded.windows.length, 1);

  summary.run.constituent_runs[0].action_windows.artifact = "missing-child.result.json";
  const missing = await readActionWindows(summary, summaryFile);
  assert.equal(missing.error, "constituent_action_windows_missing");
});

test("trace and incomplete artifacts never enter baseline proposals; proposal is rejected for comparison", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "reelterminal-p6-exclusions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runs = fixtureDirectory(root, "runs");
  const calibrationFile = path.join(root, "probe-calibration.json");
  const output = path.join(root, "proposal.json");
  writeFileSync(calibrationFile, JSON.stringify(calibration()));
  writeResult(runs, performanceResult({ runId: "trace-run", mode: "trace" }));
  writeResult(runs, performanceResult({ runId: "dropped-run", dropped: 1 }));
  const command = runCli(baselineCli, [
    "--directory", runs,
    "--calibration", calibrationFile,
    "--fixed-runner", "true",
    "--reason", "verify exclusion rules",
    "--output", output,
  ]);
  assert.equal(command.status, 0, command.stderr);
  const proposal = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(proposal.groups.length, 0);
  assert.ok(proposal.excluded.some((item) => item.reason_codes.includes("trace_mode_not_baseline")));
  assert.ok(proposal.excluded.some((item) => item.reason_codes.includes("action_capture_incomplete")));

  const reportPath = path.join(root, "proposal-rejected.json");
  const markdownPath = path.join(root, "proposal-rejected.md");
  writeResult(fixtureDirectory(root, "candidate"), performanceResult({ runId: "candidate" }));
  const reportCommand = runCli(reportCli, [
    "--directory", path.join(root, "candidate"),
    "--baseline", output,
    "--calibration", calibrationFile,
    "--policy", "warning",
    "--fixed-runner", "true",
    "--json", reportPath,
    "--markdown", markdownPath,
  ]);
  assert.equal(reportCommand.status, 1);
  const rejectedReport = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(rejectedReport.baseline.status, "invalid");
  assert.ok(rejectedReport.baseline.errors.includes("baseline_not_accepted"));
});
