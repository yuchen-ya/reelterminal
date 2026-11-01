import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { emptyWorkbenchState, type WorkbenchProjectState } from "@reelterminal/core";
import { changeAppLanguage, SYSTEM_LANGUAGE } from "../../i18n";
import { useWorkbenchUiStore } from "../../stores/workbench-ui-store";
import { useWorkbenchControllerSource, type WorkbenchControllerSource } from "./useWorkbenchController";

vi.mock("../../stores/project-store", () => ({ useProjectStore: vi.fn() }));
afterEach(async () => { cleanup(); useWorkbenchUiStore.getState().resetProjectScopedState(); await changeAppLanguage(SYSTEM_LANGUAGE); });
it("refreshes memoized feedback labels while retaining selection, authored content and revisions", async () => {
  await changeAppLanguage("en");
  useWorkbenchUiStore.getState().resetProjectScopedState();
  const state: WorkbenchProjectState = { ...emptyWorkbenchState(),
    batches: [{ id: "batch", name: "Keep", createdAt: 1, revision: 4, itemIds: ["item"] }],
    items: [{ id: "item", batchId: "batch", orderIndex: 0, title: "Keep", type: "text", version: 1, createdAt: 1,
      content: { type: "text", entryId: "text", title: "Keep", speakerOrContext: "", versions: [{ version: 1, text: "用户的原文", createdAt: 1, origin: "ingest" }] },
      provenanceTags: [], userTags: [], status: "pending", decisionLog: [], revisions: [] }],
    feedback: [{ id: "feedback", itemId: "item", itemVersion: 1, text: "Keep", referencedTagIds: [], target: { kind: "whole-item" }, state: "confirmed", createdAt: 1, updatedAt: 1 }],
  };
  const before = structuredClone(state);
  const commands = vi.fn((): never => { throw new Error("Language switching must not write content"); });
  const source: WorkbenchControllerSource = { scopeId: "locale-test", workbench: state, mediaItems: [], getWorkbench: () => state, commands,
    openMedia: vi.fn(async () => null), importRepair: vi.fn(async () => ({ ok: true as const })), undo: vi.fn(async () => ({ ok: true as const })), redo: vi.fn(async () => ({ ok: true as const })), canUndo: false, canRedo: false };
  const { result } = renderHook(() => useWorkbenchControllerSource(source));
  act(() => useWorkbenchUiStore.getState().setSelection("batch", ["item"]));
  expect(result.current.currentItem?.feedback?.targetSummary).toBe("Entire item");
  await act(() => changeAppLanguage("zh-CN"));
  expect(result.current.currentItem?.feedback?.targetSummary).toBe("整条条目");
  expect(result.current.currentItem?.feedback?.text).toBe("Keep");
  expect(result.current.currentItem?.textPayload?.currentText).toBe("用户的原文");
  expect(result.current.currentItem?.title).toBe("Keep");
  expect(result.current.selectedIds).toEqual(["item"]);
  await act(() => changeAppLanguage("en"));
  expect(result.current.currentItem?.feedback?.targetSummary).toBe("Entire item");
  expect(state).toEqual(before);
  expect(commands).not.toHaveBeenCalled();
});
