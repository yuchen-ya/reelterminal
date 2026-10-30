import { beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { useNotificationStore } from "../stores/notification-store";

const fixture = vi.hoisted(() => ({
  snapshot: {} as Record<string, unknown>,
  listeners: new Set<() => void>(),
  switchView: vi.fn(),
  writeText: vi.fn(),
  getStartupInfo: vi.fn(),
}));

vi.mock("./workspace-manager", () => ({
  workspaceManager: {
    subscribe: (listener: () => void) => {
      fixture.listeners.add(listener);
      return () => fixture.listeners.delete(listener);
    },
    getSnapshot: () => fixture.snapshot,
    switchView: fixture.switchView,
  },
}));

import {
  copyCurrentProjectAgentPrompt,
  switchProjectView,
} from "./project-switch-notify";

function snapshotWith(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    activeProjectId: "project-a",
    activeWorkspaceId: "workspace-a",
    projects: [
      { id: "project-a", name: "Project A", defaultWorkspaceId: "workspace-a", createdAt: 0, modifiedAt: 0 },
      { id: "project-b", name: "Project B", defaultWorkspaceId: "workspace-b", createdAt: 0, modifiedAt: 0 },
    ],
    workspaces: [
      { id: "workspace-a", projectId: "project-a", name: "Plan A", kind: "default", baseNodeId: null, revision: 1, updatedAt: 0, dirty: false },
      { id: "workspace-b", projectId: "project-b", name: "Plan B", kind: "default", baseNodeId: null, revision: 1, updatedAt: 0, dirty: false },
    ],
    nodes: [],
    ...overrides,
  };
}

function installClipboard() {
  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText: fixture.writeText },
    configurable: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useNotificationStore.getState().clearAll();
  fixture.snapshot = snapshotWith();
  fixture.writeText.mockResolvedValue(undefined);
  installClipboard();
  delete (window as { reelterminal?: unknown }).reelterminal;
});

describe("switchProjectView", () => {
  it("notifies once after a successful cross-project switch and copies the prompt on click", async () => {
    fixture.switchView.mockImplementation(async (target: { projectId: string; workspaceId: string }) => {
      fixture.snapshot = snapshotWith({ activeProjectId: target.projectId, activeWorkspaceId: target.workspaceId });
    });
    (window as { reelterminal?: unknown }).reelterminal = {
      collabControl: { getStartupInfo: fixture.getStartupInfo },
    };
    fixture.getStartupInfo.mockResolvedValue({ startCommand: "reel.cmd start --target rt1.project-b-workspace-b" });

    await switchProjectView({ projectId: "project-b", workspaceId: "workspace-b" });
    expect(fixture.switchView).toHaveBeenCalledWith({ projectId: "project-b", workspaceId: "workspace-b" });

    const notifications = useNotificationStore.getState().notifications;
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toBe('Switched to "Project B"');
    expect(notifications[0].onClickLabel).toBe("Copy Agent prompt");
    expect(notifications[0].duration).toBe(8000);

    // Never auto-copies; copying happens only when the user clicks.
    expect(fixture.writeText).not.toHaveBeenCalled();
    notifications[0].onClick?.();
    await waitFor(() => expect(fixture.writeText).toHaveBeenCalledTimes(1));
    const prompt = fixture.writeText.mock.calls[0][0] as string;
    expect(prompt).toBe("Run now: reel.cmd start --target rt1.project-b-workspace-b");
    expect(fixture.getStartupInfo).toHaveBeenCalledWith({ kind: "video", projectId: "project-b", workspaceId: "workspace-b" });

    await waitFor(() =>
      expect(useNotificationStore.getState().notifications.some((entry) => entry.title === "Agent prompt copied")).toBe(true),
    );
    expect(useNotificationStore.getState().notifications.some((entry) => entry.id === notifications[0].id)).toBe(false);
  });

  it("reports unavailable desktop startup information without copying an unbound prompt", async () => {
    await expect(copyCurrentProjectAgentPrompt()).rejects.toThrow("Desktop startup information is unavailable");
    expect(fixture.writeText).not.toHaveBeenCalled();
  });

  it("does not notify for a same-project workspace switch", async () => {
    fixture.switchView.mockImplementation(async (target: { projectId: string; workspaceId: string }) => {
      fixture.snapshot = snapshotWith({ activeProjectId: target.projectId, activeWorkspaceId: target.workspaceId });
    });
    await switchProjectView({ projectId: "project-a", workspaceId: "workspace-a" });
    expect(fixture.switchView).toHaveBeenCalled();
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });

  it("replaces the previous notification instead of stacking", async () => {
    fixture.switchView.mockImplementation(async (target: { projectId: string; workspaceId: string }) => {
      fixture.snapshot = snapshotWith({ activeProjectId: target.projectId, activeWorkspaceId: target.workspaceId });
    });
    await switchProjectView({ projectId: "project-b", workspaceId: "workspace-b" });
    fixture.snapshot = snapshotWith({ activeProjectId: "project-a", activeWorkspaceId: "workspace-a" });
    await switchProjectView({ projectId: "project-b", workspaceId: "workspace-b" });
    const notifications = useNotificationStore.getState().notifications;
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toBe('Switched to "Project B"');
  });

  it("does not notify when the switch fails", async () => {
    fixture.switchView.mockRejectedValue(new Error("Workspace vanished"));
    await expect(switchProjectView({ projectId: "project-b", workspaceId: "workspace-b" })).rejects.toThrow(
      "Workspace vanished",
    );
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });
});

describe("copyCurrentProjectAgentPrompt", () => {
  it("copies the prompt for the currently active target", async () => {
    fixture.snapshot = snapshotWith();
    (window as { reelterminal?: unknown }).reelterminal = { collabControl: { getStartupInfo: fixture.getStartupInfo } };
    fixture.getStartupInfo.mockResolvedValue({ startCommand: "reel.cmd start --target rt1.project-a-workspace-a" });
    await copyCurrentProjectAgentPrompt();
    expect(fixture.writeText).toHaveBeenCalledWith("Run now: reel.cmd start --target rt1.project-a-workspace-a");
    expect(fixture.getStartupInfo).toHaveBeenCalledWith({ kind: "video", projectId: "project-a", workspaceId: "workspace-a" });
  });

  it("throws when no project is active", async () => {
    fixture.snapshot = snapshotWith({ activeProjectId: null, activeWorkspaceId: null });
    await expect(copyCurrentProjectAgentPrompt()).rejects.toThrow("No active project workspace");
    expect(fixture.writeText).not.toHaveBeenCalled();
  });
});
