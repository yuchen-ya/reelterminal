import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clip, MediaItem, Project } from "@reelterminal/core";
import { createEmptyProject } from "./project/project-helpers";
import { createProjectStore } from "./project-store";

const { effectsBridge, bridgeState, transitionBridge } = vi.hoisted(() => {
  const clipEffects = new Map<string, Array<{
    id: string;
    type: string;
    enabled: boolean;
    params: Record<string, unknown>;
    order: number;
  }>>();
  const transitions = new Map<string, unknown[]>();

  return {
    effectsBridge: {
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
    bridgeState: { clipEffects },
    transitionBridge: {
      isInitialized: vi.fn(() => true),
      setTransitionsForTrack: vi.fn((trackId: string, value: unknown[]) => {
        transitions.set(trackId, [...value]);
      }),
      clearTransitionsForTrack: vi.fn((trackId: string) => { transitions.delete(trackId); }),
    },
  };
});

vi.mock("../bridges/effects-bridge", () => ({
  getEffectsBridge: () => effectsBridge,
}));

vi.mock("../bridges/transition-bridge", () => ({
  getTransitionBridge: () => transitionBridge,
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

const clipId = "history-order-clip";
const trackId = "history-order-track";

function createProject(): Project {
  const media: MediaItem = {
    id: "history-order-media",
    name: "history-order.mp4",
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
    id: clipId,
    mediaId: media.id,
    trackId,
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
  const project = createEmptyProject("History order evidence");
  return {
    ...project,
    mediaLibrary: { items: [media] },
    timeline: {
      ...project.timeline,
      tracks: [{
        id: trackId,
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
  return createProjectStore({
    initialProject: createProject(),
    isForeground: false,
  });
}

function getClip(store: ReturnType<typeof createStore>) {
  return store.getState().project.timeline.tracks
    .flatMap((track) => track.clips)
    .find((clip) => clip.id === clipId)!;
}

function getRecipeState(
  store: ReturnType<typeof createStore>,
  applicationId: string,
) {
  const project = store.getState().project;
  return {
    applied: getClip(store).metadata?.appliedTemplates?.some(
      (template) => template.applicationId === applicationId,
    ) ?? false,
    textOverlayCount: (project.textClips ?? []).filter(
      (overlay) => overlay.metadata?.templateSource?.applicationId === applicationId,
    ).length,
    shapeOverlayCount: (project.shapeClips ?? []).filter(
      (overlay) => overlay.metadata?.templateSource?.applicationId === applicationId,
    ).length,
  };
}

function applyRecipe(store: ReturnType<typeof createStore>): string {
  const applicationId = store.getState().applyEditingTemplate(
    "branding-lower-third",
    clipId,
    { name: "Ada Lovelace", role: "Director" },
  );
  if (!applicationId) throw new Error("The built-in lower-third recipe was not applied");
  return applicationId;
}

beforeEach(() => {
  bridgeState.clipEffects.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("project history order regression", () => {
  it("keeps ordinary rapid clip updates in one undo and redo unit", async () => {
    const store = createStore();
    let now = 2000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    expect((await store.getState().updateClipTransform(clipId, {
      position: { x: 0.25, y: 0.5 },
    })).success).toBe(true);
    now = 2050;
    expect((await store.getState().updateClipTransform(clipId, {
      position: { x: 0.75, y: 0.5 },
    })).success).toBe(true);

    const actionEntries = store.getState().actionHistory.getHistoryEntries();
    expect(actionEntries).toHaveLength(2);
    expect(actionEntries[1]?.groupId).toBe(actionEntries[0]?.groupId);

    expect((await store.getState().undo()).success).toBe(true);
    expect(getClip(store).transform.position.x).toBe(0.5);
    expect(store.getState().actionHistory.getRedoEntries()).toHaveLength(2);

    now = 2051;
    expect((await store.getState().redo()).success).toBe(true);
    expect(getClip(store).transform.position.x).toBe(0.75);
    expect(store.getState().actionHistory.getRedoEntries()).toHaveLength(0);
  });

  it.each([false, true])("orders same-millisecond commits (recipe first: %s)", async (recipeFirst) => {
    const store = createStore();
    vi.spyOn(Date, "now").mockReturnValue(1000);
    let applicationId = recipeFirst ? applyRecipe(store) : "";
    expect((await store.getState().updateClipTransform(clipId, { position: { x: 0.25, y: 0.5 } })).success).toBe(true);
    if (!recipeFirst) applicationId = applyRecipe(store);
    for (let cycle = 0; cycle < 2; cycle++) {
      expect((await store.getState().undo()).success).toBe(true);
      expect(getClip(store).transform.position.x).toBe(recipeFirst ? 0.5 : 0.25);
      expect(getRecipeState(store, applicationId).applied).toBe(recipeFirst);
      expect((await store.getState().undo()).success).toBe(true);
      expect(getClip(store).transform.position.x).toBe(0.5);
      expect(getRecipeState(store, applicationId).applied).toBe(false);
      expect((await store.getState().redo()).success).toBe(true);
      expect((await store.getState().redo()).success).toBe(true);
      expect(getClip(store).transform.position.x).toBe(0.25);
      expect(getRecipeState(store, applicationId).applied).toBe(true);
    }
  });

  it.each([false, true])("separates rapid actions across recipes (open gesture: %s)", async (openGesture) => {
    const store = createStore();
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const group = openGesture ? store.getState().beginHistoryGroup("drag") : undefined;
    expect((await store.getState().updateClipTransform(clipId, { position: { x: 0.25, y: 0.5 } })).success).toBe(true);
    now = 1040;
    const applicationId = applyRecipe(store);
    now = 1080;
    expect((await store.getState().updateClipTransform(clipId, { position: { x: 0.75, y: 0.5 } })).success).toBe(true);
    if (group) store.getState().endHistoryGroup(group);
    const entries = store.getState().actionHistory.getHistoryEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.groupId === entries[1]?.groupId && !!entries[0]?.groupId).toBe(false);
    expect((await store.getState().undo()).success).toBe(true);
    expect(getClip(store).transform.position.x).toBe(0.25);
    expect(getRecipeState(store, applicationId).applied).toBe(true);
    expect((await store.getState().undo()).success).toBe(true);
    expect(getRecipeState(store, applicationId).applied).toBe(false);
    expect((await store.getState().undo()).success).toBe(true);
    expect(getClip(store).transform.position.x).toBe(0.5);
    for (let i = 0; i < 3; i++) expect((await store.getState().redo()).success).toBe(true);
    expect(getClip(store).transform.position.x).toBe(0.75);
    expect(getRecipeState(store, applicationId).applied).toBe(true);
  });
});
