import { create } from "zustand";
import { createConversationDisplayState } from "@reelterminal/agent-facade/conversation-state";
import {
  captureConversationVisualState,
  resetConversationVisualState,
} from "../services/agent/visual-state";

type ConversationApi = NonNullable<NonNullable<Window["openreel"]>["conversation"]>;
type ConversationState = Awaited<ReturnType<ConversationApi["getState"]>>;

const unavailableState = (): ConversationState => ({
  sequence: 0,
  adapter: {
    availability: "missing",
    agentLabel: null,
    adapterName: null,
    sessionId: null,
    capabilityLevel: null,
    message: null,
  },
  conversation: createConversationDisplayState(),
});

interface ExternalConversationStoreState {
  state: ConversationState;
  /** Attach/detach/approval/initialization lifecycle operation. */
  busy: boolean;
  /** A prompt request is awaiting the external Agent. */
  sending: boolean;
  /** A cancel notification is being delivered out-of-band. */
  cancelling: boolean;
  error: string | null;
  applyState(state: ConversationState): void;
  initialize(): Promise<void>;
  attach(): Promise<void>;
  prompt(text: string): Promise<void>;
  resolveApproval(requestId: string, decision: "approved" | "denied"): Promise<void>;
  cancel(): Promise<void>;
  detach(): Promise<void>;
}

function conversationApi() {
  return typeof window === "undefined" ? undefined : window.openreel?.conversation;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useExternalConversationStore =
  create<ExternalConversationStoreState>((set, get) => {
    const run = async (
      operation: (
        api: NonNullable<ReturnType<typeof conversationApi>>,
      ) => Promise<ConversationState>,
      pending: "busy" | "sending" | "cancelling" = "busy",
    ): Promise<void> => {
      const api = conversationApi();
      if (!api) {
        set({
          state: unavailableState(),
          busy: false,
          sending: false,
          cancelling: false,
          error: "External Agent conversations are available in the desktop app",
        });
        return;
      }
      const startedAtSequence = get().state.sequence;
      set({ [pending]: true, error: null });
      try {
        const nextState = await operation(api);
        set((current) => ({
          state:
            nextState.sequence >= current.state.sequence
              ? nextState
              : current.state,
          [pending]: false,
          error: null,
        }));
      } catch (error) {
        set((current) => ({
          [pending]: false,
          ...(current.state.sequence <= startedAtSequence
            ? { error: errorMessage(error) }
            : {}),
        }));
        throw error;
      }
    };

    return {
      state: unavailableState(),
      busy: false,
      sending: false,
      cancelling: false,
      error: null,
      applyState: (state) =>
        set((current) =>
          state.sequence < current.state.sequence
            ? current
            : { state, error: null },
        ),
      initialize: () => run((api) => api.getState()),
      attach: () => run((api) => api.attach()),
      prompt: (text) =>
        run((api) => {
          const sessionId = get().state.adapter.sessionId;
          const visualState = sessionId
            ? captureConversationVisualState(sessionId)
            : undefined;
          return visualState
            ? api.prompt(text, visualState)
            : api.prompt(text);
        }, "sending"),
      resolveApproval: (requestId, decision) =>
        run((api) => api.resolveApproval(requestId, decision)),
      cancel: () => run((api) => api.cancel(), "cancelling"),
      detach: () => {
        resetConversationVisualState();
        return run((api) => api.detach());
      },
    };
  });

export function installExternalConversationEventListener(): () => void {
  const api = conversationApi();
  if (!api) return () => undefined;
  return api.onEvent((event) => {
    if (event.type === "state") {
      useExternalConversationStore.getState().applyState(event.state);
    }
  });
}
