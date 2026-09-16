/**
 * The material.* verb contract (user-level material library).
 *
 * The material library is USER-level state that lives in the desktop GUI
 * renderer's IndexedDB — it is NOT project state. In live sessions the
 * facade stays stateless: every verb validates params here and forwards
 * through the narrow `MaterialLibraryBridge` to the renderer, which owns
 * the canonical records, the journal (undo), and persistence. Headless
 * sessions honestly report the verbs UNSUPPORTED (there is no GUI renderer
 * and therefore no user library).
 *
 * Concurrency rules mirroring the rest of the facade:
 *  - Write verbs require the single-writer lease (gate), reads do not.
 *  - Mutating verbs accept an idempotencyKey; retries replay, never
 *    duplicate (facade ledger + renderer commit ledger).
 *  - Updates accept expectedRevision (the MATERIAL record's revision
 *    counter, distinct from the project revision) for CAS protection.
 *  - Agent writes update title/aiSummary/tags/organizeStatus/description.
 *    userNotes is intentionally absent from every schema: re-analysis can
 *    never overwrite user notes.
 */
import type {
  MaterialJournalEntry,
  MaterialKind,
  MaterialMediaType,
  MaterialOrganizeStatus,
  MaterialRecord,
} from "@openreel/core";

export const MATERIAL_VERBS = [
  "material.list",
  "material.get",
  "material.create",
  "material.update",
  "material.batch_update",
  "material.remove",
  "material.attach",
  "material.undo",
] as const;

export type MaterialVerb = (typeof MATERIAL_VERBS)[number];

/* ------------------------------ params ------------------------------ */

export type MaterialSortOrder = "updated" | "created" | "title";

export interface MaterialListParams {
  readonly kind?: MaterialKind;
  readonly status?: MaterialOrganizeStatus;
  readonly tag?: string;
  readonly query?: string;
  readonly page?: number;
  readonly pageSize?: number;
  readonly sort?: MaterialSortOrder;
}

export interface MaterialGetParams {
  readonly id: string;
}

export interface MaterialCreateParams {
  readonly kind: MaterialKind;
  readonly title?: string;
  readonly tags?: readonly string[];
  readonly organizeStatus?: MaterialOrganizeStatus;
  /** Agent-written summary/description; strictly separate from user notes. */
  readonly aiSummary?: string;
  /** Free-form origin note ("from batch 2026-09-08" etc.). */
  readonly origin?: string;
  /** media: absolute local path inside a configured media root. */
  readonly filePath?: string;
  readonly mediaType?: MaterialMediaType;
  /** segment */
  readonly parentMaterialId?: string;
  readonly startSec?: number;
  readonly endSec?: number;
  /** link */
  readonly url?: string;
  readonly description?: string;
  /** method */
  readonly skillName?: string;
  readonly prompt?: string;
  readonly steps?: readonly string[];
  readonly inputs?: readonly string[];
  readonly idempotencyKey?: string;
}

/** One item of material.batch_update. Mirrors MaterialUpdateParams fields. */
export interface MaterialBatchUpdateItem {
  readonly id: string;
  readonly title?: string;
  readonly aiSummary?: string;
  readonly tags?: readonly string[];
  readonly organizeStatus?: MaterialOrganizeStatus;
  /** Link materials only. */
  readonly description?: string;
  /** Optional per-record CAS guard (the MATERIAL record's revision). */
  readonly expectedRevision?: number;
}

export interface MaterialBatchUpdateParams {
  readonly updates: readonly MaterialBatchUpdateItem[];
  readonly idempotencyKey?: string;
}

export interface MaterialUpdateParams
  extends Omit<MaterialBatchUpdateItem, "expectedRevision"> {
  readonly id: string;
  readonly expectedRevision?: number;
  readonly idempotencyKey?: string;
}

export interface MaterialRemoveParams {
  readonly id: string;
  /** Required when the material still has project references. */
  readonly force?: boolean;
  readonly idempotencyKey?: string;
}

export interface MaterialAttachParams {
  readonly materialId: string;
  /** Optional range override for MEDIA materials (segments use their own). */
  readonly startSec?: number;
  readonly endSec?: number;
  /** Add a timeline clip (default: true for segments/ranges, false for whole media). */
  readonly addClip?: boolean;
  /** Project revision CAS; an omitted value is guarded with the current revision. */
  readonly expectedRevision?: number;
  readonly idempotencyKey?: string;
}

