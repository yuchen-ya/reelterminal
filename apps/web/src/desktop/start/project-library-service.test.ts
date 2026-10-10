// Real IndexedDB stores exercise migration and shared-media reclamation together.
import { beforeAll, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { Blob as NodeBlob } from "node:buffer";
import { createEmptyProject } from "../../stores/project/project-helpers";
import {
  activateProjectStore,
  createProjectStore,
} from "../../stores/project-store";
import { workspaceManager } from "../../services/workspace-manager";
import { projectManager } from "../../services/project-manager";
import { autoSaveManager } from "../../services/auto-save";
import { saveMediaBlob, loadMediaRecord } from "../../services/media-storage";
import {
  beginProjectExport,
  endProjectExport,
} from "../../services/project-export-activity";
import {
  loadProjectLibrary,
  previewLibraryPurge,
  purgeLibraryProjects,
  recycleLibraryProjects,
} from "./project-library-service";

beforeAll(() => {
  globalThis.indexedDB = new IDBFactory();
  activateProjectStore(createProjectStore());
});

it("migrates all older local snapshots, uses the latest recovery, and never resurrects recycled or purged projects", async () => {
  for (let index = 0; index < 12; index++)
    await projectManager.addToRecent(createEmptyProject(index < 2 ? "Legacy same" : `Legacy ${index}`));
  const older = { ...createEmptyProject("Older recovery name"), modifiedAt: Date.now() - 1000 };
  await projectManager.addToRecent(older);
  await autoSaveManager.initialize();
  await autoSaveManager.forceSave({
    ...older,
    name: "Latest recovery",
    modifiedAt: Date.now() + 1000,
  });
  const library = await loadProjectLibrary();
  expect(library.projects).toHaveLength(13);
  expect(library.projects.filter((project) => project.name === "Legacy same")).toHaveLength(2);
  expect(
    library.projects.find((project) => project.id === older.id)?.name,
  ).toBe("Latest recovery");
  expect(workspaceManager.getActiveTarget()).toBeNull();
  await recycleLibraryProjects([older.id]);
  expect(
    (await loadProjectLibrary()).projects.find(
      (project) => project.id === older.id,
    )?.recycledAt,
  ).toBeTypeOf("number");
  await purgeLibraryProjects([older.id]);
  // Simulate a delayed legacy writer after cleanup; the tombstone must win.
  await projectManager.addToRecent(older);
  expect(
    (await loadProjectLibrary()).projects.some(
      (project) => project.id === older.id,
    ),
  ).toBe(false);
});

it("protects shared media in copies and the recycle bin, reclaiming bytes only after the last project is purged", async () => {
  const project = createEmptyProject("Shared source");
  const mediaId = "shared-owned-media";
  const metadata = {
    duration: 1,
    width: 320,
    height: 180,
    frameRate: 30,
    codec: "h264",
    sampleRate: 0,
    channels: 0,
    fileSize: 12,
  };
  const item = {
    id: mediaId,
    name: "video.mp4",
    type: "video" as const,
    blob: null,
    fileHandle: null,
    waveformData: null,
    thumbnailUrl: null,
    metadata,
    importedAt: Date.now(),
  };
  const source = { ...project, mediaLibrary: { items: [item] } };
  const blob = new NodeBlob(["video bytes"]) as unknown as Blob;
  await saveMediaBlob(project.id, mediaId, blob, metadata);
  await workspaceManager.createProject(source, { loadRuntime: false });
  const copyId = await workspaceManager.copyLibraryProject(project.id);
  const exportOwner = Symbol("export-test");
  beginProjectExport(exportOwner, source);
  await expect(recycleLibraryProjects([project.id])).rejects.toThrow("export");
  endProjectExport(exportOwner);
  await recycleLibraryProjects([project.id]);
  expect(await previewLibraryPurge([project.id])).toBe(0);
  expect((await purgeLibraryProjects([project.id])).reclaimedBytes).toBe(0);
  expect(await loadMediaRecord(mediaId)).not.toBeNull();
  await recycleLibraryProjects([copyId]);
  const legacyRecovery = {
    ...createEmptyProject("Other historical recovery"),
    mediaLibrary: { items: [item] },
  };
  await autoSaveManager.forceSave(legacyRecovery);
  await autoSaveManager.forceSave({
    ...legacyRecovery,
    mediaLibrary: { items: [] },
  });
  expect(await previewLibraryPurge([copyId])).toBe(0);
  await autoSaveManager.clearProjectSaves(legacyRecovery.id);
  expect(await previewLibraryPurge([copyId])).toBe(blob.size);
  expect((await purgeLibraryProjects([copyId])).reclaimedBytes).toBe(blob.size);
  expect(await loadMediaRecord(mediaId)).toBeNull();
});
