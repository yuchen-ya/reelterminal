import type { Action, Project, ProjectSettings, GraphicsEngine, TitleEngine } from "@reelterminal/core";
import { GraphicsEngine as GraphicsEngineClass, TitleEngine as TitleEngineClass } from "@reelterminal/core";
import {
  ActionExecutor,
  ActionHistory,
  normalizeGeneratedShaders,
  normalizeProjectMotionFields,
  normalizeProjectWorkAssetFields,
  normalizeProjectSpeedDurations,
  registerProjectGeneratedShaders,
} from "@reelterminal/core";
import type { StoreApi } from "zustand";
import { v4 as uuidv4 } from "uuid";
import type { ProjectState } from "../project-store";
import { loadDirectoryHandle, loadFileHandle } from "../../services/media-storage";
import {
  attachProjectMediaGc,
  detachProjectMediaGc,
} from "../../services/project-media-gc";
import { projectManager } from "../../services/project-manager";
import {
  calculateTimelineDuration,
  createEmptyProject,
} from "./index";

type Get = StoreApi<ProjectState>["getState"];
type Set = StoreApi<ProjectState>["setState"];

export type ProjectLifecycleSlice = Pick<
  ProjectState,
  | "createNewProject"
  | "loadProject"
  | "renameProject"
  | "updateSettings"
  | "setCanvasBackground"
>;

export interface ProjectLifecycleDeps {
  syncProjectEffectsBridge: (nextProject: Project, previousProject?: Project) => void;
  syncProjectTransitionsBridge: (nextProject: Project, previousProject?: Project) => void;
  isForeground?: () => boolean;
  overlayEngines?: { titleEngine: TitleEngine; graphicsEngine: GraphicsEngine };
}

