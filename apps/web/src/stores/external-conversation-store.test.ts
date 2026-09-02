import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConversationDisplayState } from "@openreel/agent-facade/conversation-state";
import {
  installExternalConversationEventListener,
  useExternalConversationStore,
} from "./external-conversation-store";

type ConversationState = Awaited<
  ReturnType<
    NonNullable<NonNullable<Window["openreel"]>["conversation"]>["getState"]
  >
>;
type ConversationApi = NonNullable<NonNullable<Window["openreel"]>["conversation"]>;
type ConversationEvent = Parameters<ConversationApi["onEvent"]>[0] extends (
  event: infer Event,
) => void
  ? Event
  : never;

const state = (lifecycle: ConversationState["conversation"]["lifecycle"] = "idle") => ({
  adapter: {
    availability: "available" as const,
    agentLabel: "Test Agent",
    adapterName: "test-adapter",
    sessionId: "remote-session",
    capabilityLevel: "observable" as const,
    message: null,
  },
  conversation: { ...createConversationDisplayState(), lifecycle },
});

function mockConversation() {
  let listener: ((event: ConversationEvent) => void) | null = null;
  const conversation = {
    getState: vi.fn(async () => state()),
    attach: vi.fn(async () => state("ready")),
    prompt: vi.fn(async () => state("ready")),
    resolveApproval: vi.fn(async () => state("ready")),
    cancel: vi.fn(async () => state("ready")),
    detach: vi.fn(async () => state("disconnected")),
    onEvent: vi.fn((cb: (event: ConversationEvent) => void) => {
      listener = cb;
      return () => {
        listener = null;
      };
    }),
  };
  (window as { openreel?: unknown }).openreel = {
    platform: "desktop",
    conversation,
  };
  return {
    conversation,
    emit: (next: ConversationState) => listener?.({ type: "state", state: next }),
  };
}

describe("external-conversation-store", () => {
  beforeEach(() => {
    useExternalConversationStore.setState({
      state: {
        adapter: {
          availability: "missing",
          agentLabel: null,
          adapterName: null,
          sessionId: null,
          capabilityLevel: null,
          message: null,
        },
        conversation: createConversationDisplayState(),
      },
      busy: false,
      error: null,
    });
  });

  afterEach(() => {
    delete (window as { openreel?: unknown }).openreel;
    vi.restoreAllMocks();
  });

  it("routes attach, prompt, cancel, and detach through the desktop adapter", async () => {
    const { conversation } = mockConversation();
    await useExternalConversationStore.getState().initialize();
    await useExternalConversationStore.getState().attach();
    await useExternalConversationStore.getState().prompt("Join #2 and #3");
    await useExternalConversationStore
      .getState()
      .resolveApproval("approval-1", "approved");
    await useExternalConversationStore.getState().cancel();
    await useExternalConversationStore.getState().detach();

    expect(conversation.getState).toHaveBeenCalledOnce();
    expect(conversation.attach).toHaveBeenCalledOnce();
    expect(conversation.prompt).toHaveBeenCalledWith("Join #2 and #3");
    expect(conversation.resolveApproval).toHaveBeenCalledWith(
      "approval-1",
      "approved",
    );
    expect(conversation.cancel).toHaveBeenCalledOnce();
    expect(conversation.detach).toHaveBeenCalledOnce();
    expect(useExternalConversationStore.getState().state.conversation.lifecycle).toBe(
      "disconnected",
    );
  });

  it("accepts event snapshots without writing conversation data to storage", () => {
    const { emit } = mockConversation();
    const before = window.localStorage.length;
    const off = installExternalConversationEventListener();
    emit(state("ready"));
    expect(useExternalConversationStore.getState().state.conversation.lifecycle).toBe(
      "ready",
    );
    expect(window.localStorage.length).toBe(before);
    off();
  });
});
