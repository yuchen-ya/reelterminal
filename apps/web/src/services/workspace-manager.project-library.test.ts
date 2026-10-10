import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import i18next from "i18next";
import { WorkspaceManager } from "./workspace-manager";
import {
  activateProjectStore,
  createProjectStore,
  useProjectStore,
} from "../stores/project-store";
import { createEmptyProject } from "../stores/project/project-helpers";

const previousBridge = window.reelterminal;
afterEach(() => {
  window.reelterminal = previousBridge;
});

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  activateProjectStore(createProjectStore());
});

describe("local project lifecycle", () => {
  it("allocates distinct names for concurrent creates and persists the allocated name in each workspace and replay", async () => {
    const firstManager = new WorkspaceManager();
    const secondManager = new WorkspaceManager();
    await Promise.all([firstManager.initialize(), secondManager.initialize()]);
    const first = await firstManager.createProject(createEmptyProject("Horizontal"), { loadRuntime: false });
    const options = { loadRuntime: false, idempotencyKey: "new-horizontal" };
    const [second, third] = await Promise.all([
      firstManager.createProject(createEmptyProject("Horizontal"), options),
      secondManager.createProject(createEmptyProject("Horizontal"), { loadRuntime: false }),
    ]);
    expect([first.project.name, second.project.name, third.project.name].sort()).toEqual([
      "Horizontal", "Horizontal 2", "Horizontal 3",
    ]);
    const replay = await firstManager.createProject(createEmptyProject("Horizontal"), options);
    expect(replay.replayed).toBe(true);
    expect(replay.project).toEqual(second.project);
    const restarted = new WorkspaceManager();
    expect((await restarted.listProjects()).map((project) => project.name).sort()).toEqual([
      "Horizontal", "Horizontal 2", "Horizontal 3",
    ]);
    const context = await restarted.getWorkspaceContext({
      projectId: second.project.id, workspaceId: second.defaultWorkspaceId,
    });
    expect(context.store.getState().project.name).toBe(second.project.name);
  });

  it("reserves names across folders and the recycle bin, while allowing manual duplicates and preserving imported names", async () => {
    const manager = new WorkspaceManager();
    const first = await manager.createProject(createEmptyProject("Horizontal"));
    await manager.saveFolder("Folder", "folder");
    await manager.moveProjects([first.project.id], "folder");
    await manager.recycleProjects([first.project.id]);
    const second = await manager.createProject(createEmptyProject(" horizontal "));
    expect(second.project.name).toBe("horizontal 2");
    await manager.renameLibraryProject(second.project.id, "Horizontal");
    const imported = await manager.createProject(createEmptyProject("Horizontal"), { deduplicateName: false });
    expect(imported.project.name).toBe("Horizontal");
    await manager.restoreProjects([first.project.id]);
    expect((await manager.listProjects()).map((project) => project.name)).toEqual([
      "Horizontal", "Horizontal", "Horizontal",
    ]);
    await manager.recycleProjects([first.project.id, second.project.id, imported.project.id]);
    await manager.purgeProjects([first.project.id, second.project.id, imported.project.id]);
    expect((await manager.createProject(createEmptyProject("Horizontal"))).project.name).toBe("Horizontal");
  });

  it("adds a sequence number to repeated independent copies", async () => {
    const manager = new WorkspaceManager();
    const source = await manager.createProject(createEmptyProject("Original"));
    const firstId = await manager.copyLibraryProject(source.project.id);
    const secondId = await manager.copyLibraryProject(source.project.id);
    const base = `Original (${i18next.t("projectLibrary.copySuffix")})`;
    const records = await manager.listProjects();
    expect(records.find((project) => project.id === firstId)?.name).toBe(base);
    expect(records.find((project) => project.id === secondId)?.name).toBe(`${base} 2`);
  });

  it("allows deletion when retained task inputs belong to a verified interrupted task", async () => {
    const manager = new WorkspaceManager();
    const created = await manager.createProject(
      createEmptyProject("Interrupted job"),
    );
    const target = {
      projectId: created.project.id,
      workspaceId: created.defaultWorkspaceId,
    };
    const context = await manager.getWorkspaceContext(target);
    await manager.retainTaskInputs({
      jobId: "interrupted-job",
      ...target,
      sourceRevision: context.revision,
      inputProject: context.store.getState().getFullProject(),
    });
    window.reelterminal = {
      ...previousBridge,
      projectLibrary: {
        getTaskStates: async () => ({ "interrupted-job": "error" }),
      },
    } as NonNullable<typeof window.reelterminal>;
    await manager.recycleProjects([created.project.id]);
    await manager.purgeProjects([created.project.id]);
    expect(
      await manager.getMediaReferences({ projectId: created.project.id }),
    ).toEqual([]);
  });
  it("indexes every project beyond the recent-list limit without activating it", async () => {
    const manager = new WorkspaceManager();
    for (let index = 0; index < 12; index++) {
      await manager.createProject(createEmptyProject(`Project ${index}`), {
        loadRuntime: false,
      });
    }
    expect(await manager.listLibraryEntries()).toHaveLength(12);
    expect(manager.getActiveTarget()).toBeNull();
    const reloaded = new WorkspaceManager();
    expect(await reloaded.listLibraryEntries()).toHaveLength(12);
    expect((await reloaded.listLibraryEntries())[0]).toMatchObject({
      duration: 0,
      width: 1920,
      height: 1080,
    });
    expect(
      (await reloaded.listLibraryEntries())[0].engineeringBytes,
    ).toBeGreaterThan(0);
  });

  it("renames mutable workspaces while preserving immutable versions and the active project", async () => {
    const manager = new WorkspaceManager();
    const first = await manager.createProject(createEmptyProject("First"));
    const second = await manager.createProject(createEmptyProject("Second"));
    const target = {
      projectId: first.project.id,
      workspaceId: first.defaultWorkspaceId,
    };
    const node = await manager.saveNode({ target, name: "Original version" });
    const trial = await manager.createWorkspace(first.project.id, {
      sourceNodeId: node.node.id,
    });
    const active = {
      projectId: second.project.id,
      workspaceId: second.defaultWorkspaceId,
    };
    await manager.switchView(active);
    await manager.renameLibraryProject(first.project.id, "  Renamed  ");
    expect(manager.getActiveTarget()).toEqual(active);
    expect(
      (await manager.getWorkspaceContext(target)).store.getState().project.name,
    ).toBe("Renamed");
    expect(
      (
        await manager.getWorkspaceContext({
          projectId: first.project.id,
          workspaceId: trial.id,
        })
      ).store.getState().project.name,
    ).toBe("Renamed");
    expect(
      (await manager.getNode(first.project.id, node.node.id))?.project.name,
    ).toBe("First");
    expect(
      (await new WorkspaceManager().listLibraryEntries()).find(
        (project) => project.id === first.project.id,
      )?.name,
    ).toBe("Renamed");
    await expect(
      manager.renameLibraryProject(first.project.id, "  "),
    ).rejects.toThrow();
  });

  it("recycles the current project, rejects late writes and restores workspaces and versions after reload", async () => {
    const manager = new WorkspaceManager();
    const created = await manager.createProject(
      createEmptyProject("Recycle me"),
    );
    const target = {
      projectId: created.project.id,
      workspaceId: created.defaultWorkspaceId,
    };
    await manager.switchView(target);
    await manager.saveNode({ target, name: "Version 1" });
    await manager.createWorkspace(created.project.id);
    const context = await manager.getWorkspaceContext(target);
    await manager.recycleProjects([created.project.id]);
    expect(useProjectStore.getState().hasOpenProject).toBe(false);
    expect(manager.getActiveTarget()).toBeNull();
    expect(await manager.listProjects()).toEqual([]);
    expect(manager.getSnapshot().workspaces).toEqual([]);
    await expect(
      context.store.getState().renameProject("Late write"),
    ).rejects.toThrow("unavailable");
    const fresh = new WorkspaceManager();
    expect((await fresh.listLibraryEntries())[0]).toMatchObject({
      name: "Recycle me",
      recycledAt: expect.any(Number),
    });
    await fresh.restoreProjects([created.project.id]);
    expect(await fresh.listWorkspaces(created.project.id)).toHaveLength(2);
    expect(await fresh.listNodes(created.project.id)).toHaveLength(1);
    expect(
      (await fresh.getWorkspaceContext(target)).store.getState().project.name,
    ).toBe("Recycle me");
  });

  it("purges versions, workspace snapshots and drafts but keeps a permanent tombstone", async () => {
    const manager = new WorkspaceManager();
    const project = createEmptyProject("Purge me");
    const created = await manager.createProject(project);
    const target = {
      projectId: project.id,
      workspaceId: created.defaultWorkspaceId,
    };
    await manager.saveNode({ target, name: "Saved" });
    const context = await manager.getWorkspaceContext(target);
    await manager.retainTaskInputs({
      jobId: "purge-job",
      ...target,
      sourceRevision: context.revision,
      inputProject: context.store.getState().getFullProject(),
    });
    await expect(manager.recycleProjects([project.id])).rejects.toThrow("task");
    await manager.releaseTaskInputs("purge-job");
    await manager.saveDraft(target);
    await manager.recycleProjects([project.id]);
    await manager.purgeProjects([project.id]);
    const fresh = new WorkspaceManager();
    expect(await fresh.listLibraryEntries()).toEqual([]);
    expect(await fresh.getMediaReferences({ projectId: project.id })).toEqual(
      [],
    );
    expect(await fresh.listProjects(true)).toEqual([
      expect.objectContaining({
        id: project.id,
        deletedAt: expect.any(Number),
      }),
    ]);
    await expect(fresh.createProject(project)).rejects.toThrow(
      "already exists",
    );
    await expect(fresh.restoreProjects([project.id])).rejects.toThrow(
      "not in the recycle bin",
    );
    await expect(fresh.getWorkspaceContext(target)).rejects.toThrow(
      "unavailable",
    );
  });

  it("copies current edits into an independent default workspace without old versions or undo history", async () => {
    const manager = new WorkspaceManager();
    const source = await manager.createProject(createEmptyProject("Original"));
    const target = {
      projectId: source.project.id,
      workspaceId: source.defaultWorkspaceId,
    };
    await manager.saveNode({ target, name: "Original history" });
    await manager.copyLibraryProject(source.project.id);
    const copy = (await manager.listProjects()).find(
      (project) => project.id !== source.project.id,
    )!;
    expect(copy.name).toContain("Original");
    expect(await manager.listNodes(copy.id)).toEqual([]);
    expect(await manager.listWorkspaces(copy.id)).toHaveLength(1);
    await manager.renameLibraryProject(copy.id, "Independent");
    expect(
      (await manager.getWorkspaceContext(target)).store.getState().project.name,
    ).toBe("Original");
  });

  it("moves projects into virtual folders, then ungroups both active and recycled projects when the folder is deleted", async () => {
    const manager = new WorkspaceManager();
    const first = await manager.createProject(createEmptyProject("One"), {
      loadRuntime: false,
    });
    const second = await manager.createProject(createEmptyProject("Two"), {
      loadRuntime: false,
    });
    await manager.saveFolder(" Work ", "folder-work");
    await manager.moveProjects(
      [first.project.id, second.project.id],
      "folder-work",
    );
    await manager.recycleProjects([second.project.id]);
    await manager.saveFolder("Renamed folder", "folder-work");
    expect(await new WorkspaceManager().listFolders()).toEqual([
      { id: "folder-work", name: "Renamed folder" },
    ]);
    await manager.deleteFolder("folder-work");
    await manager.restoreProjects([second.project.id]);
    expect(
      (await new WorkspaceManager().listLibraryEntries()).every(
        (project) => !project.folderId,
      ),
    ).toBe(true);
    expect(await manager.listProjects()).toHaveLength(2);
    await expect(
      manager.moveProjects([first.project.id], "missing-folder"),
    ).rejects.toThrow("not found");
  });
});
