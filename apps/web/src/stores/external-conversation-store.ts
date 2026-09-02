import { create } from "zustand";
import { createConversationDisplayState } from "@openreel/agent-facade/conversation-state";

type ConversationApi = NonNullable<NonNullable<Window["openreel"]>["conversation"]>;
type ConversationState = Awaited<ReturnType<ConversationApi["getState"]>>;

const unavailableState = (): ConversationState => ({
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
  busy: boolean;
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
  create<ExternalConversationStoreState>((set) => {
    const run = async (
      operation: (
        api: NonNullable<ReturnType<typeof conversationApi>>,
      ) => Promise<ConversationState>,
    ): Promise<void> => {
      const api = conversationApi();
      if (!api) {
        set({
          state: unavailableState(),
          busy: false,
          error: "External Agent conversations are available in the desktop app",
        });
        return;
      }
      set({ busy: true, error: null });
      try {
        set({ state: await operation(api), busy: false, error: null });
      } catch (error) {
        set({ busy: false, error: errorMessage(error) });
        throw error;
      }
    };

    return {
      state: unavailableState(),
      busy: false,
      error: null,
      applyState: (state) => set({ state, error: null }),
      initialize: () => run((api) => api.getState()),
      attach: () => run((api) => api.attach()),
      prompt: (text) => run((api) => api.prompt(text)),
      resolveApproval: (requestId, decision) =>
        run((api) => api.resolveApproval(requestId, decision)),
      cancel: () => run((api) => api.cancel()),
      detach: () => run((api) => api.detach()),
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
