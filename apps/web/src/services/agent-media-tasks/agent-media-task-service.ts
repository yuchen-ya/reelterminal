/**
 * Access service for the user-level agent media task ledger.
 *
 * Single source of truth for task CRUD: an in-memory cache over the storage
 * layer, one promise-chained write lane serializing every mutation, and a
 * monotonic per-record `revision` used as a CAS guard so a concurrent actor
 * (dialog vs a late session callback) is rejected with CONFLICT instead of
 * silently clobbering state. Every mutation re-validates the status move
 * through the pure task machine, so terminal states stay frozen and
 * artifact references never survive error/cancellation.
 *
 * Creation is idempotent by `requestId`: replaying the same key returns the
 * existing record untouched, mirroring the facade idempotency-ledger
 * replay semantics. Every successful change commits in one storage
 * transaction and then broadcasts `reelterminal:agent-media-tasks-updated` on
 * `window`, so open panels re-render without polling.
 */
import { v4 as uuid } from "uuid";
import {
  decideTaskAutoConfirmation,
  MANUAL_CONFIRM_NOTICE,
  type AgentTaskAutoConfirmDecision,
  type AgentTaskCapabilityBits,
} from "./auto-confirm";
import { checkTargetProjectAvailability } from "./project-integrity";
import { taskHasRequirementText, taskOutputDirectory } from "./task-record-utils";
import { sanitizeGenerationInfo } from "./sanitize";
import {
  AGENT_TASK_RECORD_VERSION,
  AGENT_MEDIA_TASK_INSERT_INTENTS,
  AGENT_MEDIA_TASK_KINDS,
  type AgentMediaTaskInsertIntent,
  type AgentMediaTaskKind,
  type AgentMediaTaskStatus,
  type AgentMediaTaskOverrides,
  type AgentMediaTaskRecord,
} from "./types";
import {
  applyTaskRetry,
  applyTaskStatusTransition,
  type TaskTransitionPatch,
} from "./task-machine";
import {
  AgentTaskStorageUnavailableError,
  createIdbAgentTaskStorage,
  type AgentTaskStorage,
} from "./storage";
import { validateAgentTaskRecord } from "./validate";

export const AGENT_MEDIA_TASKS_UPDATED_EVENT = "reelterminal:agent-media-tasks-updated";

export function notifyAgentMediaTasksChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(AGENT_MEDIA_TASKS_UPDATED_EVENT));
  }
}

/** Window-event subscription helper; returns the unsubscribe function. */
export function subscribeAgentMediaTasks(
  listener: () => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(AGENT_MEDIA_TASKS_UPDATED_EVENT, listener);
  return () => {
    window.removeEventListener(AGENT_MEDIA_TASKS_UPDATED_EVENT, listener);
  };
}

export type AgentTaskServiceErrorCode =
  | "UNAVAILABLE"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_PARAMS"
  | "INVALID_TRANSITION"
  | "INTERNAL";

