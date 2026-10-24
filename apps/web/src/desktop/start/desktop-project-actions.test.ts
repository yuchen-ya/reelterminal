import { describe, it, expect, vi, beforeEach } from "vitest";

const stubs = vi.hoisted(() => ({
  createNewProject: vi.fn(),
  loadProject: vi.fn(),
  recoverFromAutoSave: vi.fn(),
  checkForRecovery: vi.fn(),
  recover: vi.fn(),
  forceSave: vi.fn(),
  hasOpenProject: false,
  manager: {
    getRecentProjects: vi.fn(),
    openProject: vi.fn(),
    openRecentProject: vi.fn(),
    addToRecent: vi.fn(),
  },
  workspace: {
    listProjects: vi.fn(),
    createProject: vi.fn(),
    switchView: vi.fn(),
    // Consumed by the project-switch notification path (no active project in
    // these stubs, so no switch notification fires).
    subscribe: vi.fn(() => () => {}),
    getSnapshot: vi.fn(() => ({
      version: 0,
      activeProjectId: null,
      activeWorkspaceId: null,
      projects: [],
      workspaces: [],
      nodes: [],
    })),
  },
  loadProjectMedia: vi.fn(),
  restoreMediaItem: vi.fn(),
}));

vi.mock("../../stores/project-store", () => ({
  useProjectStore: {
    getState: vi.fn(() => ({
      createNewProject: stubs.createNewProject,
      loadProject: stubs.loadProject,
      recoverFromAutoSave: stubs.recoverFromAutoSave,
      forceSave: stubs.forceSave,
      hasOpenProject: stubs.hasOpenProject,
    })),
  },
}));

vi.mock("../../services/project-manager", () => ({
  projectManager: stubs.manager,
}));
vi.mock("../../services/auto-save", () => ({
  autoSaveManager: { checkForRecovery: stubs.checkForRecovery, recover: stubs.recover },
}));
vi.mock("../../services/workspace-manager", () => ({ workspaceManager: stubs.workspace }));

vi.mock("../../services/media-storage", () => ({
  loadProjectMedia: stubs.loadProjectMedia,
}));

vi.mock("../../utils/media-recovery", () => ({
  restoreMediaItem: stubs.restoreMediaItem,
}));

import {
  DESKTOP_FORMATS,
  startNewProject,
  listRecentProjects,
  openProject,
  openRecentProject,
} from "./desktop-project-actions";

beforeEach(() => {
  vi.clearAllMocks();
  stubs.manager.getRecentProjects.mockResolvedValue([]);
  stubs.manager.openProject.mockResolvedValue(null);
  stubs.manager.openRecentProject.mockResolvedValue(null);
  stubs.manager.addToRecent.mockResolvedValue(undefined);
  stubs.workspace.listProjects.mockResolvedValue([]);
  stubs.workspace.createProject.mockImplementation(async (project) => ({ project, defaultWorkspaceId: "default-workspace" }));
  stubs.workspace.switchView.mockResolvedValue(undefined);
  stubs.loadProjectMedia.mockResolvedValue([]);
  stubs.checkForRecovery.mockResolvedValue([]);
  stubs.hasOpenProject = false;
  stubs.forceSave.mockReset().mockResolvedValue(undefined);
});

describe("DESKTOP_FORMATS", () => {
  it("contains vertical, horizontal, and square at 30fps with correct dimensions", () => {
    expect(DESKTOP_FORMATS).toHaveLength(3);
    expect(DESKTOP_FORMATS.find((f) => f.id === "vertical")).toMatchObject({
      label: "Vertical",
      width: 1080,
      height: 1920,
      frameRate: 30,
    });
    expect(DESKTOP_FORMATS.find((f) => f.id === "horizontal")).toMatchObject({
      label: "Horizontal",
      width: 1920,
      height: 1080,
      frameRate: 30,
    });
    expect(DESKTOP_FORMATS.find((f) => f.id === "square")).toMatchObject({
      label: "Square",
      width: 1080,
      height: 1080,
      frameRate: 30,
    });
  });
});

