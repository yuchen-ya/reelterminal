import { describe, it, expect, vi } from "vitest";
import { HeadlessHost } from "./headless-host";
import { runTurn } from "./loop";
import { MockLLMClient } from "./llm";
import type { LLMResponse, LoopMessage } from "./llm";
import { toAnthropicTools } from "./registry";
import { makeProjectWithClip } from "./test-fixtures";
import type { ToolExecutor } from "./loop";
import type { EditingHost } from "./host";
import type { ToolCall, ToolResult } from "./types";

const tools = toAnthropicTools();
const userMsg = (content: string): LoopMessage[] => [{ role: "user", content }];

type ExecutorCall = [string, Record<string, unknown> | undefined, EditingHost];

function recordingExecutor(
  result: ToolResult,
): { executor: ToolExecutor; calls: ExecutorCall[] } {
  const calls: ExecutorCall[] = [];
  const executor: ToolExecutor = async (name, args, host) => {
    calls.push([name, args, host]);
    return result;
  };
  return { executor, calls };
}

describe("runTurn injectable executor + gating (ADR 0004 Decision 8)", () => {
  it("uses the injected executor instead of the registry's executeTool", async () => {
    const host = new HeadlessHost(makeProjectWithClip());
    const script: LLMResponse[] = [
      {
        text: "",
        stopReason: "tool_use",
        toolUses: [{ id: "t1", name: "edit_apply", input: { ops: [] } }],
      },
      { text: "Done.", stopReason: "end_turn", toolUses: [] },
    ];
    const { executor, calls } = recordingExecutor({
      ok: true,
      summary: "Applied 0 edits (revision 3)",
      data: { revision: 3, affectedIds: [] },
    });

    const result = await runTurn({
      host,
      llm: new MockLLMClient(script),
      tools,
      messages: userMsg("noop edit"),
      executor,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("edit_apply");
    expect(calls[0][1]).toEqual({ ops: [] });
    expect(calls[0][2]).toBe(host);
    expect(result.stoppedReason).toBe("end_turn");
    expect(result.committed).toBe(true);
    // The registry executor would have rejected the unknown tool; the injected
    // one drove the result instead.
    expect(result.text).toBe("Done.");
  });

  it("honors injected gating for confirmations and dry-run", async () => {
    const host = new HeadlessHost(makeProjectWithClip());
    const script: LLMResponse[] = [
      {
        text: "",
        stopReason: "tool_use",
        toolUses: [
          { id: "t1", name: "edit_apply", input: { ops: [] } },
          { id: "t2", name: "export_start", input: {} },
        ],
      },
      { text: "Done.", stopReason: "end_turn", toolUses: [] },
    ];
    const { executor, calls } = recordingExecutor({ ok: true, summary: "ok" });
    const gating = {
      isReadOnly: (name: string) => name === "editor_get_context",
      isDestructive: () => false,
      isExpensive: (name: string) => name === "export_start",
    };
    const confirmGate = vi.fn((_call: ToolCall) => "approve" as const);

    const result = await runTurn({
      host,
      llm: new MockLLMClient(script),
      tools,
      messages: userMsg("edit and export"),
      executor,
      gating,
      confirmGate,
    });

    // export_start is expensive under the injected gating → confirm asked once;
    // edit_apply is not destructive → no confirm for it.
    expect(confirmGate).toHaveBeenCalledOnce();
    expect(confirmGate.mock.calls[0][0].name).toBe("export_start");
    expect(calls).toHaveLength(2);
    expect(result.toolCalls).toBe(2);
  });

  it("dry-run skips non-read-only calls per injected gating", async () => {
    const host = new HeadlessHost(makeProjectWithClip());
    const script: LLMResponse[] = [
      {
        text: "",
        stopReason: "tool_use",
        toolUses: [
          { id: "t1", name: "editor_get_context", input: {} },
          { id: "t2", name: "edit_apply", input: { ops: [] } },
        ],
      },
      { text: "Planned.", stopReason: "end_turn", toolUses: [] },
    ];
    const { executor, calls } = recordingExecutor({ ok: true, summary: "ok" });
    const gating = {
      isReadOnly: (name: string) => name === "editor_get_context",
      isDestructive: () => false,
      isExpensive: () => false,
    };

    const result = await runTurn({
      host,
      llm: new MockLLMClient(script),
      tools,
      messages: userMsg("plan only"),
      executor,
      gating,
      dryRun: true,
    });

    // Read-only call still executes in dry-run; the write call is faked.
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("editor_get_context");
    expect(result.committed).toBe(true);
  });
});
