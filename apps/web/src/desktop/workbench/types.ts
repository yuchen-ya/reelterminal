/**
 * AI material workbench — view-model and controller contracts.
 *
 * The migrated prototype components render THESE types; they are derived from
 * the persisted core state (`project.workbench`, see
 * packages/core/src/types/workbench.ts) and never hold a second copy of
 * content. All mutations go through controller callbacks that commit real
 * actions; components must render absent optional data as "未提供/未记录"
 * instead of inventing values.
 */
import type {
  WorkbenchAgentGuidance,
  WorkbenchCellProposal,
  WorkbenchDataColumn,
  WorkbenchDataRow,
  WorkbenchDecision,
  WorkbenchDecisionStatus,
  WorkbenchLineage,
  WorkbenchParentMode,
  WorkbenchProvenanceTag,
  WorkbenchFeedbackTarget,
  WorkbenchPixelStroke,
  WorkbenchSpatialAnnotation,
  WorkbenchVideoMarker,
  WorkbenchContentType,
} from "@reelterminal/core";

export type { WorkbenchContentType };

export type { WorkbenchParentMode } from "@reelterminal/core";
export type MediaLoadStatus = "loading" | "ready" | "error" | "unavailable";

/** Media reference handed to image/video workspaces (never raw bytes). */
export interface WorkbenchMediaRef {
  readonly mediaId: string;
  /** Object URL created by the page for the CURRENT item only; null otherwise. */
  readonly url: string | null;
  readonly status: MediaLoadStatus;
  readonly error?: string;
  /** Persisted MediaItem thumbnail (data URL) when available — for grids. */
  readonly thumbnailUrl?: string | null;
  readonly displayName: string;
}

export interface TextRangeCommentView {
  readonly id: string;
  readonly entryId: string;
  readonly version: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly quotedText: string;
  readonly suggestion: string;
  readonly referencedTags: readonly string[];
}

export interface TextPayloadView {
  readonly entryId: string;
  readonly title: string;
  readonly speakerOrContext: string;
  /** Version 1 text — the retained original. */
  readonly originalText: string;
  /** Current text (latest version entry). */
  readonly currentText: string;
  readonly originalVersion: number;
  readonly currentVersion: number;
  readonly duplicateProposal?: {
    similarToEntryId: string;
    similarityScore: number;
    reason: string;
    dismissed?: boolean;
  };
  readonly rangeComments: readonly TextRangeCommentView[];
}

export interface DataPayloadView {
  readonly datasetId: string;
  readonly columns: readonly WorkbenchDataColumn[];
  readonly rows: readonly WorkbenchDataRow[];
  readonly proposals: readonly WorkbenchCellProposal[];
}

export type ImageDisplayMode = "original" | "repaired";

export interface WorkbenchImageRepairView {
  readonly revisionId: string;
  readonly mediaId: string;
  readonly producedVersion: number;
  readonly base?: import("@reelterminal/core").WorkbenchRepairBase;
}

export interface ImagePayloadView {
  readonly originalMedia: WorkbenchMediaRef;
  /** Latest saved repair PNG; absent when no valid image-repair revision exists. */
  readonly repairMedia?: WorkbenchMediaRef;
  readonly repair?: WorkbenchImageRepairView;
  readonly initialDisplayMode: ImageDisplayMode;
  readonly naturalWidth?: number;
  readonly naturalHeight?: number;
  readonly annotations: readonly WorkbenchSpatialAnnotation[];
  /** Last persisted strokes (legacy); display uses the burned repair PNG. */
  readonly strokes: readonly WorkbenchPixelStroke[];
}

export type WorkbenchMediaUsage = "none" | "pending" | "processed";

/** Project media that can become a local workbench batch item. */
export interface WorkbenchMediaAsset {
  readonly id: string;
  readonly name: string;
  readonly type: "image" | "video";
  readonly thumbnailUrl: string | null;
  readonly width?: number;
  readonly height?: number;
  readonly durationSec?: number;
  /** Existing workbench usage, split so "exists" never means "reviewed". */
  readonly usage: WorkbenchMediaUsage;
}

export interface CreateWorkbenchBatchInput {
  readonly name: string;
  readonly description?: string;
  readonly mediaIds: readonly string[];
  /** Frozen submission identity, reused only when the media selection is unchanged. */
  readonly batchId?: string;
  readonly itemIds?: readonly string[];
}

export type CreateWorkbenchBatchResult =
  | { readonly ok: true; readonly batchId: string; readonly itemIds: readonly string[] }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface VideoPayloadView {
  readonly media: WorkbenchMediaRef;
  readonly durationSec?: number;
  readonly resolution?: string;
  readonly markers: readonly WorkbenchVideoMarker[];
  /** Optional Agent-authored reference video item id for side-by-side comparison. */
  readonly compareWithItemId?: string;
}

