import { describe, expect, it } from "vitest";
import type { Project } from "../types";
import type {
  MotionAudioClip,
  MotionComposition,
  MotionVideoLayer,
} from "../motion/types";
import { DEFAULT_MOTION_TRANSFORM } from "../motion/types";
import type { MotionShaderDef } from "../motion/shaders/types";
import type {
  CacheRecord,
  IStorageEngine,
  MediaRecord,
  ProjectSummary,
  StorageUsage,
  WaveformRecord,
} from "./types";
import {
  ProjectSerializer,
  normalizeMotionComposition,
  normalizeProjectChromaFields,
  normalizeProjectCreationFields,
  normalizeProjectMarkerFields,
  normalizeProjectMarkers,
  normalizeProjectMediaFields,
  normalizeProjectMotionFields,
  normalizeProjectStoredFields,
  normalizeProjectWorkAssetFields,
} from "./project-serializer";
import { DEFAULT_CHROMA_KEY_SETTINGS } from "../video/chroma-key-engine";
import { createCreationScene, createEmptyCreationState } from "../creation";

const makeVideoLayer = (
  overrides: Partial<MotionVideoLayer> = {},
): MotionVideoLayer => ({
  id: "layer-video-1",
  type: "video",
  name: "Clip",
  startTime: 0,
  duration: 3,
  visible: true,
  locked: false,
  transform: DEFAULT_MOTION_TRANSFORM,
  keyframes: [],
  assetId: "asset-1",
  width: 1920,
  height: 1080,
  fit: "contain",
  playbackRate: 1,
  timeOffset: 0,
  trimStart: 0,
  muted: false,
  ...overrides,
});

const makeComposition = (
  overrides: Partial<MotionComposition> = {},
): MotionComposition => ({
  id: "comp-1",
  name: "Scene",
  width: 1920,
  height: 1080,
  frameRate: 30,
  duration: 5,
  backgroundColor: "transparent",
  layers: [],
  assets: [],
  variables: [],
  markers: [],
  createdAt: 1,
  modifiedAt: 1,
  ...overrides,
});

const makeProject = (overrides: Partial<Project> = {}): Project => ({
  id: "project-1",
  name: "Project",
  createdAt: 1,
  modifiedAt: 1,
  settings: {
    width: 1920,
    height: 1080,
    frameRate: 30,
    sampleRate: 48000,
    channels: 2,
  },
  mediaLibrary: { items: [] },
  timeline: {
    tracks: [],
    subtitles: [],
    duration: 0,
    markers: [],
  },
  ...overrides,
});

class MemoryStorageEngine implements IStorageEngine {
  private projects = new Map<string, Project>();
  private media = new Map<string, MediaRecord>();

  async saveProject(project: Project): Promise<void> {
    this.projects.set(project.id, project);
  }
  async loadProject(id: string): Promise<Project | null> {
    return this.projects.get(id) ?? null;
  }
  async listProjects(): Promise<ProjectSummary[]> {
    return [...this.projects.values()].map((project) => ({
      id: project.id,
      name: project.name,
      createdAt: project.createdAt,
      modifiedAt: project.modifiedAt,
    }));
  }
  async deleteProject(id: string): Promise<void> {
    this.projects.delete(id);
  }
  async saveMedia(media: MediaRecord): Promise<void> {
    this.media.set(media.id, media);
  }
  async loadMedia(id: string): Promise<MediaRecord | null> {
    return this.media.get(id) ?? null;
  }
  async deleteMedia(id: string): Promise<void> {
    this.media.delete(id);
  }
  async getMediaByProject(): Promise<MediaRecord[]> {
    return [];
  }
  async getMediaIdsByProject(): Promise<string[]> {
    return [];
  }
  async saveCache(): Promise<void> {}
  async loadCache(): Promise<CacheRecord | null> {
    return null;
  }
  async deleteCache(): Promise<void> {}
  async clearCache(): Promise<void> {}
  async saveWaveform(): Promise<void> {}
  async loadWaveform(): Promise<WaveformRecord | null> {
    return null;
  }
  async deleteWaveform(): Promise<void> {}
  async saveFileHandle(): Promise<void> {}
  async loadFileHandle(): Promise<FileSystemFileHandle | null> {
    return null;
  }
  async saveDirectoryHandle(): Promise<void> {}
  async loadDirectoryHandle(): Promise<{
    handle: FileSystemDirectoryHandle;
    folderName: string;
  } | null> {
    return null;
  }
  async getStorageUsage(): Promise<StorageUsage> {
    return { used: 0, quota: 0, projects: 0, mediaItems: 0 };
  }
  async clearAllData(): Promise<void> {}
  close(): void {}
}

