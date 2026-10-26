import { isModelObservation } from "@reelterminal/core/review/model-observation";
/**
 * AI material workbench facade: closed verb/op schemas, facade→core input
 * conversion and read views shared by the headless session and the live
 * store seam. The core workbench actions module
 * (`@reelterminal/core/actions/workbench-actions`) owns the domain rules —
 * the facade adds the boundary schema, the "agent" operator pinning, the
 * CAS/idempotency envelope and the bounded read projections.
 *
 * Honesty notes:
 *  - Publishing a handoff is a HUMAN action (the GUI channel owns it); there
 *    is deliberately no agent `workbench.handoff.publish` verb or op.
 *  - Text rework APPENDS the producedVersion body and keeps every earlier
 *    version untouched, so old range comments remain readable. Rework content
 *    must match the source item type and is bound to the handoff itemVersion /
 *    decisionRevision; stale, retrieved or superseded tasks are rejected.
 *  - `workbench.content.update` requires an explicit expectedItemVersion CAS
 *    guard; the facade never substitutes the latest live version.
 */
import { FacadeError } from "./errors";
import { nextWorkbenchContentVersion } from "@reelterminal/core/actions/workbench-actions";
import {
  matchesSchema,
  isBoolean,
  isNonEmptyString,
  isNonNegativeInteger,
  isPlainObject,
  isPositiveInteger,
  oneOf,
  type ObjectSchema,
} from "./validate";
import type {
  WorkbenchDecisionStatus,
  WorkbenchFeedback,
  WorkbenchHandoff,
  WorkbenchVideoMarker,
} from "@reelterminal/core/types/workbench";
import {
  WORKBENCH_MAX_ITEMS_PER_BATCH,
  WORKBENCH_MAX_ROWS_PER_DATASET,
  WORKBENCH_MAX_TEXT_LENGTH,
  workbenchBatchItems,
  workbenchFeedbackIssueId,
} from "@reelterminal/core/types/workbench";
import type {
  WorkbenchBuilderResult,
  WorkbenchIngestInput,
  WorkbenchReworkResult,
} from "@reelterminal/core/actions/workbench-actions";
import type {
  WorkbenchItem,
  WorkbenchItemContent,
  WorkbenchProjectState,
  WorkbenchProvenanceTag,
} from "@reelterminal/core/types/workbench";
import type {
  WorkbenchChangesParams,
  WorkbenchChangesResult,
  WorkbenchContentInput,
  WorkbenchContentUpdateOp,
  WorkbenchGetParams,
  WorkbenchGetResult,
  WorkbenchFeedbackView,
  WorkbenchItemView,
  WorkbenchMarkerView,
  WorkbenchHandoffGetParams,
  WorkbenchHandoffGetResult,
  WorkbenchHandoffHeader,
  WorkbenchIngestParams,
  WorkbenchReworkOp,
} from "./types";

export const WORKBENCH_DEFAULT_GET_LIMIT = 50;
export const WORKBENCH_MAX_GET_LIMIT = 200;

/* ------------------------------------------------------------------ */
/* Shared scalar checks                                                */
/* ------------------------------------------------------------------ */

/** Workbench ids are non-empty strings of at most 200 characters (core rule). */
const isWorkbenchId = (v: unknown): boolean =>
  typeof v === "string" && v.length >= 1 && v.length <= 200;

const isBoundedText = (v: unknown): boolean =>
  typeof v === "string" && v.length <= WORKBENCH_MAX_TEXT_LENGTH;

const isStringOrNull = (v: unknown): boolean => v === null || typeof v === "string";

/** Nullable string leaf emission (draft-2020-12 type array). */
const NULLABLE_STRING_EMITS = { kind: "leaf", schema: { type: ["string", "null"] } } as const;

const isCellsRecord = (v: unknown): boolean =>
  isPlainObject(v) && Object.values(v).every(isStringOrNull);

const isTagIdArray = (v: unknown): boolean =>
  Array.isArray(v) && v.length <= 64 && v.every((id) => typeof id === "string" && id.length > 0);

/* ------------------------------------------------------------------ */
/* Content sub-declarations (shared by workbench.ingest and the ops)   */
/* ------------------------------------------------------------------ */

