/**
 * Pure status machine for agent media tasks.
 *
 * Mirrors the facade job registry semantics: transitions move forward only,
 * terminal states are frozen, and a task that lands in `error`/`cancelled`
 * never keeps artifact references (a failed task exposes no partial result).
 * Late callbacks hitting a terminal state are rejected here; callers that
 * want "late receipt ignored" semantics check `isTerminalTaskStatus` first.
 */
import type {
  AgentMediaTaskRecord,
  AgentMediaTaskStatus,
} from "./types";

/** Linear non-terminal progression; indices must strictly increase. */
const STATUS_ORDER: readonly AgentMediaTaskStatus[] = [
  "queued",
  "submitted",
  "running",
  "awaiting_import",
  "done",
];

const TERMINAL: ReadonlySet<AgentMediaTaskStatus> = new Set([
  "done",
  "error",
  "cancelled",
]);

export function isTerminalTaskStatus(status: AgentMediaTaskStatus): boolean {
  return TERMINAL.has(status);
}

function statusRank(status: AgentMediaTaskStatus): number {
  return STATUS_ORDER.indexOf(status);
}

/**
 * Forward-only check over the linear chain (queued → submitted → running →
 * awaiting_import → done). Races collapse to the furthest observed state,
 * matching the facade's tolerance for queued→running. error/cancelled are
 * reachable from every non-terminal state; terminal states accept nothing.
 */
export function canTransitionTaskStatus(
  from: AgentMediaTaskStatus,
  to: AgentMediaTaskStatus,
): boolean {
  if (to === "error" || to === "cancelled") return !TERMINAL.has(from);
  const fromRank = statusRank(from);
  const toRank = statusRank(to);
  if (fromRank < 0 || toRank < 0) return false;
  return toRank > fromRank;
}

export function canRetryTask(record: AgentMediaTaskRecord): boolean {
  return record.status === "error" || record.status === "cancelled";
}

export interface TaskTransitionPatch {
  readonly resultPath?: string;
  readonly resultMediaId?: string;
  readonly insertedClipId?: string;
  readonly error?: { readonly code: string; readonly message: string };
  readonly failureReason?: string;
}

export type TaskTransitionResult =
  | { readonly ok: true; readonly record: AgentMediaTaskRecord }
  | { readonly ok: false; readonly code: "INVALID_TRANSITION"; readonly message: string };

/**
 * Apply a status change to a record without touching `revision` (the CAS
 * guard belongs to the persistence layer) or `attempt` (belongs to retry).
 * Forward moves carry existing artifact fields through and let the patch
 * override them; entering error/cancelled always strips artifact
 * references — a failed task exposes no partial result. Timestamps are
 * maintained here: `submittedAt` on first entering submitted,
 * `completedAt` on reaching done/error/cancelled.
 */
export function applyTaskStatusTransition(
  record: AgentMediaTaskRecord,
  to: AgentMediaTaskStatus,
  patch: TaskTransitionPatch = {},
  now: string = new Date().toISOString(),
): TaskTransitionResult {
  if (record.status === to) {
    return {
      ok: false,
      code: "INVALID_TRANSITION",
      message: `task ${record.id} is already ${to}`,
    };
  }
  if (!canTransitionTaskStatus(record.status, to)) {
    return {
      ok: false,
      code: "INVALID_TRANSITION",
      message: `task ${record.id} cannot move from ${record.status} to ${to}`,
    };
  }

  if (to === "error" || to === "cancelled") {
    const { resultPath: _path, resultMediaId: _mediaId, insertedClipId: _clipId, error: _error, failureReason: _reason, ...rest } = record;
    return {
      ok: true,
      record: {
        ...rest,
        status: to,
        updatedAt: now,
        completedAt: now,
        ...(to === "error" && patch.error !== undefined ? { error: patch.error } : {}),
        ...(patch.failureReason !== undefined ? { failureReason: patch.failureReason } : {}),
      },
    };
  }

  return {
    ok: true,
    record: {
      ...record,
      status: to,
      updatedAt: now,
      ...(record.submittedAt === undefined && (to === "submitted" || to === "running" || to === "awaiting_import" || to === "done")
        ? { submittedAt: now }
        : {}),
      ...(patch.resultPath !== undefined ? { resultPath: patch.resultPath } : {}),
      ...(patch.resultMediaId !== undefined ? { resultMediaId: patch.resultMediaId } : {}),
      ...(patch.insertedClipId !== undefined ? { insertedClipId: patch.insertedClipId } : {}),
      ...(to === "done" ? { completedAt: now } : {}),
    },
  };
}

/**
 * Re-arm a terminal (error/cancelled) task for another attempt: fresh
 * requestId, attempt+1, artifact/error state cleared, status back to queued.
 */
export function applyTaskRetry(
  record: AgentMediaTaskRecord,
  nextRequestId: string,
  now: string = new Date().toISOString(),
): TaskTransitionResult {
  if (!canRetryTask(record)) {
    return {
      ok: false,
      code: "INVALID_TRANSITION",
      message: `task ${record.id} in status ${record.status} cannot be retried`,
    };
  }
  return {
    ok: true,
    record: {
      id: record.id,
      recordVersion: record.recordVersion,
      requestId: nextRequestId,
      kind: record.kind,
      promptText: record.promptText,
      ...(record.requirementsText !== undefined
        ? { requirementsText: record.requirementsText }
        : {}),
      ...(record.overrides !== undefined ? { overrides: record.overrides } : {}),
      status: "queued",
      ...(record.sanitizedInfo !== undefined ? { sanitizedInfo: record.sanitizedInfo } : {}),
      targetProjectId: record.targetProjectId,
      ...(record.targetProjectName !== undefined
        ? { targetProjectName: record.targetProjectName }
        : {}),
      insertIntent: record.insertIntent,
      autoConfirm: record.autoConfirm,
      ...(record.autoConfirmNotice !== undefined
        ? { autoConfirmNotice: record.autoConfirmNotice }
        : {}),
      attempt: record.attempt + 1,
      revision: record.revision,
      ...(record.sessionIdHint !== undefined ? { sessionIdHint: record.sessionIdHint } : {}),
      ...(record.outputDirectory !== undefined ? { outputDirectory: record.outputDirectory } : {}),
      createdAt: record.createdAt,
      updatedAt: now,
    },
  };
}
