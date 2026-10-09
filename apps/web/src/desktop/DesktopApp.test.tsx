import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import type React from "react";
import { Button } from "@astryxdesign/core/Button";

import { DesktopApp } from "./DesktopApp";
import { useProjectStore } from "../stores/project-store";
import type { ProjectState } from "../stores/project-store";
import { useUIStore } from "../stores/ui-store";
import { useSettingsStore } from "../stores/settings-store";
import { useNotificationStore } from "../stores/notification-store";
import { workspaceManager } from "../services/workspace-manager";

vi.mock("../stores/project-store", () => ({
  getProjectRevision: vi.fn(() => 0),
  useProjectStore: Object.assign(vi.fn(), {
    getState: vi.fn(() => ({})),
    subscribe: vi.fn(() => () => {}),
  }),
}));

vi.mock("../services/workspace-manager", () => {
  // Stable snapshot reference: useSyncExternalStore loops on fresh objects.
  const snapshot = {
    version: 0,
    activeProjectId: null,
    activeWorkspaceId: null,
    projects: [],
    workspaces: [],
    nodes: [],
  };
  return {
    workspaceManager: {
      initialize: vi.fn(async () => {}),
      listProjects: vi.fn(async () => []),
      listWorkspaces: vi.fn(async () => []),
      flushWorkspace: vi.fn(async () => {}),
      flushOpenWorkspaces: vi.fn(async () => {}),
      listRetentionCandidates: vi.fn(async () => []),
      // Read by the top-left project switcher's versioning actions.
      subscribe: vi.fn(() => () => {}),
      getSnapshot: vi.fn(() => snapshot),
      // Prepare-close must only retain through explicit user decisions; the
      // tests that exercise retention override this mock per test.
      saveNode: vi.fn(async () => {
        throw new Error("saveNode must not be called in this test");
      }),
    },
  };
});

