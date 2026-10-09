// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import type { Project } from "@reelterminal/core";
import { ProjectManager, projectManager } from "./project-manager";

const indexedDb = new IDBFactory();
vi.stubGlobal("indexedDB", indexedDb);

function makeProject(id: string, name: string): Project {
  return {
    id,
    name,
    createdAt: 1,
    modifiedAt: 1,
    settings: {
      width: 1920,
      height: 1080,
      frameRate: 30,
      sampleRate: 48000,
      channels: 2,
    },
    timeline: { duration: 2, tracks: [], markers: [], subtitles: [] },
    mediaLibrary: { items: [] },
  } as Project;
}

beforeEach(async () => {
  await projectManager.initialize();
  await projectManager.clearRecentProjects();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ProjectManager recent projects", () => {
  it("keeps the recovered snapshot reopenable instead of reopening its older file", async () => {
    const project = makeProject("recovered-file-test", "Recovered edit");
    await projectManager.addToRecent(project, { kind: "native", path: "C:/projects/old.oreel" });
    await projectManager.addToRecent(project, null);

    const recent = (await projectManager.getRecentProjects()).find((entry) => entry.id === project.id);
    expect(recent?.fileHandle).toBeUndefined();
    await expect(projectManager.openRecentProject(recent!)).resolves.toMatchObject({
      id: project.id,
      name: project.name,
    });
  });

  it("preserves a file handle while project metadata is renamed", async () => {
    const project = makeProject("recent-handle-test", "Before rename");
    const fileHandle = { kind: "native" as const, path: "C:/projects/edit.oreel" };

    await projectManager.addToRecent(project, fileHandle);
    await projectManager.updateRecentMetadata({ ...project, name: "After rename" });

    const recent = (await projectManager.getRecentProjects()).find((entry) => entry.id === project.id);
    expect(recent).toMatchObject({
      id: project.id,
      name: "After rename",
      fileHandle,
    });
  });

  it("restores per-project file locations when a manager initializes after restart", async () => {
    const project = makeProject("recent-handle-restart", "Saved project");
    const fileHandle = { kind: "native" as const, path: "C:/projects/saved.oreel" };
    await projectManager.addToRecent(project, fileHandle);

    const reopenedManager = new ProjectManager();
    await reopenedManager.initialize();

    expect(reopenedManager.getCurrentFileHandle(project.id)).toEqual(fileHandle);
  });

  it("forks an opened duplicate identity before recording its file location", async () => {
    const original = makeProject("duplicate-file-identity", "Existing project");
    const oldHandle = { kind: "native" as const, path: "C:/projects/original.oreel" };
    const openedPath = "C:/projects/imported.oreel";
    await projectManager.addToRecent(original, oldHandle);
    const previousWindow = globalThis.window;
    vi.stubGlobal("window", { reelterminal: { fs: {
      showOpenDialog: vi.fn().mockResolvedValue(openedPath),
      readFile: vi.fn().mockResolvedValue(JSON.stringify(original)),
    } } });
    try {
      const imported = await projectManager.openProject({ existingProjectIds: [original.id] });
      expect(imported?.id).not.toBe(original.id);
      expect(projectManager.getCurrentFileHandle(original.id)).toEqual(oldHandle);
      expect(projectManager.getCurrentFileHandle(imported!.id)).toEqual({ kind: "native", path: openedPath });
      const originalRecent = (await projectManager.getRecentProjects()).find((entry) => entry.id === original.id);
      expect(originalRecent?.fileHandle).toEqual(oldHandle);
    } finally {
      vi.stubGlobal("window", previousWindow);
    }
  });

  it("stores a reopenable project snapshot when no file handle exists", async () => {
    const project = makeProject("recent-snapshot-test", "Recovered project");
    await projectManager.addToRecent(project);

    const recent = (await projectManager.getRecentProjects()).find((entry) => entry.id === project.id);
    expect(recent).toBeDefined();
    await expect(projectManager.openRecentProject(recent!)).resolves.toMatchObject({
      id: project.id,
      name: project.name,
    });
  });
});
