/**
 * Submission controller between the agent-media-task dialog and the task
 * service + the external Agent conversation prompt lane.
 *
 * The flow mirrors the task contract order: create the ledger record
 * (idempotent by the client-minted requestId), precast the hand-off prompt
 * (which pins the artifact output directory and the receipt marker), then
 * send it over the conversation's single-flight prompt lane. Every failure
 * lands on the record as a real, retryable error — the controller never
 * fakes progress, and it never touches provider concepts: the connected
 * agent does the generation, the product only records and relays.
 */
import { v4 as uuid } from "uuid";
import {
  composeFailureDetail,
  composeTaskPrompt,
  type ComposeTaskPromptFailure,
} from "../../../services/agent-media-tasks/prompt-composer";
import {
  decideTaskAutoConfirmation,
  type AgentTaskCapabilityBits,
} from "../../../services/agent-media-tasks/auto-confirm";
import type { AgentMediaTaskService } from "../../../services/agent-media-tasks/agent-media-task-service";
import type {
  AgentMediaTaskInsertIntent,
  AgentMediaTaskKind,
  AgentMediaTaskOverrides,
  AgentMediaTaskRecord,
} from "../../../services/agent-media-tasks/types";

export interface AgentMediaTaskSubmitDeps {
  readonly service: AgentMediaTaskService;
  /** Sends the composed prompt over the conversation prompt lane. */
  readonly sendPrompt: (text: string) => Promise<unknown>;
  /** Session capability bits at submission time (auto-confirm decision). */
  readonly capabilityBits: AgentTaskCapabilityBits | null | undefined;
  /**
   * `capabilities_get.mediaImport.recommendedRoot` source. Returning null
   * fails the submission honestly — without a root there is no safe place
   * to precast the artifact directory.
   */
  readonly resolveRecommendedRoot: () => Promise<string | null>;
}

export interface AgentMediaTaskFormDraft {
  readonly kind: AgentMediaTaskKind;
  readonly promptText: string;
  readonly requirementsText?: string;
  readonly overrides?: AgentMediaTaskOverrides;
  readonly targetProjectId: string;
  readonly targetProjectName?: string;
  readonly insertIntent: AgentMediaTaskInsertIntent;
}

export type AgentMediaTaskSubmission =
  | { readonly ok: true; readonly record: AgentMediaTaskRecord; readonly replayed: boolean }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      /** Structured parameters for UI-side i18n of known codes. */
      readonly params?: Record<string, string | number>;
    };

function submissionError(result: {
  ok: false;
  code: string;
  message: string;
}): AgentMediaTaskSubmission {
  return { ok: false, code: result.code, message: result.message };
}

/** Structured parameters the dialog needs to translate known codes. */
function composeFailureParams(
  failure: ComposeTaskPromptFailure,
): Record<string, string | number> | undefined {
  switch (failure.code) {
    case "EMPTY_FIELD":
      return { field: failure.field };
    case "PROMPT_TOO_LONG":
      return { length: failure.length, max: failure.maxLength };
    default:
      return undefined;
  }
}

/**
 * Compose and send the hand-off prompt for a freshly created (or retried)
 * queued record; on any failure the record ends in a real error state.
 */
