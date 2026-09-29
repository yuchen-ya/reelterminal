// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import type { Project } from "@reelterminal/core";
import { projectManager } from "./project-manager";

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
