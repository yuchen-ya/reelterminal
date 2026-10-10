import {
  FacadeError,
  FACADE_ERROR_CODES,
  type FacadeErrorCode,
} from "./errors";
import { isLiveStoreConflict } from "./live-store";
import type { FacadeVerb } from "./types";

/** Preserve typed renderer failures across the live facade boundary. */
export function liveControlBridgeFailure(error: unknown): FacadeError | null {
  const typed =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown; details?: unknown })
      : undefined;
  const code = typeof typed?.code === "string" ? typed.code : undefined;
  const details =
    typeof typed?.details === "object" && typed.details !== null
      ? (typed.details as Record<string, unknown>)
      : undefined;
  const message = error instanceof Error ? error.message : String(error);

  if (isLiveStoreConflict(error) || code === "CONFLICT") {
    return new FacadeError("CONFLICT", `editor.control: ${message}`, details);
  }
  // The renderer uses NO_PROJECT for a detached window; expose the facade's
  // stable public taxonomy rather than leaking a bridge-only code.
  if (code === "NO_PROJECT") {
    return new FacadeError(
      "NOT_FOUND",
      "editor.control: no project is open in the GUI",
      details,
    );
  }
  if (
    code !== undefined &&
    (FACADE_ERROR_CODES as readonly string[]).includes(code)
  ) {
    return new FacadeError(
      code as FacadeErrorCode,
      `editor.control: ${message}`,
      details,
    );
  }
  return null;
}

/**
 * The renderer owns the canonical user-level library (records + journal +
 * IndexedDB); the facade stays stateless and only validates, guards, and
 * forwards. Error codes cross the bridge as the facade's public taxonomy.
 */
export function materialBridgeFailure(verb: FacadeVerb, error: unknown): FacadeError {
  const typed =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown; message?: unknown; details?: unknown })
      : undefined;
  const message =
    (typeof typed?.message === "string" && typed.message) ||
    (error instanceof Error ? error.message : String(error));
  const details =
    typed?.details && typeof typed.details === "object"
      ? (typed.details as Record<string, unknown>)
      : undefined;
  const code = typeof typed?.code === "string" ? typed.code : undefined;
  if (isLiveStoreConflict(error) || code === "CONFLICT") {
    return new FacadeError("CONFLICT", `${verb}: ${message}`, details);
  }
  if (code === "NOT_FOUND" || code === "NO_PROJECT") {
    return new FacadeError(
      "NOT_FOUND",
      code === "NO_PROJECT"
        ? `${verb}: no project is open in the GUI`
        : `${verb}: ${message}`,
      details,
    );
  }
  if (code === "INVALID_PARAMS" || code === "UNSUPPORTED") {
    return new FacadeError(code, `${verb}: ${message}`, details);
  }
  if (code === "MISSING_FILE") {
    return new FacadeError("INVALID_PARAMS", `${verb}: ${message}`, {
      ...(details ?? {}),
      reason: "missing_file",
    });
  }
  return new FacadeError("INTERNAL", `${verb}: ${message}`, details);
}

/**
 * Placement/apply problems are parameter errors, not INTERNAL failures:
 * the specific renderer code is preserved in details.reason (TARGET_NOT_FOUND
 * maps to NOT_FOUND, matching the taxonomy's missing-entity code).
 */
export function presetBridgeFailure(verb: FacadeVerb, error: unknown): FacadeError {
  const typed =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown; message?: unknown; details?: unknown })
      : undefined;
  const code = typeof typed?.code === "string" ? typed.code : undefined;
  const message =
    (typeof typed?.message === "string" && typed.message) ||
    (error instanceof Error ? error.message : String(error));
  const details =
    typed?.details && typeof typed.details === "object"
      ? (typed.details as Record<string, unknown>)
      : undefined;
  if (code === "TARGET_NOT_FOUND") {
    return new FacadeError("NOT_FOUND", `${verb}: ${message}`, details);
  }
  if (
    code === "PLACEMENT_INVALID" ||
    code === "TARGET_REQUIRED" ||
    code === "TARGET_MISMATCH" ||
    code === "PRESET_INVALID" ||
    code === "PRESET_APPLY_UNSUPPORTED" ||
    code === "PAYLOAD_VERSION_UNSUPPORTED"
  ) {
    return new FacadeError("INVALID_PARAMS", `${verb}: ${message}`, {
      ...(details ?? {}),
      reason: code,
    });
  }
  return materialBridgeFailure(verb, error);
}

export function liveUnavailable(verb: string, why: string): FacadeError {
  return new FacadeError(
    "UNSUPPORTED",
    `${verb}: unavailable in live mode — ${why}`,
  );
}