export function createProjectLifecycleSlice(
  set: Set,
  get: Get,
  deps: ProjectLifecycleDeps,
): ProjectLifecycleSlice {
  const { syncProjectEffectsBridge, syncProjectTransitionsBridge } = deps;
  const isForeground = deps.isForeground ?? (() => true);
  const { titleEngine, graphicsEngine } = deps.overlayEngines ?? {
    titleEngine: new TitleEngineClass(),
    graphicsEngine: new GraphicsEngineClass(),
  };

  return {
    createNewProject: (
      name?: string,
      settings?: Partial<ProjectSettings>,
    ) => {
      const newHistory = new ActionHistory();
      attachProjectMediaGc(newHistory, () => get().project);
      const newExecutor = new ActionExecutor(newHistory);
      const previousProject = get().project;
      detachProjectMediaGc(get().actionHistory);
      const nextProject = createEmptyProject(name, settings);
      projectManager.clearCurrentFileHandle(nextProject.id);

      if (isForeground()) {
        syncProjectEffectsBridge(nextProject, previousProject);
        syncProjectTransitionsBridge(nextProject, previousProject);
      }

      if (isForeground()) registerProjectGeneratedShaders(nextProject);

      titleEngine.loadTextClips([]);
      graphicsEngine.loadShapeClips([]);
      graphicsEngine.loadSVGClips([]);
      graphicsEngine.loadStickerClips([]);

      set({
        project: nextProject,
        hasOpenProject: true,
        actionHistory: newHistory,
        actionExecutor: newExecutor,
        clipUndoStack: [],
        clipRedoStack: [],
        templateUndoStack: [],
        templateRedoStack: [],
        redoJournal: [],
        clipboard: [],
        lastPastedClipIds: [],
        error: null,
      });
    },

    loadProject: (incomingProject: Project) => {
      // Projects coming from IndexedDB (loadProjectFromDb) bypass
      // normalizeProjectStoredFields, so stored-field repair for fields
      // without engine loaders (work assets) runs at this store boundary.
      const motionNormalized = normalizeProjectWorkAssetFields(
        normalizeProjectMotionFields(normalizeProjectSpeedDurations(incomingProject)),
      );
      const project: Project = {
        ...motionNormalized,
        generatedShaders: normalizeGeneratedShaders(
          motionNormalized.generatedShaders,
        ),
      };
      const previousProject = get().project;
      titleEngine.loadTextClips(project.textClips ?? []);
      graphicsEngine.loadShapeClips(project.shapeClips ?? []);
      graphicsEngine.loadSVGClips(project.svgClips ?? []);
      graphicsEngine.loadStickerClips(project.stickerClips ?? []);

      // A loaded project starts with an empty undo chain; detach the old
      // history's media roots before replacing it.
      const newHistory = new ActionHistory();
      detachProjectMediaGc(get().actionHistory);
      attachProjectMediaGc(newHistory, () => get().project);
      const newExecutor = new ActionExecutor(newHistory);

      // Fix legacy projects where timeline.duration was never persisted
      const computedDuration = calculateTimelineDuration(project);
      const fixedProject = computedDuration !== project.timeline.duration
        ? { ...project, timeline: { ...project.timeline, duration: computedDuration } }
        : project;

      if (isForeground()) {
        syncProjectEffectsBridge(fixedProject, previousProject);
        syncProjectTransitionsBridge(fixedProject, previousProject);
      }

      if (isForeground()) registerProjectGeneratedShaders(fixedProject);

      set({
        project: fixedProject,
        hasOpenProject: true,
        actionHistory: newHistory,
        actionExecutor: newExecutor,
        clipUndoStack: [],
        clipRedoStack: [],
        templateUndoStack: [],
        templateRedoStack: [],
        redoJournal: [],
        clipboard: [],
        lastPastedClipIds: [],
        error: null,
      });

      // A loaded project starts a fresh undo history. Retained bytes remain
      // available for the explicit media cleanup plan.

      // Auto-restore placeholder assets from saved FileSystemFileHandles (same machine)
      const placeholders = fixedProject.mediaLibrary.items.filter(
        (item) => item.isPlaceholder && item.sourceFile,
      );
      if (placeholders.length > 0 && "FileSystemFileHandle" in window) {
        (async () => {
          const loadedProjectId = fixedProject.id;
          const loadedActionExecutor = get().actionExecutor;
          const stillMissing: typeof placeholders = [];
          const isLoadedProjectCurrent = () =>
            get().project.id === loadedProjectId &&
            get().actionExecutor === loadedActionExecutor;
          const isCurrentPlaceholder = (candidate: (typeof placeholders)[number]) => {
            const currentProject = get().project;
            const currentItem = currentProject.mediaLibrary.items.find(
              (item) => item.id === candidate.id,
            );
            const expectedSource = candidate.sourceFile;
            const currentSource = currentItem?.sourceFile;
            return (
              isLoadedProjectCurrent() &&
              currentItem?.isPlaceholder === true &&
              !!expectedSource &&
              currentSource?.name === expectedSource.name &&
              currentSource.size === expectedSource.size &&
              currentSource.lastModified === expectedSource.lastModified &&
              currentSource.folder === expectedSource.folder
            );
          };

          // Tier 1: try individual file handles (follow file across folder moves)
          for (const item of placeholders) {
            if (!item.sourceFile) continue;
            if (!isLoadedProjectCurrent()) return;
            if (!isCurrentPlaceholder(item)) continue;
            try {
              const handle = await loadFileHandle(item.sourceFile.name, item.sourceFile.size);
              if (!isCurrentPlaceholder(item)) continue;
              if (!handle) { stillMissing.push(item); continue; }
              const file = await handle.getFile();
              if (!isCurrentPlaceholder(item)) continue;
              await get().relinkMediaAsset(item.id, file, item.sourceFile.folder);
            } catch {
              if (isCurrentPlaceholder(item)) stillMissing.push(item);
            }
          }

          // Tier 2: scan the stored relink folder for files not found via handle
          if (stillMissing.length > 0) {
            try {
              const dirInfo = await loadDirectoryHandle(fixedProject.id);
              if (!isLoadedProjectCurrent()) return;
              if (dirInfo) {
                const fileMap = new Map<string, { file: File; folder: string }>();
                const entries = (dirInfo.handle as unknown as { entries: () => AsyncIterableIterator<[string, FileSystemHandle]> }).entries();
                for await (const [, fh] of entries) {
                  if (!isLoadedProjectCurrent()) return;
                  if ((fh as FileSystemHandle).kind === "file") {
                    const f = await (fh as FileSystemFileHandle).getFile();
                    fileMap.set(`${f.name.toLowerCase()}:${f.size}`, { file: f, folder: dirInfo.folderName });
                  }
                }
                for (const item of stillMissing) {
                  if (!item.sourceFile) continue;
                  if (!isLoadedProjectCurrent()) return;
                  if (!isCurrentPlaceholder(item)) continue;
                  const entry = fileMap.get(`${item.sourceFile.name.toLowerCase()}:${item.sourceFile.size}`);
                  if (entry) {
                    try {
                      await get().relinkMediaAsset(item.id, entry.file, entry.folder);
                    } catch { /* skip */ }
                  }
                }
              }
            } catch { /* dir handle stale or unavailable */ }
          }

        })();
      }
    },

    // Rename project
    renameProject: async (name: string) => {
      const action: Action = {
        type: "project/rename",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { name },
      };
      const result = (await get().submitActionBatch([action], {
        groupLabel: "Rename project",
        historyOwner: "human",
      })).result;
      if (result.success) {
        const updatedProject = get().project;
        void projectManager.updateRecentMetadata({ ...updatedProject }).catch((error) => {
          console.warn("[ProjectStore] Failed to update recent project name:", error);
        });
      }
      return result;
    },

    // Update project settings
    updateSettings: async (settings: Partial<ProjectSettings>) => {
      const action: Action = {
        type: "project/updateSettings",
        id: uuidv4(),
        timestamp: Date.now(),
        params: settings,
      };
      return (await get().submitActionBatch([action], {
        groupLabel: "Update project settings",
        historyOwner: "human",
      })).result;
    },

    setCanvasBackground: async (mode, color) => {
      const action: Action = {
        type: "project/setCanvasBackground",
        id: uuidv4(),
        timestamp: Date.now(),
        params: {
          backgroundFillMode: mode,
          layoutBackgroundColor: color,
        },
      };
      return (await get().submitActionBatch([action], {
        groupLabel: "Set canvas background",
        historyOwner: "human",
      })).result;
    },
  };
}
