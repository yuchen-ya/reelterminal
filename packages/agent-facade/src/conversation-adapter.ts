/**
 * Provider-neutral server-side contract for an external Agent host.
 *
 * The provider owns the session, model, credentials, durable history and MCP
 * client. This router only maps the open conversation method names to typed
 * callbacks and enforces one prompt lane plus exact session ownership.
 */
import {
  EXTERNAL_CONVERSATION_METHODS,
  OPENREEL_CONVERSATION_PROTOCOL_VERSION,
  isRecord,
  type ExternalAgentApprovalParams,
  type ExternalAgentCancelParams,
  type ExternalAgentCloseParams,
  type ExternalAgentInfo,
  type ExternalAgentInitializeParams,
  type ExternalAgentInitializeResult,
  type ExternalAgentNotification,
  type ExternalAgentPromptParams,
  type ExternalAgentPromptResult,
  type ExternalAgentResumeParams,
  type ExternalAgentSessionCapabilities,
  type ExternalAgentWorkModeParams,
} from "./conversation-protocol";
import { isAgentWorkMode } from "./work-mode";

export class ExternalConversationAdapterError extends Error {
  constructor(
    readonly code: -32601 | -32602 | -32001 | -32002,
    message: string,
  ) {
    super(message);
    this.name = "ExternalConversationAdapterError";
  }
}

export interface ExternalConversationProviderAdapter {
  /** Existing opaque session id owned by the provider. */
  readonly sessionId: string;
  readonly agentInfo: ExternalAgentInfo;
  readonly sessionCapabilities: ExternalAgentSessionCapabilities;
  initialize?(params: ExternalAgentInitializeParams): Promise<void> | void;
  resume(params: ExternalAgentResumeParams): Promise<void>;
  prompt(
    params: ExternalAgentPromptParams,
    options: { readonly signal: AbortSignal },
  ): Promise<ExternalAgentPromptResult | void>;
  cancel(params: ExternalAgentCancelParams): Promise<void> | void;
  resolveApproval?(
    params: ExternalAgentApprovalParams,
  ): Promise<void> | void;
  updateWorkMode?(
    params: ExternalAgentWorkModeParams,
  ): Promise<void> | void;
  closeSession?(params: ExternalAgentCloseParams): Promise<void> | void;
  onNotification(
    listener: (notification: ExternalAgentNotification) => void,
  ): () => void;
}

export interface ExternalConversationAdapterRouter {
  request(
    method: string,
    params: unknown,
    options?: { readonly signal?: AbortSignal },
  ): Promise<unknown>;
  notify(method: string, params: unknown): Promise<void>;
  onNotification(
    listener: (notification: ExternalAgentNotification) => void,
  ): () => void;
  dispose(): Promise<void>;
}

function invalid(message: string): never {
  throw new ExternalConversationAdapterError(-32602, message);
}

function sessionId(params: unknown): string {
  if (!isRecord(params) || typeof params.sessionId !== "string") {
    return invalid("A sessionId is required");
  }
  return params.sessionId;
}

function assertOwnedSession(params: unknown, expected: string): void {
  if (sessionId(params) !== expected) {
    throw new ExternalConversationAdapterError(
      -32001,
      "The requested external Agent session is not available",
    );
  }
}

function asInitializeParams(value: unknown): ExternalAgentInitializeParams {
  if (
    !isRecord(value) ||
    !isRecord(value.clientInfo) ||
    typeof value.clientInfo.name !== "string" ||
    typeof value.clientInfo.version !== "string"
  ) {
    return invalid("initialize requires clientInfo.name and clientInfo.version");
  }
  if (
    value.protocolVersion !== undefined &&
    String(value.protocolVersion) !== OPENREEL_CONVERSATION_PROTOCOL_VERSION
  ) {
    throw new ExternalConversationAdapterError(
      -32002,
      "The requested conversation protocol version is unsupported",
    );
  }
  return value as unknown as ExternalAgentInitializeParams;
}

function asPromptParams(
  value: unknown,
  expectedSessionId: string,
): ExternalAgentPromptParams {
  assertOwnedSession(value, expectedSessionId);
  if (
    !isRecord(value) ||
    !Array.isArray(value.prompt) ||
    value.prompt.length === 0 ||
    !value.prompt.every(
      (part) =>
        isRecord(part) &&
        part.type === "text" &&
        typeof part.text === "string" &&
        part.text.length > 0,
    )
  ) {
    return invalid("session/prompt requires non-empty text content");
  }
  return value as unknown as ExternalAgentPromptParams;
}

function linkedAbortSignal(
  signals: readonly (AbortSignal | undefined)[],
): { readonly signal: AbortSignal; readonly dispose: () => void } {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  for (const signal of signals) {
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const signal of signals) signal?.removeEventListener("abort", abort);
    },
  };
}

