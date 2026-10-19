import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectArtifacts } from "./check-ci-artifacts.mjs";

async function fixture(t, data) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ci-evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "evidence.json"), JSON.stringify(data));
  return directory;
}

test("runner paths, fixture accounts and numeric evidence remain publishable", async (t) => {
  const root = await fixture(t, { path: "/home/runner/work/repo", sample: "C:\\Users\\demo\\fixture.mp4", sha256: "a".repeat(64), token: "<redacted>", rounds: 500 });
  assert.equal((await inspectArtifacts(root)).status, "passed");
});

test("nested personal paths and decoded credentials are rejected without echoing values", async (t) => {
  const root = await fixture(t, { nested: { path: "C:\\Users\\private-person\\media.mp4" }, token: "secret-value-for-test-only" });
  const result = await inspectArtifacts(root);
  assert.equal(result.status, "failed");
  assert.ok(result.findings.some(item => item.reason === "personal_home_path"));
  assert.ok(result.findings.some(item => item.reason === "credential_field"));
  assert.doesNotMatch(JSON.stringify(result), /private-person|secret-value/);
});

test("missing evidence, private configuration and bounded size fail closed", async (t) => {
  const root = await fixture(t, { value: "bounded" });
  assert.equal((await inspectArtifacts(root, { maxBytes: 1 })).status, "failed");
  await writeFile(path.join(root, "live-endpoint.json"), "not read");
  assert.ok((await inspectArtifacts(root)).findings.some(item => item.reason === "private_configuration_file"));
  assert.equal((await inspectArtifacts(path.join(root, "missing"))).status, "failed");
});
