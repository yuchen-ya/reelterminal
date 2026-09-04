import { describe, expect, it, vi } from "vitest";
import {
  ExternalConversationBridge,
} from "./conversation-bridge";
import { AGENT_WORK_MODE_SEMANTICS } from "./work-mode";
import {
  normalizeExternalConversationCapabilities,
  projectExternalAgentSessionUpdate,
} from "./conversation-protocol";
import {
  createConversationDisplayState,
  reduceConversationDisplayState,
} from "./conversation-state";
import type {
  ConversationAttachmentLease,
  ExternalAgentConnector,
  ExternalAgentNotification,
  ExternalAgentSessionUpdate,
  ExternalAgentTransport,
} from "./conversation-protocol";

class FakeTransport implements ExternalAgentTransport {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  readonly closed = vi.fn(async () => {});
  private readonly notificationListeners = new Set<
    (notification: ExternalAgentNotification) => void
  >();
  private readonly closeListeners = new Set<(error?: unknown) => void>();
  initializeResponse: unknown = {
    protocolVersion: 1,
    agentInfo: { name: "External Test Agent", version: "9.0.0" },
    sessionCapabilities: {
      resume: true,
      prompt: true,
      cancel: true,
      conversation: { formalReply: true },
    },
  };
  resumeResponse: unknown = {};
  promptResponse: unknown = { messageId: "agent-message-1" };
  requestError: unknown = null;

