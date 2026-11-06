import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import type { TaskTextReviewUnit } from "../../../../../desktop/src/shared/task-review";
import { EditScene } from "./EditScene";
import type { DraftEntry } from "./useTaskDrafts";
import { createFakeTaskAgentBridge, grantFor } from "./testing";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
});

const unit: TaskTextReviewUnit = {
  id: "unit-1",
  sourceVersionId: "source-1",
  ordinal: 3,
  text: "原始台词内容，不允许被覆盖。",
  startLine: 3,
  endLine: 3,
};

/** Stateful harness so the controlled textarea follows draft updates. */
function setup(draftText = "") {
  const agent = createFakeTaskAgentBridge();
  const updates: {
    text?: string;
    selectionStart?: number;
    selectionEnd?: number;
  }[] = [];
  const initial: DraftEntry = {
    sourceVersionId: "source-1",
    text: draftText,
    selectionStart: draftText.length,
    selectionEnd: draftText.length,
    savedText: draftText || null,
    status: "saved",
    error: null,
  };
  // Lets a test change the draft the way non-typing paths do (for example the
  // issue-option buttons writing through onUpdateDraft directly).
  const applyPatchRef: { current: ((patch: Partial<DraftEntry>) => void) | null } = { current: null };
  function Harness() {
    const [draft, setDraft] = useState(initial);
    applyPatchRef.current = (patch) => setDraft((current) => ({ ...current, ...patch }));
    return (
      <EditScene
        unit={unit}
        root="task-root"
        taskId="task-1"
        agent={agent}
        agentState={{ grant: grantFor(), jobs: [] }}
        draft={draft}
        onUpdateDraft={(patch) => {
          updates.push(patch);
          setDraft((current) => ({ ...current, ...patch }));
        }}
        onBackToReview={vi.fn()}
      />
    );
  }
  render(<Harness />);
  return { agent, updates, patchDraft: (patch: Partial<DraftEntry>) => applyPatchRef.current!(patch) };
}

