import type { ObjectSchema } from "./validate";
import {
  isNonNegativeNumber,
  isNonEmptyString,
  isNonNegativeInteger,
  oneOf,
  matchesSchema,
} from "./validate";
import type { WorkspaceVerb } from "./workspace-library";

const requiredString = {
  check: isNonEmptyString,
  describe: "a non-empty string",
  required: true,
  emits: { kind: "leaf" as const, schema: { type: "string" as const, minLength: 1 } },
};
const optionalString = {
  check: isNonEmptyString,
  describe: "a non-empty string",
  emits: { kind: "leaf" as const, schema: { type: "string" as const, minLength: 1 } },
};
const requiredRevision = {
  check: isNonNegativeInteger,
  describe: "a non-negative integer",
  required: true,
  emits: { kind: "leaf" as const, schema: { type: "integer" as const, minimum: 0 } },
};
const requiredKey = {
  check: isNonEmptyString,
  describe: "a non-empty idempotency key",
  required: true,
  emits: { kind: "leaf" as const, schema: { type: "string" as const, minLength: 1 } },
};
const optionalStringArray = {
  check: (value: unknown) => Array.isArray(value) && value.every(isNonEmptyString),
  describe: "an array of non-empty strings",
  emits: {
    kind: "array" as const,
    items: { kind: "leaf" as const, schema: { type: "string" as const, minLength: 1 } },
  },
};
const requiredStringArray = {
  ...optionalStringArray,
  required: true,
};
const cleanupTaskFileSchema = {
  jobId: requiredString,
  path: requiredString,
  sizeBytes: {
    check: isNonNegativeInteger,
    describe: "a non-negative integer",
    required: true,
    emits: { kind: "leaf" as const, schema: { type: "integer" as const, minimum: 0 } },
  },
  lastModifiedMs: {
    check: isNonNegativeNumber,
    describe: "a non-negative finite number",
    required: true,
    emits: { kind: "leaf" as const, schema: { type: "number" as const, minimum: 0 } },
  },
};
const requiredCleanupTaskFiles = {
  check: (value: unknown) => Array.isArray(value) && value.every((file) => matchesSchema(file, cleanupTaskFileSchema)),
  describe: "an array of exact failed-task file fingerprints",
  required: true,
  emits: {
    kind: "array" as const,
    items: { kind: "object" as const, schema: cleanupTaskFileSchema },
  },
};
const cleanupWorkFileSchema = { ...cleanupTaskFileSchema, fileId: requiredString };
const optionalCleanupWorkFiles = {
  check: (value: unknown) => Array.isArray(value) && value.every((file) => matchesSchema(file, cleanupWorkFileSchema)),
  describe: "exact producer-tracked work file fingerprints from the reviewed plan",
  emits: { kind: "array" as const, items: { kind: "object" as const, schema: cleanupWorkFileSchema } },
};
const cleanupAction = {
  check: oneOf(["purge-media", "purge-deleted-nodes", "recycle-nodes", "restore-nodes", "purge-cache", "purge-failed-jobs", "purge-work-files"] as const),
  describe: "a supported cleanup action",
  required: true,
  emits: {
    kind: "leaf" as const,
    schema: { enum: ["purge-media", "purge-deleted-nodes", "recycle-nodes", "restore-nodes", "purge-cache", "purge-failed-jobs", "purge-work-files"] as const },
  },
};
const confirmedTrue = {
  check: (value: unknown) => value === true,
  describe: "true after explicit confirmation of the reviewed scope",
  required: true,
  emits: { kind: "leaf" as const, schema: { type: "boolean" as const } },
};

export const WORKSPACE_VERB_SCHEMAS: Readonly<Record<WorkspaceVerb, ObjectSchema>> = {
  "project.list": {},
  "workspace.list": { projectId: requiredString },
  "workspace.create": {
    projectId: requiredString,
    name: optionalString,
    sourceNodeId: optionalString,
    sourceWorkspaceId: optionalString,
    kind: {
      check: oneOf(["trial"] as const),
      describe: '"trial"',
      emits: { kind: "leaf", schema: { enum: ["trial"] } },
    },
    idempotencyKey: optionalString,
  },
  "workspace.delete": {
    projectId: requiredString,
    workspaceId: requiredString,
    expectedRevision: requiredRevision,
    idempotencyKey: optionalString,
  },
  "workspace.close": { projectId: requiredString, workspaceId: requiredString },
  "workspace.switch_view": { projectId: requiredString, workspaceId: requiredString },
  "workspace.list_drafts": { projectId: requiredString, workspaceId: requiredString },
  "workspace.recover_draft": {
    projectId: requiredString,
    workspaceId: requiredString,
    draftId: requiredString,
    expectedRevision: requiredRevision,
    idempotencyKey: requiredKey,
  },
  "node.list": { projectId: requiredString },
  "node.get": { projectId: requiredString, nodeId: requiredString },
  "node.save": {
    projectId: requiredString,
    workspaceId: requiredString,
    name: optionalString,
    summary: optionalString,
    expectedRevision: requiredRevision,
    idempotencyKey: requiredKey,
  },
  "node.restore": {
    projectId: requiredString,
    workspaceId: requiredString,
    nodeId: requiredString,
    expectedRevision: requiredRevision,
    idempotencyKey: requiredKey,
  },
  "node.rename": {
    projectId: requiredString,
    nodeId: requiredString,
    name: requiredString,
    summary: optionalString,
  },
  "node.media": { projectId: requiredString, nodeId: requiredString },
  "node.compare": {
    projectId: requiredString,
    fromNodeId: requiredString,
    toNodeId: requiredString,
  },
  "media.references": {
    projectId: requiredString,
    mediaId: requiredString,
    workspaceId: optionalString,
  },
  "media.cleanup.review": {
    projectId: requiredString,
    workspaceId: requiredString,
    exportId: optionalString,
    cleanupTaskId: optionalString,
    selectedNodeIds: optionalStringArray,
  },
  "media.cleanup.plan": {
    projectId: requiredString,
    workspaceId: requiredString,
    exportId: optionalString,
    cleanupTaskId: optionalString,
    action: cleanupAction,
    nodeIds: optionalStringArray,
    mediaIds: optionalStringArray,
    cacheKeys: optionalStringArray,
    jobIds: optionalStringArray,
    workFileIds: optionalStringArray,
  },
  "media.cleanup.execute": {
    planId: requiredString,
    projectId: requiredString,
    workspaceId: requiredString,
    exportId: optionalString,
    cleanupTaskId: optionalString,
    action: cleanupAction,
    revision: requiredRevision,
    workspaceInstanceId: requiredString,
    nodeIds: requiredStringArray,
    mediaIds: requiredStringArray,
    cacheKeys: requiredStringArray,
    cleanupTaskNodeIds: requiredStringArray,
    jobIds: requiredStringArray,
    jobFiles: requiredCleanupTaskFiles,
    workFiles: optionalCleanupWorkFiles,
    confirmed: confirmedTrue,
  },
};