export const WORKBENCH_PROVENANCE_TAG_SCHEMA: ObjectSchema = {
  id: {
    check: isWorkbenchId,
    describe: "a stable non-empty id of at most 200 characters",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1, maxLength: 200 } },
  },
  category: {
    check: oneOf(["model", "algorithm", "skill", "source", "batch"]),
    describe: '"model", "algorithm", "skill", "source" or "batch"',
    required: true,
    emits: { kind: "leaf", schema: { enum: ["model", "algorithm", "skill", "source", "batch"] } },
  },
  shortName: {
    check: (v) => typeof v === "string" && v.length > 0,
    describe: "a non-empty display name (never identity)",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  version: {
    check: (v) => typeof v === "string" && v.length > 0,
    describe: "an optional version identity; same name with different versions never merges",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  verification: {
    check: oneOf(["declared", "verified", "unknown"]),
    describe: '"declared", "verified" or "unknown"',
    required: true,
    emits: { kind: "leaf", schema: { enum: ["declared", "verified", "unknown"] } },
  },
  upstreamRef: {
    check: (v) => typeof v === "string" && v.length > 0,
    describe: "an optional stable upstream object reference",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  detailSummary: {
    check: (v) => typeof v === "string" && v.length > 0,
    describe: "a non-empty human-readable provenance summary",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const WORKBENCH_AGENT_GUIDANCE_SCHEMA: ObjectSchema = {
  triageGroup: {
    check: oneOf(["need_verdict", "ready_patch", "pass_candidate"]),
    describe: '"need_verdict", "ready_patch" or "pass_candidate"',
    required: true,
    emits: { kind: "leaf", schema: { enum: ["need_verdict", "ready_patch", "pass_candidate"] } },
  },
  branchName: {
    check: (v) => typeof v === "string" && v.length > 0,
    describe: "a non-empty branch display name",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  nodeSlotLabel: {
    check: (v) => typeof v === "string" && v.length > 0,
    describe: "a compact node slot label; prefer 4–8 Chinese characters / <=15 characters; do not repeat the batch name prefix",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  whatHappened: {
    check: isBoundedText,
    describe: `a non-empty explanation of at most ${WORKBENCH_MAX_TEXT_LENGTH} characters`,
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  whatToDoNext: {
    check: isBoundedText,
    describe: `a non-empty next-step description of at most ${WORKBENCH_MAX_TEXT_LENGTH} characters`,
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  nodButtonLabel: {
    check: (v) => typeof v === "string" && v.length > 0,
    describe: "a non-empty label for the nod (confirm) button",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  nodDecision: {
    check: oneOf(["kept", "discarded", "modified", "rework"]),
    describe: 'the SUGGESTED decision: "kept", "discarded", "modified" or "rework" — nodding is a human confirm action, never an auto-apply',
    required: true,
    emits: { kind: "leaf", schema: { enum: ["kept", "discarded", "modified", "rework"] } },
  },
};

export const WORKBENCH_LINEAGE_STEP_SCHEMA: ObjectSchema = {
  version: {
    check: isPositiveInteger,
    describe: "a positive integer item version",
    required: true,
    emits: { kind: "leaf", schema: { type: "integer", minimum: 1 } },
  },
  outcome: {
    check: oneOf(["rejected", "modified", "current", "kept", "discarded"]),
    describe: '"rejected", "modified", "current", "kept" or "discarded"',
    required: true,
    emits: { kind: "leaf", schema: { enum: ["rejected", "modified", "current", "kept", "discarded"] } },
  },
  edgeLabel: {
    check: (v) => typeof v === "string" && v.length > 0,
    describe: "a non-empty edge label",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  summary: {
    check: (v) => typeof v === "string" && v.length > 0,
    describe: "a non-empty step summary",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

const parentModeField: ObjectSchema[string] = {
  check: oneOf(["board", "category"]),
  describe: '"board" for same-screen review of candidate images, storyboards or sparse text/data; "category" for folder-only grouping',
  emits: { kind: "leaf", schema: { enum: ["board", "category"] } },
};
const compareWithItemIdField: ObjectSchema[string] = {
  check: (value) => typeof value === "string" && value.trim().length > 0,
  describe: "a non-empty baseline video item ID in the same batch; set for rework videos or A/B comparison; top-level value takes precedence",
  emits: { kind: "leaf", schema: { type: "string", minLength: 1, pattern: "\\S" } },
};
const videoPayloadSchema: ObjectSchema = { compareWithItemId: compareWithItemIdField };

export const WORKBENCH_LINEAGE_SCHEMA: ObjectSchema = {
  groupMode: parentModeField,
  upstreamGroupId: {
    check: isWorkbenchId,
    describe: "a stable upstream group id",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  upstreamGroupTitle: {
    check: (v) => typeof v === "string" && v.length > 0,
    describe: "a non-empty upstream group title",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  upstreamSourceNode: {
    check: (v) => typeof v === "string" && v.length > 0,
    describe: "a non-empty upstream source node label",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  parentNodeId: {
    check: isWorkbenchId,
    describe: "an optional true tree parent item id",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  basedOnLabel: {
    check: (v) => typeof v === "string" && v.length > 0,
    describe: "a non-empty based-on label",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  connectorEdgeLabel: {
    check: (v) => typeof v === "string" && v.length > 0,
    describe: "a non-empty connector edge label",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  failStreak: {
    check: isNonNegativeInteger,
    describe: "a non-negative integer fail streak",
    required: true,
    emits: { kind: "leaf", schema: { type: "integer", minimum: 0 } },
  },
  steps: {
    check: (v) => Array.isArray(v) && v.length >= 1 && v.length <= 64 &&
      v.every((step) => matchesSchema(step, WORKBENCH_LINEAGE_STEP_SCHEMA)),
    describe: "1-64 lineage steps",
    required: true,
    emits: { kind: "array", minItems: 1, maxItems: 64, items: { kind: "object", schema: WORKBENCH_LINEAGE_STEP_SCHEMA } },
  },
};

/* ----------------------------- content ----------------------------- */

export const WORKBENCH_TEXT_CONTENT_SCHEMA: ObjectSchema = {
  type: {
    check: (v) => v === "text",
    describe: '"text"',
    required: true,
    emits: { kind: "leaf", schema: { const: "text" } },
  },
  entryId: {
    check: isWorkbenchId,
    describe: "a stable text entry id",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  title: {
    check: (v) => typeof v === "string" && v.length > 0,
    describe: "a non-empty text title",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  speakerOrContext: {
    check: (v) => typeof v === "string",
    describe: "a speaker or context string",
    required: true,
    emits: { kind: "leaf", schema: { type: "string" } },
  },
  text: {
    check: isBoundedText,
    describe: `the complete current text (at most ${WORKBENCH_MAX_TEXT_LENGTH} characters); ingest stores it as version 1`,
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1, maxLength: WORKBENCH_MAX_TEXT_LENGTH } },
  },
};

export const WORKBENCH_DATA_COLUMN_SCHEMA: ObjectSchema = {
  columnId: {
    check: isWorkbenchId,
    describe: "a stable column id",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  title: {
    check: (v) => typeof v === "string" && v.length > 0,
    describe: "a non-empty column title",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  width: {
    check: (v) => typeof v === "string",
    describe: "an optional display width hint",
    emits: { kind: "leaf", schema: { type: "string" } },
  },
  monospace: {
    check: isBoolean,
    describe: "a boolean (render the column monospaced)",
    emits: { kind: "leaf", schema: { type: "boolean" } },
  },
};

export const WORKBENCH_DATA_ROW_SCHEMA: ObjectSchema = {
  rowId: {
    check: isWorkbenchId,
    describe: "a stable row id",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  cells: {
    check: isCellsRecord,
    describe: "a record of columnId → string|null",
    required: true,
    emits: { kind: "leaf", schema: { type: "object" } },
  },
};

export const WORKBENCH_CELL_PROPOSAL_SCHEMA: ObjectSchema = {
  proposalId: {
    check: isWorkbenchId,
    describe: "a stable proposal id",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  rowId: {
    check: isWorkbenchId,
    describe: "the proposed row id",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  columnId: {
    check: isWorkbenchId,
    describe: "the proposed column id",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  originalValue: {
    check: isStringOrNull,
    describe: "the original cell value (string or null)",
    required: true,
    emits: NULLABLE_STRING_EMITS,
  },
  proposedValue: {
    check: isStringOrNull,
    describe: "the proposed cell value (string or null)",
    required: true,
    emits: NULLABLE_STRING_EMITS,
  },
  reason: {
    check: (v) => typeof v === "string" && v.length > 0,
    describe: "a non-empty proposal reason",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  provenanceTagId: {
    check: isWorkbenchId,
    describe: "the provenance tag backing this proposal",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  status: {
    check: oneOf(["proposed", "accepted", "rejected", "modified"]),
    describe: '"proposed", "accepted", "rejected" or "modified"',
    required: true,
    emits: { kind: "leaf", schema: { enum: ["proposed", "accepted", "rejected", "modified"] } },
  },
};

export const WORKBENCH_DATA_CONTENT_SCHEMA: ObjectSchema = {
  type: {
    check: (v) => v === "data",
    describe: '"data"',
    required: true,
    emits: { kind: "leaf", schema: { const: "data" } },
  },
  datasetId: {
    check: isWorkbenchId,
    describe: "a stable dataset id",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  columns: {
    check: (v) => Array.isArray(v) && v.length >= 1 && v.length <= 64 &&
      v.every((column) => matchesSchema(column, WORKBENCH_DATA_COLUMN_SCHEMA)),
    describe: "1-64 column declarations",
    required: true,
    emits: { kind: "array", minItems: 1, maxItems: 64, items: { kind: "object", schema: WORKBENCH_DATA_COLUMN_SCHEMA } },
  },
  rows: {
    check: (v) => Array.isArray(v) && v.length >= 1 && v.length <= WORKBENCH_MAX_ROWS_PER_DATASET &&
      v.every((row) => matchesSchema(row, WORKBENCH_DATA_ROW_SCHEMA)),
    describe: `1-${WORKBENCH_MAX_ROWS_PER_DATASET} data rows`,
    required: true,
    emits: {
      kind: "array",
      minItems: 1,
      maxItems: WORKBENCH_MAX_ROWS_PER_DATASET,
      items: { kind: "object", schema: WORKBENCH_DATA_ROW_SCHEMA },
    },
  },
  proposals: {
    check: (v) => Array.isArray(v) && v.length <= 2048 &&
      v.every((proposal) => matchesSchema(proposal, WORKBENCH_CELL_PROPOSAL_SCHEMA)),
    describe: "an array of at most 2048 cell proposals",
    required: true,
    emits: {
      kind: "array",
      maxItems: 2048,
      items: { kind: "object", schema: WORKBENCH_CELL_PROPOSAL_SCHEMA },
    },
  },
};

export const WORKBENCH_IMAGE_CONTENT_SCHEMA: ObjectSchema = {
  type: {
    check: (v) => v === "image",
    describe: '"image"',
    required: true,
    emits: { kind: "leaf", schema: { const: "image" } },
  },
  mediaId: {
    check: isWorkbenchId,
    describe: "an already-imported project media id (never media bytes)",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  naturalWidth: {
    check: isPositiveInteger,
    describe: "a positive integer (decoded pixels)",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 1 } },
  },
  naturalHeight: {
    check: isPositiveInteger,
    describe: "a positive integer (decoded pixels)",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 1 } },
  },
};

export const WORKBENCH_VIDEO_CONTENT_SCHEMA: ObjectSchema = {
  type: {
    check: (v) => v === "video",
    describe: '"video"',
    required: true,
    emits: { kind: "leaf", schema: { const: "video" } },
  },
  mediaId: {
    check: isWorkbenchId,
    describe: "an already-imported project media id (never media bytes)",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  durationSec: {
    check: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0,
    describe: "a non-negative display-only duration in seconds",
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
  resolution: {
    check: (v) => typeof v === "string" && v.length > 0,
    describe: "a display-only resolution label (e.g. \"1920x1080\")",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const WORKBENCH_MODEL_CONTENT_SCHEMA: ObjectSchema = {
  type: { check: value => value === "model3d", describe: "model3d", required: true, emits: { kind: "leaf", schema: { const: "model3d" } } },
  resourceId: { check: isWorkbenchId, describe: "registered GLB FileResource UUID", required: true, emits: { kind: "leaf", schema: { type: "string", minLength: 1, maxLength: 200 } } },
};

export const WORKBENCH_CONTENT_VARIANTS = [
  WORKBENCH_MODEL_CONTENT_SCHEMA,
  WORKBENCH_TEXT_CONTENT_SCHEMA,
  WORKBENCH_DATA_CONTENT_SCHEMA,
  WORKBENCH_IMAGE_CONTENT_SCHEMA,
  WORKBENCH_VIDEO_CONTENT_SCHEMA,
] as const;

/** Shape check dispatching on the `type` discriminator. */
export function isWorkbenchContentInput(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const variant = WORKBENCH_CONTENT_VARIANTS.find(
    (schema) => schema.type?.check(value.type) ?? false,
  );
  return variant !== undefined && matchesSchema(value, variant);
}

/* ------------------------------------------------------------------ */
/* Verb param declarations                                             */
/* ------------------------------------------------------------------ */

export const WORKBENCH_INGEST_ITEM_SCHEMA: ObjectSchema = {
  groupMode: parentModeField,
  compareWithItemId: compareWithItemIdField,
  videoPayload: {
    check: (value) => matchesSchema(value, videoPayloadSchema),
    describe: "optional Agent-provided video comparison metadata",
    emits: { kind: "object", schema: videoPayloadSchema },
  },
  id: {
    check: isWorkbenchId,
    describe: "a stable caller-minted item id (never reused across batches)",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1, maxLength: 200 } },
  },
  title: {
    check: (v) => typeof v === "string" && v.length > 0,
    describe: "a compact item title; prefer 4–8 Chinese characters / <=15 characters; do not repeat the batch name prefix",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  subtitle: {
    check: (v) => typeof v === "string",
    describe: "an optional subtitle",
    emits: { kind: "leaf", schema: { type: "string" } },
  },
  type: {
    check: oneOf(["image", "text", "data", "video", "model3d"]),
    describe: '"image", "text", "data", "video" or "model3d" (must match content.type)',
    required: true,
    emits: { kind: "leaf", schema: { enum: ["image", "text", "data", "video", "model3d"] } },
  },
  content: {
    check: isWorkbenchContentInput,
    describe:
      'the item content: {"type":"text",entryId,title,speakerOrContext,text} | {"type":"data",datasetId,columns,rows,proposals} | {"type":"image",mediaId,naturalWidth?,naturalHeight?} | {"type":"video",mediaId,durationSec?,resolution?} | {"type":"model3d",resourceId} — image/video reference imported project media by mediaId; model3d references a GLB resource',
    required: true,
    emits: { kind: "anyOfObjects", variants: [...WORKBENCH_CONTENT_VARIANTS] },
  },
  provenanceTags: {
    check: (v) => Array.isArray(v) && v.length <= 64 &&
      v.every((tag) => matchesSchema(tag, WORKBENCH_PROVENANCE_TAG_SCHEMA)),
    describe: "0-64 declared provenance tags",
    emits: {
      kind: "array",
      maxItems: 64,
      items: { kind: "object", schema: WORKBENCH_PROVENANCE_TAG_SCHEMA },
    },
  },
  agentGuidance: {
    check: (v) => matchesSchema(v, WORKBENCH_AGENT_GUIDANCE_SCHEMA),
    describe: "optional structured triage guidance rendered by the GUI (nodding stays a human confirm action)",
    emits: { kind: "object", schema: WORKBENCH_AGENT_GUIDANCE_SCHEMA },
  },
  lineage: {
    check: (v) => matchesSchema(v, WORKBENCH_LINEAGE_SCHEMA),
    describe: "optional derivation lineage for the lineage tree view",
    emits: { kind: "object", schema: WORKBENCH_LINEAGE_SCHEMA },
  },
};

export const WORKBENCH_INGEST_SCHEMA: ObjectSchema = {
  batchId: {
    check: isWorkbenchId,
    describe: "the batch to create or append to (create-or-append by id)",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1, maxLength: 200 } },
  },
  name: {
    check: (v) => typeof v === "string" && v.trim().length > 0,
    describe: "a non-empty batch display name",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  description: {
    check: (v) => typeof v === "string",
    describe: "an optional batch description",
    emits: { kind: "leaf", schema: { type: "string" } },
  },
  items: {
    check: (v) => Array.isArray(v) && v.length >= 1 && v.length <= WORKBENCH_MAX_ITEMS_PER_BATCH &&
      v.every((item) => matchesSchema(item, WORKBENCH_INGEST_ITEM_SCHEMA)),
    describe: `1-${WORKBENCH_MAX_ITEMS_PER_BATCH} new items (re-ingesting an existing item id with identical content is an idempotent skip; a reused id with different content is rejected)`,
    required: true,
    emits: {
      kind: "array",
      minItems: 1,
      maxItems: WORKBENCH_MAX_ITEMS_PER_BATCH,
      items: { kind: "object", schema: WORKBENCH_INGEST_ITEM_SCHEMA },
    },
  },
  expectedRevision: {
    check: isNonNegativeInteger,
    describe: "a non-negative project revision CAS guard",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 0 } },
  },
  idempotencyKey: {
    check: isNonEmptyString,
    describe: "a non-empty retry key; the same key with the same payload replays the committed result",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const WORKBENCH_GET_SCHEMA: ObjectSchema = {
  batchId: {
    check: isWorkbenchId,
    describe: "an optional batch filter (must exist when given)",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  itemId: {
    check: isWorkbenchId,
    describe: "an optional single-item lookup (mutually exclusive with batching/paging)",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  status: {
    check: oneOf(["pending", "kept", "discarded", "modified", "rework"]),
    describe: 'an optional decision-status filter: "pending", "kept", "discarded", "modified" or "rework"',
    emits: { kind: "leaf", schema: { enum: ["pending", "kept", "discarded", "modified", "rework"] } },
  },
  offset: {
    check: isNonNegativeInteger,
    describe: "a non-negative page offset (default 0)",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 0 } },
  },
  limit: {
    check: (v) => isPositiveInteger(v) && (v as number) <= WORKBENCH_MAX_GET_LIMIT,
    describe: `an integer in [1, ${WORKBENCH_MAX_GET_LIMIT}] (default ${WORKBENCH_DEFAULT_GET_LIMIT})`,
    emits: { kind: "leaf", schema: { type: "integer", minimum: 1, maximum: WORKBENCH_MAX_GET_LIMIT } },
  },
  includeData: {
    check: isBoolean,
    describe: "true returns full data rows for data items (default false: rowCount + columns only)",
    emits: { kind: "leaf", schema: { type: "boolean" } },
  },
  includeFeedback: {
    check: isBoolean,
    describe:
      "true returns the item's feedback records with intent/target/cleared state (default false: counts only)",
    emits: { kind: "leaf", schema: { type: "boolean" } },
  },
  includeMarkers: {
    check: isBoolean,
    describe:
      "true returns video markers with real PTS ranges and frame-mapping facts (default false: markerCount only)",
    emits: { kind: "leaf", schema: { type: "boolean" } },
  },
  includeRevisions: {
    check: isBoolean,
    describe:
      "true returns content revisions (kind/producedVersion/media/base) (default false)",
    emits: { kind: "leaf", schema: { type: "boolean" } },
  },
};

export const WORKBENCH_CHANGES_SCHEMA: ObjectSchema = {
  batchId: {
    check: isWorkbenchId,
    describe: "the batch whose decisions and handoffs are read",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  cursor: {
    check: isNonNegativeInteger,
    describe:
      "the projectRevision returned by the previous call. Decision log entries do not carry project revisions, so the cursor is an approximation: a cursor OLDER than the current revision marks the response stale and returns the FULL current decision log — re-read snapshots instead of applying a delta; a cursor equal to the current revision returns empty lists",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 0 } },
  },
};

export const WORKBENCH_HANDOFF_GET_SCHEMA: ObjectSchema = {
  handoffId: {
    check: isWorkbenchId,
    describe: "the legacy handoff id (same identity as snapshotId)",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  snapshotId: {
    check: isWorkbenchId,
    describe:
      "the published snapshot id to read; omit with handoffId too to get only the latest snapshot header",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

/* ------------------------------------------------------------------ */
/* edit.apply op declarations                                          */
/* ------------------------------------------------------------------ */

const WORKBENCH_DECISIONS = ["kept", "discarded", "modified", "rework"] as const;

export const WORKBENCH_DECIDE_TARGET_SCHEMA: ObjectSchema = {
  itemId: {
    check: isWorkbenchId,
    describe: "an existing workbench item id",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  decision: {
    check: oneOf(WORKBENCH_DECISIONS),
    describe: '"kept", "discarded", "modified" or "rework" ("modified" requires contentRevisionId)',
    required: true,
    emits: { kind: "leaf", schema: { enum: [...WORKBENCH_DECISIONS] } },
  },
  expectedItemVersion: {
    check: isPositiveInteger,
    describe: "an optional CAS guard: the item version the decision was derived from; a mismatch fails CONFLICT",
    emits: { kind: "leaf", schema: { type: "integer", minimum: 1 } },
  },
  contentRevisionId: {
    check: isWorkbenchId,
    describe: "required when decision is \"modified\": a real content revision on the item (no real change, no modified status)",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const WORKBENCH_DECIDE_OP_SCHEMA: ObjectSchema = {
  op: {
    check: (v) => v === "workbench.decide",
    describe: '"workbench.decide"',
    required: true,
    emits: { kind: "leaf", schema: { const: "workbench.decide" } },
  },
  batchId: {
    check: isWorkbenchId,
    describe: "the batch every decision target belongs to",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  decisions: {
    check: (v) => Array.isArray(v) && v.length >= 1 && v.length <= 200 &&
      v.every((target) => matchesSchema(target, WORKBENCH_DECIDE_TARGET_SCHEMA)),
    describe: "1-200 decision targets; the operator is always the agent channel and never an input",
    required: true,
    emits: {
      kind: "array",
      minItems: 1,
      maxItems: 200,
      items: { kind: "object", schema: WORKBENCH_DECIDE_TARGET_SCHEMA },
    },
  },
};

/* ------------------------- feedback.save op ------------------------ */

export const WORKBENCH_FEEDBACK_TARGET_PIXEL_SCHEMA: ObjectSchema = {
  kind: {
    check: (v) => v === "pixel-region",
    describe: '"pixel-region"',
    required: true,
    emits: { kind: "leaf", schema: { const: "pixel-region" } },
  },
  annotationId: {
    check: isWorkbenchId,
    describe: "the referenced spatial annotation id",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  x: { check: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1, describe: "a normalized [0,1] x", required: true, emits: { kind: "leaf", schema: { type: "number", minimum: 0, maximum: 1 } } },
  y: { check: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1, describe: "a normalized [0,1] y", required: true, emits: { kind: "leaf", schema: { type: "number", minimum: 0, maximum: 1 } } },
  w: { check: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1, describe: "an optional normalized width", emits: { kind: "leaf", schema: { type: "number", minimum: 0, maximum: 1 } } },
  h: { check: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1, describe: "an optional normalized height", emits: { kind: "leaf", schema: { type: "number", minimum: 0, maximum: 1 } } },
  naturalWidth: { check: isPositiveInteger, describe: "an optional decoded width in pixels", emits: { kind: "leaf", schema: { type: "integer", minimum: 1 } } },
  naturalHeight: { check: isPositiveInteger, describe: "an optional decoded height in pixels", emits: { kind: "leaf", schema: { type: "integer", minimum: 1 } } },
};

export const WORKBENCH_FEEDBACK_TARGET_TEXT_RANGE_SCHEMA: ObjectSchema = {
  kind: {
    check: (v) => v === "text-range",
    describe: '"text-range"',
    required: true,
    emits: { kind: "leaf", schema: { const: "text-range" } },
  },
  entryId: {
    check: isWorkbenchId,
    describe: "the text entry id",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  version: {
    check: isPositiveInteger,
    describe: "the UTF-16 anchored text version",
    required: true,
    emits: { kind: "leaf", schema: { type: "integer", minimum: 1 } },
  },
  startOffset: {
    check: isNonNegativeInteger,
    describe: "a half-open UTF-16 start offset",
    required: true,
    emits: { kind: "leaf", schema: { type: "integer", minimum: 0 } },
  },
  endOffset: {
    check: isNonNegativeInteger,
    describe: "a half-open UTF-16 end offset (>= startOffset)",
    required: true,
    emits: { kind: "leaf", schema: { type: "integer", minimum: 0 } },
  },
};

export const WORKBENCH_FEEDBACK_TARGET_DATA_CELL_SCHEMA: ObjectSchema = {
  kind: {
    check: (v) => v === "data-cell",
    describe: '"data-cell"',
    required: true,
    emits: { kind: "leaf", schema: { const: "data-cell" } },
  },
  rowId: {
    check: isWorkbenchId,
    describe: "the stable row id",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  columnId: {
    check: isWorkbenchId,
    describe: "the stable column id",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  proposalId: {
    check: isWorkbenchId,
    describe: "an optional referenced proposal id",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const WORKBENCH_FEEDBACK_TARGET_VIDEO_MARKER_SCHEMA: ObjectSchema = {
  kind: {
    check: (v) => v === "video-marker",
    describe: '"video-marker"',
    required: true,
    emits: { kind: "leaf", schema: { const: "video-marker" } },
  },
  markerId: {
    check: isWorkbenchId,
    describe: "the referenced video marker id",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  startPtsSec: {
    check: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0,
    describe: "the marker's real PTS start seconds",
    required: true,
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
  endPtsSec: {
    check: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0,
    describe: "an optional real PTS end seconds",
    emits: { kind: "leaf", schema: { type: "number", minimum: 0 } },
  },
  hasFrameMapping: {
    check: isBoolean,
    describe: "true only when a real decoded-frame mapping exists (never an fps guess)",
    required: true,
    emits: { kind: "leaf", schema: { type: "boolean" } },
  },
};

export const WORKBENCH_FEEDBACK_TARGET_WHOLE_ITEM_SCHEMA: ObjectSchema = {
  kind: {
    check: (v) => v === "whole-item",
    describe: '"whole-item"',
    required: true,
    emits: { kind: "leaf", schema: { const: "whole-item" } },
  },
};

const observationSchema = {
  type: "object", additionalProperties: false, required: ["preset", "background", "camera", "animation", "viewport"],
  properties: {
    preset: { const: "neutral-r182-v1" }, background: { enum: ["light", "dark"] },
    camera: { type: "object", additionalProperties: false, required: ["position", "quaternion", "target", "fov", "near", "far"], properties: {
      position: { type: "array", minItems: 3, maxItems: 3, items: { type: "number", minimum: -1e12, maximum: 1e12 } },
      target: { type: "array", minItems: 3, maxItems: 3, items: { type: "number", minimum: -1e12, maximum: 1e12 } },
      quaternion: { type: "array", minItems: 4, maxItems: 4, items: { type: "number", minimum: -1, maximum: 1 } },
      fov: { type: "number", exclusiveMinimum: 0, maximum: 179.999999 }, near: { type: "number", exclusiveMinimum: 0 }, far: { type: "number", exclusiveMinimum: 0 },
    } },
    animation: { type: ["object", "null"], additionalProperties: false, required: ["index", "name", "time"], properties: {
      index: { type: "integer", minimum: 0 }, name: { type: "string", maxLength: 2000 }, time: { type: "number", minimum: 0 },
    } },
    viewport: { type: "object", additionalProperties: false, required: ["width", "height"], properties: {
      width: { type: "integer", minimum: 1, maximum: 16384 }, height: { type: "integer", minimum: 1, maximum: 16384 },
    } },
  },
} as const;

export const WORKBENCH_MODEL_VIEW_SCHEMA: ObjectSchema = {
  kind: { check: value => value === "model-view", describe: "model-view", required: true, emits: { kind: "leaf", schema: { const: "model-view" } } },
  ...Object.fromEntries(["observationId", "resourceId", "screenshotResourceId"].map(key => [key, { check: isWorkbenchId, describe: "stable observation/resource identity", required: true, emits: { kind: "leaf" as const, schema: { type: "string", minLength: 1, maxLength: 200 } } }])),
  observation: { check: isModelObservation, describe: "frozen neutral-r182-v1 camera, animation, viewport and background", required: true,
    emits: { kind: "leaf", schema: observationSchema } },
};

export const WORKBENCH_FEEDBACK_TARGET_VARIANTS = [
  WORKBENCH_MODEL_VIEW_SCHEMA,
  WORKBENCH_FEEDBACK_TARGET_PIXEL_SCHEMA,
  WORKBENCH_FEEDBACK_TARGET_TEXT_RANGE_SCHEMA,
  WORKBENCH_FEEDBACK_TARGET_DATA_CELL_SCHEMA,
  WORKBENCH_FEEDBACK_TARGET_VIDEO_MARKER_SCHEMA,
  WORKBENCH_FEEDBACK_TARGET_WHOLE_ITEM_SCHEMA,
] as const;

export function isWorkbenchFeedbackTarget(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const variant = WORKBENCH_FEEDBACK_TARGET_VARIANTS.find(
    (schema) => schema.kind?.check(value.kind) ?? false,
  );
  return variant !== undefined && matchesSchema(value, variant);
}

export const WORKBENCH_FEEDBACK_OP_SCHEMA: ObjectSchema = {
  id: {
    check: isWorkbenchId,
    describe: "a stable feedback id (re-saving the same id replaces the record)",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  itemId: {
    check: isWorkbenchId,
    describe: "the item the feedback is written against",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  itemVersion: {
    check: isPositiveInteger,
    describe: "the item content version the feedback targets (must be the current version for a new record)",
    required: true,
    emits: { kind: "leaf", schema: { type: "integer", minimum: 1 } },
  },
  text: {
    check: isBoundedText,
    describe: `the feedback text (at most ${WORKBENCH_MAX_TEXT_LENGTH} characters)`,
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  referencedTagIds: {
    check: isTagIdArray,
    describe: "the provenance tag ids this feedback references",
    required: true,
    emits: { kind: "array", maxItems: 64, items: { kind: "leaf", schema: { type: "string", minLength: 1 } } },
  },
  target: {
    check: isWorkbenchFeedbackTarget,
    describe: "an optional structured position target (pixel-region | text-range | data-cell | video-marker | whole-item | model-view)",
    emits: { kind: "anyOfObjects", variants: [...WORKBENCH_FEEDBACK_TARGET_VARIANTS] },
  },
  state: {
    check: oneOf(["draft", "confirmed"]),
    describe: '"draft" (persisted but never enters a handoff) or "confirmed"',
    required: true,
    emits: { kind: "leaf", schema: { enum: ["draft", "confirmed"] } },
  },
};

export const WORKBENCH_FEEDBACK_SAVE_OP_SCHEMA: ObjectSchema = {
  op: {
    check: (v) => v === "workbench.feedback.save",
    describe: '"workbench.feedback.save"',
    required: true,
    emits: { kind: "leaf", schema: { const: "workbench.feedback.save" } },
  },
  feedback: {
    check: (v) => matchesSchema(v, WORKBENCH_FEEDBACK_OP_SCHEMA),
    describe: "the complete feedback record (createdAt/updatedAt are stamped by the facade)",
    required: true,
    emits: { kind: "object", schema: WORKBENCH_FEEDBACK_OP_SCHEMA },
  },
};

/* --------------------------- handoff ack op ------------------------ */

export const WORKBENCH_HANDOFF_ACK_OP_SCHEMA: ObjectSchema = {
  op: {
    check: (v) => v === "workbench.handoff.ack",
    describe: '"workbench.handoff.ack"',
    required: true,
    emits: { kind: "leaf", schema: { const: "workbench.handoff.ack" } },
  },
  handoffId: {
    check: isWorkbenchId,
    describe: "the published handoff to acknowledge (must be published_waiting)",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

/* ----------------------------- rework op --------------------------- */

export const WORKBENCH_REWORK_RESULT_SCHEMA: ObjectSchema = {
  sourceItemId: {
    check: isWorkbenchId,
    describe: "the rework item id from the handoff snapshot",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  previousVersion: {
    check: isPositiveInteger,
    describe: "the item version the rework is derived from; must be the live version (a human revision wins, no overwrite)",
    required: true,
    emits: { kind: "leaf", schema: { type: "integer", minimum: 1 } },
  },
  content: {
    check: isWorkbenchContentInput,
    describe: "the full replacement content, same shape as workbench.ingest items' content",
    required: true,
    emits: { kind: "anyOfObjects", variants: [...WORKBENCH_CONTENT_VARIANTS] },
  },
  agentGuidance: {
    check: (v) => matchesSchema(v, WORKBENCH_AGENT_GUIDANCE_SCHEMA),
    describe: "optional refreshed triage guidance",
    emits: { kind: "object", schema: WORKBENCH_AGENT_GUIDANCE_SCHEMA },
  },
  lineage: {
    check: (v) => matchesSchema(v, WORKBENCH_LINEAGE_SCHEMA),
    describe: "optional refreshed lineage",
    emits: { kind: "object", schema: WORKBENCH_LINEAGE_SCHEMA },
  },
  reworkSummary: {
    check: (v) => typeof v === "string" && v.length > 0,
    describe: "an optional human-readable summary of what the rework changed",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
};

export const WORKBENCH_REWORK_OP_SCHEMA: ObjectSchema = {
  op: {
    check: (v) => v === "workbench.rework",
    describe: '"workbench.rework"',
    required: true,
    emits: { kind: "leaf", schema: { const: "workbench.rework" } },
  },
  handoffId: {
    check: isWorkbenchId,
    describe: "the handoff being answered (must not already be rework_returned)",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  results: {
    check: (v) => Array.isArray(v) && v.length >= 1 && v.length <= 200 &&
      v.every((result) => matchesSchema(result, WORKBENCH_REWORK_RESULT_SCHEMA)),
    describe: "1-200 rework results; producedVersion = previousVersion + 1 is derived by the facade",
    required: true,
    emits: {
      kind: "array",
      minItems: 1,
      maxItems: 200,
      items: { kind: "object", schema: WORKBENCH_REWORK_RESULT_SCHEMA },
    },
  },
};

/* ------------------------- content.update op ----------------------- */

export const WORKBENCH_DATA_PATCH_SCHEMA: ObjectSchema = {
  rowId: {
    check: isWorkbenchId,
    describe: "the patched row id",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  columnId: {
    check: isWorkbenchId,
    describe: "the patched column id",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  value: {
    check: isStringOrNull,
    describe: "the new cell value (string, or null to clear the cell); omit for a proposal-only accept/reject that must not touch the value",
    emits: NULLABLE_STRING_EMITS,
  },
  proposalId: {
    check: isWorkbenchId,
    describe: "an optional proposal this patch resolves",
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  proposalOutcome: {
    check: oneOf(["accepted", "modified", "rejected"]),
    describe: 'required with proposalId: "accepted", "modified" or "rejected"',
    emits: { kind: "leaf", schema: { enum: ["accepted", "modified", "rejected"] } },
  },
};

export const WORKBENCH_CONTENT_UPDATE_OP_SCHEMA: ObjectSchema = {
  op: {
    check: (v) => v === "workbench.content.update",
    describe: '"workbench.content.update"',
    required: true,
    emits: { kind: "leaf", schema: { const: "workbench.content.update" } },
  },
  itemId: {
    check: isWorkbenchId,
    describe: "the existing text or data item to revise",
    required: true,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1 } },
  },
  expectedItemVersion: {
    check: isPositiveInteger,
    describe:
      "the item version the revision was derived from (required CAS guard; a stale version is CONFLICT, never silently retargeted)",
    required: true,
    emits: { kind: "leaf", schema: { type: "integer", minimum: 1 } },
  },
  kind: {
    check: oneOf(["text", "data"]),
    describe: '"text" (requires text) or "data" (requires patches)',
    required: true,
    emits: { kind: "leaf", schema: { enum: ["text", "data"] } },
  },
  text: {
    check: isBoundedText,
    describe: `kind "text": the COMPLETE new text (a no-change revision is rejected — revisions must carry a real change)`,
    emits: { kind: "leaf", schema: { type: "string", minLength: 1, maxLength: WORKBENCH_MAX_TEXT_LENGTH } },
  },
  patches: {
    check: (v) => Array.isArray(v) && v.length >= 1 && v.length <= 2000 &&
      v.every((patch) => matchesSchema(patch, WORKBENCH_DATA_PATCH_SCHEMA)),
    describe: 'kind "data": 1-2000 explicit cell patches (whole-table overwrite is not supported; a no-op patch set is rejected)',
    emits: {
      kind: "array",
      minItems: 1,
      maxItems: 2000,
      items: { kind: "object", schema: WORKBENCH_DATA_PATCH_SCHEMA },
    },
  },
};

/* ------------------------------------------------------------------ */
/* Facade → core input conversion                                      */
/* ------------------------------------------------------------------ */

function contentFromInput(
  content: WorkbenchContentInput,
  now: number,
): WorkbenchItemContent {
  switch (content.type) {
    case "text":
      return {
        type: "text",
        entryId: content.entryId,
        title: content.title,
        speakerOrContext: content.speakerOrContext,
        versions: [
          {
            version: 1,
            text: content.text,
            createdAt: now,
            origin: "ingest",
          },
        ],
      };
    case "data":
      return {
        type: "data",
        datasetId: content.datasetId,
        columns: content.columns.map((column) => ({ ...column })),
        rows: content.rows.map((row) => ({
          rowId: row.rowId,
          cells: { ...row.cells },
        })),
        proposals: content.proposals.map((proposal) => ({ ...proposal })),
      };
    case "model3d":
      return { type: "model3d", resourceId: content.resourceId };
    case "image":
      return {
        type: "image",
        mediaId: content.mediaId,
        ...(content.naturalWidth !== undefined ? { naturalWidth: content.naturalWidth } : {}),
        ...(content.naturalHeight !== undefined ? { naturalHeight: content.naturalHeight } : {}),
        annotations: [],
        strokes: [],
      };
    case "video":
      return {
        type: "video",
        mediaId: content.mediaId,
        ...(content.durationSec !== undefined ? { durationSec: content.durationSec } : {}),
        ...(content.resolution !== undefined ? { resolution: content.resolution } : {}),
        markers: [],
      };
  }
}

/**
 * Convert validated facade ingest params into the core builder input. The
 * facade-side text content carries the complete CURRENT text; ingest stores
 * it as version 1 with origin "ingest".
 */
export function workbenchIngestInput(
  params: WorkbenchIngestParams,
  now: number,
): WorkbenchIngestInput {
  return {
    batchId: params.batchId,
    name: params.name,
    ...(params.description !== undefined ? { description: params.description } : {}),
    items: params.items.map((item) => ({
      id: item.id,
      groupMode: item.groupMode,
      compareWithItemId: item.compareWithItemId ?? item.videoPayload?.compareWithItemId,
      videoPayload: item.compareWithItemId !== undefined || item.videoPayload?.compareWithItemId !== undefined
        ? { ...item.videoPayload, compareWithItemId: item.compareWithItemId ?? item.videoPayload?.compareWithItemId }
        : item.videoPayload,
      title: item.title,
      ...(item.subtitle !== undefined ? { subtitle: item.subtitle } : {}),
      type: item.type,
      content: contentFromInput(item.content, now),
      ...(item.provenanceTags !== undefined
        ? {
            provenanceTags: item.provenanceTags.map(
              (tag): WorkbenchProvenanceTag => ({ ...tag }),
            ),
          }
        : {}),
      ...(item.agentGuidance !== undefined ? { agentGuidance: item.agentGuidance } : {}),
      ...(item.lineage !== undefined ? { lineage: item.lineage } : {}),
    })),
  };
}

/**
 * Convert a validated rework result into the core WorkbenchReworkResult.
 * producedVersion is allocated above every retained content version. Text rework APPENDS a new version that
 * keeps every earlier body byte-identical (old range comments stay readable);
 * it never rewrites the parent version's text. The result content type must
 * match the source item type — no temporary type override.
 */
export function workbenchReworkResult(
  op: WorkbenchReworkOp["results"][number],
  item: WorkbenchItem,
  now: number,
): WorkbenchReworkResult {
  const producedVersion = nextWorkbenchContentVersion(item);
  let content: WorkbenchItemContent;
  if (op.content.type === "text") {
    if (item.content.type !== "text") {
      throw new FacadeError(
        "INVALID_PARAMS",
        `workbench.rework: text content supplied for non-text item "${item.id}"`,
        { itemId: item.id, itemType: item.content.type },
      );
    }
    content = {
      type: "text",
      entryId: item.content.entryId,
      title: op.content.title,
      speakerOrContext: op.content.speakerOrContext,
      versions: [
        ...item.content.versions.map((version) => ({ ...version })),
        {
          version: producedVersion,
          text: op.content.text,
          createdAt: now,
          origin: "agent-rework" as const,
          parentVersion: op.previousVersion,
        },
      ],
    };
  } else {
    if (op.content.type !== item.content.type) {
      throw new FacadeError(
        "INVALID_PARAMS",
        `workbench.rework: ${op.content.type} content supplied for ${item.content.type} item "${item.id}"`,
        { itemId: item.id, itemType: item.content.type, resultType: op.content.type },
      );
    }
    content = contentFromInput(op.content, now);
  }
  return {
    sourceItemId: op.sourceItemId,
    previousVersion: op.previousVersion,
    producedVersion,
    content,
    ...(op.agentGuidance !== undefined ? { agentGuidance: op.agentGuidance } : {}),
    ...(op.lineage !== undefined ? { lineage: op.lineage } : {}),
    ...(op.reworkSummary !== undefined ? { reworkSummary: op.reworkSummary } : {}),
  };
}

/** Map a builder failure onto the facade error taxonomy. */
export function workbenchBuilderError(verb: string, failure: Extract<WorkbenchBuilderResult, { ok: false }>): FacadeError {
  return new FacadeError(failure.code, `${verb}: ${failure.message}`, failure.details);
}

/* ------------------------------------------------------------------ */
/* Read views                                                          */
/* ------------------------------------------------------------------ */

export const WORKBENCH_CHANGES_NOTE =
  "Cursor semantics: decision log entries do not record project revisions, so the cursor is the read snapshot's projectRevision. A cursor older than the returned projectRevision marks stale:true and the decided/handoffEvents lists carry the FULL current state — re-read snapshots rather than applying a delta. A cursor equal to projectRevision returned empty lists (nothing changed since).";

const EMPTY_STATUS_COUNTS = (): Record<WorkbenchDecisionStatus, number> => ({
  pending: 0,
  kept: 0,
  discarded: 0,
  modified: 0,
  rework: 0,
});

function referencedTagViews(
  referencedTagIds: readonly string[],
  provenanceTags: readonly WorkbenchProvenanceTag[],
): WorkbenchFeedbackView["referencedTags"] {
  const byId = new Map(provenanceTags.map((tag) => [tag.id, tag]));
  return referencedTagIds.map((id) => {
    const tag = byId.get(id);
    return tag
      ? {
          id,
          name: tag.shortName,
          ...(tag.version !== undefined ? { version: tag.version } : {}),
          referenceState: "resolved" as const,
        }
      : { id, referenceState: "unresolved" as const, raw: id };
  });
}

function workbenchFeedbackView(
  record: WorkbenchFeedback,
  item: WorkbenchItem,
): WorkbenchFeedbackView {
  return {
    id: record.id,
    issueId: workbenchFeedbackIssueId(record.target ?? { kind: "whole-item" }),
    itemVersion: record.itemVersion,
    intent: record.intent ?? "note",
    state: record.state,
    text: record.text,
    target: structuredClone(record.target ?? { kind: "whole-item" as const }),
    referencedTags: referencedTagViews(record.referencedTagIds, item.provenanceTags),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.clearedBy !== undefined ? { clearedBy: record.clearedBy } : {}),
    ...(record.clearedAt !== undefined ? { clearedAt: record.clearedAt } : {}),
    historical: record.itemVersion !== item.version,
  };
}

function workbenchMarkerView(marker: WorkbenchVideoMarker): WorkbenchMarkerView {
  return {
    id: marker.id,
    type: marker.type,
    timeBasis: "browser-current-time",
    startPtsSec: marker.startPtsSec,
    ...(marker.endPtsSec !== undefined ? { endPtsSec: marker.endPtsSec } : {}),
    ...(marker.startFrameIndex !== undefined ? { startFrameIndex: marker.startFrameIndex } : {}),
    ...(marker.endFrameIndex !== undefined ? { endFrameIndex: marker.endFrameIndex } : {}),
    hasFrameMapping: marker.startFrameIndex !== undefined,
    note: marker.note,
    itemVersion: marker.version,
    annotations: marker.annotations.map((annotation) => ({
      id: annotation.id,
      ...(annotation.label !== undefined ? { label: annotation.label } : {}),
      x: annotation.x,
      y: annotation.y,
      ...(annotation.w !== undefined ? { w: annotation.w } : {}),
      ...(annotation.h !== undefined ? { h: annotation.h } : {}),
      ...(annotation.endX !== undefined ? { endX: annotation.endX } : {}),
      ...(annotation.endY !== undefined ? { endY: annotation.endY } : {}),
      ...(annotation.ptsSec !== undefined ? { ptsSec: annotation.ptsSec } : {}),
    })),
  };
}

function itemView(
  item: WorkbenchItem,
  includeData: boolean,
  include: {
    readonly feedback?: boolean;
    readonly markers?: boolean;
    readonly revisions?: boolean;
  } = {},
  feedback: readonly WorkbenchFeedback[] = [],
): WorkbenchItemView {
  const lastDecision = item.decisionLog.length
    ? item.decisionLog[item.decisionLog.length - 1]
    : undefined;
  let content: WorkbenchItemView["content"];
  switch (item.content.type) {
    case "text":
      content = {
        type: "text",
        entryId: item.content.entryId,
        title: item.content.title,
        speakerOrContext: item.content.speakerOrContext,
        currentText: item.content.versions[item.content.versions.length - 1]?.text ?? "",
        versionCount: item.content.versions.length,
        ...(item.content.duplicateProposal
          ? { duplicateProposal: { ...item.content.duplicateProposal } }
          : {}),
      };
      break;
    case "data": {
      const base = {
        type: "data" as const,
        datasetId: item.content.datasetId,
        columns: item.content.columns.map((column) => ({
          columnId: column.columnId,
          title: column.title,
          ...(column.width !== undefined ? { width: column.width } : {}),
          ...(column.monospace !== undefined ? { monospace: column.monospace } : {}),
        })),
        rowCount: item.content.rows.length,
        proposalCount: item.content.proposals.length,
      };
      content = includeData
        ? {
            ...base,
            rows: item.content.rows.map((row) => ({
              rowId: row.rowId,
              cells: { ...row.cells },
            })),
          }
        : base;
      break;
    }
    case "model3d":
      content = { type: "model3d", resourceId: item.content.resourceId };
      break;
    case "image":
      content = {
        type: "image",
        mediaId: item.content.mediaId,
        ...(item.content.naturalWidth !== undefined ? { naturalWidth: item.content.naturalWidth } : {}),
        ...(item.content.naturalHeight !== undefined ? { naturalHeight: item.content.naturalHeight } : {}),
        annotationCount: item.content.annotations.length,
        strokeCount: item.content.strokes.length,
      };
      break;
    case "video":
      content = {
        type: "video",
        mediaId: item.content.mediaId,
        ...(item.content.durationSec !== undefined ? { durationSec: item.content.durationSec } : {}),
        ...(item.content.resolution !== undefined ? { resolution: item.content.resolution } : {}),
        markerCount: item.content.markers.length,
        ...(include.markers
          ? { markers: item.content.markers.map(workbenchMarkerView) }
          : {}),
      };
      break;
  }
  return {
    id: item.id,
    batchId: item.batchId,
    ...(item.groupMode ?? item.lineage?.groupMode ? { groupMode: item.groupMode ?? item.lineage?.groupMode } : {}),
    ...(item.compareWithItemId !== undefined ? { compareWithItemId: item.compareWithItemId } : {}),
    ...(item.videoPayload !== undefined ? { videoPayload: { ...item.videoPayload } } : {}),
    title: item.title,
    ...(item.subtitle !== undefined ? { subtitle: item.subtitle } : {}),
    type: item.type,
    version: item.version,
    status: item.status,
    orderIndex: item.orderIndex,
    createdAt: item.createdAt,
    decisionCount: item.decisionLog.length,
    lastDecision: lastDecision
      ? {
          decision: lastDecision.decision,
          decisionRevision: lastDecision.decisionRevision,
          baseVersion: lastDecision.baseVersion,
          decidedAt: lastDecision.decidedAt,
          operator: lastDecision.operator,
          ...(lastDecision.contentRevisionId ? { contentRevisionId: lastDecision.contentRevisionId } : {}),
        }
      : null,
    feedbackCount: 0, // filled by the caller (needs project state)
    confirmedFeedbackCount: 0, // filled by the caller (needs project state)
    ...(item.reworkOrigin
      ? {
          reworkOrigin: {
            fromHandoffId: item.reworkOrigin.fromHandoffId,
            previousVersion: item.reworkOrigin.previousVersion,
            ...(item.reworkOrigin.summary !== undefined
              ? { summary: item.reworkOrigin.summary }
              : {}),
          },
        }
      : {}),
    ...(include.feedback
      ? { feedback: feedback.map((record) => workbenchFeedbackView(record, item)) }
      : {}),
    ...(include.revisions
      ? {
          revisions: item.revisions.map((revision) => ({
            id: revision.id,
            kind: revision.kind,
            parentVersion: revision.parentVersion,
            producedVersion: revision.producedVersion,
            createdAt: revision.createdAt,
            ...(revision.mediaId !== undefined ? { mediaId: revision.mediaId } : {}),
            ...(revision.base !== undefined ? { base: structuredClone(revision.base) } : {}),
          })),
        }
      : {}),
    content,
  };
}

/** Bounded read projection for workbench.get. */
export function workbenchGetView(
  state: WorkbenchProjectState,
  revision: number,
  params: WorkbenchGetParams,
): WorkbenchGetResult {
  const includeData = params.includeData ?? false;
  const include = {
    feedback: params.includeFeedback ?? false,
    markers: params.includeMarkers ?? false,
    revisions: params.includeRevisions ?? false,
  };
  const feedbackByItem = new Map<string, WorkbenchFeedback[]>();
  for (const record of state.feedback) {
    const list = feedbackByItem.get(record.itemId) ?? [];
    list.push(record);
    feedbackByItem.set(record.itemId, list);
  }
  const read = { capturedAt: Date.now(), stateRevision: revision };
  if (params.itemId !== undefined) {
    const item = state.items.find((candidate) => candidate.id === params.itemId);
    if (!item) {
      throw new FacadeError("NOT_FOUND", `workbench.get: item "${params.itemId}" not found`, {
        itemId: params.itemId,
      });
    }
    return {
      revision,
      read,
      item: withFeedbackCounts(
        feedbackByItem.get(item.id) ?? [],
        itemView(item, includeData, include, feedbackByItem.get(item.id) ?? []),
      ),
    };
  }
  if (params.batchId !== undefined && !state.batches.some((batch) => batch.id === params.batchId)) {
    throw new FacadeError("NOT_FOUND", `workbench.get: batch "${params.batchId}" not found`, {
      batchId: params.batchId,
    });
  }
  let items = params.batchId !== undefined
    ? [...workbenchBatchItems(state, params.batchId)]
    : [...state.items];
  if (params.status !== undefined) {
    items = items.filter((item) => item.status === params.status);
  }
  const total = items.length;
  const offset = params.offset ?? 0;
  const limit = params.limit ?? WORKBENCH_DEFAULT_GET_LIMIT;
  const page = items.slice(offset, offset + limit).map((item) =>
    withFeedbackCounts(
      feedbackByItem.get(item.id) ?? [],
      itemView(item, includeData, include, feedbackByItem.get(item.id) ?? []),
    ),
  );
  const handoffByBatch = new Map<string, WorkbenchHandoff>();
  for (const handoff of state.handoffs) {
    if (!handoffByBatch.has(handoff.batchId)) handoffByBatch.set(handoff.batchId, handoff);
  }
  const batches = state.batches
    .filter((batch) => params.batchId === undefined || batch.id === params.batchId)
    .map((batch) => {
      const counts = EMPTY_STATUS_COUNTS();
      for (const item of state.items) {
        if (item.batchId === batch.id) counts[item.status] += 1;
      }
      const handoff = handoffByBatch.get(batch.id);
      return {
        id: batch.id,
        name: batch.name,
        ...(batch.description !== undefined ? { description: batch.description } : {}),
        createdAt: batch.createdAt,
        revision: batch.revision,
        itemCount: batch.itemIds.length,
        statusCounts: counts,
        ...(handoff
          ? { handoffState: handoff.deliveryState }
          : { handoffState: "none" as const }),
      };
    });
  return { revision, read, batches, items: page, total };
}

function withFeedbackCounts(
  feedback: readonly WorkbenchFeedback[],
  view: WorkbenchItemView,
): WorkbenchItemView {
  return {
    ...view,
    feedbackCount: feedback.length,
    confirmedFeedbackCount: feedback.filter((record) => record.state === "confirmed").length,
  };
}

/** Read projection for workbench.changes (see WORKBENCH_CHANGES_NOTE). */
export function workbenchChangesView(
  state: WorkbenchProjectState,
  revision: number,
  params: WorkbenchChangesParams,
): WorkbenchChangesResult {
  if (!state.batches.some((batch) => batch.id === params.batchId)) {
    throw new FacadeError("NOT_FOUND", `workbench.changes: batch "${params.batchId}" not found`, {
      batchId: params.batchId,
    });
  }
  if (params.cursor !== undefined && params.cursor > revision) {
    throw new FacadeError(
      "CONFLICT",
      `workbench.changes: cursor ${params.cursor} is newer than the current revision ${revision}`,
      { currentRevision: revision },
    );
  }
  const stale = params.cursor !== undefined && params.cursor < revision;
  if (params.cursor !== undefined && params.cursor === revision) {
    return {
      projectRevision: revision,
      cursor: params.cursor,
      stale: false,
      decided: [],
      handoffEvents: [],
      note: WORKBENCH_CHANGES_NOTE,
    };
  }
  const items = workbenchBatchItems(state, params.batchId);
  const decided = items.flatMap((item) =>
    item.decisionLog.map((entry) => ({
      itemId: item.id,
      batchId: item.batchId,
      decision: entry.decision,
      decisionRevision: entry.decisionRevision,
      baseVersion: entry.baseVersion,
      decidedAt: entry.decidedAt,
      operator: entry.operator,
      ...(entry.contentRevisionId ? { contentRevisionId: entry.contentRevisionId } : {}),
    })),
  );
  const handoffEvents = state.handoffs
    .filter((handoff) => handoff.batchId === params.batchId)
    .map((handoff) => ({
      handoffId: handoff.handoffId,
      batchId: handoff.batchId,
      deliveryState: handoff.deliveryState,
      publishedAt: handoff.publishedAt,
      ...(handoff.supersedesHandoffId ? { supersedesHandoffId: handoff.supersedesHandoffId } : {}),
      itemCount: handoff.items.length,
    }));
  return {
    projectRevision: revision,
    cursor: params.cursor ?? null,
    stale,
    decided,
    handoffEvents,
    note: WORKBENCH_CHANGES_NOTE,
  };
}

/** Full immutable snapshot read for workbench.handoff.get. */
export function workbenchHandoffGetView(
  state: WorkbenchProjectState,
  revision: number,
  params: WorkbenchHandoffGetParams,
): WorkbenchHandoffGetResult {
  if (
    params.handoffId !== undefined &&
    params.snapshotId !== undefined &&
    params.handoffId !== params.snapshotId
  ) {
    throw new FacadeError(
      "INVALID_PARAMS",
      "workbench.handoff.get: handoffId and snapshotId must identify the same snapshot",
      { handoffId: params.handoffId, snapshotId: params.snapshotId },
    );
  }
  const requestedId = params.snapshotId ?? params.handoffId;
  if (requestedId === undefined) {
    // Header-only read: no content is synthesized from current items/tags.
    const latest = state.handoffs[0];
    const header: WorkbenchHandoffHeader | null = latest
      ? {
          snapshotId: latest.handoffId,
          handoffId: latest.handoffId,
          batchId: latest.batchId,
          batchName: latest.batchName,
          publishedAt: latest.publishedAt,
          deliveryState: latest.deliveryState,
          ...(latest.snapshotSchemaVersion !== undefined
            ? { snapshotSchemaVersion: latest.snapshotSchemaVersion }
            : {}),
          itemCount: latest.items.length,
        }
      : null;
    return { revision, latest: header };
  }
  const handoff = state.handoffs.find((candidate) => candidate.handoffId === requestedId);
  if (!handoff) {
    throw new FacadeError("NOT_FOUND", `workbench.handoff.get: handoff "${requestedId}" not found`, {
      handoffId: requestedId,
    });
  }
  return { revision, handoff: structuredClone(handoff) };
}

/** Cross-field rules for workbench.content.update that stay out of the schema. */
export function validateWorkbenchContentUpdateOp(op: WorkbenchContentUpdateOp, label: string): void {
  if (op.kind === "text" && op.text === undefined) {
    throw new FacadeError("INVALID_PARAMS", `${label}: kind "text" requires the complete new text`);
  }
  if (op.kind === "text" && op.patches !== undefined) {
    throw new FacadeError("INVALID_PARAMS", `${label}: kind "text" must not carry patches`);
  }
  if (op.kind === "data" && op.patches === undefined) {
    throw new FacadeError("INVALID_PARAMS", `${label}: kind "data" requires 1-2000 cell patches`);
  }
  if (op.kind === "data" && op.text !== undefined) {
    throw new FacadeError("INVALID_PARAMS", `${label}: kind "data" must not carry text`);
  }
  if (op.kind === "data") {
    for (const [index, patch] of (op.patches ?? []).entries()) {
      if (patch.proposalId === undefined && patch.proposalOutcome !== undefined) {
        throw new FacadeError(
          "INVALID_PARAMS",
          `${label}.patches[${index}]: proposalOutcome requires proposalId`,
        );
      }
      if (patch.value === undefined && patch.proposalId === undefined) {
        throw new FacadeError(
          "INVALID_PARAMS",
          `${label}.patches[${index}]: a patch without a value must resolve a proposal`,
        );
      }
    }
  }
}
