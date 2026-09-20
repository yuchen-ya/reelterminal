import type {
  ExternalConversationDisplayState,
  ExternalConversationLifecycle,
} from "@reelterminal/agent-facade";

export type AgentConnectionState =
  | "disabled"
  | "connecting"
  | "connected"
  | "disconnected"
  | "unsupported"
  | "error";

export interface AgentConnectionView {
  readonly state: AgentConnectionState;
  readonly agentName?: string;
  readonly detail?: string;
  readonly fallback?: "mcp-only";
}

export interface AgentMessage {
  readonly id: string;
  readonly role: "user" | "agent";
  readonly text: string;
  readonly streaming?: boolean;
}

export type AgentToolCallStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentToolCall {
  readonly id: string;
  readonly title: string;
  readonly status: AgentToolCallStatus;
  readonly detail?: string;
}

export type AgentApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";

export interface AgentApprovalRequest {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly options?: readonly AgentApprovalOption[];
  readonly status: AgentApprovalStatus;
}

export interface AgentApprovalOption {
  readonly id: string;
  /** Agent-authored option label; the UI displays it verbatim. */
  readonly label: string;
}

/**
 * A host-owned opaque visual handle. The handle is deliberately not a path,
 * URL, or raw artifact payload. A future host may resolve it to a short-lived
 * app-owned object URL at the final rendering boundary.
 */
export interface AgentArtifactFrame {
  readonly id?: string;
  readonly previewId?: string;
  readonly timecodeSeconds?: number;
  readonly label?: string;
}

export interface AgentArtifactPreview {
  readonly previewId?: string;
  readonly timecodeSeconds?: number;
  readonly frames?: readonly AgentArtifactFrame[];
}

export interface AgentReferenceChip {
  readonly number: number;
  /** This label is display-only user content and must never be translated. */
  readonly label: string;
  readonly kind?: string;
  readonly stale?: boolean;
  readonly startSeconds?: number | null;
  readonly endSeconds?: number | null;
}

export type AgentCapabilityLevel = "basic" | "streaming" | "full";

export interface AgentCapabilityAvailability {
  readonly basic: boolean;
  readonly streaming: boolean;
  readonly full: boolean;
  /** Optional negotiated descriptor used by hosts that expose one. */
  readonly level?: "basic" | "streaming" | "full" | "observable";
}

export interface AgentThinkingSummary {
  readonly text: string;
  readonly expanded?: boolean;
}

export interface AgentPlanEntry {
  readonly content: string;
  readonly status?: "pending" | "in_progress" | "completed";
}

export type AgentActivity =
  | {
      readonly type: "user_message";
      readonly id: string;
      readonly sequence: number;
      readonly text: string;
    }
  | {
      readonly type: "agent_message";
      readonly id: string;
      readonly sequence: number;
      readonly text: string;
      readonly streaming?: boolean;
    }
  | {
      readonly type: "reasoning_summary";
      readonly id: string;
      readonly sequence: number;
      /** Agent-curated summary, never a hidden chain-of-thought trace. */
      readonly text: string;
    }
  | {
      readonly type: "tool";
      readonly id: string;
      readonly sequence: number;
      readonly phase: "call" | "update" | "result";
      readonly title: string;
      readonly status: AgentToolCallStatus;
      /** Safe, agent-curated summary only; raw args/results are excluded. */
      readonly detail?: string;
    }
  | {
      readonly type: "approval";
      readonly id: string;
      readonly sequence: number;
      readonly phase: "request" | "resolution";
      readonly title: string;
      readonly description?: string;
      readonly options?: readonly AgentApprovalOption[];
      readonly status: AgentApprovalStatus;
    }
  | {
      readonly type: "subtask";
      readonly id: string;
      readonly sequence: number;
      readonly title: string;
      readonly status: "pending" | "running" | "completed" | "failed" | "cancelled";
      readonly detail?: string;
    }
  | {
      readonly type: "artifact";
      readonly id: string;
      readonly sequence: number;
      /** Safe display label only; paths, URLs, and raw payloads are omitted. */
      readonly label: string;
      readonly status: "available" | "pending" | "failed";
      readonly sizeBytes?: number;
      readonly kind?: string;
      readonly mimeType?: string;
      /** Optional forward-compatible visual projection; absent means no image was transmitted. */
      readonly preview?: AgentArtifactPreview;
    }
  | {
      readonly type: "plan";
      readonly id: string;
      readonly sequence: number;
      readonly entries: readonly AgentPlanEntry[];
    }
  | {
      readonly type: "usage";
      readonly id: string;
      readonly sequence: number;
      readonly inputTokens?: number;
      readonly cachedInputTokens?: number;
      readonly outputTokens?: number;
      readonly reasoningOutputTokens?: number;
      readonly totalTokens?: number;
      readonly turnInputTokens?: number;
      readonly turnCachedInputTokens?: number;
      readonly turnOutputTokens?: number;
      readonly turnReasoningOutputTokens?: number;
      readonly turnTotalTokens?: number;
      readonly currentContextTokens?: number;
      readonly contextWindowTokens?: number;
    }
  | {
      readonly type: "state";
      readonly id: string;
      readonly sequence: number;
      readonly state: "idle" | "working" | "cancelled" | "failed";
      readonly detail?: string;
    };