describe("normalizeMotionComposition", () => {
  it("defaults audioClips to [] when missing", () => {
    const composition = makeComposition();
    expect(composition.audioClips).toBeUndefined();

    const normalized = normalizeMotionComposition(composition);

    expect(normalized.audioClips).toEqual([]);
  });

  it("preserves existing audioClips", () => {
    const audioClips: MotionAudioClip[] = [
      { id: "audio-1", startTime: 0, duration: 4, gain: 0.8 },
    ];
    const normalized = normalizeMotionComposition(
      makeComposition({ audioClips }),
    );

    expect(normalized.audioClips).toEqual(audioClips);
  });

  it("drops malformed audioClips entries", () => {
    const audioClips = [
      { id: "audio-1", startTime: 0, duration: 4 },
      null,
      { startTime: 1, duration: 2 },
    ] as unknown as MotionAudioClip[];

    const normalized = normalizeMotionComposition(
      makeComposition({ audioClips }),
    );

    expect(normalized.audioClips).toHaveLength(1);
    expect(normalized.audioClips?.[0]?.id).toBe("audio-1");
  });

  it("preserves video layers and their fields", () => {
    const videoLayer = makeVideoLayer({
      assetId: "video-asset-42",
      playbackRate: 1.5,
      trimStart: 2,
      muted: true,
    });
    const normalized = normalizeMotionComposition(
      makeComposition({ layers: [videoLayer] }),
    );

    expect(normalized.layers).toHaveLength(1);
    const layer = normalized.layers[0] as MotionVideoLayer;
    expect(layer.type).toBe("video");
    expect(layer.assetId).toBe("video-asset-42");
    expect(layer.playbackRate).toBe(1.5);
    expect(layer.trimStart).toBe(2);
    expect(layer.muted).toBe(true);
  });

  it("backfills guides/lights/tracks and is idempotent", () => {
    const composition = makeComposition();
    const once = normalizeMotionComposition(composition);
    const twice = normalizeMotionComposition(once);

    expect(once.guides).toEqual([]);
    expect(once.lights).toEqual([]);
    expect(once.tracks).toEqual([]);
    expect(twice).toEqual(once);
  });
});

describe("normalizeProjectMotionFields", () => {
  it("defaults motionCompositions and motionInstances", () => {
    const normalized = normalizeProjectMotionFields(makeProject());

    expect(normalized.motionCompositions).toEqual([]);
    expect(normalized.motionInstances).toEqual([]);
  });

  it("does not clobber existing motion instances", () => {
    const project = makeProject({
      motionInstances: [
        {
          id: "instance-1",
          compositionId: "comp-1",
          startTime: 0,
          duration: 5,
          transform: {
            position: { x: 0, y: 0 },
            scale: { x: 1, y: 1 },
            rotation: 0,
            anchor: { x: 0.5, y: 0.5 },
            opacity: 1,
            fitMode: "contain",
          },
          opacity: 1,
        },
      ],
    });

    const normalized = normalizeProjectMotionFields(project);

    expect(normalized.motionInstances).toHaveLength(1);
    expect(normalized.motionInstances?.[0]?.id).toBe("instance-1");
  });
});