  async request<T>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (this.requestError) throw this.requestError;
    if (method === "initialize") return this.initializeResponse as T;
    if (method === "session/resume") return this.resumeResponse as T;
    if (method === "session/prompt") return this.promptResponse as T;
    return {} as T;
  }

  notify(method: string, params: unknown): void {
    this.notifications.push({ method, params });
  }

  onNotification(listener: (notification: ExternalAgentNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onClose(listener: (error?: unknown) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async close(): Promise<void> {
    await this.closed();
  }

  emit(notification: ExternalAgentNotification): void {
    for (const listener of this.notificationListeners) listener(notification);
  }

  remoteClose(error?: unknown): void {
    for (const listener of this.closeListeners) listener(error);
  }
}

class FakeLease implements ConversationAttachmentLease {
  currentValue: { connectionId: string; sessionId: string } | null = null;
  readonly releases: Array<{ connectionId: string; sessionId: string }> = [];
  acquire(connectionId: string, sessionId: string): boolean {
    if (this.currentValue) return false;
    this.currentValue = { connectionId, sessionId };
    return true;
  }
  release(connectionId: string, sessionId: string): void {
    if (
      this.currentValue?.connectionId === connectionId &&
      this.currentValue.sessionId === sessionId
    ) {
      this.releases.push({ connectionId, sessionId });
      this.currentValue = null;
    }
  }
  current(): { connectionId: string; sessionId: string } | null {
    return this.currentValue;
  }
}

function connectorFor(transport: FakeTransport): ExternalAgentConnector {
  return { connect: async () => transport };
}

function lifecycleStates(
  events: Array<{ type: string; state?: string }>,
): string[] {
  return events
    .filter((event) => event.type === "lifecycle")
    .map((event) => event.state ?? "");
}

describe("ExternalConversationBridge", () => {
  it("resumes the paired remote session and reports explicit ownership without provider state", async () => {
    const transport = new FakeTransport();
    const lease = new FakeLease();
    const events: Array<{ type: string; state?: string }> = [];
    const bridge = new ExternalConversationBridge({
      connector: connectorFor(transport),
      attachmentLease: lease,
      connectionId: () => "attachment-1",
      now: () => 100,
    });
    bridge.subscribe((event) => events.push(event));

    const state = await bridge.connect({
      sessionId: "agent-session-7",
      agentLabel: "Native agent",
    });

    expect(lifecycleStates(events)).toEqual([
      "pairing",
      "connecting",
      "resuming",
      "ready",
    ]);
    expect(transport.requests.map((request) => request.method)).toEqual([
      "initialize",
      "session/resume",
    ]);
    expect(transport.requests[0]?.params).toMatchObject({
      clientContext: {
        workMode: "collaborative",
        semantics: AGENT_WORK_MODE_SEMANTICS.collaborative,
      },
      clientCapabilities: {
        sessionUpdate: true,
        conversation: {
          formalReply: true,
          streaming: true,
          reasoningSummary: true,
          toolEvents: true,
          approval: true,
          usage: true,
          artifact: true,
          subtask: true,
        },
      },
    });
    expect(transport.requests[1]?.params).toEqual({
      sessionId: "agent-session-7",
      clientContext: {
        workMode: "collaborative",
        semantics: AGENT_WORK_MODE_SEMANTICS.collaborative,
      },
    });
    expect(state).toMatchObject({
      lifecycle: "ready",
      sessionId: "agent-session-7",
      connectionId: "attachment-1",
      agent: { name: "External Test Agent", version: "9.0.0" },
      ownership: {
        sessionOwner: "external-agent",
        attachmentOwner: "openreel-client",
      },
      fallback: null,
    });
    expect("provider" in state).toBe(false);
    expect("model" in state).toBe(false);
    expect(lease.current()).toEqual({
      connectionId: "attachment-1",
      sessionId: "agent-session-7",
    });
  });

  it("forwards prompts to the external session but never stores prompt text locally", async () => {
    const transport = new FakeTransport();
    const bridge = new ExternalConversationBridge({
      connector: connectorFor(transport),
      connectionId: () => "attachment-2",
    });
    const events: Array<{ type: string; phase?: string; update?: unknown }> = [];
    bridge.subscribe((event) => events.push(event));
    await bridge.connect({ sessionId: "agent-session-8" });

    const receipt = await bridge.prompt("Rewrite the selected caption");
    expect(receipt).toEqual({
      sessionId: "agent-session-8",
      messageId: "agent-message-1",
    });
    expect(transport.requests.at(-1)).toEqual({
      method: "session/prompt",
      params: {
        sessionId: "agent-session-8",
        prompt: [{ type: "text", text: "Rewrite the selected caption" }],
        clientContext: {
          workMode: "collaborative",
          semantics: AGENT_WORK_MODE_SEMANTICS.collaborative,
        },
      },
    });
    expect(JSON.stringify(bridge.getDisplayState())).not.toContain(
      "Rewrite the selected caption",
    );
    expect(events.filter((event) => event.type === "prompt").map((event) => event.phase)).toEqual([
      "submitted",
      "accepted",
    ]);

    transport.emit({
      method: "session/update",
      params: {
        sessionId: "agent-session-8",
        sequence: 3,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Done" },
        },
      },
    });
    expect(bridge.getDisplayState().updates).toHaveLength(1);
    expect(bridge.getDisplayState().updates[0]).toMatchObject({
      type: "session_update",
      remoteSequence: 3,
    });

    transport.emit({
      method: "session/update",
      params: {
        sessionId: "agent-session-8",
        sequence: 2,
        update: {
          sessionUpdate: "agent_message",
          content: [{ type: "text", text: "stale replay" }],
        },
      },
    });
    transport.emit({
      method: "session/update",
      params: {
        sessionId: "agent-session-8",
        sequence: 4,
        update: {
          sessionUpdate: "agent_message",
          content: [{ type: "text", text: "Final reply" }],
        },
      },
    });
    const updateEvents = bridge
      .getDisplayState()
      .updates.filter((event) => event.type === "session_update");
    expect(updateEvents.map((event) => event.remoteSequence)).toEqual([3, 4]);
    expect(JSON.stringify(updateEvents)).not.toContain("stale replay");
  });

  it("delivers cancel and work-mode notifications while a prompt is still in flight", async () => {
    const transport = new FakeTransport();
    let finishPrompt!: (value: unknown) => void;
    transport.promptResponse = new Promise((resolve) => {
      finishPrompt = resolve;
    });
    let workMode: "guided" | "collaborative" = "guided";
    const bridge = new ExternalConversationBridge({
      connector: connectorFor(transport),
      getWorkMode: () => workMode,
    });
    await bridge.connect({ sessionId: "agent-session-cancellable" });

    const pendingPrompt = bridge.prompt("Keep working until cancelled");
    await vi.waitFor(() => {
      expect(transport.requests.at(-1)?.method).toBe("session/prompt");
    });

    await bridge.cancel();
    workMode = "collaborative";
    await bridge.updateWorkMode();
    expect(transport.notifications).toEqual([
      {
        method: "session/cancel",
        params: { sessionId: "agent-session-cancellable" },
      },
      expect.objectContaining({
        method: "openreel/work_mode",
        params: expect.objectContaining({
          sessionId: "agent-session-cancellable",
          clientContext: expect.objectContaining({ workMode: "collaborative" }),
        }),
      }),
    ]);
    await expect(bridge.prompt("second prompt")).rejects.toMatchObject({
      code: "INVALID_STATE",
    });

    finishPrompt({ messageId: "after-cancel" });
    await expect(pendingPrompt).resolves.toEqual({
      sessionId: "agent-session-cancellable",
      messageId: "after-cancel",
    });
  });

  it("discards a prompt completion from an earlier attachment generation", async () => {
    const transport = new FakeTransport();
    let finishPrompt!: (value: unknown) => void;
    transport.promptResponse = new Promise((resolve) => {
      finishPrompt = resolve;
    });
    const bridge = new ExternalConversationBridge({
      connector: connectorFor(transport),
    });
    await bridge.connect({ sessionId: "old-session" });
    const oldPrompt = bridge.prompt("Old attachment turn");
    await vi.waitFor(() => {
      expect(transport.requests.at(-1)?.method).toBe("session/prompt");
    });

    await bridge.disconnect();
    await bridge.connect({ sessionId: "new-session" });
    finishPrompt({
      messageId: "stale-message",
      content: [{ type: "text", text: "must not cross generations" }],
    });

    await expect(oldPrompt).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(bridge.getDisplayState()).toMatchObject({
      lifecycle: "ready",
      sessionId: "new-session",
      updates: [],
    });
  });

  it("reports the current work mode on attach, change notification, and the next prompt", async () => {
    const transport = new FakeTransport();
    let workMode: "guided" | "collaborative" | "autonomous" = "guided";
    const bridge = new ExternalConversationBridge({
      connector: connectorFor(transport),
      getWorkMode: () => workMode,
    });
    await bridge.connect({ sessionId: "agent-session-mode" });
    expect(transport.requests[0]?.params).toMatchObject({
      clientContext: { workMode: "guided" },
    });

    workMode = "autonomous";
    await bridge.updateWorkMode();
    expect(transport.notifications.at(-1)).toMatchObject({
      method: "openreel/work_mode",
      params: {
        sessionId: "agent-session-mode",
        clientContext: { workMode: "autonomous" },
      },
    });

    await bridge.prompt("Continue");
    expect(transport.requests.at(-1)?.params).toMatchObject({
      clientContext: { workMode: "autonomous" },
    });
  });

  it("projects a direct formal reply into memory without making ReelTerminal the history owner", async () => {
    const transport = new FakeTransport();
    transport.promptResponse = {
      messageId: "agent-message-direct",
      content: [{ type: "text", text: "The caption is ready" }],
      provider: "should-not-cross-the-boundary",
    };
    const bridge = new ExternalConversationBridge({
      connector: connectorFor(transport),
      connectionId: () => "attachment-direct",
    });
    await bridge.connect({ sessionId: "agent-session-direct" });
    await bridge.prompt("secret prompt");

    const state = bridge.getDisplayState();
    expect(state.updates.at(-1)).toMatchObject({
      type: "session_update",
      update: {
        sessionUpdate: "agent_message",
        messageId: "agent-message-direct",
        content: [{ type: "text", text: "The caption is ready" }],
      },
    });
    expect(JSON.stringify(state)).not.toContain("secret prompt");
    expect(JSON.stringify(state)).not.toContain("should-not-cross-the-boundary");
  });

  it("projects safe optional updates and ignores namespaced extension payloads", async () => {
    const transport = new FakeTransport();
    const bridge = new ExternalConversationBridge({
      connector: connectorFor(transport),
      connectionId: () => "attachment-updates",
    });
    await bridge.connect({ sessionId: "agent-session-updates" });
    const emit = (update: Record<string, unknown>) => {
      transport.emit({
        method: "session/update",
        params: { sessionId: "agent-session-updates", update },
      });
    };

    emit({
      sessionUpdate: "reasoning_summary",
      summary: "Comparing the selected clips",
      reasoningTrace: "must never be copied",
    });
    emit({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Read timeline",
      status: "running",
      summary: "Inspecting the selected range",
      arguments: { secret: "raw arguments must never be copied" },
    });
    emit({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      summary: "Timeline inspected",
      output: "raw tool output must never be copied",
    });
    emit({
      sessionUpdate: "tool_result",
      toolCallId: "tool-1",
      status: "completed",
      summary: "No changes required",
      result: "raw result must never be copied",
    });
    emit({
      sessionUpdate: "approval_request",
      requestId: "approval-1",
      title: "Apply edit",
      summary: "The agent requests permission",
      options: [
        { id: "approve", label: "Apply" , raw: "ignored" },
        { id: "deny", label: "Skip" },
      ],
    });
    emit({
      sessionUpdate: "approval_resolution",
      requestId: "approval-1",
      outcome: "rejected",
      summary: "User chose skip",
    });
    emit({
      sessionUpdate: "usage",
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      model: "must-not-cross-the-boundary",
    });
    emit({
      sessionUpdate: "artifact",
      artifactId: "artifact-1",
      kind: "preview",
      label: "Preview",
      mimeType: "image/png",
      sizeBytes: 42,
      path: "/private/secret",
    });
    emit({
      sessionUpdate: "subtask",
      subtaskId: "subtask-1",
      title: "Render preview",
      status: "running",
      summary: "Rendering locally",
      secret: "ignored",
    });
    emit({
      sessionUpdate: "_vendor/raw_trace",
      secret: "namespaced extensions are ignored",
    });

    await bridge.resolveApproval("approval-1", "denied");
    expect(transport.requests.at(-1)).toEqual({
      method: "session/approval",
      params: {
        sessionId: "agent-session-updates",
        requestId: "approval-1",
        decision: "denied",
      },
    });
    const state = bridge.getDisplayState();
    expect(state.updates.map((event) =>
      event.type === "session_update" ? event.update.sessionUpdate : event.type,
    )).toEqual([
      "reasoning_summary",
      "tool_call",
      "tool_call_update",
      "tool_result",
      "approval_request",
      "approval_resolution",
      "usage",
      "artifact",
      "subtask",
    ]);
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain("raw arguments");
    expect(serialized).not.toContain("raw tool output");
    expect(serialized).not.toContain("raw result");
    expect(serialized).not.toContain("raw_trace");
    expect(serialized).not.toContain("must-not-cross-the-boundary");
    expect(serialized).not.toContain("/private/secret");
    expect(state.updates.at(4)).toMatchObject({
      type: "session_update",
      update: {
        sessionUpdate: "approval_request",
        options: [{ id: "approve", label: "Apply" }, { id: "deny", label: "Skip" }],
      },
    });
  });

  it("gates optional updates by negotiated capabilities while retaining the formal base tier", async () => {
    const transport = new FakeTransport();
    transport.initializeResponse = {
      protocolVersion: 1,
      sessionCapabilities: {
        resume: true,
        prompt: true,
        cancel: true,
        conversation: {
          formalReply: true,
          streaming: false,
          reasoningSummary: false,
          toolEvents: false,
          approval: false,
          usage: false,
          artifact: false,
          subtask: false,
        },
      },
    };
    const bridge = new ExternalConversationBridge({
      connector: connectorFor(transport),
      connectionId: () => "attachment-capabilities",
    });
    const state = await bridge.connect({ sessionId: "agent-session-capabilities" });
    expect(state.capabilities).toEqual({
      formalReply: "supported",
      streaming: "unsupported",
      reasoningSummary: "unsupported",
      toolEvents: "unsupported",
      approval: "unsupported",
      usage: "unsupported",
      artifact: "unsupported",
      subtask: "unsupported",
    });
    transport.emit({
      method: "session/update",
      params: {
        sessionId: "agent-session-capabilities",
        update: {
          sessionUpdate: "agent_message",
          content: [{ type: "text", text: "formal reply" }],
        },
      },
    });
    transport.emit({
      method: "session/update",
      params: {
        sessionId: "agent-session-capabilities",
        update: {
          sessionUpdate: "reasoning_summary",
          summary: "should be gated",
        },
      },
    });
    transport.emit({
      method: "session/update",
      params: {
        sessionId: "agent-session-capabilities",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tool-gated",
        },
      },
    });
    expect(bridge.getDisplayState().updates).toHaveLength(1);
    expect(JSON.stringify(bridge.getDisplayState())).toContain("formal reply");
    await expect(bridge.resolveApproval("approval-gated", "approved")).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    expect(transport.requests.map((request) => request.method)).not.toContain("session/approval");
  });

  it("ignores updates for another remote session and bounds display memory", async () => {
    const transport = new FakeTransport();
    const bridge = new ExternalConversationBridge({
      connector: connectorFor(transport),
      connectionId: () => "attachment-3",
      displayLimit: 2,
    });
    await bridge.connect({ sessionId: "agent-session-9" });
    for (const text of ["one", "two", "three"]) {
      transport.emit({
        method: "session/update",
        params: {
          sessionId: "agent-session-9",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        },
      });
    }
    transport.emit({
      method: "session/update",
      params: {
        sessionId: "other-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "foreign" },
        },
      },
    });
    expect(bridge.getDisplayState().updates).toHaveLength(2);
    expect(JSON.stringify(bridge.getDisplayState())).not.toContain("foreign");
    expect(JSON.stringify(bridge.getDisplayState())).not.toContain("one");
    expect(JSON.stringify(bridge.getDisplayState())).toContain("three");
  });

  it("rejects an adapter that does not explicitly advertise the basic tier", async () => {
    const transport = new FakeTransport();
    transport.initializeResponse = {
      protocolVersion: 1,
      sessionCapabilities: {},
    };
    const bridge = new ExternalConversationBridge({
      connector: connectorFor(transport),
    });

    const state = await bridge.connect({ sessionId: "agent-session-implicit" });
    expect(state).toMatchObject({
      lifecycle: "unsupported",
      fallback: "mcp-only",
      lastError: { code: "UNSUPPORTED" },
    });
    expect(transport.requests.map((request) => request.method)).not.toContain(
      "session/resume",
    );
  });

  it("does not infer formal replies from the three basic method booleans", async () => {
    const transport = new FakeTransport();
    transport.initializeResponse = {
      protocolVersion: 1,
      sessionCapabilities: {
        resume: true,
        prompt: true,
        cancel: true,
      },
    };
    const bridge = new ExternalConversationBridge({
      connector: connectorFor(transport),
    });

    const state = await bridge.connect({ sessionId: "agent-session-no-reply" });
    expect(state).toMatchObject({
      lifecycle: "unsupported",
      fallback: "mcp-only",
      capabilities: { formalReply: "unknown" },
    });
  });

  it("falls back to native MCP-only use when ACP resume is unsupported and releases the lease", async () => {
    const transport = new FakeTransport();
    transport.requestError = Object.assign(new Error("method not found"), {
      code: -32601,
    });
    const lease = new FakeLease();
    const released = vi.fn();
    const bridge = new ExternalConversationBridge({
      connector: connectorFor(transport),
      attachmentLease: lease,
      connectionId: () => "attachment-4",
      onAttachmentReleased: released,
    });

    const state = await bridge.connect({ sessionId: "agent-session-10" });
    expect(state.lifecycle).toBe("unsupported");
    expect(state.fallback).toBe("mcp-only");
    expect(state.lastError?.code).toBe("UNSUPPORTED");
    expect(lease.current()).toBeNull();
    expect(released).toHaveBeenCalledOnce();
    expect(transport.closed).toHaveBeenCalledOnce();
    await expect(bridge.prompt("hello")).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
  });

  it("disconnects the view without closing the remote conversation and releases ownership", async () => {
    const transport = new FakeTransport();
    const lease = new FakeLease();
    const released: Array<{ reason: string; sessionId: string }> = [];
    const bridge = new ExternalConversationBridge({
      connector: connectorFor(transport),
      attachmentLease: lease,
      connectionId: () => "attachment-5",
      onAttachmentReleased: (ownership, reason) => {
        released.push({ reason, sessionId: ownership.sessionId });
      },
    });
    await bridge.connect({ sessionId: "agent-session-11" });
    await bridge.disconnect("user");

    expect(transport.closed).toHaveBeenCalledOnce();
    expect(transport.requests.map((request) => request.method)).not.toContain(
      "session/close",
    );
    expect(lease.current()).toBeNull();
    expect(released).toEqual([{ reason: "user", sessionId: "agent-session-11" }]);
    expect(bridge.getDisplayState()).toMatchObject({
      lifecycle: "disconnected",
      connectionId: null,
      sessionId: "agent-session-11",
      ownership: null,
      fallback: null,
    });
  });

  it("releases ownership when the remote transport closes and emits a monotonic lifecycle sequence", async () => {
    const transport = new FakeTransport();
    const lease = new FakeLease();
    const bridge = new ExternalConversationBridge({
      connector: connectorFor(transport),
      attachmentLease: lease,
      connectionId: () => "attachment-6",
    });
    const events: Array<{ sequence: number; type: string; state?: string }> = [];
    bridge.subscribe((event) => events.push(event));
    await bridge.connect({ sessionId: "agent-session-12" });
    transport.remoteClose(new Error("agent exited"));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(lease.current()).toBeNull();
    expect(bridge.getDisplayState()).toMatchObject({
      lifecycle: "disconnected",
      ownership: null,
      lastError: { code: "TRANSPORT" },
    });
    expect(events.map((event) => event.sequence)).toEqual(
      [...events].map((event) => event.sequence).sort((a, b) => a - b),
    );
    expect(events.at(-1)).toMatchObject({
      type: "lifecycle",
      state: "disconnected",
    });
  });

  it("uses ACP session/cancel as a notification and does not expose a local tool loop", async () => {
    const transport = new FakeTransport();
    const bridge = new ExternalConversationBridge({
      connector: connectorFor(transport),
      connectionId: () => "attachment-7",
    });
    await bridge.connect({ sessionId: "agent-session-13" });
    await bridge.cancel();

    expect(transport.notifications).toEqual([
      {
        method: "session/cancel",
        params: { sessionId: "agent-session-13" },
      },
    ]);
    expect(JSON.stringify(bridge.getDisplayState())).not.toContain("toolLoop");
  });

  it("rejects a second local attachment without contacting the connector", async () => {
    const firstTransport = new FakeTransport();
    const secondTransport = new FakeTransport();
    const lease = new FakeLease();
    const first = new ExternalConversationBridge({
      connector: connectorFor(firstTransport),
      attachmentLease: lease,
      connectionId: () => "attachment-a",
    });
    const secondConnector = vi.fn(async () => secondTransport);
    const second = new ExternalConversationBridge({
      connector: { connect: secondConnector },
      attachmentLease: lease,
      connectionId: () => "attachment-b",
    });
    await first.connect({ sessionId: "agent-session-14" });
    await expect(second.connect({ sessionId: "agent-session-15" })).rejects.toMatchObject({
      code: "LEASE_UNAVAILABLE",
    });
    expect(secondConnector).not.toHaveBeenCalled();
  });

  it("rejects an empty pairing before invoking a connector", async () => {
    const connector = vi.fn(async () => new FakeTransport());
    const bridge = new ExternalConversationBridge({ connector: { connect: connector } });
    await expect(bridge.connect({ sessionId: "  " })).rejects.toMatchObject({
      code: "INVALID_PAIRING",
    });
    expect(connector).not.toHaveBeenCalled();
  });
});

