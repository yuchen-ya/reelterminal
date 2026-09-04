/**
 * ACP-style attachment client for an externally owned agent conversation.
 *
 * This service is deliberately a client, not an agent: it never creates a
 * local conversation, calls an LLM, selects a model/provider, stores prompt
 * text, or invokes ReelTerminal edit verbs. The external agent remains the owner
 * of reasoning and history and reaches ReelTerminal's canonical project through
 * MCP. ReelTerminal only resumes the paired remote session and projects streamed
 * updates into a bounded in-memory display buffer.
 */
import {
  EXTERNAL_CONVERSATION_METHODS,
  OPENREEL_CONVERSATION_CLIENT,
  isExternalAgentInitializeResult,
  isExternalAgentSessionUpdateNotification,
  isRecord,
  normalizeExternalConversationCapabilities,
  projectExternalAgentPromptResult,
  projectExternalAgentSessionUpdate,
  type ConversationAttachmentLease,
  type ExternalAgentConnector,
  type ExternalAgentContent,
  type ExternalAgentApprovalDecision,
  type ExternalAgentApprovalParams,
  type ExternalAgentInfo,
  type ExternalAgentInitializeParams,
  type ExternalAgentInitializeResult,
  type ExternalAgentNotification,
  type ExternalAgentPairing,
  type ExternalAgentTransport,
  type ExternalConversationDisplayState,
  type ExternalConversationCapabilitySupport,
  type ExternalConversationDisconnectReason,
  type ExternalConversationError,
  type ExternalConversationErrorCode,
  type ExternalConversationEvent,
  type ExternalConversationFallback,
  type ExternalConversationLifecycle,
  type ExternalConversationOwnership,
} from "./conversation-protocol";
import {
  DEFAULT_AGENT_WORK_MODE,
  agentWorkModeSemantics,
  type AgentWorkMode,
} from "./work-mode";
import {
  createConversationDisplayState,
  DEFAULT_CONVERSATION_DISPLAY_LIMIT,
  reduceConversationDisplayState,
} from "./conversation-state";

export interface ExternalConversationBridgeOptions {
  readonly connector: ExternalAgentConnector;
  /** Optional local attachment arbitration; never represents remote session ownership. */
  readonly attachmentLease?: ConversationAttachmentLease;
  /** Called exactly once after a successful attachment is released. */
  readonly onAttachmentReleased?: (
    ownership: ExternalConversationOwnership,
    reason: ExternalConversationDisconnectReason,
  ) => void | Promise<void>;
  /** Keep display memory bounded even when an agent streams indefinitely. */
  readonly displayLimit?: number;
  readonly now?: () => number;
  readonly connectionId?: () => string;
  /** Optional protocol version hint; it is not a model/provider setting. */
  readonly protocolVersion?: string;
  /** Shared desktop preference; read on attach, every prompt, and updates. */
  readonly getWorkMode?: () => AgentWorkMode;
}

export interface ExternalConversationPromptReceipt {
  readonly sessionId: string;
  /** Agent-owned message id, when returned by the ACP implementation. */
  readonly messageId?: string;
}

export class ExternalConversationBridgeError extends Error {
  readonly code: ExternalConversationErrorCode;

  constructor(code: ExternalConversationErrorCode, message: string) {
    super(message);
    this.name = "ExternalConversationBridgeError";
    this.code = code;
  }
}

interface LifecycleOptions {
  readonly reason?: ExternalConversationDisconnectReason;
  readonly fallback?: ExternalConversationFallback | null;
  readonly error?: ExternalConversationError;
  readonly agent?: ExternalAgentInfo | null;
  readonly ownership?: ExternalConversationOwnership | null;
  readonly capabilities?: ExternalConversationCapabilitySupport;
}

const asErrorCode = (value: unknown): string | number | null => {
  if (typeof value === "string" || typeof value === "number") return value;
  return null;
};

const asErrorMessage = (value: unknown): string =>
  value instanceof ExternalConversationBridgeError
    ? value.message.slice(0, 512)
    : "The external Agent operation failed";

