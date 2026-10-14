import assert from "node:assert/strict";
import test from "node:test";
import { hostedPlan, resourceEvidence, calibrationEvidence, stabilityCompletion } from "./hosted.mjs";
import { runKey } from "./p6-support.mjs";
import { runTimeoutMs } from "./run-options.mjs";

test("hosted profiles reserve installation/build headroom within a 210-minute job", () => {
  for (const profile of ["smoke", "stress", "stability-smoke", "stability"]) {
    const plan = hostedPlan(profile);
    assert.ok(plan.reduce((ms, command) => ms + runTimeoutMs(command.options), 0) < 180 * 60_000);
    assert.ok(plan.every(command => command.options.repeats === 1));
  }
  assert.throws(() => hostedPlan("all"));
});

test("stability profiles reuse the original workloads without changing performance profiles", () => {
  assert.deepEqual(hostedPlan("stability-smoke"), hostedPlan("smoke"));
  assert.deepEqual(hostedPlan("stability"), hostedPlan("stress"));
});

test("stability coverage rejects missing results, wrong commits, partial soaks and false correctness", () => {
  const record = { commit: "a".repeat(40), commands: hostedPlan("stability").map(command => ({ ...command, status: "passed" })) };
  const documents = record.commands.flatMap(command => command.options.scenarios.map((scenario, index) => ({
    status: "complete", validity: { complete: true }, build: { source_head: record.commit },
    run: { run_id: `${scenario}-${command.options.nodeCount}-${index}`, scenario_id: scenario,
      fixture_manifest: { parameters: { nodeCount: command.options.nodeCount, clipCount: command.options.clipCount, trackCount: command.options.trackCount } },
      completed_rounds: scenario === "R01" ? 500 : 1600, requested_duration_seconds: 1800, elapsed_ms: 1800100 },
    history_saturation: { capacity: 1000, edits: 1001, plateauCounts: Array(10).fill(1000) },
    operations: [{ outcome: "ok" }], correctness: { undo_redo_full_state_verified: true, target_frame_verified: true },
  })));
  const report = { purpose: "stability", status: "stability_passed", counts: { hard_failures: 0, results: 7 },
    runs: documents.map(document => ({ run_key: runKey(document.run.run_id), comparison: { status: "stability_verified" }, hard_failures: [] })) };
  const check = () => stabilityCompletion(record, documents, report);
  assert.equal(check().status, "passed");
  assert.deepEqual(check().counts, { passed: 7, failed: 0, not_run: 0 });
  assert.equal(check().performance_qualified, false);
  const saturated = documents.find(document => document.run.scenario_id === "R02");
  saturated.history_saturation.edits = 20;
  assert.equal(check().status, "passed"); // Pre-existing undo entries can need fewer edits.
  saturated.history_saturation.plateauCounts[0] = 999;
  assert.equal(check().counts.failed, 1);
  saturated.history_saturation.plateauCounts[0] = 1000;
  const soak = documents.find(document => document.run.scenario_id === "R02");
  soak.run.elapsed_ms = 1799999;
  assert.equal(check().status, "failed");
  assert.equal(check().counts.failed, 1);
  soak.run.elapsed_ms = 1800100;
  documents[0].build.source_head = "b".repeat(40);
  assert.equal(check().counts.failed, 1);
  documents[0].build.source_head = record.commit;
  report.runs[0].comparison.status = "hard_failure";
  report.runs[0].hard_failures = ["correctness_failed"];
  assert.equal(check().counts.failed, 1);
  documents.pop();
  assert.equal(check().counts.not_run, 1);
});

test("representative soak stays continuous for 30 minutes after real history saturation", () => {
  const options = hostedPlan("stress").find(command => command.options.scenarios.includes("R02")).options;
  assert.equal(options.durationSeconds, 1800);
  assert.equal(options.saturateHistory, true);
  assert.ok(options.runTimeoutSeconds >= options.durationSeconds + 600);
});

