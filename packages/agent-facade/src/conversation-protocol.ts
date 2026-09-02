/**
 * Provider-neutral protocol types for the optional ReelTerminal conversation
 * client.
 *
 * ReelTerminal is the ACP-style client in this boundary. The external agent owns
 * the conversation, reasoning, model, credentials, and history. This module
 * deliberately contains no provider/model fields and no LLM dependency. An
 * adapter supplies the transport (stdio, loopback, WebSocket, etc.) and
 * unwraps JSON-RPC responses before they reach the bridge.
 *
 * The wire names follow Agent Client Protocol's stable shape (`initialize`,
 * `session/resume`, `session/prompt`, `session/cancel`, and
 * `session/update`). This is a small attachment subset, not a claim of full
 * ACP conformance. Keeping the transport behind an interface lets an agent
 * that speaks another protocol use the MCP-only fallback without ReelTerminal
 * inventing a local conversation.
 */

export const EXTERNAL_CONVERSATION_METHODS = {
  initialize: "initialize",
  resume: "session/resume",
  prompt: "session/prompt",
  cancel: "session/cancel",
  approval: "session/approval",
  close: "session/close",
} as const;

export type ExternalConversationMethod =
  (typeof EXTERNAL_CONVERSATION_METHODS)[keyof typeof EXTERNAL_CONVERSATION_METHODS];

export const OPENREEL_CONVERSATION_CLIENT = {
  name: "ReelTerminal",
  version: "0.1.0",
} as const;

export const OPENREEL_CONVERSATION_PROTOCOL_VERSION =
  "openreel-conversation/1" as const;

/** The external session id is opaque and is never generated or persisted by ReelTerminal. */
export interface ExternalAgentPairing {
  /** Existing session owned by the external agent; attachment always resumes it. */
  readonly sessionId: string;
  /** Optional display-only label supplied by the user or connector. */
  readonly agentLabel?: string;
}

export interface ExternalAgentClientInfo {
  readonly name: string;
  readonly version: string;
}

/**
 * Display capabilities are deliberately about presentation, not reasoning.
 * `formalReply` is the base tier; every other tier is optional. The agent
 * reports booleans during initialize and ReelTerminal normalizes them into
 * supported/unsupported/unknown states for the in-memory display projection.
 */
export const EXTERNAL_CONVERSATION_CAPABILITIES = {
  formalReply: "formal_reply",
  streaming: "streaming",
  reasoningSummary: "reasoning_summary",
  toolEvents: "tool_events",
  approval: "approval",
  usage: "usage",
  artifact: "artifact",
  subtask: "subtask",
} as const;

export type ExternalConversationCapability =
  (typeof EXTERNAL_CONVERSATION_CAPABILITIES)[keyof typeof EXTERNAL_CONVERSATION_CAPABILITIES];

export type ExternalConversationCapabilityState =
  | "supported"
  | "unsupported"
  | "unknown";

/** Wire-level capability declaration supplied by the external agent. */
export interface ExternalAgentConversationCapabilities {
  readonly formalReply?: boolean;
  readonly streaming?: boolean;
  readonly reasoningSummary?: boolean;
  readonly toolEvents?: boolean;
  readonly approval?: boolean;
  readonly usage?: boolean;
  readonly artifact?: boolean;
  readonly subtask?: boolean;
}

/** Normalized capability negotiation retained in display state. */
export interface ExternalConversationCapabilitySupport {
  readonly formalReply: ExternalConversationCapabilityState;
  readonly streaming: ExternalConversationCapabilityState;
  readonly reasoningSummary: ExternalConversationCapabilityState;
  readonly toolEvents: ExternalConversationCapabilityState;
  readonly approval: ExternalConversationCapabilityState;
  readonly usage: ExternalConversationCapabilityState;
  readonly artifact: ExternalConversationCapabilityState;
  readonly subtask: ExternalConversationCapabilityState;
}

export interface ExternalAgentInitializeParams {
  readonly protocolVersion?: string;
  readonly clientInfo: ExternalAgentClientInfo;
  /** ReelTerminal only needs session update delivery for this foundation. */
  readonly clientCapabilities?: {
    readonly sessionUpdate?: boolean;
    readonly conversation?: ExternalAgentConversationCapabilities;
  };
}

