import type { ObjectSchema } from "./validate";
import {
  isNonEmptyString,
  isNonNegativeInteger,
  oneOf,
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
  "media.cleanup.plan": { projectId: optionalString },
  "media.cleanup.execute": { projectId: optionalString, planId: requiredString, idempotencyKey: optionalString },
};
