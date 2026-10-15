import { indexedDB as testIndexedDB } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clip, Project } from "@reelterminal/core";
import { GraphicsEngine, TitleEngine, TemplateEngine } from "@reelterminal/core";
import { createEmptyProject } from "./project/project-helpers";
import { createProjectStore, type ProjectState } from "./project-store";

const { mockEffectsBridge, mockClipEffects } = vi.hoisted(() => {
  const clipEffects = new Map<string, Array<{
    id: string;
    type: string;
    enabled: boolean;
    params: Record<string, unknown>;
    order: number;
  }>>();

  return {
    mockClipEffects: clipEffects,
    mockEffectsBridge: {
      isInitialized: vi.fn(() => true),
      applyVideoEffect: vi.fn((clipId: string, effectType: string, params: Record<string, unknown> = {}) => {
        const effects = clipEffects.get(clipId) ?? [];
        const effect = {
          id: `effect-${effects.length + 1}`,
          type: effectType,
          enabled: true,
          params: { ...params },
          order: effects.length,
        };
        clipEffects.set(clipId, [...effects, effect]);
        return { success: true, effectId: effect.id };
      }),
      getEffects: vi.fn((clipId: string) => [...(clipEffects.get(clipId) ?? [])]),
      getEffect: vi.fn((clipId: string, effectId: string) =>
        (clipEffects.get(clipId) ?? []).find((effect) => effect.id === effectId),
      ),
      deserializeEffects: vi.fn((clipId: string, data: { effects: Array<{
        id: string;
        type: string;
        enabled: boolean;
        params: Record<string, unknown>;
        order: number;
      }> }) => {
        clipEffects.set(clipId, data.effects.map((effect) => ({ ...effect })));
        return { success: true };
      }),
      clearEffects: vi.fn((clipId: string) => { clipEffects.delete(clipId); }),
      getColorGrading: vi.fn(() => ({})),
    },
  };
});

vi.mock("../bridges/effects-bridge", () => ({
  getEffectsBridge: () => mockEffectsBridge,
}));

vi.mock("../bridges/transition-bridge", () => ({
  getTransitionBridge: () => ({
    isInitialized: vi.fn(() => true),
    setTransitionsForTrack: vi.fn(),
    clearTransitionsForTrack: vi.fn(),
  }),
}));

vi.mock("../services/auto-save", () => ({
  autoSaveManager: {
    start: vi.fn(),
    markDirty: vi.fn(),
    hasUnsavedChanges: vi.fn(() => false),
    checkForRecovery: vi.fn().mockResolvedValue([]),
    recover: vi.fn().mockResolvedValue(null),
    startAutoSave: vi.fn(),
    stopAutoSave: vi.fn(),
    triggerSave: vi.fn(),
    forceSave: vi.fn().mockResolvedValue(undefined),
    getRecentSaves: vi.fn().mockResolvedValue([]),
    loadSave: vi.fn(),
    deleteSave: vi.fn(),
  },
  initializeAutoSave: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../bridges/media-bridge", () => ({
  getMediaBridge: vi.fn(() => ({
    isInitialized: vi.fn(() => true),
    importFile: vi.fn().mockResolvedValue({ success: true }),
  })),
  initializeMediaBridge: vi.fn().mockResolvedValue(undefined),
}));

const videoClipId = "history-boundary-video";
const videoTrackId = "history-boundary-video-track";

