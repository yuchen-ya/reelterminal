import type { Project } from "@reelterminal/core";
import {
  ActionExecutor,
  ActionHistory,
  normalizeGeneratedShaders,
  normalizeProjectWorkAssetFields,
  registerProjectGeneratedShaders,
} from "@reelterminal/core";
import type { StoreApi } from "zustand";
import type { ProjectState } from "../project-store";
import {
  autoSaveManager,
  initializeAutoSave as initializeAutoSaveService,
} from "../../services/auto-save";
import { loadProjectMedia } from "../../services/media-storage";
import {
  attachProjectMediaGc,
  detachProjectMediaGc,
} from "../../services/project-media-gc";
import { projectManager } from "../../services/project-manager";
import { restoreMediaItem } from "../../utils/media-recovery";

type Get = StoreApi<ProjectState>["getState"];
type Set = StoreApi<ProjectState>["setState"];

export type ProjectPersistenceSlice = Pick<
  ProjectState,
  | "initializeAutoSave"
  | "checkForRecovery"
  | "recoverFromAutoSave"
  | "forceSave"
  | "getFullProject"
>;

export interface ProjectPersistenceDeps {
  subscribeToProject: (listener: () => void) => () => void;
}

let autoSaveInitialized = false;
let autoSaveInitializationPromise: Promise<void> | null = null;
let unsubscribeProjectChanges: (() => void) | null = null;

export function createProjectPersistenceSlice(
  set: Set,
  get: Get,
  deps: ProjectPersistenceDeps,
): ProjectPersistenceSlice {
  return {
    initializeAutoSave: async () => {
      // Workspace drafts are committed by WorkspaceManager per workspace.
      // The legacy autosave database is project-keyed and would collapse trial
      // and default workspaces into the same recovery slots.
      if (get().workspaceId) return;
      if (autoSaveInitialized) return;
      if (!autoSaveInitializationPromise) {
        autoSaveInitializationPromise = (async () => {
          await initializeAutoSaveService();
          autoSaveManager.start(() => get().getFullProject());
          if (!unsubscribeProjectChanges) {
            let previousProject = get().getFullProject();
            unsubscribeProjectChanges = deps.subscribeToProject(() => {
              const currentProject = get().getFullProject();
              if (currentProject.id !== previousProject.id) {
                if (autoSaveManager.hasUnsavedChanges(previousProject)) {
                  void autoSaveManager.forceSave(previousProject).catch((error) => {
                    console.warn(
                      "[ProjectStore] Failed to save project before switching:",
                      error,
                    );
                  });
                }
              } else {
                autoSaveManager.markDirty(currentProject);
              }
              previousProject = currentProject;
            });
          }
          autoSaveInitialized = true;
        })();
      }
      try {
        await autoSaveInitializationPromise;
      } finally {
        autoSaveInitializationPromise = null;
      }
    },

    checkForRecovery: async () => {
      const { project } = get();
      return autoSaveManager.checkForRecovery(project.id);
    },

    recoverFromAutoSave: async (saveId: string) => {
      const startingProject = get().project;
      const startingRevision = get().projectRevision;
      const isRecoveryTargetCurrent = () =>
        get().project === startingProject &&
        get().projectRevision === startingRevision;
      const recoveredProject = await autoSaveManager.recover(saveId);
      if (recoveredProject) {
        const { workspaceManager } = await import("../../services/workspace-manager");
        const record = (await workspaceManager.listProjects(true)).find((entry) => entry.id === recoveredProject.id);
        if (record?.recycledAt !== undefined || record?.deletedAt !== undefined) return false;
        // Auto-save recovery parses raw JSON and never passes through
        // normalizeProjectStoredFields, so stored-field repair for fields
        // without engine loaders (work assets) must run here explicitly.
        const normalizedProject = normalizeProjectWorkAssetFields(
          recoveredProject,
        );
        const storedMedia = await loadProjectMedia(
          normalizedProject.id,
          normalizedProject.mediaLibrary.items.map((item) => item.id),
        );
        const blobMap = new Map(storedMedia.map((m) => [m.id, m.blob]));

        const restoredItems = await Promise.all(
          normalizedProject.mediaLibrary.items.map((item) =>
            restoreMediaItem(item, blobMap.get(item.id)),
          ),
        );

        if (!isRecoveryTargetCurrent()) {
          const originalItems = new Map(
            normalizedProject.mediaLibrary.items.map((item) => [item.id, item]),
          );
          for (const item of restoredItems) {
            const originalThumbnail = originalItems.get(item.id)?.thumbnailUrl;
            if (
              item.thumbnailUrl?.startsWith("blob:") &&
              item.thumbnailUrl !== originalThumbnail
            ) {
              URL.revokeObjectURL(item.thumbnailUrl);
            }
          }
          return false;
        }

        const projectWithMedia: Project = {
          ...normalizedProject,
          generatedShaders: normalizeGeneratedShaders(
            normalizedProject.generatedShaders,
          ),
          mediaLibrary: {
            ...normalizedProject.mediaLibrary,
            items: restoredItems,
          },
        };

        const newHistory = new ActionHistory();
        detachProjectMediaGc(get().actionHistory);
        attachProjectMediaGc(newHistory, () => get().project);
        const newExecutor = new ActionExecutor(newHistory);

        if (get().isForeground) registerProjectGeneratedShaders(projectWithMedia);

        set({
          project: projectWithMedia,
          hasOpenProject: true,
          actionHistory: newHistory,
          actionExecutor: newExecutor,
          clipUndoStack: [],
          clipRedoStack: [],
          templateUndoStack: [],
          templateRedoStack: [],
          redoJournal: [],
          error: null,
        });

        projectManager.clearCurrentFileHandle(projectWithMedia.id);
        await projectManager.addToRecent(projectWithMedia, null);
        return true;
      }
      return false;
    },

    forceSave: async () => {
      const workspaceDraftSave = get().saveWorkspaceDraft;
      if (get().workspaceId && workspaceDraftSave) {
        await workspaceDraftSave();
        return;
      }
      // Manual save is also the recovery path for a failed first-time setup.
      await get().initializeAutoSave();
      const project = get().getFullProject();
      await autoSaveManager.forceSave(project);
      // Desktop recovery starts from Recent; an autosave alone is not listed there.
      await projectManager.addToRecent(project);
    },

    getFullProject: (): Project => {
      const { project } = get();
      return {
        ...project,
        textClips: project.textClips ?? [],
        shapeClips: project.shapeClips ?? [],
        svgClips: project.svgClips ?? [],
        stickerClips: project.stickerClips ?? [],
      };
    },
  };
}
