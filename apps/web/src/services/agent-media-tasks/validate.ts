/**
 * Conservative record validation for rows read back from the agent-task
 * IndexedDB store. Rows written by a newer application (higher record
 * version) are never misread; callers drop them into an "unreadable" list
 * instead, mirroring the media-recovery conservative-read precedent.
 */
import {
  AGENT_MEDIA_TASK_INSERT_INTENTS,
  AGENT_MEDIA_TASK_KINDS,
  AGENT_MEDIA_TASK_STATUSES,
  AGENT_TASK_RECORD_VERSION,
  type AgentMediaTaskRecord,
} from "./types";

export type AgentTaskValidationResult =
  | { readonly ok: true; readonly value: AgentMediaTaskRecord }
  | { readonly ok: false; readonly code: "NEWER_RECORD_VERSION" | "INVALID_RECORD"; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function invalid(message: string): AgentTaskValidationResult {
  return { ok: false, code: "INVALID_RECORD", message };
}

export function validateAgentTaskRecord(raw: unknown): AgentTaskValidationResult {
  if (!isRecord(raw)) return invalid("row is not an object");
  const record = raw as { recordVersion?: unknown };

  const recordVersion =
    typeof record.recordVersion === "number"
      ? record.recordVersion
      : AGENT_TASK_RECORD_VERSION;
  if (recordVersion > AGENT_TASK_RECORD_VERSION) {
    return {
      ok: false,
      code: "NEWER_RECORD_VERSION",
      message: `record version ${recordVersion} is newer than supported version ${AGENT_TASK_RECORD_VERSION}`,
    };
  }

  if (typeof raw.id !== "string" || raw.id.length === 0) return invalid("id must be a non-empty string");
  if (typeof raw.requestId !== "string" || raw.requestId.length === 0) {
    return invalid("requestId must be a non-empty string");
  }
  if (!(AGENT_MEDIA_TASK_KINDS as readonly string[]).includes(raw.kind as never)) {
    return invalid(`unknown task kind: ${String(raw.kind)}`);
  }
  // Music records may carry an empty description when the brief lives in
  // the requirement wording; every task still needs the field present.
  if (
    typeof raw.promptText !== "string" ||
    (raw.promptText.length === 0 && raw.kind !== "music")
  ) {
    return invalid("promptText must be a non-empty string");
  }
  if (!(AGENT_MEDIA_TASK_STATUSES as readonly string[]).includes(raw.status as never)) {
    return invalid(`unknown task status: ${String(raw.status)}`);
  }
  if (typeof raw.targetProjectId !== "string" || raw.targetProjectId.length === 0) {
    return invalid("targetProjectId must be a non-empty string");
  }
  if (!(AGENT_MEDIA_TASK_INSERT_INTENTS as readonly string[]).includes(raw.insertIntent as never)) {
    return invalid(`unknown insert intent: ${String(raw.insertIntent)}`);
  }
  if (raw.autoConfirm !== "receipt" && raw.autoConfirm !== "manual-only") {
    return invalid("autoConfirm must be 'receipt' or 'manual-only'");
  }
  if (typeof raw.attempt !== "number" || !Number.isInteger(raw.attempt) || raw.attempt < 0) {
    return invalid("attempt must be a non-negative integer");
  }
  if (typeof raw.revision !== "number" || !Number.isInteger(raw.revision) || raw.revision < 1) {
    return invalid("revision must be a positive integer");
  }
  for (const key of ["createdAt", "updatedAt"] as const) {
    if (typeof raw[key] !== "string" || (raw[key] as string).length === 0) {
      return invalid(`${key} must be a non-empty string`);
    }
  }
  const overrides = raw.overrides;
  if (overrides !== undefined && !isRecord(overrides)) {
    return invalid("overrides must be an object when present");
  }
  const error = raw.error;
  if (
    error !== undefined &&
    (!isRecord(error) || typeof error.code !== "string" || typeof error.message !== "string")
  ) {
    return invalid("error must be { code, message } when present");
  }

  const validated: AgentMediaTaskRecord = {
    id: raw.id,
    recordVersion,
    requestId: raw.requestId,
    kind: raw.kind as AgentMediaTaskRecord["kind"],
    promptText: raw.promptText,
    ...(raw.requirementsText !== undefined
      ? { requirementsText: asOptionalString(raw.requirementsText) }
      : {}),
    ...(overrides !== undefined ? { overrides: overrides as AgentMediaTaskRecord["overrides"] } : {}),
    status: raw.status as AgentMediaTaskRecord["status"],
    ...(raw.sanitizedInfo !== undefined ? { sanitizedInfo: asOptionalString(raw.sanitizedInfo) } : {}),
    ...(raw.resultPath !== undefined ? { resultPath: asOptionalString(raw.resultPath) } : {}),
    ...(raw.resultMediaId !== undefined ? { resultMediaId: asOptionalString(raw.resultMediaId) } : {}),
    ...(raw.failureReason !== undefined ? { failureReason: asOptionalString(raw.failureReason) } : {}),
    ...(error !== undefined
      ? { error: { code: (error as { code: string }).code, message: (error as { message: string }).message } }
      : {}),
    targetProjectId: raw.targetProjectId,
    ...(raw.targetProjectName !== undefined
      ? { targetProjectName: asOptionalString(raw.targetProjectName) }
      : {}),
    insertIntent: raw.insertIntent as AgentMediaTaskRecord["insertIntent"],
    ...(raw.insertedClipId !== undefined ? { insertedClipId: asOptionalString(raw.insertedClipId) } : {}),
    autoConfirm: raw.autoConfirm,
    ...(raw.autoConfirmNotice !== undefined
      ? { autoConfirmNotice: asOptionalString(raw.autoConfirmNotice) }
      : {}),
    attempt: raw.attempt,
    revision: raw.revision,
    ...(raw.sessionIdHint !== undefined ? { sessionIdHint: asOptionalString(raw.sessionIdHint) } : {}),
    ...(raw.outputDirectory !== undefined ? { outputDirectory: asOptionalString(raw.outputDirectory) } : {}),
    createdAt: raw.createdAt as string,
    updatedAt: raw.updatedAt as string,
    ...(raw.submittedAt !== undefined ? { submittedAt: asOptionalString(raw.submittedAt) } : {}),
    ...(raw.completedAt !== undefined ? { completedAt: asOptionalString(raw.completedAt) } : {}),
  };
  return { ok: true, value: validated };
}
