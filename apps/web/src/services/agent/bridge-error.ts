import { WorkspaceManagerError } from "../workspace-manager";

/**
 * Shared error classification for the agent bridges.
 *
 * workspace-manager failures carry their identity on the error itself
 * (`WorkspaceManagerError.code`), so the bridges classify through the code —
 * via `instanceof` or the duck-typed `{ code }` shape the bridges use for
 * their own guard errors — instead of matching message substrings. The
 * human-readable message stays display-only and may change freely.
 */

export type WorkspaceManagerCode = "CONFLICT" | "NOT_FOUND" | "INVALID_PARAMS";

const MANAGER_CODES: ReadonlySet<string> = new Set<WorkspaceManagerCode>([
  "CONFLICT",
  "NOT_FOUND",
  "INVALID_PARAMS",
]);

/**
 * The manager code a thrown error carries, or undefined when the error is
 * not a manager failure (nor a bridge guard error reusing the same codes).
 * Callers keep their own default classification for undefined.
 */
export function managerErrorCode(error: unknown): WorkspaceManagerCode | undefined {
  if (error instanceof WorkspaceManagerError) return error.code;
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && MANAGER_CODES.has(code)) {
      return code as WorkspaceManagerCode;
    }
  }
  return undefined;
}

/** `WorkspaceManagerError.details` as an object, when the error carries one. */
export function managerErrorDetails(error: unknown): Record<string, unknown> | undefined {
  const details = error instanceof WorkspaceManagerError
    ? error.details
    : (error as { details?: unknown })?.details;
  return typeof details === "object" && details !== null
    ? (details as Record<string, unknown>)
    : undefined;
}

/**
 * A plain error carrying one manager code — for the bridges' own guard
 * throws, so the same code-first classification applies to them without
 * inspecting message text.
 */
export function codedError(code: WorkspaceManagerCode, message: string): Error {
  return Object.assign(new Error(message), { code });
}
