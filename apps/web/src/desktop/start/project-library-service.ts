import {
  workspaceManager,
  type ProjectFolder,
  type ProjectLibraryEntry,
} from "../../services/workspace-manager";
import { projectManager } from "../../services/project-manager";
import { autoSaveManager } from "../../services/auto-save";
import { getAgentMediaTaskService } from "../../services/agent-media-tasks/agent-media-task-service";
import i18n from "../../i18n";
import {
  createMediaCleanupPlan,
  estimateProjectPurge,
  executeMediaCleanupPlan,
} from "../../services/project-media-gc";

export interface ProjectLibraryData {
  projects: ProjectLibraryEntry[];
  folders: ProjectFolder[];
}

/** Workspace records are authoritative; legacy snapshots only fill missing ids. */
export async function loadProjectLibrary(): Promise<ProjectLibraryData> {
  const [known, stored, saves] = await Promise.all([
    workspaceManager.listProjects(true),
    projectManager.listStoredProjects(),
    autoSaveManager.checkForRecovery(),
  ]);
  const knownIds = new Set(known.map((project) => project.id));
  const candidates = new Map(stored.map((project) => [project.id, project]));
  const newestSaves = new Map<string, (typeof saves)[number]>();
  for (const save of saves) {
    const previous = newestSaves.get(save.projectId);
    if (!previous || save.timestamp > previous.timestamp)
      newestSaves.set(save.projectId, save);
  }
  for (const [id, save] of newestSaves) {
    if (knownIds.has(id)) continue;
    if (
      !candidates.has(id) ||
      save.timestamp > candidates.get(id)!.modifiedAt
    ) {
      const recovered = await autoSaveManager.recover(save.id);
      if (!recovered)
        throw new Error(
          i18n.t("projectLibrary.recoveryFailed", { name: save.projectName }),
        );
      candidates.set(id, recovered);
    }
  }
  for (const project of candidates.values()) {
    if (!knownIds.has(project.id)) {
      await workspaceManager.createProject(project, { loadRuntime: false, deduplicateName: false });
      knownIds.add(project.id);
    }
  }
  const [projects, folders] = await Promise.all([
    workspaceManager.listLibraryEntries(),
    workspaceManager.listFolders(),
  ]);
  return { projects, folders };
}

async function assertNoRunningJobs(ids: readonly string[]): Promise<void> {
  await workspaceManager.assertProjectDeletionAllowed(ids);
  const result = await getAgentMediaTaskService().list();
  if (!result.ok) throw new Error(result.message);
  if (result.value.unreadable.length)
    throw new Error(i18n.t("projectLibrary.tasksUnreadable"));
  if (
    result.value.tasks.some(
      (task) =>
        ids.includes(task.targetProjectId) &&
        ["queued", "submitted", "running"].includes(task.status),
    )
  )
    throw new Error(i18n.t("projectLibrary.taskBusy"));
}

export async function recycleLibraryProjects(
  ids: readonly string[],
): Promise<void> {
  await assertNoRunningJobs(ids);
  await workspaceManager.recycleProjects(ids);
}

export async function previewLibraryPurge(
  ids: readonly string[],
): Promise<number> {
  await assertNoRunningJobs(ids);
  return (await estimateProjectPurge(ids)).bytes;
}

export async function purgeLibraryProjects(
  ids: readonly string[],
): Promise<{ reclaimedBytes: number; incomplete: boolean }> {
  await assertNoRunningJobs(ids);
  const estimate = await estimateProjectPurge(ids);
  const records = await workspaceManager.listProjects(true);
  const mediaIds = [
    ...new Set([
      ...estimate.mediaIds,
      ...records
        .filter((record) => ids.includes(record.id))
        .flatMap((record) => record.purgedMediaIds ?? []),
    ]),
  ];
  for (const id of ids) {
    await autoSaveManager.clearProjectSaves(id);
    await projectManager.deleteStoredProject(id);
  }
  // Legacy cleanup happens while the project is still recoverable in the bin.
  // The workspace transaction retains tombstones against stale recovery imports.
  await workspaceManager.purgeProjects(ids, mediaIds);
  // Scope the cleanup to every purged project, not just the first: media of
  // the other projects must be eligible as candidates too or their blobs are
  // orphaned in storage forever.
  const plan = await createMediaCleanupPlan(ids, mediaIds);
  const result = await executeMediaCleanupPlan(plan);
  return {
    reclaimedBytes: result.reclaimedBytes,
    incomplete: !plan.referenceScanReady || result.skipped.length > 0,
  };
}

export const projectLibraryActions = {
  rename: (id: string, name: string) =>
    workspaceManager.renameLibraryProject(id, name),
  copy: (id: string) => workspaceManager.copyLibraryProject(id),
  move: (ids: readonly string[], folderId?: string) =>
    workspaceManager.moveProjects(ids, folderId),
  restore: (ids: readonly string[]) => workspaceManager.restoreProjects(ids),
  saveFolder: (name: string, id?: string) =>
    workspaceManager.saveFolder(name, id),
  deleteFolder: (id: string) => workspaceManager.deleteFolder(id),
};
