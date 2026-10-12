import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Project } from "@reelterminal/core";
import { DurableTaskLedger, type DurableTaskInput } from "./task-ledger";

const directories: string[] = [];
function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "reel-task-ledger-"));
  directories.push(root);
  const input: DurableTaskInput = {
    jobId: "job-export-1", kind: "export", projectId: "project-a", workspaceId: "workspace-a",
    sourceRevision: 7, inputProject: { id: "project-a", name: "Original input" } as Project,
    parameters: { startSec: 1, endSec: 3 },
  };
  return { root, input, ledger: new DurableTaskLedger(root) };
}
afterEach(() => {
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable desktop task ledger", () => {
  it("captures detached fixed input and reports unfinished tasks as interrupted after restart", () => {
    const { root, input, ledger } = setup();
    ledger.begin(input);
    (input.inputProject as unknown as { name: string }).name = "Later GUI edit";
    const queued = ledger.get(input.jobId)!;
    ledger.update({ ...queued.status, state: "running", progress: { phase: "rendering", percent: 42 } });
    const restored = new DurableTaskLedger(root).get(input.jobId)!;
    expect(restored.inputProject.name).toBe("Original input");
    expect(restored.parameters).toEqual({ startSec: 1, endSec: 3 });
    expect(restored.status).toMatchObject({ state: "error", artifact: null, error: { code: "INTERRUPTED" }, sourceRevision: 7 });
    expect(new DurableTaskLedger(root).get(input.jobId)?.status).toEqual(restored.status);
  });

  it("keeps completed artifact and target identity queryable through restart", () => {
    const { root, input, ledger } = setup();
    ledger.begin(input);
    const status = ledger.get(input.jobId)!.status;
    ledger.update({ ...status, state: "done", deliveredTo: "E:/jobs/output/final.mp4" });
    const restored = new DurableTaskLedger(root).get(input.jobId)!;
    expect(restored.status.state).toBe("done");
    expect(restored.status.deliveredTo).toBe("E:/jobs/output/final.mp4");
    expect(restored.workspaceId).toBe("workspace-a");
    (restored.inputProject as unknown as { name: string }).name = "Mutated read";
    expect(ledger.get(input.jobId)?.inputProject.name).toBe("Original input");
  });

  it("rejects reused job IDs and foreign status without changing the persisted task", () => {
    const { root, input, ledger } = setup();
    ledger.begin(input);
    expect(() => ledger.begin({ ...input, workspaceId: "other" })).toThrow("already exists");
    expect(() => ledger.update({ ...ledger.get(input.jobId)!.status, sourceRevision: 8 })).toThrow("fixed input");
    expect(() => ledger.begin({ ...input, jobId: "../escape" })).toThrow("Invalid task ID");
    expect(new DurableTaskLedger(root).get(input.jobId)?.sourceRevision).toBe(7);
  });

  it("progress ticks never rewrite the fixed input and coalesce to the latest value", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "reel-task-ledger-"));
    directories.push(root);
    const input: DurableTaskInput = {
      jobId: "job-export-2", kind: "export", projectId: "project-a", workspaceId: "workspace-a",
      sourceRevision: 3, inputProject: { id: "project-a", name: "Big", blob: "x".repeat(2_000_000) } as Project,
      parameters: null,
    };
    const ledger = new DurableTaskLedger(root, { progressWriteIntervalMs: 25 });
    ledger.begin(input);
    const inputBytes = readFileSync(path.join(root, "job-export-2.json"));
    const running = { ...ledger.get(input.jobId)!.status, state: "running" as const };
    ledger.update(running);
    for (let frame = 1; frame <= 50; frame += 1) {
      ledger.update({ ...running, progress: { phase: "rendering", percent: frame / 100 } });
    }
    // Same-state progress coalesces: the synchronous burst must not have
    // touched the input document at all.
    expect(readFileSync(path.join(root, "job-export-2.json")).equals(inputBytes)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const persisted = JSON.parse(readFileSync(path.join(root, "job-export-2.status.json"), "utf8"));
    expect(persisted.status.progress.percent).toBe(0.5);
    expect(persisted.status.state).toBe("running");
    // The identity summary avoids cloning the input snapshot.
    expect(ledger.summary(input.jobId)).toMatchObject({ projectId: "project-a", workspaceId: "workspace-a" });
  });

  it("terminal states persist immediately without waiting for the progress interval", () => {
    const root = mkdtempSync(path.join(tmpdir(), "reel-task-ledger-"));
    directories.push(root);
    const ledger = new DurableTaskLedger(root, { progressWriteIntervalMs: 60_000 });
    ledger.begin({
      jobId: "job-export-3", kind: "export", projectId: "project-a", workspaceId: "workspace-a",
      sourceRevision: 1, inputProject: { id: "project-a" } as Project, parameters: null,
    });
    const running = { ...ledger.get("job-export-3")!.status, state: "running" as const };
    ledger.update(running);
    ledger.update({ ...running, state: "done", deliveredTo: "E:/out/final.mp4" });
    const persisted = JSON.parse(readFileSync(path.join(root, "job-export-3.status.json"), "utf8"));
    expect(persisted.status.state).toBe("done");
    expect(persisted.status.deliveredTo).toBe("E:/out/final.mp4");
  });

  it("migrates legacy v1 single-file records in place on load", () => {
    const root = mkdtempSync(path.join(tmpdir(), "reel-task-ledger-"));
    directories.push(root);
    const v1 = {
      formatVersion: 1, jobId: "job-export-4", kind: "export", projectId: "project-a",
      workspaceId: "workspace-a", sourceRevision: 11,
      inputProject: { id: "project-a", name: "Legacy" }, parameters: { legacy: true },
      status: {
        jobId: "job-export-4", kind: "export", sourceRevision: 11, state: "done",
        progress: null, artifact: null, result: null, error: null,
        deliveredTo: null, deliveryError: null, route: null,
        upscalingRequestedButInactive: false, cancelRequested: false,
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:01.000Z",
      },
    };
    writeFileSync(path.join(root, "job-export-4.json"), JSON.stringify(v1), "utf8");
    const migrated = new DurableTaskLedger(root).get("job-export-4")!;
    expect(migrated.status.state).toBe("done");
    expect(migrated.inputProject.name).toBe("Legacy");
    const inputDoc = JSON.parse(readFileSync(path.join(root, "job-export-4.json"), "utf8"));
    expect(inputDoc.formatVersion).toBe(2);
    expect(inputDoc.status).toBeUndefined();
    const statusDoc = JSON.parse(readFileSync(path.join(root, "job-export-4.status.json"), "utf8"));
    expect(statusDoc.status.state).toBe("done");
  });
});
