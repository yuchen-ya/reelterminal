import { type FacadeResult } from "./errors";
import { isNonNegativeInteger, isPlainObject, matchesSchema, type ObjectSchema } from "./validate";
type FieldRule = ObjectSchema[string];
import { WORKBENCH_INGEST_ITEM_SCHEMA, WORKBENCH_CONTENT_VARIANTS, WORKBENCH_CONTENT_UPDATE_OP_SCHEMA, WORKBENCH_DECIDE_OP_SCHEMA, WORKBENCH_DECIDE_TARGET_SCHEMA,
  WORKBENCH_FEEDBACK_OP_SCHEMA, WORKBENCH_FEEDBACK_SAVE_OP_SCHEMA, WORKBENCH_HANDOFF_ACK_OP_SCHEMA, WORKBENCH_REWORK_OP_SCHEMA, WORKBENCH_REWORK_RESULT_SCHEMA, workbenchIngestInput } from "./workbench";
import type { WorkbenchIngestItem, WorkbenchIngestParams } from "./types";
import { validateReviewParameters } from "@reelterminal/core/review/steps";
import type { ReviewJson } from "@reelterminal/core/review/types";

export const REVIEW_VERBS = [
  "review.nodes.list", "review.nodes.create", "review.directory.get", "review.directory.apply", "review.directory.history.control",
  "review.get", "review.ingest", "review.apply", "review.changes", "review.handoff.get", "review.versions.get", "review.history.control",
  "review.export.prepare", "review.export.status", "review.export.cancel", "review.export.copy",
  "review.steps.start", "review.steps.complete", "review.steps.fail", "review.steps.list",
  "review.package.inspect", "review.package.restore", "review.attach", "review.media.inspect", "review.frames.extract",
] as const;
export type ReviewVerb = typeof REVIEW_VERBS[number];
export type ReviewFacadeBindings = { readonly [Verb in ReviewVerb]: (params: Record<string, unknown>) => Promise<FacadeResult<unknown>> };
export type ReviewBridge = (verb: ReviewVerb, params: Record<string, unknown>) => Promise<unknown>;
const uuidPattern = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const uuid = (value: unknown): boolean => typeof value === "string" && new RegExp(uuidPattern).test(value);
const uuidField = (required = true): FieldRule => ({ check: uuid, describe: "a UUID", required, emits: { kind: "leaf", schema: { type: "string", pattern: uuidPattern } } });
const revision: FieldRule = { check: isNonNegativeInteger, describe: "a monotonic nonnegative storage revision", required: true, emits: { kind: "leaf", schema: { type: "integer", minimum: 0 } } };
function target(nodeRequired: boolean) {
  const schema: ObjectSchema = {
    kind: { check: value => value === "review", describe: '"review"', required: true, emits: { kind: "leaf", schema: { const: "review" } } },
    reviewWorkspaceId: uuidField(), instanceId: uuidField(), nodeId: uuidField(nodeRequired),
  };
  return { check: (value: unknown) => matchesSchema(value, schema), describe: "an explicit independent review target", required: true, emits: { kind: "object" as const, schema } };
}
const page: ObjectSchema = {
  limit: { check: value => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 500, describe: "a page size from 1 to 500", emits: { kind: "leaf", schema: { type: "integer", minimum: 1, maximum: 500 } } },
  cursor: { check: value => typeof value === "string" && value.length <= 500, describe: "the preceding page cursor", emits: { kind: "leaf", schema: { type: "string", maxLength: 500 } } },
};
const name: FieldRule = { check: (value: unknown) => typeof value === "string" && value.trim().length > 0 && value.length <= 200, describe: "a name of 1–200 characters", required: true, emits: { kind: "leaf", schema: { type: "string", minLength: 1, maxLength: 200 } } };
const optionalName = { ...name, required: false };
const booleanField: FieldRule = { check: value => typeof value === "boolean", describe: "a boolean", emits: { kind: "leaf", schema: { type: "boolean" } } };
const direction: FieldRule = { check: value => value === "undo" || value === "redo", describe: '"undo" or "redo"', required: true, emits: { kind: "leaf", schema: { enum: ["undo", "redo"] } } };
const nodePatch: ObjectSchema = { name: optionalName, pinned: booleanField, archived: booleanField, trashed: booleanField,
  groupId: { check: value => value === null || uuid(value), describe: "a group UUID or null to ungroup", emits: { kind: "leaf", schema: { type: ["string", "null"] } } } };
