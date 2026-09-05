import { describe, expect, it, vi } from "vitest";
import {
  ExternalConversationAdapterError,
  createExternalConversationAdapterRouter,
  type ExternalConversationProviderAdapter,
} from "./conversation-adapter";
import type { ExternalAgentNotification } from "./conversation-protocol";

function fixture(overrides: Partial<ExternalConversationProviderAdapter> = {}) {
  const listeners = new Set<
    (notification: ExternalAgentNotification) => void
  >();
  const provider: ExternalConversationProviderAdapter = {
    sessionId: "owned-session",
    agentInfo: { name: "Reference Agent", version: "1.0" },
    sessionCapabilities: {
      resume: true,
      prompt: true,
      cancel: true,
      conversation: { formalReply: true, streaming: true },
    },
    resume: vi.fn(async () => undefined),
    prompt: vi.fn(async () => ({ messageId: "message-1" })),
    cancel: vi.fn(async () => undefined),
    onNotification: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ...overrides,
  };
  return { provider, listeners };
}

describe("provider-neutral external conversation adapter", () => {
  it("routes initialize, resume, prompt and work-mode context", async () => {
    const initialize = vi.fn();
    const updateWorkMode = vi.fn();
    const { provider } = fixture({ initialize, updateWorkMode });
    const router = createExternalConversationAdapterRouter(provider);

    const initialized = await router.request("initialize", {
      protocolVersion: "openreel-conversation/1",
      clientInfo: { name: "ReelTerminal", version: "0.1.0" },
    });
    expect(initialized).toMatchObject({
      protocolVersion: "openreel-conversation/1",
      agentInfo: { name: "Reference Agent" },
    });
    await router.request("session/resume", { sessionId: "owned-session" });
    await router.request("session/prompt", {
      sessionId: "owned-session",
      prompt: [{ type: "text", text: "Continue the edit" }],
    });
    await router.notify("openreel/work_mode", {
      sessionId: "owned-session",
      clientContext: {
        workMode: "guided",
        semantics: {
          id: "guided",
          label: "Guided",
          summary: "Explain consequential choices.",
          deliveryRequiresExplicitAuthorization: true,
        },
      },
    });

    expect(initialize).toHaveBeenCalledOnce();
    expect(provider.resume).toHaveBeenCalledOnce();
    expect(provider.prompt).toHaveBeenCalledOnce();
    expect(updateWorkMode).toHaveBeenCalledOnce();
  });

  it("rejects a foreign session before invoking the provider", async () => {
    const { provider } = fixture();
    const router = createExternalConversationAdapterRouter(provider);

    await expect(
      router.request("session/prompt", {
        sessionId: "other-session",
        prompt: [{ type: "text", text: "Do not route" }],
      }),
    ).rejects.toMatchObject({ code: -32001 });
    expect(provider.prompt).not.toHaveBeenCalled();
  });

  it("keeps one prompt lane and cancellation out of band", async () => {
    let observedSignal: AbortSignal | undefined;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const prompt = vi.fn(
      async (_params: unknown, options: { signal: AbortSignal }) => {
        observedSignal = options.signal;
        await pending;
      },
    );
    const { provider } = fixture({ prompt });
    const router = createExternalConversationAdapterRouter(provider);
    const first = router.request("session/prompt", {
      sessionId: "owned-session",
      prompt: [{ type: "text", text: "Long turn" }],
    });
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());

    await expect(
      router.request("session/prompt", {
        sessionId: "owned-session",
        prompt: [{ type: "text", text: "Overlapping turn" }],
      }),
    ).rejects.toMatchObject({ code: -32002 });
    await router.notify("session/cancel", { sessionId: "owned-session" });
    expect(provider.cancel).toHaveBeenCalledOnce();
    expect(observedSignal?.aborted).toBe(true);
    finish();
    await first;
  });

  it("fails optional operations explicitly and forwards safe notifications", async () => {
    const { provider, listeners } = fixture();
    const router = createExternalConversationAdapterRouter(provider);
    const received = vi.fn();
    const off = router.onNotification(received);
    const notification = {
      method: "session/update",
      params: { sessionId: "owned-session", update: { sessionUpdate: "state_update", state: "idle" } },
    } as const;
    for (const listener of listeners) listener(notification);
    expect(received).toHaveBeenCalledWith(notification);
    off();

    await expect(
      router.request("session/approval", {
        sessionId: "owned-session",
        requestId: "approval-1",
        decision: "approved",
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ExternalConversationAdapterError>>({
        code: -32601,
      }),
    );

    await router.dispose();
    await expect(
      router.notify("session/cancel", { sessionId: "owned-session" }),
    ).rejects.toMatchObject({ code: -32002 });
  });
});