describe("normalizeProjectCreationFields", () => {
  it("normalizes creation state while preserving scene records", () => {
    const creation = {
      ...createEmptyCreationState(),
      scenes: [createCreationScene({ id: "scene-creation", name: "Creation", now: 1 })],
    };
    const normalized = normalizeProjectCreationFields(makeProject({ creation }));

    expect(normalized.creation?.version).toBe(creation.version);
    expect(normalized.creation?.scenes).toHaveLength(1);
    expect(normalized.creation?.operationHistory).toEqual([]);
  });
});

describe("normalizeProjectChromaFields (legacy chromaKey backfill)", () => {
  const trackId = "track-video";
  const legacyChromaKey = {
    enabled: true,
    keyColor: { r: 0, g: 0.4, b: 0 },
    tolerance: 0.42,
    edgeSoftness: 0.2,
    spillSuppression: 0.8,
  };

  const makeClip = (overrides: Record<string, unknown> = {}) =>
    ({
      id: "clip-1",
      mediaId: "media-1",
      trackId,
      startTime: 0,
      duration: 5,
      inPoint: 0,
      outPoint: 5,
      effects: [],
      audioEffects: [],
      transform: {
        position: { x: 0, y: 0 },
        scale: { x: 1, y: 1 },
        rotation: 0,
        anchor: { x: 0.5, y: 0.5 },
        opacity: 1,
      },
      volume: 1,
      keyframes: [],
      ...overrides,
    }) as Project["timeline"]["tracks"][number]["clips"][number];

  const makeTrack = (clips: ReturnType<typeof makeClip>[]) => ({
    id: trackId,
    type: "video" as const,
    name: "Primary",
    clips,
    transitions: [],
    locked: false,
    hidden: false,
    muted: false,
    solo: false,
  });

  const chromaItemsOf = (clip: ReturnType<typeof makeClip>) =>
    clip.effects.filter((effect) => effect.type === "chromaKey");

  it("backfills the render-side effect item for legacy clips that only have the settings field", () => {
    // Pre-effects-stacks projects: clip/setChromaKey wrote only the field, so
    // the GUI panel showed green screen enabled while rendering had no keyer.
    const project = makeProject({
      timeline: {
        ...makeProject().timeline,
        duration: 5,
        tracks: [makeTrack([makeClip({ chromaKey: legacyChromaKey })])],
      },
    });

    // The full stored-fields chain is the load path (importFromJson and
    // project-manager normalization), so what the renderer consumes from
    // clip.effects must hold after it — preview and export stay in sync.
    const normalized = normalizeProjectStoredFields(project);
    const clip = normalized.timeline.tracks[0]!.clips[0]!;
    const items = chromaItemsOf(clip);

    expect(items).toHaveLength(1);
    expect(items[0]!.enabled).toBe(true);
    expect(items[0]!.params).toEqual({
      keyColor: { r: 0, g: 0.4, b: 0 },
      tolerance: 0.42,
      edgeSoftness: 0.2,
      spillSuppression: 0.8,
    });
    // The settings field itself stays untouched for the GUI panel.
    expect(clip.chromaKey).toEqual(legacyChromaKey);
  });

  it("fills missing legacy settings with the defaults so params stay numeric", () => {
    const project = makeProject({
      timeline: {
        ...makeProject().timeline,
        tracks: [
          makeTrack([
            makeClip({
              chromaKey: { enabled: true, keyColor: { r: 0, g: 1, b: 0 } },
            }),
          ]),
        ],
      },
    });

    const normalized = normalizeProjectChromaFields(project);
    const items = chromaItemsOf(
      normalized.timeline.tracks[0]!.clips[0]! as ReturnType<typeof makeClip>,
    );

    expect(items).toHaveLength(1);
    expect(items[0]!.params).toEqual({
      keyColor: { r: 0, g: 1, b: 0 },
      tolerance: DEFAULT_CHROMA_KEY_SETTINGS.tolerance,
      edgeSoftness: DEFAULT_CHROMA_KEY_SETTINGS.edgeSoftness,
      spillSuppression: DEFAULT_CHROMA_KEY_SETTINGS.spillSuppression,
    });
  });

  it("does not duplicate or overwrite when an effect item already exists", () => {
    const userTunedItems = [
      {
        id: "effect-chromakey-user",
        type: "chromaKey",
        enabled: false,
        params: { keyColor: { r: 0, g: 1, b: 0 }, tolerance: 0.9 },
      },
    ];
    const clip = makeClip({
      chromaKey: legacyChromaKey,
      effects: userTunedItems,
    });
    const project = makeProject({
      timeline: {
        ...makeProject().timeline,
        tracks: [makeTrack([clip])],
      },
    });

    const normalized = normalizeProjectChromaFields(project);

    // Untouched stack, byte-for-byte, and no second chromaKey item.
    expect(normalized.timeline.tracks[0]!.clips[0]!.effects).toEqual(
      userTunedItems,
    );
    expect(normalized).toBe(project);
  });

  it("leaves clips without a chromaKey field untouched", () => {
    const project = makeProject({
      timeline: {
        ...makeProject().timeline,
        tracks: [makeTrack([makeClip()])],
      },
    });

    const normalized = normalizeProjectChromaFields(project);

    expect(chromaItemsOf(normalized.timeline.tracks[0]!.clips[0]! as ReturnType<typeof makeClip>)).toHaveLength(0);
    expect(normalized).toBe(project);
  });
});