async function dispatchComposedPrompt(
  record: AgentMediaTaskRecord,
  deps: AgentMediaTaskSubmitDeps,
  recommendedRoot: string | null,
): Promise<AgentMediaTaskSubmission> {
  const composed = composeTaskPrompt({
    requestId: record.requestId,
    taskId: record.id,
    kind: record.kind,
    promptText: record.promptText,
    requirementsText: record.requirementsText,
    overrides: record.overrides,
    recommendedRoot,
  });
  if (!composed.ok) {
    // Language-neutral detail for the ledger; the dialog translates the code.
    const detail = composeFailureDetail(composed);
    const failed = await deps.service.markError(record.id, {
      code: composed.code,
      message: detail,
    });
    return failed.ok
      ? {
          ok: false,
          code: composed.code,
          message: detail,
          ...(composeFailureParams(composed) !== undefined
            ? { params: composeFailureParams(composed) }
            : {}),
        }
      : submissionError(failed);
  }
  try {
    await deps.sendPrompt(composed.prompt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = await deps.service.markError(record.id, {
      code: "PROMPT_SEND_FAILED",
      message,
    });
    return failed.ok
      ? { ok: false, code: "PROMPT_SEND_FAILED", message }
      : submissionError(failed);
  }
  const submitted = await deps.service.markSubmitted(record.id, {
    autoConfirm: decideTaskAutoConfirmation(deps.capabilityBits),
  });
  if (!submitted.ok) return submissionError(submitted);
  return { ok: true, record: submitted.value, replayed: false };
}

/**
 * Create a task record and hand its composed prompt to the conversation.
 * `requestId` defaults to a fresh mint; callers that re-enter the same
 * logical submission (double invoke, retry-after-crash) pass the same key
 * and get the first record back with `replayed: true` — the prompt is then
 * intentionally not sent twice.
 */
export async function submitAgentMediaTask(
  draft: AgentMediaTaskFormDraft,
  deps: AgentMediaTaskSubmitDeps,
  requestId: string = `req_${uuid()}`,
): Promise<AgentMediaTaskSubmission> {
  const recommendedRoot = await deps.resolveRecommendedRoot();
  const created = await deps.service.createTask({
    ...draft,
    requestId,
    capabilityBits: deps.capabilityBits ?? null,
    recommendedRoot,
  });
  if (!created.ok) return submissionError(created);
  if (created.value.replayed) {
    return { ok: true, record: created.value.record, replayed: true };
  }
  return dispatchComposedPrompt(created.value.record, deps, recommendedRoot);
}

/**
 * Re-arm a terminal error/cancelled task and submit it again. The service
 * mints the fresh requestId (a stale receipt for the dead attempt must
 * never match); the prompt is recomposed from the record's own wording.
 */
export async function retryAgentMediaTask(
  taskId: string,
  deps: AgentMediaTaskSubmitDeps,
): Promise<AgentMediaTaskSubmission> {
  const recommendedRoot = await deps.resolveRecommendedRoot();
  const retried = await deps.service.retryTask(taskId);
  if (!retried.ok) return submissionError(retried);
  return dispatchComposedPrompt(retried.value, deps, recommendedRoot);
}

/**
 * Cancel is task-local: it marks this ledger record cancelled so the panel
 * stops presenting it as active. The external session owns its own turn —
 * it may still be running, and stopping the whole turn happens in the Agent
 * panel, never implicitly here.
 */
export async function cancelAgentMediaTask(
  taskId: string,
  service: AgentMediaTaskService,
  reason?: string,
): Promise<AgentMediaTaskSubmission> {
  const cancelled = await service.markCancelled(taskId, reason ? { reason } : {});
  if (!cancelled.ok) return submissionError(cancelled);
  return { ok: true, record: cancelled.value, replayed: false };
}

/**
 * Fail-closed placeholder recommended-root source. The desktop runtime
 * installer swaps in the real resolver (the `agentTasks.getMediaRoots`
 * channel advertising `capabilities_get.mediaImport`) via
 * `setRecommendedRootResolver`; without that installation — web builds,
 * tests, or a desktop session before installation — this default stays
 * active and submission fails with NO_RECOMMENDED_ROOT instead of guessing
 * an output directory the agent workspace never advertised.
 */
export async function defaultResolveRecommendedRoot(): Promise<string | null> {
  return null;
}

let recommendedRootResolver: () => Promise<string | null> =
  defaultResolveRecommendedRoot;

/**
 * Replace the recommended-root source. Artifact receiving (the desktop
 * channel that exposes `capabilities_get.mediaImport`) installs the real
 * resolver here; until then the default fails submissions honestly instead
 * of precasting a directory the agent workspace never advertised.
 */
export function setRecommendedRootResolver(
  resolver: () => Promise<string | null>,
): void {
  recommendedRootResolver = resolver;
}

export function getRecommendedRootResolver(): () => Promise<string | null> {
  return recommendedRootResolver;
}
