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
      sessionEvent(8, { sessionUpdate: "artifact", artifactId: "artifact-1", label: "Title preview", status: "available" }),
      sessionEvent(9, { sessionUpdate: "subtask", subtaskId: "subtask-1", title: "Render preview", status: "running", summary: "Rendering" }),
      sessionEvent(10, { sessionUpdate: "plan", entries: [{ content: "Add a title", status: "completed" }] }),
      sessionEvent(11, { sessionUpdate: "usage", inputTokens: 3, outputTokens: 5, totalTokens: 8 }),
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

    const message = viewModel.activities.find((activity) => activity.type === "agent_message");
    expect(message).toMatchObject({ id: "a1", text: "First the timeline.", sequence: 3, streaming: false });
  });
});
