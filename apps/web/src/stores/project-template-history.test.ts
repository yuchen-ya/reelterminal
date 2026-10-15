import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clip, MediaItem, Project } from "@reelterminal/core";
import { createEmptyProject } from "./project/project-helpers";
import { createProjectStore } from "./project-store";

const { mockEffectsBridge, mockEffectsBridgeState, mockTransitionBridge } = vi.hoisted(() => {
  const clipEffects = new Map<string, Array<{
    id: string;
    type: string;
    enabled: boolean;
    params: Record<string, unknown>;
    order: number;
  }>>();
  const transitions = new Map<string, unknown[]>();

  const effectsBridge = {
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
  };

  const transitionBridge = {
    isInitialized: vi.fn(() => true),
    setTransitionsForTrack: vi.fn((trackId: string, value: unknown[]) => {
      transitions.set(trackId, [...value]);
    }),
    clearTransitionsForTrack: vi.fn((trackId: string) => { transitions.delete(trackId); }),
  };

  return {
    mockEffectsBridge: effectsBridge,
    mockEffectsBridgeState: { clipEffects },
    mockTransitionBridge: transitionBridge,
  };
});

vi.mock("../bridges/effects-bridge", () => ({
  getEffectsBridge: () => mockEffectsBridge,
}));

vi.mock("../bridges/transition-bridge", () => ({
  getTransitionBridge: () => mockTransitionBridge,
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

const videoClipId = "video-clip-1";
const videoTrackId = "video-track-1";

function createProjectWithEditableClip(includeTextTrack = false): Project {
  const mediaItem: MediaItem = {
    id: "video-media-1",
    name: "hero-shot.mp4",
    type: "video",
    fileHandle: null,
    blob: null,
    metadata: {
      duration: 10,
      width: 1920,
      height: 1080,
      frameRate: 30,
      codec: "h264",
      sampleRate: 48000,
      channels: 2,
      fileSize: 1000000,
    },
    thumbnailUrl: null,
    waveformData: null,
  };
  const clip: Clip = {
    id: videoClipId,
    mediaId: mediaItem.id,
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
  const project = createEmptyProject("Template history project");
  const tracks: Project["timeline"]["tracks"] = [{
    id: videoTrackId,
    type: "video",
    name: "Video",
    clips: [clip],
    transitions: [],
    locked: false,
    hidden: false,
    muted: false,
    solo: false,
  }];
  if (includeTextTrack) {
    tracks.push({
      id: "text-track-1",
      type: "text",
      name: "Titles",
      clips: [],
      transitions: [],
      locked: false,
      hidden: false,
      muted: false,
      solo: false,
    });
  }
  return {
    ...project,
    mediaLibrary: { items: [mediaItem] },
    timeline: {
      ...project.timeline,
      tracks,
      duration: 10,
    },
  };
}

type WorkspaceWriter = <T>(operation: () => T) => Promise<T>;

type ProjectInitialization = "initialProject" | "loadProject";

function createStore(
  submitWorkspaceWrite?: WorkspaceWriter,
  initialization: ProjectInitialization = "initialProject",
  includeTextTrack = false,
) {
  const project = createProjectWithEditableClip(includeTextTrack);
  if (initialization === "initialProject") {
    return createProjectStore({
      initialProject: project,
      isForeground: false,
      submitWorkspaceWrite,
    });
  }

  const store = createProjectStore({ isForeground: false, submitWorkspaceWrite });
  store.getState().loadProject(project);
  return store;
}

function trackTypes(store: ReturnType<typeof createStore>): string[] {
  return store.getState().project.timeline.tracks.map((track) => track.type);
}

function appliedTemplateCount(store: ReturnType<typeof createStore>): number {
  return store.getState().project.timeline.tracks
    .flatMap((track) => track.clips)
    .find((clip) => clip.id === videoClipId)
    ?.metadata?.appliedTemplates?.length ?? 0;
}

function templateOverlayCounts(
  store: ReturnType<typeof createStore>,
  applicationId: string,
): { text: number; shape: number } {
  const project = store.getState().project;
  return {
    text: (project.textClips ?? []).filter(
      (clip) => clip.metadata?.templateSource?.applicationId === applicationId,
    ).length,
    shape: (project.shapeClips ?? []).filter(
      (clip) => clip.metadata?.templateSource?.applicationId === applicationId,
    ).length,
  };
}

function applyLowerThird(store: ReturnType<typeof createStore>): string {
  const applicationId = store.getState().applyEditingTemplate(
    "branding-lower-third",
    videoClipId,
    { name: "Ada Lovelace", role: "Director" },
  );
  if (!applicationId) throw new Error("The built-in lower-third template was not applied");
  return applicationId;
}

function historySnapshot(store: ReturnType<typeof createStore>) {
  const state = store.getState();
  return {
    actionUndo: state.actionHistory.getHistoryEntries().map((entry) => entry.action.id),
    actionRedo: state.actionHistory.getRedoEntries().map((entry) => entry.action.id),
    templateUndo: state.templateUndoStack.map((entry) => ({
      applicationId: entry.applicationId,
      mode: entry.mode,
      timestamp: entry.timestamp,
    })),
    templateRedo: state.templateRedoStack.map((entry) => ({
      applicationId: entry.applicationId,
      mode: entry.mode,
      timestamp: entry.timestamp,
    })),
    redoJournal: [...state.redoJournal],
    canUndo: state.canUndo(),
    canRedo: state.canRedo(),
  };
}

function appliedTemplateControls(
  store: ReturnType<typeof createStore>,
  applicationId: string,
): Record<string, unknown> | undefined {
  return store.getState().project.timeline.tracks
    .flatMap((track) => track.clips)
    .find((clip) => clip.id === videoClipId)
    ?.metadata?.appliedTemplates?.find((template) => template.applicationId === applicationId)
    ?.controlValues;
}

beforeEach(() => {
  mockEffectsBridgeState.clipEffects.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("project store recipe and action history", () => {
  it.each(["initialProject", "loadProject"] as const)(
    "does not redo an audio track after undo followed by applying a recipe (%s)",
    async (initialization) => {
      const store = createStore(undefined, initialization);
      expect((await store.getState().addTrack("audio")).success).toBe(true);
      expect(trackTypes(store)).toContain("audio");

      expect((await store.getState().undo()).success).toBe(true);
      expect(trackTypes(store)).not.toContain("audio");
      expect(store.getState().canRedo()).toBe(true);

      const applicationId = applyLowerThird(store);
      expect(appliedTemplateCount(store)).toBe(1);

      const redoAvailableAfterRecipe = store.getState().canRedo();
      const redo = await store.getState().redo();
      expect({
        redoAvailableAfterRecipe,
        redoSucceeded: redo.success,
        audioTrackReturned: trackTypes(store).includes("audio"),
        recipeRemains: appliedTemplateCount(store),
        recipeOverlays: templateOverlayCounts(store, applicationId),
      }).toEqual({
        redoAvailableAfterRecipe: false,
        redoSucceeded: false,
        audioTrackReturned: false,
        recipeRemains: 1,
        recipeOverlays: { text: 2, shape: 1 },
      });
    },
  );

  it("creating a text overlay after template undo invalidates the template redo", async () => {
    const store = createStore(undefined, "initialProject", true);
    const textTrack = store.getState().project.timeline.tracks.find(
      (track) => track.type === "text",
    );
    expect(textTrack).toBeDefined();
    const applicationId = applyLowerThird(store);
    expect((await store.getState().undo()).success).toBe(true);
    expect(store.getState().templateRedoStack).toHaveLength(1);
    expect(store.getState().redoJournal).toEqual(["template"]);

    const independentText = store.getState().createTextClip(
      textTrack!.id,
      0,
      "Independent title",
      2,
    );
    expect(independentText).toBeTruthy();
    expect(store.getState().project.textClips?.map((clip) => clip.text)).toEqual([
      "Independent title",
    ]);

    const redoAvailable = store.getState().canRedo();
    const redo = await store.getState().redo();
    expect({
      redoAvailable,
      redoSucceeded: redo.success,
      templateApplications: appliedTemplateCount(store),
      independentText: store.getState().project.textClips?.map((clip) => clip.text),
      templateRedo: store.getState().templateRedoStack.length,
      redoJournal: store.getState().redoJournal,
    }).toEqual({
      redoAvailable: false,
      redoSucceeded: false,
      templateApplications: 0,
      independentText: ["Independent title"],
      templateRedo: 0,
      redoJournal: [],
    });
    expect(templateOverlayCounts(store, applicationId)).toEqual({ text: 0, shape: 0 });
  });

  it("renaming media after template undo invalidates the template redo", async () => {
    const store = createStore();
    const applicationId = applyLowerThird(store);
    expect((await store.getState().undo()).success).toBe(true);
    expect(store.getState().templateRedoStack).toHaveLength(1);
    expect(store.getState().redoJournal).toEqual(["template"]);

    expect((await store.getState().renameMedia("video-media-1", "renamed-hero-shot.mp4")).success)
      .toBe(true);
    expect(store.getState().getMediaItem("video-media-1")?.displayName).toBe("renamed-hero-shot.mp4");

    const redoAvailable = store.getState().canRedo();
    const redo = await store.getState().redo();
    expect({
      redoAvailable,
      redoSucceeded: redo.success,
      templateApplications: appliedTemplateCount(store),
      mediaName: store.getState().getMediaItem("video-media-1")?.displayName,
      templateRedo: store.getState().templateRedoStack.length,
      redoJournal: store.getState().redoJournal,
    }).toEqual({
      redoAvailable: false,
      redoSucceeded: false,
      templateApplications: 0,
      mediaName: "renamed-hero-shot.mp4",
      templateRedo: 0,
      redoJournal: [],
    });
    expect(templateOverlayCounts(store, applicationId)).toEqual({ text: 0, shape: 0 });
  });

  it("undoes and redoes a template around an earlier ordinary action", async () => {
    const store = createStore();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    expect((await store.getState().addTrack("audio")).success).toBe(true);

    // Keep the operation order deterministic because the existing history
    // selects the newest action or template by its timestamp.
    clock.mockReturnValue(2000);
    const applicationId = applyLowerThird(store);
    clock.mockRestore();
    expect(trackTypes(store)).toContain("audio");
    expect(appliedTemplateCount(store)).toBe(1);

    expect((await store.getState().undo()).success).toBe(true);
    expect(trackTypes(store)).toContain("audio");
    expect(appliedTemplateCount(store)).toBe(0);
    expect(templateOverlayCounts(store, applicationId)).toEqual({ text: 0, shape: 0 });

    expect((await store.getState().redo()).success).toBe(true);
    expect(trackTypes(store)).toContain("audio");
    expect(appliedTemplateCount(store)).toBe(1);
    expect(templateOverlayCounts(store, applicationId)).toEqual({ text: 2, shape: 1 });

    expect((await store.getState().undo()).success).toBe(true);
    expect((await store.getState().undo()).success).toBe(true);
    expect(trackTypes(store)).not.toContain("audio");
    expect(appliedTemplateCount(store)).toBe(0);

    expect((await store.getState().redo()).success).toBe(true);
    expect(trackTypes(store)).toContain("audio");
    expect(appliedTemplateCount(store)).toBe(0);
    expect((await store.getState().redo()).success).toBe(true);
    expect(trackTypes(store)).toContain("audio");
    expect(appliedTemplateCount(store)).toBe(1);
    expect(templateOverlayCounts(store, applicationId)).toEqual({ text: 2, shape: 1 });
  });

  it("a successful recipe update invalidates action redo and its journal entry", async () => {
    const store = createStore();
    const applicationId = applyLowerThird(store);
    expect((await store.getState().addTrack("audio")).success).toBe(true);
    expect((await store.getState().undo()).success).toBe(true);
    expect(store.getState().actionHistory.canRedo()).toBe(true);
    expect(store.getState().redoJournal).toEqual(["action"]);

    expect(store.getState().updateEditingTemplateApplication(
      videoClipId,
      applicationId,
      { name: "Grace Hopper", role: "Engineer" },
    )).toBe(true);

    expect(historySnapshot(store)).toMatchObject({
      actionRedo: [],
      templateRedo: [],
      redoJournal: [],
      canRedo: false,
    });
    expect(trackTypes(store)).not.toContain("audio");
    expect(appliedTemplateControls(store, applicationId)).toMatchObject({
      name: "Grace Hopper",
      role: "Engineer",
    });
    expect((await store.getState().redo()).success).toBe(false);
    expect(trackTypes(store)).not.toContain("audio");
  });

  it("a same-value recipe update succeeds and invalidates template redo", async () => {
    const store = createStore();
    const applicationId = applyLowerThird(store);
    expect(store.getState().updateEditingTemplateApplication(
      videoClipId,
      applicationId,
      { name: "Grace Hopper", role: "Engineer" },
    )).toBe(true);
    expect((await store.getState().undo()).success).toBe(true);
    expect(store.getState().templateRedoStack).toHaveLength(1);
    expect(store.getState().redoJournal).toEqual(["template"]);
    expect(appliedTemplateControls(store, applicationId)).toMatchObject({
      name: "Ada Lovelace",
      role: "Director",
    });

    expect(store.getState().updateEditingTemplateApplication(
      videoClipId,
      applicationId,
      { name: "Ada Lovelace", role: "Director" },
    )).toBe(true);

    const history = historySnapshot(store);
    expect(history.templateRedo).toEqual([]);
    expect(history.actionRedo).toEqual([]);
    expect(history.redoJournal).toEqual([]);
    expect(history.canRedo).toBe(false);
    expect(history.templateUndo).toHaveLength(2);
    expect(history.canUndo).toBe(true);
    expect(appliedTemplateControls(store, applicationId)).toMatchObject({
      name: "Ada Lovelace",
      role: "Director",
    });
  });

  it("a successful recipe removal invalidates action redo and remains non-undoable", async () => {
    const store = createStore();
    const applicationId = applyLowerThird(store);
    expect((await store.getState().addTrack("audio")).success).toBe(true);
    expect((await store.getState().undo()).success).toBe(true);
    expect(store.getState().actionHistory.canRedo()).toBe(true);

    expect(store.getState().removeEditingTemplateApplication(
      videoClipId,
      applicationId,
    )).toBe(true);

    const history = historySnapshot(store);
    expect(history.actionRedo).toEqual([]);
    expect(history.templateUndo).toEqual([]);
    expect(history.templateRedo).toEqual([]);
    expect(history.redoJournal).toEqual([]);
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    expect(trackTypes(store)).not.toContain("audio");
    expect(appliedTemplateCount(store)).toBe(0);
    expect((await store.getState().undo()).success).toBe(false);
  });

  it("a successful recipe removal invalidates template redo without adding undo", async () => {
    const store = createStore();
    const applicationId = applyLowerThird(store);
    expect(store.getState().updateEditingTemplateApplication(
      videoClipId,
      applicationId,
      { name: "Grace Hopper", role: "Engineer" },
    )).toBe(true);
    expect((await store.getState().undo()).success).toBe(true);
    expect(store.getState().templateRedoStack).toHaveLength(1);
    expect(store.getState().redoJournal).toEqual(["template"]);

    expect(store.getState().removeEditingTemplateApplication(
      videoClipId,
      applicationId,
    )).toBe(true);

    const history = historySnapshot(store);
    expect(history.templateUndo).toEqual([]);
    expect(history.templateRedo).toEqual([]);
    expect(history.redoJournal).toEqual([]);
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    expect(appliedTemplateCount(store)).toBe(0);
    expect((await store.getState().undo()).success).toBe(false);
    expect((await store.getState().redo()).success).toBe(false);
  });

  it("a new ordinary action after template undo clears template redo but remains undoable", async () => {
    const store = createStore();
    const applicationId = applyLowerThird(store);
    expect((await store.getState().undo()).success).toBe(true);
    expect(store.getState().templateRedoStack).toHaveLength(1);
    expect(store.getState().redoJournal).toEqual(["template"]);
    expect(appliedTemplateCount(store)).toBe(0);

    expect((await store.getState().addTrack("audio")).success).toBe(true);
    const history = historySnapshot(store);
    expect(history.actionUndo).toHaveLength(1);
    expect(history.actionRedo).toEqual([]);
    expect(history.templateRedo).toEqual([]);
    expect(history.redoJournal).toEqual([]);
    expect(history.canUndo).toBe(true);
    expect(history.canRedo).toBe(false);
    expect(trackTypes(store)).toContain("audio");

    expect((await store.getState().undo()).success).toBe(true);
    expect(trackTypes(store)).not.toContain("audio");
    expect(appliedTemplateCount(store)).toBe(0);
    expect((await store.getState().redo()).success).toBe(true);
    expect(trackTypes(store)).toContain("audio");
    expect(appliedTemplateCount(store)).toBe(0);
    expect(appliedTemplateControls(store, applicationId)).toBeUndefined();
  });

  it("failed updates and removals preserve project, stacks, and redo journal", async () => {
    const store = createStore();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    expect((await store.getState().addTrack("audio")).success).toBe(true);
    clock.mockReturnValue(2000);
    const applicationId = applyLowerThird(store);
    clock.mockRestore();
    expect((await store.getState().undo()).success).toBe(true);
    expect((await store.getState().undo()).success).toBe(true);
    expect(store.getState().templateRedoStack).toHaveLength(1);
    expect(store.getState().actionHistory.canRedo()).toBe(true);
    expect(store.getState().redoJournal).toEqual(["template", "action"]);

    const projectBefore = store.getState().project;
    const historyBefore = historySnapshot(store);
    expect(store.getState().updateEditingTemplateApplication(
      videoClipId,
      "missing-application",
      { name: "Invalid Update" },
    )).toBe(false);
    expect(store.getState().removeEditingTemplateApplication(
      videoClipId,
      "missing-application",
    )).toBe(false);

    expect(store.getState().project).toBe(projectBefore);
    expect(historySnapshot(store)).toEqual(historyBefore);
    expect(appliedTemplateCount(store)).toBe(0);
    expect(trackTypes(store)).not.toContain("audio");
    expect(applicationId).toBeTruthy();
  });

  it("keeps redo valid after a failed recipe/action and a cancelled queued redo", async () => {
    let cancelQueuedMutation = false;
    const submitWorkspaceWrite: WorkspaceWriter = async <T,>(operation: () => T): Promise<T> => {
      if (cancelQueuedMutation) {
        throw new DOMException("Workspace mutation was cancelled", "AbortError");
      }
      return operation();
    };
    const store = createStore(submitWorkspaceWrite);
    expect((await store.getState().addTrack("audio")).success).toBe(true);
    expect((await store.getState().undo()).success).toBe(true);
    expect(store.getState().canRedo()).toBe(true);

    const projectBeforeFailedRecipe = store.getState().project;
    expect(store.getState().applyEditingTemplate("missing-template", videoClipId)).toBeNull();
    expect(store.getState().project).toBe(projectBeforeFailedRecipe);
    expect(store.getState().canRedo()).toBe(true);

    const failedAction = await store.getState().executeAction({
      type: "clip/remove",
      id: "missing-clip-remove",
      timestamp: Date.now(),
      params: { clipId: "missing-clip" },
    });
    expect(failedAction.success).toBe(false);
    expect(trackTypes(store)).not.toContain("audio");
    expect(store.getState().canRedo()).toBe(true);

    cancelQueuedMutation = true;
    await expect(store.getState().redo()).rejects.toMatchObject({ name: "AbortError" });
    expect(trackTypes(store)).not.toContain("audio");
    expect(store.getState().canRedo()).toBe(true);

    cancelQueuedMutation = false;
    expect((await store.getState().redo()).success).toBe(true);
    expect(trackTypes(store)).toContain("audio");
  });

  it("keeps the established failed result for undo and redo with no history", async () => {
    const store = createStore();
    const projectBefore = store.getState().project;

    expect(store.getState().canUndo()).toBe(false);
    expect(store.getState().canRedo()).toBe(false);
    expect(await store.getState().undo()).toMatchObject({
      success: false,
      error: { code: "INVALID_PARAMS", message: "Nothing to undo" },
    });
    expect(await store.getState().redo()).toMatchObject({
      success: false,
      error: { code: "INVALID_PARAMS", message: "Nothing to redo" },
    });
    expect(store.getState().project).toBe(projectBefore);
    expect(store.getState().canUndo()).toBe(false);
    expect(store.getState().canRedo()).toBe(false);
  });
});