export interface AgentConversationViewModel {
  readonly connection: AgentConnectionView;
  readonly capabilities: AgentCapabilityAvailability;
  readonly activities: readonly AgentActivity[];
  readonly messages: readonly AgentMessage[];
  readonly thinkingSummary: AgentThinkingSummary | null;
  readonly toolCalls: readonly AgentToolCall[];
  readonly approvals: readonly AgentApprovalRequest[];
}

const MAX_ARTIFACT_PREVIEW_ID_LENGTH = 128;
const MAX_ARTIFACT_FRAME_COUNT = 12;
const MAX_ARTIFACT_LABEL_LENGTH = 160;
const MAX_ARTIFACT_TIME_SECONDS = 24 * 60 * 60;

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

/** Preview handles are opaque identifiers, never paths, URLs, or payloads. */
function projectOpaqueId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  return id.length > 0 && id.length <= MAX_ARTIFACT_PREVIEW_ID_LENGTH &&
    /^[A-Za-z0-9._~-]+$/.test(id)
    ? id
    : undefined;
}

/** Keep display labels useful while dropping control characters and paths/URLs. */
function projectDisplayText(value: unknown, maxLength = MAX_ARTIFACT_LABEL_LENGTH): string | undefined {
  if (typeof value !== "string") return undefined;
  let cleaned = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    cleaned += codePoint <= 0x1f || codePoint === 0x7f ? " " : character;
  }
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned.length > maxLength) return undefined;
  if (/^(?:[A-Za-z][A-Za-z0-9+.-]*:|[\\/]|[A-Za-z]:[\\/])/.test(cleaned)) {
    return undefined;
  }
  return cleaned;
}

function projectVisualSeconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 &&
    value <= MAX_ARTIFACT_TIME_SECONDS
    ? value
    : undefined;
}

function projectMimeType(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  const mimeType = value.trim();
  return /^[a-z]+\/[a-z0-9.+-]+$/i.test(mimeType) ? mimeType : undefined;
}

function projectArtifactKind(value: unknown): string | undefined {
  const kind = projectDisplayText(value, 48);
  return kind && !/[\\/:]/.test(kind) ? kind : undefined;
}

function projectArtifactFrame(value: unknown): AgentArtifactFrame | undefined {
  const source = asRecord(value);
  if (!source) return undefined;
  const id = projectOpaqueId(source.id);
  const previewId = projectOpaqueId(source.previewId);
  const timecodeSeconds = projectVisualSeconds(source.timecodeSeconds);
  const label = projectDisplayText(source.label);
  const frame: AgentArtifactFrame = {
    ...(id ? { id } : {}),
    ...(previewId ? { previewId } : {}),
    ...(timecodeSeconds !== undefined ? { timecodeSeconds } : {}),
    ...(label ? { label } : {}),
  };
  return Object.keys(frame).length > 0 ? frame : undefined;
}

