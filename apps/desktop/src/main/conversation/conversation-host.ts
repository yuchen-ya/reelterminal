import {
  ExternalConversationBridge,
  OPENREEL_CONVERSATION_PROTOCOL_VERSION,
  createConversationDisplayState,
  type ExternalConversationBridge as ExternalConversationBridgeType,
} from "@openreel/agent-facade";
import type {
  ConversationAdapterSummary,
  DesktopConversationEvent,
  DesktopConversationState,
} from "../../shared/conversation";
import {
  ConversationDescriptorError,
  createLoopbackConversationConnector,
  descriptorSummary,
  readConversationEndpointDescriptor,
  type ConversationEndpointDescriptor,
} from "./loopback-connector";

const missingAdapter = (): ConversationAdapterSummary => ({
  availability: "missing",
  agentLabel: null,
  adapterName: null,
  sessionId: null,
  capabilityLevel: null,
  message: "No external Agent adapter is configured",
});

export interface ConversationHostDeps {
  readonly descriptorFilePath: string;
  readonly emitEvent: (event: DesktopConversationEvent) => void;
}

export interface ConversationHost {
  getState(): Promise<DesktopConversationState>;
  attach(): Promise<DesktopConversationState>;
  prompt(text: string): Promise<DesktopConversationState>;
  resolveApproval(
    requestId: string,
    decision: "approved" | "denied",
  ): Promise<DesktopConversationState>;
  cancel(): Promise<DesktopConversationState>;
  detach(): Promise<DesktopConversationState>;
  dispose(): Promise<void>;
}

export function createConversationHost(deps: ConversationHostDeps): ConversationHost {
  let bridge: ExternalConversationBridgeType | null = null;
  let unsubscribe: (() => void) | null = null;
  let adapter = missingAdapter();
  let queue: Promise<unknown> = Promise.resolve();

  const snapshot = (): DesktopConversationState => ({
    adapter: { ...adapter },
    conversation: bridge?.getDisplayState() ?? createConversationDisplayState(),
  });

  const emit = (): void => deps.emitEvent({ type: "state", state: snapshot() });

  const inspectAdapter = async (): Promise<ConversationEndpointDescriptor> => {
    try {
      const descriptor = await readConversationEndpointDescriptor(deps.descriptorFilePath);
      adapter = descriptorSummary(descriptor);
      return descriptor;
    } catch (error) {
      const message =
        error instanceof ConversationDescriptorError
          ? error.message
          : "Could not inspect the external Agent adapter";
      adapter = {
        ...missingAdapter(),
        availability: message.startsWith("No external") ? "missing" : "invalid",
        message,
      };
      throw error;
    }
  };

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation, operation);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const clearBridge = async (reason: "user" | "replaced" | "disabled"): Promise<void> => {
    const current = bridge;
    bridge = null;
    unsubscribe?.();
    unsubscribe = null;
    if (current) await current.disconnect(reason).catch(() => undefined);
  };

  const host: ConversationHost = {
    async getState() {
      return enqueue(async () => {
        if (!bridge) await inspectAdapter().catch(() => undefined);
        return snapshot();
      });
    },

    async attach() {
      return enqueue(async () => {
        await clearBridge("replaced");
        let descriptor: ConversationEndpointDescriptor;
        try {
          descriptor = await inspectAdapter();
        } catch (error) {
          emit();
          throw error;
        }
        const next = new ExternalConversationBridge({
          connector: createLoopbackConversationConnector(descriptor),
          protocolVersion: OPENREEL_CONVERSATION_PROTOCOL_VERSION,
        });
        bridge = next;
        unsubscribe = next.subscribe(() => emit());
        try {
          await next.connect({
            sessionId: descriptor.sessionId,
            agentLabel: descriptor.agent.name,
          });
        } catch (error) {
          emit();
          throw error;
        }
        emit();
        return snapshot();
      });
    },

    async prompt(text: string) {
      return enqueue(async () => {
        const value = text.trim();
        if (!value) throw new Error("A non-empty message is required");
        if (value.length > 32_000) throw new Error("Message is too long");
        if (!bridge) throw new Error("No external Agent conversation is attached");
        await bridge.prompt(value);
        emit();
        return snapshot();
      });
    },

    async resolveApproval(requestId, decision) {
      return enqueue(async () => {
        if (!bridge) throw new Error("No external Agent conversation is attached");
        await bridge.resolveApproval(requestId, decision);
        emit();
        return snapshot();
      });
    },

    async cancel() {
      return enqueue(async () => {
        if (!bridge) throw new Error("No external Agent conversation is attached");
        await bridge.cancel();
        emit();
        return snapshot();
      });
    },

    async detach() {
      return enqueue(async () => {
        await clearBridge("user");
        emit();
        return snapshot();
      });
    },

    async dispose() {
      return enqueue(async () => {
        await clearBridge("disabled");
      });
    },
  };

  return host;
}