test("resource projection omits arbitrary strings, paths and credentials", () => {
  const secret = "private/path/token";
  const result = resourceEvidence({ retained_profile: secret, last_capture: { status: "incomplete", reasonCodes: ["spans_left_open", secret], mainStatus: "incomplete", mainReasonCodes: ["main_spans_left_open", secret], token: secret }, run: { scenario_id: "R02", completed_rounds: 50, elapsed_ms: 1800000 }, history_saturation: { capacity: 1000, token: secret }, idle_samples: [{ heap_bytes: 42, path: secret, rss: [{ role: secret, rss_bytes: 100, process_epoch: secret }] }] });
  assert.equal(result.idle[0].heap_bytes, 42);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(result.capture.main_reason_codes, ["main_spans_left_open"]);
});

test("failed calibration retains capture reason and timing without raw controls", () => {
  const record = calibrationEvidence({ status: "invalid", runs: [{ durationMs: 31000 }], controls: { token: "private/token", currentCapture: { status: "incomplete", reasonCodes: ["budget:capture_seconds", "private/token"], wallDurationUs: 31000000, events: [{ token: "private/token" }] } } });
  assert.deepEqual(record.capture.reason_codes, ["budget:capture_seconds"]);
  assert.equal(record.capture.wall_duration_us, 31000000);
  assert.equal(record.completed_groups, 1);
  assert.equal(JSON.stringify(record).includes("private/token"), false);
});

test("calibration diagnostic projection retains CPU/export evidence without changing qualification", () => {
  const document = {
    status: "probe_overhead_exceeded",
    runs: [{ mode: "light", durationMs: 21000, taskSeconds: 1.25, exportMs: 9,
      events: 512, heapBytesBefore: 100, heapBytesAfter: 200, rssBytes: 300,
      token: "private/token", endpoint: "private/token" }],
    comparison: { toleranceMs: 400, overheadPercent: 6.27 },
  };
  const before = structuredClone(document);
  const evidence = calibrationEvidence(document);
  assert.deepEqual(document, before);
  assert.equal(evidence.status, "probe_overhead_exceeded");
  assert.deepEqual(evidence.runs[0], { index: 0, mode: "light", duration_ms: 21000,
    task_seconds: 1.25, task_window_seconds: null, phases: {}, export_ms: 9, events: 512,
    heap_bytes_before: 100, heap_bytes_after: 200, rss_bytes: 300 });
  assert.equal(JSON.stringify(evidence).includes("private/token"), false);
  assert.equal(evidence.task_duration_scope, "includes_capture_initialization_and_export");
  const invalid = calibrationEvidence({ status: "invalid", runs: [{ mode: "private/token", taskSeconds: "private/token", exportMs: -1, events: 1.5 }] });
  assert.equal(invalid.runs[0].mode, "unknown");
  assert.equal(invalid.runs[0].task_seconds, null);
  assert.equal(invalid.runs[0].export_ms, null);
  assert.equal(invalid.runs[0].events, null);
});

test("phase evidence preserves failed-group timings and drops arbitrary keys and strings", () => {
  const record = calibrationEvidence({ status: "invalid", controls: {
    currentPhases: { drag_ms: 20000, drag_raf_count: 48, token: "private/token", save_wait_ms: "private/token", injected_numeric: 123 },
    currentWindowTaskSeconds: 0.3,
  }, runs: [{ mode: "off", durationMs: 21000, taskWindowSeconds: 0.4, phases: { read_before_ms: 100, token: "private/token" } }] });
  assert.deepEqual(record.current_phases, { drag_ms: 20000, drag_raf_count: 48 });
  assert.equal(record.current_window_task_seconds, 0.3);
  assert.equal(record.runs[0].task_window_seconds, 0.4);
  assert.deepEqual(record.runs[0].phases, { read_before_ms: 100 });
  assert.equal(JSON.stringify(record).includes("private/token"), false);
  assert.equal(JSON.stringify(record).includes("injected_numeric"), false);
});
