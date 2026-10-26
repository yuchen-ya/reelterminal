import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Project } from "@reelterminal/core";
import { JobRegistry } from "@reelterminal/agent-facade";
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
  it("retains a completed batch result across restart while unfinished work is interrupted", () => {
    const { root, input, ledger } = setup();
    const registry = new JobRegistry();
    const batchStates = new Map<string, string>();
    for (const jobId of ["batch-done", "batch-pending"]) {
      ledger.begin({ ...input, jobId, kind: "analysis" });
      registry.create(jobId, input.sourceRevision, "analysis");
      registry.observe(jobId, status => ledger.update(status), "task-lifecycle");
      registry.observe(jobId, status => batchStates.set(jobId, status.state));
      registry.markRunning(jobId);
    }
    registry.markAnalysisDone("batch-done", {
      analysisTypes: ["technicalQuality"], summary: { measured: true }, artifacts: [],
    });
    expect(batchStates.get("batch-done")).toBe("done");
    const restored = new DurableTaskLedger(root);
    expect(restored.get("batch-done")?.status).toMatchObject({
      state: "done", result: { summary: { measured: true } }, error: null,
    });
    expect(restored.get("batch-pending")?.status).toMatchObject({
      state: "error", result: null, error: { code: "INTERRUPTED" },
    });
  });

  it("captures detached fixed input and reports unfinished tasks as interrupted after restart", () => {
    const { root, input, ledger } = setup();
    const audioInput = { ...input, kind: "audio-process" as const };
    ledger.begin(audioInput);
    (input.inputProject as unknown as { name: string }).name = "Later GUI edit";
    const queued = ledger.get(input.jobId)!;
    ledger.update({ ...queued.status, state: "running", progress: { phase: "rendering", percent: 42 } });
    const restored = new DurableTaskLedger(root).get(input.jobId)!;
    expect(restored.inputProject.name).toBe("Original input");
    expect(restored.parameters).toEqual({ startSec: 1, endSec: 3 });
    expect(restored.status).toMatchObject({ state: "error", artifact: null, error: { code: "INTERRUPTED" }, sourceRevision: 7 });
    expect(restored.status.ownership).toMatchObject({ kind: "work", projectId: "project-a", workspaceId: "workspace-a", deliveryStatus: "pending" });
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
      sourceRevision: 3, inputProject: { id: "project-a", name: "Big", blob: "x".repeat(2_000_000) } as unknown as Project,
      parameters: null,
    };
    const inputWrites = new Map<string, number>();
    const ledger = new DurableTaskLedger(root, {
      progressWriteIntervalMs: 25,
      onInputWrite: (jobId) => inputWrites.set(jobId, (inputWrites.get(jobId) ?? 0) + 1),
    });
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
    expect(inputWrites.get(input.jobId)).toBe(1);
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
    expect(migrated.status).not.toHaveProperty("ownership");
    expect(migrated.inputProject.name).toBe("Legacy");
    const inputDoc = JSON.parse(readFileSync(path.join(root, "job-export-4.json"), "utf8"));
    expect(inputDoc.formatVersion).toBe(2);
    expect(inputDoc.status).toBeUndefined();
    const statusDoc = JSON.parse(readFileSync(path.join(root, "job-export-4.status.json"), "utf8"));
    expect(statusDoc.status.state).toBe("done");
  });

  it("persists and restores audio-process task identity and fixed inputs", () => {
    const { root, input } = setup();
    const ledger = new DurableTaskLedger(root);
    const audioInput: DurableTaskInput = {
      ...input,
      jobId: "job-audio-process-1",
      kind: "audio-process",
      parameters: { verb: "audio.process.normalize", idempotencyKey: "normalize-1", payloadHash: "payload-hash" },
    };
    ledger.begin(audioInput);
    ledger.update({
      ...ledger.get(audioInput.jobId)!.status,
      state: "running",
      progress: { phase: "measuring", percent: 0.5 },
    });

    const restored = new DurableTaskLedger(root).get(audioInput.jobId)!;
    expect(restored.kind).toBe("audio-process");
    expect(restored.status.ownership).toMatchObject({ kind: "work", purpose: "Audio processing: normalize", origin: "agent" });
    expect(restored.parameters).toEqual(audioInput.parameters);
    expect(restored.status).toMatchObject({
      kind: "audio-process",
      state: "error",
      error: { code: "INTERRUPTED" },
      artifact: null,
      sourceRevision: 7,
    });
  });

  it("persists task ownership as work until success and marks only confirmed copies delivered", () => {
    const { root, input, ledger } = setup();
    ledger.begin(input);
    const queued = ledger.get(input.jobId)!.status;
    expect(queued.ownership).toEqual({
      kind: "work", purpose: "Video export", origin: "agent",
      projectId: "project-a", workspaceId: "workspace-a", deliveryStatus: "pending",
    });
    expect(queued.ownership?.nodeId).toBeUndefined();

    const running = { ...queued, state: "running" as const };
    ledger.update(running);
    const done = { ...running, state: "done" as const, artifact: {
      kind: "video" as const, format: "mp4" as const, path: "C:/artifacts/final.mp4",
      sizeBytes: 12, sha256: "hash", sourceRevision: 7,
    } };
    ledger.update(done);
    expect(ledger.get(input.jobId)?.status.ownership).toMatchObject({ kind: "output", deliveryStatus: "pending" });

    ledger.update({ ...done, deliveredTo: "C:/delivery/final.mp4" });
    expect(ledger.get(input.jobId)?.status.ownership).toMatchObject({ kind: "output", deliveryStatus: "delivered" });
    const persistedStatus = JSON.parse(readFileSync(path.join(root, `${input.jobId}.status.json`), "utf8"));
    expect(persistedStatus.status.ownership).toMatchObject({
      kind: "output", purpose: "Video export", origin: "agent",
      projectId: "project-a", workspaceId: "workspace-a", deliveryStatus: "delivered",
    });
  });

  it("lists only exact-target task records and recognizes a new task's empty producer manifest", () => {
    const { input, ledger } = setup();
    ledger.begin(input);
    const queued = ledger.get(input.jobId)!.status;
    ledger.update({ ...queued, state: "error", error: { code: "FAILED", message: "render failed" } });
    ledger.begin({ ...input, jobId: "job-other-project", projectId: "project-b", inputProject: { id: "project-b" } as Project });
    ledger.begin({ ...input, jobId: "job-other-workspace", workspaceId: "workspace-b" });

    const summary = ledger.listCleanupCandidates({ projectId: "project-a", workspaceId: "workspace-a" });
    expect(summary.tasks).toHaveLength(1);
    expect(summary.tasks[0]).toMatchObject({
      jobId: input.jobId, state: "error", kind: "export", sourceRevision: 7,
      ownership: { kind: "work", projectId: "project-a", workspaceId: "workspace-a" },
    });
    expect(summary.tasks[0].files.map(file => path.basename(file.path))).toEqual([
      `${input.jobId}.json`, `${input.jobId}.status.json`,
    ]);
    expect(summary.tasks[0].files.every(file => file.retainedReason.includes("no output or media file is removed"))).toBe(true);
    expect(summary.artifactScanReady).toBe(true);
    expect(summary.unknowns).not.toContain(`${input.jobId}: partial outputs from this failed task are not indexed and remain retained.`);
  });

  it("keeps completed analysis and unadopted audio processing as work rather than finished movies", () => {
    const { input, ledger } = setup();
    for (const kind of ["analysis", "audio-process"] as const) {
      const jobId = `job-${kind}`;
      ledger.begin({ ...input, jobId, kind });
      ledger.update({ ...ledger.get(jobId)!.status, state: "done" });
      expect(ledger.get(jobId)?.status.ownership).toMatchObject({ kind: "work", deliveryStatus: "pending" });
    }
  });

  it("purges only fingerprinted failed task-record pairs after exact target and state rechecks", () => {
    const { root, input, ledger } = setup();
    ledger.begin(input);
    const queued = ledger.get(input.jobId)!.status;
    ledger.update({ ...queued, state: "cancelled" });
    ledger.begin({ ...input, jobId: "job-still-running" });
    const unrelatedOutput = path.join(root, "unrelated.mp4");
    writeFileSync(unrelatedOutput, "keep", "utf8");

    const task = ledger.listCleanupCandidates({ projectId: "project-a", workspaceId: "workspace-a" }).tasks
      .find(candidate => candidate.jobId === input.jobId)!;
    const result = ledger.purgeFailedTaskRecords({
      projectId: "project-a",
      workspaceId: "workspace-a",
      jobIds: [input.jobId, "job-still-running"],
      expectedFiles: task.files.map(file => ({ jobId: input.jobId, ...file })),
    });

    expect(result.deleted).toHaveLength(1);
    expect(result.deleted[0].files.map(file => path.basename(file))).toEqual([
      `${input.jobId}.json`, `${input.jobId}.status.json`,
    ]);
    expect(result.actualBytes).toBeGreaterThan(0);
    expect(result.skipped).toEqual([{ jobId: "job-still-running", reason: "Only failed or cancelled tasks can have their ledger records removed." }]);
    expect(ledger.get(input.jobId)).toBeNull();
    expect(ledger.get("job-still-running")).not.toBeNull();
    expect(readFileSync(unrelatedOutput, "utf8")).toBe("keep");
  });

  it("skips task-record fingerprints changed since the cleanup review", () => {
    const { root, input, ledger } = setup();
    ledger.begin(input);
    ledger.update({ ...ledger.get(input.jobId)!.status, state: "error", error: { code: "FAILED", message: "failed" } });
    const task = ledger.listCleanupCandidates({ projectId: "project-a", workspaceId: "workspace-a" }).tasks[0];
    const statusPath = path.join(root, `${input.jobId}.status.json`);
    writeFileSync(statusPath, `${readFileSync(statusPath, "utf8")} `, "utf8");

    const result = ledger.purgeFailedTaskRecords({
      projectId: "project-a", workspaceId: "workspace-a", jobIds: [input.jobId],
      expectedFiles: task.files.map(file => ({ jobId: input.jobId, ...file })),
    });
    expect(result.deleted).toEqual([]);
    expect(result.skipped).toEqual([{ jobId: input.jobId, reason: "Task record file changed since review" }]);
    expect(ledger.get(input.jobId)).not.toBeNull();
  });

  it("skips task-record fingerprints whose modification time changed without a size change", () => {
    const { root, input, ledger } = setup();
    ledger.begin(input);
    ledger.update({ ...ledger.get(input.jobId)!.status, state: "error", error: { code: "FAILED", message: "failed" } });
    const task = ledger.listCleanupCandidates({ projectId: "project-a", workspaceId: "workspace-a" }).tasks[0];
    const statusPath = path.join(root, `${input.jobId}.status.json`);
    const content = readFileSync(statusPath);
    const previous = lstatSync(statusPath);
    const later = new Date(previous.mtimeMs + 5000);
    utimesSync(statusPath, later, later);
    expect(readFileSync(statusPath).byteLength).toBe(content.byteLength);

    const result = ledger.purgeFailedTaskRecords({
      projectId: "project-a", workspaceId: "workspace-a", jobIds: [input.jobId],
      expectedFiles: task.files.map(file => ({ jobId: input.jobId, ...file })),
    });
    expect(result.deleted).toEqual([]);
    expect(result.skipped).toEqual([{ jobId: input.jobId, reason: "Task record file changed since review" }]);
  });

  it("rejects escaped record paths and a task whose persisted state changed to running", () => {
    const parentRoot = mkdtempSync(path.join(tmpdir(), "reel-task-cleanup-"));
    directories.push(parentRoot);
    const root = path.join(parentRoot, "ledger");
    mkdirSync(root);
    const input: DurableTaskInput = {
      jobId: "job-cleanup-escape", kind: "export", projectId: "project-a", workspaceId: "workspace-a",
      sourceRevision: 7, inputProject: { id: "project-a" } as Project, parameters: null,
    };
    const ledger = new DurableTaskLedger(root);
    ledger.begin(input);
    ledger.update({ ...ledger.get(input.jobId)!.status, state: "error", error: { code: "FAILED", message: "failed" } });
    const task = ledger.listCleanupCandidates({ projectId: "project-a", workspaceId: "workspace-a" }).tasks[0];
    const outsidePath = path.resolve(root, "..", "outside.json");
    writeFileSync(outsidePath, "keep", "utf8");
    const escapedResult = ledger.purgeFailedTaskRecords({
      projectId: "project-a", workspaceId: "workspace-a", jobIds: [input.jobId],
      expectedFiles: task.files.map(file => ({
        jobId: input.jobId,
        ...file,
        ...(file.path.endsWith(`${input.jobId}.json`) ? { path: outsidePath } : {}),
      })),
    });
    expect(escapedResult.deleted).toEqual([]);
    expect(escapedResult.skipped).toHaveLength(1);
    expect(ledger.get(input.jobId)).not.toBeNull();
    expect(readFileSync(outsidePath, "utf8")).toBe("keep");

    const persisted = JSON.parse(readFileSync(path.join(root, `${input.jobId}.status.json`), "utf8"));
    writeFileSync(path.join(root, `${input.jobId}.status.json`), JSON.stringify({
      ...persisted,
      status: { ...persisted.status, state: "running" },
    }), "utf8");
    const refreshedTask = ledger.listCleanupCandidates({ projectId: "project-a", workspaceId: "workspace-a" }).tasks[0];
    const changedStateResult = ledger.purgeFailedTaskRecords({
      projectId: "project-a", workspaceId: "workspace-a", jobIds: [input.jobId],
      expectedFiles: refreshedTask.files.map(file => ({ jobId: input.jobId, ...file })),
    });
    expect(changedStateResult.deleted).toEqual([]);
    expect(changedStateResult.skipped).toEqual([{
      jobId: input.jobId,
      reason: "The persisted task identity or terminal state changed since review.",
    }]);
  });

  it("restores the status record if removing the input record fails", () => {
    const root = mkdtempSync(path.join(tmpdir(), "reel-task-ledger-"));
    directories.push(root);
    const input: DurableTaskInput = {
      jobId: "job-purge-partial", kind: "export", projectId: "project-a", workspaceId: "workspace-a",
      sourceRevision: 3, inputProject: { id: "project-a" } as Project, parameters: null,
    };
    const ledger = new DurableTaskLedger(root, {
      unlinkRecordFile: filePath => {
        if (filePath.endsWith(`${input.jobId}.json`)) throw new Error("injected input unlink failure");
        unlinkSync(filePath);
      },
    });
    ledger.begin(input);
    ledger.update({ ...ledger.get(input.jobId)!.status, state: "cancelled" });
    const task = ledger.listCleanupCandidates({ projectId: "project-a", workspaceId: "workspace-a" }).tasks[0];

    const result = ledger.purgeFailedTaskRecords({
      projectId: "project-a", workspaceId: "workspace-a", jobIds: [input.jobId],
      expectedFiles: task.files.map(file => ({ jobId: input.jobId, ...file })),
    });
    expect(result.deleted).toEqual([]);
    expect(result.actualBytes).toBe(0);
    expect(result.failed).toEqual([{ jobId: input.jobId, reason: "Task record removal failed: injected input unlink failure" }]);
    expect(ledger.get(input.jobId)).not.toBeNull();
    expect(ledger.listCleanupCandidates({ projectId: "project-a", workspaceId: "workspace-a" }).tasks[0].files).toHaveLength(2);
  });

  it("does not let a pending progress timer recreate purged terminal task records", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "reel-task-ledger-"));
    directories.push(root);
    const ledger = new DurableTaskLedger(root, { progressWriteIntervalMs: 20 });
    const input: DurableTaskInput = {
      jobId: "job-purge-progress", kind: "export", projectId: "project-a", workspaceId: "workspace-a",
      sourceRevision: 3, inputProject: { id: "project-a" } as Project, parameters: null,
    };
    ledger.begin(input);
    const queued = ledger.get(input.jobId)!.status;
    const running = { ...queued, state: "running" as const };
    ledger.update(running);
    ledger.update({ ...running, progress: { phase: "rendering", percent: 0.25 } });
    ledger.update({ ...running, state: "error", error: { code: "FAILED", message: "failed" } });
    const task = ledger.listCleanupCandidates({ projectId: "project-a", workspaceId: "workspace-a" }).tasks[0];
    const result = ledger.purgeFailedTaskRecords({
      projectId: "project-a", workspaceId: "workspace-a", jobIds: [input.jobId],
      expectedFiles: task.files.map(file => ({ jobId: input.jobId, ...file })),
    });
    expect(result.deleted).toHaveLength(1);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(() => readFileSync(path.join(root, `${input.jobId}.json`))).toThrow();
    expect(() => readFileSync(path.join(root, `${input.jobId}.status.json`))).toThrow();
  });

  it("persists producer file ownership before a write and purges only its exact terminal work file", () => {
    const { root, input, ledger } = setup();
    ledger.begin({ ...input, kind: "audio-process" });
    const registry = new JobRegistry();
    registry.create(input.jobId, input.sourceRevision, "audio-process", {
      projectId: input.projectId, workspaceId: input.workspaceId,
    });
    registry.observe(input.jobId, status => ledger.update(status), "durable-task");
    registry.markRunning(input.jobId);

    const workPath = path.join(root, "generated", "unadopted.wav");
    mkdirSync(path.dirname(workPath), { recursive: true });
    registry.recordArtifactFile(input.jobId, {
      fileId: "audio-output",
      path: workPath,
      kind: "work",
      purpose: "Generated unadopted audio work output",
      rebuildable: true,
      deliveryStatus: "pending",
    });
    const persistedBeforeWrite = JSON.parse(readFileSync(path.join(root, `${input.jobId}.status.json`), "utf8"));
    expect(persistedBeforeWrite.status.artifactFiles).toEqual([{
      fileId: "audio-output", path: workPath, kind: "work", purpose: "Generated unadopted audio work output",
      origin: "agent", rebuildable: true, deliveryStatus: "pending",
    }]);

    writeFileSync(workPath, "derived wav bytes", "utf8");
    registry.markError(input.jobId, { code: "FAILED", message: "process failed" });
    const summary = ledger.listCleanupCandidates({ projectId: input.projectId, workspaceId: input.workspaceId });
    const candidate = summary.tasks[0]!.artifactFiles[0]!;
    expect(summary.artifactScanReady).toBe(true);
    expect(candidate).toMatchObject({
      fileId: "audio-output", path: workPath, kind: "work", sizeBytes: Buffer.byteLength("derived wav bytes"),
    });
    expect(candidate.lastModifiedMs).toBe(lstatSync(workPath).mtimeMs);

    const ledgerOnly = ledger.listCleanupCandidates({ projectId: input.projectId, workspaceId: input.workspaceId }).tasks[0]!;
    const recordPurge = ledger.purgeFailedTaskRecords({
      projectId: input.projectId, workspaceId: input.workspaceId, jobIds: [input.jobId],
      expectedFiles: ledgerOnly.files.map(file => ({ jobId: input.jobId, ...file })),
    });
    expect(recordPurge.deleted).toEqual([]);
    expect(recordPurge.skipped[0]?.reason).toContain("Tracked artifact files still exist");

    const result = ledger.purgeTrackedWorkFiles({
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      jobIds: [input.jobId],
      expectedFiles: [{
        jobId: input.jobId,
        fileId: candidate.fileId,
        path: candidate.path,
        sizeBytes: candidate.sizeBytes,
        lastModifiedMs: candidate.lastModifiedMs,
      }],
    });
    expect(result.deleted).toHaveLength(1);
    expect(result.actualBytes).toBe(Buffer.byteLength("derived wav bytes"));
    expect(() => lstatSync(workPath)).toThrow();
    expect(ledger.get(input.jobId)?.status.artifactFiles).toEqual([]);
    registry.forgetArtifactFile(input.jobId, "audio-output");
    expect(registry.get(input.jobId)?.artifactFiles).toEqual([]);
  });

  it.each(["manifest", "quarantined"])("blocks work-file removal when another task has a damaged %s", (damage) => {
    const { root, input, ledger } = setup();
    ledger.begin({ ...input, kind: "analysis" });
    const registry = new JobRegistry();
    registry.create(input.jobId, input.sourceRevision, "analysis", {
      projectId: input.projectId, workspaceId: input.workspaceId,
    });
    registry.observe(input.jobId, status => ledger.update(status), "durable-task");
    registry.recordArtifactFile(input.jobId, {
      fileId: "analysis-work", path: path.join(root, "generated", "analysis.json"), kind: "work",
      purpose: "Analysis work file", rebuildable: true, deliveryStatus: "pending",
    });
    const workPath = path.join(root, "generated", "analysis.json");
    mkdirSync(path.dirname(workPath), { recursive: true });
    writeFileSync(workPath, "analysis", "utf8");
    registry.markError(input.jobId, { code: "FAILED", message: "failed" });

    const otherInput = { ...input, jobId: "job-other-manifest", projectId: "project-b", inputProject: { id: "project-b" } as Project };
    ledger.begin(otherInput);
    const statusPath = path.join(root, `${otherInput.jobId}.status.json`);
    const statusDoc = JSON.parse(readFileSync(statusPath, "utf8"));
    statusDoc.status.artifactFiles = [{ fileId: "broken", path: workPath, kind: "not-a-kind" }];
    writeFileSync(statusPath, damage === "manifest" ? JSON.stringify(statusDoc) : '{"status":', "utf8");

    const restored = new DurableTaskLedger(root, { artifactRoots: [root] });
    const listing = restored.listCleanupCandidates({ projectId: input.projectId, workspaceId: input.workspaceId });
    expect(listing.artifactScanReady).toBe(false);
    const candidate = listing.tasks[0]!.artifactFiles[0]!;
    const result = restored.purgeTrackedWorkFiles({
      projectId: input.projectId, workspaceId: input.workspaceId, jobIds: [input.jobId],
      expectedFiles: [{ jobId: input.jobId, fileId: candidate.fileId, path: candidate.path,
        sizeBytes: candidate.sizeBytes, lastModifiedMs: candidate.lastModifiedMs }],
    });
    expect(result.deleted).toEqual([]);
    expect(result.skipped[0]?.reason.toLowerCase()).toContain(damage === "manifest" ? "malformed artifact manifest" : "quarantined");
    expect(readFileSync(workPath, "utf8")).toBe("analysis");
  });

  it("blocks a work file still referenced by another task result on disk", () => {
    const { root, input, ledger } = setup();
    ledger.begin({ ...input, kind: "audio-process" });
    const registry = new JobRegistry();
    registry.create(input.jobId, input.sourceRevision, "audio-process", {
      projectId: input.projectId, workspaceId: input.workspaceId,
    });
    registry.observe(input.jobId, status => ledger.update(status), "durable-task");
    const workPath = path.join(root, "audio-work.wav");
    registry.recordArtifactFile(input.jobId, {
      fileId: "audio-output", path: workPath, kind: "work", purpose: "Generated audio", rebuildable: true,
      deliveryStatus: "pending",
    });
    writeFileSync(workPath, "audio", "utf8");
    registry.markAudioProcessDone(input.jobId, { path: workPath } as never);

    const otherInput = { ...input, jobId: "job-result-reference", projectId: "project-b", inputProject: { id: "project-b" } as Project };
    ledger.begin(otherInput);
    ledger.update({
      ...ledger.get(otherInput.jobId)!.status,
      state: "done",
      result: { artifacts: [{ path: workPath }] } as never,
    });

    const listing = ledger.listCleanupCandidates({ projectId: input.projectId, workspaceId: input.workspaceId });
    const candidate = listing.tasks[0]!.artifactFiles[0]!;
    expect(candidate.retainedReason).toContain("Task job-result-reference result or artifact references this exact path");
    const result = ledger.purgeTrackedWorkFiles({
      projectId: input.projectId, workspaceId: input.workspaceId, jobIds: [input.jobId],
      expectedFiles: [{ jobId: input.jobId, fileId: candidate.fileId, path: candidate.path,
        sizeBytes: candidate.sizeBytes, lastModifiedMs: candidate.lastModifiedMs }],
    });
    expect(result.deleted).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("result or artifact references this exact path");
    expect(readFileSync(workPath, "utf8")).toBe("audio");
  });

  it("skips work files whose modification time changed after review", () => {
    const { root, input, ledger } = setup();
    const audioInput = { ...input, kind: "audio-process" as const };
    ledger.begin(audioInput);
    const registry = new JobRegistry();
    registry.create(input.jobId, input.sourceRevision, "audio-process", {
      projectId: input.projectId, workspaceId: input.workspaceId,
    });
    registry.observe(input.jobId, status => ledger.update(status), "durable-task");
    const workPath = path.join(root, "generated", "stale-fingerprint.wav");
    mkdirSync(path.dirname(workPath), { recursive: true });
    registry.recordArtifactFile(input.jobId, {
      fileId: "audio-output", path: workPath, kind: "work", purpose: "Generated audio", rebuildable: true,
      deliveryStatus: "pending",
    });
    writeFileSync(workPath, "same-size", "utf8");
    registry.markError(input.jobId, { code: "FAILED", message: "failed" });
    const candidate = ledger.listCleanupCandidates({ projectId: input.projectId, workspaceId: input.workspaceId })
      .tasks[0]!.artifactFiles[0]!;
    const updatedMtime = lstatSync(workPath).mtimeMs / 1000 + 5.25;
    utimesSync(workPath, updatedMtime, updatedMtime);

    const result = ledger.purgeTrackedWorkFiles({
      projectId: input.projectId, workspaceId: input.workspaceId, jobIds: [input.jobId],
      expectedFiles: [{ jobId: input.jobId, fileId: candidate.fileId, path: candidate.path,
        sizeBytes: candidate.sizeBytes, lastModifiedMs: candidate.lastModifiedMs }],
    });
    expect(result.deleted).toEqual([]);
    expect(result.skipped[0]?.reason).toBe("File changed since review.");
    expect(readFileSync(workPath, "utf8")).toBe("same-size");
  });

  it("does not remove a tracked output even when its exact fingerprint is supplied", () => {
    const { root, input, ledger } = setup();
    ledger.begin(input);
    const registry = new JobRegistry();
    registry.create(input.jobId, input.sourceRevision, "export", {
      projectId: input.projectId, workspaceId: input.workspaceId,
    });
    registry.observe(input.jobId, status => ledger.update(status), "durable-task");
    const outputPath = path.join(root, "output.mp4");
    registry.recordArtifactFile(input.jobId, {
      fileId: "export-output", path: outputPath, kind: "work", purpose: "Video export", rebuildable: true,
      deliveryStatus: "pending",
    });
    writeFileSync(outputPath, "finished movie", "utf8");
    registry.markDone(input.jobId, {
      kind: "video", format: "mp4", path: outputPath, sizeBytes: Buffer.byteLength("finished movie"),
      sha256: "ab".repeat(32), sourceRevision: input.sourceRevision,
    }, "chromium-frames-ffmpeg");
    const candidate = ledger.listCleanupCandidates({ projectId: input.projectId, workspaceId: input.workspaceId })
      .tasks[0]!.artifactFiles[0]!;
    expect(candidate.kind).toBe("output");
    expect(candidate.retainedReason).toContain("only producer-registered work files");

    const result = ledger.purgeTrackedWorkFiles({
      projectId: input.projectId, workspaceId: input.workspaceId, jobIds: [input.jobId],
      expectedFiles: [{ jobId: input.jobId, fileId: candidate.fileId, path: candidate.path,
        sizeBytes: candidate.sizeBytes, lastModifiedMs: candidate.lastModifiedMs }],
    });
    expect(result.deleted).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("no longer owns this exact eligible work file");
    expect(readFileSync(outputPath, "utf8")).toBe("finished movie");
  });

  it("shows a work file as retained when another task delivered to the same path", () => {
    const { root, input, ledger } = setup();
    ledger.begin({ ...input, kind: "audio-process" });
    const registry = new JobRegistry();
    registry.create(input.jobId, input.sourceRevision, "audio-process", {
      projectId: input.projectId, workspaceId: input.workspaceId,
    });
    registry.observe(input.jobId, status => ledger.update(status), "durable-task");
    const workPath = path.join(root, "shared-output.wav");
    registry.recordArtifactFile(input.jobId, {
      fileId: "audio-output", path: workPath, kind: "work", purpose: "Generated audio", rebuildable: true,
      deliveryStatus: "pending",
    });
    writeFileSync(workPath, "audio", "utf8");
    registry.markAudioProcessDone(input.jobId, { path: workPath } as never);

    const deliveredInput = { ...input, jobId: "job-delivered-reference", projectId: "project-b", inputProject: { id: "project-b" } as Project };
    ledger.begin(deliveredInput);
    ledger.update({ ...ledger.get(deliveredInput.jobId)!.status, state: "done", deliveredTo: workPath });

    const listing = ledger.listCleanupCandidates({ projectId: input.projectId, workspaceId: input.workspaceId });
    expect(listing.tasks[0]!.artifactFiles[0]!.retainedReason)
      .toBe("Task job-delivered-reference delivered this exact path.");
  });

  it.each(["file-url-result", "malformed-file-url", "active-export-destination"])(
    "rechecks %s references written after the cleanup review",
    referenceKind => {
      const { root, input, ledger } = setup();
      const audioInput = { ...input, kind: "audio-process" as const };
      ledger.begin(audioInput);
      const registry = new JobRegistry();
      registry.create(input.jobId, input.sourceRevision, "audio-process", {
        projectId: input.projectId, workspaceId: input.workspaceId,
      });
      registry.observe(input.jobId, status => ledger.update(status), "durable-task");
      const workPath = path.join(root, "late-reference.wav");
      registry.recordArtifactFile(input.jobId, {
        fileId: "audio-output", path: workPath, kind: "work", purpose: "Generated audio", rebuildable: true,
        deliveryStatus: "pending",
      });
      writeFileSync(workPath, "audio", "utf8");
      registry.markError(input.jobId, { code: "FAILED", message: "failed" });
      const candidate = ledger.listCleanupCandidates({ projectId: input.projectId, workspaceId: input.workspaceId })
        .tasks[0]!.artifactFiles[0]!;

      const otherInput = {
        ...input,
        jobId: "job-late-reference",
        kind: "export" as const,
        projectId: "project-b",
        inputProject: { id: "project-b" } as Project,
        parameters: { destinationPath: null },
      };
      ledger.begin(otherInput);
      const statusPath = path.join(root, `${otherInput.jobId}.status.json`);
      const statusDoc = JSON.parse(readFileSync(statusPath, "utf8"));
      if (referenceKind === "active-export-destination") {
        const inputPath = path.join(root, `${otherInput.jobId}.json`);
        const inputDoc = JSON.parse(readFileSync(inputPath, "utf8"));
        inputDoc.parameters.destinationPath = workPath;
        writeFileSync(inputPath, JSON.stringify(inputDoc), "utf8");
        statusDoc.status.state = "running";
      } else {
        statusDoc.status.state = "done";
        const referencedPath = referenceKind === "file-url-result"
          ? pathToFileURL(workPath).href
          : "file:///E:/invalid%ZZpath.wav";
        statusDoc.status.result = { artifacts: [{ path: referencedPath }] };
      }
      writeFileSync(statusPath, JSON.stringify(statusDoc), "utf8");

      const result = ledger.purgeTrackedWorkFiles({
        projectId: input.projectId, workspaceId: input.workspaceId, jobIds: [input.jobId],
        expectedFiles: [{ jobId: input.jobId, fileId: candidate.fileId, path: candidate.path,
          sizeBytes: candidate.sizeBytes, lastModifiedMs: candidate.lastModifiedMs }],
      });
      expect(result.deleted).toEqual([]);
      expect(result.skipped[0]?.reason).toContain(referenceKind === "active-export-destination"
        ? "targets this exact destination path"
        : "result or artifact references this exact path");
      expect(readFileSync(workPath, "utf8")).toBe("audio");
    },
  );
});
