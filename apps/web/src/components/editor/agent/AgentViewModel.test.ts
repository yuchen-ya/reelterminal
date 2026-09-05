import type {
  ExternalAgentSessionUpdate,
  ExternalConversationDisplayState,
  ExternalConversationEvent,
} from "@openreel/agent-facade";
import { describe, expect, it } from "vitest";
import { conversationViewModelFromProtocol } from "./AgentViewModel";

function sessionEvent(sequence: number, update: ExternalAgentSessionUpdate): ExternalConversationEvent {
  return {
    type: "session_update",
    sequence,
    occurredAt: sequence,
    connectionId: "connection-1",
    sessionId: "session-1",
    update,
  };
}

describe("conversationViewModelFromProtocol", () => {
  it("keeps chronological activity positions while merging streamed updates", () => {
    const updates = [
      sessionEvent(1, { sessionUpdate: "user_message", messageId: "u1", content: [{ type: "text", text: "Make a title" }] }),
      sessionEvent(2, { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Add title", status: "pending" }),
      sessionEvent(3, { sessionUpdate: "agent_message_chunk", messageId: "a1", content: { type: "text", text: "First " } }),
      sessionEvent(4, { sessionUpdate: "reasoning_summary", summary: "Preparing the requested edit" }),
      sessionEvent(5, { sessionUpdate: "approval_request", requestId: "approval-1", title: "Apply edit?", summary: "The timeline will change." }),
      sessionEvent(6, { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "running", summary: "Editing timeline" }),
      sessionEvent(7, { sessionUpdate: "agent_message_chunk", messageId: "a1", content: { type: "text", text: "the timeline." } }),
      sessionEvent(8, { sessionUpdate: "artifact", artifactId: "artifact-1", label: "Title preview", kind: "contact_sheet", mimeType: "image/png", status: "available" }),
      sessionEvent(9, { sessionUpdate: "subtask", subtaskId: "subtask-1", title: "Render preview", status: "running", summary: "Rendering" }),
      sessionEvent(10, { sessionUpdate: "plan", entries: [{ content: "Add a title", status: "completed" }] }),
      sessionEvent(11, {
        sessionUpdate: "usage",
        inputTokens: 3,
        cachedInputTokens: 2,
        outputTokens: 5,
        reasoningOutputTokens: 1,
        totalTokens: 8,
        turnTotalTokens: 8,
        currentContextTokens: 3,
      }),
      sessionEvent(12, { sessionUpdate: "tool_result", toolCallId: "tool-1", status: "completed", summary: "Timeline updated" }),
      sessionEvent(13, { sessionUpdate: "approval_resolution", requestId: "approval-1", outcome: "approved", summary: "Approved by you" }),
      sessionEvent(14, { sessionUpdate: "agent_message", messageId: "a1", content: [{ type: "text", text: "First the timeline." }] }),
      sessionEvent(15, { sessionUpdate: "state_update", state: "idle" }),
    ];
    const state = {
      lifecycle: "ready",
      connectionId: "connection-1",
      sessionId: "session-1",
      agent: { name: "Remote editor" },
      capabilities: {
        formalReply: "supported",
        streaming: "supported",
        reasoningSummary: "supported",
        toolEvents: "supported",
        approval: "supported",
        usage: "supported",
        artifact: "supported",
        subtask: "supported",
      },
      ownership: null,
      fallback: null,
      lastError: null,
      updates,
      lastEventSequence: 15,
    } satisfies ExternalConversationDisplayState;

    const viewModel = conversationViewModelFromProtocol(state);
    expect(viewModel.activities.map((activity) => activity.type)).toEqual([
      "user_message",
      "tool",
      "agent_message",
      "reasoning_summary",
      "approval",
      "artifact",
      "subtask",
      "plan",
      "usage",
      "state",
    ]);

    const tool = viewModel.activities.find((activity) => activity.type === "tool");
    expect(tool).toMatchObject({ id: "tool-1", phase: "result", status: "completed", sequence: 2 });
    expect(tool).not.toHaveProperty("args");
    expect(tool).not.toHaveProperty("result");

    const approval = viewModel.activities.find((activity) => activity.type === "approval");
    expect(approval).toMatchObject({ id: "approval-1", phase: "resolution", status: "approved", sequence: 5 });

    const artifact = viewModel.activities.find((activity) => activity.type === "artifact");
    expect(artifact).toMatchObject({
      id: "artifact-1",
      kind: "contact_sheet",
      mimeType: "image/png",
      status: "available",
    });
    const usage = viewModel.activities.find((activity) => activity.type === "usage");
    expect(usage).toMatchObject({
      cachedInputTokens: 2,
      reasoningOutputTokens: 1,
      turnTotalTokens: 8,
      currentContextTokens: 3,
    });

    const message = viewModel.activities.find((activity) => activity.type === "agent_message");
    expect(message).toMatchObject({ id: "a1", text: "First the timeline.", sequence: 3, streaming: false });
  });

  it("projects visual artifact fields through an allowlist", () => {
    const frames = Array.from({ length: 20 }, (_, index) => ({
      previewId: `frame-${index}`,
      timecodeSeconds: index,
      label: `Frame ${index + 1}`,
      path: `/Users/private/frame-${index}.png`,
      url: "file:///Users/private/frame.png",
      rawPayload: { pixels: [1, 2, 3] },
    }));
    const maliciousUpdate = {
      sessionUpdate: "artifact",
      artifactId: "/Users/private/contact-sheet.png",
      label: "/Users/private/contact-sheet.png",
      kind: "file:///private/contact-sheet",
      mimeType: "image/png",
      status: "available",
      preview: {
        previewId: "preview-safe",
        timecodeSeconds: 2.25,
        path: "/Users/private/contact-sheet.png",
        url: "file:///Users/private/contact-sheet.png",
        rawPayload: { bytes: "not-for-ui" },
        frames,
      },
    } as unknown as ExternalAgentSessionUpdate;
    const state = {
      lifecycle: "ready",
      connectionId: "connection-1",
      sessionId: "session-1",
      agent: { name: "Remote editor" },
      capabilities: {
        formalReply: "supported",
        streaming: "supported",
        reasoningSummary: "supported",
        toolEvents: "supported",
        approval: "supported",
        usage: "supported",
        artifact: "supported",
        subtask: "supported",
      },
      ownership: null,
      fallback: null,
      lastError: null,
      updates: [sessionEvent(1, maliciousUpdate)],
      lastEventSequence: 1,
    } satisfies ExternalConversationDisplayState;

    const artifact = conversationViewModelFromProtocol(state).activities.find(
      (activity) => activity.type === "artifact",
    );
    expect(artifact).toMatchObject({
      id: "artifact-1",
      label: "",
      mimeType: "image/png",
      status: "available",
    });
    expect(artifact).not.toHaveProperty("path");
    expect(artifact).not.toHaveProperty("url");
    expect(artifact).not.toHaveProperty("rawPayload");
    if (artifact?.type !== "artifact" || !artifact.preview) throw new Error("expected projected preview");
    expect(Object.keys(artifact.preview).sort()).toEqual(["frames", "previewId", "timecodeSeconds"]);
    expect(artifact.preview).toEqual({
      previewId: "preview-safe",
      timecodeSeconds: 2.25,
      frames: frames.slice(0, 12).map((frame) => ({
        previewId: frame.previewId,
        timecodeSeconds: frame.timecodeSeconds,
        label: frame.label,
      })),
    });
    expect(artifact.preview).not.toHaveProperty("path");
    expect(artifact.preview).not.toHaveProperty("url");
    expect(artifact.preview).not.toHaveProperty("rawPayload");
    expect(artifact.preview.frames).toHaveLength(12);
    expect(artifact.preview.frames?.[0]).not.toHaveProperty("path");
    expect(artifact.preview.frames?.[0]).not.toHaveProperty("url");
  });
});
