import type {
  Project,
  MediaItem,
  ProjectMarker,
  ProjectMarkersState,
  ProjectMarkerTarget,
  WorkAsset,
} from "../types";
import type { IStorageEngine, MediaRecord } from "./types";
import type { ValidationResult, ProjectFileWithMetadata } from "./schema-types";
import type {
  MotionAudioClip,
  MotionComposition,
  MotionCompositionInstance,
  MotionLayer,
} from "../motion/types";
import type {
  MotionShaderCategory,
  MotionShaderDef,
  MotionShaderParamDef,
} from "../motion/shaders/types";
import { normalizeMotionCamera } from "../motion/motion-camera";
import { normalizeMotionLights } from "../motion/motion-lights";
import { normalizeMotionTracks } from "../motion/motion-tracking";
import { normalizeCreationState } from "../creation";
import {
  fullChromaKeySettings,
  syncChromaKeyEffectItem,
} from "../actions/handlers/clip-fx";

const MOTION_SHADER_CATEGORIES: ReadonlySet<MotionShaderCategory> = new Set([
  "fill",
  "effect",
  "text",
]);

function isMotionShaderParamDef(value: unknown): value is MotionShaderParamDef {
  if (!value || typeof value !== "object") {
    return false;
  }
  const param = value as Record<string, unknown>;
  return (
    typeof param.name === "string" &&
    typeof param.label === "string" &&
    (param.type === "number" || param.type === "color") &&
    typeof param.default === "number" &&
    typeof param.min === "number" &&
    typeof param.max === "number" &&
    typeof param.step === "number"
  );
}

function isMotionShaderDef(value: unknown): value is MotionShaderDef {
  if (!value || typeof value !== "object") {
    return false;
  }
  const def = value as Record<string, unknown>;
  return (
    typeof def.id === "string" &&
    def.id.length > 0 &&
    typeof def.name === "string" &&
    typeof def.category === "string" &&
    MOTION_SHADER_CATEGORIES.has(def.category as MotionShaderCategory) &&
    typeof def.glsl === "string" &&
    def.glsl.length > 0 &&
    Array.isArray(def.params) &&
    def.params.every(isMotionShaderParamDef)
  );
}

export function normalizeGeneratedShaders(
  value: unknown,
): readonly MotionShaderDef[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isMotionShaderDef).map((def) => ({
    id: def.id,
    name: def.name,
    category: def.category,
    glsl: def.glsl,
    params: def.params,
    origin: "generated" as const,
  }));
}

export interface ProjectFile {
  readonly version: string;
  readonly project: Project;
}

export const SCHEMA_VERSION = "1.0.0";

function normalizeMotionAudioClips(
  composition: Pick<MotionComposition, "audioClips">,
): MotionAudioClip[] {
  if (!Array.isArray(composition.audioClips)) {
    return [];
  }
  return composition.audioClips.filter(
    (clip): clip is MotionAudioClip =>
      !!clip && typeof clip === "object" && typeof clip.id === "string",
  );
}

function normalizeMotionLayers(
  composition: Pick<MotionComposition, "layers">,
): MotionLayer[] {
  if (!Array.isArray(composition.layers)) {
    return [];
  }
  return composition.layers.filter(
    (layer): layer is MotionLayer =>
      !!layer && typeof layer === "object" && typeof layer.id === "string",
  );
}

export function normalizeMotionComposition(
  composition: MotionComposition,
): MotionComposition {
  return {
    ...composition,
    layers: normalizeMotionLayers(composition),
    assets: Array.isArray(composition.assets) ? composition.assets : [],
    variables: Array.isArray(composition.variables) ? composition.variables : [],
    markers: Array.isArray(composition.markers) ? composition.markers : [],
    audioClips: normalizeMotionAudioClips(composition),
    guides: Array.isArray(composition.guides) ? composition.guides : [],
    lights: normalizeMotionLights(composition),
    camera: composition.camera
      ? normalizeMotionCamera(composition)
      : undefined,
    tracks: normalizeMotionTracks(composition),
  };
}

export function normalizeProjectMotionFields(project: Project): Project {
  const motionInstances: MotionCompositionInstance[] = Array.isArray(
    project.motionInstances,
  )
    ? project.motionInstances
    : [];

  return {
    ...project,
    motionCompositions: Array.isArray(project.motionCompositions)
      ? project.motionCompositions.map(normalizeMotionComposition)
      : [],
    motionInstances,
  };
}

export function normalizeProjectCreationFields(project: Project): Project {
  return {
    ...project,
    creation: normalizeCreationState(project.creation),
  };
}

export function normalizeProjectGeneratedShaderFields(
  project: Project,
): Project {
  return {
    ...project,
    generatedShaders: normalizeGeneratedShaders(project.generatedShaders),
  };
}

