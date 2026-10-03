/**
 * Durable voiceover/music task records for reviewing and importing output files.
 * Task generation is unavailable. Status transitions are forward-only;
 * terminal states are immutable.
 */

export const AGENT_TASK_RECORD_VERSION = 1;

export const AGENT_MEDIA_TASK_KINDS = ["tts", "music"] as const;
export type AgentMediaTaskKind = (typeof AGENT_MEDIA_TASK_KINDS)[number];

export const AGENT_MEDIA_TASK_STATUSES = [
  "queued",
  "submitted",
  "running",
  "awaiting_import",
  "done",
  "error",
  "cancelled",
] as const;
export type AgentMediaTaskStatus = (typeof AGENT_MEDIA_TASK_STATUSES)[number];

export type AgentMediaTaskTerminalStatus = "done" | "error" | "cancelled";

export const AGENT_MEDIA_TASK_INSERT_INTENTS = ["timeline", "library-only"] as const;
export type AgentMediaTaskInsertIntent =
  (typeof AGENT_MEDIA_TASK_INSERT_INTENTS)[number];

/**
 * Optional request refinements kept for compatibility with stored tasks.
 */
export interface AgentMediaTaskOverrides {
  readonly language?: string;
  readonly targetDurationSeconds?: number;
  readonly styleHint?: string;
}

/**
 * Confirmation mode in stored task records. The renderer does not create
 * or automatically confirm tasks.
 */
export type AgentMediaTaskAutoConfirmMode = "receipt" | "manual-only";

export interface AgentMediaTaskRecord {
  /** `amt_<uuid>`; the operation identity. Names are for search only. */
  readonly id: string;
  /** Compatibility shim for future schema changes; readers stay conservative. */
  readonly recordVersion: number;
  /**
   * Idempotency key retained with the stored record and reused for artifact import.
   */
  readonly requestId: string;
  readonly kind: AgentMediaTaskKind;
  /** The user's own wording (read-aloud text / music brief); kept for retry. */
  readonly promptText: string;
  readonly requirementsText?: string;
  readonly overrides?: AgentMediaTaskOverrides;
  readonly status: AgentMediaTaskStatus;
  /** Redacted generation summary (agent name / self-reported label only). */
  readonly sanitizedInfo?: string;
  /** Generated file path inside the task's job output directory, pre-import. */
  readonly resultPath?: string;
  /** Project media id once the product imported the artifact. */
  readonly resultMediaId?: string;
  /** One-line human-readable failure reason (mirrors `error.message`). */
  readonly failureReason?: string;
  readonly error?: { readonly code: string; readonly message: string };
  /** Snapshot taken at first submission; never retargeted. */
  readonly targetProjectId: string;
  /** Display hint only; the project may be renamed or deleted afterwards. */
  readonly targetProjectName?: string;
  readonly insertIntent: AgentMediaTaskInsertIntent;
  /** Clip id once inserted into the target timeline (duplicate-insert guard). */
  readonly insertedClipId?: string;
  readonly autoConfirm: AgentMediaTaskAutoConfirmMode;
  /** Present when auto-confirm is impossible; shown to the user verbatim. */
  readonly autoConfirmNotice?: string;
  /** Retry counter; a retry keeps the record and mints a fresh requestId. */
  readonly attempt: number;
  /** Monotonic CAS guard incremented on every persisted change. */
  readonly revision: number;
  /** Opaque display hint for the external session; the session itself is
   *  owned by the external Agent and is never persisted here. */
  readonly sessionIdHint?: string;
  /**
   * Precast artifact output directory captured at creation
   * (`<recommendedRoot>/jobs/<taskId>/output`), so later prompt submissions
   * and receipt path matching share one immutable location.
   */
  readonly outputDirectory?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly submittedAt?: string;
  readonly completedAt?: string;
}