export interface ExternalAgentInfo {
  readonly name: string;
  readonly version?: string;
}

export interface ExternalAgentSessionCapabilities {
  readonly resume?: boolean;
  readonly prompt?: boolean;
  readonly cancel?: boolean;
  readonly close?: boolean;
  readonly conversation?: ExternalAgentConversationCapabilities;
}

export interface ExternalAgentInitializeResult {
  /** ACP implementations have used both numeric and string versions. */
  readonly protocolVersion: string | number;
  readonly agentInfo?: ExternalAgentInfo;
  readonly sessionCapabilities?: ExternalAgentSessionCapabilities;
}

export interface ExternalAgentResumeParams {
  readonly sessionId: string;
}

export type ExternalAgentContent = {
  readonly type: "text";
  readonly text: string;
};

export interface ExternalAgentPromptParams {
  readonly sessionId: string;
  readonly prompt: readonly ExternalAgentContent[];
}

/** Optional direct response to `session/prompt`; streamed agents may omit it. */
export interface ExternalAgentPromptResult {
  readonly messageId?: string;
  readonly content?: readonly ExternalAgentContent[];
}

export interface ExternalAgentCancelParams {
  readonly sessionId: string;
}

export type ExternalAgentApprovalDecision = "approved" | "denied";

export interface ExternalAgentApprovalParams {
  readonly sessionId: string;
  readonly requestId: string;
  readonly decision: ExternalAgentApprovalDecision;
}

export interface ExternalAgentCloseParams {
  readonly sessionId: string;
}

/** Safe text used by display updates. Raw tool arguments/results are never modelled. */
export interface ExternalAgentSafeError {
  readonly code?: string;
  readonly message: string;
}

export type ExternalAgentToolStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface ExternalAgentToolDisplayFields {
  readonly toolCallId: string;
  readonly title?: string;
  readonly status?: ExternalAgentToolStatus;
  /** Agent-curated display summary; never raw arguments or tool output. */
  readonly summary?: string;
}

export type ExternalAgentSessionUpdate =
  | {
      readonly sessionUpdate: "user_message";
      readonly messageId?: string;
      readonly content: readonly ExternalAgentContent[];
    }
  | {
      /** A complete, agent-authored response (the base display tier). */
      readonly sessionUpdate: "agent_message";
      readonly messageId?: string;
      readonly content: readonly ExternalAgentContent[];
    }
  | {
      /** Optional streamed response chunks. */
      readonly sessionUpdate: "agent_message_chunk";
      readonly messageId?: string;
      readonly content: ExternalAgentContent;
    }
  | ({
      readonly sessionUpdate: "tool_call";
    } & ExternalAgentToolDisplayFields)
  | ({
      readonly sessionUpdate: "tool_call_update";
    } & ExternalAgentToolDisplayFields)
  | ({
      /** Completion summary for a tool call; no raw result payload. */
      readonly sessionUpdate: "tool_result";
      readonly toolCallId: string;
      readonly title?: string;
      readonly status: Extract<ExternalAgentToolStatus, "completed" | "failed" | "cancelled">;
      readonly summary?: string;
      readonly error?: ExternalAgentSafeError;
    })
  | {
      /** Agent-provided concise summary, never a hidden reasoning trace. */
      readonly sessionUpdate: "reasoning_summary";
      readonly summary: string;
    }
  | {
      readonly sessionUpdate: "approval_request";
      readonly requestId: string;
      readonly title?: string;
      readonly summary?: string;
      readonly options?: readonly {
        readonly id: string;
        readonly label: string;
      }[];
    }
  | {
      readonly sessionUpdate: "approval_resolution";
      readonly requestId: string;
      readonly outcome: "approved" | "rejected" | "cancelled" | "expired";
      readonly summary?: string;
    }
  | {
      /** Optional usage counters; provider/model identity is intentionally absent. */
      readonly sessionUpdate: "usage";
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly totalTokens?: number;
    }
  | {
      readonly sessionUpdate: "artifact";
      readonly artifactId: string;
      readonly kind?: string;
      readonly label?: string;
      readonly mimeType?: string;
      readonly sizeBytes?: number;
      readonly status?: "available" | "pending" | "failed";
    }
  | {
      readonly sessionUpdate: "subtask";
      readonly subtaskId: string;
      readonly title?: string;
      readonly status: "pending" | "running" | "completed" | "failed" | "cancelled";
      readonly summary?: string;
    }
  | {
      readonly sessionUpdate: "state_update";
      readonly state: "idle" | "working" | "cancelled" | "failed";
      readonly stopReason?: string;
    }
  | {
      readonly sessionUpdate: "plan";
      readonly entries: readonly {
        readonly content: string;
        readonly status?: "pending" | "in_progress" | "completed";
      }[];
    }
  | {
      /** Namespaced extensions may be ignored by clients that do not know them. */
      readonly sessionUpdate: `_${string}`;
      readonly [key: string]: unknown;
    };

