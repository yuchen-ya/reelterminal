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
