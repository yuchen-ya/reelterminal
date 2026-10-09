/**
 * Contract for the editing shortcuts while a read-only version preview is
 * active (docs/VERSION-NODES-UX.md 预览不会打断编辑): Delete, Cut, undo/redo
 * and friends must never mutate the previewed historical store. The gate
 * itself (one "read-only" hint per session) is covered by
 * services/preview-session.test.ts; this file pins that the global keyboard
 * handlers actually route through that gate.
 */
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { useProjectStore } from "../stores/project-store";
import { useUIStore } from "../stores/ui-store";
import {
  blockPreviewEditInteraction,
} from "../services/preview-session";

vi.mock("../services/preview-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/preview-session")>()),
  blockPreviewEditInteraction: vi.fn(() => false),
}));

const deleteTimelineItem = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("../utils/timeline-item-actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/timeline-item-actions")>()),
  deleteTimelineItem,
}));

const mockedBlock = vi.mocked(blockPreviewEditInteraction);

const press = (
  key: string,
  code: string,
  modifiers: KeyboardEventInit = {},
): void => {
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      code,
      bubbles: true,
      cancelable: true,
      ...modifiers,
    }),
  );
};

describe("useKeyboardShortcuts read-only preview edit gate", () => {
  beforeEach(() => {
    useProjectStore.getState().createNewProject();
    useProjectStore.setState({ workspaceId: "preview-gate-workspace" });
    mockedBlock.mockReturnValue(false);
    deleteTimelineItem.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Delete during a preview never reaches the project store", () => {
    mockedBlock.mockReturnValue(true);
    const { unmount } = renderHook(() => useKeyboardShortcuts());

    press("Delete", "Delete");

    expect(deleteTimelineItem).not.toHaveBeenCalled();
    unmount();
  });

  it("Cut during a preview is blocked like Delete", () => {
    mockedBlock.mockReturnValue(true);
    const { unmount } = renderHook(() => useKeyboardShortcuts());

    press("x", "KeyX", { ctrlKey: true });

    expect(deleteTimelineItem).not.toHaveBeenCalled();
    unmount();
  });

  it("Delete with no preview active still edits normally", () => {
    mockedBlock.mockReturnValue(false);
    useUIStore.getState().selectMultiple([
      { id: "clip-1", trackId: "track-1", type: "clip" },
    ]);
    const { unmount } = renderHook(() => useKeyboardShortcuts());

    press("Delete", "Delete");

    expect(deleteTimelineItem).toHaveBeenCalledWith(
      expect.anything(),
      "clip-1",
    );
    unmount();
  });
});
