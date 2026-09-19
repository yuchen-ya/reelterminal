import { describe, expect, it, vi } from "vitest";
import {
  createCodexOnboardingHost,
  summarizeCodexThreads,
} from "./codex-onboarding";
import type { CodexOnboardingDeps } from "./codex-onboarding";

/** Failure shaped like the App Server client's CodexAppServerError. */
function appServerFailure(code: string, detail?: string): Error {
  return Object.assign(new Error(`Codex app-server failure (${code})`), {
    name: "CodexAppServerError",
    code,
    ...(detail ? { detail } : {}),
  });
}

interface HostOptions {
  readonly env?: Record<string, string>;
  readonly platform?: NodeJS.Platform;
  readonly accessFile?: (candidate: string, mode?: number) => Promise<void>;
  readonly startError?: unknown;
  readonly createClient?: CodexOnboardingDeps["createClient"];
  readonly startAdapter?: CodexOnboardingDeps["startAdapter"];
}

function createHost(options: HostOptions = {}) {
  const close = vi.fn(async () => undefined);
  const createClient =
    options.createClient ??
    vi.fn(() => ({
      start: vi.fn(async () => {
        if (options.startError) throw options.startError;
        return {};
      }),
      readAccount: vi.fn(async () => ({ account: { type: "chatgpt" } })),
      listThreads: vi.fn(async () => ({ data: [] })),
      close,
    }));
  return {
    close,
    createClient,
    host: createCodexOnboardingHost({
      descriptorFilePath: "/runtime/conversation.json",
      visualStateRoot: "/runtime/visuals",
      liveMcpConnector: "/app/live-mcp.js",
      newThreadCwd: "/videos/agent-workspace",
      env: options.env ?? { OPENREEL_CODEX_COMMAND: "codex-test" },
      ...(options.platform ? { platform: options.platform } : {}),
      ...(options.accessFile ? { accessFile: options.accessFile } : {}),
      createClient,
      ...(options.startAdapter ? { startAdapter: options.startAdapter } : {}),
      inspectExternalAdapter: vi.fn(async () => ({})),
    }),
  };
}

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

  it("classifies a nonzero app-server exit as a launch failure with sanitized detail", async () => {
    const { host } = createHost({
      startError: appServerFailure(
        "PROCESS_EXIT",
        "error: unexpected argument '--stdio' found",
      ),
    });
    const state = await host.inspect();
    expect(state.codex).toEqual({
      state: "error",
      code: "codex-launch-failed",
      detail: "error: unexpected argument '--stdio' found",
    });
    expect(state.authentication).toEqual({ state: "missing", code: "auth-unknown" });
  });

  it("classifies handshake timeouts as launch failures", async () => {
    const { host } = createHost({ startError: appServerFailure("REQUEST_TIMEOUT") });
    const state = await host.inspect();
    expect(state.codex).toEqual({ state: "error", code: "codex-launch-failed" });
  });

  it("classifies invalid handshakes as protocol errors", async () => {
    const { host } = createHost({ startError: appServerFailure("INVALID_RESPONSE") });
    const state = await host.inspect();
    expect(state.codex).toEqual({ state: "error", code: "codex-protocol-error" });
  });

  it("falls back to codex-unavailable for unexpected failures", async () => {
    const { host } = createHost({ startError: new Error("boom") });
    const state = await host.inspect();
    expect(state.codex).toEqual({ state: "error", code: "codex-unavailable" });
  });

  it("reports codex as missing when no candidate is executable", async () => {
    const { host } = createHost({
      env: {},
      accessFile: vi.fn(async () => {
        throw new Error("ENOENT");
      }),
    });
    const state = await host.inspect();
    expect(state.codex).toEqual({ state: "missing", code: "codex-missing" });
    expect(state.authentication).toEqual({ state: "missing", code: "auth-unknown" });
  });

  it("resolves npm global codex.cmd shims to their Node CLI entry on Windows", async () => {
    const cliEntry = "C:\\npm-global\\node_modules\\@openai\\codex\\bin\\codex.js";
    const accessFile = vi.fn(async (candidate: string) => {
      if (candidate === "C:\\npm-global\\codex.cmd") return;
      if (candidate === cliEntry) return;
      throw new Error("ENOENT");
    });
    const createClient = vi.fn(() => ({
      start: vi.fn(async () => ({})),
      readAccount: vi.fn(async () => ({ account: { type: "chatgpt" } })),
      listThreads: vi.fn(async () => ({ data: [] })),
      close: vi.fn(async () => undefined),
    }));
    const { host } = createHost({
      env: { PATH: "C:\\npm-global" },
      platform: "win32",
      accessFile,
      createClient,
    });

    const state = await host.inspect();
    expect(state.codex).toEqual({ state: "ready", code: "codex-ready" });
    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({ command: "node", argsPrefix: [cliEntry] }),
    );
  });

  it("prefers codex.exe over the codex.cmd shim on Windows", async () => {
    const accessFile = vi.fn(async (candidate: string) => {
      if (candidate === "C:\\npm-global\\codex.exe") return;
      throw new Error("ENOENT");
    });
    const createClient = vi.fn(() => ({
      start: vi.fn(async () => ({})),
      readAccount: vi.fn(async () => ({ account: { type: "chatgpt" } })),
      listThreads: vi.fn(async () => ({ data: [] })),
      close: vi.fn(async () => undefined),
    }));
    const { host } = createHost({
      env: { PATH: "C:\\npm-global" },
      platform: "win32",
      accessFile,
      createClient,
    });

    const state = await host.inspect();
    expect(state.codex).toEqual({ state: "ready", code: "codex-ready" });
    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({ command: "C:\\npm-global\\codex.exe" }),
    );
  });

  it("hands the resolved prefix args to the managed adapter on start", async () => {
    const cliEntry = "C:\\npm-global\\node_modules\\@openai\\codex\\bin\\codex.js";
    const accessFile = vi.fn(async (candidate: string) => {
      if (candidate === "C:\\npm-global\\codex.cmd") return;
      if (candidate === cliEntry) return;
      if (candidate === "/app/live-mcp.js") return;
      throw new Error("ENOENT");
    });
    const adapter = { threadId: "thr_selected", close: vi.fn(async () => undefined) };
    const startAdapter = vi.fn(async () => adapter);
    const { host } = createHost({
      env: { PATH: "C:\\npm-global" },
      platform: "win32",
      accessFile,
      startAdapter,
    });

    await host.start({ provider: "codex", threadId: "thr_selected" });
    expect(startAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        codexCommand: "node",
        codexArgsPrefix: [cliEntry],
      }),
    );
  });
});