export function createExternalConversationAdapterRouter(
  provider: ExternalConversationProviderAdapter,
): ExternalConversationAdapterRouter {
  let promptAbort: AbortController | null = null;
  let disposed = false;

  const request = async (
    method: string,
    params: unknown,
    options?: { readonly signal?: AbortSignal },
  ): Promise<unknown> => {
    if (disposed) {
      throw new ExternalConversationAdapterError(
        -32002,
        "The conversation adapter is closed",
      );
    }
    switch (method) {
      case EXTERNAL_CONVERSATION_METHODS.initialize: {
        const value = asInitializeParams(params);
        await provider.initialize?.(value);
        return {
          protocolVersion: OPENREEL_CONVERSATION_PROTOCOL_VERSION,
          agentInfo: provider.agentInfo,
          sessionCapabilities: provider.sessionCapabilities,
        } satisfies ExternalAgentInitializeResult;
      }
      case EXTERNAL_CONVERSATION_METHODS.resume: {
        assertOwnedSession(params, provider.sessionId);
        await provider.resume(params as ExternalAgentResumeParams);
        return {};
      }
      case EXTERNAL_CONVERSATION_METHODS.prompt: {
        if (promptAbort) {
          throw new ExternalConversationAdapterError(
            -32002,
            "A prompt is already in flight for this attachment",
          );
        }
        const value = asPromptParams(params, provider.sessionId);
        promptAbort = new AbortController();
        const linked = linkedAbortSignal([
          promptAbort.signal,
          options?.signal,
        ]);
        try {
          return (await provider.prompt(value, { signal: linked.signal })) ?? {};
        } finally {
          linked.dispose();
          promptAbort = null;
        }
      }
      case EXTERNAL_CONVERSATION_METHODS.cancel: {
        assertOwnedSession(params, provider.sessionId);
        promptAbort?.abort();
        await provider.cancel(params as ExternalAgentCancelParams);
        return {};
      }
      case EXTERNAL_CONVERSATION_METHODS.approval: {
        assertOwnedSession(params, provider.sessionId);
        if (!provider.resolveApproval) {
          throw new ExternalConversationAdapterError(
            -32601,
            "This adapter does not support approval resolution",
          );
        }
        const record = params as unknown as Record<string, unknown>;
        if (
          typeof record.requestId !== "string" ||
          (record.decision !== "approved" && record.decision !== "denied")
        ) {
          return invalid("session/approval requires requestId and decision");
        }
        await provider.resolveApproval(params as ExternalAgentApprovalParams);
        return {};
      }
      case EXTERNAL_CONVERSATION_METHODS.close: {
        assertOwnedSession(params, provider.sessionId);
        if (!provider.closeSession) {
          throw new ExternalConversationAdapterError(
            -32601,
            "This adapter does not allow the client to close its session",
          );
        }
        await provider.closeSession(params as ExternalAgentCloseParams);
        return {};
      }
      default:
        throw new ExternalConversationAdapterError(
          -32601,
          `Unsupported conversation method: ${method}`,
        );
    }
  };

  return {
    request,
    async notify(method, params) {
      if (disposed) {
        throw new ExternalConversationAdapterError(
          -32002,
          "The conversation adapter is closed",
        );
      }
      if (method === EXTERNAL_CONVERSATION_METHODS.cancel) {
        assertOwnedSession(params, provider.sessionId);
        promptAbort?.abort();
        await provider.cancel(params as ExternalAgentCancelParams);
        return;
      }
      if (method === EXTERNAL_CONVERSATION_METHODS.workMode) {
        assertOwnedSession(params, provider.sessionId);
        if (!isRecord(params) || !isRecord(params.clientContext)) {
          return invalid("openreel/work_mode requires clientContext");
        }
        const context = params.clientContext;
        if (
          !isAgentWorkMode(context.workMode) ||
          !isRecord(context.semantics) ||
          context.semantics.id !== context.workMode ||
          typeof context.semantics.label !== "string" ||
          typeof context.semantics.summary !== "string" ||
          context.semantics.deliveryRequiresExplicitAuthorization !== true
        ) {
          return invalid("openreel/work_mode requires complete work-mode semantics");
        }
        await provider.updateWorkMode?.(
          params as unknown as ExternalAgentWorkModeParams,
        );
        return;
      }
      throw new ExternalConversationAdapterError(
        -32601,
        `Unsupported conversation notification: ${method}`,
      );
    },
    onNotification: (listener) => provider.onNotification(listener),
    async dispose() {
      if (disposed) return;
      disposed = true;
      promptAbort?.abort();
      promptAbort = null;
    },
  };
}