describe("ProjectSerializer round-trip", () => {
  it("preserves audioClips and video layers through export/import", () => {
    const serializer = new ProjectSerializer(new MemoryStorageEngine());
    const composition = makeComposition({
      layers: [makeVideoLayer()],
      audioClips: [{ id: "audio-1", startTime: 0, duration: 4 }],
    });
    const project = makeProject({ motionCompositions: [composition] });

    const json = serializer.exportToJson(project);
    const imported = serializer.importFromJson(json);

    expect(imported.motionCompositions).toHaveLength(1);
    const importedComposition = imported.motionCompositions![0];
    expect(importedComposition.audioClips).toEqual([
      { id: "audio-1", startTime: 0, duration: 4 },
    ]);
    expect(importedComposition.layers).toHaveLength(1);
    expect((importedComposition.layers[0] as MotionVideoLayer).type).toBe(
      "video",
    );
    expect((importedComposition.layers[0] as MotionVideoLayer).assetId).toBe(
      "asset-1",
    );
  });

  it("backfills audioClips when an older composition lacks it", () => {
    const serializer = new ProjectSerializer(new MemoryStorageEngine());
    const composition = makeComposition({ layers: [makeVideoLayer()] });
    const project = makeProject({ motionCompositions: [composition] });

    const imported = serializer.importFromJson(serializer.exportToJson(project));

    expect(imported.motionCompositions![0].audioClips).toEqual([]);
  });
});

const makeShaderDef = (
  overrides: Partial<MotionShaderDef> = {},
): MotionShaderDef => ({
  id: "ai-round-1",
  name: "AI Round",
  category: "fill",
  glsl: "void main(){}",
  params: [
    {
      name: "u_intensity",
      label: "Intensity",
      type: "number",
      default: 0.5,
      min: 0,
      max: 1,
      step: 0.01,
    },
  ],
  origin: "generated",
  ...overrides,
});

describe("ProjectSerializer generatedShaders", () => {
  it("round-trips a valid generated shader through export/import", () => {
    const serializer = new ProjectSerializer(new MemoryStorageEngine());
    const def = makeShaderDef();
    const project = makeProject({ generatedShaders: [def] });

    const imported = serializer.importFromJson(serializer.exportToJson(project));

    expect(imported.generatedShaders).toEqual([def]);
  });

  it("drops malformed generated shaders on import", () => {
    const serializer = new ProjectSerializer(new MemoryStorageEngine());
    const valid = makeShaderDef();
    const badCategory = makeShaderDef({ id: "ai-bad-cat", category: "wrong" as MotionShaderDef["category"] });
    const missingGlsl = { ...makeShaderDef({ id: "ai-no-glsl" }), glsl: undefined };
    const project = makeProject({
      generatedShaders: [valid, badCategory, missingGlsl] as MotionShaderDef[],
    });

    const imported = serializer.importFromJson(serializer.exportToJson(project));

    expect(imported.generatedShaders?.map((d) => d.id)).toEqual(["ai-round-1"]);
  });

  it("defaults generatedShaders to an empty array when absent", () => {
    const serializer = new ProjectSerializer(new MemoryStorageEngine());
    const project = makeProject();

    const imported = serializer.importFromJson(serializer.exportToJson(project));

    expect(imported.generatedShaders).toEqual([]);
  });
});

