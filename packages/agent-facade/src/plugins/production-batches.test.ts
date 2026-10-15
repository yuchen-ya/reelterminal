import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bindTools, type ToolContext } from "../plugin-api";
import { productionBatchesPlugin } from "./production-batches";
import { createEmptyProject } from "../project-factory";
import { JobRegistry, jobStatusView } from "../jobs";
import { ok, fail, FacadeError } from "../errors";
import type { MediaItem } from "@reelterminal/core/types/project";
import type { JobStatusView } from "../types";
import { readdirSync } from "node:fs";
import { Worker } from "node:worker_threads";

const renameFault = vi.hoisted(() => ({ codes: [] as string[], attempts: 0 }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: (...args: Parameters<typeof actual.renameSync>) => {
    renameFault.attempts += 1;
    const code = renameFault.codes.shift();
    if (code) throw Object.assign(new Error(`injected rename ${code}`), { code });
    return actual.renameSync(...args);
  } };
});

describe("durable local analysis batches", () => {
  let root: string;
  let registry: JobRegistry;
  let context: ToolContext;
  let starts: string[];
  beforeEach(async () => {
    renameFault.codes = [];
    renameFault.attempts = 0;
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

  it.runIf(process.platform === "win32")("commits a terminal checkpoint after transient Windows sharing errors", async () => {
    const tools = bindTools(productionBatchesPlugin.tools, context);
    await tools["batch.start"](input);
    renameFault.codes = ["EPERM", "EBUSY"];
    const before = renameFault.attempts;
    registry.markAnalysisDone("job-1", { analysisTypes: ["technicalQuality"], summary: {}, artifacts: [] });
    expect(renameFault.attempts - before).toBe(3);
    expect(registry.get("job-1")?.state).toBe("done");
    const saved = JSON.parse(await readFile(join(root, "production-batches", "review-1.json"), "utf8"));
    expect(saved.items[0].status.state).toBe("done");
    expect(readdirSync(join(root, "production-batches")).filter(file => file.endsWith(".tmp"))).toEqual([]);
  });

  it.runIf(process.platform === "win32")("preserves completed results while another thread reads real checkpoint files", async () => {
    const tools = bindTools(productionBatchesPlugin.tools, context);
    await tools["batch.start"](input);
    registry.markAnalysisDone("job-1", { analysisTypes: ["technicalQuality"], summary: { measured: true }, artifacts: [] });
    const file = join(root, "production-batches", "review-1.json");
    const stop = new SharedArrayBuffer(4);
    const reader = new Worker(`
      const { workerData, parentPort } = require('node:worker_threads');
      const { readFileSync } = require('node:fs');
      const stop = new Int32Array(workerData.stop);
      parentPort.postMessage('ready');
      while (!Atomics.load(stop, 0)) JSON.parse(readFileSync(workerData.file, 'utf8'));
    `, { eval: true, workerData: { stop, file } });
    const finished = new Promise<void>((resolve, reject) => { reader.once("exit", () => resolve()); reader.once("error", reject); });
    try {
      await new Promise<void>(resolve => reader.once("message", () => resolve()));
      for (let count = 0; count < 200; count += 1) {
        const current = await tools["batch.get"]({ batchId: input.batchId });
        expect(current.ok, JSON.stringify(current)).toBe(true);
      }
    } finally {
      Atomics.store(new Int32Array(stop), 0, 1);
      await finished;
    }
    expect(JSON.parse(await readFile(file, "utf8")).items[0].status.result.summary).toEqual({ measured: true });
  });

  it.each(["EPERM", "EIO"])("keeps the last good checkpoint and reports persistent %s", async code => {
    const tools = bindTools(productionBatchesPlugin.tools, context);
    await tools["batch.start"](input);
    const file = join(root, "production-batches", "review-1.json");
    const before = await readFile(file, "utf8");
    renameFault.codes = Array(10).fill(code);
    const attempts = renameFault.attempts;
    registry.markAnalysisDone("job-1", { analysisTypes: ["technicalQuality"], summary: {}, artifacts: [] });
    expect(registry.get("job-1")).toMatchObject({ state: "error", result: null, error: { code: "BATCH_PERSISTENCE_FAILED" } });
    // The registry also attempts to checkpoint its resulting error status.
    expect(renameFault.attempts - attempts).toBe(code === "EPERM" && process.platform === "win32" ? 10 : 2);
    expect(await readFile(file, "utf8")).toBe(before);
    expect(readdirSync(join(root, "production-batches")).filter(file => file.endsWith(".tmp"))).toEqual([]);
  });

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
    const savedResult = saved.items[0].status.result;
    if (!savedResult || !("summary" in savedResult)) throw new Error("completed analysis has no analysis result");
    expect(savedResult.summary).toEqual({ measured: true });
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

  it("compacts legacy dense audio results from a batch manifest when the registry has no job", async () => {
    const tools = bindTools(productionBatchesPlugin.tools, context);
    await tools["batch.start"](input);

    const file = join(root, "production-batches", "review-1.json");
    const batch = JSON.parse(await readFile(file, "utf8")) as import("./production-batches").BatchRecord;
    const legacyStatus: JobStatusView = {
      jobId: "job-legacy-audio",
      kind: "analysis",
      state: "done",
      progress: null,
      artifact: null,
      result: {
        analysisTypes: ["audioSummary"],
        summary: {
          audioSummary: {
            waveform: Array.from({ length: 650 }, (_, index) => ({ startSec: index / 100, endSec: (index + 1) / 100, rms: 0.2, peak: 0.4 })),
            onsets: [{ timeSec: 1 }],
            silence: [],
            integratedLufs: -18,
          },
        },
        artifacts: [],
      },
      error: null,
      deliveredTo: null,
      deliveryError: null,
      sourceRevision: 3,
      route: null,
      upscalingRequestedButInactive: false,
      cancelRequested: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    };
    batch.items[0]!.jobId = legacyStatus.jobId;
    batch.items[0]!.status = legacyStatus;
    await writeFile(file, JSON.stringify(batch));

    registry = new JobRegistry(); // After restart, current() has no entry for this old job.
    const recovered = await bindTools(productionBatchesPlugin.tools, context)["batch.get"]({ batchId: input.batchId });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    const recoveredBatch = recovered.value as typeof batch;
    const recoveredResult = recoveredBatch.items[0]!.status!.result;
    if (!recoveredResult || !("summary" in recoveredResult)) throw new Error("recovered analysis has no analysis result");
    const audio = recoveredResult.summary.audioSummary as Record<string, unknown>;
    expect(audio).toMatchObject({ integratedLufs: -18 });
    expect(audio).not.toHaveProperty("waveform");
    expect(audio).not.toHaveProperty("onsets");
    expect(audio).not.toHaveProperty("silence");

    const persisted = JSON.parse(await readFile(file, "utf8")) as typeof batch;
    const persistedResult = persisted.items[0]!.status!.result;
    if (!persistedResult || !("summary" in persistedResult)) throw new Error("persisted analysis has no analysis result");
    expect(persistedResult.summary.audioSummary).not.toHaveProperty("waveform");
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
