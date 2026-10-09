import { v4 as uuidv4 } from "uuid";
import type { StoreApi } from "zustand";
import type {
  Action,
  Project,
  ShapeClip,
  TextClip,
  SVGClip,
  StickerClip,
  GraphicsEngine,
  TitleEngine,
} from "@reelterminal/core";
import {
  calculateProjectDuration,
  getSpeedEngine,
  getAdjustmentLayerEngine,
  multicamEngine,
  getNestedSequenceEngine,
} from "@reelterminal/core";
import type { ProjectState } from "../project-store";
import type { ClipHistoryEntryType } from "./index";
import { useEngineStore } from "../engine-store";

type Get = StoreApi<ProjectState>["getState"];
type Set = StoreApi<ProjectState>["setState"];

type OverlayField = "textClips" | "shapeClips" | "svgClips" | "stickerClips";

export interface ProjectStoreHelpers {
  overlayEngines: { titleEngine: TitleEngine; graphicsEngine: GraphicsEngine };
  applyClipDataSnapshot(
    type: ClipHistoryEntryType,
    clipId: string,
    data: ShapeClip | TextClip | SVGClip | StickerClip,
  ): boolean;
  cloneClipSnapshot<T>(clip: T): T;
  recordOverlayCreate(
    prefix: string,
    field: OverlayField,
    clip: { id: string },
  ): void;
  recordOverlayUpdate(
    prefix: string,
    field: OverlayField,
    clipId: string,
    updatedClip: { id: string },
    before: { id: string } | undefined,
  ): void;
  recordOverlayRemove(
    prefix: string,
    field: OverlayField,
    clipId: string,
    before: { id: string } | undefined,
  ): void;
  syncOverlayEnginesFromProject(): void;
}