function isProjectMarkerTargetShape(value: unknown): value is ProjectMarkerTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  switch (target.kind) {
    case "asset":
      return typeof target.mediaId === "string" && target.mediaId.length > 0;
    case "clip":
      return typeof target.clipId === "string" && target.clipId.length > 0;
    case "text":
      return (
        typeof target.textClipId === "string" && target.textClipId.length > 0
      );
    case "timeRange":
      return (
        typeof target.start === "number" &&
        Number.isFinite(target.start) &&
        target.start >= 0 &&
        typeof target.end === "number" &&
        Number.isFinite(target.end) &&
        target.end >= target.start
      );
    default:
      return false;
  }
}

function isProjectMarkerShape(value: unknown): value is ProjectMarker {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  return (
    typeof marker.id === "string" &&
    marker.id.length > 0 &&
    typeof marker.number === "number" &&
    Number.isInteger(marker.number) &&
    marker.number >= 1 &&
    isProjectMarkerTargetShape(marker.target) &&
    (marker.label === undefined || typeof marker.label === "string") &&
    (marker.color === undefined || typeof marker.color === "string") &&
    typeof marker.createdAt === "number" &&
    Number.isFinite(marker.createdAt) &&
    marker.createdAt >= 0
  );
}

/**
 * Defensive repair for stored marker state: an absent/invalid `markers`
 * becomes empty, structurally invalid items are dropped, duplicate ids or
 * numbers keep the first occurrence, and nextNumber is repaired to stay
 * above every surviving item's number (deleted numbers stay retired).
 */
export function normalizeProjectMarkers(value: unknown): ProjectMarkersState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { nextNumber: 1, items: [] };
  }
  const state = value as { nextNumber?: unknown; items?: unknown };
  const rawItems = Array.isArray(state.items) ? state.items : [];
  const seenIds = new Set<string>();
  const seenNumbers = new Set<number>();
  const items: ProjectMarker[] = [];
  for (const raw of rawItems) {
    if (!isProjectMarkerShape(raw)) continue;
    if (seenIds.has(raw.id) || seenNumbers.has(raw.number)) continue;
    seenIds.add(raw.id);
    seenNumbers.add(raw.number);
    items.push(raw);
  }
  const maxNumber = items.reduce((max, item) => Math.max(max, item.number), 0);
  const nextNumber =
    typeof state.nextNumber === "number" &&
    Number.isInteger(state.nextNumber) &&
    state.nextNumber >= 1
      ? state.nextNumber
      : 1;
  return { nextNumber: Math.max(nextNumber, maxNumber + 1), items };
}

export function normalizeProjectMarkerFields(project: Project): Project {
  return {
    ...project,
    markers: normalizeProjectMarkers(project.markers),
  };
}

function isWorkAssetUnsupportedParamShape(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { field?: unknown }).field === "string" &&
    typeof (value as { reason?: unknown }).reason === "string"
  );
}

function isWorkAssetShape(value: unknown): value is WorkAsset {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const asset = value as Record<string, unknown>;
  const range = asset.sourceRange as
    | { inSec?: unknown; outSec?: unknown }
    | undefined;
  const rangeValid =
    !!range &&
    typeof range.inSec === "number" &&
    Number.isFinite(range.inSec) &&
    range.inSec >= 0 &&
    typeof range.outSec === "number" &&
    Number.isFinite(range.outSec) &&
    range.outSec > range.inSec;
  return (
    asset.schemaVersion === 1 &&
    typeof asset.id === "string" &&
    asset.id.length > 0 &&
    (asset.kind === "single" || asset.kind === "multi") &&
    typeof asset.name === "string" &&
    typeof asset.sourceMediaId === "string" &&
    asset.sourceMediaId.length > 0 &&
    rangeValid &&
    typeof asset.createdAt === "number" &&
    Number.isFinite(asset.createdAt) &&
    asset.createdAt >= 0 &&
    typeof asset.updatedAt === "number" &&
    Number.isFinite(asset.updatedAt) &&
    asset.updatedAt >= 0 &&
    (asset.clipSnapshot === undefined ||
      (typeof asset.clipSnapshot === "object" && asset.clipSnapshot !== null)) &&
    Array.isArray(asset.unsupportedParams) &&
    asset.unsupportedParams.every(isWorkAssetUnsupportedParamShape) &&
    (asset.captureRequestId === undefined ||
      typeof asset.captureRequestId === "string") &&
    (asset.members === undefined || Array.isArray(asset.members))
  );
}

/**
 * Defensive repair for stored work assets: an absent `workAssets` leaves the
 * project untouched (old projects keep working with no field at all), a
 * non-array value is replaced with the empty list, structurally invalid
 * entries are dropped, and duplicate ids keep the first occurrence.
 */
