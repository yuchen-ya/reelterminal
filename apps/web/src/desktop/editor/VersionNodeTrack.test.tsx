import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useNotificationStore } from "../../stores/notification-store";

const fixture = vi.hoisted(() => ({
  snapshot: {} as Record<string, unknown>,
  preview: { active: false, busy: false, info: null } as Record<string, unknown>,
  listeners: new Set<() => void>(),
  enter: vi.fn(),
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
  useNotificationStore.getState().clearAll();
  fixture.snapshot = baseSnapshot();
  fixture.preview = { active: false, busy: false, info: null };
  fixture.enter.mockResolvedValue(undefined);
  fixture.exit.mockResolvedValue(undefined);
  fixture.adopt.mockResolvedValue(undefined);
  fixture.renameNode.mockImplementation(async (_input: { name: string }) => ({
    ...node("root", "project-a", null, _input.name),
  }));
  fixture.deleteNode.mockResolvedValue(undefined);
  fixture.restoreDeletedNode.mockResolvedValue(undefined);
});

describe("VersionNodeTrack", () => {
  it("renders nothing when the project has no nodes and no trial plans", () => {
    fixture.snapshot = { ...baseSnapshot(), nodes: [] };
    const { container } = render(<VersionNodeTrack />);
    expect(container.querySelector('[data-testid="version-track"]')).toBeNull();
    expect(screen.queryByLabelText("Version track")).not.toBeInTheDocument();
  });

  it("renders the project's dots from summaries only, without persistent labels", () => {
    render(<VersionNodeTrack />);
    expect(screen.getByTestId("version-track")).toHaveAttribute("data-project-id", "project-a");
    expect(screen.getByTestId("version-node-root")).toBeInTheDocument();
    expect(screen.getByTestId("version-node-child")).toBeInTheDocument();
    expect(screen.getByTestId("version-node-branch")).toBeInTheDocument();
    expect(screen.queryByTestId("version-node-foreign")).not.toBeInTheDocument();
    // No persistent name/date copy; tooltip only on demand.
    expect(screen.queryByText("Root A")).not.toBeInTheDocument();
    expect(screen.queryByTestId("version-node-tooltip")).not.toBeInTheDocument();
  });

  it("marks the active workspace's base node with the accent fill and ring", () => {
    render(<VersionNodeTrack />);
    const base = screen.getByTestId("version-node-child");
    expect(base).toHaveAttribute("data-base", "true");
    expect(base.querySelector("span")).toHaveClass("bg-accent");
    expect(base.querySelector("span")).toHaveClass("ring-accent");
    const other = screen.getByTestId("version-node-root");
    expect(other.querySelector("span")).not.toHaveClass("bg-accent");
  });

  it("distinguishes the previewed node by shape and dashed outline, not brightness", () => {
    fixture.preview = {
      active: true,
      busy: false,
      info: { projectId: "project-a", nodeId: "root", workspaceId: null, nodeName: "Root A", summary: "", createdAt: 1_000, missingDependencies: [], agentTrial: false },
    };
    render(<VersionNodeTrack />);
    const previewDot = screen.getByTestId("version-node-root").querySelector("span");
    expect(previewDot).toHaveClass("rotate-45");
    expect(previewDot).toHaveClass("outline-dashed");
    // The base node keeps its accent while a historical version is previewed.
    const baseDot = screen.getByTestId("version-node-child").querySelector("span");
    expect(baseDot).toHaveClass("bg-accent");
    expect(baseDot).not.toHaveClass("rotate-45");
  });

  it("selects on single click without entering a preview", () => {
    render(<VersionNodeTrack />);
    const dot = screen.getByTestId("version-node-root");
    expect(dot).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(dot);
    expect(dot).toHaveAttribute("aria-pressed", "true");
    expect(fixture.enter).not.toHaveBeenCalled();
  });

  it("previews on double click and on Enter", () => {
    render(<VersionNodeTrack />);
    fireEvent.doubleClick(screen.getByTestId("version-node-root"));
    expect(fixture.enter).toHaveBeenCalledWith({ kind: "node", nodeId: "root" });
    fireEvent.keyDown(screen.getByTestId("version-node-child"), { key: "Enter" });
    expect(fixture.enter).toHaveBeenCalledWith({ kind: "node", nodeId: "child" });
  });

  it("opens a four-action context menu on right click and closes on Escape", () => {
    render(<VersionNodeTrack />);
    fireEvent.contextMenu(screen.getByTestId("version-node-root"), { clientX: 10, clientY: 10 });
    const menu = screen.getByTestId("version-node-menu");
    expect(menu).toBeInTheDocument();
    expect(screen.getByTestId("version-menu-preview")).toHaveTextContent("Preview this version");
    expect(screen.getByTestId("version-menu-rename")).toHaveTextContent("Rename");
    expect(screen.getByTestId("version-menu-adopt")).toHaveTextContent("Continue editing from here");
    expect(screen.getByTestId("version-menu-delete")).toHaveTextContent("Delete this version");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("version-node-menu")).not.toBeInTheDocument();
  });

  it("previews and adopts through the menu actions", async () => {
    render(<VersionNodeTrack />);
    fireEvent.contextMenu(screen.getByTestId("version-node-root"), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByTestId("version-menu-preview"));
    expect(fixture.enter).toHaveBeenCalledWith({ kind: "node", nodeId: "root" });

    fireEvent.contextMenu(screen.getByTestId("version-node-root"), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByTestId("version-menu-adopt"));
    await waitFor(() => expect(fixture.adopt).toHaveBeenCalled());
    expect(fixture.enter).toHaveBeenCalledWith({ kind: "node", nodeId: "root" });
    expect(fixture.enter.mock.invocationCallOrder[0]).toBeLessThan(fixture.adopt.mock.invocationCallOrder[0]);
  });

  it("commits a trimmed rename inline and never creates a node", async () => {
    render(<VersionNodeTrack />);
    fireEvent.contextMenu(screen.getByTestId("version-node-root"), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByTestId("version-menu-rename"));
    const input = screen.getByTestId("version-rename-input");
    expect(input).toHaveValue("Root A");
    fireEvent.change(input, { target: { value: "  Renamed stage  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(fixture.renameNode).toHaveBeenCalledWith({
        projectId: "project-a",
        nodeId: "root",
        name: "Renamed stage",
      }),
    );
    expect(fixture.deleteNode).not.toHaveBeenCalled();
    expect(fixture.enter).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId("version-node-menu")).not.toBeInTheDocument());
  });

  it("rejects an empty rename locally without a request and cancels cleanly", async () => {
    render(<VersionNodeTrack />);
    fireEvent.contextMenu(screen.getByTestId("version-node-root"), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByTestId("version-menu-rename"));
    const input = screen.getByTestId("version-rename-input");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(fixture.renameNode).not.toHaveBeenCalled();
    expect(input).toHaveAttribute("aria-invalid", "true");
    fireEvent.click(screen.getByTestId("version-rename-cancel"));
    expect(fixture.renameNode).not.toHaveBeenCalled();
    expect(screen.queryByTestId("version-node-menu")).not.toBeInTheDocument();
  });

  it("deletes via the menu, exiting an active preview of that node first, and supports undo", async () => {
    fixture.preview = {
      active: true,
      busy: false,
      info: { projectId: "project-a", nodeId: "root", workspaceId: null, nodeName: "Root A", summary: "", createdAt: 1_000, missingDependencies: [], agentTrial: false },
    };
    render(<VersionNodeTrack />);
    fireEvent.contextMenu(screen.getByTestId("version-node-root"), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByTestId("version-menu-delete"));
    await waitFor(() => expect(fixture.deleteNode).toHaveBeenCalledWith({ projectId: "project-a", nodeId: "root" }));
    expect(fixture.exit).toHaveBeenCalled();
    expect(fixture.exit.mock.invocationCallOrder[0]).toBeLessThan(fixture.deleteNode.mock.invocationCallOrder[0]);

    const notification = useNotificationStore
      .getState()
      .notifications.find((entry) => entry.title === "Version moved to the recycle bin");
    expect(notification).toBeDefined();
    expect(notification?.onClickLabel).toBe("Undo delete");
    expect(notification?.duration).toBe(6000);

    act(() => {
      notification?.onClick?.();
    });
    await waitFor(() =>
      expect(fixture.restoreDeletedNode).toHaveBeenCalledWith({ projectId: "project-a", nodeId: "root" }),
    );
    expect(
      useNotificationStore.getState().notifications.some((entry) => entry.id === notification?.id),
    ).toBe(false);
  });

  it("shows the non-interactive current-edit endpoint chip when the base node is recycled", () => {
    fixture.snapshot = {
      ...baseSnapshot(),
      workspaces: [
        { id: "workspace-a", projectId: "project-a", name: "Default", kind: "default", baseNodeId: "recycled", revision: 9, updatedAt: 0, dirty: false },
      ],
    };
    render(<VersionNodeTrack />);
    const chip = screen.getByTestId("current-edit-endpoint");
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveTextContent("Current editing");
    expect(chip.tagName).toBe("SPAN");
    expect(screen.queryByTestId("version-node-recycled")).not.toBeInTheDocument();
  });

  it("renders Agent trial workspaces as separate hollow diamonds previewing the workspace", () => {
    fixture.snapshot = {
      ...baseSnapshot(),
      workspaces: [
        ...(baseSnapshot().workspaces as unknown[]),
        { id: "trial-1", projectId: "project-a", name: "Trial", kind: "trial", baseNodeId: "root", revision: 1, updatedAt: 0, dirty: false },
      ],
    };
    render(<VersionNodeTrack />);
    const trial = screen.getByTestId("version-trial-trial-1");
    expect(trial).toHaveAttribute("aria-label", "Agent trial cut");
    fireEvent.doubleClick(trial);
    expect(fixture.enter).toHaveBeenCalledWith({ kind: "workspace", workspaceId: "trial-1" });
  });

  it("shows name, date, summary and missing-dependency warnings in the hover tooltip", () => {
    fixture.snapshot = {
      ...baseSnapshot(),
      nodes: [node("root", "project-a", null, "Root A", 1_000, ["media-1"])],
      workspaces: [
        { id: "workspace-a", projectId: "project-a", name: "Default", kind: "default", baseNodeId: "root", revision: 7, updatedAt: 0, dirty: false },
      ],
    };
    render(<VersionNodeTrack />);
    const dot = screen.getByTestId("version-node-root");
    fireEvent.mouseEnter(dot);
    const tooltip = screen.getByTestId("version-node-tooltip");
    expect(tooltip).toHaveTextContent("Root A");
    expect(tooltip).toHaveTextContent(new Date(1_000).toLocaleString());
    expect(tooltip).toHaveTextContent("Stage summary");
    expect(tooltip).toHaveTextContent("Missing dependencies");
    fireEvent.mouseLeave(dot);
    expect(screen.queryByTestId("version-node-tooltip")).not.toBeInTheDocument();
  });

  it("keeps off-mainline nodes on a secondary row with a fold indicator for deeper subtrees", () => {
    fixture.snapshot = {
      ...baseSnapshot(),
      nodes: [
        node("root", "project-a", null, "Root A", 1_000),
        node("child", "project-a", "root", "Continuation A", 2_000),
        node("branch", "project-a", "root", "Alternate A", 1_500),
        node("deep", "project-a", "branch", "Deep A", 1_600),
      ],
    };
    render(<VersionNodeTrack />);
    const fold = screen.getByTestId("branch-fold-branch");
    expect(fold).toHaveAttribute("aria-expanded", "false");
    // Deeper descendants stay folded until the indicator is clicked.
    expect(screen.queryByTestId("version-node-deep")).not.toBeInTheDocument();
    fireEvent.click(fold);
    expect(screen.getByTestId("branch-fold-branch")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("version-node-deep")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("branch-fold-branch"));
    expect(screen.queryByTestId("version-node-deep")).not.toBeInTheDocument();
  });
});
