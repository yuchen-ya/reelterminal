import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConversationDisplayState } from "@reelterminal/agent-facade/conversation-state";
import {
  installExternalConversationEventListener,
  useExternalConversationStore,
} from "./external-conversation-store";

type ConversationState = Awaited<
  ReturnType<
    NonNullable<NonNullable<Window["reelterminal"]>["conversation"]>["getState"]
  >
>;
type ConversationApi = NonNullable<NonNullable<Window["reelterminal"]>["conversation"]>;
type ConversationEvent = Parameters<ConversationApi["onEvent"]>[0] extends (
  event: infer Event,
) => void
  ? Event
  : never;

let nextStateSequence = 0;
const state = (
  lifecycle: ConversationState["conversation"]["lifecycle"] = "idle",
  sequence = ++nextStateSequence,
) => ({
  sequence,
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
  (window as { reelterminal?: unknown }).reelterminal = {
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
    nextStateSequence = 0;
    useExternalConversationStore.setState({
      state: {
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
      },
      busy: false,
      sending: false,
      cancelling: false,
      error: null,
    });
  });

  afterEach(() => {
    delete (window as { reelterminal?: unknown }).reelterminal;
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

  it("keeps cancel available while a prompt is in flight", async () => {
    const { conversation } = mockConversation();
    type PromptState = Awaited<ReturnType<typeof conversation.prompt>>;
    let finishPrompt!: (value: PromptState) => void;
    conversation.prompt.mockImplementation(
      () =>
        new Promise<PromptState>((resolve) => {
          finishPrompt = resolve;
        }),
    );

    const pendingPrompt = useExternalConversationStore
      .getState()
      .prompt("Long-running turn");
    expect(useExternalConversationStore.getState()).toMatchObject({
      busy: false,
      sending: true,
      cancelling: false,
    });

    await useExternalConversationStore.getState().cancel();
    expect(conversation.cancel).toHaveBeenCalledOnce();
    expect(useExternalConversationStore.getState()).toMatchObject({
      sending: true,
      cancelling: false,
    });

    finishPrompt(state("ready") as PromptState);
    await pendingPrompt;
    expect(useExternalConversationStore.getState().sending).toBe(false);
  });

  it("ignores an old prompt result after a newer attachment snapshot", async () => {
    const { conversation, emit } = mockConversation();
    const off = installExternalConversationEventListener();
    const oldPromptState = state("ready");
    let finishPrompt!: (value: typeof oldPromptState) => void;
    conversation.prompt.mockImplementation(
      () =>
        new Promise<typeof oldPromptState>((resolve) => {
          finishPrompt = resolve;
        }),
    );

    const pending = useExternalConversationStore.getState().prompt("Old turn");
    emit(state("disconnected"));
    finishPrompt(oldPromptState);
    await pending;

    expect(useExternalConversationStore.getState()).toMatchObject({
      sending: false,
      error: null,
      state: { conversation: { lifecycle: "disconnected" } },
    });
    off();
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
