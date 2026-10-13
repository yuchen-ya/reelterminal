import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useNotificationStore } from "../../stores/notification-store";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const desktopThemeCss = readFileSync(fileURLToPath(new URL("./../theme/desktop-theme.css", import.meta.url)), "utf8");

const fixture = vi.hoisted(() => ({
  snapshot: {} as Record<string, unknown>,
  preview: { active: false, busy: false, info: null } as Record<string, unknown>,
  listeners: new Set<() => void>(),
  enter: vi.fn(),
  cancelPending: vi.fn(),
  exit: vi.fn(),
  adopt: vi.fn(),
  renameNode: vi.fn(),
  deleteNode: vi.fn(),
  restoreDeletedNode: vi.fn(),
}));

vi.mock("../../services/workspace-manager", () => ({
  workspaceManager: {
    subscribe: (listener: () => void) => {
      fixture.listeners.add(listener);
      return () => fixture.listeners.delete(listener);
    },
    getSnapshot: () => fixture.snapshot,
    initialize: async () => {},
    renameNode: fixture.renameNode,
    deleteNode: fixture.deleteNode,
    restoreDeletedNode: fixture.restoreDeletedNode,
  },
}));

vi.mock("../../services/preview-session", () => ({
  previewSession: {
    subscribe: (listener: () => void) => {
      fixture.listeners.add(listener);
      return () => fixture.listeners.delete(listener);
    },
    getSnapshot: () => fixture.preview,
    enter: fixture.enter,
    cancelPending: fixture.cancelPending,
    exit: fixture.exit,
    adopt: fixture.adopt,
    getNodeSummary: async () => null,
  },
}));

import { VersionNodeTrack } from "./VersionNodeTrack";

function node(
  id: string,
  projectId: string,
  parentNodeId: string | null,
  name: string,
  createdAt = 1_000,
  missingDependencies: string[] = [],
) {
  return {
    id,
    projectId,
    parentNodeId,
    name,
    summary: "Stage summary",
    createdAt,
    formatVersion: 1 as const,
    mediaIds: [],
    missingDependencies,
  };
}

