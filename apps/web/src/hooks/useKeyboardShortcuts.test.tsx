/**
 * Contract for the web renderer's file.save shortcut (Cmd/Ctrl+S): it must
 * only complete pending workspace writes (never create version nodes), show
 * visible saved / failure feedback, and stay a no-op acknowledgement while a
 * read-only preview is active (docs/VERSION-NODES-UX.md 预览不会打断编辑).
 */
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { useProjectStore } from "../stores/project-store";
import { useNotificationStore } from "../stores/notification-store";
import { workspaceManager } from "../services/workspace-manager";
import { isPreviewActive } from "../services/preview-session";
import { t } from "../i18n";

vi.mock("../services/preview-session", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../services/preview-session")
  >()),
  isPreviewActive: vi.fn(() => false),
}));

const mockedIsPreviewActive = vi.mocked(isPreviewActive);

const pressSave = (): void => {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "s", code: "KeyS", ctrlKey: true }),
  );
};

describe("useKeyboardShortcuts file.save", () => {
  beforeEach(() => {
    useProjectStore.getState().createNewProject();
    useProjectStore.setState({ workspaceId: "shortcut-workspace" });
    vi.spyOn(workspaceManager, "initialize").mockResolvedValue(undefined);
    mockedIsPreviewActive.mockReturnValue(false);
    useNotificationStore.getState().clearAll();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockedIsPreviewActive.mockReset();
    useNotificationStore.getState().clearAll();
  });

  it("Ctrl+S flushes the workspace instead of creating a node", async () => {
    const state = useProjectStore.getState();
    const flushWorkspace = vi
      .spyOn(workspaceManager, "flushWorkspace")
      .mockResolvedValue(undefined);
    const saveNode = vi
      .spyOn(workspaceManager, "saveNode")
      .mockRejectedValue(new Error("saveNode must not be called from Ctrl+S"));
    const { unmount } = renderHook(() => useKeyboardShortcuts());

    pressSave();

    await vi.waitFor(() =>
      expect(flushWorkspace).toHaveBeenCalledWith({
        projectId: state.project.id,
        workspaceId: state.workspaceId,
      }),
    );
    expect(saveNode).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(
        useNotificationStore
          .getState()
          .notifications.some((notification) => notification.type === "success"),
      ).toBe(true),
    );
    unmount();
  });

  it("Ctrl+S while a preview is active only reports the saved version and never writes", async () => {
    mockedIsPreviewActive.mockReturnValue(true);
    const flushWorkspace = vi
      .spyOn(workspaceManager, "flushWorkspace")
      .mockResolvedValue(undefined);
    const saveNode = vi.spyOn(workspaceManager, "saveNode");
    const { unmount } = renderHook(() => useKeyboardShortcuts());

    pressSave();

    await vi.waitFor(() =>
      expect(
        useNotificationStore
          .getState()
          .notifications.some(
            (notification) =>
              notification.type === "info" &&
              notification.title === t("versioning.previewSavedToast"),
          ),
      ).toBe(true),
    );
    expect(flushWorkspace).not.toHaveBeenCalled();
    expect(workspaceManager.initialize).not.toHaveBeenCalled();
    expect(saveNode).not.toHaveBeenCalled();
    unmount();
  });

  it("reports a failed save instead of staying silent", async () => {
    vi.spyOn(workspaceManager, "flushWorkspace").mockRejectedValue(
      new Error("IndexedDB transaction aborted"),
    );
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
