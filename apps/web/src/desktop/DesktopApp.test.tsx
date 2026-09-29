import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import type React from "react";
import { Button } from "@astryxdesign/core/Button";

import { DesktopApp } from "./DesktopApp";
import { useProjectStore } from "../stores/project-store";
import type { ProjectState } from "../stores/project-store";
import { useUIStore } from "../stores/ui-store";
import { useSettingsStore } from "../stores/settings-store";

vi.mock("../stores/project-store", () => ({
  getProjectRevision: vi.fn(() => 0),
  useProjectStore: Object.assign(vi.fn(), {
    getState: vi.fn(() => ({})),
    subscribe: vi.fn(() => () => {}),
  }),
}));

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
  it("applies the desktop theme class to its root", () => {
    mockHasProject(false);
    const { container } = render(<DesktopApp />);
    expect(container.querySelector(".reelterminal-desktop")).not.toBeNull();
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

  it("lets a lifecycle flush observe a durable-save rejection", async () => {
    mockHasProject(false);
    const failure = new Error("IndexedDB transaction aborted");
    const forceSave = vi.fn().mockRejectedValue(failure);
    let flush: (() => Promise<void>) | undefined;
    (mockedUseProjectStore as unknown as { getState: () => unknown }).getState =
      () => ({ forceSave });
    (window as unknown as { reelterminal: unknown }).reelterminal = {
      platform: "desktop",
      win: {
        minimize: () => {},
        toggleMaximize: () => {},
        close: () => {},
        isMaximized: async () => false,
      },
      lifecycle: {
        onQueryUnsaved: () => () => {},
        onFlush: (handler: () => Promise<void>) => {
          flush = handler;
          return () => {};
        },
      },
    };
    render(<DesktopApp />);

    expect(flush).toBeTypeOf("function");
    await expect(flush?.()).rejects.toBe(failure);
    expect(forceSave).toHaveBeenCalledOnce();
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