function baseSnapshot() {
  return {
    version: 1,
    activeProjectId: "project-a",
    activeWorkspaceId: "workspace-a",
    projects: [
      { id: "project-a", name: "Project A", defaultWorkspaceId: "workspace-a", createdAt: 0, modifiedAt: 0 },
    ],
    workspaces: [
      { id: "workspace-a", projectId: "project-a", name: "Default", kind: "default", baseNodeId: "child", revision: 7, updatedAt: 0, dirty: false },
    ],
    nodes: [
      node("root", "project-a", null, "Root A", 1_000),
      node("child", "project-a", "root", "Continuation A", 2_000),
      node("branch", "project-a", "root", "Alternate A", 1_500),
      node("foreign", "project-b", null, "Foreign project node", 3_000),
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  useNotificationStore.getState().clearAll();
  fixture.snapshot = baseSnapshot();
  fixture.preview = { active: false, busy: false, info: null };
  fixture.enter.mockResolvedValue(undefined);
  fixture.cancelPending.mockResolvedValue(undefined);
  fixture.exit.mockResolvedValue(undefined);
  fixture.adopt.mockResolvedValue(undefined);
  fixture.renameNode.mockImplementation(async (_input: { name: string }) => ({
    ...node("root", "project-a", null, _input.name),
  }));
  fixture.deleteNode.mockResolvedValue(undefined);
  fixture.restoreDeletedNode.mockResolvedValue(undefined);
});

function publishPreviewState(state: Record<string, unknown>): void {
  act(() => {
    fixture.preview = state;
    fixture.listeners.forEach((listener) => listener());
  });
}

describe("inspector archive browser", () => {
  it("shows an honest empty state without fake unretained trial nodes", () => {
    fixture.snapshot = { ...baseSnapshot(), nodes: [], workspaces: [{ id: "workspace-a", projectId: "project-a", baseNodeId: null }, { id: "trial", projectId: "project-a", kind: "trial" }] };
    render(<VersionNodeTrack />);
    expect(screen.getByText("No save points yet. Current edits are still saved normally.")).toBeInTheDocument();
    expect(screen.queryByTestId("version-node-trial")).not.toBeInTheDocument();
    expect(fixture.enter).not.toHaveBeenCalled();
  });
  it("shows names and actual parent edges; one click only selects details", () => {
    const { container } = render(<VersionNodeTrack />);
    expect(screen.queryByTestId("archive-details")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Root A" })).toBeInTheDocument();
    expect(container.querySelector('[data-child-id="branch"][data-parent-id="root"]')).not.toBeNull();
    fireEvent.click(screen.getByTestId("version-node-root"));
    expect(screen.getByTestId("archive-details")).toHaveTextContent("Root A");
    expect(fixture.enter).not.toHaveBeenCalled();
    expect(fixture.adopt).not.toHaveBeenCalled();
    expect(screen.getByTestId("version-node-child")).toHaveAttribute("data-base", "true");
  });
  it("marks retained trial provenance without reclassifying referenced ordinary save points", () => {
    const snapshot = baseSnapshot();
    const retainedTrial = { ...node("retained-trial", "project-a", "root", "Retained trial", 2_500), sourceWorkspaceKind: "trial" };
    fixture.snapshot = {
      ...snapshot,
      nodes: [...snapshot.nodes, retainedTrial],
      workspaces: [
        ...snapshot.workspaces,
        { id: "trial-copy", projectId: "project-a", kind: "trial", baseNodeId: "child", dirty: false },
        { id: "export-copy", projectId: "project-a", kind: "trial", baseNodeId: "root", dirty: false },
      ],
    };
    const view = render(<VersionNodeTrack />);
    expect(within(screen.getByTestId("version-node-child")).getByText("Current")).toBeInTheDocument();
    expect(within(screen.getByTestId("version-node-child")).queryByText("Trial")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("version-node-root")).queryByText("Trial")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("version-node-retained-trial")).getByText("Trial")).toBeInTheDocument();
    fixture.snapshot = { ...snapshot, nodes: [...snapshot.nodes, retainedTrial] };
    view.rerender(<VersionNodeTrack />);
    expect(within(screen.getByTestId("version-node-retained-trial")).getByText("Trial")).toBeInTheDocument();
  });
  it("double click previews, while adopting needs the explicit action", async () => {
    fixture.enter.mockImplementation(async () => {
      publishPreviewState({
        active: true,
        busy: false,
        info: { nodeId: "root" },
        loading: {
          generation: 1,
          source: { kind: "node", nodeId: "root" },
          label: "Root A",
          phase: "awaiting-first-valid-frame",
          startedAt: performance.now(),
          cancellable: true,
        },
      });
    });
    render(<VersionNodeTrack />);
    fireEvent.doubleClick(screen.getByTestId("version-node-root"));
    await waitFor(() => expect(fixture.enter).toHaveBeenCalledWith({ kind: "node", nodeId: "root" }, { label: "Root A" }));
    expect(fixture.adopt).not.toHaveBeenCalled();
    fireEvent.contextMenu(screen.getByTestId("version-node-root"), { clientX: 20, clientY: 20 });
    fireEvent.click(screen.getByTestId("version-menu-adopt"));
    await waitFor(() => expect(fixture.enter).toHaveBeenCalledTimes(2));
    expect(fixture.adopt).not.toHaveBeenCalled();
    publishPreviewState({
      active: true,
      busy: false,
      info: { nodeId: "root" },
      loading: null,
    });
    await waitFor(() => expect(fixture.adopt).toHaveBeenCalledOnce());
  });

  it("does not adopt when the preview is cancelled before its first valid frame", async () => {
    fixture.enter.mockImplementation(async () => {
      publishPreviewState({
        active: true,
        busy: false,
        info: { nodeId: "root" },
        loading: {
          generation: 1,
          source: { kind: "node", nodeId: "root" },
          label: "Root A",
          phase: "awaiting-first-valid-frame",
          startedAt: performance.now(),
          cancellable: true,
        },
      });
    });
    render(<VersionNodeTrack />);
    fireEvent.contextMenu(screen.getByTestId("version-node-root"), { clientX: 20, clientY: 20 });
    fireEvent.click(screen.getByTestId("version-menu-adopt"));
    await waitFor(() => expect(fixture.enter).toHaveBeenCalledOnce());
    const saveButton = screen.getByTestId("create-save-point") as HTMLButtonElement;
    await waitFor(() => expect(saveButton.disabled).toBe(true));

    publishPreviewState({
      active: false,
      busy: true,
      info: null,
      loading: {
        generation: 2,
        source: { kind: "editing" },
        label: "Current workspace",
        phase: "restoring-context",
        startedAt: performance.now(),
        cancellable: true,
      },
    });
    await waitFor(() => expect(saveButton.disabled).toBe(false));
    expect(fixture.adopt).not.toHaveBeenCalled();
  });
  it("keeps node switching available while a previous preview request is pending", () => {
    fixture.enter.mockImplementation(() => new Promise<void>(() => {}));
    render(<VersionNodeTrack />);

    fireEvent.doubleClick(screen.getByTestId("version-node-root"));
    fireEvent.doubleClick(screen.getByTestId("version-node-branch"));
    fireEvent.doubleClick(screen.getByTestId("version-node-child"));

    expect(fixture.enter).toHaveBeenNthCalledWith(1, { kind: "node", nodeId: "root" }, { label: "Root A" });
    expect(fixture.enter).toHaveBeenNthCalledWith(2, { kind: "node", nodeId: "branch" }, { label: "Alternate A" });
    expect(fixture.enter).toHaveBeenNthCalledWith(3, { kind: "node", nodeId: "child" }, { label: "Continuation A" });
  });
  it("lays out portal context actions as four full-width rows", () => {
    const style = document.createElement("style");
    style.textContent = desktopThemeCss;
    document.head.append(style);
    try {
      render(<VersionNodeTrack />);
      fireEvent.contextMenu(screen.getByTestId("version-node-root"), { clientX: 20, clientY: 20 });
      const actions = within(screen.getByTestId("version-node-menu")).getAllByRole("menuitem");
      expect(actions).toHaveLength(4);
      for (const action of actions) {
        const computed = getComputedStyle(action);
        expect(computed.display).toBe("block");
        expect(computed.width).toBe("100%");
        expect(Number.parseFloat(computed.minHeight)).toBeGreaterThanOrEqual(32);
        expect(computed.textAlign).toBe("left");
      }
    } finally {
      style.remove();
    }
  });
  it("renames through the same metadata command and rejects blank names", async () => {
    render(<VersionNodeTrack />);
    fireEvent.contextMenu(screen.getByTestId("version-node-root"), { clientX: 20, clientY: 20 });
    fireEvent.click(screen.getByTestId("version-menu-rename"));
    const input = screen.getByTestId("version-rename-input");
    fireEvent.change(input, { target: { value: " " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(fixture.renameNode).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "User name" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(fixture.renameNode).toHaveBeenCalledWith({ projectId: "project-a", nodeId: "root", name: "User name" }));
  });
  it("ends a rename when another save point is selected and previewed", async () => {
    render(<VersionNodeTrack />);
    fireEvent.contextMenu(screen.getByTestId("version-node-root"), { clientX: 20, clientY: 20 });
    fireEvent.click(screen.getByTestId("version-menu-rename"));
    expect(screen.getByTestId("version-rename-input")).toHaveValue("Root A");
    fireEvent.contextMenu(screen.getByTestId("version-node-branch"), { clientX: 20, clientY: 20 });
    expect(screen.queryByTestId("version-rename-input")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("version-menu-preview"));
    await waitFor(() => expect(fixture.enter).toHaveBeenCalledWith({ kind: "node", nodeId: "branch" }, { label: "Alternate A" }));
    expect(screen.getByTestId("archive-details")).toHaveTextContent("Alternate A");
    expect(fixture.renameNode).not.toHaveBeenCalled();
  });
  it("recycles the previewed point only after returning to editing and offers undo", async () => {
    fixture.preview = { active: true, info: { nodeId: "root" } };
    render(<VersionNodeTrack />);
    fireEvent.contextMenu(screen.getByTestId("version-node-root"), { clientX: 20, clientY: 20 });
    fireEvent.click(screen.getByTestId("version-menu-delete"));
    await waitFor(() => expect(fixture.deleteNode).toHaveBeenCalledWith({ projectId: "project-a", nodeId: "root" }));
    expect(fixture.exit).toHaveBeenCalledOnce();
    await act(async () => { await useNotificationStore.getState().notifications[0]?.onClick?.(); });
    expect(fixture.restoreDeletedNode).toHaveBeenCalledWith({ projectId: "project-a", nodeId: "root" });
  });
  it("stable distinct colors survive rename and list ordering", () => {
    const view = render(<VersionNodeTrack />);
    const color = (id: string) => screen.getByTestId(`version-node-${id}`).querySelector('[style]')?.getAttribute("style");
    const rootColor = color("root"), childColor = color("child");
    expect(rootColor).not.toBe(childColor);
    fixture.snapshot = { ...baseSnapshot(), nodes: [...baseSnapshot().nodes].reverse().map((entry) => ({ ...entry, name: entry.id === "root" ? "Renamed" : entry.name })) };
    view.rerender(<VersionNodeTrack />);
    expect(color("root")).toBe(rootColor);
    expect(color("child")).toBe(childColor);
  });
  it("keeps missing dependencies visible in the selected details", () => {
    fixture.snapshot = { ...baseSnapshot(), nodes: [node("root", "project-a", null, "Missing", 1000, ["font-render:Unavailable"])] };
    render(<VersionNodeTrack />);
    fireEvent.click(screen.getByTestId("version-node-root"));
    expect(screen.getByTestId("archive-details")).toHaveTextContent("This save point is missing media or fonts and cannot be fully restored.");
  });
  it("shows the current load phase and offers cancellation", async () => {
    fixture.preview = {
      active: false,
      busy: true,
      info: null,
      loading: {
        generation: 2,
        source: { kind: "node", nodeId: "root" },
        label: "Root A",
        phase: "reading-snapshot",
        startedAt: performance.now(),
        cancellable: true,
      },
    };
    render(<VersionNodeTrack />);

    expect(screen.getByTestId("preview-loading-status")).toHaveTextContent("Loading “Root A”");
    expect(screen.getByTestId("preview-loading-stage")).toHaveTextContent("Reading saved project");
    fireEvent.click(screen.getByTestId("cancel-preview-loading"));
    await waitFor(() => expect(fixture.cancelPending).toHaveBeenCalledOnce());
  });
  it("cancels a busy preview before closing the archive sidebar", async () => {
    fixture.preview = {
      active: false,
      busy: true,
      info: null,
      loading: {
        generation: 3,
        source: { kind: "node", nodeId: "root" },
        label: "Root A",
        phase: "loading-fonts",
        startedAt: performance.now(),
        cancellable: true,
      },
    };
    const onClose = vi.fn();
    render(<VersionNodeTrack onClose={onClose} />);

    fireEvent.click(screen.getByTestId("close-archives"));
    await waitFor(() => expect(fixture.exit).toHaveBeenCalledOnce());
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });
});