const kind = (value: string): FieldRule => ({ check: candidate => candidate === value, describe: value, required: true, emits: { kind: "leaf", schema: { const: value } } });
const directoryCommands: readonly ObjectSchema[] = [
  { kind: kind("node.create"), name },
  { kind: kind("node.update"), nodeId: uuidField(), patch: { check: value => matchesSchema(value, nodePatch), describe: "node display metadata", required: true, emits: { kind: "object", schema: nodePatch } } },
  { kind: kind("group.create"), name },
  { kind: kind("group.update"), groupId: uuidField(), name: optionalName, order: { ...revision, required: false } },
  { kind: kind("group.remove"), groupId: uuidField() },
];
const contentVariants = WORKBENCH_CONTENT_VARIANTS.map(schema => ({ ...schema, ...("mediaId" in schema ? { mediaId: uuidField() } : "resourceId" in schema ? { resourceId: uuidField() } : {}) }));
const content: FieldRule = { check: value => contentVariants.some(schema => matchesSchema(value, schema)), describe: "real text/data/image/video/model3d content; image/video mediaId and model3d resourceId are registered FileResource UUIDs", required: true, emits: { kind: "anyOfObjects", variants: contentVariants } };
export type ReviewIngestItem = WorkbenchIngestItem & { readonly originalResourceId?: string };
export function reviewIngestInput(params: Pick<WorkbenchIngestParams, "batchId" | "name" | "description"> & { readonly items: readonly ReviewIngestItem[] }, now: number) {
  const input = workbenchIngestInput(params, now);
  return { ...input, items: input.items.map((item, index) => ({ ...item,
    ...(params.items[index].originalResourceId ? { originalResourceId: params.items[index].originalResourceId } : {}) })) };
}
const itemSchema: ObjectSchema = { ...WORKBENCH_INGEST_ITEM_SCHEMA, id: uuidField(), content, originalResourceId: uuidField(false) };
const objectArray = (schema: ObjectSchema, minItems: number, maxItems: number, describe: string, required = true): FieldRule => ({
  check: value => Array.isArray(value) && value.length >= minItems && value.length <= maxItems && value.every(item => matchesSchema(item, schema)), describe, required,
  emits: { kind: "array", minItems, maxItems, items: { kind: "object", schema } },
});
const decideTarget: ObjectSchema = { ...WORKBENCH_DECIDE_TARGET_SCHEMA, itemId: uuidField(), expectedItemVersion: { ...WORKBENCH_DECIDE_TARGET_SCHEMA.expectedItemVersion, required: true }, contentRevisionId: uuidField(false) };
const feedbackSchema: ObjectSchema = { ...WORKBENCH_FEEDBACK_OP_SCHEMA, id: uuidField(), itemId: uuidField() };
const reworkResult: ObjectSchema = { ...WORKBENCH_REWORK_RESULT_SCHEMA, sourceItemId: uuidField(), content };
const applyOps: readonly ObjectSchema[] = [
  { ...WORKBENCH_DECIDE_OP_SCHEMA, batchId: uuidField(), decisions: objectArray(decideTarget, 1, 200, "decisions with exact item versions") },
  { ...WORKBENCH_FEEDBACK_SAVE_OP_SCHEMA, feedback: { check: value => matchesSchema(value, feedbackSchema), describe: "version-bound feedback", required: true, emits: { kind: "object", schema: feedbackSchema } } },
  { ...WORKBENCH_HANDOFF_ACK_OP_SCHEMA, handoffId: uuidField() },
  { ...WORKBENCH_REWORK_OP_SCHEMA, handoffId: uuidField(), results: objectArray(reworkResult, 1, 500, "real version-bound rework results") },
  { ...WORKBENCH_CONTENT_UPDATE_OP_SCHEMA, itemId: uuidField() },
];
const fileSchema: ObjectSchema = {
  resourceId: uuidField(),
  sourcePath: { check: value => typeof value === "string" && value.length > 0 && value.length <= 32768, describe: "an absolute local file inside an allowed media root", required: true, emits: { kind: "leaf", schema: { type: "string", minLength: 1, maxLength: 32768 } } },
  mime: { check: value => typeof value === "string" && value.length <= 200 && /^[^\r\n]+\/[^\r\n]+$/.test(value), describe: "the source MIME type", required: true, emits: { kind: "leaf", schema: { type: "string", minLength: 3, maxLength: 200 } } },
};
const files = objectArray(fileSchema, 0, 64, "at most 64 source files copied before the atomic commit", false);
const nodeWrite = { target: target(true), expectedNodeRevision: revision, requestId: uuidField() };
const boundedText = (maximum: number, required = true): FieldRule => ({ check: value => typeof value === "string" && value.length > 0 && value.length <= maximum, describe: `text of 1–${maximum} characters`, required, emits: { kind: "leaf", schema: { type: "string", minLength: 1, maxLength: maximum } } });
const oneOf = (values: readonly string[], required = true): FieldRule => ({ check: value => values.includes(String(value)), describe: values.join(" or "), required, emits: { kind: "leaf", schema: { enum: values } } });
const finite = (positive = false): FieldRule => ({ check: value => typeof value === "number" && Number.isFinite(value) && (positive ? value > 0 : value >= 0), describe: positive ? "a finite positive number" : "a finite nonnegative number", required: true, emits: { kind: "leaf", schema: { type: "number", minimum: 0, ...(positive ? { exclusiveMinimum: 0 } : {}) } } });
const regionSchema: ObjectSchema = { space: kind("source-pixels"), x: finite(), y: finite(), width: finite(true), height: finite(true) };
const timeRange: ObjectSchema = { startSec: finite(), endSec: finite(true) };
const referenceExtra: ObjectSchema = { role: boundedText(64),
  region: { check: value => matchesSchema(value, regionSchema), describe: "an explicit source-pixel rectangle", emits: { kind: "object", schema: regionSchema } },
  range: { check: value => matchesSchema(value, timeRange), describe: "an explicit source time range", emits: { kind: "object", schema: timeRange } },
};
const references: readonly ObjectSchema[] = [
  { nodeId: uuidField(), itemId: uuidField(), version: { ...revision, check: value => isNonNegativeInteger(value) && Number(value) > 0, emits: { kind: "leaf", schema: { type: "integer", minimum: 1 } } }, ...referenceExtra },
  { resourceId: uuidField(), ...referenceExtra },
];
const referenceArray = (minimum: number): FieldRule => ({ check: value => Array.isArray(value) && value.length >= minimum && value.length <= 64 && value.every(ref => references.some(schema => matchesSchema(ref, schema))), describe: `${minimum}–64 exact version/resource references with roles`, required: true, emits: { kind: "array", minItems: minimum, maxItems: 64, items: { kind: "anyOfObjects", variants: references } } });
const methodSchema: ObjectSchema = { kind: oneOf(["algorithm", "model", "skill"]), name: boundedText(200), version: boundedText(100, false) };
const mappingSchema: ObjectSchema = { kind: oneOf(["image-bounds", "time-range"]), inputIndex: revision, outputIndex: revision };
const stepBase: ObjectSchema = { runId: uuidField(), label: boundedText(200), inputs: referenceArray(0),
  method: { check: value => matchesSchema(value, methodSchema), describe: "the actual tool/model/skill used; external reports are labelled declared", required: true, emits: { kind: "object", schema: methodSchema } },
  parameters: { check: value => {
    if (!isPlainObject(value) || new TextEncoder().encode(JSON.stringify(value)).byteLength > 32768) return false;
    try { validateReviewParameters(value as ReviewJson); return true; }
    catch (error) { if ((error as { code?: string }).code === "INVALID_PARAMS") return false; throw error; }
  }, describe: "optional JSON parameters within 32 KiB, depth 8; no credentials", emits: { kind: "leaf", schema: { type: "object" } } },
  supersedesStepId: uuidField(false),
  mapping: { check: value => matchesSchema(value, mappingSchema), describe: "explicit full-image bounds correspondence or linear mapping between the two reference time ranges", emits: { kind: "object", schema: mappingSchema } },
};
const completedStepSchema: ObjectSchema = { id: uuidField(), ...stepBase, outputs: referenceArray(1), startedAt: finite(), finishedAt: finite() };
const completedSteps = objectArray(completedStepSchema, 0, 500, "actual completed processing reports committed with their real new outputs", false);
const ingestOutput: ObjectSchema = { batchId: uuidField(), name, items: objectArray(itemSchema, 1, 500, "new output items") };
const exportIdentity = { target: target(true), exportId: uuidField() };
const query: FieldRule = { check: value => typeof value === "string" && value.length <= 500, describe: "a search string of at most 500 characters", emits: { kind: "leaf", schema: { type: "string", maxLength: 500 } } };
const typeFilter: FieldRule = { check: value => ["all", "image", "text", "data", "video", "model3d"].includes(String(value)), describe: "an optional content type filter", emits: { kind: "leaf", schema: { enum: ["all", "image", "text", "data", "video", "model3d"] } } };
const exportFilter: ObjectSchema = { batchId: uuidField(false), type: typeFilter, query };
const videoDestination: ObjectSchema = { kind: kind("video"), projectId: boundedText(200), workspaceId: boundedText(200), instanceId: uuidField() };
const resourceRead: ObjectSchema = { target: target(true), expectedNodeRevision: revision,
  reference: { check: value => references.some(schema => matchesSchema(value, schema)), describe: "an exact version or resource retained by the target node", required: true, emits: { kind: "anyOfObjects", variants: references } } };
