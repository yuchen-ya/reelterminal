import { test, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeCalibrationFailure } from "./calibration-failure";

test("a failed screenshot cannot replace the primary failure or expose log credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reelterminal-calibration-evidence-"));
  const artifact = path.join(root, "failed.json");
  const canary = "a".repeat(64);
  let screenshotAttempted = false;
  try {
    await expect(writeCalibrationFailure({
      artifact, error: new Error("semantic marker timeout"), stage: "prime_marker", controls: {}, runs: [],
      retainedProfile: "/owned/test/profile", output: { mainStderr: ["Bearer " + canary] },
      screenshot: async () => {
        // The essential evidence must already be durable when screenshot stalls.
        expect(JSON.parse(await readFile(artifact, "utf8")).failure.message).toContain("semantic marker timeout");
        screenshotAttempted = true;
        throw new Error("screenshot timeout " + canary);
      },
    })).resolves.toBeUndefined();
    expect(screenshotAttempted).toBe(true);
    const result = JSON.parse(await readFile(artifact, "utf8"));
    expect(result).toMatchObject({ status: "invalid", stage: "prime_marker", retained_profile: "/owned/test/profile" });
    expect(result.failure.message).toContain("semantic marker timeout");
    expect(await readFile(path.join(root, "failed.mainStderr.redacted.log"), "utf8")).toBe("Bearer [redacted]");
    const secondary = await readFile(path.join(root, "failed.screenshot-error.json"), "utf8");
    expect(secondary).toContain("screenshot timeout"); expect(secondary).not.toContain(canary);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("build identity digests stay intact while primary error credentials are redacted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reelterminal-calibration-evidence-"));
  const digest = "b".repeat(64);
  const artifact = path.join(root, "failed.json");
  try {
    await writeCalibrationFailure({ artifact, error: new Error(digest), stage: "launch", build: { source_digest: digest }, controls: {}, runs: [] });
    const result = JSON.parse(await readFile(artifact, "utf8"));
    expect(result.build.source_digest).toBe(digest);
    expect(result.failure.message).toContain("[redacted]");
  } finally { await rm(root, { recursive: true, force: true }); }
});
