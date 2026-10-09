import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useNotificationStore } from "../../stores/notification-store";

const fixture = vi.hoisted(() => ({
  snapshot: {} as Record<string, unknown>,
  listeners: new Set<() => void>(),
  saveNode: vi.fn(),
  createWorkspace: vi.fn(),
  switchView: vi.fn(),
  copyPrompt: vi.fn(),
  setDesktopPage: vi.fn(),
}));

vi.mock("../../services/workspace-manager", () => ({
  workspaceManager: {
    subscribe: (listener: () => void) => {
      fixture.listeners.add(listener);
      return () => fixture.listeners.delete(listener);
    },
    getSnapshot: () => fixture.snapshot,
    saveNode: fixture.saveNode,
    createWorkspace: fixture.createWorkspace,
    switchView: fixture.switchView,
  },
}));

vi.mock("../../services/project-switch-notify", () => ({
  copyCurrentProjectAgentPrompt: fixture.copyPrompt,
}));

vi.mock("../../desktop/start/desktop-project-actions", () => ({
  listRecentProjects: async () => [],
  openProject: async () => true,
  openRecentProject: async () => true,
}));

vi.mock("../../stores/project-store", () => ({
  useProjectStore: (selector?: (state: Record<string, unknown>) => unknown) => {
    const state = {
      project: { id: "project-a", name: "Project A" },
      createNewProject: vi.fn(),
      hasOpenProject: true,
    };
    return selector ? selector(state) : state;
  },
}));

vi.mock("../../stores/ui-store", () => ({
  useUIStore: Object.assign((selector?: (state: Record<string, unknown>) => unknown) => selector?.({}) ?? null, {
    getState: () => ({ setDesktopPage: fixture.setDesktopPage, openModal: vi.fn() }),
  }),
}));

vi.mock("../../desktop/editor/RecoveryDraftsDialog", () => ({
  RecoveryDraftsDialog: ({ target }: { target?: { workspaceId?: string } }) => (
    <div data-testid="recovery-drafts-dialog" data-target-workspace={target?.workspaceId ?? ""} />
  ),
}));

import { ProjectSwitcher } from "./ProjectSwitcher";

function snapshotWith(workspaces: unknown[]) {
  return {
    version: 1,
    activeProjectId: "project-a",
    activeWorkspaceId: "workspace-a",
    projects: [
      { id: "project-a", name: "Project A", defaultWorkspaceId: "workspace-a", createdAt: 0, modifiedAt: 0 },
    ],
    workspaces,
    nodes: [],
  };
}

async function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "Project A" }));
  await waitFor(() => expect(screen.getByText("Project actions")).toBeInTheDocument());
}

beforeEach(() => {
  vi.clearAllMocks();
  useNotificationStore.getState().clearAll();
  fixture.snapshot = snapshotWith([
    { id: "workspace-a", projectId: "project-a", name: "Plan A", kind: "default", baseNodeId: null, revision: 1, updatedAt: 0, dirty: false },
  ]);
  fixture.saveNode.mockResolvedValue({ node: { id: "node-1", name: "Snapshot 1" }, revision: 2, replayed: false });
  fixture.createWorkspace.mockResolvedValue({ id: "new-trial", projectId: "project-a", name: "Trial", kind: "trial", baseNodeId: null, revision: 0, updatedAt: 0, dirty: false });
  fixture.switchView.mockResolvedValue(undefined);
  fixture.copyPrompt.mockResolvedValue(undefined);
});

describe("ProjectSwitcher versioning actions", () => {
  it("shows the project action entries and hides the plans section for a single workspace", async () => {
    render(<ProjectSwitcher />);
    await openMenu();
    expect(screen.getByRole("button", { name: "Create save point" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Recover previous edits" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy Agent prompt" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try another cut" })).toBeInTheDocument();
    expect(screen.queryByText("Editing plans")).not.toBeInTheDocument();
  });

  it("retains a version without a name and toasts the auto-generated node name", async () => {
    render(<ProjectSwitcher />);
    await openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Create save point" }));
    await waitFor(() =>
      expect(fixture.saveNode).toHaveBeenCalledWith({
        target: { projectId: "project-a", workspaceId: "workspace-a" },
      }),
    );
    await waitFor(() =>
      expect(
        useNotificationStore.getState().notifications.some((entry) => entry.title === 'Save point “Snapshot 1” created'),
      ).toBe(true),
    );
  });

  it("opens the recovery drafts dialog for the active target", async () => {
    render(<ProjectSwitcher />);
    await openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Recover previous edits" }));
    await waitFor(() => expect(screen.getByTestId("recovery-drafts-dialog")).toBeInTheDocument());
    expect(screen.getByTestId("recovery-drafts-dialog")).toHaveAttribute("data-target-workspace", "workspace-a");
  });

  it("copies the current project's Agent prompt from the menu", async () => {
    render(<ProjectSwitcher />);
    await openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Copy Agent prompt" }));
    await waitFor(() => expect(fixture.copyPrompt).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        useNotificationStore.getState().notifications.some((entry) => entry.title === "Agent prompt copied"),
      ).toBe(true),
    );
  });

  it("creates an isolated trial plan from the current edit and switches to it", async () => {
    render(<ProjectSwitcher />);
    await openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Try another cut" }));
    await waitFor(() =>
      expect(fixture.createWorkspace).toHaveBeenCalledWith("project-a", { sourceWorkspaceId: "workspace-a" }),
    );
    await waitFor(() =>
      expect(fixture.switchView).toHaveBeenCalledWith({ projectId: "project-a", workspaceId: "new-trial" }),
    );
  });

  it("lists editing plans only with multiple workspaces and switches within the same project", async () => {
    render(<ProjectSwitcher />);
    await act(async () => {
      fixture.snapshot = snapshotWith([
        { id: "workspace-a", projectId: "project-a", name: "Plan A", kind: "default", baseNodeId: null, revision: 1, updatedAt: 0, dirty: false },
        { id: "trial-1", projectId: "project-a", name: "Alt cut", kind: "trial", baseNodeId: null, revision: 1, updatedAt: 0, dirty: false },
      ]);
      fixture.listeners.forEach((listener) => listener());
    });
    await openMenu();
    expect(screen.getByText("Editing plans")).toBeInTheDocument();
    const plan = screen.getByRole("button", { name: "Alt cut" });
    expect(plan).toBeInTheDocument();
    fireEvent.click(plan);
    await waitFor(() =>
      expect(fixture.switchView).toHaveBeenCalledWith({ projectId: "project-a", workspaceId: "trial-1" }),
    );
  });
});
