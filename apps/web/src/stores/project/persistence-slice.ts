import type { Project } from "@openreel/core";
import {
  ActionExecutor,
  ActionHistory,
  normalizeGeneratedShaders,
  normalizeProjectWorkAssetFields,
  registerProjectGeneratedShaders,
} from "@openreel/core";
import type { StoreApi } from "zustand";
import type { ProjectState } from "../project-store";
import {
  autoSaveManager,
  initializeAutoSave as initializeAutoSaveService,
} from "../../services/auto-save";
import { loadProjectMedia } from "../../services/media-storage";
import {
  attachProjectMediaGc,
  flushProjectMediaBytes,
  sweepOrphanProjectMedia,
} from "../../services/project-media-gc";
import { projectManager } from "../../services/project-manager";
import { restoreMediaItem } from "../../utils/media-recovery";
import { useEngineStore } from "../engine-store";

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
      if (autoSaveInitialized) return;
      if (!autoSaveInitializationPromise) {
        autoSaveInitializationPromise = (async () => {
          await initializeAutoSaveService();
          autoSaveManager.start(() => get().getFullProject());
          if (!unsubscribeProjectChanges) {
            unsubscribeProjectChanges = deps.subscribeToProject(() => {
              autoSaveManager.markDirty(get().getFullProject());
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
      const recoveredProject = await autoSaveManager.recover(saveId);
      if (recoveredProject) {
        // Auto-save recovery parses raw JSON and never passes through
        // normalizeProjectStoredFields, so stored-field repair for fields
        // without engine loaders (work assets) must run here explicitly.
        const normalizedProject = normalizeProjectWorkAssetFields(
          recoveredProject,
        );
        const storedMedia = await loadProjectMedia(normalizedProject.id);
        const blobMap = new Map(storedMedia.map((m) => [m.id, m.blob]));

        const restoredItems = await Promise.all(
          normalizedProject.mediaLibrary.items.map((item) =>
            restoreMediaItem(item, blobMap.get(item.id)),
          ),
        );

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

        const titleEngine = useEngineStore.getState().getTitleEngine();
        const graphicsEngine = useEngineStore.getState().getGraphicsEngine();

        if (titleEngine && recoveredProject.textClips) {
          titleEngine.loadTextClips(recoveredProject.textClips);
        }
        if (graphicsEngine) {
          if (recoveredProject.shapeClips) {
            graphicsEngine.loadShapeClips(recoveredProject.shapeClips);
          }
          if (recoveredProject.svgClips) {
            graphicsEngine.loadSVGClips(recoveredProject.svgClips);
          }
          if (recoveredProject.stickerClips) {
            graphicsEngine.loadStickerClips(recoveredProject.stickerClips);
          }
        }

        // Leaving the previous project state destroys its undo history, so
        // bytes that only that history could restore are reclaimed now.
        void flushProjectMediaBytes(get().project);
        const newHistory = new ActionHistory();
        attachProjectMediaGc(newHistory, () => get().project);
        const newExecutor = new ActionExecutor(newHistory);

        registerProjectGeneratedShaders(projectWithMedia);

        set({
          project: projectWithMedia,
          hasOpenProject: true,
          actionHistory: newHistory,
          actionExecutor: newExecutor,
          clipUndoStack: [],
          clipRedoStack: [],
          templateUndoStack: [],
          templateRedoStack: [],
          error: null,
        });

        // A fresh session history is empty, so nothing from before the
        // recovery can be undone: bytes outside the restored items are
        // leftovers and are reclaimed.
        void sweepOrphanProjectMedia(projectWithMedia);

        await projectManager.addToRecent(projectWithMedia);
        return true;
      }
      return false;
    },

    forceSave: async () => {
      // Manual save is also the recovery path for a failed first-time setup.
      await get().initializeAutoSave();
      await autoSaveManager.forceSave(get().getFullProject());
    },

    getFullProject: (): Project => {
      const { project } = get();
      const titleEngine = useEngineStore.getState().getTitleEngine();
      const graphicsEngine = useEngineStore.getState().getGraphicsEngine();

      return {
        ...project,
        // Same engine-null fallback as forceSave: never silently drop
        // overlays from a snapshot.
        textClips: titleEngine?.getAllTextClips() ?? project.textClips ?? [],
        shapeClips:
          graphicsEngine?.getAllShapeClips() ?? project.shapeClips ?? [],
        svgClips: graphicsEngine?.getAllSVGClips() ?? project.svgClips ?? [],
        stickerClips:
          graphicsEngine?.getAllStickerClips() ?? project.stickerClips ?? [],
      };
    },
  };
}
