import type { Project } from "@reelterminal/core";
import { useProjectStore } from "../../stores/project-store";
import { loadProjectMedia } from "../../services/media-storage";
import { projectManager } from "../../services/project-manager";
import { restoreMediaItem } from "../../utils/media-recovery";
import { autoSaveManager } from "../../services/auto-save";
import { workspaceManager } from "../../services/workspace-manager";
import { createEmptyProject } from "../../stores/project";
import { v4 as uuid } from "uuid";
import { toast } from "../../stores/notification-store";
import { t } from "../../i18n";
import { switchProjectView } from "../../services/project-switch-notify";

export interface NewProjectFormat {
  id: string;
  label: string;
  width: number;
  height: number;
  frameRate: number;
}

export const DESKTOP_FORMATS: NewProjectFormat[] = [
  { id: "vertical", label: "Vertical", width: 1080, height: 1920, frameRate: 30 },
  { id: "horizontal", label: "Horizontal", width: 1920, height: 1080, frameRate: 30 },
  { id: "square", label: "Square", width: 1080, height: 1080, frameRate: 30 },
];

async function createAndShowProject(format: NewProjectFormat, name: string): Promise<void> {
  const project = createEmptyProject(name, {
    width: format.width,
    height: format.height,
    frameRate: format.frameRate,
  });
  const created = await workspaceManager.createProject(project);
  await workspaceManager.switchView({ projectId: project.id, workspaceId: created.defaultWorkspaceId });
  await projectManager.addToRecent(created.project);
}

export function startNewProject(format: NewProjectFormat): Promise<void> {
  return createAndShowProject(format, format.label);
}

export function startNewMotionProject(format: NewProjectFormat): Promise<void> {
  return createAndShowProject(format, `${format.label} Motion Creator`);
}

export interface RecentEntry {
  id: string;
  name: string;
  lastOpened: number;
  recoverySaveId?: string;
}

export async function listRecentProjects(): Promise<RecentEntry[]> {
  const [recentProjects, saves, projects] = await Promise.all([
    projectManager.getRecentProjects(),
    autoSaveManager.checkForRecovery(),
    workspaceManager.listProjects(true),
  ]);
  const unavailable = new Set(projects.filter((project) => project.recycledAt !== undefined || project.deletedAt !== undefined).map((project) => project.id));
  const entries = new Map<string, RecentEntry>(
    recentProjects.map((recent) => [recent.id, {
      id: recent.id,
      name: recent.name,
      lastOpened: recent.lastOpened,
    }]),
  );
  for (const save of saves) {
    const existing = entries.get(save.projectId);
    if (!existing || save.timestamp > existing.lastOpened) {
      entries.set(save.projectId, {
        id: save.projectId,
        name: save.projectName,
        lastOpened: save.timestamp,
        recoverySaveId: save.id,
      });
    }
  }
  return [...entries.values()].filter((entry) => !unavailable.has(entry.id)).sort((a, b) => b.lastOpened - a.lastOpened).slice(0, 10);
}

async function importProjectIntoWorkspace(project: Project): Promise<void> {
  const storedMedia = await loadProjectMedia(project.id, project.mediaLibrary.items.map((item) => item.id));
  const blobsById = new Map(storedMedia.map((record) => [record.id, record.blob]));
  const items = await Promise.all(
    project.mediaLibrary.items.map((item) =>
      restoreMediaItem(item, blobsById.get(item.id)),
    ),
  );

  const existing = (await workspaceManager.listProjects(true)).some((entry) => entry.id === project.id);
  const imported = {
    ...project,
    ...(existing ? { id: uuid(), name: `${project.name} (${t("versioning.importedCopy")})` } : {}),
    mediaLibrary: { ...project.mediaLibrary, items },
  };
  const created = await workspaceManager.createProject(imported, { deduplicateName: false });
  await switchProjectView({ projectId: imported.id, workspaceId: created.defaultWorkspaceId });
  await projectManager.addToRecent(imported);
  toast.info(t("versioning.projectFileScope"));
}

export async function saveCurrentProject(): Promise<void> {
  const state = useProjectStore.getState();
  if (state.hasOpenProject) await state.forceSave();
}

export async function openProject(): Promise<boolean> {
  await saveCurrentProject();
  const existingProjects = await workspaceManager.listProjects();
  const project = await projectManager.openProject({ existingProjectIds: existingProjects.map((entry) => entry.id) });
  if (!project) return false;
  await importProjectIntoWorkspace(project);
  return true;
}

export async function openRecentProject(projectId: string): Promise<boolean> {
  await saveCurrentProject();
  const existing = (await workspaceManager.listProjects(true)).find((project) => project.id === projectId);
  if (existing?.recycledAt !== undefined || existing?.deletedAt !== undefined) return false;
  if (existing) {
    await switchProjectView({ projectId, workspaceId: existing.defaultWorkspaceId });
    return true;
  }
  const entry = (await listRecentProjects()).find((item) => item.id === projectId);
  if (entry?.recoverySaveId) {
    const recovered = await autoSaveManager.recover(entry.recoverySaveId);
    if (!recovered) return false;
    await importProjectIntoWorkspace(recovered);
    return true;
  }
  const recentProjects = await projectManager.getRecentProjects();
  const recent = recentProjects.find((entry) => entry.id === projectId);
  if (!recent) return false;

  const project = await projectManager.openRecentProject(recent);
  if (!project) return false;
  await importProjectIntoWorkspace(project);
  return true;
}