function responseError(value: unknown): ExternalConversationBridgeError | null {
  if (!isRecord(value) || !isRecord(value.error)) return null;
  const rawCode = asErrorCode(value.error.code);
  const unsupported =
    rawCode === -32601 ||
    rawCode === "METHOD_NOT_FOUND" ||
    rawCode === "METHOD_UNSUPPORTED" ||
    rawCode === "UNSUPPORTED";
  return new ExternalConversationBridgeError(
    unsupported ? "UNSUPPORTED" : "TRANSPORT",
    unsupported
      ? "The external Agent does not support this operation"
      : "The external Agent request failed",
  );
}

function isUnsupportedError(error: unknown): boolean {
  if (error instanceof ExternalConversationBridgeError) return error.code === "UNSUPPORTED";
  if (!isRecord(error)) return false;
  const code = asErrorCode(error.code);
  return (
    code === -32601 ||
    code === "METHOD_NOT_FOUND" ||
    code === "METHOD_UNSUPPORTED" ||
    code === "UNSUPPORTED"
  );
}

function errorBody(
  code: ExternalConversationErrorCode,
  error: unknown,
): ExternalConversationError {
  return { code, message: asErrorMessage(error) };
}

function unwrapResult<T>(value: unknown): T {
  const rpcError = responseError(value);
  if (rpcError) throw rpcError;
  // Adapters normally unwrap JSON-RPC. Accepting an envelope as well keeps
  // this seam usable by a minimal transport adapter without duplicating it.
  if (isRecord(value) && "result" in value) return value.result as T;
  return value as T;
}

function normalizeAgentInfo(
  result: ExternalAgentInitializeResult,
): ExternalAgentInfo | null {
  if (!result.agentInfo) return null;
  return {
    name: result.agentInfo.name.slice(0, 256),
    ...(result.agentInfo.version !== undefined
      ? { version: result.agentInfo.version.slice(0, 128) }
      : {}),
  };
}

function validatePairing(pairing: ExternalAgentPairing): string {
  if (!isRecord(pairing) || typeof pairing.sessionId !== "string") {
    throw new ExternalConversationBridgeError(
      "INVALID_PAIRING",
      "An existing external agent sessionId is required to attach",
    );
  }
  const sessionId = pairing.sessionId.trim();
  if (!sessionId) {
    throw new ExternalConversationBridgeError(
      "INVALID_PAIRING",
      "An existing external agent sessionId is required to attach",
    );
  }
  return sessionId;
}

/**
 * A single ReelTerminal UI attachment to one externally owned agent session.
 * `connect` never calls `session/new`: pairing identifies the existing remote
 * session so the native agent chat and this optional view share one history.
 */
