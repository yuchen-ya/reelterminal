import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

test("real timeout and assertion failure close FFmpeg before the next Vitest case", { timeout: 45_000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "native-scope-probe-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = fileURLToPath(new URL("../", import.meta.url));
  const report = path.join(directory, "results.json");
  const evidence = path.join(directory, "cleanup.json");
  const env = { ...process.env, REELTERMINAL_TEST_SCOPE_EVIDENCE: evidence,
    REELTERMINAL_AUDIO_CONFIG: path.join(directory, "absent-audio-environment.json") };
  delete env.NODE_OPTIONS;
  let exitCode = 0;
  try {
    await promisify(execFile)(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run",
      "--config", "test/native-test-scope.fixture.config.ts", "--reporter=json", "--outputFile", report],
    { cwd: root, env, windowsHide: true, timeout: 40_000, maxBuffer: 2 * 1024 * 1024 });
  } catch (error) {
    assert.equal(error.killed, false, "The outer watchdog must not replace the real Vitest timeout");
    exitCode = error.code;
  }
  assert.equal(exitCode, 1, "The inner runner must preserve both deliberate failures");
  const result = JSON.parse(await readFile(report, "utf8"));
  assert.equal(result.success, false);
  assert.equal(result.numFailedTests, 2);
  assert.equal(result.numPassedTests, 1);
  const cases = result.testResults.flatMap(group => group.assertionResults);
  assert.equal(cases[0].status, "failed");
  assert.match(cases[1].failureMessages.join("\n"), /deliberate native assertion failure/);
  assert.equal(cases[2].status, "passed");
  const cleanup = JSON.parse(await readFile(evidence, "utf8"));
  // Vitest's JSON reporter may retain STACK_TRACE_ERROR as the stack heading;
  // its own context signal carries the actual timeout reason independently.
  assert.match(cleanup.timeoutReason, /Test timed out in 2000ms/);
  assert.equal(cleanup.leakedBeforeFallback, 0);
  assert.equal(cleanup.liveAfterCleanup, 0);
  assert.equal(cleanup.lateCompletion, false);
  assert.equal(cleanup.events.filter(event => event.endsWith(":spawn")).length, 2);
  assert.equal(cleanup.events.filter(event => event.endsWith(":close")).length, 2);
  console.log(JSON.stringify({ nativeCleanupProbe: "passed", realTimeouts: 1, retainedAssertionFailures: 1,
    closedProcesses: 2, fallbackCleanup: false, nextCaseStartedAfterClose: true, lateCompletionAccepted: false }));
});
