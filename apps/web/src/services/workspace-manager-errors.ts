export type WorkspaceManagerErrorCode = "CONFLICT" | "NOT_FOUND" | "INVALID_PARAMS";

/**
 * Failure identity for workspace-manager operations. The human message stays
 * stable; agent bridges classify through `code` via `instanceof` or the
 * duck-typed `(error as { code?: string }).code` shape instead of matching on
 * message substrings.
 */
export class WorkspaceManagerError extends Error {
  readonly code: WorkspaceManagerErrorCode;
  readonly details?: unknown;

  constructor(code: WorkspaceManagerErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "WorkspaceManagerError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/**
 * Machine-readable retention purpose of a media reference. GC decisions
 * (`estimateProjectPurge`) key on this field; `label` is display-only.
 * Absent purpose on a task-kind reference is conservatively retained
 * (treated like a task result, never as a purgeable task input).
 */
export type MediaReferencePurpose = "task-input" | "task-result" | "export";