export function normalizeProjectWorkAssetFields(project: Project): Project {
  const raw = project.workAssets;
  if (raw === undefined) return project;
  if (!Array.isArray(raw)) {
    return { ...project, workAssets: [] };
  }
  const seenIds = new Set<string>();
  const items: WorkAsset[] = [];
  for (const entry of raw) {
    if (!isWorkAssetShape(entry) || seenIds.has(entry.id)) continue;
    seenIds.add(entry.id);
    items.push(entry);
  }
  if (items.length === raw.length) {
    return project;
  }
  return { ...project, workAssets: items };
}

/**
 * Defensive repair for stored media items: an invalid `displayName` (wrong
 * type or blank after trim) is dropped so display sites fall back to the
 * source filename. Everything else passes through untouched — old projects
 * without displayName are unaffected.
 */
export function normalizeProjectMediaFields(project: Project): Project {
  const items = project.mediaLibrary?.items;
  if (!Array.isArray(items)) return project;
  let changed = false;
  const normalizedItems = items.map((item: MediaItem) => {
    if (
      item.displayName === undefined ||
      (typeof item.displayName === "string" && item.displayName.trim().length > 0)
    ) {
      return item;
    }
    changed = true;
    const { displayName: _invalid, ...rest } = item;
    return rest as MediaItem;
  });
  return changed ? { ...project, mediaLibrary: { items: normalizedItems } } : project;
}

/**
 * Legacy project backfill: before the per-frame keyer moved into the
 * clip.effects stack, clip/setChromaKey only wrote the clip.chromaKey
 * settings field, so an upgraded project shows an enabled green-screen panel
 * while the render chain (which consumes clip.effects) has no keyer. Clips
 * saved since then always carry both representations. For any clip that has
 * the field but no chromaKey effect item, restore the item from the field
 * (same param shape the clip/setChromaKey handler writes); clips that
 * already have an item are left untouched so a user-tuned Effects-panel
 * stack is never duplicated or overwritten.
 */
export function normalizeProjectChromaFields(project: Project): Project {
  let changed = false;
  const tracks = project.timeline.tracks.map((track) => ({
    ...track,
    clips: track.clips.map((clip) => {
      const settings = clip.chromaKey;
      if (!settings) return clip;
      if ((clip.effects ?? []).some((effect) => effect.type === "chromaKey")) {
        return clip;
      }
      changed = true;
      return {
        ...clip,
        effects: syncChromaKeyEffectItem(
          clip.effects ?? [],
          fullChromaKeySettings(settings),
        ),
      };
    }),
  }));
  return changed
    ? { ...project, timeline: { ...project.timeline, tracks } }
    : project;
}

export function normalizeProjectStoredFields(project: Project): Project {
  return normalizeProjectMediaFields(
    normalizeProjectMarkerFields(
      normalizeProjectGeneratedShaderFields(
        normalizeProjectCreationFields(
          normalizeProjectWorkAssetFields(
            normalizeProjectMotionFields(
              normalizeProjectChromaFields(project),
            ),
          ),
        ),
      ),
    ),
  );
}

export class ProjectSerializer {
  private storage: IStorageEngine;

  constructor(storage: IStorageEngine) {
    this.storage = storage;
  }

  async saveProject(project: Project): Promise<void> {
    await this.saveMediaBlobs(project);

    const projectToSave: Project = {
      ...project,
      modifiedAt: Date.now(),
    };

    await this.storage.saveProject(projectToSave);
  }

  async loadProject(id: string): Promise<Project | null> {
    const project = await this.storage.loadProject(id);
    if (!project) {
      return null;
    }

    const restoredProject = await this.restoreMediaBlobs(project);
    return restoredProject;
  }

  exportToJson(project: Project): string {
    const projectFile: ProjectFile = {
      version: SCHEMA_VERSION,
      project: this.stripMediaBlobs(project),
    };
    return JSON.stringify(projectFile, null, 2);
  }

  importFromJson(json: string): Project {
    const projectFile = JSON.parse(json) as ProjectFile;

    if (projectFile.version !== SCHEMA_VERSION) {
      return this.migrateProject(projectFile);
    }

    const project = this.normalizeStoredFields(projectFile.project);

    const processedItems: MediaItem[] = project.mediaLibrary.items.map(
      (item: MediaItem) => {
        if (!item.blob) {
          return {
            ...item,
            isPlaceholder: true,
            originalUrl: item.thumbnailUrl || undefined,
          };
        }
        return item;
      },
    );

    return {
      ...project,
      mediaLibrary: {
        items: processedItems,
      },
    };
  }

  exportToJsonWithMetadata(project: Project, description?: string): string {
    const projectFile: ProjectFileWithMetadata = {
      version: SCHEMA_VERSION,
      project: this.stripMediaBlobs(project),
      metadata: {
        exportedAt: Date.now(),
        description,
      },
    };
    return JSON.stringify(projectFile, null, 2);
  }

