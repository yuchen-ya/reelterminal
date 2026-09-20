/**
 * Data contract for user-level agent media tasks (voiceover / music).
 *
 * The product never talks to a media provider itself: it records what the
 * user asked for, hands a composed text prompt to the already-connected
 * external Agent conversation, and later receives the generated audio back
 * through the product's own import path. These records are the durable
 * ledger for that exchange — user-level, deliberately outside the project
 * store, because the target project may not be open while a task is running.
 *
 * The status set and its transition semantics mirror the facade job state
 * machine (JOB_STATES / JobRegistry in @reelterminal/agent-facade jobs.ts):
 * forward-only movement and frozen terminal states.
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
 * Optional request refinements. These are plain wording hints relayed to the
 * external Agent inside the prompt text — never provider API parameters,
 * because the product holds no provider knowledge at all.
 */
export interface AgentMediaTaskOverrides {
  readonly language?: string;
  readonly targetDurationSeconds?: number;
  readonly styleHint?: string;
}

/**
 * How a task result will be confirmed once the external Agent finishes.
 *  - "receipt": the agent_message channel is available, so the composed
 *    RESULT/ERROR receipt line is expected to arrive and can auto-advance
 *    the task.
 *  - "manual-only": the formal-reply capability bit is explicitly
 *    unsupported, so the conversation bridge drops the agent_message class
 *    and the correlator ignores any receipt that might still arrive on
 *    another channel. The task stays parked after submission until a human
 *    confirms or marks it failed.
 */
export type AgentMediaTaskAutoConfirmMode = "receipt" | "manual-only";

export interface AgentMediaTaskRecord {
  /** `amt_<uuid>`; the operation identity. Names are for search only. */
  readonly id: string;
  /** Compatibility shim for future schema changes; readers stay conservative. */
  readonly recordVersion: number;
  /**
   * Client-minted idempotency key, embedded in the prompt text as the receipt
   * marker. Unique across the ledger: replaying it returns the existing task.
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