describe("ProjectSerializer project markers", () => {
  const makeMarker = (
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    id: "marker-1",
    number: 1,
    target: { kind: "timeRange", start: 0, end: 2 },
    createdAt: 1000,
    ...overrides,
  });

  it("round-trips markers through export/import", () => {
    const serializer = new ProjectSerializer(new MemoryStorageEngine());
    const project = makeProject({
      markers: {
        nextNumber: 3,
        items: [
          makeMarker({
            label: "Intro",
            color: "#ff0000",
            target: { kind: "asset", mediaId: "m1" },
          }),
          makeMarker({
            id: "marker-2",
            number: 2,
            target: { kind: "timeRange", start: 1.5, end: 4 },
          }),
        ],
      } as unknown as Project["markers"],
    });

    const imported = serializer.importFromJson(serializer.exportToJson(project));

    expect(imported.markers).toEqual(project.markers);
  });

  it("defaults markers to the empty state when the stored project lacks them", () => {
    const serializer = new ProjectSerializer(new MemoryStorageEngine());
    const project = makeProject();

    const imported = serializer.importFromJson(serializer.exportToJson(project));

    expect(imported.markers).toEqual({ nextNumber: 1, items: [] });
  });

  it("repairs nextNumber above the highest stored number and drops invalid items", () => {
    const serializer = new ProjectSerializer(new MemoryStorageEngine());
    const project = makeProject({
      markers: {
        nextNumber: 1,
        items: [
          makeMarker({ id: "marker-3", number: 3 }),
          makeMarker({ id: "marker-3", number: 4 }), // duplicate id
          makeMarker({ id: "marker-4", number: 3 }), // duplicate number
          makeMarker({ id: "", number: 9 }), // invalid id
          makeMarker({ id: "marker-5", number: 1.5 }), // non-integer number
          makeMarker({ id: "marker-6", number: 6, target: { kind: "region" } }), // bad target
          makeMarker({ id: "marker-7", number: 7, createdAt: -1 }), // bad createdAt
          "garbage",
        ],
      } as unknown as Project["markers"],
    });

    const imported = serializer.importFromJson(serializer.exportToJson(project));

    expect(imported.markers?.items.map((m) => m.id)).toEqual(["marker-3"]);
    expect(imported.markers?.nextNumber).toBe(4);
  });

  it("keeps a valid nextNumber above every item (deleted numbers stay retired)", () => {
    const normalized = normalizeProjectMarkers({
      nextNumber: 9,
      items: [makeMarker({ id: "marker-3", number: 3 })],
    });

    expect(normalized.nextNumber).toBe(9);
  });

  it("replaces an invalid markers shape with the empty state", () => {
    expect(normalizeProjectMarkers([1, 2, 3])).toEqual({
      nextNumber: 1,
      items: [],
    });
    expect(normalizeProjectMarkers("nope")).toEqual({
      nextNumber: 1,
      items: [],
    });
    expect(
      normalizeProjectMarkers({ nextNumber: "x", items: "nope" }),
    ).toEqual({ nextNumber: 1, items: [] });
  });

  it("normalizeProjectMarkerFields always leaves a defined markers state", () => {
    const normalized = normalizeProjectMarkerFields(makeProject());

    expect(normalized.markers).toEqual({ nextNumber: 1, items: [] });
  });

  it("validates all four target kinds structurally", () => {
    const normalized = normalizeProjectMarkers({
      nextNumber: 1,
      items: [
        makeMarker({ id: "marker-a", number: 1, target: { kind: "asset", mediaId: "m1" } }),
        makeMarker({ id: "marker-c", number: 2, target: { kind: "clip", clipId: "c1" } }),
        makeMarker({ id: "marker-t", number: 3, target: { kind: "text", textClipId: "text-1" } }),
        makeMarker({ id: "marker-r", number: 4, target: { kind: "timeRange", start: 0, end: 0 } }),
        makeMarker({ id: "marker-bad", number: 5, target: { kind: "timeRange", start: 2, end: 1 } }),
        makeMarker({ id: "marker-bad2", number: 6, target: { kind: "asset" } }),
      ],
    });

    expect(normalized.items.map((m) => m.id)).toEqual([
      "marker-a",
      "marker-c",
      "marker-t",
      "marker-r",
    ]);
    expect(normalized.nextNumber).toBe(5);
  });
});

