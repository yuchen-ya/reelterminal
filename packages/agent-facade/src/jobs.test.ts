/**
 * JobRegistry state-machine tests:
 * queued/running/done/error/cancelled transitions, terminal-state sealing,
 * and the no-artifact-on-failure invariant.
 */
import { describe, expect, it } from "vitest";
import { JobRegistry, jobStatusView } from "./jobs";
import type { ArtifactRef } from "./providers";
import type { JobStatusView } from "./types";

const ARTIFACT: ArtifactRef = {
  kind: "video",
  format: "mp4",
  path: "/artifacts/exports/job-1/output.mp4",
  sizeBytes: 1234,
  sha256: "ab".repeat(32),
  sourceRevision: 2,
};

describe("JobRegistry", () => {
  it("projects restored audio jobs compactly and hides legacy failed or cancelled results", () => {
    const legacyResult = {
      analysisTypes: ["audioSummary", "silence", "beatGrid"] as const,
      summary: {
        audioSummary: { waveform: [{ rms: 0.5 }], onsets: [{ timeSec: 1 }], silence: [], integratedLufs: -18 },
        silence: { silentRegions: [{ startSec: 1, endSec: 2 }], totalSilenceDurationSec: 1 },
        beatGrid: { beats: [{ timeSec: 1 }], bpm: 120 },
      },
      artifacts: [],
    };
    const status = (jobId: string, state: JobStatusView["state"]): JobStatusView => ({
      jobId,
      kind: "analysis",
      state,
      progress: null,
      artifact: null,
      result: legacyResult,
      error: null,
      deliveredTo: null,
      deliveryError: null,
      sourceRevision: 1,
      route: null,
      upscalingRequestedButInactive: false,
      cancelRequested: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });

    const registry = new JobRegistry();
    registry.restore(status("legacy-done", "done"));
    registry.restore(status("legacy-error", "error"));
    registry.restore(status("legacy-cancelled", "cancelled"));

    const done = jobStatusView(registry.get("legacy-done")!);
    expect(done.result?.summary).toEqual({
      audioSummary: { integratedLufs: -18 },
      silence: { totalSilenceDurationSec: 1 },
      beatGrid: { bpm: 120 },
    });
    expect(jobStatusView(registry.get("legacy-error")!).result).toBeNull();
    expect(jobStatusView(registry.get("legacy-cancelled")!).result).toBeNull();
    // Projection is an output contract; restoring the durable source remains lossless.
    expect(registry.get("legacy-done")?.result?.summary.audioSummary).toHaveProperty("waveform");
  });

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

  it("publishes delivery outcome in the same persisted terminal status", () => {
    const reg = new JobRegistry();
    const persisted: JobStatusView[] = [];
    reg.create("delivered", 2);
    reg.observe("delivered", (status) => persisted.push(status));
    reg.markRunning("delivered");
    reg.markDone("delivered", ARTIFACT, "chromium-webcodecs", false, {
      deliveredTo: "/workspace/jobs/demo/output/final.mp4",
    });

    expect(persisted.filter((status) => status.state === "done")).toHaveLength(1);
    expect(persisted.at(-1)).toMatchObject({
      state: "done",
      artifact: ARTIFACT,
      deliveredTo: "/workspace/jobs/demo/output/final.mp4",
      deliveryError: null,
    });

    const failed = new JobRegistry();
    const failureStatuses: JobStatusView[] = [];
    failed.create("delivery-failed", 2);
    failed.observe("delivery-failed", (status) => failureStatuses.push(status));
    failed.markRunning("delivery-failed");
    failed.markDone("delivery-failed", ARTIFACT, "chromium-webcodecs", false, {
      deliveryError: "EEXIST: file already exists",
    });
    expect(failureStatuses.at(-1)).toMatchObject({
      state: "done",
      artifact: ARTIFACT,
      deliveredTo: null,
      deliveryError: "EEXIST: file already exists",
    });
  });
});
