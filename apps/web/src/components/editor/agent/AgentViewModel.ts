import type {
  ExternalConversationDisplayState,
  ExternalConversationLifecycle,
} from "@openreel/agent-facade";

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
      readonly outputTokens?: number;
      readonly totalTokens?: number;
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

function activityIndex(
  activities: readonly AgentActivity[],
  type: AgentActivity["type"],
  id: string,
): number {
  return activities.findIndex((activity) => activity.type === type && activity.id === id);
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
        const index = activityIndex(activities, "user_message", id);
        if (index >= 0) replaceActivity(activities, index, next);
        else activities.push(next);
        break;
      }
      case "agent_message_chunk": {
        const id = update.messageId ?? "agent-stream";
        const index = activityIndex(activities, "agent_message", id);
        if (index >= 0 && activities[index].type === "agent_message") {
          const previous = activities[index];
          replaceActivity(activities, index, {
            ...previous,
            text: previous.text + update.content.text,
            streaming: true,
          });
        } else {
          activities.push({
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
        const index = activityIndex(activities, "agent_message", id);
        if (index >= 0) replaceActivity(activities, index, next);
        else activities.push(next);
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        const id = update.toolCallId;
        const index = activityIndex(activities, "tool", id);
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
        else activities.push(next);
        break;
      }
      case "tool_result": {
        const id = update.toolCallId;
        const index = activityIndex(activities, "tool", id);
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
        else activities.push(next);
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
        const index = activityIndex(activities, "approval", id);
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
        else activities.push(next);
        break;
      }
      case "approval_resolution": {
        const id = update.requestId;
        const index = activityIndex(activities, "approval", id);
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
        else activities.push(next);
        break;
      }
      case "subtask": {
        const id = update.subtaskId;
        const index = activityIndex(activities, "subtask", id);
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
        else activities.push(next);
        break;
      }
      case "artifact": {
        const id = update.artifactId;
        const index = activityIndex(activities, "artifact", id);
        const previous = index >= 0 && activities[index].type === "artifact"
          ? activities[index]
          : undefined;
        const next: AgentActivity = {
          type: "artifact",
          id,
          sequence: event.sequence,
          label: update.label ?? previous?.label ?? "",
          status: update.status ?? previous?.status ?? "available",
          sizeBytes: update.sizeBytes ?? previous?.sizeBytes,
        };
        if (index >= 0) replaceActivity(activities, index, next);
        else activities.push(next);
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
          outputTokens: update.outputTokens,
          totalTokens: update.totalTokens,
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
