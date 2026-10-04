import type { MediaProduction } from "./media-production";
import type { Timeline } from "./timeline";
import type { TextClip } from "../text/types";
import type { ShapeClip, SVGClip, StickerClip } from "../graphics/types";
import type { AdjustmentLayer } from "../video/adjustment-layer-engine";
import type { Mask } from "../video/mask-engine";
import type { MultiCamGroup } from "../video/multicam-engine";
import type {
  CompoundClip,
  CompoundClipInstance,
} from "../timeline/nested-sequence-engine";
import type {
  MotionComposition,
  MotionCompositionInstance,
} from "../motion/types";
import type { MotionShaderDef } from "../motion/shaders/types";
import type { CreationProjectState } from "../creation";
import type { ReferenceComparisonConfig } from "./reference-comparison";
import type { WorkAsset } from "./work-asset";
import type { ProjectRequirementsState } from "./requirement";

export interface ProjectSettings {
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly sampleRate: number;
  readonly channels: number;
}

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly modifiedAt: number;
  readonly settings: ProjectSettings;
  readonly mediaLibrary: MediaLibrary;
  readonly timeline: Timeline;
  readonly markers?: ProjectMarkersState;
  /** Project-scoped user requirements consumed by external Agents through reelctl. */
  readonly requirements?: ProjectRequirementsState;
  readonly textClips?: TextClip[];
  readonly shapeClips?: ShapeClip[];
  readonly svgClips?: SVGClip[];
  readonly stickerClips?: StickerClip[];
  readonly adjustmentLayers?: AdjustmentLayer[];
  readonly masks?: Mask[];
  readonly multicamGroups?: MultiCamGroup[];
  readonly compoundClips?: CompoundClip[];
  readonly nestedInstances?: CompoundClipInstance[];
  readonly motionCompositions?: MotionComposition[];
  readonly motionInstances?: MotionCompositionInstance[];
  readonly generatedShaders?: readonly MotionShaderDef[];
  readonly creation?: CreationProjectState;
  /**
   * Reference comparison (P1): the single shared sync-compare configuration
   * used by the GUI panel AND the Agent verbs. Absent = no comparison set.
   */
  readonly referenceComparison?: ReferenceComparisonConfig;
  /**
   * Project-scoped work assets ("saved work"): named reusable spans of project
   * media with a captured parameter snapshot. Optional for backward
   * compatibility — absent means the project has no work assets, and old
   * projects never gain the field unless they are edited.
   */
  readonly workAssets?: WorkAsset[];
}

export interface MediaLibrary {
  readonly items: MediaItem[];
}

/**
 * What a project marker points at — exactly one of: a media-library asset,
 * a timeline clip, a text overlay, or an absolute timeline time range.
 */
export type ProjectMarkerTarget =
  | { readonly kind: "asset"; readonly mediaId: string }
  | { readonly kind: "clip"; readonly clipId: string }
  | { readonly kind: "text"; readonly textClipId: string }
  | { readonly kind: "timeRange"; readonly start: number; readonly end: number };

/**
 * Persisted project metadata (never rendered or exported). `number` is
 * stable for the marker's lifetime and is never reused after deletion.
 * Distinct from `Timeline.markers` (ruler point markers).
 */
export interface ProjectMarker {
  readonly id: string;
  readonly number: number;
  readonly target: ProjectMarkerTarget;
  readonly label?: string;
  readonly color?: string;
  readonly createdAt: number;
}

export const DEFAULT_PROJECT_MARKER_COLOR = "#f59e0b";

export interface ProjectMarkersState {
  /** Next number to assign — starts at 1, monotonic (gaps are never reused). */
  readonly nextNumber: number;
  readonly items: ProjectMarker[];
}

export interface MediaItem {
  readonly production?: MediaProduction;
  readonly id: string;
  readonly name: string;
  /**
   * User-facing display name, decoupled from `name` (which keeps the
   * import-time source-filename semantics). Optional for backward
   * compatibility: projects stored before this field existed fall back to
   * `name` at every display site (see mediaDisplayName). Renaming never
   * touches the file on disk or any path resolution — bytes are addressed
   * by `id`.
   */
  readonly displayName?: string;
  readonly type: "video" | "audio" | "image";
  readonly fileHandle: FileSystemFileHandle | null;
  readonly blob: Blob | null;
  readonly metadata: MediaMetadata;
  readonly thumbnailUrl: string | null;
  readonly waveformData: Float32Array | null;
  readonly filmstripThumbnails?: FilmstripThumbnail[];
  readonly isPlaceholder?: boolean;
  readonly originalUrl?: string;
  /** File hint stored in JSON for cross-session/cross-machine asset matching */
  readonly sourceFile?: { name: string; size: number; lastModified: number; folder?: string };
  /**
   * Stable provenance for media imported from the user-level material
   * library.  It is project metadata only and never grants ownership of, or
   * permission to delete, the library record or its source file.
   */
  readonly materialSource?: {
    /** The library entry the user/Agent attached (a media or segment). */
    readonly materialId: string;
    /** Underlying media entry when `materialId` names a segment. */
    readonly sourceMediaMaterialId?: string;
    /** Library record revision observed at attach time. */
    readonly materialRevision: number;
    readonly attachedAt: string;
    readonly attachedBy?: "user" | "agent";
  };
  /**
   * Immutable project-local version lineage. Present on a media.replace
   * result even when the replacement file is not itself saved in the user
   * material library.
   */
  readonly versionSource?: {
    readonly supersedesMediaIdInProject: string;
    readonly supersedesMaterialId?: string;
    readonly replacedAt: string;
    readonly replacedBy?: "user" | "agent";
  };
}

/**
 * Resolved user-facing label for a media item: the explicit displayName when
 * one was set, otherwise the source filename. Every display/search site must
 * go through this helper so old projects without displayName keep working.
 */
export function mediaDisplayName(
  item: Pick<MediaItem, "name" | "displayName">,
): string {
  return item.displayName ?? item.name;
}

/** Thumbnail for filmstrip display in timeline */
export interface FilmstripThumbnail {
  readonly timestamp: number;
  readonly url: string;
}

export interface MediaMetadata {
  readonly duration: number; // In seconds
  readonly width: number; // For video/image
  readonly height: number; // For video/image
  readonly frameRate: number; // For video
  readonly codec: string;
  readonly sampleRate: number; // For audio
  readonly channels: number; // For audio
  readonly fileSize: number;
  /** Number of audio tracks in the file (may be > 1 for multi-track video/audio files) */
  readonly audioTrackCount?: number;
}
