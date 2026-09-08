/**
 * User-level material library data model.
 *
 * The material library is a USER-level collection of creative resources that
 * exists independently of any project: local media files, time ranges inside
 * media, links, and reusable "skill + prompt" methods. Projects reference
 * materials; they never own them. Removing a project reference never deletes
 * the user-level material, and removing a library entry never deletes the
 * original file on disk.
 *
 * The record format is JSON and persists in the renderer's IndexedDB
 * (`openreel-material-library`). `schemaVersion` gates future migrations.
 *
 * Separation guarantees (load-bearing):
 *  - `userNotes` is written by the human. Agent tools update `aiSummary`,
 *    never `userNotes`; re-analysis can never overwrite user notes.
 *  - `revision` is a monotonic per-record counter used as a CAS guard so a
 *    concurrent editor can never be silently overwritten.
 */

/** Current record format version persisted in IndexedDB. */
export const MATERIAL_LIBRARY_SCHEMA_VERSION = 1;

export type MaterialKind = "media" | "segment" | "link" | "method";
export type MaterialMediaType = "video" | "audio" | "image";
export type MaterialOrganizeStatus = "inbox" | "organized";
export type MaterialActor = "user" | "agent";

export const MATERIAL_KINDS: readonly MaterialKind[] = [
  "media",
  "segment",
  "link",
  "method",
];

export const MATERIAL_MEDIA_TYPES: readonly MaterialMediaType[] = [
  "video",
  "audio",
  "image",
];

/**
 * How a media material reaches its bytes.
 *
 *  - `path`: desktop reference to the ORIGINAL file at its absolute path.
 *    The file is never moved or copied by the library; existence is probed
 *    on demand and a missing file is surfaced, never hidden.
 *  - `blob`: an explicit copy stored in the library's own IndexedDB blob
 *    store (the browser build has no stable path). Created only when the
 *    user saves a file into the library.
 */
export type MaterialFileRef =
  | {
      readonly type: "path";
      readonly path: string;
      readonly fileName: string;
      readonly sizeBytes?: number;
      readonly lastModifiedMs?: number;
    }
  | {
      readonly type: "blob";
      readonly fileName: string;
      readonly mimeType?: string;
      readonly sizeBytes?: number;
      readonly lastModifiedMs?: number;
    };

/** Technical metadata for media materials (best effort, all optional). */
export interface MaterialMediaMetadata {
  readonly durationSec?: number;
  readonly width?: number;
  readonly height?: number;
  readonly frameRate?: number;
  readonly codec?: string;
  readonly sampleRate?: number;
  readonly channels?: number;
  readonly fileSizeBytes?: number;
}

/** Where a material came from and who added it. */
export interface MaterialSourceInfo {
  /** Free-form origin description (e.g. "recorded on trip", "agent batch"). */
  readonly origin?: string;
  /** Path/URL the material was captured from, when applicable. */
  readonly capturedFrom?: string;
  readonly addedBy: MaterialActor;
  readonly addedAt: string;
}

/** One project's reference to a material (informational, project-scoped). */
export interface MaterialUsage {
  readonly projectId: string;
  readonly projectName?: string;
  /** Project-local media item id minted by the canonical import path. */
  readonly mediaIdInProject?: string;
  /** Range used by THIS reference, when the attach was range-scoped. */
  readonly startSec?: number;
  readonly endSec?: number;
  readonly attachedAt: string;
  readonly attachedBy: MaterialActor;
}

export interface MaterialRecordBase {
  readonly schemaVersion: number;
  readonly id: string;
  readonly kind: MaterialKind;
  readonly title: string;
  readonly tags: readonly string[];
  readonly organizeStatus: MaterialOrganizeStatus;
  /** Human-written notes. Agent writes go to `aiSummary`, never here. */
  readonly userNotes: string;
  /** Agent/AI-written summary or description. */
  readonly aiSummary: string;
  readonly source: MaterialSourceInfo;
  /** Provenance of the last write. */
  readonly updatedBy: MaterialActor;
  readonly lastAgentEditAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Monotonic per-record counter; CAS guard for concurrent updates. */
  readonly revision: number;
  readonly usages: readonly MaterialUsage[];
}

export interface MediaMaterialRecord extends MaterialRecordBase {
  readonly kind: "media";
  readonly mediaType: MaterialMediaType;
  readonly fileRef: MaterialFileRef;
  readonly metadata: MaterialMediaMetadata;
  /** Small inline JPEG data URL (best effort), absent when unavailable. */
  readonly thumbnailDataUrl?: string;
}

export interface SegmentMaterialRecord extends MaterialRecordBase {
  readonly kind: "segment";
  readonly parentMaterialId: string;
  readonly startSec: number;
  readonly endSec: number;
}

export interface LinkMaterialRecord extends MaterialRecordBase {
  readonly kind: "link";
  readonly url: string;
  /** User-written or fetched note about the URL's content. */
  readonly description?: string;
}

export interface MethodMaterialRecord extends MaterialRecordBase {
  readonly kind: "method";
  /** Skill/tool identifier the method references (optional). */
  readonly skillName?: string;
  readonly prompt: string;
  readonly steps?: readonly string[];
  /** Inputs the method expects (descriptions, not executable code). */
  readonly inputs?: readonly string[];
}

export type MaterialRecord =
  | MediaMaterialRecord
  | SegmentMaterialRecord
  | LinkMaterialRecord
  | MethodMaterialRecord;

/* ------------------------------------------------------------------ */
/* Journal (library-scoped undo, independent of project history)       */
/* ------------------------------------------------------------------ */

/** One record's before/after state inside a journaled batch. */
export interface MaterialJournalChange {
  readonly materialId: string;
  /** Record state before the change; null when the change created it. */
  readonly before: MaterialRecord | null;
  /** Record state after the change; null when the change removed it. */
  readonly after: MaterialRecord | null;
}

export interface MaterialJournalEntry {
  readonly id: string;
  readonly schemaVersion: number;
  readonly at: string;
  readonly actor: MaterialActor;
  /** One-line human-readable description of the batch. */
  readonly label: string;
  /** Facade verb that produced the batch, when agent-driven. */
  readonly verb?: string;
  readonly materialIds: readonly string[];
  readonly changes: readonly MaterialJournalChange[];
  readonly undone: boolean;
  readonly undoneAt?: string;
}

/* ------------------------------------------------------------------ */
/* List / search                                                       */
/* ------------------------------------------------------------------ */

export interface MaterialFilters {
  readonly kind?: MaterialKind;
  readonly status?: MaterialOrganizeStatus;
  readonly tag?: string;
}

export type MaterialSortOrder = "updated" | "created" | "title";

export interface MaterialListQuery extends MaterialFilters {
  /** Substring search over title, notes, summary, tags and kind text. */
  readonly query?: string;
  readonly page: number;
  readonly pageSize: number;
  readonly sort?: MaterialSortOrder;
}

export interface MaterialListResult {
  readonly items: readonly MaterialRecord[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages: number;
  /** Distinct tags across the WHOLE library (not just this page). */
  readonly allTags: readonly string[];
}

/** Computed (never persisted) availability of a media material's bytes. */
export type MaterialFileStatus = "ok" | "missing" | "unknown";
