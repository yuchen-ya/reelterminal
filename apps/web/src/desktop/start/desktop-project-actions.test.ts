import { describe, it, expect, vi, beforeEach } from "vitest";

const stubs = vi.hoisted(() => ({
  createNewProject: vi.fn(),
  loadProject: vi.fn(),
  manager: {
    getRecentProjects: vi.fn(),
    openProject: vi.fn(),
    openRecentProject: vi.fn(),
  },
  loadProjectMedia: vi.fn(),
  restoreMediaItem: vi.fn(),
}));

vi.mock("../../stores/project-store", () => ({
  useProjectStore: {
    getState: vi.fn(() => ({
      createNewProject: stubs.createNewProject,
      loadProject: stubs.loadProject,
    })),
  },
}));

vi.mock("../../services/project-manager", () => ({
  projectManager: stubs.manager,
}));

vi.mock("../../services/media-storage", () => ({
  loadProjectMedia: stubs.loadProjectMedia,
}));

vi.mock("../../utils/media-recovery", () => ({
  restoreMediaItem: stubs.restoreMediaItem,
}));

import {
  DESKTOP_FORMATS,
  startNewProject,
  startNewMotionProject,
  listRecentProjects,
  openProject,
  openRecentProject,
} from "./desktop-project-actions";

beforeEach(() => {
  vi.clearAllMocks();
  stubs.manager.getRecentProjects.mockResolvedValue([]);
  stubs.manager.openProject.mockResolvedValue(null);
  stubs.manager.openRecentProject.mockResolvedValue(null);
  stubs.loadProjectMedia.mockResolvedValue([]);
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
  it("calls createNewProject with the format label and dimensions", () => {
    const format = DESKTOP_FORMATS[1];
    startNewProject(format);
    expect(stubs.createNewProject).toHaveBeenCalledWith("Horizontal", {
      width: 1920,
      height: 1080,
      frameRate: 30,
    });
  });
});

describe("startNewMotionProject", () => {
  it("creates a Motion Creator project with the selected format dimensions", () => {
    startNewMotionProject(DESKTOP_FORMATS[0]);
    expect(stubs.createNewProject).toHaveBeenCalledWith("Vertical Motion Creator", {
      width: 1080,
      height: 1920,
      frameRate: 30,
    });
  });
});

describe("recent projects", () => {
  it("maps project-manager recents to the start screen shape", async () => {
    stubs.manager.getRecentProjects.mockResolvedValue([
      { id: "project-a", name: "Alpha", lastOpened: 2000, fileHandle: { kind: "native", path: "a" } },
      { id: "project-b", name: "Beta", lastOpened: 3000 },
    ]);

    await expect(listRecentProjects()).resolves.toEqual([
      { id: "project-a", name: "Alpha", lastOpened: 2000 },
      { id: "project-b", name: "Beta", lastOpened: 3000 },
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
    expect(stubs.loadProject).toHaveBeenCalledWith({
      ...project,
      mediaLibrary: { items: [restoredItem] },
    });
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
    expect(stubs.loadProject).toHaveBeenCalledWith(project);
  });
});