describe("conversation display state reducer", () => {
  it("normalizes capability tiers and safely projects without mutating the wire value", () => {
    expect(normalizeExternalConversationCapabilities({
      formalReply: true,
      streaming: false,
    })).toEqual({
      formalReply: "supported",
      streaming: "unsupported",
      reasoningSummary: "unknown",
      toolEvents: "unknown",
      approval: "unknown",
      usage: "unknown",
      artifact: "unknown",
      subtask: "unknown",
    });
    const wire = {
      sessionUpdate: "tool_call",
      toolCallId: "tool-pure",
      title: "Inspect",
      arguments: { secret: "do not retain" },
    } as const;
    const projected = projectExternalAgentSessionUpdate(wire);
    expect(projected).toEqual({
      sessionUpdate: "tool_call",
      toolCallId: "tool-pure",
      title: "Inspect",
    });
    expect(wire).toEqual({
      sessionUpdate: "tool_call",
      toolCallId: "tool-pure",
      title: "Inspect",
      arguments: { secret: "do not retain" },
    });
    expect(projectExternalAgentSessionUpdate({
      sessionUpdate: "_vendor/extension",
      secret: "ignored",
    })).toBeNull();

    const previous = createConversationDisplayState();
    const reduced = reduceConversationDisplayState(previous, {
      type: "session_update",
      sequence: 1,
      occurredAt: 1,
      connectionId: "attachment",
      sessionId: "session",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-reduced",
        arguments: { secret: "must be removed by the reducer" },
      } as unknown as ExternalAgentSessionUpdate,
    }, 2);
    expect(reduced.updates[0]).toMatchObject({
      type: "session_update",
      update: { sessionUpdate: "tool_call", toolCallId: "tool-reduced" },
    });
    expect(JSON.stringify(reduced)).not.toContain("must be removed");
    expect(previous.updates).toHaveLength(0);
  });

  it("does not make prompts part of the display history", async () => {
    const transport = new FakeTransport();
    const bridge = new ExternalConversationBridge({
      connector: connectorFor(transport),
      connectionId: () => "attachment-state",
    });
    await bridge.connect({ sessionId: "agent-session-state" });
    await bridge.prompt("secret prompt should not persist");
    const state = bridge.getDisplayState();
    expect(state.updates.every((event) => event.type !== "prompt")).toBe(true);
  });
});
