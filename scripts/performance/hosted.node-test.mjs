import assert from "node:assert/strict";
import test from "node:test";
import { hostedPlan, resourceEvidence, calibrationEvidence } from "./hosted.mjs";
import { runTimeoutMs } from "./run-options.mjs";

test("hosted profiles reserve installation/build headroom within a 210-minute job", () => {
  for (const profile of ["smoke", "stress"]) {
    const plan = hostedPlan(profile);
    assert.ok(plan.reduce((ms, command) => ms + runTimeoutMs(command.options), 0) < 180 * 60_000);
    assert.ok(plan.every(command => command.options.repeats === 1));
  }
  assert.throws(() => hostedPlan("all"));
});

test("representative soak stays continuous for 30 minutes after real history saturation", () => {
  const options = hostedPlan("stress").find(command => command.options.scenarios.includes("R02")).options;
  assert.equal(options.durationSeconds, 1800);
  assert.equal(options.saturateHistory, true);
  assert.ok(options.runTimeoutSeconds >= options.durationSeconds + 600);
});

test("resource projection omits arbitrary strings, paths and credentials", () => {
  const secret = "private/path/token";
  const result = resourceEvidence({ retained_profile: secret, run: { scenario_id: "R02", completed_rounds: 50, elapsed_ms: 1800000 }, history_saturation: { capacity: 1000, token: secret }, idle_samples: [{ heap_bytes: 42, path: secret, rss: [{ role: secret, rss_bytes: 100, process_epoch: secret }] }] });
  assert.equal(result.idle[0].heap_bytes, 42);
  assert.equal(JSON.stringify(result).includes(secret), false);
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
