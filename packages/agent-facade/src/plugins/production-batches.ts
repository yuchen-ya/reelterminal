import { randomUUID } from "node:crypto";
import { lstat, writeFile } from "node:fs/promises";
import {
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  readFileSync,
  lstatSync,
} from "node:fs";
import { join } from "node:path";
import { definePlugin, defineTool, type ToolContext } from "../plugin-api";
import { FacadeError } from "../errors";
import { requireArtifactRoot, prepareArtifactDir } from "../artifact-io";
import {
  isNonEmptyString,
  isNonNegativeInteger,
  validateObject,
  type ObjectSchema,
} from "../validate";
import type { JobStatusView, MediaAnalyzeStartParams } from "../types";

const LOCAL_TYPES = [
  "technicalQuality",
  "sceneCuts",
  "blackFrames",
  "duplicateFrames",
] as const;
export interface BatchInput {
  batchId: string;
  mediaIds: string[];
  analysisTypes: (typeof LOCAL_TYPES)[number][];
  expectedRevision: number;
}
export interface BatchItem {
  input: MediaAnalyzeStartParams;
  jobId: string | null;
  status: JobStatusView | null;
  error: string | null;
}
export interface BatchRecord {
  batchId: string;
  projectId: string;
  sourceRevision: number;
  sourceModifiedAt: number;
  items: BatchItem[];
}
const idField: ObjectSchema[string] = {
  required: true,
  check: (v: unknown) =>
    typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(v),
  describe:
    "Unique batch identifier, letters/digits/underscore/hyphen, at most 80 characters",
  emits: {
    kind: "leaf" as const,
    schema: { type: "string", minLength: 1, maxLength: 80 },
  },
};
const listField: ObjectSchema[string] = {
  required: true,
  check: (v: unknown) =>
    Array.isArray(v) &&
    v.length > 0 &&
    v.length <= 20 &&
    v.every(isNonEmptyString) &&
    new Set(v).size === v.length,
  describe: "1-20 unique project media IDs",
  emits: {
    kind: "leaf" as const,
    schema: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: { type: "string", minLength: 1 },
    },
  },
};
const inputSchema: ObjectSchema = {
  batchId: idField,
  mediaIds: listField,
  analysisTypes: {
    required: true,
    check: (v: unknown) =>
      Array.isArray(v) &&
      v.length > 0 &&
      v.length <= 4 &&
      v.every((type) => LOCAL_TYPES.includes(type)) &&
      new Set(v).size === v.length,
    describe: "Existing local analysis jobs only",
    emits: {
      kind: "leaf" as const,
      schema: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: { enum: [...LOCAL_TYPES] },
      },
    },
  },
  expectedRevision: {
    required: true,
    check: isNonNegativeInteger,
    describe: "Project revision captured before the batch",
    emits: { kind: "leaf" as const, schema: { type: "integer", minimum: 0 } },
  },
};
const output = {
  type: "object" as const,
  additionalProperties: true,
  properties: {},
};
const active = new Set<string>();