describe("edit scene completion", () => {
  it("debounces typing and cancels stale candidates without changing the input", async () => {
    vi.useFakeTimers();
    const { agent } = setup("已有反馈");
    const cancel = vi.spyOn(agent, "cancelCompletion");
    const input = screen.getByTestId("task-review-edit-input") as HTMLTextAreaElement;
    await act(async () => {});
    fireEvent.change(input, { target: { value: "第一轮输入", selectionStart: 2, selectionEnd: 2 } });
    await act(async () => { await vi.advanceTimersByTimeAsync(999); });
    expect(agent.completeRequests).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(agent.completeRequests).toHaveLength(1);
    const oldGeneration = expectGenerationOf(agent);
    fireEvent.change(input, { target: { value: "用户继续输入", selectionStart: 3, selectionEnd: 3 } });
    expect(cancel).toHaveBeenCalledWith({ taskId: "task-1", generationId: oldGeneration });
    act(() => agent.emit({ taskId: "task-1", unitId: "unit-1", generationId: oldGeneration, delta: "过期文本", done: true }));
    expect(screen.queryByTestId("task-review-suggestion")).toBeNull();
    expect(input.value).toBe("用户继续输入");
    expect([input.selectionStart, input.selectionEnd]).toEqual([3, 3]);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(agent.completeRequests.at(-1)?.text).toBe("用户继续输入");
  });

  it("waits until real IME composition finishes before automatically requesting", async () => {
    vi.useFakeTimers();
    const { agent } = setup();
    const input = screen.getByTestId("task-review-edit-input") as HTMLTextAreaElement;
    await act(async () => {});
    input.focus();
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "中文输入中" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(agent.completeRequests).toHaveLength(0);
    expect(document.activeElement).toBe(input);
    fireEvent.compositionEnd(input);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(agent.completeRequests).toHaveLength(1);
    expect(agent.completeRequests[0]?.text).toBe("中文输入中");
    expect(document.activeElement).toBe(input);
  });
  it("streams a completion for the active generation only", async () => {
    const { agent } = setup("人工反馈");
    fireEvent.click(screen.getByTestId("task-review-complete-request"));
    await waitFor(() =>
      expect(agent.emit).toBeTruthy(),
    );
    const running = screen.getByTestId("task-review-complete-status").textContent;
    expect(running).toContain("正在生成");
    // A stale generation never replaces the newer request.
    agent.emit({
      taskId: "task-1",
      unitId: "unit-1",
      generationId: "stale-generation",
      delta: "过时建议",
      done: false,
    });
    expect(screen.getByTestId("task-review-suggestion").textContent).not.toContain("过时建议");
  });

  it("defers streaming updates during IME composition and never disturbs the input", async () => {
    const { agent } = setup("正在打字");
    const input = screen.getByTestId("task-review-edit-input") as HTMLTextAreaElement;
    input.focus();
    fireEvent.click(screen.getByTestId("task-review-complete-request"));
    // The reviewer starts a Chinese IME composition.
    fireEvent.compositionStart(input);
    expect(document.activeElement).toBe(input);
    agent.emit({
      taskId: "task-1",
      unitId: "unit-1",
      generationId: expectGenerationOf(agent),
      delta: "流式增量",
      done: false,
    });
    // Composition active: neither the input nor the suggestion is updated.
    expect(input.value).toBe("正在打字");
    expect(screen.getByTestId("task-review-suggestion").textContent).not.toContain("流式增量");
    expect(document.activeElement).toBe(input);
    fireEvent.compositionEnd(input);
    await waitFor(() =>
      expect(screen.getByTestId("task-review-suggestion").textContent).toContain("流式增量"),
    );
    expect(input.value).toBe("正在打字");
    expect(document.activeElement).toBe(input);
  });

  it("adopts the whole suggestion as an insertion without overwriting the original", async () => {
    const { agent, updates } = setup("已有反馈");
    fireEvent.click(screen.getByTestId("task-review-complete-request"));
    const generationId = expectGenerationOf(agent);
    agent.emit({ taskId: "task-1", unitId: "unit-1", generationId, delta: "AI建议内容", done: false });
    agent.emit({ taskId: "task-1", unitId: "unit-1", generationId, delta: "", done: true });
    await waitFor(() =>
      expect(screen.getByTestId("task-review-suggestion").textContent).toContain("AI建议内容"),
    );
    fireEvent.click(screen.getByTestId("task-review-adopt-all"));
    expect(updates.at(-1)?.text).toBe("已有反馈AI建议内容");
    // The immutable original stays untouched.
    expect(screen.getByTestId("task-review-edit-original").textContent).toBe(unit.text);
  });

  it("adopts only the selected part of a suggestion", async () => {
    const { agent, updates } = setup("");
    fireEvent.click(screen.getByTestId("task-review-complete-request"));
    const generationId = expectGenerationOf(agent);
    agent.emit({ taskId: "task-1", unitId: "unit-1", generationId, delta: "前半段后半段", done: true });
    const suggestion = screen.getByTestId("task-review-suggestion");
    await waitFor(() => expect(suggestion.textContent).toContain("前半段后半段"));
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(suggestion.firstChild!, 0);
    range.setEnd(suggestion.firstChild!, 3);
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.click(screen.getByTestId("task-review-adopt-selection"));
    expect(updates.at(-1)?.text).toBe("前半段");
  });

  it("shows the completion error without clearing the draft", async () => {
    const { agent } = setup("保留我的输入");
    fireEvent.click(screen.getByTestId("task-review-complete-request"));
    const generationId = expectGenerationOf(agent);
    agent.emit({
      taskId: "task-1",
      unitId: "unit-1",
      generationId,
      delta: "",
      done: true,
      error: "模型暂不可用",
    });
    await waitFor(() =>
      expect(screen.getByTestId("task-review-complete-status").textContent).toContain("模型暂不可用"),
    );
    expect((screen.getByTestId("task-review-edit-input") as HTMLTextAreaElement).value).toBe("保留我的输入");
  });

  it("cancels the in-flight generation the moment IME input changes the draft", async () => {
    const { agent } = setup("正在输入");
    const cancel = vi.spyOn(agent, "cancelCompletion");
    const input = screen.getByTestId("task-review-edit-input") as HTMLTextAreaElement;
    fireEvent.click(screen.getByTestId("task-review-complete-request"));
    const generationId = expectGenerationOf(agent);
    agent.emit({ taskId: "task-1", unitId: "unit-1", generationId, delta: "候选开头", done: false });
    await waitFor(() =>
      expect(screen.getByTestId("task-review-suggestion").textContent).toContain("候选开头"),
    );
    // The reviewer starts composing and the first IME update lands: the
    // generation for the old draft must die immediately, mid-composition.
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "正在输入拼音中间态" } });
    expect(cancel).toHaveBeenCalledWith({ taskId: "task-1", generationId });
    expect(screen.queryByTestId("task-review-suggestion")).toBeNull();
    agent.emit({ taskId: "task-1", unitId: "unit-1", generationId, delta: "迟到的增量", done: true });
    fireEvent.compositionEnd(input);
    expect(screen.queryByTestId("task-review-suggestion")).toBeNull();
    expect(input.value).toBe("正在输入拼音中间态");
  });

  it("invalidates a finished candidate when the draft changes without typing", async () => {
    const { agent, updates, patchDraft } = setup("已有反馈");
    fireEvent.click(screen.getByTestId("task-review-complete-request"));
    const generationId = expectGenerationOf(agent);
    agent.emit({ taskId: "task-1", unitId: "unit-1", generationId, delta: "续写内容", done: true });
    await waitFor(() =>
      expect(screen.getByTestId("task-review-suggestion").textContent).toContain("续写内容"),
    );
    expect((screen.getByTestId("task-review-adopt-all") as HTMLButtonElement).disabled).toBe(false);
    // A programmatic draft change (for example an issue-option insertion)
    // never fires the textarea's change event; the candidate must still die.
    updates.length = 0;
    patchDraft({ text: "已有反馈＋选项追加" });
    await waitFor(() =>
      expect(screen.queryByTestId("task-review-suggestion")).toBeNull(),
    );
    expect(screen.queryByTestId("task-review-adopt-all")).toBeNull();
    expect(updates).toHaveLength(0);
  });

  it("blocks adoption after the selection moved away from the generation-time selection", async () => {
    const { agent, updates, patchDraft } = setup("已有反馈");
    fireEvent.click(screen.getByTestId("task-review-complete-request"));
    const generationId = expectGenerationOf(agent);
    agent.emit({ taskId: "task-1", unitId: "unit-1", generationId, delta: "后续文本", done: true });
    await waitFor(() =>
      expect(screen.getByTestId("task-review-suggestion").textContent).toContain("后续文本"),
    );
    // Moving only the caret is not input: the candidate stays visible but the
    // follow-up no longer matches the draft it was generated against.
    patchDraft({ selectionStart: 1, selectionEnd: 1 });
    const adoptAll = screen.getByTestId("task-review-adopt-all") as HTMLButtonElement;
    await waitFor(() => expect(adoptAll.disabled).toBe(true));
    expect(screen.getByTestId("task-review-complete-status").textContent).toContain("候选失效");
    updates.length = 0;
    fireEvent.click(adoptAll);
    expect(updates).toHaveLength(0);
    // Restoring the generation-time selection makes the candidate adoptable
    // again, and adoption inserts at that exact selection.
    patchDraft({ selectionStart: 5, selectionEnd: 5 });
    await waitFor(() => expect(adoptAll.disabled).toBe(false));
    fireEvent.click(adoptAll);
    expect(updates.at(-1)?.text).toBe("已有反馈后续文本");
  });
});

/** Reads the generation id the scene submitted through the fake bridge. */
function expectGenerationOf(agent: ReturnType<typeof createFakeTaskAgentBridge>): string {
  const latest = agent.completeRequests.at(-1);
  if (!latest) throw new Error("no completion requested");
  return latest.generationId;
}