export interface ExternalAgentSessionUpdateNotification {
  readonly sessionId: string;
  readonly update: ExternalAgentSessionUpdate;
  /** Optional sequence assigned by the external agent. */
  readonly sequence?: number;
}

export interface ExternalAgentNotification {
  readonly method: string;
  readonly params?: unknown;
}

/**
 * Transport adapter contract. `request` returns the unwrapped JSON-RPC
 * result; adapters own framing, authentication, process/socket lifecycle,
 * and secrets. No endpoint or credential crosses the bridge state/events.
 */
export interface ExternalAgentTransport {
  request<T = unknown>(
    method: string,
    params: unknown,
    options?: { readonly signal?: AbortSignal },
  ): Promise<T>;
  notify(method: string, params: unknown): Promise<void> | void;
  onNotification(listener: (notification: ExternalAgentNotification) => void): () => void;
  onClose(listener: (error?: unknown) => void): () => void;
  close(): Promise<void>;
}

/** Connector config is intentionally opaque to this package (no provider keys). */
export interface ExternalAgentConnector {
  connect(pairing: ExternalAgentPairing): Promise<ExternalAgentTransport>;
}

export interface ConversationAttachmentLease {
  /** Claim one local ReelTerminal attachment for this external session. */
  acquire(connectionId: string, sessionId: string): boolean;
  /** Release only the matching attachment; stale clients are no-ops. */
  release(connectionId: string, sessionId: string): void;
  current(): { readonly connectionId: string; readonly sessionId: string } | null;
}

export type ExternalConversationLifecycle =
  | "idle"
  | "pairing"
  | "connecting"
  | "resuming"
  | "ready"
  | "disconnecting"
  | "disconnected"
  | "unsupported"
  | "error";

export type ExternalConversationFallback = "mcp-only";

export type ExternalConversationDisconnectReason =
  | "user"
  | "transport_closed"
  | "agent_closed"
  | "lease_released"
  | "protocol_error"
  | "disabled"
  | "replaced";

export type ExternalConversationErrorCode =
  | "ALREADY_ATTACHED"
  | "INVALID_PAIRING"
  | "INVALID_STATE"
  | "INVALID_RESPONSE"
  | "LEASE_UNAVAILABLE"
  | "SESSION_MISMATCH"
  | "TRANSPORT"
  | "UNSUPPORTED";

export interface ExternalConversationError {
  readonly code: ExternalConversationErrorCode;
  readonly message: string;
}

/** Ownership is explicit: the remote agent owns the session; ReelTerminal owns an ephemeral view attachment. */
export interface ExternalConversationOwnership {
  readonly sessionOwner: "external-agent";
  readonly attachmentOwner: "openreel-client";
  readonly sessionId: string;
  readonly connectionId: string;
}