export interface MaterialUndoParams {
  /** Undo a specific journal entry; default: the latest undoable entry. */
  readonly entryId?: string;
  /** Strongly recommended: a retried undo without a key would undo the NEXT entry. */
  readonly idempotencyKey?: string;
}

/* ------------------------------ results ----------------------------- */

export interface MaterialGetResult {
  readonly material: MaterialRecord;
}

export interface MaterialCreateResult {
  /** True when an idempotency-keyed retry replayed the committed result. */
  readonly replayed?: boolean;
  readonly material: MaterialRecord;
  /** The library journal entry that recorded this creation. */
  readonly journalEntryId: string;
}

export interface MaterialUpdateResult {
  /** True when an idempotency-keyed retry replayed the committed result. */
  readonly replayed?: boolean;
  readonly material: MaterialRecord;
  readonly journalEntryId: string;
}

export interface MaterialBatchUpdateResult {
  /** True when an idempotency-keyed retry replayed the committed result. */
  readonly replayed?: boolean;
  readonly materials: readonly MaterialRecord[];
  readonly journalEntryId: string;
}

export interface MaterialRemoveResult {
  /** True when an idempotency-keyed retry replayed the committed result. */
  readonly replayed?: boolean;
  readonly id: string;
  /** Everything removed by this call (a media material cascades its segments). */
  readonly removedIds: readonly string[];
  readonly journalEntryId: string;
}

export interface MaterialAttachResult {
  /** True when an idempotency-keyed retry replayed the committed result. */
  readonly replayed?: boolean;
  readonly materialId: string;
  readonly mediaIdInProject: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly clipId: string | null;
  readonly rangeSec: { readonly startSec: number; readonly endSec: number } | null;
  readonly revision: number;
}

export interface MaterialUndoResult {
  /** True when an idempotency-keyed retry replayed the committed result. */
  readonly replayed?: boolean;
  readonly entryId: string;
  readonly undoneEntryId: string;
  readonly restored: readonly string[];
  readonly removed: readonly string[];
  /**
   * Restored media records whose library blob bytes are absent — such an
   * undo must not read as an unqualified success (those records cannot be
   * previewed or attached). Optional so older renderers may omit it; the
   * library keeps bytes across its undo window, so a normal
   * remove→undo reports an empty list here, and a non-empty list means
   * historically missing data (never a side effect of the undo itself).
   */
  readonly blobMissingIds?: readonly string[];
}

export interface MaterialJournalResult {
  readonly entries: readonly MaterialJournalEntry[];
}

/* --------------------------- the bridge seam ------------------------- */

/** JSON-safe mutation/forward request the facade sends to the renderer. */
export type MaterialLibraryBridgeVerb =
  | "list"
  | "get"
  | "create"
  | "update"
  | "batchUpdate"
  | "remove"
  | "undo"
  | "attach";

export interface MaterialLibraryBridgeRequest {
  readonly verb: MaterialLibraryBridgeVerb;
  readonly params: Record<string, unknown>;
}

export interface MaterialLibraryBridgeError {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export type MaterialLibraryBridgeReply =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: MaterialLibraryBridgeError };

/**
 * The renderer seam: implementations (desktop main → IPC → web renderer)
 * execute against the canonical user-level library and return detached
 * JSON-safe values. Errors carry stable codes; conflicts use "CONFLICT".
 */
export type MaterialLibraryBridge = (
  request: MaterialLibraryBridgeRequest,
) => Promise<MaterialLibraryBridgeReply>;

export const MATERIAL_LIBRARY_LIMITS = {
  maxPageSize: 200,
  maxBatchItems: 200,
  maxJournalEntries: 100,
} as const;

/** Capability block reported by capabilities.get. */
export interface MaterialLibraryCapability {
  readonly available: boolean;
  readonly reason?: string;
  readonly kinds: readonly MaterialKind[];
  readonly statusValues: readonly MaterialOrganizeStatus[];
  readonly searchableFields: readonly string[];
  readonly limits: {
    readonly maxPageSize: number;
    readonly maxBatchItems: number;
    readonly journalEntriesRetained: number;
  };
  /** media materials reference ORIGINAL files (never moved or copied). */
  readonly filePolicy:
    | "reference-original"
    | "renderer-blob-copy-for-web-imports";
  readonly undo: {
    readonly available: boolean;
    readonly scope: "user-library";
  };
  readonly attach: {
    readonly available: boolean;
    readonly supportsRange: boolean;
    readonly reason?: string;
  };
}
