/**
 * Typed facade error taxonomy (audit/facade-v0.md contract #5).
 * Domain failures are reported via `{ ok: false, error }` results — callers
 * must never rely on string matching, only on `code`.
 */
export const FACADE_ERROR_CODES = [
  "INVALID_PARAMS",
  "NOT_FOUND",
  "CONFLICT",
  "UNSUPPORTED",
  "CONFIRMATION_REQUIRED",
  "JOB_FAILED",
  "ACTION_FAILED",
  "INTERNAL",
  /**
   * The session's explicit read-only access forbids the verb outright. Distinct from CONFLICT,
   * which reports a retryable state/lease precondition — FORBIDDEN is a
   * property of the session's access authorization, not of the current state.
   */
  "FORBIDDEN",
] as const;

export type FacadeErrorCode = (typeof FACADE_ERROR_CODES)[number];

export interface FacadeErrorBody {
  readonly code: FacadeErrorCode;
  readonly message: string;
  /** Machine-readable context (e.g. `{ currentRevision }` on CONFLICT). */
  readonly details?: Record<string, unknown>;
}

export class FacadeError extends Error implements FacadeErrorBody {
  readonly code: FacadeErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: FacadeErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "FacadeError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }

  toBody(): FacadeErrorBody {
    return {
      code: this.code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

export type FacadeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: FacadeErrorBody };

export function ok<T>(value: T): FacadeResult<T> {
  return { ok: true, value };
}

export function fail<T = never>(error: FacadeError): FacadeResult<T> {
  return { ok: false, error: error.toBody() };
}

/** Normalize any thrown value into a FAILED result with a typed code. */
export function toFailure<T>(error: unknown): FacadeResult<T> {
  if (error instanceof FacadeError) return fail(error);
  const message = error instanceof Error ? error.message : String(error);
  return fail(new FacadeError("INTERNAL", message));
}
