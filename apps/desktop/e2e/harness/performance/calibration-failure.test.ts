import { test, expect, vi } from "vitest";
import { runInNewContext } from "node:vm";
import type { Page } from "playwright-core";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { captureCalibrationStartup, writeCalibrationFailure } from "./calibration-failure";

test("startup snapshots contain structural DOM state and exact locator counts without page contents or URL credentials", async () => {
  const secret = "e".repeat(64);
  const page = {
    evaluate: async (read: Function) => runInNewContext(`(${read})()`, {
      location: { origin: "app://reelterminal", pathname: "/index.html", search: `?token=${secret}` },
      navigator: { language: "en-US" },
      document: {
        readyState: "complete", visibilityState: "visible", hasFocus: () => true,
        documentElement: { lang: "en" }, body: { innerText: secret },
        getElementById: () => ({ childElementCount: 2 }),
        querySelector: (selector: string) => selector.includes("project-library") ? {} : null,
      },
    }),
    getByRole: (role: string, options: unknown) => {
      expect(role).toBe("button"); expect(options).toEqual({ name: "Open synthetic fixture", exact: true });
      return { count: async () => 1 };
    },
  } as unknown as Page;
  const result = await captureCalibrationStartup(page, "Open synthetic fixture");
  expect(result).toMatchObject({
    documentState: { status: "available", value: { url: "app://reelterminal/index.html", readyState: "complete", rootPresent: true, rootChildCount: 2, libraryPresent: true, editorPresent: false } },
    openButtonCount: { status: "available", value: 1 },
  });
  expect(JSON.stringify(result)).not.toContain(secret);
});

test("a stalled locator and failed execution context have independent bounded diagnostics", async () => {
  const secret = "e".repeat(64);
  const page = {
    evaluate: async () => { throw new Error(`execution unavailable ${secret}`); },
    getByRole: () => ({ count: () => new Promise(() => {}) }),
  } as unknown as Page;
  const result = await captureCalibrationStartup(page, "Open fixture", 15);
  expect(result).toMatchObject({ documentState: { status: "unavailable" }, openButtonCount: { status: "unavailable" } });
  expect(JSON.stringify(result)).toContain("deadline exceeded");
  expect(JSON.stringify(result)).not.toContain(secret);
});

test("primary failure is durable before a stalled startup snapshot and screenshot still follows its deadline", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reelterminal-calibration-evidence-"));
  const artifact = path.join(root, "failed.json");
  let begin!: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; });
  let screenshotAttempted = false;
  vi.useFakeTimers();
  try {
    const writing = writeCalibrationFailure({
      artifact, error: new Error("original locator failure"), stage: "open_fixture", controls: {}, runs: [],
      startupDiagnostics: () => { begin(); return new Promise(() => {}); },
      screenshot: async () => { screenshotAttempted = true; },
    });
    await started;
    expect(JSON.parse(await readFile(artifact, "utf8")).failure.message).toContain("original locator failure");
    await vi.advanceTimersByTimeAsync(4_501);
    await writing;
    expect(screenshotAttempted).toBe(true);
    expect(JSON.parse(await readFile(path.join(root, "failed.startup.json"), "utf8"))).toMatchObject({ status: "unavailable" });
  } finally { vi.useRealTimers(); await rm(root, { recursive: true, force: true }); }
});

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