describe("startNewProject", () => {
  it("stores the allocated name in recent projects instead of the requested name", async () => {
    stubs.workspace.createProject.mockImplementation(async (project) => ({
      project: { ...project, name: "Horizontal 2" }, defaultWorkspaceId: "default-workspace",
    }));
    await startNewProject(DESKTOP_FORMATS[1]);
    expect(stubs.manager.addToRecent).toHaveBeenCalledWith(expect.objectContaining({ name: "Horizontal 2" }));
  });
  it("persists a default workspace with the format label and dimensions before showing it", async () => {
    const format = DESKTOP_FORMATS[1];
    await startNewProject(format);
    expect(stubs.workspace.createProject).toHaveBeenCalledWith(expect.objectContaining({ name: "Horizontal", settings: expect.objectContaining({
      width: 1920,
      height: 1080,
      frameRate: 30,
    }) }));
    expect(stubs.workspace.switchView).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "default-workspace" }));
    expect(stubs.workspace.createProject.mock.invocationCallOrder[0]).toBeLessThan(stubs.workspace.switchView.mock.invocationCallOrder[0]);
  });
});

describe("recent projects", () => {
  it("excludes recycled and purged ids from legacy recents and refuses their recovery", async () => {
    stubs.workspace.listProjects.mockResolvedValue([
      { id: "recycled", recycledAt: 1 }, { id: "purged", deletedAt: 2 },
    ]);
    stubs.manager.getRecentProjects.mockResolvedValue([
      { id: "recycled", name: "Recycled", lastOpened: 3 },
      { id: "purged", name: "Purged", lastOpened: 3 },
    ]);
    stubs.checkForRecovery.mockResolvedValue([{ id: "old-save", projectId: "recycled", projectName: "Old recovery", timestamp: 4 }]);
    expect(await listRecentProjects()).toEqual([]);
    expect(await openRecentProject("recycled")).toBe(false);
    expect(await openRecentProject("purged")).toBe(false);
    expect(stubs.recover).not.toHaveBeenCalled();
    expect(stubs.manager.openRecentProject).not.toHaveBeenCalled();
    expect(stubs.workspace.switchView).not.toHaveBeenCalled();
  });
  it("saves the current project before opening the picker, and preserves it on cancellation", async () => {
    stubs.hasOpenProject = true;
    await expect(openProject()).resolves.toBe(false);
    expect(stubs.forceSave).toHaveBeenCalledOnce();
    expect(stubs.forceSave.mock.invocationCallOrder[0]).toBeLessThan(stubs.manager.openProject.mock.invocationCallOrder[0]);
    expect(stubs.loadProject).not.toHaveBeenCalled();
  });

  it("blocks file and recent-project switching after a failed save", async () => {
    stubs.hasOpenProject = true;
    stubs.forceSave.mockRejectedValue(new Error("storage full"));
    await expect(openProject()).rejects.toThrow("storage full");
    await expect(openRecentProject("project-a")).rejects.toThrow("storage full");
    expect(stubs.manager.openProject).not.toHaveBeenCalled();
    expect(stubs.manager.openRecentProject).not.toHaveBeenCalled();
    expect(stubs.recoverFromAutoSave).not.toHaveBeenCalled();
  });
  it("lists autosave-only projects once and reopens the latest slot", async () => {
    stubs.checkForRecovery.mockResolvedValue([
      { id: "old", projectId: "project-a", projectName: "Old name", timestamp: 1000 },
      { id: "latest", projectId: "project-a", projectName: "Recovered", timestamp: 3000 },
    ]);
    stubs.recover.mockResolvedValue({ id: "project-a", name: "Recovered", mediaLibrary: { items: [] } });

    await expect(listRecentProjects()).resolves.toEqual([
      { id: "project-a", name: "Recovered", lastOpened: 3000, recoverySaveId: "latest" },
    ]);
    await expect(openRecentProject("project-a")).resolves.toBe(true);
    expect(stubs.recover).toHaveBeenCalledWith("latest");
    expect(stubs.manager.openRecentProject).not.toHaveBeenCalled();
  });

  it("chooses newer autosaves over a recent snapshot and retains newer file entries", async () => {
    stubs.manager.getRecentProjects.mockResolvedValue([
      { id: "project-a", name: "Saved", lastOpened: 1000 },
      { id: "project-b", name: "File", lastOpened: 4000, fileHandle: { kind: "native", path: "b.oreel" } },
    ]);
    stubs.checkForRecovery.mockResolvedValue([
      { id: "latest-a", projectId: "project-a", projectName: "Edited", timestamp: 3000 },
      { id: "older-b", projectId: "project-b", projectName: "Old", timestamp: 2000 },
    ]);

    await expect(listRecentProjects()).resolves.toEqual([
      { id: "project-b", name: "File", lastOpened: 4000 },
      { id: "project-a", name: "Edited", lastOpened: 3000, recoverySaveId: "latest-a" },
    ]);
  });

  it("maps project-manager recents to the start screen shape", async () => {
    stubs.manager.getRecentProjects.mockResolvedValue([
      { id: "project-a", name: "Alpha", lastOpened: 2000, fileHandle: { kind: "native", path: "a" } },
      { id: "project-b", name: "Beta", lastOpened: 3000 },
    ]);

    await expect(listRecentProjects()).resolves.toEqual([
      { id: "project-b", name: "Beta", lastOpened: 3000 },
      { id: "project-a", name: "Alpha", lastOpened: 2000 },
    ]);
    expect(stubs.manager.getRecentProjects).toHaveBeenCalledOnce();
  });

  it("opens the selected recent project, restores media, and loads it into the store", async () => {
    const item = { id: "media-1", type: "video" };
    const restoredItem = { ...item, blob: new Blob(["media"]) };
    const project = {
      id: "project-a",
      name: "Alpha",
      timeline: { duration: 0, tracks: [] },
      mediaLibrary: { items: [item] },
    };
    const blob = new Blob(["media"]);
    stubs.manager.getRecentProjects.mockResolvedValue([
      { id: "project-a", name: "Alpha", lastOpened: 2000 },
    ]);
    stubs.manager.openRecentProject.mockResolvedValue(project);
    stubs.loadProjectMedia.mockResolvedValue([{ id: "media-1", blob }]);
    stubs.restoreMediaItem.mockResolvedValue(restoredItem);

    await expect(openRecentProject("project-a")).resolves.toBe(true);

    expect(stubs.manager.openRecentProject).toHaveBeenCalledWith(
      expect.objectContaining({ id: "project-a", name: "Alpha" }),
    );
    expect(stubs.restoreMediaItem).toHaveBeenCalledWith(item, blob);
    expect(stubs.workspace.createProject).toHaveBeenCalledWith({
      ...project,
      mediaLibrary: { items: [restoredItem] },
    }, { deduplicateName: false });
  });

  it("returns false when the project-manager cannot open the selected item", async () => {
    stubs.manager.getRecentProjects.mockResolvedValue([
      { id: "missing", name: "Missing", lastOpened: 2000 },
    ]);
    stubs.manager.openRecentProject.mockResolvedValue(null);

    await expect(openRecentProject("missing")).resolves.toBe(false);
    expect(stubs.loadProject).not.toHaveBeenCalled();
  });

  it("opens a project through the file picker and adopts it into the store", async () => {
    const project = {
      id: "picked",
      name: "Picked",
      timeline: { duration: 0, tracks: [] },
      mediaLibrary: { items: [] },
    };
    stubs.manager.openProject.mockResolvedValue(project);

    await expect(openProject()).resolves.toBe(true);
    expect(stubs.workspace.createProject).toHaveBeenCalledWith(project, { deduplicateName: false });
  });

  it("resumes an existing workspace instead of overwriting it with a recent file", async () => {
    stubs.workspace.listProjects.mockResolvedValue([{ id: "project-a", defaultWorkspaceId: "workspace-a" }]);
    await expect(openRecentProject("project-a")).resolves.toBe(true);
    expect(stubs.workspace.switchView).toHaveBeenCalledWith({ projectId: "project-a", workspaceId: "workspace-a" });
    expect(stubs.manager.openRecentProject).not.toHaveBeenCalled();
    expect(stubs.workspace.createProject).not.toHaveBeenCalled();
  });

  it("imports a same-identity project file as a distinct project without replacing the existing workspace", async () => {
    stubs.workspace.listProjects.mockResolvedValue([{ id: "same-id", defaultWorkspaceId: "old-workspace" }]);
    stubs.manager.openProject.mockResolvedValue({ id: "same-id", name: "Saved file", mediaLibrary: { items: [] } });
    await expect(openProject()).resolves.toBe(true);
    const imported = stubs.workspace.createProject.mock.calls[0][0];
    expect(imported.id).not.toBe("same-id");
    expect(imported.name).toContain("Imported copy");
  });
});
