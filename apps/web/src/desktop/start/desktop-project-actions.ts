import type { Project } from "@reelterminal/core";
import { useProjectStore } from "../../stores/project-store";
import { loadProjectMedia } from "../../services/media-storage";
import { projectManager } from "../../services/project-manager";
import { restoreMediaItem } from "../../utils/media-recovery";
import { autoSaveManager } from "../../services/auto-save";

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

export function startNewProject(format: NewProjectFormat): void {
  useProjectStore.getState().createNewProject(format.label, {
    width: format.width,
    height: format.height,
    frameRate: format.frameRate,
  });
}

export function startNewMotionProject(format: NewProjectFormat): void {
  useProjectStore.getState().createNewProject(`${format.label} Motion Creator`, {
    width: format.width,
    height: format.height,
    frameRate: format.frameRate,
  });
}

export interface RecentEntry {
  id: string;
  name: string;
  lastOpened: number;
  recoverySaveId?: string;
}

export async function listRecentProjects(): Promise<RecentEntry[]> {
  const [recentProjects, saves] = await Promise.all([
    projectManager.getRecentProjects(),
    autoSaveManager.checkForRecovery(),
  ]);
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
  return [...entries.values()].sort((a, b) => b.lastOpened - a.lastOpened).slice(0, 10);
}

async function loadProjectIntoStore(project: Project): Promise<void> {
  const storedMedia = await loadProjectMedia(project.id);
  const blobsById = new Map(storedMedia.map((record) => [record.id, record.blob]));
  const items = await Promise.all(
    project.mediaLibrary.items.map((item) =>
      restoreMediaItem(item, blobsById.get(item.id)),
    ),
  );

  useProjectStore.getState().loadProject({
    ...project,
    mediaLibrary: { ...project.mediaLibrary, items },
  });
}

export async function saveCurrentProject(): Promise<void> {
  const state = useProjectStore.getState();
  if (state.hasOpenProject) await state.forceSave();
}

export async function openProject(): Promise<boolean> {
  await saveCurrentProject();
  const project = await projectManager.openProject();
  if (!project) return false;
  await loadProjectIntoStore(project);
  return true;
}

export async function openRecentProject(projectId: string): Promise<boolean> {
  await saveCurrentProject();
  const entry = (await listRecentProjects()).find((item) => item.id === projectId);
  if (entry?.recoverySaveId) {
    return useProjectStore.getState().recoverFromAutoSave(entry.recoverySaveId);
  }
  const recentProjects = await projectManager.getRecentProjects();
  const recent = recentProjects.find((entry) => entry.id === projectId);
  if (!recent) return false;

  const project = await projectManager.openRecentProject(recent);
  if (!project) return false;
  await loadProjectIntoStore(project);
  return true;
}