export interface AgentTaskServiceError {
  readonly ok: false;
  readonly code: AgentTaskServiceErrorCode;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export interface AgentTaskServiceResult<T> {
  readonly ok: true;
  readonly value: T;
}

export type AgentTaskServiceOutcome<T> =
  | AgentTaskServiceResult<T>
  | AgentTaskServiceError;

export interface AgentTaskUnreadableEntry {
  readonly id: string;
  readonly reason: string;
}

export interface AgentMediaTaskCreateInput {
  readonly kind: AgentMediaTaskKind;
  readonly promptText: string;
  readonly requirementsText?: string;
  readonly overrides?: AgentMediaTaskOverrides;
  readonly targetProjectId: string;
  readonly targetProjectName?: string;
  readonly insertIntent: AgentMediaTaskInsertIntent;
  /** Session capability bits at creation time; decides auto-confirm mode. */
  readonly capabilityBits?: AgentTaskCapabilityBits | null;
  /** Client-minted idempotency key; same key replays the first result. */
  readonly requestId?: string;
  readonly sessionIdHint?: string;
  /** Snapshot of `capabilities_get.mediaImport.recommendedRoot`, if known. */
  readonly recommendedRoot?: string | null;
  readonly id?: string;
  readonly now?: string;
}

export interface AgentMediaTaskCreated {
  readonly record: AgentMediaTaskRecord;
  /** True when an existing record was replayed for the same requestId. */
  readonly replayed: boolean;
}

export interface AgentMediaTaskSubmitInput {
  readonly autoConfirm: AgentTaskAutoConfirmDecision;
  readonly expectedRevision?: number;
  readonly now?: string;
}

export interface AgentMediaTaskRunningInput {
  readonly expectedRevision?: number;
  readonly now?: string;
}

export interface AgentMediaTaskAwaitingImportInput {
  /** Artifact path confirmed inside the task job output directory. */
  readonly resultPath: string;
  readonly expectedRevision?: number;
  readonly now?: string;
}

export interface AgentMediaTaskDoneInput {
  readonly resultPath?: string;
  readonly resultMediaId?: string;
  readonly insertedClipId?: string;
  readonly expectedRevision?: number;
  readonly now?: string;
}

export interface AgentMediaTaskErrorInput {
  readonly code: string;
  readonly message: string;
  readonly expectedRevision?: number;
  readonly now?: string;
}

export interface AgentMediaTaskCancelInput {
  readonly reason?: string;
  readonly expectedRevision?: number;
  readonly now?: string;
}

export interface AgentMediaTaskRetryInput {
  readonly expectedRevision?: number;
  readonly now?: string;
}

export interface AgentTaskTargetProjectVerification {
  readonly projectId: string;
  /** True when the record had to be failed because the project is gone. */
  readonly failedAsMissing: boolean;
}

function fail<T>(
  code: AgentTaskServiceErrorCode,
  message: string,
  details?: Record<string, unknown>,
): AgentTaskServiceOutcome<T> {
  return details ? { ok: false, code, message, details } : { ok: false, code, message };
}

function isoNow(now: string | undefined): string {
  return now ?? new Date().toISOString();
}

function requireNonEmpty(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export class AgentMediaTaskService {
  private readonly storage: AgentTaskStorage;
  private readonly records = new Map<string, AgentMediaTaskRecord>();
  private readonly requestIdIndex = new Map<string, AgentMediaTaskRecord>();
  private unreadableEntries: AgentTaskUnreadableEntry[] = [];
  private snapshot: AgentMediaTaskRecord[] = [];
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(storage: AgentTaskStorage = createIdbAgentTaskStorage()) {
    this.storage = storage;
  }

  /** Load + normalize persisted state once (idempotent, conservative). */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        const rawRows = await this.storage.loadAll();
        const unreadable: AgentTaskUnreadableEntry[] = [];
        for (const raw of rawRows) {
          const id =
            typeof raw === "object" && raw !== null && typeof (raw as { id?: unknown }).id === "string"
              ? (raw as { id: string }).id
              : "<missing-id>";
          const result = validateAgentTaskRecord(raw);
          if (result.ok) {
            this.records.set(result.value.id, result.value);
            this.requestIdIndex.set(result.value.requestId, result.value);
          } else {
            unreadable.push({ id, reason: result.message });
          }
        }
        this.unreadableEntries = unreadable;
        this.rebuildSnapshot();
        this.loaded = true;
      })().catch((error) => {
        this.loadPromise = null;
        throw error;
      });
    }
    return this.loadPromise;
  }

  private rebuildSnapshot(): void {
    this.snapshot = [...this.records.values()].sort(
      (first, second) =>
        second.updatedAt.localeCompare(first.updatedAt) ||
        first.id.localeCompare(second.id),
    );
  }

  private enqueue<T>(
    body: () => Promise<AgentTaskServiceOutcome<T>>,
  ): Promise<AgentTaskServiceOutcome<T>> {
    const next = this.chain.then(body, body);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private mapStorageError(error: unknown): AgentTaskServiceErrorCode {
    if (error instanceof AgentTaskStorageUnavailableError) return "UNAVAILABLE";
    return "INTERNAL";
  }

  private checkCas(
    current: AgentMediaTaskRecord,
    expectedRevision: number | undefined,
  ): AgentTaskServiceOutcome<never> | null {
    if (
      expectedRevision !== undefined &&
      expectedRevision !== current.revision
    ) {
      return fail(
        "CONFLICT",
        `task "${current.id}" was modified concurrently: expected revision ${expectedRevision}, current is ${current.revision} — re-read and retry`,
        { id: current.id, currentRevision: current.revision, expectedRevision },
      );
    }
    return null;
  }

  /**
   * Persist a transition: CAS check, pure machine application, revision
   * bump, single-transaction commit, cache refresh, change broadcast.
   */
  private async transitionTask(
    current: AgentMediaTaskRecord,
    to: AgentMediaTaskStatus,
    patch: TaskTransitionPatch,
    expectedRevision: number | undefined,
    now: string,
  ): Promise<AgentTaskServiceOutcome<AgentMediaTaskRecord>> {
    const casError = this.checkCas(current, expectedRevision);
    if (casError) return casError;
    const applied = applyTaskStatusTransition(current, to, patch, now);
    if (!applied.ok) {
      return fail("INVALID_TRANSITION", applied.message, {
        id: current.id,
        from: current.status,
        to,
      });
    }
    const next: AgentMediaTaskRecord = { ...applied.record, revision: current.revision + 1 };
    await this.storage.commit([next], []);
    this.records.set(next.id, next);
    this.requestIdIndex.set(next.requestId, next);
    this.rebuildSnapshot();
    notifyAgentMediaTasksChanged();
    return { ok: true, value: next };
  }

  /* ------------------------------ reads ------------------------------ */

  async list(): Promise<AgentTaskServiceOutcome<AgentTaskListResult>> {
    try {
      await this.chain;
      await this.ensureLoaded();
      return {
        ok: true,
        value: { tasks: this.snapshot, unreadable: this.unreadableEntries },
      };
    } catch (error) {
      return fail(this.mapStorageError(error), `agent task list failed: ${String(error)}`);
    }
  }

  async get(id: string): Promise<AgentTaskServiceOutcome<AgentMediaTaskRecord>> {
    try {
      await this.chain;
      await this.ensureLoaded();
      const record = this.records.get(id);
      if (!record) return fail("NOT_FOUND", `task "${id}" was not found`, { id });
      return { ok: true, value: record };
    } catch (error) {
      return fail(this.mapStorageError(error), `task read failed: ${String(error)}`);
    }
  }

  async getByRequestId(
    requestId: string,
  ): Promise<AgentTaskServiceOutcome<AgentMediaTaskRecord>> {
    try {
      await this.chain;
      await this.ensureLoaded();
      const record = this.requestIdIndex.get(requestId);
      if (!record) {
        return fail("NOT_FOUND", `no task for requestId "${requestId}"`, { requestId });
      }
      return { ok: true, value: record };
    } catch (error) {
      return fail(this.mapStorageError(error), `task read failed: ${String(error)}`);
    }
  }

  /** Synchronous snapshot for hook initial state (may be empty pre-load). */
  getSnapshot(): readonly AgentMediaTaskRecord[] {
    return this.snapshot;
  }

  /* ---------------------------- mutations ---------------------------- */

  async createTask(
    input: AgentMediaTaskCreateInput,
  ): Promise<AgentTaskServiceOutcome<AgentMediaTaskCreated>> {
    return this.enqueue(async () => {
      try {
        await this.ensureLoaded();
        const requestId = input.requestId
          ? requireNonEmpty(input.requestId)
          : `req_${uuid()}`;
        if (!requestId) {
          return fail("INVALID_PARAMS", "requestId 不能为空", { field: "requestId" });
        }
        const replayed = this.requestIdIndex.get(requestId);
        if (replayed) {
          return { ok: true, value: { record: replayed, replayed: true } };
        }
        if (!(AGENT_MEDIA_TASK_KINDS as readonly string[]).includes(input.kind)) {
          return fail("INVALID_PARAMS", `unknown task kind: ${String(input.kind)}`, {
            field: "kind",
          });
        }
        // A music task may carry its brief entirely in the requirement
        // wording; a voiceover task always needs the read-aloud text.
        const promptText = requireNonEmpty(input.promptText ?? "");
        if (
          !promptText &&
          !(input.kind === "music" && taskHasRequirementText(input.requirementsText, input.overrides))
        ) {
          return fail("INVALID_PARAMS", "promptText 不能为空", { field: "promptText" });
        }
        const targetProjectId = requireNonEmpty(input.targetProjectId ?? "");
        if (!targetProjectId) {
          return fail("INVALID_PARAMS", "targetProjectId 不能为空", {
            field: "targetProjectId",
          });
        }
        if (!(AGENT_MEDIA_TASK_INSERT_INTENTS as readonly string[]).includes(input.insertIntent)) {
          return fail(
            "INVALID_PARAMS",
            `unknown insert intent: ${String(input.insertIntent)}`,
            { field: "insertIntent" },
          );
        }
        const id = input.id ?? `amt_${uuid()}`;
        if (this.records.has(id)) {
          return fail("CONFLICT", `task "${id}" already exists`, { id });
        }
        const decision = decideTaskAutoConfirmation(input.capabilityBits);
        const now = isoNow(input.now);
        const recommendedRoot = input.recommendedRoot?.trim();
        const record: AgentMediaTaskRecord = {
          id,
          recordVersion: AGENT_TASK_RECORD_VERSION,
          requestId,
          kind: input.kind,
          promptText: promptText ?? "",
          ...(input.requirementsText !== undefined && input.requirementsText.trim().length > 0
            ? { requirementsText: input.requirementsText.trim() }
            : {}),
          ...(input.overrides !== undefined ? { overrides: input.overrides } : {}),
          status: "queued",
          targetProjectId,
          ...(input.targetProjectName !== undefined
            ? { targetProjectName: input.targetProjectName }
            : {}),
          insertIntent: input.insertIntent,
          autoConfirm: decision.mode,
          ...(decision.mode === "manual-only" ? { autoConfirmNotice: decision.reason } : {}),
          attempt: 0,
          revision: 1,
          ...(input.sessionIdHint !== undefined ? { sessionIdHint: input.sessionIdHint } : {}),
          ...(recommendedRoot
            ? { outputDirectory: taskOutputDirectorySnapshot(recommendedRoot, id) }
            : {}),
          createdAt: now,
          updatedAt: now,
        };
        await this.storage.commit([record], []);
        this.records.set(record.id, record);
        this.requestIdIndex.set(record.requestId, record);
        this.rebuildSnapshot();
        notifyAgentMediaTasksChanged();
        return { ok: true, value: { record, replayed: false } };
      } catch (error) {
        return fail(this.mapStorageError(error), `task create failed: ${String(error)}`);
      }
    });
  }

  /**
   * queued → submitted. The submission-time auto-confirm decision is
   * mandatory here: callers must have read the session capability bits at
   * submission time, so a session without the formal-reply capability parks
   * the task at submitted with an explicit notice instead of silently
   * waiting for a receipt the product would ignore anyway.
   */
  async markSubmitted(
    id: string,
    input: AgentMediaTaskSubmitInput,
  ): Promise<AgentTaskServiceOutcome<AgentMediaTaskRecord>> {
    return this.enqueue(async () => {
      try {
        await this.ensureLoaded();
        const current = this.records.get(id);
        if (!current) return fail("NOT_FOUND", `task "${id}" was not found`, { id });
        const casError = this.checkCas(current, input.expectedRevision);
        if (casError) return casError;
        const applied = applyTaskStatusTransition(current, "submitted", {}, isoNow(input.now));
        if (!applied.ok) {
          return fail("INVALID_TRANSITION", applied.message, {
            id,
            from: current.status,
            to: "submitted",
          });
        }
        // The submission-time decision is authoritative: flipping to
        // "receipt" must also drop a stale manual-only notice.
        const { autoConfirmNotice: _stale, ...carried } = applied.record;
        const withDecision: AgentMediaTaskRecord = {
          ...carried,
          autoConfirm: input.autoConfirm.mode,
          ...(input.autoConfirm.mode === "manual-only"
            ? { autoConfirmNotice: input.autoConfirm.reason || MANUAL_CONFIRM_NOTICE }
            : {}),
        };
        const next: AgentMediaTaskRecord = { ...withDecision, revision: current.revision + 1 };
        await this.storage.commit([next], []);
        this.records.set(next.id, next);
        this.requestIdIndex.set(next.requestId, next);
        this.rebuildSnapshot();
        notifyAgentMediaTasksChanged();
        return { ok: true, value: next };
      } catch (error) {
        return fail(this.mapStorageError(error), `task submit failed: ${String(error)}`);
      }
    });
  }

  async markRunning(
    id: string,
    input: AgentMediaTaskRunningInput = {},
  ): Promise<AgentTaskServiceOutcome<AgentMediaTaskRecord>> {
    return this.enqueue(() => this.transitionRecord(id, "running", {}, input));
  }

  async markAwaitingImport(
    id: string,
    input: AgentMediaTaskAwaitingImportInput,
  ): Promise<AgentTaskServiceOutcome<AgentMediaTaskRecord>> {
    return this.enqueue(async () => {
      try {
        await this.ensureLoaded();
        const current = this.records.get(id);
        if (!current) return fail("NOT_FOUND", `task "${id}" was not found`, { id });
        const resultPath = requireNonEmpty(input.resultPath ?? "");
        if (!resultPath) {
          return fail("INVALID_PARAMS", "resultPath 不能为空", { field: "resultPath" });
        }
        return await this.transitionTask(
          current,
          "awaiting_import",
          { resultPath },
          input.expectedRevision,
          isoNow(input.now),
        );
      } catch (error) {
        return fail(this.mapStorageError(error), `task update failed: ${String(error)}`);
      }
    });
  }

  async markDone(
    id: string,
    input: AgentMediaTaskDoneInput = {},
  ): Promise<AgentTaskServiceOutcome<AgentMediaTaskRecord>> {
    return this.enqueue(() =>
      this.transitionRecord(
        id,
        "done",
        {
          ...(input.resultPath !== undefined ? { resultPath: input.resultPath } : {}),
          ...(input.resultMediaId !== undefined ? { resultMediaId: input.resultMediaId } : {}),
          ...(input.insertedClipId !== undefined ? { insertedClipId: input.insertedClipId } : {}),
        },
        input,
      ),
    );
  }

  async markError(
    id: string,
    input: AgentMediaTaskErrorInput,
  ): Promise<AgentTaskServiceOutcome<AgentMediaTaskRecord>> {
    return this.enqueue(() =>
      this.transitionRecord(
        id,
        "error",
        {
          error: { code: input.code, message: input.message },
          failureReason: input.message,
        },
        input,
      ),
    );
  }

  async markCancelled(
    id: string,
    input: AgentMediaTaskCancelInput = {},
  ): Promise<AgentTaskServiceOutcome<AgentMediaTaskRecord>> {
    return this.enqueue(() =>
      this.transitionRecord(
        id,
        "cancelled",
        input.reason !== undefined ? { failureReason: input.reason } : {},
        input,
      ),
    );
  }

  /**
   * Historical ledger transition. The UI currently blocks retries until an
   * independent generation mechanism is in place.
   */
  async retryTask(
    id: string,
    input: AgentMediaTaskRetryInput = {},
  ): Promise<AgentTaskServiceOutcome<AgentMediaTaskRecord>> {
    return this.enqueue(async () => {
      try {
        await this.ensureLoaded();
        const current = this.records.get(id);
        if (!current) return fail("NOT_FOUND", `task "${id}" was not found`, { id });
        const casError = this.checkCas(current, input.expectedRevision);
        if (casError) return casError;
        const applied = applyTaskRetry(current, `req_${uuid()}`, isoNow(input.now));
        if (!applied.ok) {
          return fail("INVALID_TRANSITION", applied.message, { id, from: current.status });
        }
        const next: AgentMediaTaskRecord = { ...applied.record, revision: current.revision + 1 };
        await this.storage.commit([next], []);
        // The previous requestId loses its index entry so each stored
        // attempt keeps a distinct idempotency identity.
        this.records.set(next.id, next);
        this.requestIdIndex.delete(current.requestId);
        this.requestIdIndex.set(next.requestId, next);
        this.rebuildSnapshot();
        notifyAgentMediaTasksChanged();
        return { ok: true, value: next };
      } catch (error) {
        return fail(this.mapStorageError(error), `task retry failed: ${String(error)}`);
      }
    });
  }

  /** Sanitize-then-store a generation summary; never stores raw updates. */
  async setSanitizedInfo(
    id: string,
    rawInfo: string,
    input: { expectedRevision?: number; now?: string } = {},
  ): Promise<AgentTaskServiceOutcome<AgentMediaTaskRecord>> {
    return this.enqueue(async () => {
      try {
        await this.ensureLoaded();
        const current = this.records.get(id);
        if (!current) return fail("NOT_FOUND", `task "${id}" was not found`, { id });
        const casError = this.checkCas(current, input.expectedRevision);
        if (casError) return casError;
        const next: AgentMediaTaskRecord = {
          ...current,
          sanitizedInfo: sanitizeGenerationInfo(rawInfo),
          updatedAt: isoNow(input.now),
          revision: current.revision + 1,
        };
        await this.storage.commit([next], []);
        this.records.set(next.id, next);
        this.requestIdIndex.set(next.requestId, next);
        this.rebuildSnapshot();
        notifyAgentMediaTasksChanged();
        return { ok: true, value: next };
      } catch (error) {
        return fail(this.mapStorageError(error), `task update failed: ${String(error)}`);
      }
    });
  }

  /**
   * Target-project gate: verify the target project still exists before an
   * `awaiting_import` task proceeds to import or the UI navigates to it.
   * A missing project fails the task honestly (error + failureReason);
   * the artifact is never re-targeted at another project.
   */
  async verifyTargetProjectBeforeImport(
    id: string,
    knownProjectIds: readonly string[] | ReadonlySet<string>,
    input: { expectedRevision?: number; now?: string } = {},
  ): Promise<AgentTaskServiceOutcome<AgentTaskTargetProjectVerification>> {
    return this.enqueue(async () => {
      try {
        await this.ensureLoaded();
        const current = this.records.get(id);
        if (!current) return fail("NOT_FOUND", `task "${id}" was not found`, { id });
        if (current.status !== "awaiting_import") {
          return fail(
            "INVALID_TRANSITION",
            `task "${id}" is ${current.status}; the target project check applies to awaiting_import tasks`,
            { id, status: current.status },
          );
        }
        const check = checkTargetProjectAvailability(current.targetProjectId, knownProjectIds);
        if (check.ok) {
          return { ok: true, value: { projectId: check.projectId, failedAsMissing: false } };
        }
        const casError = this.checkCas(current, input.expectedRevision);
        if (casError) return casError;
        const applied = applyTaskStatusTransition(
          current,
          "error",
          {
            error: { code: check.code, message: check.message },
            failureReason: check.message,
          },
          isoNow(input.now),
        );
        if (!applied.ok) {
          return fail("INVALID_TRANSITION", applied.message, { id, from: current.status });
        }
        const next: AgentMediaTaskRecord = { ...applied.record, revision: current.revision + 1 };
        await this.storage.commit([next], []);
        this.records.set(next.id, next);
        this.requestIdIndex.set(next.requestId, next);
        this.rebuildSnapshot();
        notifyAgentMediaTasksChanged();
        return { ok: true, value: { projectId: current.targetProjectId, failedAsMissing: true } };
      } catch (error) {
        return fail(this.mapStorageError(error), `task verification failed: ${String(error)}`);
      }
    });
  }

  /**
   * Record the clip id after the done task's media was inserted into the
   * target timeline. Insertion is user-triggered and idempotent: re-recording
   * the same clip is accepted silently (the panel button disappears on the
   * stored id), a different clip or a non-done task is refused.
   */
  async setInsertedClip(
    id: string,
    clipId: string,
    input: { expectedRevision?: number; now?: string } = {},
  ): Promise<AgentTaskServiceOutcome<AgentMediaTaskRecord>> {
    return this.enqueue(async () => {
      try {
        await this.ensureLoaded();
        const current = this.records.get(id);
        if (!current) return fail("NOT_FOUND", `task "${id}" was not found`, { id });
        const trimmed = requireNonEmpty(clipId ?? "");
        if (!trimmed) {
          return fail("INVALID_PARAMS", "clipId 不能为空", { field: "clipId" });
        }
        if (current.insertedClipId === trimmed) {
          return { ok: true, value: current };
        }
        if (current.status !== "done" || !current.resultMediaId) {
          return fail(
            "INVALID_TRANSITION",
            `task "${id}" is ${current.status}; a timeline insertion can only be recorded on an imported (done) task`,
            { id, status: current.status },
          );
        }
        const casError = this.checkCas(current, input.expectedRevision);
        if (casError) return casError;
        const next: AgentMediaTaskRecord = {
          ...current,
          insertedClipId: trimmed,
          updatedAt: isoNow(input.now),
          revision: current.revision + 1,
        };
        await this.storage.commit([next], []);
        this.records.set(next.id, next);
        this.requestIdIndex.set(next.requestId, next);
        this.rebuildSnapshot();
        notifyAgentMediaTasksChanged();
        return { ok: true, value: next };
      } catch (error) {
        return fail(this.mapStorageError(error), `task update failed: ${String(error)}`);
      }
    });
  }

  async remove(
    id: string,
  ): Promise<AgentTaskServiceOutcome<{ readonly id: string; readonly alreadyGone: boolean }>> {
    return this.enqueue(async () => {
      try {
        await this.ensureLoaded();
        const existing = this.records.get(id);
        if (!existing) return { ok: true, value: { id, alreadyGone: true } };
        await this.storage.commit([], [id]);
        this.records.delete(id);
        if (this.requestIdIndex.get(existing.requestId)?.id === id) {
          this.requestIdIndex.delete(existing.requestId);
        }
        this.rebuildSnapshot();
        notifyAgentMediaTasksChanged();
        return { ok: true, value: { id, alreadyGone: false } };
      } catch (error) {
        return fail(this.mapStorageError(error), `task remove failed: ${String(error)}`);
      }
    });
  }

  /* --------------------------- internals ----------------------------- */

  private async transitionRecord(
    id: string,
    to: AgentMediaTaskStatus,
    patch: TaskTransitionPatch,
    input: { expectedRevision?: number; now?: string },
  ): Promise<AgentTaskServiceOutcome<AgentMediaTaskRecord>> {
    try {
      return await this.transitionRecordInternal(id, to, patch, input);
    } catch (error) {
      return fail(this.mapStorageError(error), `task update failed: ${String(error)}`);
    }
  }

  private async transitionRecordInternal(
    id: string,
    to: AgentMediaTaskStatus,
    patch: TaskTransitionPatch,
    input: { expectedRevision?: number; now?: string },
  ): Promise<AgentTaskServiceOutcome<AgentMediaTaskRecord>> {
    await this.ensureLoaded();
    const current = this.records.get(id);
    if (!current) return fail("NOT_FOUND", `task "${id}" was not found`, { id });
    return this.transitionTask(current, to, patch, input.expectedRevision, isoNow(input.now));
  }
}