vi.mock("./editor/EditorBootstrapGate", () => ({
  EditorBootstrapGate: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("./pages/EditPage", () => ({
  EditPage: () => null,
}));

vi.mock("./pages/MotionPage", () => ({
  MotionPage: () => null,
}));

vi.mock("./editor/DesktopExportButton", () => ({
  DesktopExportButton: () => <Button label="Video Export" />,
}));

vi.mock("../components/editor/settings/SettingsDialog", () => ({
  SettingsDialog: () => <div data-testid="desktop-settings-dialog" />,
}));

const mockedUseProjectStore = vi.mocked(useProjectStore);
const openProjectMock = vi.hoisted(() => vi.fn());

vi.mock("./start/desktop-project-actions", async () => ({
  ...await vi.importActual<typeof import("./start/desktop-project-actions")>("./start/desktop-project-actions"),
  openProject: openProjectMock,
}));

function mockHasProject(value: boolean): void {
  mockedUseProjectStore.mockImplementation((selector) => {
    // The title-bar project name control (and the ProjectSwitcher inside it)
    // consume the store without a selector, so the mock must serve the whole
    // slice too — not only selector-driven reads.
    const state = {
      hasOpenProject: value,
      project: { id: "project-1", name: "My Project" },
      createNewProject: vi.fn(),
      recoverFromAutoSave: vi.fn(),
      renameProject: vi.fn().mockResolvedValue({ success: true }),
    } as unknown as ProjectState;
    return selector ? selector(state) : state;
  });
}

beforeEach(() => {
  openProjectMock.mockReset().mockResolvedValue(false);
  useUIStore.setState({ desktopPage: "edit" });
  useSettingsStore.setState({ settingsOpen: false, settingsTab: "general" });
  (window as unknown as { reelterminal: unknown }).reelterminal = {
    platform: "desktop",
    win: { minimize: () => {}, toggleMaximize: () => {}, close: () => {}, isMaximized: async () => false },
  };
});
afterEach(() => {
  delete (window as unknown as { reelterminal?: unknown }).reelterminal;
  vi.clearAllMocks();
});

describe("DesktopApp", () => {
  it("opens the chooser from New Project and returns to the same mounted editor on cancel", async () => {
    mockHasProject(true);
    const view = render(<DesktopApp />);
    const workspace = view.getByTestId("desktop-workspace");
    fireEvent.click(view.getByRole("button", { name: "My Project" }));
    fireEvent.click(await view.findByRole("button", { name: "New Project" }));
    expect(view.getByRole("button", { name: "Back to current project" })).toBeTruthy();
    expect(workspace.closest("[hidden]")).not.toBeNull();
    expect(view.queryByRole("button", { name: "Video Export" })).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Back to current project" }));
    expect(view.getByTestId("desktop-workspace")).toBe(workspace);
    expect(workspace.closest("[hidden]")).toBeNull();
    expect(view.getByRole("button", { name: "My Project" })).toBeTruthy();
  });

  it("routes native New/Open accelerators through the chooser and project open flow", async () => {
    mockHasProject(true);
    let onMenuAction: (id: string) => void = () => {};
    window.reelterminal!.onMenuAction = (handler) => {
      onMenuAction = handler;
      return () => {};
    };
    const view = render(<DesktopApp />);
    act(() => onMenuAction("newProject"));
    expect(view.getByRole("button", { name: "Back to current project" })).toBeTruthy();

    act(() => onMenuAction("open"));
    await waitFor(() => expect(openProjectMock).toHaveBeenCalledOnce());
    expect(view.getByRole("button", { name: "Back to current project" })).toBeTruthy();

    openProjectMock.mockResolvedValue(true);
    act(() => onMenuAction("open"));
    await waitFor(() => expect(view.queryByRole("button", { name: "Back to current project" })).toBeNull());
    expect(view.getByRole("button", { name: "My Project" })).toBeTruthy();
  });
  it("applies the desktop theme class to its root", () => {
    mockHasProject(false);
    const { container, unmount } = render(<DesktopApp />);
    expect(container.querySelector(".reelterminal-desktop")).not.toBeNull();
    expect(document.body).toHaveClass("reelterminal-desktop");
    unmount();
    expect(document.body).not.toHaveClass("reelterminal-desktop");
  });

  it("shows the start screen and hides the workspace when no project is open", () => {
    mockHasProject(false);
    const { getByText, queryByTestId } = render(<DesktopApp />);
    expect(getByText("New Project")).toBeTruthy();
    expect(queryByTestId("desktop-workspace")).toBeNull();
  });

  it("renders the title bar and workspace when a project is open", () => {
    mockHasProject(true);
    const { getByText, getByTestId, getByRole } = render(<DesktopApp />);
    expect(getByText("ReelTerminal")).toBeTruthy();
    expect(getByTestId("desktop-workspace")).toBeTruthy();
    // The desktop chrome itself exposes the rename entry.
    expect(getByTestId("desktop-project-name-control")).toBeTruthy();
    expect(getByRole("button", { name: "My Project" })).toBeTruthy();
    expect(getByRole("button", { name: "Rename project" })).toBeTruthy();
  });

  it("shows the video export only while the Video Editing workspace is active", () => {
    mockHasProject(true);
    const editView = render(<DesktopApp />);
    expect(editView.getByRole("button", { name: "Video Export" })).toBeTruthy();
    editView.unmount();

    useUIStore.setState({ desktopPage: "motion" });
    const motionView = render(<DesktopApp />);
    expect(
      motionView.queryByRole("button", { name: "Video Export" }),
    ).toBeNull();
  });

  it("keeps settings reachable from the desktop title bar", () => {
    mockHasProject(false);
    const view = render(<DesktopApp />);

    fireEvent.click(view.getByRole("button", { name: "Settings" }));

    expect(useSettingsStore.getState().settingsOpen).toBe(true);
    expect(view.getByTestId("desktop-settings-dialog")).toBeTruthy();
  });

  function mockPrepareClose(): { handler: () => (() => Promise<boolean>) | undefined } {
    let prepare: (() => Promise<boolean>) | undefined;
    (window as unknown as { reelterminal: unknown }).reelterminal = {
      platform: "desktop",
      win: {
        minimize: () => {},
        toggleMaximize: () => {},
        close: () => {},
        isMaximized: async () => false,
      },
      lifecycle: {
        onPrepareClose: (handler: () => Promise<boolean>) => {
          prepare = handler;
          return () => {};
        },
      },
    };
    return { handler: () => prepare };
  }

  it("prepare-close flushes open workspaces and closes when nothing needs retention", async () => {
    mockHasProject(false);
    const { handler } = mockPrepareClose();
    vi.mocked(workspaceManager.listProjects).mockResolvedValue([
      { id: "p1", name: "宣传片", defaultWorkspaceId: "w1", createdAt: 0, modifiedAt: 0 },
    ]);
    vi.mocked(workspaceManager.listWorkspaces).mockResolvedValue([
      {
        id: "w1",
        projectId: "p1",
        name: "主剪辑",
        kind: "default",
        baseNodeId: null,
        revision: 3,
        updatedAt: 0,
        dirty: true,
      },
    ]);
    vi.mocked(workspaceManager.listRetentionCandidates).mockResolvedValue([]);

    render(<DesktopApp />);
    const prepare = handler();
    expect(prepare).toBeTypeOf("function");

    await expect(prepare!()).resolves.toBe(true);
    expect(workspaceManager.flushOpenWorkspaces).toHaveBeenCalledTimes(2);
    expect(workspaceManager.listProjects).not.toHaveBeenCalled();
    expect(workspaceManager.saveNode).not.toHaveBeenCalled();
  });

  it("prepare-close keeps the window open and reports the failure when a flush fails", async () => {
    mockHasProject(false);
    useNotificationStore.getState().clearAll();
    const { handler } = mockPrepareClose();
    vi.mocked(workspaceManager.flushOpenWorkspaces).mockRejectedValueOnce(
      new Error("IndexedDB transaction aborted"),
    );

    render(<DesktopApp />);
    await act(async () => {
      await expect(handler()!()).resolves.toBe(false);
    });
    expect(
      useNotificationStore
        .getState()
        .notifications.some((notification) => notification.type === "error"),
    ).toBe(true);
    useNotificationStore.getState().clearAll();
  });

  it("prepare-close opens the retention dialog for the ask preference and closes on a direct close", async () => {
    mockHasProject(false);
    useSettingsStore.getState().setCloseRetention("ask");
    const { handler } = mockPrepareClose();
    vi.mocked(workspaceManager.listRetentionCandidates).mockResolvedValue([
      {
        projectId: "p1",
        projectName: "宣传片",
        workspaceId: "w1",
        workspaceName: "主剪辑",
      },
    ]);

    const view = render(<DesktopApp />);
    const decision = handler()!();

    expect(await view.findByTestId("close-retention-dialog")).toBeTruthy();
    fireEvent.click(await view.findByTestId("close-directly-button"));
    await expect(decision).resolves.toBe(true);
    expect(useSettingsStore.getState().closeRetention).toBe("ask");
    expect(workspaceManager.saveNode).not.toHaveBeenCalled();
    useSettingsStore.getState().setCloseRetention("ask");
  });

  it("prepare-close retains automatically for the retain preference", async () => {
    mockHasProject(false);
    useSettingsStore.getState().setCloseRetention("retain");
    const { handler } = mockPrepareClose();
    vi.mocked(workspaceManager.listRetentionCandidates).mockResolvedValue([
      {
        projectId: "p1",
        projectName: "宣传片",
        workspaceId: "w1",
        workspaceName: "主剪辑",
      },
    ]);
    const saveNode = vi
      .spyOn(workspaceManager, "saveNode")
      .mockResolvedValue({} as Awaited<ReturnType<typeof workspaceManager.saveNode>>);

    render(<DesktopApp />);
    await expect(handler()!()).resolves.toBe(true);
    expect(saveNode).toHaveBeenCalledWith({
      target: { projectId: "p1", workspaceId: "w1" },
    });
    useSettingsStore.getState().setCloseRetention("ask");
  });

  describe("DOM-level undo/redo keyboard handler (G-01)", () => {
    function mockUndoRedo(): { undo: ReturnType<typeof vi.fn>; redo: ReturnType<typeof vi.fn> } {
      const undo = vi.fn();
      const redo = vi.fn();
      (mockedUseProjectStore as unknown as { getState: () => unknown }).getState = () => ({
        undo,
        redo,
      });
      return { undo, redo };
    }

    it("routes Cmd+Z / Ctrl+Z to the store undo", () => {
      mockHasProject(true);
      const { undo, redo } = mockUndoRedo();
      render(<DesktopApp />);

      fireEvent.keyDown(window, { key: "z", metaKey: true });
      expect(undo).toHaveBeenCalledTimes(1);
      expect(redo).not.toHaveBeenCalled();

      fireEvent.keyDown(window, { key: "z", ctrlKey: true });
      expect(undo).toHaveBeenCalledTimes(2);
      expect(redo).not.toHaveBeenCalled();
    });

    it("routes Cmd+Shift+Z / Ctrl+Y to the store redo", () => {
      mockHasProject(true);
      const { undo, redo } = mockUndoRedo();
      render(<DesktopApp />);

      fireEvent.keyDown(window, { key: "Z", metaKey: true, shiftKey: true });
      expect(redo).toHaveBeenCalledTimes(1);
      expect(undo).not.toHaveBeenCalled();

      fireEvent.keyDown(window, { key: "y", ctrlKey: true });
      expect(redo).toHaveBeenCalledTimes(2);
      expect(undo).not.toHaveBeenCalled();
    });

    it("never hijacks text entry (input / textarea / contenteditable guard)", () => {
      mockHasProject(true);
      const { undo, redo } = mockUndoRedo();
      render(<DesktopApp />);

      const input = document.createElement("input");
      const textarea = document.createElement("textarea");
      const editable = document.createElement("div");
      // jsdom does not implement isContentEditable (always false) — stub it
      // so the guard path itself is exercised.
      Object.defineProperty(editable, "isContentEditable", { value: true });
      document.body.append(input, textarea, editable);

      fireEvent.keyDown(input, { key: "z", metaKey: true });
      fireEvent.keyDown(textarea, { key: "z", metaKey: true });
      fireEvent.keyDown(editable, { key: "z", metaKey: true });
      expect(undo).not.toHaveBeenCalled();
      expect(redo).not.toHaveBeenCalled();

      input.remove();
      textarea.remove();
      editable.remove();
    });

    it("ignores unrelated keys and modifier-less presses", () => {
      mockHasProject(true);
      const { undo, redo } = mockUndoRedo();
      render(<DesktopApp />);

      fireEvent.keyDown(window, { key: "z" });
      fireEvent.keyDown(window, { key: "x", metaKey: true });
      fireEvent.keyDown(window, { key: "z", metaKey: true, altKey: true });
      expect(undo).not.toHaveBeenCalled();
      expect(redo).not.toHaveBeenCalled();
    });
  });
});