export type ExternalConversationEvent =
  | {
      readonly type: "lifecycle";
      readonly sequence: number;
      readonly occurredAt: number;
      readonly state: ExternalConversationLifecycle;
      readonly connectionId: string | null;
      readonly sessionId: string | null;
      readonly ownership: ExternalConversationOwnership | null;
      readonly capabilities?: ExternalConversationCapabilitySupport;
      readonly reason?: ExternalConversationDisconnectReason;
      readonly fallback?: ExternalConversationFallback;
      readonly error?: ExternalConversationError;
    }
  | {
      readonly type: "session_update";
      readonly sequence: number;
      readonly occurredAt: number;
      readonly connectionId: string;
      readonly sessionId: string;
      readonly update: ExternalAgentSessionUpdate;
      readonly remoteSequence?: number;
    }
  | {
      readonly type: "prompt";
      readonly sequence: number;
      readonly occurredAt: number;
      readonly phase: "submitted" | "accepted" | "cancel_requested";
      readonly connectionId: string;
      readonly sessionId: string;
    };

export interface ExternalConversationDisplayState {
  readonly lifecycle: ExternalConversationLifecycle;
  readonly connectionId: string | null;
  readonly sessionId: string | null;
  readonly agent: ExternalAgentInfo | null;
  /** Capability negotiation result; unknown means the agent omitted that tier. */
  readonly capabilities: ExternalConversationCapabilitySupport;
  readonly ownership: ExternalConversationOwnership | null;
  /** `mcp-only` means the native external-agent chat remains the UI. */
  readonly fallback: ExternalConversationFallback | null;
  readonly lastError: ExternalConversationError | null;
  /** Bounded, in-memory display updates; never persisted or replayed by ReelTerminal. */
  readonly updates: readonly ExternalConversationEvent[];
  readonly lastEventSequence: number;
}

const DISPLAY_TEXT_LIMIT = 16_384;
const DISPLAY_ID_LIMIT = 512;
const DISPLAY_LIST_LIMIT = 64;
const DISPLAY_OPTION_LIMIT = 16;

const CAPABILITY_NAMES: readonly ExternalConversationCapability[] = [
  EXTERNAL_CONVERSATION_CAPABILITIES.formalReply,
  EXTERNAL_CONVERSATION_CAPABILITIES.streaming,
  EXTERNAL_CONVERSATION_CAPABILITIES.reasoningSummary,
  EXTERNAL_CONVERSATION_CAPABILITIES.toolEvents,
  EXTERNAL_CONVERSATION_CAPABILITIES.approval,
  EXTERNAL_CONVERSATION_CAPABILITIES.usage,
  EXTERNAL_CONVERSATION_CAPABILITIES.artifact,
  EXTERNAL_CONVERSATION_CAPABILITIES.subtask,
];

function normalizeCapability(value: unknown, defaultState: ExternalConversationCapabilityState = "unknown"):
  ExternalConversationCapabilityState {
  if (value === true) return "supported";
  if (value === false) return "unsupported";
  return defaultState;
}

/** Convert the optional wire declaration into a stable, display-only view. */
export function normalizeExternalConversationCapabilities(
  value: unknown,
): ExternalConversationCapabilitySupport {
  const capabilities = isRecord(value) ? value : {};
  return {
    // Formal replies are the base tier. Omitted legacy declarations retain it.
    formalReply: normalizeCapability(capabilities.formalReply, "supported"),
    streaming: normalizeCapability(capabilities.streaming),
    reasoningSummary: normalizeCapability(capabilities.reasoningSummary),
    toolEvents: normalizeCapability(capabilities.toolEvents),
    approval: normalizeCapability(capabilities.approval),
    usage: normalizeCapability(capabilities.usage),
    artifact: normalizeCapability(capabilities.artifact),
    subtask: normalizeCapability(capabilities.subtask),
  };
}

