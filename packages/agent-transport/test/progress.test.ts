import { describe, expect, it } from "vitest";
import type { FacadeResult, JobStatusView } from "@openreel/agent-facade";
import { startJobProgressWatch, type JobProgressNotification } from "../src/progress";

function status(state: JobStatusView["state"], percent: number | null, phase = "rendering"): JobStatusView {
  return {
    jobId: "job-1",
    kind: "export",
    state,
    progress: percent === null ? null : { phase: phase as "rendering", percent },
    artifact: null,
    error: null,
    sourceRevision: 1,
    route: null,
    cancelRequested: false,
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
  };
}

describe("MCP export progress watcher", () => {
  it("emits opt-in progress once per changed public job status and completes at 1", async () => {
    const statuses = [
      status("queued", null),
      status("running", 0.25),
      status("running", 0.25),
      status("done", 1, "complete"),
    ];
    const notifications: JobProgressNotification[] = [];
    const watch = startJobProgressWatch({
      jobId: "job-1",
      progressToken: "export-token",
      pollMs: 50,
      readStatus: async () => ({ ok: true, value: statuses.shift() ?? status("done", 1, "complete") }) as FacadeResult<JobStatusView>,
      notify: async (notification) => {
        notifications.push(notification);
      },
    });

    await watch.done;
    expect(notifications).toEqual([
      { progressToken: "export-token", progress: 0, total: 1, message: "queued" },
      { progressToken: "export-token", progress: 0.25, total: 1, message: "rendering" },
      { progressToken: "export-token", progress: 1, total: 1, message: "complete" },
    ]);
  });

  it("stop prevents another poll and is safe to call repeatedly", async () => {
    let reads = 0;
    const watch = startJobProgressWatch({
      jobId: "job-1",
      progressToken: 7,
      pollMs: 50,
      readStatus: async () => {
        reads += 1;
        return { ok: true, value: status("running", 0.1) };
      },
      notify: async () => undefined,
    });
    watch.stop();
    watch.stop();
    await watch.done;
    expect(reads).toBe(1);
  });
});