/** Explicitly project visual metadata; unknown keys are never copied. */
function projectArtifactPreview(value: unknown): AgentArtifactPreview | undefined {
  const source = asRecord(value);
  if (!source) return undefined;
  const previewId = projectOpaqueId(source.previewId);
  const timecodeSeconds = projectVisualSeconds(source.timecodeSeconds);
  const frames = Array.isArray(source.frames)
    ? source.frames
        .slice(0, MAX_ARTIFACT_FRAME_COUNT)
        .map(projectArtifactFrame)
        .filter((frame): frame is AgentArtifactFrame => frame !== undefined)
    : [];
  const preview: AgentArtifactPreview = {
    ...(previewId ? { previewId } : {}),
    ...(timecodeSeconds !== undefined ? { timecodeSeconds } : {}),
    ...(frames.length > 0 ? { frames } : {}),
  };
  return Object.keys(preview).length > 0 ? preview : undefined;
}

function projectArtifactStatus(
  value: unknown,
): "available" | "pending" | "failed" | undefined {
  return value === "available" || value === "pending" || value === "failed"
    ? value
    : undefined;
}

function projectSizeBytes(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function connectionStateForLifecycle(
  lifecycle: ExternalConversationLifecycle,
): AgentConnectionState {
  switch (lifecycle) {
    case "pairing":
    case "connecting":
    case "resuming":
    case "disconnecting":
      return "connecting";
    case "ready":
      return "connected";
    case "unsupported":
      return "unsupported";
    case "error":
      return "error";
    case "idle":
    case "disconnected":
      return "disconnected";
  }
}

function textFromContent(
  content: readonly { readonly type: "text"; readonly text: string }[] | undefined,
): string {
  return content?.map((part) => part.text).join("") ?? "";
}

function activityKey(
  type: AgentActivity["type"],
  id: string,
): string {
  return `${type}\u0000${id}`;
}

function replaceActivity(
  activities: AgentActivity[],
  index: number,
  next: AgentActivity,
): void {
  // Keep the original sequence so updates remain at the event's first place.
  activities[index] = { ...next, sequence: activities[index].sequence } as AgentActivity;
}

function approvalStatusForOutcome(
  outcome: "approved" | "rejected" | "cancelled" | "expired",
): AgentApprovalStatus {
  if (outcome === "approved") return "approved";
  if (outcome === "expired") return "expired";
  if (outcome === "cancelled") return "cancelled";
  return "denied";
}

/**
 * Project the current external-agent protocol state into display data.
 * This is intentionally a pure adapter: it owns no transport, store, or
 * persistence and can be replaced by a bridge-specific projection later.
 */
export function conversationViewModelFromProtocol(
  state: ExternalConversationDisplayState,
): AgentConversationViewModel {
  const activities: AgentActivity[] = [];
  // Mutable protocol entities (messages, tools, approvals, subtasks, and
  // artifacts) are updated repeatedly while streaming. Index them once so a
  // long turn does not repeatedly scan the complete activity list.
  const activityIndexes = new Map<string, number>();
  const indexFor = (type: AgentActivity["type"], id: string): number =>
    activityIndexes.get(activityKey(type, id)) ?? -1;
  const appendIndexed = (activity: AgentActivity): void => {
    activityIndexes.set(
      activityKey(activity.type, activity.id),
      activities.length,
    );
    activities.push(activity);
  };

  for (const event of [...state.updates].sort((left, right) => left.sequence - right.sequence)) {
    if (event.type !== "session_update") continue;
    const update = event.update;
    switch (update.sessionUpdate) {
      case "user_message": {
        const text = textFromContent(update.content);
        if (!text) break;
        const id = update.messageId ?? `user-${event.sequence}`;
        const next: AgentActivity = {
          type: "user_message",
          id,
          sequence: event.sequence,
          text,
        };
        const index = indexFor("user_message", id);
        if (index >= 0) replaceActivity(activities, index, next);
        else appendIndexed(next);
        break;
      }
      case "agent_message_chunk": {
        const id = update.messageId ?? "agent-stream";
        const index = indexFor("agent_message", id);
        if (index >= 0 && activities[index].type === "agent_message") {
          const previous = activities[index];
          replaceActivity(activities, index, {
            ...previous,
            text: previous.text + update.content.text,
            streaming: true,
          });
        } else {
          appendIndexed({
            type: "agent_message",
            id,
            sequence: event.sequence,
            text: update.content.text,
            streaming: true,
          });
        }
        break;
      }
      case "agent_message": {
        const text = textFromContent(update.content);
        if (!text) break;
        const id = update.messageId ?? `agent-${event.sequence}`;
        const next: AgentActivity = {
          type: "agent_message",
          id,
          sequence: event.sequence,
          text,
          streaming: false,
        };
        const index = indexFor("agent_message", id);
        if (index >= 0) replaceActivity(activities, index, next);
        else appendIndexed(next);
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        const id = update.toolCallId;
        const index = indexFor("tool", id);
        const previous = index >= 0 && activities[index].type === "tool"
          ? activities[index]
          : undefined;
        const next: AgentActivity = {
          type: "tool",
          id,
          sequence: event.sequence,
          phase: update.sessionUpdate === "tool_call" ? "call" : "update",
          title: update.title ?? previous?.title ?? "",
          status: update.status ?? previous?.status ?? "pending",
          detail: update.summary ?? previous?.detail,
        };
        if (index >= 0) replaceActivity(activities, index, next);
        else appendIndexed(next);
        break;
      }
      case "tool_result": {
        const id = update.toolCallId;
        const index = indexFor("tool", id);
        const previous = index >= 0 && activities[index].type === "tool"
          ? activities[index]
          : undefined;
        const next: AgentActivity = {
          type: "tool",
          id,
          sequence: event.sequence,
          phase: "result",
          title: update.title ?? previous?.title ?? "",
          status: update.status,
          detail: update.summary ?? update.error?.message ?? previous?.detail,
        };
        if (index >= 0) replaceActivity(activities, index, next);
        else appendIndexed(next);
        break;
      }
      case "reasoning_summary":
        activities.push({
          type: "reasoning_summary",
          id: `reasoning-${event.sequence}`,
          sequence: event.sequence,
          text: update.summary,
        });
        break;
      case "approval_request": {
        const id = update.requestId;
        const index = indexFor("approval", id);
        const previous = index >= 0 && activities[index].type === "approval"
          ? activities[index]
          : undefined;
        const next: AgentActivity = {
          type: "approval",
          id,
          sequence: event.sequence,
          phase: "request",
          title: update.title ?? previous?.title ?? "",
          description: update.summary ?? previous?.description,
          options: update.options ?? previous?.options,
          status: "pending",
        };
        if (index >= 0) replaceActivity(activities, index, next);
        else appendIndexed(next);
        break;
      }
      case "approval_resolution": {
        const id = update.requestId;
        const index = indexFor("approval", id);
        const previous = index >= 0 && activities[index].type === "approval"
          ? activities[index]
          : undefined;
        const next: AgentActivity = {
          type: "approval",
          id,
          sequence: event.sequence,
          phase: "resolution",
          title: previous?.title ?? "",
          description: update.summary ?? previous?.description,
          options: previous?.options,
          status: approvalStatusForOutcome(update.outcome),
        };
        if (index >= 0) replaceActivity(activities, index, next);
        else appendIndexed(next);
        break;
      }
      case "subtask": {
        const id = update.subtaskId;
        const index = indexFor("subtask", id);
        const previous = index >= 0 && activities[index].type === "subtask"
          ? activities[index]
          : undefined;
        const next: AgentActivity = {
          type: "subtask",
          id,
          sequence: event.sequence,
          title: update.title ?? previous?.title ?? "",
          status: update.status,
          detail: update.summary ?? previous?.detail,
        };
        if (index >= 0) replaceActivity(activities, index, next);
        else appendIndexed(next);
        break;
      }
      case "artifact": {
        const visual = update as unknown as UnknownRecord;
        const id = projectOpaqueId(update.artifactId) ?? `artifact-${event.sequence}`;
        const index = indexFor("artifact", id);
        const previous = index >= 0 && activities[index].type === "artifact"
          ? activities[index]
          : undefined;
        // The current wire protocol only exposes safe artifact metadata. Read
        // optional visual fields defensively, then explicitly project each
        // allowed field so paths, URLs, and raw payloads cannot cross into the
        // view model (even if an adapter sends them as extra properties).
        const preview = projectArtifactPreview(visual.preview) ?? projectArtifactPreview(visual);
        const label = projectDisplayText(update.label) ?? previous?.label ?? "";
        const status = projectArtifactStatus(update.status) ?? previous?.status ?? "available";
        const sizeBytes = projectSizeBytes(update.sizeBytes) ?? previous?.sizeBytes;
        const kind = projectArtifactKind(update.kind ?? visual.kind) ?? previous?.kind;
        const mimeType = projectMimeType(update.mimeType ?? visual.mimeType) ?? previous?.mimeType;
        const next: AgentActivity = {
          type: "artifact",
          id,
          sequence: event.sequence,
          label,
          status,
          sizeBytes,
          kind,
          mimeType,
          preview: preview ?? previous?.preview,
        };
        if (index >= 0) replaceActivity(activities, index, next);
        else appendIndexed(next);
        break;
      }
      case "plan":
        activities.push({
          type: "plan",
          id: `plan-${event.sequence}`,
          sequence: event.sequence,
          entries: update.entries,
        });
        break;
      case "usage":
        activities.push({
          type: "usage",
          id: `usage-${event.sequence}`,
          sequence: event.sequence,
          inputTokens: update.inputTokens,
          cachedInputTokens: update.cachedInputTokens,
          outputTokens: update.outputTokens,
          reasoningOutputTokens: update.reasoningOutputTokens,
          totalTokens: update.totalTokens,
          turnInputTokens: update.turnInputTokens,
          turnCachedInputTokens: update.turnCachedInputTokens,
          turnOutputTokens: update.turnOutputTokens,
          turnReasoningOutputTokens: update.turnReasoningOutputTokens,
          turnTotalTokens: update.turnTotalTokens,
          currentContextTokens: update.currentContextTokens,
          contextWindowTokens: update.contextWindowTokens,
        });
        break;
      case "state_update":
        activities.push({
          type: "state",
          id: `state-${event.sequence}`,
          sequence: event.sequence,
          state: update.state,
          detail: update.stopReason,
        });
        if (update.state !== "working") {
          for (let index = 0; index < activities.length; index += 1) {
            const activity = activities[index];
            if (activity.type === "agent_message" && activity.streaming) {
              activities[index] = { ...activity, streaming: false };
            }
          }
        }
        break;
    }
  }

  const messages = activities
    .filter((activity): activity is Extract<AgentActivity, { type: "user_message" | "agent_message" }> =>
      activity.type === "user_message" || activity.type === "agent_message")
    .map((activity) => ({
      id: activity.id,
      role: activity.type === "user_message" ? "user" as const : "agent" as const,
      text: activity.text,
      ...(activity.type === "agent_message" && activity.streaming !== undefined
        ? { streaming: activity.streaming }
        : {}),
    }));
  const toolCalls = activities
    .filter((activity): activity is Extract<AgentActivity, { type: "tool" }> => activity.type === "tool")
    .map(({ id, title, status, detail }) => ({ id, title, status, detail }));
  const approvals = activities
    .filter((activity): activity is Extract<AgentActivity, { type: "approval" }> => activity.type === "approval")
    .map(({ id, title, description, options, status }) => ({ id, title, description, options, status }));
  const lastThinking = [...activities].reverse().find(
    (activity): activity is Extract<AgentActivity, { type: "reasoning_summary" | "plan" }> =>
      activity.type === "reasoning_summary" || activity.type === "plan",
  );
  const thinkingSummary = lastThinking
    ? {
        text: lastThinking.type === "reasoning_summary"
          ? lastThinking.text
          : lastThinking.entries.map((entry) => entry.content).join("\n"),
      }
    : null;
  const basic = state.capabilities.formalReply !== "unsupported";
  const streaming = state.capabilities.streaming === "supported";
  const full =
    state.capabilities.reasoningSummary === "supported" &&
    state.capabilities.toolEvents === "supported" &&
    state.capabilities.approval === "supported";

  return {
    connection: {
      state: connectionStateForLifecycle(state.lifecycle),
      agentName: state.agent?.name,
      detail: state.lastError?.message,
      fallback: state.fallback ?? undefined,
    },
    capabilities: {
      basic,
      streaming,
      full,
      level: full ? "full" : streaming ? "streaming" : basic ? "basic" : "observable",
    },
    activities,
    messages,
    thinkingSummary,
    toolCalls,
    approvals,
  };
}
