/**
 * Contract for the global Esc rule while a read-only version preview is
 * active (docs/VERSION-NODES-UX.md 节点操作约定): Esc returns to current
 * editing, but never steals Esc from menus (which prevent/default it first)
 * and never fires while the user is typing in a text field.
 */
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { useProjectStore } from "../stores/project-store";

const { exitPreview, previewSnapshot } = vi.hoisted(() => ({
  exitPreview: vi.fn(() => Promise.resolve()),
  previewSnapshot: { active: false as boolean, busy: false, info: null },
}));

vi.mock("../services/preview-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/preview-session")>();
  return {
    ...actual,
    isPreviewActive: () => previewSnapshot.active,
    previewSession: {
      ...actual.previewSession,
      getSnapshot: () => previewSnapshot,
      exit: exitPreview,
    },
  };
});

const pressEscOn = (target: HTMLElement): void => {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
};

describe("useKeyboardShortcuts preview Esc", () => {
  let unmount: () => void = () => {};

  beforeEach(() => {
    exitPreview.mockClear();
    previewSnapshot.active = false;
    useProjectStore.getState().createNewProject();
    useProjectStore.setState({ workspaceId: "preview-esc-workspace" });
    const rendered = renderHook(() => useKeyboardShortcuts());
    unmount = rendered.unmount;
  });

  afterEach(() => {
    unmount();
    vi.restoreAllMocks();
  });

  it("Esc exits an active read-only preview", () => {
    previewSnapshot.active = true;

    pressEscOn(document.body);

    expect(exitPreview).toHaveBeenCalledTimes(1);
  });

  it("Esc while typing in a text field does not exit the preview", () => {
    previewSnapshot.active = true;
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    pressEscOn(input);

    expect(exitPreview).not.toHaveBeenCalled();
    input.remove();
  });

  it("Esc does nothing while no preview is active", () => {
    pressEscOn(document.body);

    expect(exitPreview).not.toHaveBeenCalled();
  });

  it("Esc already handled by a menu (defaultPrevented) does not exit the preview", () => {
    previewSnapshot.active = true;
    // Menus close themselves via capture listeners that consume the event.
    const menuCapture = (event: KeyboardEvent) => {
      if (event.key === "Escape") event.preventDefault();
    };
    window.addEventListener("keydown", menuCapture, true);

    try {
      pressEscOn(document.body);
      expect(exitPreview).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", menuCapture, true);
    }
  });
});