async function location(context: ToolContext, id: string): Promise<string> {
  const root = requireArtifactRoot(context.artifactRoot, "batch");
  const dir = join(root, "production-batches");
  await prepareArtifactDir(dir, root, "batch");
  const file = join(dir, `${id}.json`);
  try {
    if (!(await lstat(file)).isFile())
      throw new FacadeError(
        "INVALID_PARAMS",
        "Batch manifest must be a regular file, never a symlink",
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return file;
}

/** Small job records are flushed synchronously so completion cannot outrun its checkpoint. */
function save(file: string, batch: BatchRecord): void {
  if (!lstatSync(file).isFile())
    throw new Error("Batch manifest must remain a regular file");
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx");
  try {
    writeFileSync(fd, JSON.stringify(batch));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
}

function observeItem(file: string, jobId: string, context: ToolContext): void {
  context.analysisJobs!.observe(jobId, (status) => {
    if (!lstatSync(file).isFile())
      throw new Error("Batch manifest must remain a regular file");
    const latest = JSON.parse(readFileSync(file, "utf8")) as BatchRecord;
    const item = latest.items.find((entry) => entry.jobId === jobId);
    if (!item) throw new Error(`Batch no longer contains job ${jobId}`);
    item.status = status;
    item.error = status.error?.message ?? null;
    save(file, latest);
  });
}

function load(file: string): BatchRecord {
  // Keep the read/close in this event-loop turn. On Windows, an asynchronous
  // read can hold the target open while a job observer tries to rename over it.
  const batch = JSON.parse(readFileSync(file, "utf8")) as BatchRecord;
  if (
    !batch ||
    !Array.isArray(batch.items) ||
    batch.items.some(
      (item) =>
        !item ||
        !item.input ||
        typeof item.input !== "object" ||
        (item.jobId !== null && typeof item.jobId !== "string") ||
        (item.error !== null && typeof item.error !== "string") ||
        (item.status !== null &&
          (!item.status ||
            !["queued", "running", "done", "error", "cancelled"].includes(
              item.status.state,
            ))),
    )
  )
    throw new FacadeError("INVALID_PARAMS", "Invalid batch manifest");
  validateObject(
    {
      batchId: batch.batchId,
      mediaIds: batch.items.map((item) => item.input.mediaId),
      analysisTypes: batch.items[0]?.input.analysisTypes,
      expectedRevision: batch.sourceRevision,
    },
    inputSchema,
    "Stored batch",
  );
  if (
    typeof batch.projectId !== "string" ||
    !Number.isFinite(batch.sourceModifiedAt) ||
    batch.items.some(
      (item) =>
        !item.input ||
        item.input.cloudUpload ||
        JSON.stringify(item.input.analysisTypes) !==
          JSON.stringify(batch.items[0].input.analysisTypes),
    )
  )
    throw new FacadeError("INVALID_PARAMS", "Invalid batch manifest inputs");
  return batch;
}

function refresh(batch: BatchRecord, context: ToolContext): void {
  if (!context.analysisJobs)
    throw new FacadeError("UNSUPPORTED", "Analysis jobs unavailable");
  for (const item of batch.items) {
    if (!item.jobId) continue;
    const status = context.analysisJobs.current(item.jobId);
    if (status) {
      item.status = status;
      item.error = status.error?.message ?? null;
    }
  }
}

async function startItems(
  batch: BatchRecord,
  file: string,
  context: ToolContext,
  retry: readonly string[] = [],
  expectedRevision = batch.sourceRevision,
): Promise<void> {
  if (!context.analysisJobs)
    throw new FacadeError("UNSUPPORTED", "Analysis jobs unavailable");
  const snapshot = await context.snapshot();
  if (
    snapshot.project.id !== batch.projectId ||
    snapshot.revision !== expectedRevision ||
    snapshot.project.modifiedAt !== batch.sourceModifiedAt
  )
    throw new FacadeError(
      "CONFLICT",
      "Project changed since batch creation. Create a new batch; apply results only with current identity and expectedRevision.",
    );
  refresh(batch, context);
  for (const id of retry) {
    const item = batch.items.find((entry) => entry.input.mediaId === id);
    if (!item || (item.status?.state !== "error" && item.error === null))
      throw new FacadeError(
        "INVALID_PARAMS",
        "retryMediaIds must name failed batch items",
      );
  }
  for (const item of batch.items) {
    if (item.status?.state === "done") continue;
    if (
      (item.status?.state === "error" || item.error) &&
      !retry.includes(item.input.mediaId)
    )
      continue;
    if (item.jobId && !retry.includes(item.input.mediaId)) {
      const existing = context.analysisJobs.current(item.jobId);
      if (existing && ["running", "queued"].includes(existing.state)) {
        observeItem(file, item.jobId, context);
        continue;
      }
    }
    // Never trust arbitrary persisted fields as new execution parameters.
    item.input = {
      mediaId: item.input.mediaId,
      analysisTypes: item.input.analysisTypes,
      expectedRevision,
    };
    const result = await context.analysisJobs.start(item.input);
    item.error = result.ok ? null : result.error.message;
    item.jobId = result.ok ? result.value.jobId : null;
    item.status = null;
    refresh(batch, context);
    save(file, batch);
    if (item.jobId) observeItem(file, item.jobId, context);
  }
}

export const productionBatchesPlugin = definePlugin({
  id: "production-batches",
  tools: [
    defineTool({
      name: "batch.start",
      effect: "read",
      requires: ["artifactRoot"],
      input: inputSchema,
      output,
      description:
        "Persist and start up to 20 existing local media analysis jobs. Records inputs, parameters, job IDs, states and results under artifactRoot. Job transitions and terminal results are flushed automatically before publication. Never imports, replaces or edits the project. Select source versions with media.production_list first.",
      schemaCases: [
        {
          name: "valid",
          params: {
            batchId: "review-1",
            mediaIds: ["m1"],
            analysisTypes: ["technicalQuality"],
            expectedRevision: 0,
          },
          expectValid: true,
        },
        { name: "missing", params: {}, expectValid: false },
      ],
      async execute(input: BatchInput, context) {
        const file = await location(context, input.batchId);
        const snapshot = await context.snapshot();
        if (snapshot.revision !== input.expectedRevision)
          throw new FacadeError("CONFLICT", "Project revision changed");
        if (
          input.mediaIds.some(
            (id) =>
              !snapshot.project.mediaLibrary.items.some(
                (media) => media.id === id,
              ),
          )
        )
          throw new FacadeError("NOT_FOUND", "Batch input media not found");
        const batch: BatchRecord = {
          batchId: input.batchId,
          projectId: snapshot.project.id,
          sourceRevision: snapshot.revision,
          sourceModifiedAt: snapshot.project.modifiedAt,
          items: input.mediaIds.map((mediaId) => ({
            input: {
              mediaId,
              analysisTypes: input.analysisTypes,
              expectedRevision: input.expectedRevision,
            },
            jobId: null,
            status: null,
            error: null,
          })),
        };
        if (active.has(file))
          throw new FacadeError("CONFLICT", "Batch is active");
        active.add(file);
        try {
          await writeFile(file, JSON.stringify(batch), { flag: "wx" });
          await startItems(batch, file, context);
          return batch;
        } finally {
          active.delete(file);
        }
      },
    }),
    defineTool({
      name: "batch.get",
      effect: "read",
      requires: ["artifactRoot"],
      input: { batchId: idField },
      output,
      description:
        "Read an automatically checkpointed analysis batch. Individual jobs retain job.status and job.cancel. Completed jobs remain completed after restart without polling batch.get.",
      schemaCases: [
        { name: "valid", params: { batchId: "review-1" }, expectValid: true },
        { name: "missing", params: {}, expectValid: false },
      ],
      async execute(input: { batchId: string }, context) {
        const file = await location(context, input.batchId);
        if (active.has(file))
          throw new FacadeError(
            "CONFLICT",
            "Batch is starting; retry get after start/resume completes",
          );
        active.add(file);
        try {
          const batch = load(file);
          refresh(batch, context);
          save(file, batch);
          return batch;
        } finally {
          active.delete(file);
        }
      },
    }),
    defineTool({
      name: "batch.resume",
      effect: "read",
      requires: ["artifactRoot"],
      input: {
        batchId: idField,
        retryMediaIds: { ...listField, required: false },
        expectedRevision: {
          ...inputSchema.expectedRevision,
          required: false,
          describe:
            "Current session revision after reopening the unchanged project; project identity and modification time must still match",
        },
      },
      output,
      description:
        "Resume unfinished local analysis batch items; skip completed and still-running jobs. Failed items run only when explicitly listed in retryMediaIds. Refuse changed project identity/revision. Results are candidates; use edit.validate/apply with revision guards for any subsequent backfill.",
      schemaCases: [
        { name: "valid", params: { batchId: "review-1" }, expectValid: true },
        {
          name: "path traversal",
          params: { batchId: "../x" },
          expectValid: false,
          schemaValid: true,
        },
      ],
      async execute(
        input: {
          batchId: string;
          retryMediaIds?: string[];
          expectedRevision?: number;
        },
        context,
      ) {
        const file = await location(context, input.batchId);
        if (active.has(file))
          throw new FacadeError("CONFLICT", "Batch is active");
        active.add(file);
        try {
          const batch = load(file);
          await startItems(
            batch,
            file,
            context,
            input.retryMediaIds,
            input.expectedRevision,
          );
          return batch;
        } finally {
          active.delete(file);
        }
      },
    }),
  ],
});