const makeMediaItem = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "media-1",
  name: "take-01.mp4",
  type: "video",
  fileHandle: null,
  blob: null,
  metadata: {
    duration: 6,
    width: 320,
    height: 180,
    frameRate: 10,
    codec: "h264",
    sampleRate: 0,
    channels: 0,
    fileSize: 10,
  },
  thumbnailUrl: null,
  waveformData: null,
  ...overrides,
});

describe("ProjectSerializer media displayName", () => {
  it("round-trips a renamed media item through export/import", () => {
    const serializer = new ProjectSerializer(new MemoryStorageEngine());
    const project = makeProject({
      mediaLibrary: {
        items: [
          makeMediaItem({ displayName: "中文片头" }),
          makeMediaItem({ id: "media-2", name: "b-roll.mp4" }),
        ],
      } as unknown as Project["mediaLibrary"],
    });

    const imported = serializer.importFromJson(
      serializer.exportToJson(project),
    );

    expect(imported.mediaLibrary.items).toHaveLength(2);
    expect(imported.mediaLibrary.items[0]?.displayName).toBe("中文片头");
    expect(imported.mediaLibrary.items[0]?.name).toBe("take-01.mp4");
    // Old-style item without displayName stays untouched.
    expect(imported.mediaLibrary.items[1]?.displayName).toBeUndefined();
  });

  it("drops an invalid displayName on import and keeps the source filename", () => {
    const serializer = new ProjectSerializer(new MemoryStorageEngine());
    const project = makeProject({
      mediaLibrary: {
        items: [
          makeMediaItem({ displayName: 42 }),
          makeMediaItem({ id: "media-2", name: "blank.mp4", displayName: "   " }),
        ],
      } as unknown as Project["mediaLibrary"],
    });

    const imported = serializer.importFromJson(
      serializer.exportToJson(project),
    );

    expect(imported.mediaLibrary.items[0]?.displayName).toBeUndefined();
    expect(imported.mediaLibrary.items[0]?.name).toBe("take-01.mp4");
    expect(imported.mediaLibrary.items[1]?.displayName).toBeUndefined();
    expect(imported.mediaLibrary.items[1]?.name).toBe("blank.mp4");
  });

  it("normalizeProjectMediaFields leaves projects without displayName untouched", () => {
    const item = makeMediaItem();
    const project = makeProject({
      mediaLibrary: { items: [item] } as unknown as Project["mediaLibrary"],
    });

    const normalized = normalizeProjectMediaFields(project);

    expect(normalized).toBe(project);
  });
});

const makeWorkAsset = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1,
  id: "wa-1",
  kind: "single",
  name: "Hero trim",
  sourceMediaId: "m1",
  sourceRange: { inSec: 2, outSec: 6 },
  clipSnapshot: {
    duration: 4,
    inPoint: 2,
    outPoint: 6,
    effects: [],
    audioEffects: [],
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      anchor: { x: 0.5, y: 0.5 },
      opacity: 1,
    },
    volume: 1,
    keyframes: [],
  },
  unsupportedParams: [{ field: "stabilization.profile", reason: "recomputed" }],
  createdAt: 1000,
  updatedAt: 1000,
  ...overrides,
});

