/**
 * Contract for the web renderer's file.save shortcut (Cmd/Ctrl+S): it must
 * actually flush a durable save through the same store path the desktop
 * lifecycle flush and the agent requestSave verb use, with visible saved /
 * failure feedback — never a silent no-op.
 */
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { useProjectStore } from "../stores/project-store";
import { useNotificationStore } from "../stores/notification-store";

const pressSave = (): void => {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "s", code: "KeyS", ctrlKey: true }),
  );
};

describe("useKeyboardShortcuts file.save", () => {
  beforeEach(() => {
    useProjectStore.getState().createNewProject();
    useNotificationStore.getState().clearAll();
  });

  afterEach(() => {
    useNotificationStore.getState().clearAll();
  });

  it("Ctrl+S forces a durable save and confirms with a success notification", async () => {
    const forceSave = vi.fn(async () => {});
    useProjectStore.setState({ forceSave });
    const { unmount } = renderHook(() => useKeyboardShortcuts());

    pressSave();

    await vi.waitFor(() => expect(forceSave).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(
        useNotificationStore
          .getState()
          .notifications.some((notification) => notification.type === "success"),
      ).toBe(true),
    );
    unmount();
  });

  it("reports a failed save instead of staying silent", async () => {
    useProjectStore.setState({
      forceSave: vi.fn(async () => {
        throw new Error("IndexedDB transaction aborted");
      }),
    });
    const { unmount } = renderHook(() => useKeyboardShortcuts());

    pressSave();

    await vi.waitFor(() =>
      expect(
        useNotificationStore
          .getState()
          .notifications.some((notification) => notification.type === "error"),
      ).toBe(true),
    );
    unmount();
  });
});