export function createProjectStoreHelpers(
  set: Set,
  get: Get,
  overlayEngines: { titleEngine: TitleEngine; graphicsEngine: GraphicsEngine },
): ProjectStoreHelpers {
  const cloneClipSnapshot = <T,>(clip: T): T =>
    JSON.parse(JSON.stringify(clip)) as T;

  const overlayList = (
    project: Project,
    field: OverlayField,
  ): Array<{ id: string }> =>
    ((project as unknown as Record<string, Array<{ id: string }>>)[field] ??
      []) as Array<{ id: string }>;

  const applyClipDataSnapshot = (
    type: ClipHistoryEntryType,
    clipId: string,
    data: ShapeClip | TextClip | SVGClip | StickerClip,
  ): boolean => {
    if (type === "text") {
      return Boolean(
        overlayEngines.titleEngine.updateTextClip(clipId, data as Partial<TextClip>),
      );
    }
    if (type === "shape") {
      return Boolean(
        overlayEngines.graphicsEngine.updateShapeClip(clipId, data as Partial<ShapeClip>),
      );
    }
    if (type === "svg") {
      return Boolean(
        overlayEngines.graphicsEngine.updateSVGClip(clipId, data as Partial<SVGClip>),
      );
    }
    return Boolean(
      overlayEngines.graphicsEngine.updateStickerClip(clipId, data as Partial<StickerClip>),
    );
  };

  const recordOverlayCreate = (
    prefix: string,
    field: OverlayField,
    clip: { id: string },
  ): void => {
    const { project, actionExecutor } = get();
    const actionId = uuidv4();
    const snap = cloneClipSnapshot(clip);
    const action: Action = {
      type: `${prefix}/create`,
      id: actionId,
      timestamp: Date.now(),
      params: { clip: snap },
    };
    const inverse: Action = {
      type: `${prefix}/remove`,
      id: `inverse-${actionId}`,
      timestamp: Date.now(),
      params: { clipId: clip.id },
    };
    const nextProject = {
      ...project,
      [field]: [...overlayList(project, field), snap],
      modifiedAt: Date.now(),
    } as Project;
    set({
      project: {
        ...nextProject,
        timeline: {
          ...nextProject.timeline,
          duration: calculateProjectDuration(nextProject),
        },
      },
      clipRedoStack: [],
    });
    actionExecutor.getHistory().push(action, inverse);
  };

  const recordOverlayUpdate = (
    prefix: string,
    field: OverlayField,
    clipId: string,
    updatedClip: { id: string },
    before: { id: string } | undefined,
  ): void => {
    const { project, actionExecutor } = get();
    const actionId = uuidv4();
    const after = cloneClipSnapshot(updatedClip);
    const action: Action = {
      type: `${prefix}/update`,
      id: actionId,
      timestamp: Date.now(),
      params: { clipId, updates: after },
    };
    const inverse: Action = {
      type: `${prefix}/update`,
      id: `inverse-${actionId}`,
      timestamp: Date.now(),
      params: { clipId, updates: before ? cloneClipSnapshot(before) : {} },
    };
    const list = overlayList(project, field);
    const next = list.some((c) => c.id === clipId)
      ? list.map((c) => (c.id === clipId ? after : c))
      : [...list, after];
    const nextProject = {
      ...project,
      [field]: next,
      modifiedAt: Date.now(),
    } as Project;
    set({
      project: {
        ...nextProject,
        timeline: {
          ...nextProject.timeline,
          duration: calculateProjectDuration(nextProject),
        },
      },
      clipRedoStack: [],
    });
    actionExecutor.getHistory().push(action, inverse);
  };

  const recordOverlayRemove = (
    prefix: string,
    field: OverlayField,
    clipId: string,
    before: { id: string } | undefined,
  ): void => {
    const { project, actionExecutor } = get();
    const actionId = uuidv4();
    const action: Action = {
      type: `${prefix}/remove`,
      id: actionId,
      timestamp: Date.now(),
      params: { clipId },
    };
    const inverse: Action | null = before
      ? {
          type: `${prefix}/create`,
          id: `inverse-${actionId}`,
          timestamp: Date.now(),
          params: { clip: cloneClipSnapshot(before) },
        }
      : null;
    const nextProject = {
      ...project,
      [field]: overlayList(project, field).filter((c) => c.id !== clipId),
      modifiedAt: Date.now(),
    } as Project;
    set({
      project: {
        ...nextProject,
        timeline: {
          ...nextProject.timeline,
          duration: calculateProjectDuration(nextProject),
        },
      },
      clipRedoStack: [],
    });
    actionExecutor.getHistory().push(action, inverse);
  };

  const syncOverlayEnginesFromProject = (): void => {
    const { project } = get();
    overlayEngines.titleEngine.loadTextClips(project.textClips ?? []);
    overlayEngines.graphicsEngine.loadShapeClips(project.shapeClips ?? []);
    overlayEngines.graphicsEngine.loadSVGClips(project.svgClips ?? []);
    overlayEngines.graphicsEngine.loadStickerClips(project.stickerClips ?? []);
    if (!get().isForeground) return;
    const speedEngine = getSpeedEngine();
    speedEngine.loadClips(project.timeline.tracks.flatMap((track) => track.clips));
    const chromaClips = project.timeline.tracks
      .flatMap((t) => t.clips)
      .filter((c) => c.chromaKey);
    if (chromaClips.length > 0) {
      void useEngineStore
        .getState()
        .getChromaKeyEngine()
        .then((engine) => {
          for (const c of chromaClips) {
            if (c.chromaKey) engine.setSettings(c.id, c.chromaKey);
          }
        });
    }
    getAdjustmentLayerEngine().loadLayers(project.adjustmentLayers ?? []);
    if (project.masks) {
      void useEngineStore
        .getState()
        .getMaskEngine()
        .then((engine) => engine.loadMasks(project.masks ?? []));
    }
    if (project.multicamGroups) {
      multicamEngine.loadGroups(project.multicamGroups);
    }
    if (project.compoundClips || project.nestedInstances) {
      getNestedSequenceEngine().loadState(
        project.compoundClips ?? [],
        project.nestedInstances ?? [],
      );
    }
  };

  return {
    applyClipDataSnapshot,
    overlayEngines,
    cloneClipSnapshot,
    recordOverlayCreate,
    recordOverlayUpdate,
    recordOverlayRemove,
    syncOverlayEnginesFromProject,
  };
}