export interface FeedbackView {
  readonly id: string;
  readonly text: string;
  readonly referencedTagIds: readonly string[];
  readonly targetSummary: string;
  /** Structured target identity (issue-level feedback); absent for legacy whole-item records. */
  readonly target?: WorkbenchFeedbackTarget;
  readonly itemVersion: number;
  readonly wantsRework: boolean;
  readonly clearedBy?: "accepted" | "cancelled";
  readonly clearedAt?: number;
  readonly isDraft: boolean;
  readonly updatedAt: number;
}

/** Stable cell coordinates used by explicit "mark rework". */
export interface DataReworkCell {
  readonly rowId: string;
  readonly columnId: string;
  readonly proposalId?: string;
}

export interface WorkbenchItemView {
  readonly isNew?: boolean;
  readonly updatedAt?: number;
  /** False for a paginated summary; payloads and feedback have not been read yet. */
  readonly detailsLoaded?: boolean;
  readonly id: string;
  readonly batchId: string;
  readonly orderIndex: number;
  readonly title: string;
  readonly subtitle: string;
  readonly type: WorkbenchContentType;
  readonly version: number;
  readonly status: WorkbenchDecisionStatus;
  readonly hasManualRevision: boolean;
  readonly provenanceTags: readonly WorkbenchProvenanceTag[];
  readonly userCategoryTags: readonly string[];
  /** Optional agent input — components must render absence explicitly. */
  readonly agentGuidance?: WorkbenchAgentGuidance;
  /** Optional lineage — no fabricated tree edges. */
  readonly lineage?: WorkbenchLineage;
  readonly feedback?: FeedbackView;
  /** Every persisted feedback record, newest last (issue-level reads). */
  readonly feedbacks: readonly FeedbackView[];
  readonly reworkOrigin?: {
    fromHandoffId: string;
    previousVersion: number;
    summary?: string;
  };
  readonly textPayload?: TextPayloadView;
  readonly dataPayload?: DataPayloadView;
  readonly videoPayload?: VideoPayloadView;
  readonly imagePayload?: ImagePayloadView;
  readonly modelPayload?: { readonly resourceId: string };
  /**
   * Optional Agent-specified parent presentation mode ("board" = adaptive multi-item
   * canvas, collapsed by default in tree; "category" = folder classification).
   */
  readonly groupMode?: WorkbenchParentMode;
  /** Optional Agent-specified comparison target item id (e.g. baseline video/image). */
  readonly compareWithItemId?: string;
}

export interface WorkbenchBatchView {
  readonly isNew?: boolean;
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly revision: number;
  readonly totalCount: number;
  readonly pendingCount: number;
}

