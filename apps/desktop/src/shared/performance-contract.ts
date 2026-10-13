/**
 * IPC contract for the performance measurement system (design phase P1).
 *
 * Shared between the main-process session manager and the preload bridge.
 * Every message carries a schemaVersion; receivers validate with the narrow
 * is* guards below and reject anything else as invalid_request — unknown or
 * malformed payloads are never forwarded, which is also the privacy rule:
 * only these known fields cross the bridge. Error replies carry a code, never
 * a free-form message.
 */

export const PERFORMANCE_IPC = {
  start: "reelterminal:performance:start",
  stop: "reelterminal:performance:stop",
  clockPing: "reelterminal:performance:clock:ping",
  clockPong: "reelterminal:performance:clock:pong",
} as const;

export const PERFORMANCE_CONTRACT_SCHEMA_VERSION = 1;

export type PerfSessionMode = "counts" | "light" | "trace";

export type PerfSessionErrorCode =
  | "session_already_active"
  | "no_active_session"
  | "invalid_request"
  | "internal_error";

export interface PerfStartRequest {
  readonly schemaVersion: number;
  readonly runId?: string;
  readonly mode: PerfSessionMode;
  readonly runClockHandshake?: boolean;
  readonly budgets?: { readonly captureSeconds?: number };
}

export interface PerfClockEstimateSummary {
  readonly valid: boolean;
  readonly offsetUs: number | null;
  readonly uncertaintyUs: number | null;
  readonly sampleCount: number;
}

export type PerfStartReply =
  | { readonly ok: true; readonly runId: string; readonly clock: PerfClockEstimateSummary | null }
  | { readonly ok: false; readonly error: PerfSessionErrorCode };

export interface PerfProcessSampleSummary {
  readonly tsUs: number;
  readonly role: string;
  readonly pid: number;
  readonly rssBytes: number;
}

export interface PerfStopRequest {
  readonly schemaVersion: number;
  readonly runId: string;
  readonly reason?: string;
  /** Renderer capture report; already sanitized by the renderer. */
  readonly rendererReport?: unknown;
}

export type PerfStopReply =
  | {
      readonly ok: true;
      readonly runId: string;
      readonly sessionDurationUs: number;
      readonly clock: PerfClockEstimateSummary | null;
      readonly processSamples: readonly PerfProcessSampleSummary[];
    }
  | { readonly ok: false; readonly error: PerfSessionErrorCode };

/** main → renderer, answered by the preload bridge's automatic responder. */
export interface PerfClockPing {
  readonly schemaVersion: number;
  readonly attempt: number;
}

/** renderer → main; r1/r2 are renderer-clock microseconds. */
export interface PerfClockPong {
  readonly schemaVersion: number;
  readonly attempt: number;
  readonly r1Us: number;
  readonly r2Us: number;
}

// ---------------------------------------------------------------------------
// Narrow runtime guards (pure, dependency-free)
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasSchemaVersion(value: Record<string, unknown>): boolean {
  return value.schemaVersion === PERFORMANCE_CONTRACT_SCHEMA_VERSION;
}

function isPerfSessionMode(value: unknown): value is PerfSessionMode {
  return value === "counts" || value === "light" || value === "trace";
}

export function isPerfStartRequest(value: unknown): value is PerfStartRequest {
  if (!isPlainObject(value) || !hasSchemaVersion(value)) return false;
  if (!isPerfSessionMode(value.mode)) return false;
  if (value.runId !== undefined && typeof value.runId !== "string") return false;
  if (value.runClockHandshake !== undefined && typeof value.runClockHandshake !== "boolean") {
    return false;
  }
  if (value.budgets !== undefined) {
    if (!isPlainObject(value.budgets)) return false;
    const seconds = value.budgets.captureSeconds;
    if (seconds !== undefined && (typeof seconds !== "number" || !Number.isFinite(seconds))) {
      return false;
    }
  }
  return true;
}

export function isPerfStopRequest(value: unknown): value is PerfStopRequest {
  if (!isPlainObject(value) || !hasSchemaVersion(value)) return false;
  if (typeof value.runId !== "string" || value.runId.length === 0) return false;
  if (value.reason !== undefined && typeof value.reason !== "string") return false;
  return true;
}

export function isPerfClockPing(value: unknown): value is PerfClockPing {
  if (!isPlainObject(value) || !hasSchemaVersion(value)) return false;
  return typeof value.attempt === "number" && Number.isInteger(value.attempt) && value.attempt >= 0;
}

export function isPerfClockPong(value: unknown): value is PerfClockPong {
  if (!isPlainObject(value) || !hasSchemaVersion(value)) return false;
  if (typeof value.attempt !== "number" || !Number.isInteger(value.attempt)) return false;
  for (const key of ["r1Us", "r2Us"] as const) {
    const ts = value[key];
    if (typeof ts !== "number" || !Number.isFinite(ts) || ts < 0) return false;
  }
  return true;
}
