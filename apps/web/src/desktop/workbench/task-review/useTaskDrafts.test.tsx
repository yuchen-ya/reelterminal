import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTaskDrafts } from "./useTaskDrafts";
import type { TaskReviewController, MutationResult } from "./useTaskReviewController";
import { emptySnapshot } from "./testing";

afterEach(() => { cleanup(); vi.useRealTimers(); });

const initial = () => ({ ...emptySnapshot(), drafts: [{ unitId: "b", sourceVersionId: "source-1", text: "人工意见", selectionStart: 4, selectionEnd: 4, updatedAt: 1 }] });
const success = { ok: true, snapshot: null, error: null };

describe("task feedback persistence", () => {
  it("persists selection-only changes and restores them from the authoritative draft", async () => {
    vi.useFakeTimers();
    const saveDraft = vi.fn().mockResolvedValue(success);
    const controller = { saveDraft } as unknown as TaskReviewController;
    const hook = renderHook(() => useTaskDrafts(initial(), controller));
    act(() => hook.result.current.updateDraft("b", "source-1", { selectionStart: 1, selectionEnd: 3 }));
    expect(hook.result.current.dirtyCount).toBe(1);
    await act(async () => { await hook.result.current.flushAll(); });
    expect(saveDraft).toHaveBeenCalledWith({ unitId: "b", sourceVersionId: "source-1", text: "人工意见", selectionStart: 1, selectionEnd: 3 });
    expect(hook.result.current.dirtyCount).toBe(0);
  });

  it("keeps newer text and selection when an older save and snapshot arrive late", async () => {
    vi.useFakeTimers();
    let acknowledge!: (result: MutationResult) => void;
    const saveDraft = vi.fn().mockImplementationOnce(() => new Promise<MutationResult>((resolve) => { acknowledge = resolve; })).mockResolvedValue(success);
    const controller = { saveDraft } as unknown as TaskReviewController;
    const hook = renderHook(({ snapshot }) => useTaskDrafts(snapshot, controller), { initialProps: { snapshot: initial() } });
    act(() => hook.result.current.updateDraft("b", "source-1", { text: "第一版", selectionStart: 2, selectionEnd: 2 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    act(() => hook.result.current.updateDraft("b", "source-1", { text: "更新后的文字", selectionStart: 1, selectionEnd: 4 }));
    await act(async () => { acknowledge(success); });
    hook.rerender({ snapshot: initial() });
    expect(hook.result.current.drafts.b).toMatchObject({ text: "更新后的文字", selectionStart: 1, selectionEnd: 4, status: "idle" });
    await act(async () => { await hook.result.current.flushAll(); });
    expect(saveDraft).toHaveBeenLastCalledWith(expect.objectContaining({ text: "更新后的文字", selectionStart: 1, selectionEnd: 4 }));
    expect(hook.result.current.dirtyCount).toBe(0);
  });
});