export function isExternalAgentConversationCapabilities(
  value: unknown,
): value is ExternalAgentConversationCapabilities {
  if (!isRecord(value)) return false;
  return CAPABILITY_NAMES.every((name) => {
    // The wire uses the camel-cased property names from the TypeScript shape.
    const property = name === "formal_reply"
      ? "formalReply"
      : name === "reasoning_summary"
        ? "reasoningSummary"
        : name === "tool_events"
          ? "toolEvents"
          : name;
    return value[property] === undefined || typeof value[property] === "boolean";
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isExternalAgentInitializeResult(
  value: unknown,
): value is ExternalAgentInitializeResult {
  if (!isRecord(value)) return false;
  const protocolVersion = value.protocolVersion;
  if (
    (typeof protocolVersion !== "string" && typeof protocolVersion !== "number") ||
    String(protocolVersion).trim().length === 0
  ) {
    return false;
  }
  const agentInfo = value.agentInfo;
  if (agentInfo !== undefined) {
    if (!isRecord(agentInfo) || typeof agentInfo.name !== "string") return false;
    if (agentInfo.version !== undefined && typeof agentInfo.version !== "string") {
      return false;
    }
  }
  const sessionCapabilities = value.sessionCapabilities;
  if (sessionCapabilities !== undefined) {
    if (!isRecord(sessionCapabilities)) return false;
    for (const key of ["resume", "prompt", "cancel", "close"] as const) {
      if (
        sessionCapabilities[key] !== undefined &&
        typeof sessionCapabilities[key] !== "boolean"
      ) {
        return false;
      }
    }
    if (
      sessionCapabilities.conversation !== undefined &&
      !isExternalAgentConversationCapabilities(sessionCapabilities.conversation)
    ) {
      return false;
    }
  }
  return true;
}

export function isExternalAgentSessionUpdate(
  value: unknown,
): value is ExternalAgentSessionUpdate {
  if (!isRecord(value) || typeof value.sessionUpdate !== "string") return false;
  const kind: string = value.sessionUpdate;
  if (kind.startsWith("_")) return true;
  switch (kind) {
    case "user_message":
    case "agent_message":
      return (
        Array.isArray(value.content) &&
        value.content.slice(0, DISPLAY_LIST_LIMIT).every(isExternalAgentTextContent)
      );
    case "agent_message_chunk":
      return isExternalAgentTextContent(value.content);
    case "tool_call":
    case "tool_call_update":
      return (
        typeof value.toolCallId === "string" &&
        (value.status === undefined || isExternalAgentToolStatus(value.status)) &&
        (value.title === undefined || typeof value.title === "string") &&
        (value.summary === undefined || typeof value.summary === "string")
      );
    case "tool_result":
      return (
        typeof value.toolCallId === "string" &&
        isExternalAgentToolResultStatus(value.status) &&
        (value.title === undefined || typeof value.title === "string") &&
        (value.summary === undefined || typeof value.summary === "string") &&
        (value.error === undefined || isExternalAgentSafeError(value.error))
      );
    case "reasoning_summary":
      return typeof value.summary === "string";
    case "approval_request":
      return (
        typeof value.requestId === "string" &&
        (value.title === undefined || typeof value.title === "string") &&
        (value.summary === undefined || typeof value.summary === "string") &&
        (value.options === undefined || isExternalAgentApprovalOptions(value.options))
      );
    case "approval_resolution":
      return (
        typeof value.requestId === "string" &&
        isExternalAgentApprovalOutcome(value.outcome) &&
        (value.summary === undefined || typeof value.summary === "string")
      );
    case "usage":
      return isOptionalNonNegativeInteger(value.inputTokens) &&
        isOptionalNonNegativeInteger(value.outputTokens) &&
        isOptionalNonNegativeInteger(value.totalTokens);
    case "artifact":
      return (
        typeof value.artifactId === "string" &&
        (value.kind === undefined || typeof value.kind === "string") &&
        (value.label === undefined || typeof value.label === "string") &&
        (value.mimeType === undefined || typeof value.mimeType === "string") &&
        isOptionalNonNegativeInteger(value.sizeBytes) &&
        (value.status === undefined || isExternalAgentArtifactStatus(value.status))
      );
    case "subtask":
      return (
        typeof value.subtaskId === "string" &&
        isExternalAgentSubtaskStatus(value.status) &&
        (value.title === undefined || typeof value.title === "string") &&
        (value.summary === undefined || typeof value.summary === "string")
      );
    case "state_update":
      return (
        value.state === "idle" ||
        value.state === "working" ||
        value.state === "cancelled" ||
        value.state === "failed"
      );
    case "plan":
      return (
        Array.isArray(value.entries) &&
        value.entries.slice(0, DISPLAY_LIST_LIMIT).every(
          (entry) =>
            isRecord(entry) &&
            typeof entry.content === "string" &&
            (entry.status === undefined || isExternalAgentPlanStatus(entry.status)),
        )
      );
    default:
      return false;
  }
}

function isExternalAgentTextContent(value: unknown): value is ExternalAgentContent {
  return (
    isRecord(value) && value.type === "text" && typeof value.text === "string"
  );
}

function isExternalAgentToolStatus(value: unknown): value is ExternalAgentToolStatus {
  return (
    value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function isExternalAgentToolResultStatus(
  value: unknown,
): value is Extract<ExternalAgentToolStatus, "completed" | "failed" | "cancelled"> {
  return value === "completed" || value === "failed" || value === "cancelled";
}

function isExternalAgentSafeError(value: unknown): value is ExternalAgentSafeError {
  return (
    isRecord(value) &&
    typeof value.message === "string" &&
    (value.code === undefined || typeof value.code === "string")
  );
}

function isExternalAgentApprovalOptions(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.slice(0, DISPLAY_OPTION_LIMIT).every(
      (option) =>
        isRecord(option) &&
        typeof option.id === "string" &&
        typeof option.label === "string",
    )
  );
}

function isExternalAgentApprovalOutcome(
  value: unknown,
): value is "approved" | "rejected" | "cancelled" | "expired" {
  return (
    value === "approved" ||
    value === "rejected" ||
    value === "cancelled" ||
    value === "expired"
  );
}

function isExternalAgentArtifactStatus(
  value: unknown,
): value is "available" | "pending" | "failed" {
  return value === "available" || value === "pending" || value === "failed";
}

function isExternalAgentSubtaskStatus(
  value: unknown,
): value is "pending" | "running" | "completed" | "failed" | "cancelled" {
  return (
    value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function isExternalAgentPlanStatus(
  value: unknown,
): value is "pending" | "in_progress" | "completed" {
  return value === "pending" || value === "in_progress" || value === "completed";
}

function isOptionalNonNegativeInteger(value: unknown): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0)
  );
}

function boundedString(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > limit ? value.slice(0, limit) : value;
}

function boundedId(value: unknown): string | undefined {
  return boundedString(value, DISPLAY_ID_LIMIT);
}

function projectContent(value: unknown): readonly ExternalAgentContent[] | null {
  if (!Array.isArray(value)) return null;
  const content: ExternalAgentContent[] = [];
  for (const part of value.slice(0, DISPLAY_LIST_LIMIT)) {
    if (!isExternalAgentTextContent(part)) return null;
    content.push({
      type: "text",
      text: boundedString(part.text, DISPLAY_TEXT_LIMIT) ?? "",
    });
  }
  return content;
}

function projectSingleContent(value: unknown): ExternalAgentContent | null {
  if (!isExternalAgentTextContent(value)) return null;
  return {
    type: "text",
    text: boundedString(value.text, DISPLAY_TEXT_LIMIT) ?? "",
  };
}

function projectOptionalText(value: Record<string, unknown>, key: string): string | undefined {
  return boundedString(value[key], DISPLAY_TEXT_LIMIT);
}

function projectOptionalId(value: Record<string, unknown>, key: string): string | undefined {
  return boundedId(value[key]);
}

function projectOptionalStatus<T extends string>(
  value: Record<string, unknown>,
  key: string,
  isStatus: (candidate: unknown) => candidate is T,
): T | undefined {
  return isStatus(value[key]) ? value[key] : undefined;
}

/**
 * Strip protocol fields that are not safe or useful for an ReelTerminal display.
 * Unknown namespaced extensions intentionally return null so they can be
 * ignored without persisting arbitrary payloads. In particular, this helper
 * never copies tool arguments/results, hidden reasoning traces, URIs, paths,
 * credentials, model names, or provider metadata.
 */
export function projectExternalAgentSessionUpdate(
  value: unknown,
): ExternalAgentSessionUpdate | null {
  if (!isRecord(value) || !isExternalAgentSessionUpdate(value)) return null;
  const source = value as Record<string, unknown>;
  const kind = source.sessionUpdate;
  if (typeof kind !== "string") return null;
  if (kind.startsWith("_")) return null;
  switch (kind) {
    case "user_message": {
      const content = projectContent(source.content);
      if (!content) return null;
      const messageId = projectOptionalId(source, "messageId");
      return {
        sessionUpdate: "user_message",
        ...(messageId ? { messageId } : {}),
        content,
      };
    }
    case "agent_message": {
      const content = projectContent(source.content);
      if (!content) return null;
      const messageId = projectOptionalId(source, "messageId");
      return {
        sessionUpdate: "agent_message",
        ...(messageId ? { messageId } : {}),
        content,
      };
    }
    case "agent_message_chunk": {
      const content = projectSingleContent(source.content);
      if (!content) return null;
      const messageId = projectOptionalId(source, "messageId");
      return {
        sessionUpdate: "agent_message_chunk",
        ...(messageId ? { messageId } : {}),
        content,
      };
    }
    case "tool_call":
    case "tool_call_update": {
      const toolCallId = boundedId(source.toolCallId);
      if (!toolCallId) return null;
      const title = projectOptionalText(source, "title");
      const summary = projectOptionalText(source, "summary");
      const status = projectOptionalStatus(source, "status", isExternalAgentToolStatus);
      return {
        sessionUpdate: kind,
        toolCallId,
        ...(title !== undefined ? { title } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(summary !== undefined ? { summary } : {}),
      };
    }
    case "tool_result": {
      const toolCallId = boundedId(source.toolCallId);
      if (!toolCallId || !isExternalAgentToolResultStatus(source.status)) return null;
      const title = projectOptionalText(source, "title");
      const summary = projectOptionalText(source, "summary");
      const rawError = source.error;
      const error = isExternalAgentSafeError(rawError)
        ? {
            ...(boundedString(rawError.code, DISPLAY_ID_LIMIT)
              ? { code: boundedString(rawError.code, DISPLAY_ID_LIMIT) }
              : {}),
            message: boundedString(rawError.message, DISPLAY_TEXT_LIMIT) ?? "",
          }
        : undefined;
      return {
        sessionUpdate: "tool_result",
        toolCallId,
        status: source.status,
        ...(title !== undefined ? { title } : {}),
        ...(summary !== undefined ? { summary } : {}),
        ...(error ? { error } : {}),
      };
    }
    case "reasoning_summary": {
      const summary = projectOptionalText(source, "summary");
      return summary === undefined ? null : { sessionUpdate: "reasoning_summary", summary };
    }
    case "approval_request": {
      const requestId = boundedId(source.requestId);
      if (!requestId) return null;
      const title = projectOptionalText(source, "title");
      const summary = projectOptionalText(source, "summary");
      let options: readonly { readonly id: string; readonly label: string }[] | undefined;
      if (Array.isArray(source.options)) {
        const projected = source.options
          .slice(0, DISPLAY_OPTION_LIMIT)
          .filter(isRecord)
          .map((option) => {
            const id = boundedId(option.id);
            const label = boundedString(option.label, DISPLAY_TEXT_LIMIT);
            return id && label !== undefined ? { id, label } : null;
          })
          .filter((option): option is { readonly id: string; readonly label: string } => option !== null);
        options = projected;
      }
      return {
        sessionUpdate: "approval_request",
        requestId,
        ...(title !== undefined ? { title } : {}),
        ...(summary !== undefined ? { summary } : {}),
        ...(options !== undefined ? { options } : {}),
      };
    }
    case "approval_resolution": {
      const requestId = boundedId(source.requestId);
      if (!requestId || !isExternalAgentApprovalOutcome(source.outcome)) return null;
      const summary = projectOptionalText(source, "summary");
      return {
        sessionUpdate: "approval_resolution",
        requestId,
        outcome: source.outcome,
        ...(summary !== undefined ? { summary } : {}),
      };
    }
    case "usage":
      return {
        sessionUpdate: "usage",
        ...(isOptionalNonNegativeInteger(source.inputTokens) && source.inputTokens !== undefined
          ? { inputTokens: source.inputTokens }
          : {}),
        ...(isOptionalNonNegativeInteger(source.outputTokens) && source.outputTokens !== undefined
          ? { outputTokens: source.outputTokens }
          : {}),
        ...(isOptionalNonNegativeInteger(source.totalTokens) && source.totalTokens !== undefined
          ? { totalTokens: source.totalTokens }
          : {}),
      };
    case "artifact": {
      const artifactId = boundedId(source.artifactId);
      if (!artifactId || (source.status !== undefined && !isExternalAgentArtifactStatus(source.status))) {
        return null;
      }
      const kindValue = boundedString(source.kind, DISPLAY_ID_LIMIT);
      const label = boundedString(source.label, DISPLAY_TEXT_LIMIT);
      const mimeType = boundedString(source.mimeType, DISPLAY_ID_LIMIT);
      return {
        sessionUpdate: "artifact",
        artifactId,
        ...(kindValue !== undefined ? { kind: kindValue } : {}),
        ...(label !== undefined ? { label } : {}),
        ...(mimeType !== undefined ? { mimeType } : {}),
        ...(isOptionalNonNegativeInteger(source.sizeBytes) && source.sizeBytes !== undefined
          ? { sizeBytes: source.sizeBytes }
          : {}),
        ...(source.status !== undefined ? { status: source.status } : {}),
      };
    }
    case "subtask": {
      const subtaskId = boundedId(source.subtaskId);
      if (!subtaskId || !isExternalAgentSubtaskStatus(source.status)) return null;
      const title = projectOptionalText(source, "title");
      const summary = projectOptionalText(source, "summary");
      return {
        sessionUpdate: "subtask",
        subtaskId,
        status: source.status,
        ...(title !== undefined ? { title } : {}),
        ...(summary !== undefined ? { summary } : {}),
      };
    }
    case "state_update": {
      const stopReason = projectOptionalText(source, "stopReason");
      if (
        source.state !== "idle" &&
        source.state !== "working" &&
        source.state !== "cancelled" &&
        source.state !== "failed"
      ) {
        return null;
      }
      return {
        sessionUpdate: "state_update",
        state: source.state,
        ...(stopReason !== undefined ? { stopReason } : {}),
      };
    }
    case "plan": {
      if (!Array.isArray(source.entries)) return null;
      const entries = source.entries
        .slice(0, DISPLAY_LIST_LIMIT)
        .filter(isRecord)
        .map((entry) => {
          const content = boundedString(entry.content, DISPLAY_TEXT_LIMIT);
          if (content === undefined) return null;
          const status = projectOptionalStatus(entry, "status", isExternalAgentPlanStatus);
          return {
            content,
            ...(status !== undefined ? { status } : {}),
          };
        })
        .filter((entry): entry is { readonly content: string; readonly status?: "pending" | "in_progress" | "completed" } => entry !== null);
      return { sessionUpdate: "plan", entries };
    }
    default:
      return null;
  }
}

/** Project an optional direct prompt response without retaining arbitrary result fields. */
export function projectExternalAgentPromptResult(value: unknown): ExternalAgentPromptResult | null {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) return null;
  const messageId = boundedId(value.messageId);
  if (value.content === undefined) {
    return messageId ? { messageId } : {};
  }
  const content = projectContent(value.content);
  if (!content) return null;
  return {
    ...(messageId ? { messageId } : {}),
    content,
  };
}

export function isExternalAgentSessionUpdateNotification(
  value: unknown,
): value is ExternalAgentSessionUpdateNotification {
  if (!isRecord(value) || typeof value.sessionId !== "string") return false;
  if (
    value.sequence !== undefined &&
    (typeof value.sequence !== "number" ||
      !Number.isSafeInteger(value.sequence) ||
      value.sequence < 1)
  ) {
    return false;
  }
  return isExternalAgentSessionUpdate(value.update);
}