export class ExternalConversationBridge {
  private readonly options: ExternalConversationBridgeOptions;
  private readonly displayLimit: number;
  private readonly now: () => number;
  private readonly makeConnectionId: () => string;
  private state: ExternalConversationDisplayState = createConversationDisplayState();
  private eventSequence = 0;
  private transport: ExternalAgentTransport | null = null;
  private unsubscribeNotification: (() => void) | null = null;
  private unsubscribeClose: (() => void) | null = null;
  private connectionIdValue: string | null = null;
  private sessionIdValue: string | null = null;
  private ownershipValue: ExternalConversationOwnership | null = null;
  private agentInfo: ExternalAgentInfo | null = null;
  private capabilitiesValue: ExternalConversationCapabilitySupport =
    normalizeExternalConversationCapabilities(undefined);
  private lastRemoteSequence: number | null = null;
  private releaseNotified = false;
  private attachmentGeneration = 0;
  private listeners = new Set<(event: ExternalConversationEvent) => void>();
  /** Lifecycle mutations serialize; the active turn stays cancellable out-of-band. */
  private promptInFlight: Promise<ExternalConversationPromptReceipt> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: ExternalConversationBridgeOptions) {
    this.options = options;
    const requestedDisplayLimit = options.displayLimit ?? DEFAULT_CONVERSATION_DISPLAY_LIMIT;
    this.displayLimit = Number.isFinite(requestedDisplayLimit)
      ? Math.max(1, Math.floor(requestedDisplayLimit))
      : DEFAULT_CONVERSATION_DISPLAY_LIMIT;
    this.now = options.now ?? Date.now;
    this.makeConnectionId =
      options.connectionId ?? (() => `openreel-attachment-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  }

  getDisplayState(): ExternalConversationDisplayState {
    try {
      return structuredClone(this.state);
    } catch {
      return {
        ...this.state,
        updates: [...this.state.updates],
      };
    }
  }

  subscribe(listener: (event: ExternalConversationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private workModeContext() {
    const workMode = this.options.getWorkMode?.() ?? DEFAULT_AGENT_WORK_MODE;
    return { workMode, semantics: agentWorkModeSemantics(workMode) };
  }

  async connect(pairing: ExternalAgentPairing): Promise<ExternalConversationDisplayState> {
    return this.enqueue(async () => {
      if (
        this.state.lifecycle === "pairing" ||
        this.state.lifecycle === "connecting" ||
        this.state.lifecycle === "resuming" ||
        this.state.lifecycle === "ready" ||
        this.state.lifecycle === "disconnecting"
      ) {
        throw new ExternalConversationBridgeError(
          "ALREADY_ATTACHED",
          "An external agent conversation is already attached",
        );
      }

      const sessionId = validatePairing(pairing);
      this.attachmentGeneration += 1;
      const connectionId = this.makeConnectionId();
      if (!connectionId.trim()) {
        throw new ExternalConversationBridgeError(
          "INVALID_PAIRING",
          "The connector returned an empty attachment id",
        );
      }
      this.connectionIdValue = connectionId;
      this.sessionIdValue = sessionId;
      this.agentInfo = null;
      this.capabilitiesValue = normalizeExternalConversationCapabilities(undefined);
      this.lastRemoteSequence = null;
      this.releaseNotified = false;
      // A reconnect starts a fresh display projection. The remote agent is
      // the history authority and may replay history through session/update.
      this.state = {
        ...createConversationDisplayState(),
        lastEventSequence: this.eventSequence,
      };
      const ownership: ExternalConversationOwnership = {
        sessionOwner: "external-agent",
        attachmentOwner: "openreel-client",
        sessionId,
        connectionId,
      };
      if (
        this.options.attachmentLease &&
        !this.options.attachmentLease.acquire(connectionId, sessionId)
      ) {
        const error = errorBody(
          "LEASE_UNAVAILABLE",
          "The external agent session is already attached in this ReelTerminal window",
        );
        this.connectionIdValue = null;
        this.sessionIdValue = null;
        this.emitLifecycle("error", { error });
        throw new ExternalConversationBridgeError(error.code, error.message);
      }
      this.ownershipValue = ownership;
      this.emitLifecycle("pairing", { ownership });

      let transport: ExternalAgentTransport | null = null;
      try {
        this.emitLifecycle("connecting", { ownership });
        transport = await this.options.connector.connect({
          sessionId,
          ...(pairing.agentLabel ? { agentLabel: pairing.agentLabel } : {}),
        });
        this.installTransport(transport);

        const initializeParams: ExternalAgentInitializeParams = {
          ...(this.options.protocolVersion
            ? { protocolVersion: this.options.protocolVersion }
            : {}),
          clientInfo: OPENREEL_CONVERSATION_CLIENT,
          clientCapabilities: {
            sessionUpdate: true,
            conversation: {
              formalReply: true,
              streaming: true,
              reasoningSummary: true,
              toolEvents: true,
              approval: true,
              usage: true,
              artifact: true,
              subtask: true,
            },
          },
          clientContext: this.workModeContext(),
        };
        const initializeRaw = await transport.request(
          EXTERNAL_CONVERSATION_METHODS.initialize,
          initializeParams,
        );
        const initialize = unwrapResult<ExternalAgentInitializeResult>(initializeRaw);
        if (!isExternalAgentInitializeResult(initialize)) {
          throw new ExternalConversationBridgeError(
            "UNSUPPORTED",
            "The external agent did not return an ACP initialize response",
          );
        }
        this.agentInfo = normalizeAgentInfo(initialize);
        this.capabilitiesValue = normalizeExternalConversationCapabilities(
          initialize.sessionCapabilities?.conversation,
        );
        this.emitLifecycle("resuming", {
          ownership,
          agent: this.agentInfo,
          capabilities: this.capabilitiesValue,
        });

        if (initialize.sessionCapabilities?.resume !== true) {
          throw new ExternalConversationBridgeError(
            "UNSUPPORTED",
            "The external agent does not support resuming an existing session",
          );
        }
        if (
          initialize.sessionCapabilities?.prompt !== true ||
          initialize.sessionCapabilities?.cancel !== true ||
          this.capabilitiesValue.formalReply !== "supported"
        ) {
          throw new ExternalConversationBridgeError(
            "UNSUPPORTED",
            "The external agent does not support the basic conversation surface",
          );
        }
        const resumeRaw = await transport.request(
          EXTERNAL_CONVERSATION_METHODS.resume,
          { sessionId, clientContext: this.workModeContext() },
        );
        unwrapResult<unknown>(resumeRaw);
        this.emitLifecycle("ready", {
          ownership,
          agent: this.agentInfo,
          capabilities: this.capabilitiesValue,
          fallback: null,
        });
        return this.getDisplayState();
      } catch (error) {
        const unsupported = isUnsupportedError(error);
        await this.releaseTransport(transport);
        await this.releaseAttachment("protocol_error");
        this.connectionIdValue = null;
        const code: ExternalConversationErrorCode = unsupported
          ? "UNSUPPORTED"
          : error instanceof ExternalConversationBridgeError &&
              error.code === "INVALID_RESPONSE"
            ? "INVALID_RESPONSE"
            : "TRANSPORT";
        const displayError = errorBody(code, error);
        this.emitLifecycle(unsupported ? "unsupported" : "error", {
          ownership: null,
          fallback: unsupported ? "mcp-only" : null,
          error: displayError,
          agent: this.agentInfo,
        });
        if (unsupported) return this.getDisplayState();
        throw new ExternalConversationBridgeError(code, displayError.message);
      }
    });
  }

  async prompt(
    content: string | readonly ExternalAgentContent[],
  ): Promise<ExternalConversationPromptReceipt> {
    if (this.promptInFlight) {
      throw new ExternalConversationBridgeError(
        "INVALID_STATE",
        "An external Agent prompt is already in flight",
      );
    }
    const transport = this.requireReady();
    const sessionId = this.requireSessionId();
    const attachment = {
      generation: this.attachmentGeneration,
      transport,
      sessionId,
      connectionId: this.connectionIdValue,
    };
    const operation = this.performPrompt(content, attachment);
    this.promptInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.promptInFlight === operation) this.promptInFlight = null;
    }
  }

  private async performPrompt(
    content: string | readonly ExternalAgentContent[],
    attachment: {
      readonly generation: number;
      readonly transport: ExternalAgentTransport;
      readonly sessionId: string;
      readonly connectionId: string | null;
    },
  ): Promise<ExternalConversationPromptReceipt> {
    const { transport, sessionId } = attachment;
    const prompt: readonly ExternalAgentContent[] =
      typeof content === "string" ? [{ type: "text", text: content }] : [...content];
    if (
      prompt.length === 0 ||
      prompt.some((part) => part.type !== "text" || !part.text.trim())
    ) {
      throw new ExternalConversationBridgeError(
        "INVALID_PAIRING",
        "A non-empty text prompt is required",
      );
    }
    // Deliberately emit no prompt text. The external agent is the history
    // authority and may echo it as a user_message session update.
    this.emitPrompt("submitted");
    try {
      const raw = await transport.request(
        EXTERNAL_CONVERSATION_METHODS.prompt,
        { sessionId, prompt, clientContext: this.workModeContext() },
      );
      if (!this.isCurrentAttachment(attachment)) {
        throw new ExternalConversationBridgeError(
          "INVALID_STATE",
          "The prompt completed after its conversation attachment changed",
        );
      }
      const result = unwrapResult<unknown>(raw);
      this.emitPrompt("accepted");
      const projected = projectExternalAgentPromptResult(result);
      if (!projected) {
        throw new ExternalConversationBridgeError(
          "INVALID_RESPONSE",
          "The external agent returned an invalid prompt response",
        );
      }
      if (projected.content && this.capabilitiesAllow("agent_message")) {
        this.emitSessionUpdate({
          sessionUpdate: "agent_message",
          ...(projected.messageId ? { messageId: projected.messageId } : {}),
          content: projected.content,
        });
      }
      const messageId = projected.messageId;
      return { sessionId, ...(messageId ? { messageId } : {}) };
    } catch (error) {
      if (!this.isCurrentAttachment(attachment)) {
        throw new ExternalConversationBridgeError(
          "INVALID_STATE",
          "The prompt was cancelled because its conversation attachment changed",
        );
      }
      const unsupported = isUnsupportedError(error);
      if (unsupported) {
        await this.failUnsupported("session/prompt is not supported by the external agent");
      }
      const code: ExternalConversationErrorCode = unsupported
        ? "UNSUPPORTED"
        : error instanceof ExternalConversationBridgeError
          ? error.code
          : "TRANSPORT";
      throw new ExternalConversationBridgeError(code, asErrorMessage(error));
    }
  }

  private isCurrentAttachment(attachment: {
    readonly generation: number;
    readonly transport: ExternalAgentTransport;
    readonly sessionId: string;
    readonly connectionId: string | null;
  }): boolean {
    return (
      attachment.generation === this.attachmentGeneration &&
      attachment.transport === this.transport &&
      attachment.sessionId === this.sessionIdValue &&
      attachment.connectionId === this.connectionIdValue
    );
  }

  /** Notify an attached Agent immediately; prompt payloads also carry the mode. */
  async updateWorkMode(): Promise<void> {
    if (this.state.lifecycle !== "ready" || !this.transport) return;
    await this.transport.notify(EXTERNAL_CONVERSATION_METHODS.workMode, {
      sessionId: this.requireSessionId(),
      clientContext: this.workModeContext(),
    });
  }

  async cancel(): Promise<void> {
    const transport = this.requireReady();
    const sessionId = this.requireSessionId();
    try {
      await transport.notify(EXTERNAL_CONVERSATION_METHODS.cancel, { sessionId });
      this.emitPrompt("cancel_requested");
    } catch (error) {
      throw new ExternalConversationBridgeError("TRANSPORT", asErrorMessage(error));
    }
  }

  /** Resolve an agent-owned approval request without creating local history. */
  async resolveApproval(
    requestId: string,
    decision: ExternalAgentApprovalDecision,
  ): Promise<void> {
    return this.enqueue(async () => {
      const transport = this.requireReady();
      const sessionId = this.requireSessionId();
      if (this.capabilitiesValue.approval === "unsupported") {
        throw new ExternalConversationBridgeError(
          "UNSUPPORTED",
          "The external agent did not advertise approval support",
        );
      }
      if (
        typeof requestId !== "string" ||
        !requestId.trim() ||
        (decision !== "approved" && decision !== "denied")
      ) {
        throw new ExternalConversationBridgeError(
          "INVALID_PAIRING",
          "A request id and approved or denied decision are required",
        );
      }
      const params: ExternalAgentApprovalParams = {
        sessionId,
        requestId: requestId.trim(),
        decision,
      };
      try {
        const raw = await transport.request(
          EXTERNAL_CONVERSATION_METHODS.approval,
          params,
        );
        unwrapResult<unknown>(raw);
      } catch (error) {
        const unsupported = isUnsupportedError(error);
        if (unsupported) {
          await this.failUnsupported("session/approval is not supported by the external agent");
        }
        const code: ExternalConversationErrorCode = unsupported
          ? "UNSUPPORTED"
          : error instanceof ExternalConversationBridgeError
            ? error.code
            : "TRANSPORT";
        throw new ExternalConversationBridgeError(
          code,
          asErrorMessage(error),
        );
      }
    });
  }

  /**
   * Detach the view. This does not send `session/close`: closing a view must
   * not delete/terminate the agent's session or its native conversation.
   * Transport close and the local attachment lease release are guaranteed.
   */
  async disconnect(reason: ExternalConversationDisconnectReason = "user"): Promise<void> {
    return this.enqueue(async () => {
      if (
        this.state.lifecycle === "idle" ||
        this.state.lifecycle === "disconnected" ||
        this.state.lifecycle === "unsupported" ||
        this.state.lifecycle === "error"
      ) {
        return;
      }
      this.attachmentGeneration += 1;
      this.emitLifecycle("disconnecting");
      await this.releaseTransport(this.transport);
      await this.releaseAttachment(reason);
      this.connectionIdValue = null;
      this.emitLifecycle("disconnected", {
        ownership: null,
        fallback: null,
        reason,
      });
      this.ownershipValue = null;
      // Keep the opaque session id as a reconnect hint; no history is kept.
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private installTransport(transport: ExternalAgentTransport): void {
    this.transport = transport;
    this.unsubscribeNotification = transport.onNotification((notification) => {
      this.handleNotification(notification, transport);
    });
    this.unsubscribeClose = transport.onClose((error) => {
      void this.handleTransportClose(transport, error);
    });
  }

  private handleNotification(
    notification: ExternalAgentNotification,
    transport: ExternalAgentTransport,
  ): void {
    if (transport !== this.transport || notification.method !== "session/update") return;
    if (!isExternalAgentSessionUpdateNotification(notification.params)) return;
    const update = notification.params;
    if (update.sessionId !== this.sessionIdValue || !this.connectionIdValue) return;
    if (update.sequence !== undefined) {
      if (
        this.lastRemoteSequence !== null &&
        update.sequence <= this.lastRemoteSequence
      ) {
        return;
      }
      this.lastRemoteSequence = update.sequence;
    }
    const projected = projectExternalAgentSessionUpdate(update.update);
    if (!projected || !this.capabilitiesAllow(projected.sessionUpdate)) return;
    this.emitSessionUpdate(projected, update.sequence);
  }

  private emitSessionUpdate(
    update: import("./conversation-protocol").ExternalAgentSessionUpdate,
    remoteSequence?: number,
  ): void {
    const connectionId = this.connectionIdValue;
    const sessionId = this.sessionIdValue;
    if (!connectionId || !sessionId) return;
    const event: ExternalConversationEvent = {
      type: "session_update",
      sequence: this.nextSequence(),
      occurredAt: this.now(),
      connectionId,
      sessionId,
      update,
      ...(remoteSequence !== undefined ? { remoteSequence } : {}),
    };
    this.applyAndPublish(event);
  }

  private capabilitiesAllow(kind: import("./conversation-protocol").ExternalAgentSessionUpdate["sessionUpdate"]): boolean {
    const capability =
      kind === "agent_message" || kind === "user_message"
        ? this.capabilitiesValue.formalReply
        : kind === "agent_message_chunk"
          ? this.capabilitiesValue.streaming
          : kind === "reasoning_summary"
            ? this.capabilitiesValue.reasoningSummary
            : kind === "tool_call" || kind === "tool_call_update" || kind === "tool_result"
              ? this.capabilitiesValue.toolEvents
              : kind === "approval_request" || kind === "approval_resolution"
                ? this.capabilitiesValue.approval
                : kind === "usage"
                  ? this.capabilitiesValue.usage
                  : kind === "artifact"
                    ? this.capabilitiesValue.artifact
                    : kind === "subtask"
                      ? this.capabilitiesValue.subtask
                      : "supported";
    // Unknown means omitted by an older agent and remains display-compatible.
    return capability !== "unsupported";
  }

  private async handleTransportClose(
    transport: ExternalAgentTransport,
    error?: unknown,
  ): Promise<void> {
    await this.enqueue(async () => {
      if (transport !== this.transport) return;
      this.attachmentGeneration += 1;
      const reason: ExternalConversationDisconnectReason = "transport_closed";
      await this.releaseTransport(transport, false);
      await this.releaseAttachment(reason);
      this.connectionIdValue = null;
      const displayError = error
        ? errorBody("TRANSPORT", error)
        : undefined;
      this.emitLifecycle("disconnected", {
        ownership: null,
        fallback: null,
        reason,
        ...(displayError ? { error: displayError } : {}),
      });
      this.ownershipValue = null;
    });
  }

  private async failUnsupported(message: string): Promise<void> {
    this.attachmentGeneration += 1;
    await this.releaseTransport(this.transport);
    await this.releaseAttachment("protocol_error");
    this.connectionIdValue = null;
    this.emitLifecycle("unsupported", {
      ownership: null,
      fallback: "mcp-only",
      error: { code: "UNSUPPORTED", message },
      agent: this.agentInfo,
    });
  }

  private async releaseTransport(
    transport: ExternalAgentTransport | null,
    close = true,
  ): Promise<void> {
    if (transport === null) return;
    if (transport === this.transport) {
      this.unsubscribeNotification?.();
      this.unsubscribeClose?.();
      this.unsubscribeNotification = null;
      this.unsubscribeClose = null;
      this.transport = null;
    }
    if (close) await transport.close().catch(() => undefined);
  }

  private async releaseAttachment(
    reason: ExternalConversationDisconnectReason,
  ): Promise<void> {
    const ownership = this.ownershipValue;
    if (!ownership || this.releaseNotified) return;
    this.releaseNotified = true;
    try {
      this.options.attachmentLease?.release(
        ownership.connectionId,
        ownership.sessionId,
      );
    } catch {
      // A lease adapter is expected to be idempotent; a faulty adapter cannot
      // prevent the bridge from detaching its transport and display state.
    }
    try {
      await this.options.onAttachmentReleased?.(ownership, reason);
    } catch {
      // Lease release is a lifecycle guarantee; an integration callback must
      // not strand the attachment or prevent the view from becoming detached.
    }
    this.ownershipValue = null;
  }

  private requireReady(): ExternalAgentTransport {
    if (this.state.lifecycle !== "ready" || !this.transport) {
      throw new ExternalConversationBridgeError(
        "INVALID_STATE",
        "The external agent conversation is not attached and ready",
      );
    }
    return this.transport;
  }

  private requireSessionId(): string {
    if (!this.sessionIdValue) {
      throw new ExternalConversationBridgeError(
        "INVALID_STATE",
        "No external agent session is attached",
      );
    }
    return this.sessionIdValue;
  }

  private emitPrompt(phase: "submitted" | "accepted" | "cancel_requested"): void {
    const connectionId = this.connectionIdValue;
    const sessionId = this.sessionIdValue;
    if (!connectionId || !sessionId) return;
    const event: ExternalConversationEvent = {
      type: "prompt",
      sequence: this.nextSequence(),
      occurredAt: this.now(),
      phase,
      connectionId,
      sessionId,
    };
    this.applyAndPublish(event);
  }

  private emitLifecycle(
    state: ExternalConversationLifecycle,
    options: LifecycleOptions = {},
  ): void {
    const event: ExternalConversationEvent = {
      type: "lifecycle",
      sequence: this.nextSequence(),
      occurredAt: this.now(),
      state,
      connectionId: this.connectionIdValue,
      sessionId: this.sessionIdValue,
      ownership: this.ownershipValue,
      ...(options.capabilities ? { capabilities: options.capabilities } : {}),
      ...(options.reason ? { reason: options.reason } : {}),
      ...(options.fallback ? { fallback: options.fallback } : {}),
      ...(options.error ? { error: options.error } : {}),
    };
    this.applyAndPublish(event, {
      agent: options.agent,
      ownership:
        options.ownership === undefined ? this.ownershipValue : options.ownership,
      capabilities: options.capabilities,
      fallback:
        options.fallback === undefined ? this.state.fallback : options.fallback,
    });
  }

  private nextSequence(): number {
    this.eventSequence += 1;
    return this.eventSequence;
  }

  private applyAndPublish(
    event: ExternalConversationEvent,
    patch: {
      readonly agent?: ExternalAgentInfo | null;
      readonly ownership?: ExternalConversationOwnership | null;
      readonly fallback?: ExternalConversationFallback | null;
      readonly capabilities?: ExternalConversationCapabilitySupport;
    } = {},
  ): void {
    this.state = reduceConversationDisplayState(
      this.state,
      event,
      this.displayLimit,
      patch,
    );
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A display subscriber cannot break the protocol or lease lifecycle.
      }
    }
  }
}

export function createExternalConversationBridge(
  options: ExternalConversationBridgeOptions,
): ExternalConversationBridge {
  return new ExternalConversationBridge(options);
}

/** Short alias for integrations that already call this a conversation bridge. */
export { ExternalConversationBridge as ConversationBridge };
