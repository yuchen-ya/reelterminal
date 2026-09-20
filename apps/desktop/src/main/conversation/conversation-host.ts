import {
  ExternalConversationBridge,
  OPENREEL_CONVERSATION_PROTOCOL_VERSION,
  createConversationDisplayState,
  type ExternalConversationBridge as ExternalConversationBridgeType,
  type AgentWorkMode,
} from "@reelterminal/agent-facade";
import type {
  ConversationAdapterSummary,
  DesktopConversationEvent,
  DesktopConversationState,
  ConversationVisualStateCapture,
} from "../../shared/conversation";
import {
  ConversationDescriptorError,
  createLoopbackConversationConnector,
  descriptorSummary,
  readConversationEndpointDescriptor,
  type ConversationEndpointDescriptor,
} from "./loopback-connector";
import type { ConversationVisualStateStore } from "./visual-state-store";

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
  readonly getWorkMode: () => AgentWorkMode;
  readonly visualStateStore?: ConversationVisualStateStore;
}

export interface ConversationHost {
  getState(): Promise<DesktopConversationState>;
  attach(): Promise<DesktopConversationState>;
  prompt(
    text: string,
    visualState?: ConversationVisualStateCapture,
  ): Promise<DesktopConversationState>;
  resolveApproval(
    requestId: string,
    decision: "approved" | "denied",
  ): Promise<DesktopConversationState>;
  cancel(): Promise<DesktopConversationState>;
  detach(): Promise<DesktopConversationState>;
  workModeChanged(): Promise<void>;
  dispose(): Promise<void>;
}

export function createConversationHost(deps: ConversationHostDeps): ConversationHost {
  let bridge: ExternalConversationBridgeType | null = null;
  let unsubscribe: (() => void) | null = null;
  let adapter = missingAdapter();
  let queue: Promise<unknown> = Promise.resolve();
  let emitScheduled = false;
  let snapshotSequence = 0;

  const snapshot = (): DesktopConversationState => ({
    sequence: ++snapshotSequence,
    adapter: { ...adapter },
    conversation: bridge?.getDisplayState() ?? createConversationDisplayState(),
  });

  const emit = (): void => deps.emitEvent({ type: "state", state: snapshot() });
  const scheduleEmit = (): void => {
    if (emitScheduled) return;
    emitScheduled = true;
    queueMicrotask(() => {
      emitScheduled = false;
      emit();
    });
  };

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
    await deps.visualStateStore?.clear().catch(() => undefined);
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
          getWorkMode: deps.getWorkMode,
        });
        bridge = next;
        // A transport poll may project many chunks synchronously. Coalesce
        // that burst into one detached IPC snapshot instead of cloning and
        // sending the full bounded state once per chunk.
        unsubscribe = next.subscribe(scheduleEmit);
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

    async prompt(text: string, visualStateCapture?: ConversationVisualStateCapture) {
      const value = text.trim();
      if (!value) throw new Error("A non-empty message is required");
      if (value.length > 32_000) throw new Error("Message is too long");
      const current = bridge;
      if (!current) throw new Error("No external Agent conversation is attached");
      // Visual state is an optimization/context aid. A capture or filesystem
      // failure must not make the conversation unusable; continue with exact
      // text and the regular MCP fallback when persistence is unavailable.
      const visualState = visualStateCapture
        ? await deps.visualStateStore
            ?.persist(visualStateCapture)
            .catch(() => undefined)
        : undefined;
      // The active turn deliberately does not occupy the lifecycle queue:
      // cancel, detach, and work-mode notifications must remain responsive.
      await current.prompt(value, visualState);
      emit();
      return snapshot();
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
      const current = bridge;
      if (!current) throw new Error("No external Agent conversation is attached");
      await current.cancel();
      emit();
      return snapshot();
    },

    async detach() {
      return enqueue(async () => {
        await clearBridge("user");
        emit();
        return snapshot();
      });
    },

    async workModeChanged() {
      await bridge?.updateWorkMode();
    },

    async dispose() {
      return enqueue(async () => {
        await clearBridge("disabled");
      });
    },
  };

  return host;
}
