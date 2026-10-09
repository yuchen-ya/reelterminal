import { mkdtempSync, rmSync } from "node:fs";
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
});