/** Result shape for controller mutations (single error surfaced, no silent fallback). */
export type WorkbenchMutationResult =
  | {
      readonly ok: true;
      /** Present for publish: the replayed/created snapshot identity. */
      readonly handoffId?: string;
      readonly replayed?: boolean;
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface DataPatchInput {
  readonly rowId: string;
  readonly columnId: string;
  /** Omit for a proposal-only accept/reject (never rewrites the cell value). */
  readonly value?: string | null;
  readonly proposalId?: string;
  readonly proposalOutcome?: "accepted" | "modified" | "rejected";
}

export interface RangeCommentInput {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly quotedText: string;
  readonly suggestion: string;
  readonly referencedTags: readonly string[];
}

export interface FeedbackDraftInput {
  readonly text: string;
  readonly referencedTagIds: readonly string[];
  readonly targetSummary: string;
  readonly confirmed: boolean;
}

/** Selection modifier semantics shared by tree, grid and mind-map. */
export interface SelectModifiers {
  readonly shift?: boolean;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
}

/**
 * Controller surface consumed by WorkbenchPage and the workspace components.
 * Implemented by useWorkbenchController(); every write returns a promise that
 * resolves only after the action batch commits (auto-advance happens on
 * success only).
 */
export interface WorkbenchController {
  // --- read model -----------------------------------------------------------
  readonly batches: readonly WorkbenchBatchView[];
  readonly mediaAssets: readonly WorkbenchMediaAsset[];
  readonly createBatchFromMedia: (
    input: CreateWorkbenchBatchInput,
  ) => Promise<CreateWorkbenchBatchResult>;
  readonly activeBatch: WorkbenchBatchView | null;
  /** All items of the active batch in stable order (before filters). */
  readonly batchItems: readonly WorkbenchItemView[];
  /** Items visible under the current type filter + search (selectable scope). */
  readonly visibleItems: readonly WorkbenchItemView[];
  /** Ids of the visible scope; keyboard decisions may only target these. */
  readonly visibleItemIds: readonly string[];
  readonly pendingItems: readonly WorkbenchItemView[];
  readonly currentItem: WorkbenchItemView | null;
  readonly selectedIds: readonly string[];
  readonly selectionCount: number;
  readonly provenanceTags: readonly WorkbenchProvenanceTag[];
  readonly handoffs: readonly import("@reelterminal/core").WorkbenchHandoff[];
  /** True when the store's undo stack has entries (host history, not a shadow stack). */
  readonly canUndo: boolean;
  readonly canRedo: boolean;

  // --- display state (workbench UI store, not persisted content) ------------
  readonly typeFilter: WorkbenchContentType | "all";
  readonly searchQuery: string;
  readonly autoAdvance: boolean;
  readonly setTypeFilter: (filter: WorkbenchContentType | "all") => void;
  readonly setSearchQuery: (query: string) => void;
  readonly setAutoAdvance: (enabled: boolean) => void;
  readonly setActiveBatchId: (batchId: string) => void;
  readonly openMindMapModal: () => void;
  readonly closeMindMapModal: () => void;
  readonly isMindMapModalOpen: boolean;

  // --- selection / navigation ------------------------------------------------
  readonly selectItem: (itemId: string, modifiers?: SelectModifiers) => void;
  readonly selectAllVisible: () => void;
  readonly clearSelection: () => void;
  readonly setSelection: (itemIds: readonly string[]) => void;
  readonly focusItem: (itemId: string) => void;
  readonly skipNext: () => void;
  readonly skipPrev: () => void;

  // --- decisions -------------------------------------------------------------
  readonly commitDecision: (
    decision: WorkbenchDecision,
    explicitTargetIds?: readonly string[],
    options?: { reason?: string; advance?: boolean },
  ) => Promise<WorkbenchMutationResult>;
  /** Branch nod: per-item suggested decisions, but one shared execution path. */
  readonly commitBranchNod: (
    items: readonly WorkbenchItemView[],
  ) => Promise<WorkbenchMutationResult>;
  readonly retrieveToPending: (itemId: string) => Promise<WorkbenchMutationResult>;
  readonly retrieveItemsToPending: (itemIds: readonly string[]) => Promise<WorkbenchMutationResult>;
  readonly undoLast: () => Promise<WorkbenchMutationResult>;
  readonly redoLast: () => Promise<WorkbenchMutationResult>;
  readonly addUserTag: (itemId: string, tag: string) => Promise<WorkbenchMutationResult>;

  // --- content edits ----------------------------------------------------------
  readonly saveTextRevision: (
    itemId: string,
    newText: string,
  ) => Promise<WorkbenchMutationResult>;
  readonly addRangeComment: (
    itemId: string,
    comment: RangeCommentInput,
    expectedVersion?: number,
  ) => Promise<WorkbenchMutationResult>;
  readonly confirmDuplicate: (
    itemId: string,
    action: "discard" | "dismiss_proposal",
  ) => Promise<WorkbenchMutationResult>;
  readonly updateDataCells: (
    itemId: string,
    patches: readonly DataPatchInput[],
    markDecision?: "modified",
    expectedVersion?: number,
  ) => Promise<WorkbenchMutationResult>;
  /** Explicit multi-cell rework marks + item rework decision in ONE commit. */
  readonly markDataRework: (
    itemId: string,
    itemVersion: number,
    cells: readonly DataReworkCell[],
    reason?: string,
  ) => Promise<WorkbenchMutationResult>;
  /** Cancel active rework markers (sets clearedBy "cancelled"). */
  readonly clearDataRework: (
    itemId: string,
    itemVersion: number,
    cells: readonly DataReworkCell[],
  ) => Promise<WorkbenchMutationResult>;
  readonly updateImageAnnotations: (
    itemId: string,
    annotations: readonly WorkbenchSpatialAnnotation[],
    feedback?: {
      text: string;
      referencedTagIds: readonly string[];
      markRework: boolean;
      state?: "draft" | "confirmed";
      target?: import("@reelterminal/core").WorkbenchFeedbackTarget;
    },
    expectedVersion?: number,
  ) => Promise<WorkbenchMutationResult>;
  readonly saveImageRepair: (
    itemId: string,
    strokes: readonly WorkbenchPixelStroke[],
    renderPatchedImage: () => Promise<Blob | null>,
    base?: import("@reelterminal/core").WorkbenchRepairBase,
  ) => Promise<WorkbenchMutationResult>;
  readonly updateVideoMarkers: (
    itemId: string,
    markers: readonly WorkbenchVideoMarker[],
    feedback?: {
      text: string;
      referencedTagIds: readonly string[];
      markRework: boolean;
      state?: "draft" | "confirmed";
      target?: import("@reelterminal/core").WorkbenchFeedbackTarget;
    },
    expectedVersion?: number,
  ) => Promise<WorkbenchMutationResult>;
  readonly saveFeedback: (
    itemId: string,
    draft: FeedbackDraftInput,
  ) => Promise<WorkbenchMutationResult>;

  readonly saveModelObservation?: (input: import("../../services/review-workspace/model-feedback").SaveModelObservation) => Promise<WorkbenchMutationResult>;
  /** Resolve a playable/displayable URL for any item's mediaId on demand (used by board & video comparison). */
  readonly openMediaUrl?: (
    mediaId: string,
  ) => Promise<{ url: string; release: () => void } | null>;
  /** Ensure full payloads are loaded for a set of item ids (used by independent review board & comparison). */
  readonly ensureItemsLoaded?: (itemIds: readonly string[]) => Promise<void>;

  // --- handoff ---------------------------------------------------------------
  readonly publishHandoff: (
    itemIds?: readonly string[],
  ) => Promise<WorkbenchMutationResult>;
}