describe("ProjectSerializer work assets", () => {
  it("round-trips work assets through export/import", () => {
    const serializer = new ProjectSerializer(new MemoryStorageEngine());
    const project = makeProject({
      workAssets: [
        makeWorkAsset(),
        makeWorkAsset({ id: "wa-2", name: "B-roll" }),
      ],
    } as unknown as Project);

    const imported = serializer.importFromJson(serializer.exportToJson(project));

    expect(imported.workAssets).toEqual(project.workAssets);
  });

  it("keeps old projects without workAssets untouched (field stays absent)", () => {
    const serializer = new ProjectSerializer(new MemoryStorageEngine());
    const project = makeProject();

    const imported = serializer.importFromJson(serializer.exportToJson(project));

    expect(imported.workAssets).toBeUndefined();
  });

  it("normalizeProjectWorkAssetFields leaves an absent field untouched", () => {
    const project = makeProject();

    const normalized = normalizeProjectWorkAssetFields(project);

    expect(normalized).toBe(project);
  });

  it("replaces a non-array workAssets value with the empty list", () => {
    const project = makeProject({
      workAssets: "garbage",
    } as unknown as Project);

    const normalized = normalizeProjectWorkAssetFields(project);

    expect(normalized.workAssets).toEqual([]);
  });

  it("drops structurally invalid entries and keeps the first of duplicate ids", () => {
    const serializer = new ProjectSerializer(new MemoryStorageEngine());
    const project = makeProject({
      workAssets: [
        makeWorkAsset({ id: "wa-keep" }),
        makeWorkAsset({ id: "wa-keep", name: "dupe" }), // duplicate id
        makeWorkAsset({ id: "" }), // empty id
        makeWorkAsset({ sourceMediaId: "" }), // empty source media
        makeWorkAsset({ sourceRange: { inSec: 8, outSec: 2 } }), // bad range
        makeWorkAsset({ unsupportedParams: "nope" }), // bad params list
        makeWorkAsset({ createdAt: "old" }), // bad createdAt
        "garbage",
      ],
    } as unknown as Project);

    const imported = serializer.importFromJson(serializer.exportToJson(project));

    expect(imported.workAssets?.map((asset) => asset.id)).toEqual(["wa-keep"]);
  });

  it("keeps an entry whose snapshot is an object without deep-checking it", () => {
    const project = makeProject({
      workAssets: [
        makeWorkAsset(),
        makeWorkAsset({ id: "wa-shallow", clipSnapshot: { duration: "4" } }),
      ],
    } as unknown as Project);

    const normalized = normalizeProjectWorkAssetFields(project);

    // Snapshot internals are validated by the action validator at create
    // time; normalization only guarantees the entry envelope shape.
    expect(normalized.workAssets?.map((asset) => asset.id)).toEqual([
      "wa-1",
      "wa-shallow",
    ]);
  });

  const makeMember = (overrides: Record<string, unknown> = {}) => ({
    memberId: "m-1",
    mediaId: "m1",
    sourceRange: { inSec: 2, outSec: 6 },
    relativeStart: 0,
    lane: { trackType: "video", laneOffset: 0 },
    snapshot: {
      duration: 4,
      inPoint: 2,
      outPoint: 6,
      effects: [],
      audioEffects: [],
      transform: {
        position: { x: 0, y: 0 },
        scale: { x: 1, y: 1 },
        rotation: 0,
        anchor: { x: 0.5, y: 0.5 },
        opacity: 1,
      },
      volume: 1,
      keyframes: [],
    },
    ...overrides,
  });

  const makeMultiAsset = (overrides: Record<string, unknown> = {}) =>
    makeWorkAsset({
      kind: "multi",
      name: "Composite",
      clipSnapshot: undefined,
      members: [makeMember()],
      unsupportedParams: [],
      ...overrides,
    });

  it("round-trips a kind multi asset with members and archived transitions", () => {
    const serializer = new ProjectSerializer(new MemoryStorageEngine());
    const multi = makeMultiAsset({
      id: "wa-multi",
      members: [
        makeMember(),
        makeMember({
          memberId: "m-2",
          mediaId: "m2",
          relativeStart: 1.5,
          lane: { trackType: "audio", laneOffset: 0 },
        }),
      ],
      transitions: [
        {
          fromMemberId: "m-1",
          toMemberId: "m-2",
          type: "crossfade",
          duration: 0.5,
          params: { easing: "linear" },
        },
      ],
    });
    const project = makeProject({
      workAssets: [makeWorkAsset(), multi],
    } as unknown as Project);

    const imported = serializer.importFromJson(serializer.exportToJson(project));

    expect(imported.workAssets).toEqual(project.workAssets);
  });

  it("drops multi entries with malformed members (entry-level discard, one bad member is enough)", () => {
    const serializer = new ProjectSerializer(new MemoryStorageEngine());
    const project = makeProject({
      workAssets: [
        makeWorkAsset({ id: "wa-single" }),
        makeMultiAsset({ id: "wa-bad-lane", members: [makeMember({ lane: { trackType: "text", laneOffset: 0 } })] }),
        makeMultiAsset({ id: "wa-bad-range", members: [makeMember({ sourceRange: { inSec: 8, outSec: 2 } })] }),
        makeMultiAsset({ id: "wa-negative-start", members: [makeMember({ relativeStart: -1 })] }),
        makeMultiAsset({ id: "wa-no-snapshot", members: [makeMember({ snapshot: undefined })] }),
        makeMultiAsset({ id: "wa-empty", members: [] }),
        makeMultiAsset({ id: "wa-garbage", members: "nope" }),
      ],
    } as unknown as Project);

    const imported = serializer.importFromJson(serializer.exportToJson(project));

    expect(imported.workAssets?.map((asset) => asset.id)).toEqual(["wa-single"]);
  });

  it("enforces the kind/members pairing (multi without members, single with members)", () => {
    const project = makeProject({
      workAssets: [
        makeWorkAsset({ kind: "multi", clipSnapshot: undefined }), // multi, no members
        makeWorkAsset({ members: [makeMember()] }), // single with members
      ],
    } as unknown as Project);

    const normalized = normalizeProjectWorkAssetFields(project);

    expect(normalized.workAssets).toEqual([]);
  });
});