  validateProjectJson(json: string): ValidationResult {
    const result: ValidationResult = {
      valid: true,
      errors: [],
      warnings: [],
      missingAssets: [],
    };

    try {
      const projectFile = JSON.parse(json) as ProjectFile;

      if (!projectFile.version) {
        result.errors.push("Missing version field");
        result.valid = false;
      } else if (projectFile.version !== SCHEMA_VERSION) {
        result.warnings.push(
          `Version mismatch: expected ${SCHEMA_VERSION}, got ${projectFile.version}`,
        );
      }

      if (!projectFile.project) {
        result.errors.push("Missing project field");
        result.valid = false;
        return result;
      }

      const project = projectFile.project;

      if (!project.id) {
        result.errors.push("Missing project.id");
        result.valid = false;
      }
      if (!project.name) {
        result.errors.push("Missing project.name");
        result.valid = false;
      }
      if (!project.settings) {
        result.errors.push("Missing project.settings");
        result.valid = false;
      }
      if (!project.timeline) {
        result.errors.push("Missing project.timeline");
        result.valid = false;
      }
      if (!project.mediaLibrary) {
        result.errors.push("Missing project.mediaLibrary");
        result.valid = false;
      }

      if (!result.valid) {
        return result;
      }

      const mediaIds = new Set(
        project.mediaLibrary.items.map((item: MediaItem) => item.id),
      );

      for (const item of project.mediaLibrary.items) {
        if (!item.blob && !item.thumbnailUrl) {
          result.missingAssets!.push(item.id);
        }
      }

      if (project.timeline.tracks) {
        for (const track of project.timeline.tracks) {
          if (track.clips) {
            for (const clip of track.clips) {
              const isVirtualClip =
                clip.mediaId &&
                (clip.mediaId.startsWith("text-") ||
                  clip.mediaId.startsWith("shape-") ||
                  clip.mediaId.startsWith("svg-") ||
                  clip.mediaId.startsWith("sticker-") ||
                  clip.mediaId.startsWith("motion-"));
              if (
                clip.mediaId &&
                !isVirtualClip &&
                !mediaIds.has(clip.mediaId)
              ) {
                result.errors.push(
                  `Clip ${clip.id} references non-existent mediaId: ${clip.mediaId}`,
                );
                result.valid = false;
              }
            }
          }
        }
      }

      if (result.missingAssets && result.missingAssets.length > 0) {
        result.warnings.push(
          `${result.missingAssets.length} asset(s) need replacement`,
        );
      }
    } catch (error) {
      result.errors.push(
        `Invalid JSON: ${error instanceof Error ? error.message : "Parse error"}`,
      );
      result.valid = false;
    }

    return result;
  }

  importFromJsonWithValidation(json: string): {
    project: Project | null;
    validation: ValidationResult;
  } {
    const validation = this.validateProjectJson(json);

    if (!validation.valid) {
      return { project: null, validation };
    }

    const project = this.importFromJson(json);
    return { project, validation };
  }

  private async saveMediaBlobs(project: Project): Promise<void> {
    for (const item of project.mediaLibrary.items) {
      if (item.blob) {
        const mediaRecord: MediaRecord = {
          id: item.id,
          projectId: project.id,
          blob: item.blob,
          metadata: item.metadata,
        };
        await this.storage.saveMedia(mediaRecord);
      }
    }
  }

  private async restoreMediaBlobs(project: Project): Promise<Project> {
    const restoredItems: MediaItem[] = [];

    for (const item of project.mediaLibrary.items) {
      const mediaRecord = await this.storage.loadMedia(item.id);

      if (mediaRecord) {
        restoredItems.push({
          ...item,
          blob: mediaRecord.blob,
          metadata: mediaRecord.metadata,
        });
      } else {
        restoredItems.push(item);
      }
    }

    return {
      ...project,
      mediaLibrary: {
        items: restoredItems,
      },
    };
  }

  private stripMediaBlobs(project: Project): Project {
    const strippedItems: MediaItem[] = project.mediaLibrary.items.map(
      (item) => ({
        ...item,
        blob: null,
        fileHandle: null,
        waveformData: null,
      }),
    );

    return {
      ...project,
      mediaLibrary: {
        items: strippedItems,
      },
    };
  }

  private migrateProject(projectFile: ProjectFile): Project {
    return this.normalizeStoredFields(projectFile.project);
  }

  private normalizeStoredFields(project: Project): Project {
    return normalizeProjectStoredFields(project);
  }

  async deleteProject(id: string): Promise<void> {
    await this.storage.deleteProject(id);
  }

  async listProjects() {
    return this.storage.listProjects();
  }
}

export function createProjectSerializer(
  storage: IStorageEngine,
): ProjectSerializer {
  return new ProjectSerializer(storage);
}