function createProject(): Project {
  const project = createEmptyProject("History boundary evidence");
  const clip: Clip = {
    id: videoClipId,
    mediaId: "history-boundary-media",
    trackId: videoTrackId,
    startTime: 0,
    duration: 10,
    inPoint: 0,
    outPoint: 10,
    effects: [],
    audioEffects: [],
    transform: {
      position: { x: 0.5, y: 0.5 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      anchor: { x: 0.5, y: 0.5 },
      opacity: 1,
    },
    volume: 1,
    keyframes: [],
  };

  return {
    ...project,
    timeline: {
      ...project.timeline,
      tracks: [{
        id: videoTrackId,
        type: "video",
        name: "Video",
        clips: [clip],
        transitions: [],
        locked: false,
        hidden: false,
        muted: false,
        solo: false,
      }],
      duration: 10,
    },
  };
}

function createStore() {
  const overlayEngines = {
    titleEngine: new TitleEngine(),
    graphicsEngine: new GraphicsEngine(),
  };
  const store = createProjectStore({
    initialProject: createProject(),
    isForeground: false,
    overlayEngines,
  });
  return { store, overlayEngines };
}

function applyLowerThird(store: ReturnType<typeof createStore>["store"]): string {
  const applicationId = store.getState().applyEditingTemplate(
    "branding-lower-third",
    videoClipId,
    { name: "Ada Lovelace", role: "Director" },
  );
  if (!applicationId) throw new Error("The built-in lower-third template was not applied");
  return applicationId;
}

function templateTextClips(
  store: ReturnType<typeof createStore>["store"],
  applicationId: string,
) {
  return (store.getState().project.textClips ?? []).filter(
    (clip) => clip.metadata?.templateSource?.applicationId === applicationId,
  );
}

function templateShapes(
  project: Project,
  applicationId: string,
) {
  return (project.shapeClips ?? []).filter(
    (clip) => clip.metadata?.templateSource?.applicationId === applicationId,
  );
}

type UntrackedSetterName = "rotate3d" | "perspective" | "transformStyle";

const untrackedOverlaySetters: Array<{
  name: UntrackedSetterName;
  value: unknown;
  apply: (state: ProjectState, clipId: string) => boolean;
}> = [
  {
    name: "rotate3d",
    value: { x: 33, y: -12, z: 5 },
    apply: (state, clipId) => state.updateClipRotate3D(clipId, { x: 33, y: -12, z: 5 }),
  },
  {
    name: "perspective",
    value: 840,
    apply: (state, clipId) => state.updateClipPerspective(clipId, 840),
  },
  {
    name: "transformStyle",
    value: "preserve-3d",
    apply: (state, clipId) => state.updateClipTransformStyle(clipId, "preserve-3d"),
  },
];

function recipeControls(
  store: ReturnType<typeof createStore>["store"],
  applicationId: string,
) {
  return store.getState().project.timeline.tracks
    .flatMap((track) => track.clips)
    .find((clip) => clip.id === videoClipId)
    ?.metadata?.appliedTemplates?.find((template) => template.applicationId === applicationId)
    ?.controlValues;
}

function engineTemplateText(
  titleEngine: TitleEngine,
  applicationId: string,
) {
  return titleEngine.getAllTextClips().filter(
    (clip) => clip.metadata?.templateSource?.applicationId === applicationId,
  );
}

function engineTemplateShapes(
  graphicsEngine: GraphicsEngine,
  applicationId: string,
) {
  return graphicsEngine.getAllShapeClips().filter(
    (clip) => clip.metadata?.templateSource?.applicationId === applicationId,
  );
}

beforeEach(() => {
  mockClipEffects.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("project history boundaries", () => {
  it.each(untrackedOverlaySetters)(
    "$name setter after recipe undo invalidates stale template redo",
    async ({ name, value, apply }) => {
      const { store } = createStore();
      const applicationId = applyLowerThird(store);
      expect(store.getState().updateEditingTemplateApplication(
        videoClipId,
        applicationId,
        { name: "Grace Hopper", role: "Engineer" },
      )).toBe(true);
      expect((await store.getState().undo()).success).toBe(true);

      const overlay = templateTextClips(store, applicationId)[0];
      expect(overlay).toBeDefined();
      expect(apply(store.getState(), overlay.id)).toBe(true);
      expect(templateTextClips(store, applicationId)
        .find((clip) => clip.id === overlay.id)?.transform[name]).toEqual(value);

      const redoAvailableAfterUserEdit = store.getState().canRedo();
      const redo = await store.getState().redo();
      const restoredOverlay = templateTextClips(store, applicationId)
        .find((clip) => clip.id === overlay.id);

      expect({
        redoAvailableAfterUserEdit,
        redoSucceeded: redo.success,
        recipeControls: recipeControls(store, applicationId),
        editedFieldAfterRedo: restoredOverlay?.transform[name],
      }).toMatchObject({
        redoAvailableAfterUserEdit: false,
        redoSucceeded: false,
        recipeControls: { name: "Ada Lovelace", role: "Director" },
      });
      expect(restoredOverlay?.transform[name]).toEqual(value);
    },
  );

  it.each(untrackedOverlaySetters)(
    "$name setter after action undo invalidates old action redo",
    async ({ name, value, apply }) => {
      const { store } = createStore();
      expect((await store.getState().addTrack("audio")).success).toBe(true);
      expect((await store.getState().undo()).success).toBe(true);

      expect(apply(store.getState(), videoClipId)).toBe(true);
      const redoAvailableAfterUserEdit = store.getState().canRedo();
      const redo = await store.getState().redo();
      const clip = store.getState().getClip(videoClipId);

      expect({
        redoAvailableAfterUserEdit,
        redoSucceeded: redo.success,
        audioTrackReturned: store.getState().project.timeline.tracks.some(
          (track) => track.type === "audio",
        ),
        editedFieldAfterRedo: clip?.transform[name],
      }).toMatchObject({
        redoAvailableAfterUserEdit: false,
        redoSucceeded: false,
        audioTrackReturned: false,
        editedFieldAfterRedo: value,
      });
    },
  );

  it("ordinary edit, recipe, 3D branch, replacement and new undo/redo stay in their project", async () => {
    const { store } = createStore();
    expect((await store.getState().addTrack("audio")).success).toBe(true);
    const applicationId = applyLowerThird(store);
    expect(store.getState().updateEditingTemplateApplication(videoClipId, applicationId, { name: "Grace", role: "Engineer" })).toBe(true);
    expect((await store.getState().undo()).success).toBe(true);
    const overlay = templateTextClips(store, applicationId)[0]!;
    expect(store.getState().updateClipRotate3D(overlay.id, { x: 33, y: 0, z: 0 })).toBe(true);
    expect((await store.getState().redo()).success).toBe(false);
    expect(templateTextClips(store, applicationId)[0]?.transform.rotate3d?.x).toBe(33);
    window.indexedDB = testIndexedDB;
    const engine = new TemplateEngine();
    await engine.initialize();
    const template = await engine.loadTemplate("builtin-tiktok-promo");
    store.getState().loadProject(engine.applyTemplate(template!, {}).project);
    const replacement = store.getState().project;
    expect(store.getState().templateUndoStack).toEqual([]);
    expect(store.getState().templateRedoStack).toEqual([]);
    expect(store.getState().redoJournal).toEqual([]);
    expect((await store.getState().undo()).success).toBe(false);
    expect((await store.getState().redo()).success).toBe(false);
    expect(store.getState().project).toBe(replacement);
    expect((await store.getState().removeTrack("track-text-1")).success).toBe(true);
    expect((await store.getState().undo()).success).toBe(true);
    expect(store.getState().project.timeline.tracks.find(t => t.id === "track-text-1")?.clips.map(c => c.id)).toEqual(["clip-cta"]);
    expect((await store.getState().redo()).success).toBe(true);
    expect(store.getState().project.timeline.tracks.some(t => t.id === "track-text-1")).toBe(false);
    expect((store.getState().project.textClips ?? []).some(c => c.id === overlay.id)).toBe(false);
  });

  it("rejected direct setters preserve the valid redo branch", async () => {
    const { store } = createStore();
    expect((await store.getState().addTrack("audio")).success).toBe(true);
    expect((await store.getState().undo()).success).toBe(true);
    const before = store.getState().project;
    expect(store.getState().updateClipRotate3D("missing", { x: 1, y: 2, z: 3 })).toBe(false);
    expect(store.getState().updateClipPerspective(videoClipId, -1)).toBe(false);
    expect(store.getState().updateClipTransformStyle("missing", "flat")).toBe(false);
    expect(store.getState().project).toBe(before);
    expect(store.getState().canRedo()).toBe(true);
    expect((await store.getState().redo()).success).toBe(true);
  });
});

// These observations remain known faults, not assertions of repaired behavior.
describe("unrepaired engine restoration fault injection", () => {
  it("a one-shot GraphicsEngine restore failure during recipe update leaves canonical overlays and engines split", () => {
    const { store, overlayEngines } = createStore();
    const applicationId = applyLowerThird(store);
    const projectBefore = store.getState().project;
    const controlsBefore = recipeControls(store, applicationId);
    const createShape = vi.spyOn(overlayEngines.graphicsEngine, "createShape")
      .mockImplementationOnce(() => { throw new Error("injected GraphicsEngine createShape failure"); });

    expect(() => store.getState().updateEditingTemplateApplication(
      videoClipId,
      applicationId,
      { name: "Grace Hopper", role: "Engineer" },
    )).toThrow("injected GraphicsEngine createShape failure");

    expect(createShape).toHaveBeenCalledTimes(1);
    expect(store.getState().project).toBe(projectBefore);
    expect(recipeControls(store, applicationId)).toEqual(controlsBefore);
    expect(templateTextClips(store, applicationId)).toHaveLength(2);
    expect(templateShapes(store.getState().project, applicationId)).toHaveLength(1);
    expect(engineTemplateText(overlayEngines.titleEngine, applicationId)).toHaveLength(0);
    expect(engineTemplateShapes(overlayEngines.graphicsEngine, applicationId)).toHaveLength(0);
  });

  it("a one-shot GraphicsEngine restore failure during recipe undo leaves the prior project canonical", async () => {
    const { store, overlayEngines } = createStore();
    const applicationId = applyLowerThird(store);
    expect(store.getState().updateEditingTemplateApplication(
      videoClipId,
      applicationId,
      { name: "Grace Hopper", role: "Engineer" },
    )).toBe(true);
    const projectBefore = store.getState().project;
    const controlsBefore = recipeControls(store, applicationId);
    const createShape = vi.spyOn(overlayEngines.graphicsEngine, "createShape")
      .mockImplementationOnce(() => { throw new Error("injected GraphicsEngine createShape failure"); });

    await expect(store.getState().undo()).rejects.toThrow(
      "injected GraphicsEngine createShape failure",
    );

    expect(createShape).toHaveBeenCalledTimes(1);
    expect(store.getState().project).toBe(projectBefore);
    expect(recipeControls(store, applicationId)).toEqual(controlsBefore);
    expect(store.getState().templateRedoStack).toHaveLength(0);
    expect(templateShapes(store.getState().project, applicationId)).toHaveLength(1);
    expect(engineTemplateShapes(overlayEngines.graphicsEngine, applicationId)).toHaveLength(0);
    expect(engineTemplateText(overlayEngines.titleEngine, applicationId).map((clip) => clip.text))
      .not.toEqual(templateTextClips(store, applicationId).map((clip) => clip.text));
  });

  it("a one-shot GraphicsEngine restore failure during recipe redo leaves the undone project canonical", async () => {
    const { store, overlayEngines } = createStore();
    const applicationId = applyLowerThird(store);
    expect(store.getState().updateEditingTemplateApplication(
      videoClipId,
      applicationId,
      { name: "Grace Hopper", role: "Engineer" },
    )).toBe(true);
    expect((await store.getState().undo()).success).toBe(true);
    const projectBefore = store.getState().project;
    const controlsBefore = recipeControls(store, applicationId);
    const createShape = vi.spyOn(overlayEngines.graphicsEngine, "createShape")
      .mockImplementationOnce(() => { throw new Error("injected GraphicsEngine createShape failure"); });

    await expect(store.getState().redo()).rejects.toThrow(
      "injected GraphicsEngine createShape failure",
    );

    expect(createShape).toHaveBeenCalledTimes(1);
    expect(store.getState().project).toBe(projectBefore);
    expect(recipeControls(store, applicationId)).toEqual(controlsBefore);
    expect(store.getState().templateRedoStack).toHaveLength(1);
    expect(templateShapes(store.getState().project, applicationId)).toHaveLength(1);
    expect(engineTemplateShapes(overlayEngines.graphicsEngine, applicationId)).toHaveLength(0);
    expect(engineTemplateText(overlayEngines.titleEngine, applicationId).map((clip) => clip.text))
      .not.toEqual(templateTextClips(store, applicationId).map((clip) => clip.text));
  });
});