function taskOutputDirectorySnapshot(recommendedRoot: string, taskId: string): string {
  // Delegates to the composer so the prompt path and the stored snapshot
  // can never drift apart.
  return taskOutputDirectory(recommendedRoot, taskId);
}

export interface AgentTaskListResult {
  /** Usable records, newest-first by updatedAt. */
  readonly tasks: readonly AgentMediaTaskRecord[];
  /** Rows skipped at load: newer record versions or failed validation. */
  readonly unreadable: readonly AgentTaskUnreadableEntry[];
}

let singleton: AgentMediaTaskService | null = null;

/** Process-wide service bound to the real IndexedDB storage. */
export function getAgentMediaTaskService(): AgentMediaTaskService {
  if (!singleton) singleton = new AgentMediaTaskService();
  return singleton;
}

/** Test-only: replace the process-wide service (e.g. with an in-memory one). */
export function setAgentMediaTaskServiceForTests(
  service: AgentMediaTaskService | null,
): void {
  singleton = service;
}

let initPromise: Promise<void> | null = null;

/**
 * Warms the cache once; safe to call from every dialog mount. Failures do
 * not throw to the caller — panels render whatever the snapshot holds and
 * the service surfaces UNAVAILABLE on actual operations.
 */
export function initAgentMediaTasks(): Promise<void> {
  if (!initPromise) {
    initPromise = getAgentMediaTaskService()
      .ensureLoaded()
      .catch(() => undefined);
  }
  return initPromise;
}
