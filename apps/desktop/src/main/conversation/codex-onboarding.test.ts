import { describe, expect, it, vi } from "vitest";
import {
  createCodexOnboardingHost,
  summarizeCodexThreads,
} from "./codex-onboarding";

describe("Codex onboarding host", () => {
  it("sanitizes App Server threads for the renderer", () => {
    expect(summarizeCodexThreads({
      data: [
        {
          id: "thr_1",
          name: "  Edit   launch video  ",
          preview: "private/path should not be a field",
          cwd: "/Users/private/project",
          updatedAt: 42,
          status: { type: "active", activeFlags: [] },
        },
        { id: 4, name: "invalid" },
      ],
    })).toEqual([{
      id: "thr_1",
      title: "Edit launch video",
      preview: "private/path should not be a field",
      updatedAt: 42,
      active: true,
    }]);
  });

  it("checks Codex auth, connector, and real stored threads without starting one", async () => {
    const startAdapter = vi.fn();
    const close = vi.fn(async () => undefined);
    const host = createCodexOnboardingHost({
      descriptorFilePath: "/runtime/conversation.json",
      visualStateRoot: "/runtime/visuals",
      liveMcpConnector: "/app/live-mcp.js",
      newThreadCwd: "/videos/agent-workspace",
      env: { OPENREEL_CODEX_COMMAND: "codex-test" },
      accessFile: vi.fn(async () => undefined),
      inspectExternalAdapter: vi.fn(async () => {
        throw Object.assign(new Error("missing"), { name: "ConversationDescriptorError" });
      }),
      createClient: () => ({
        start: vi.fn(async () => ({})),
        readAccount: vi.fn(async () => ({ account: { type: "chatgpt" }, requiresOpenaiAuth: true })),
        listThreads: vi.fn(async () => ({ data: [{ id: "thr_a", name: "Trailer polish" }] })),
        close,
      }),
      startAdapter,
    });

    const state = await host.inspect();
    expect(state.codex).toEqual({ state: "ready", code: "codex-ready" });
    expect(state.authentication).toEqual({ state: "ready", code: "auth-ready" });
    expect(state.liveConnector).toEqual({ state: "ready", code: "connector-ready" });
    expect(state.threads).toEqual([expect.objectContaining({ id: "thr_a", title: "Trailer polish" })]);
    expect(startAdapter).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("starts the managed adapter for exactly the selected existing thread", async () => {
    const adapter = { threadId: "thr_selected", close: vi.fn(async () => undefined) };
    const startAdapter = vi.fn(async (_options: Record<string, unknown>) => adapter);
    const host = createCodexOnboardingHost({
      descriptorFilePath: "/runtime/conversation.json",
      visualStateRoot: "/runtime/visuals",
      liveMcpConnector: "/app/live-mcp.js",
      newThreadCwd: "/videos/agent-workspace",
      env: { OPENREEL_CODEX_COMMAND: "codex-test" },
      accessFile: vi.fn(async () => undefined),
      ensureDirectory: vi.fn(async () => undefined),
      inspectExternalAdapter: vi.fn(async () => ({})),
      createClient: () => ({
        start: vi.fn(async () => ({})),
        readAccount: vi.fn(async () => ({ account: { type: "chatgpt" } })),
        listThreads: vi.fn(async () => ({ data: [] })),
        close: vi.fn(async () => undefined),
      }),
      startAdapter,
    });

    const state = await host.start({ provider: "codex", threadId: "thr_selected" });
    expect(startAdapter).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thr_selected",
      descriptorPath: "/runtime/conversation.json",
      liveMcpConnector: "/app/live-mcp.js",
    }));
    expect(startAdapter.mock.calls[0]?.[0]).not.toHaveProperty("cwd");
    expect(state.managedSessionId).toBe("thr_selected");
    await host.dispose();
    expect(adapter.close).toHaveBeenCalledOnce();
  });

  it("uses the bounded Agent workspace only when creating a new Codex thread", async () => {
    const startAdapter = vi.fn(async (_options: Record<string, unknown>) => ({
      threadId: "thr_new",
      close: vi.fn(async () => undefined),
    }));
    const host = createCodexOnboardingHost({
      descriptorFilePath: "/runtime/conversation.json",
      visualStateRoot: "/runtime/visuals",
      liveMcpConnector: "/app/live-mcp.js",
      newThreadCwd: "/videos/agent-workspace",
      env: { OPENREEL_CODEX_COMMAND: "codex-test" },
      accessFile: vi.fn(async () => undefined),
      ensureDirectory: vi.fn(async () => undefined),
      inspectExternalAdapter: vi.fn(async () => ({})),
      createClient: () => ({
        start: vi.fn(async () => ({})),
        readAccount: vi.fn(async () => ({ account: { type: "chatgpt" } })),
        listThreads: vi.fn(async () => ({ data: [] })),
        close: vi.fn(async () => undefined),
      }),
      startAdapter,
    });

    await host.start({ provider: "codex", createThread: true });
    expect(startAdapter).toHaveBeenCalledWith(expect.objectContaining({
      createThread: true,
      cwd: "/videos/agent-workspace",
    }));
  });

  it("keeps the current managed adapter when a replacement cannot start", async () => {
    const current = { threadId: "thr_current", close: vi.fn(async () => undefined) };
    const startAdapter = vi
      .fn<[Record<string, unknown>], Promise<typeof current>>()
      .mockResolvedValueOnce(current)
      .mockRejectedValueOnce(new Error("resume failed"));
    const host = createCodexOnboardingHost({
      descriptorFilePath: "/runtime/conversation.json",
      visualStateRoot: "/runtime/visuals",
      liveMcpConnector: "/app/live-mcp.js",
      newThreadCwd: "/videos/agent-workspace",
      env: { OPENREEL_CODEX_COMMAND: "codex-test" },
      accessFile: vi.fn(async () => undefined),
      inspectExternalAdapter: vi.fn(async () => ({})),
      createClient: () => ({
        start: vi.fn(async () => ({})),
        readAccount: vi.fn(async () => ({ account: { type: "chatgpt" } })),
        listThreads: vi.fn(async () => ({ data: [] })),
        close: vi.fn(async () => undefined),
      }),
      startAdapter,
    });

    await host.start({ provider: "codex", threadId: "thr_current" });
    await expect(host.start({ provider: "codex", threadId: "thr_other" })).rejects.toThrow(
      "resume failed",
    );
    expect(current.close).not.toHaveBeenCalled();
    expect((await host.inspect()).managedSessionId).toBe("thr_current");
    await host.dispose();
    expect(current.close).toHaveBeenCalledOnce();
  });
});
