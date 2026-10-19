import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./report-native-process-metrics.mjs", import.meta.url));
async function fixture(t, competingPassed, closeProcess = true) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "native-report-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const label of ["competing", "isolated"]) {
    const passed = label === "isolated" || competingPassed;
    await writeFile(path.join(directory, `${label}-results.json`), JSON.stringify({ success: passed, numTotalTests: 1,
      testResults: [{ name: "fixture-root/audio-normalize.test.ts", assertionResults: [{ title: "native fixture", status: passed ? "passed" : "failed", duration: 1, failureMessages: ["DO_NOT_PUBLISH_TEST_FAILURE_TEXT"] }] }] }));
    const events = [{ event: "invoked", ownerPid: 1, id: 1, stage: "probe", childPid: 2 },
      ...(closeProcess ? [{ event: "closed", ownerPid: 1, id: 1, stage: "probe" }] : [])];
    await writeFile(path.join(directory, `${label}.1.jsonl`), events.map(item => JSON.stringify(item)).join("\n") + "\n");
  }
  const output = path.join(directory, "report.json");
  const result = spawnSync(process.execPath, [script, directory, output], { encoding: "utf8", windowsHide: true });
  const text = await readFile(output, "utf8");
  assert.doesNotMatch(text, /DO_NOT_PUBLISH_TEST_FAILURE_TEXT|fixture-root/);
  return { result, report: JSON.parse(text) };
}
test("both successful runs with closed processes qualify", async t => {
  const { result, report } = await fixture(t, true);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(report.reports.every(item => item.allNativeCasesPassed && item.pendingProcesses.length === 0));
});
test("isolated success never overrides an original suite failure", async t => {
  const { result, report } = await fixture(t, false);
  assert.equal(result.status, 1);
  assert.equal(report.reports[0].suiteSucceeded, false);
  assert.equal(report.reports[1].suiteSucceeded, true);
});
test("unclosed native processes remain a failure even with green assertions", async t => {
  const { result, report } = await fixture(t, true, false);
  assert.equal(result.status, 1);
  assert.equal(report.reports[0].pendingProcesses.length, 1);
});