it("round-trips production history and review evidence and rejects malformed new metadata", () => {
  const serializer = new ProjectSerializer(new MemoryStorageEngine());
  const production = {
    status: "pending" as const,
    notes: "候选",
    steps: [
      {
        operation: "generation" as const,
        tool: "external",
        model: "declared",
        inputMediaIds: [],
        range: { startFrame: 0, endFrame: 6 },
      },
    ],
  };
  const project = makeProject({
    mediaLibrary: {
      items: [makeMediaItem({ production })],
    } as unknown as Project["mediaLibrary"],
    requirements: {
      nextNumber: 2,
      items: [
        {
          id: "review-1",
          number: 1,
          title: "Review",
          description: "",
          priority: "normal",
          status: "review",
          markerIds: [],
          createdAt: 1,
          updatedAt: 1,
          reviewRange: {
            coordinateSpace: "timeline",
            startFrame: 0,
            endFrame: 1,
            frameRate: 30,
            projectModifiedAt: 1,
            mappings: [],
            screenshot: "data:image/jpeg;base64,YQ==",
          },
        },
      ],
    },
  });
  const restored = serializer.importFromJson(serializer.exportToJson(project));
  expect(restored.mediaLibrary.items[0].production).toEqual(production);
  expect(restored.requirements).toEqual(project.requirements);
  const corrupted = serializer
    .exportToJson(project)
    .replace('"pending"', '"invalid-status"');
  expect(() => serializer.importFromJson(corrupted)).toThrow(
    /production record/,
  );
});