export const REVIEW_SCHEMAS: Record<ReviewVerb, ObjectSchema> = {
  "review.media.inspect": resourceRead,
  "review.frames.extract": { ...resourceRead, frames: { check: value => Array.isArray(value) && value.length > 0 && value.length <= 600 && value.every(frame => Number.isSafeInteger(frame) && frame >= 0),
    describe: "1–600 exact zero-based decode frame indices", required: true, emits: { kind: "array", minItems: 1, maxItems: 600, items: { kind: "leaf", schema: { type: "integer", minimum: 0 } } } } },
  "review.attach": { ...nodeWrite, itemId: uuidField(), expectedProjectRevision: revision,
    destination: { check: value => matchesSchema(value, videoDestination), describe: "the explicit destination video workspace and current runtime", required: true, emits: { kind: "object", schema: videoDestination } } },
  "review.package.inspect": { target: target(false), directory: boundedText(32768) },
  "review.package.restore": { target: target(false), expectedWorkspaceRevision: revision, requestId: uuidField(), packageId: uuidField(),
    digest: { check: value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value), describe: "the inspected frozen package digest", required: true, emits: { kind: "leaf", schema: { type: "string", pattern: "^[0-9a-f]{64}$" } } },
  },
  "review.steps.start": { ...nodeWrite, stepId: uuidField(), ...stepBase },
  "review.steps.complete": { ...nodeWrite, stepId: uuidField(), outputs: referenceArray(1), files,
    ingest: { check: value => matchesSchema(value, ingestOutput), describe: "new output items in the same transaction", emits: { kind: "object", schema: ingestOutput } },
    ops: { check: value => Array.isArray(value) && value.length > 0 && value.length <= 100 && value.every(op => applyOps.some(schema => matchesSchema(op, schema))), describe: "real output version changes; exclusive with ingest", emits: { kind: "array", minItems: 1, maxItems: 100, items: { kind: "anyOfObjects", variants: applyOps } } },
  },
  "review.steps.fail": { ...nodeWrite, stepId: uuidField(), state: oneOf(["failed", "cancelled"], false), error: boundedText(2000) },
  "review.steps.list": { target: target(true), runId: uuidField(false), ...page },
  "review.nodes.list": { target: target(false), ...page, query, groupId: uuidField(false),
    view: { check: value => ["all", "recent", "pinned", "archived", "trash"].includes(String(value)), describe: "a directory view", emits: { kind: "leaf", schema: { enum: ["all", "recent", "pinned", "archived", "trash"] } } } },
  "review.export.prepare": { ...exportIdentity, expectedNodeRevision: revision,
    mode: { check: value => ["original", "adopted", "node-package", "version"].includes(String(value)), describe: "original files, human-adopted versions, portable node package, or an exact processing reference", required: true, emits: { kind: "leaf", schema: { enum: ["original", "adopted", "node-package", "version"] } } },
    reference: { check: value => references.some(schema => matchesSchema(value, schema)), describe: "one exact node-owned version or retained resource; version mode only, full file rather than a cropped region", emits: { kind: "anyOfObjects", variants: references } },
    scope: { check: value => ["node", "filtered", "selected"].includes(String(value)), describe: "an explicit frozen export scope", required: true, emits: { kind: "leaf", schema: { enum: ["node", "filtered", "selected"] } } },
    itemIds: { check: value => Array.isArray(value) && value.length > 0 && value.length <= 10000 && value.every(uuid), describe: "explicit selected item UUIDs", emits: { kind: "array", minItems: 1, maxItems: 10000, items: uuidField().emits! } },
    filter: { check: value => matchesSchema(value, exportFilter), describe: "the complete explicit filtered scope, including all its pages", emits: { kind: "object", schema: exportFilter } },
  },
  "review.export.status": exportIdentity,
  "review.export.cancel": exportIdentity,
  "review.export.copy": { ...exportIdentity, directory: { check: value => typeof value === "string" && value.length > 0 && value.length <= 32768, describe: "an existing destination directory inside allowed media roots", required: true, emits: { kind: "leaf", schema: { type: "string", minLength: 1, maxLength: 32768 } } } },
  "review.nodes.create": { target: target(false), name, expectedWorkspaceRevision: revision, requestId: uuidField() },
  "review.directory.get": { target: target(false) },
  "review.directory.apply": { target: target(false), expectedWorkspaceRevision: revision, requestId: uuidField(),
    commands: { check: value => Array.isArray(value) && value.length >= 1 && value.length <= 100 && value.every(command => directoryCommands.some(schema => matchesSchema(command, schema))),
      describe: "1–100 atomic directory commands", required: true, emits: { kind: "array", minItems: 1, maxItems: 100, items: { kind: "anyOfObjects", variants: directoryCommands } } } },
  "review.directory.history.control": { target: target(false), expectedWorkspaceRevision: revision, requestId: uuidField(), direction },
  "review.get": { target: target(true), itemId: uuidField(false), batchId: uuidField(false), ...page,
    type: { check: value => ["all", "image", "text", "data", "video", "model3d"].includes(String(value)), describe: "an optional content type filter", emits: { kind: "leaf", schema: { enum: ["all", "image", "text", "data", "video", "model3d"] } } },
    query: { check: value => typeof value === "string" && value.length <= 500, describe: "search titles, source labels and provenance names", emits: { kind: "leaf", schema: { type: "string", maxLength: 500 } } },
  },
  "review.ingest": { ...nodeWrite, batchId: uuidField(), name, files, steps: completedSteps,
    items: { check: value => Array.isArray(value) && value.length >= 1 && value.length <= 500 && value.every(item => matchesSchema(item, itemSchema)),
      describe: "1–500 real review items; mediaId identifies a registered FileResource", required: true,
      emits: { kind: "array", minItems: 1, maxItems: 500, items: { kind: "object", schema: itemSchema } } },
  },
  "review.apply": { ...nodeWrite, files, ops: { check: value => Array.isArray(value) && value.length >= 1 && value.length <= 100 && value.every(op => applyOps.some(schema => matchesSchema(op, schema))),
    describe: "1–100 shared workbench operations in one independent review transaction; agent operator is pinned and publishing is human-only", required: true,
    emits: { kind: "array", minItems: 1, maxItems: 100, items: { kind: "anyOfObjects", variants: applyOps } } } },
  "review.changes": { target: target(true), afterSequence: revision, limit: page.limit },
  "review.handoff.get": { target: target(true), handoffId: uuidField() },
  "review.versions.get": { target: target(true), itemId: uuidField(), version: { check: value => isNonNegativeInteger(value) && Number(value) > 0, describe: "an exact positive content version", required: true, emits: { kind: "leaf", schema: { type: "integer", minimum: 1 } } } },
  "review.history.control": { target: target(true), expectedNodeRevision: revision, requestId: uuidField(),
    direction,
  },
};
export const REVIEW_DESCRIPTIONS: Record<ReviewVerb, string> = {
  "review.media.inspect": "Read verified file metadata for an exact node-owned media/resource reference. Requires no video project; does not add feedback or process records.",
  "review.frames.extract": "Use the existing local FFmpeg frame processor on an exact node-owned resource. Returns real source PTS and lossless PNG candidates under review jobs, pinned to the original target/revision. Does not create review items or feedback; record actual processing explicitly with review.steps.*.",
  "review.attach": "Add the exact human-adopted image/video version as independent project media in an explicit video workspace. Requires both review and video write access. Durable retries return the same media ID; does not insert a timeline clip or resurrect an undone import.",
  "review.package.inspect": "Validate a portable node package, its relative file paths, exact bytes and references inside allowed media roots. Returns a concrete restore inventory without creating a node.",
  "review.package.restore": "Restore an inspected package atomically as a new node with new entity/resource identities and durable request receipt. Historical snapshots cannot resume old external tasks; old journals are read-only evidence.",
  "review.steps.start": "Record a real processing run with exact input versions, roles, tool identity and bounded parameters. Does not execute a tool or invent outputs; external reports remain declared.",
  "review.steps.complete": "Complete a running step atomically with its new output items, content versions or prepared resources. A terminal step cannot be rewritten. Provide ingest or ops, or files for resource-only outputs.",
  "review.steps.fail": "Record a running step as failed or cancelled with no claimed outputs. Retry as a new step, optionally superseding the failed one.",
  "review.steps.list": "Read a bounded page of node-owned processing records with exact input/output references; no media bytes or item bodies.",
  "review.export.prepare": "Freeze an exact node revision and explicit scope, then stream original or human-adopted versions into disposable copies. Poll status; this does not report an OS drop as received.",
  "review.export.status": "Read a node-owned frozen export's progress, errors and ready manifest without media bytes.",
  "review.export.cancel": "Cancel a queued or preparing export. A cancelled export cannot be dragged or copied as complete.",
  "review.export.copy": "Copy a ready frozen export into a new directory under an allowed media root, preserving existing files and verifying each exported byte stream.",
  "review.nodes.list": "List a bounded page of independent review nodes for an explicit review workspace. Does not use a video project or current page selection.",
  "review.nodes.create": "Create a persistent independent review node with directory CAS and a durable UUID request receipt.",
  "review.directory.get": "Read the independent directory revision and groups in one transaction.",
  "review.directory.apply": "Atomically create or update node/group metadata with directory CAS. Display renames do not rename original files. Trash is reversible.",
  "review.directory.history.control": "Undo or redo directory metadata without rolling back node content revisions. External commits form a history boundary.",
  "review.get": "Read a bounded page of review item summaries; pass an exact itemId to read its content and version-bound feedback. Does not load media bytes into JSON.",
  "review.ingest": "Atomically ingest review text/data or already registered resource references into an explicit node with node CAS and durable requestId. Uses the existing workbench core semantics.",
  "review.apply": "Apply version-bound feedback, decisions, text/data revisions, handoff acknowledgement or rework atomically to an explicit review node. Reuses the legacy workbench operation vocabulary and semantics; cannot publish human handoffs.",
  "review.changes": "Read bounded journal event summaries after a monotonic sequence, without loading item bodies or hidden UI selections.",
  "review.handoff.get": "Read an exact immutable published handoff from its owning review node.",
  "review.versions.get": "Read an exact retained content version, including versions retained after undo or branching.",
  "review.history.control": "Undo or redo the explicit review node's persisted history with monotonic revision guards. External content commits form a history boundary.",
};
