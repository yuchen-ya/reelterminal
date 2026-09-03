/**
 * JobRegistry state-machine unit tests (audit/facade-v0.md contract #4):
 * queued/running/done/error/cancelled transitions, terminal-state sealing,
 * and the no-artifact-on-failure invariant.
 */
import { describe, expect, it } from "vitest";
import { JobRegistry, jobStatusView } from "./jobs";
import type { ArtifactRef } from "./providers";

const ARTIFACT: ArtifactRef = {
  kind: "video",
  format: "mp4",
  path: "/artifacts/exports/job-1/output.mp4",
  sizeBytes: 1234,
  sha256: "ab".repeat(32),
  sourceRevision: 2,
};

describe("JobRegistry", () => {
  it("follows queued → running → done with progress", () => {
    const reg = new JobRegistry();
    reg.create("j1", 2);
    expect(reg.get("j1")?.state).toBe("queued");
    expect(reg.get("j1")?.sourceRevision).toBe(2);
    expect(reg.get("j1")?.artifact).toBeNull();

    reg.markRunning("j1");
    expect(reg.get("j1")?.state).toBe("running");

    reg.markProgress("j1", {
      phase: "rendering",
      percent: 0.5,
      currentFrame: 75,
      totalFrames: 150,
    });
    expect(reg.get("j1")?.progress?.percent).toBe(0.5);
    expect(reg.get("j1")?.progress?.currentFrame).toBe(75);

    reg.markDone("j1", ARTIFACT, "chromium-webcodecs");
    const done = reg.get("j1");
    expect(done?.state).toBe("done");
    expect(done?.artifact).toEqual(ARTIFACT);
    expect(done?.route).toBe("chromium-webcodecs");
    expect(reg.isTerminal("j1")).toBe(true);
  });

  it("error drops any artifact and seals the job", () => {
    const reg = new JobRegistry();
    reg.create("j2", 0);
    reg.markRunning("j2");
    reg.markError("j2", { code: "JOB_FAILED", message: "encoder exploded" });
    const job = reg.get("j2");
    expect(job?.state).toBe("error");
    expect(job?.artifact).toBeNull();
    expect(job?.error?.message).toBe("encoder exploded");
    // Terminal states are sealed: late transitions are ignored.
    reg.markDone("j2", ARTIFACT, "chromium-webcodecs");
    expect(reg.get("j2")?.state).toBe("error");
    expect(reg.get("j2")?.artifact).toBeNull();
  });

  it("cancel from queued and from running settles cancelled, sealed", () => {
    const reg = new JobRegistry();
    reg.create("q", 1);
    reg.markCancelRequested("q");
    expect(reg.get("q")?.cancelRequested).toBe(true);
    reg.markCancelled("q");
    expect(reg.get("q")?.state).toBe("cancelled");
    expect(reg.get("q")?.artifact).toBeNull();
    reg.markRunning("q");
    expect(reg.get("q")?.state).toBe("cancelled");

    reg.create("r", 1);
    reg.markRunning("r");
    reg.markProgress("r", { phase: "rendering", percent: 0.1 });
    reg.markCancelRequested("r");
    reg.markCancelled("r");
    expect(reg.get("r")?.state).toBe("cancelled");
    expect(reg.get("r")?.artifact).toBeNull();
    reg.markError("r", { code: "X", message: "late error ignored" });
    expect(reg.get("r")?.state).toBe("cancelled");
  });

  it("done jobs ignore a late cancel", () => {
    const reg = new JobRegistry();
    reg.create("d", 3);
    reg.markRunning("d");
    reg.markDone("d", ARTIFACT, "chromium-frames-ffmpeg");
    reg.markCancelRequested("d");
    expect(reg.get("d")?.cancelRequested).toBe(false);
    reg.markCancelled("d");
    expect(reg.get("d")?.state).toBe("done");
    expect(reg.get("d")?.artifact).toEqual(ARTIFACT);
  });

  it("unknown jobIds are safe no-ops", () => {
    const reg = new JobRegistry();
    expect(reg.get("nope")).toBeNull();
    expect(reg.isTerminal("nope")).toBe(false);
    reg.markRunning("nope");
    reg.markError("nope", { code: "X", message: "y" });
    reg.markCancelled("nope");
    expect(reg.get("nope")).toBeNull();
  });

  it("delivery bookkeeping settles only on done jobs and survives in the status view", () => {
    const reg = new JobRegistry();
    reg.create("j1", 2);
    // Not done yet: delivery marks are ignored.
    reg.markDelivered("j1", "/ws/jobs/a/output/x.mp4");
    expect(reg.get("j1")?.deliveredTo).toBeNull();

    reg.markDone("j1", ARTIFACT, "chromium-webcodecs");
    reg.markDelivered("j1", "/ws/jobs/a/output/x.mp4");
    expect(reg.get("j1")?.deliveredTo).toBe("/ws/jobs/a/output/x.mp4");
    expect(reg.get("j1")?.deliveryError).toBeNull();
    expect(reg.get("j1")?.artifact).toEqual(ARTIFACT);

    reg.create("j2", 2);
    reg.markDone("j2", ARTIFACT, "chromium-webcodecs");
    reg.markDeliveryFailed("j2", "EEXIST: file already exists");
    const failed = reg.get("j2");
    // A delivery failure never hides the artifact or downgrades the job.
    expect(failed?.state).toBe("done");
    expect(failed?.artifact).toEqual(ARTIFACT);
    expect(failed?.deliveryError).toBe("EEXIST: file already exists");
    expect(failed?.deliveredTo).toBeNull();

    const view = jobStatusView(failed!);
    expect(view.deliveredTo).toBeNull();
    expect(view.deliveryError).toBe("EEXIST: file already exists");
  });
});
