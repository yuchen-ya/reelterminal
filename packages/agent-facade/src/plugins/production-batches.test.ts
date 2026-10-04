import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bindTools, type ToolContext } from "../plugin-api";
import { productionBatchesPlugin } from "./production-batches";
import { createEmptyProject } from "../project-factory";
import { JobRegistry, jobStatusView } from "../jobs";
import { ok, fail, FacadeError } from "../errors";
import type { MediaItem } from "@reelterminal/core/types/project";

describe("durable local analysis batches", () => {
  let root: string;
  let registry: JobRegistry;
  let context: ToolContext;
  let starts: string[];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "production-batch-"));
    registry = new JobRegistry();
    starts = [];
    const project = createEmptyProject("Batch");
    project.mediaLibrary.items.push(
      ...["m1", "m2"].map((id) => ({ id }) as MediaItem),
    );
    context = {
      mode: "headless",
      artifactRoot: root,
      mediaRoots: [],
      snapshot: async () => ({ project, revision: 3 }),
      resolveMediaPath: async () => "unused",
      analysisJobs: {
        current: (id) => {
          const job = registry.get(id);
          return job ? jobStatusView(job) : null;
        },
        observe: (id, persist) => registry.observe(id, persist),
        start: async (input) => {
          starts.push(input.mediaId);
          const job = registry.create(`job-${starts.length}`, 3, "analysis");
          registry.markRunning(job.jobId);
          return ok({
            jobId: job.jobId,
            kind: "analysis",
            state: "running",
            sourceRevision: 3,
            analysisTypes: input.analysisTypes,
            replayed: false,
          });
        },
        status: async ({ jobId }) => {
          const job = registry.get(jobId);
          return job
            ? ok(jobStatusView(job))
            : fail(new FacadeError("NOT_FOUND", "Job not found"));
        },
      },
    };
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const input = {
    batchId: "review-1",
    mediaIds: ["m1", "m2"],
    analysisTypes: ["technicalQuality" as const],
    expectedRevision: 3,
  };

  it("automatically checkpoints cancellation and exposes storage failures without false completion", async () => {
    const tools = bindTools(productionBatchesPlugin.tools, context);
    await tools["batch.start"](input);
    registry.markCancelled("job-1");
    const file = join(root, "production-batches", "review-1.json");
    expect(JSON.parse(await readFile(file, "utf8")).items[0].status.state).toBe(
      "cancelled",
    );
    await rm(file);
    registry.markAnalysisDone("job-2", {
      analysisTypes: ["technicalQuality"],
      summary: {},
      artifacts: [],
    });
    expect(registry.get("job-2")).toMatchObject({
      state: "error",
      result: null,
      error: { code: "BATCH_PERSISTENCE_FAILED" },
    });
  });

  it("resumes after a session revision reset only with an explicit current revision and unchanged project", async () => {
    const tools = bindTools(productionBatchesPlugin.tools, context);
    await tools["batch.start"](input);
    registry = new JobRegistry();
    const snapshot = await context.snapshot();
    const reopened = bindTools(productionBatchesPlugin.tools, {
      ...context,
      snapshot: async () => ({ ...snapshot, revision: 0 }),
    });
    expect(
      (await reopened["batch.resume"]({ batchId: input.batchId })).ok,
    ).toBe(false);
    expect(
      (
        await reopened["batch.resume"]({
          batchId: input.batchId,
          expectedRevision: 0,
        })
      ).ok,
    ).toBe(true);
    expect(starts).toHaveLength(4);
    const changed = bindTools(productionBatchesPlugin.tools, {
      ...context,
      snapshot: async () => ({
        project: {
          ...snapshot.project,
          modifiedAt: snapshot.project.modifiedAt + 1,
        },
        revision: 0,
      }),
    });
    expect(
      (
        await changed["batch.resume"]({
          batchId: input.batchId,
          expectedRevision: 0,
        })
      ).ok,
    ).toBe(false);
  });

  it("persists completed results, recovers only unfinished items and refuses changed projects", async () => {
    let tools = bindTools(productionBatchesPlugin.tools, context);
    expect((await tools["batch.start"](input)).ok).toBe(true);
    registry.markAnalysisDone("job-1", {
      analysisTypes: ["technicalQuality"],
      summary: { measured: true },
      artifacts: [],
    });
    // No polling: terminal publication must already have flushed the manifest.
    const saved = JSON.parse(
      await readFile(join(root, "production-batches", "review-1.json"), "utf8"),
    );
    expect(saved.items[0].status.result.summary).toEqual({ measured: true });
    registry = new JobRegistry(); // process restart; persisted completed item survives
    tools = bindTools(productionBatchesPlugin.tools, context);
    expect((await tools["batch.resume"]({ batchId: input.batchId })).ok).toBe(
      true,
    );
    expect(starts).toEqual(["m1", "m2", "m2"]);
    const snapshot = await context.snapshot();
    const changed = bindTools(productionBatchesPlugin.tools, {
      ...context,
      snapshot: async () => ({ ...snapshot, revision: 4 }),
    });
    const conflict = await changed["batch.resume"]({ batchId: input.batchId });
    expect(!conflict.ok && conflict.error.code).toBe("CONFLICT");
  });

  it("does not duplicate running jobs and retries failures only when explicitly selected", async () => {
    const tools = bindTools(productionBatchesPlugin.tools, context);
    await tools["batch.start"](input);
    registry.markError("job-1", { code: "JOB_FAILED", message: "Bad input" });
    await tools["batch.resume"]({ batchId: input.batchId });
    expect(starts).toHaveLength(2);
    await tools["batch.resume"]({
      batchId: input.batchId,
      retryMediaIds: ["m1"],
    });
    expect(starts).toEqual(["m1", "m2", "m1"]);
    expect((await tools["batch.start"](input)).ok).toBe(false);
    expect(starts).toHaveLength(3);
  });
});
