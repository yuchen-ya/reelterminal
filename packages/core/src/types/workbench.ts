/**
 * AI material workbench: batch review of Agent-produced content.
 *
 * This is the persisted data model for the human decision-maker side of the
 * workbench (`project.workbench`). Four content kinds are first-class — image,
 * text, data and video. Text corpora and data tables are REAL content kinds
 * with their own payloads; they must never be disguised as media.import files.
 * Image/video items reference existing project media by `mediaId` and never
 * duplicate media bytes.
 *
 * Invariants (see docs/AI-MATERIAL-WORKBENCH-DESIGN.md):
 * - Every item has at most one primary decision status
 *   (pending/kept/discarded/modified/rework); counts are mutually exclusive.
 * - "Discarded" is a batch-level logical decision: source files are never
 *   deleted and other batches keep their own references.
 * - Positions are typed per content kind and bound to an item version:
 *   text uses UTF-16 half-open offsets, data uses stable rowId/columnId,
 *   images use direction-normalized source pixel coordinates, video uses real
 *   PTS seconds (frame indexes only when a real mapping exists).
 * - Handoffs are immutable once published; later decisions supersede via a
 *   new handoff, and identical idempotency keys never publish twice.
 */

import { v5 as uuidv5, validate as isUuid } from "uuid";

export type WorkbenchContentType = "image" | "text" | "data" | "video" | "model3d";

export type WorkbenchDecisionStatus =
  | "pending"
  | "kept"
  | "discarded"
  | "modified"
  | "rework";

export type WorkbenchDecision =
  Exclude<WorkbenchDecisionStatus, "pending">;

export type WorkbenchProvenanceCategory =
  | "model"
  | "algorithm"
  | "skill"
  | "source"
  | "batch";

/**
 * A provenance tag keeps a stable identity plus version; display names are
 * never identity. `verification` distinguishes what the Agent DECLARED from
 * what has actually been checked — "unknown" is a valid, displayable state.
 */
export interface WorkbenchProvenanceTag {
  /** Stable identity, e.g. "prov_edge_clean"; minted by the ingest caller. */
  readonly id: string;
  readonly category: WorkbenchProvenanceCategory;
  readonly shortName: string;
  /** Version identity when available; same name with different versions never merges. */
  readonly version?: string;
  readonly verification: "declared" | "verified" | "unknown";
  /** Optional upstream object reference (stable id string). */
  readonly upstreamRef?: string;
  readonly detailSummary: string;
}

/** Normalized [0,1] rectangle/anchor relative to decoded image dimensions. */
export interface WorkbenchSpatialAnnotation {
  readonly id: string;
  readonly tool: "box" | "arrow" | "text";
  readonly x: number;
  readonly y: number;
  readonly w?: number;
  readonly h?: number;
  readonly endX?: number;
  readonly endY?: number;
  readonly label?: string;
  readonly color: string;
  /** Video only: PTS seconds of the frame the annotation is anchored to. */
  readonly ptsSec?: number;
}

/**
 * One brush/eraser stroke on the pixel-repair layer. Points are in decoded
 * source-pixel coordinates (direction normalized) and carry Pointer Events
 * pressure. The eraser erases the REPAIR layer only — it never paints the
 * background color.
 */
export interface WorkbenchPixelStroke {
  readonly id: string;
  readonly tool: "brush" | "eraser";
  readonly color: string;
  /** Brush size in source pixels. */
  readonly size: number;
  readonly points: ReadonlyArray<{
    readonly x: number;
    readonly y: number;
    readonly pressure: number;
  }>;
}

/**
 * A video problem marker. Legacy *PtsSec fields store HTMLVideoElement.currentTime
 * seconds on the browser media timeline, not an inferred container timestamp.
 * Frame indexes are optional and present only when a real decoded-frame
 * mapping exists; a nominal-fps guess must never be stored as a frame index.
 */
export interface WorkbenchVideoMarker {
  readonly id: string;
  /** Automatically created to hold spatial annotations, not a standalone issue. */
  readonly annotationContainer?: boolean;
  readonly type: "frame" | "interval";
  readonly startPtsSec: number;
  readonly endPtsSec?: number;
  readonly startFrameIndex?: number;
  readonly endFrameIndex?: number;
  readonly note: string;
  /** Item content version the marker was created against. */
  readonly version: number;
  readonly annotations: readonly WorkbenchSpatialAnnotation[];
}

export interface WorkbenchTextVersion {
  readonly version: number;
  readonly text: string;
  readonly createdAt: number;
  readonly origin: "ingest" | "human-revision" | "agent-rework";
  readonly parentVersion?: number;
}

export interface WorkbenchDuplicateProposal {
  readonly similarToEntryId: string;
  readonly similarityScore: number;
  readonly reason: string;
  readonly dismissed?: boolean;
}

export interface WorkbenchTextContent {
  readonly type: "text";
  readonly entryId: string;
  readonly title: string;
  readonly speakerOrContext: string;
  /**
   * Every saved revision is retained so older range comments stay readable
   * against the version they were anchored to. The current text is the last
   * entry; `item.version` equals that entry's version.
   */
  readonly versions: readonly WorkbenchTextVersion[];
  readonly duplicateProposal?: WorkbenchDuplicateProposal;
}

export interface WorkbenchImageContent {
  readonly type: "image";
  /** Reference to the project MediaItem with the source bytes. */
  readonly mediaId: string;
  /** Decoded natural size in pixels, when known at ingest. */
  readonly naturalWidth?: number;
  readonly naturalHeight?: number;
  readonly annotations: readonly WorkbenchSpatialAnnotation[];
  /** Pixel-repair layer strokes; annotations and repairs are stored separately. */
  readonly strokes: readonly WorkbenchPixelStroke[];
}

export interface WorkbenchVideoContent {
  readonly type: "video";
  readonly mediaId: string;
  /** Display-only metadata; positions always come from real playback. */
  readonly durationSec?: number;
  readonly resolution?: string;
  readonly markers: readonly WorkbenchVideoMarker[];
}

export interface WorkbenchDataColumn {
  readonly columnId: string;
  readonly title: string;
  readonly width?: string;
  readonly monospace?: boolean;
}

export interface WorkbenchDataRow {
  readonly rowId: string;
  readonly cells: Readonly<Record<string, string | null>>;
}

/** Agent-submitted cell proposal with a stable proposal id. */
export interface WorkbenchCellProposal {
  readonly proposalId: string;
  readonly rowId: string;
  readonly columnId: string;
  readonly originalValue: string | null;
  readonly proposedValue: string | null;
  readonly reason: string;
  readonly provenanceTagId: string;
  readonly status: "proposed" | "accepted" | "rejected" | "modified";
}

export interface WorkbenchDataContent {
  readonly type: "data";
  readonly datasetId: string;
  readonly columns: readonly WorkbenchDataColumn[];
  readonly rows: readonly WorkbenchDataRow[];
  readonly proposals: readonly WorkbenchCellProposal[];
}

/** Read-only GLB original. Viewer state is feedback, never content. */
export interface WorkbenchModelContent {
  readonly type: "model3d";
  readonly resourceId: string;
}

export interface ModelObservation {
  readonly preset: "neutral-r182-v1";
  readonly background: "light" | "dark";
  readonly camera: {
    readonly position: readonly number[];
    readonly quaternion: readonly number[];
    readonly target: readonly number[];
    readonly fov: number;
    readonly near: number;
    readonly far: number;
  };
  readonly animation: { readonly index: number; readonly name: string; readonly time: number } | null;
  readonly viewport: { readonly width: number; readonly height: number };
}

export type WorkbenchItemContent =
  | WorkbenchTextContent
  | WorkbenchImageContent
  | WorkbenchVideoContent
  | WorkbenchDataContent
  | WorkbenchModelContent;

/**
 * One cell edit; the dataset evolves only through explicit patches.
 *
 * `value` may be omitted for a proposal-only patch (accept/reject): resolving
 * a proposal is a real state change even when the cell text is unchanged, and
 * rejecting a proposal must never reset a human-edited value to the proposal's
 * original value. Patch sets that change neither a value nor a proposal status
 * are rejected as no-ops by the builder.
 */
export interface WorkbenchDataPatch {
  readonly rowId: string;
  readonly columnId: string;
  readonly value?: string | null;
  /** Proposal this patch resolves, when the edit confirms an Agent proposal. */
  readonly proposalId?: string;
  readonly proposalOutcome?: "accepted" | "modified" | "rejected";
}

/** Explicit base of an image repair; legacy revisions may not have recorded it. */
export type WorkbenchRepairBase =
  | { readonly kind: "source" }
  | { readonly kind: "revision"; readonly revisionId: string };

/** A saved content revision. The original content is never overwritten. */
export interface WorkbenchContentRevision {
  readonly id: string;
  readonly itemId: string;
  readonly parentVersion: number;
  readonly producedVersion: number;
  readonly createdAt: number;
  readonly kind: "text" | "data" | "image-repair" | "agent-rework";
  readonly text?: { readonly entryId: string; readonly text: string };
  readonly data?: { readonly patches: readonly WorkbenchDataPatch[] };
  /** Derived media of an image repair (patched PNG); the source media is untouched. */
  readonly mediaId?: string;
  readonly strokes?: readonly WorkbenchPixelStroke[];
  readonly base?: WorkbenchRepairBase;
  /** Separate transparent layer and its frozen bottom image for exact eraser semantics. */
  readonly repairLayerMediaId?: string;
  readonly repairBaseMediaId?: string;
}

/** Agent guidance is optional input; the UI must render its absence honestly. */
export interface WorkbenchAgentGuidance {
  readonly triageGroup: "need_verdict" | "ready_patch" | "pass_candidate";
  readonly branchName: string;
  readonly nodeSlotLabel: string;
  readonly whatHappened: string;
  readonly whatToDoNext: string;
  readonly nodButtonLabel: string;
  /**
   * The Agent's SUGGESTED decision. Nodding is a human confirm action — it
   * never auto-applies patches; "modified" suggestions require a real patch.
   */
  readonly nodDecision: WorkbenchDecision;
}

export interface WorkbenchLineageStep {
  readonly version: number;
  readonly outcome: "rejected" | "modified" | "current" | "kept" | "discarded";
  readonly edgeLabel: string;
  readonly summary: string;
}

export type WorkbenchParentMode = "board" | "category";

/** Agent-provided video presentation metadata; media content remains in content. */
export interface WorkbenchVideoPayload {
  /** 同批次内作为对比基准的另一条 video item ID。 */
  readonly compareWithItemId?: string;
}

export interface WorkbenchLineage {
  /** board 聚合画板（默认收拢，同屏审阅子项）；category 分类目录（默认展开）。 */
  readonly groupMode?: WorkbenchParentMode;
  readonly upstreamGroupId: string;
  readonly upstreamGroupTitle: string;
  readonly upstreamSourceNode: string;
  /** True tree parent item id, when a real parent reference exists. */
  readonly parentNodeId?: string;
  readonly basedOnLabel: string;
  readonly connectorEdgeLabel: string;
  readonly failStreak: number;
  readonly steps: readonly WorkbenchLineageStep[];
}

/** Structured feedback target — never a display string alone. */
export type WorkbenchFeedbackTarget =
  | { readonly kind: "model-view"; readonly observationId: string; readonly resourceId: string;
      readonly screenshotResourceId: string; readonly observation: ModelObservation }
  | {
      readonly kind: "pixel-region";
      readonly annotationId: string;
      readonly x: number;
      readonly y: number;
      readonly w?: number;
      readonly h?: number;
      readonly naturalWidth?: number;
      readonly naturalHeight?: number;
    }
  | {
      readonly kind: "text-range";
      readonly entryId: string;
      readonly version: number;
      readonly startOffset: number;
      readonly endOffset: number;
    }
  | {
      readonly kind: "data-cell";
      readonly rowId: string;
      readonly columnId: string;
      readonly proposalId?: string;
    }
  | {
      readonly kind: "video-marker";
      readonly markerId: string;
      readonly startPtsSec: number;
      readonly endPtsSec?: number;
      readonly hasFrameMapping: boolean;
    }
  | { readonly kind: "whole-item" };

export interface WorkbenchFeedback {
  readonly id: string;
  readonly itemId: string;
  /** Item content version the feedback was written against. */
  readonly itemVersion: number;
  readonly text: string;
  readonly referencedTagIds: readonly string[];
  readonly target?: WorkbenchFeedbackTarget;
  /**
   * Machine-detectable intent. Only an explicit "rework" signal counts as
   * rework; ordinary notes and text keywords are never inferred as rework.
   */
  readonly intent?: "note" | "rework";
  /** Set when a rework signal stops being an active todo (accept/cancel). */
  readonly clearedAt?: number;
  readonly clearedBy?: "accepted" | "cancelled";
  /** Draft feedback is persisted but never enters a published handoff. */
  readonly state: "draft" | "confirmed";
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Append-only decision log entry; `decisionRevision` is per-item monotonic. */
export interface WorkbenchDecisionEntry {
  readonly decision: WorkbenchDecision;
  readonly decisionRevision: number;
  readonly baseVersion: number;
  readonly decidedAt: number;
  /** Channel identity; agents can never author human decisions. */
  readonly operator: "human" | "agent";
  readonly contentRevisionId?: string;
  readonly feedbackIds?: readonly string[];
}

export interface WorkbenchItem {
  readonly incomingRevision?: number;
  /** 父节点或所属分组的呈现模式。 */
  readonly groupMode?: WorkbenchParentMode;
  /** Agent 预绑定的对比基准条目 ID。 */
  readonly compareWithItemId?: string;
  readonly videoPayload?: WorkbenchVideoPayload;
  /** Independent review file import retains the exact source bytes, including text/table files. */
  readonly originalResourceId?: string;
  /** Stable identity minted at ingest; never reused. */
  readonly id: string;
  readonly batchId: string;
  readonly orderIndex: number;
  readonly title: string;
  readonly subtitle?: string;
  readonly type: WorkbenchContentType;
  /** Current content version; starts at 1 on ingest. */
  readonly version: number;
  /** Latest persisted item/feedback change; older records may omit it. */
  readonly updatedAt?: number;
  /** Independent review storage retains allocated versions across undo branches. */
  readonly versionCeiling?: number;
  readonly createdAt: number;
  readonly content: WorkbenchItemContent;
  readonly provenanceTags: readonly WorkbenchProvenanceTag[];
  readonly userTags: readonly string[];
  readonly agentGuidance?: WorkbenchAgentGuidance;
  readonly lineage?: WorkbenchLineage;
  readonly reworkOrigin?: {
    readonly fromHandoffId: string;
    readonly previousVersion: number;
    readonly summary?: string;
  };
  /** Current primary decision status; "pending" until a human decides. */
  readonly status: WorkbenchDecisionStatus;
  readonly decisionLog: readonly WorkbenchDecisionEntry[];
  readonly revisions: readonly WorkbenchContentRevision[];
}

export interface WorkbenchBatch {
  /** Local review notification metadata; independent of review decisions. */
  readonly incomingRevision?: number;
  readonly contentUpdatedAt?: number;
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly createdAt: number;
  /** Bumped on every accepted append so concurrent ingests are detectable. */
  readonly revision: number;
  /** Ordered membership; stable once written. */
  readonly itemIds: readonly string[];
}

/** One frozen tag reference inside an execution-level handoff issue. */
export interface WorkbenchHandoffReferencedTag {
  readonly id: string;
  readonly name?: string;
  readonly version?: string;
  /** A non-resolvable reference keeps its raw value instead of disappearing. */
  readonly referenceState: "resolved" | "unresolved";
  readonly raw?: string;
}

/**
 * Execution-level issue frozen into a handoff snapshot: item version, stable
 * issue id, the full target geometry/time/row-column identity and the tag
 * references as they resolved at publish time. An `annotationCount` alone is
 * not an executable contract.
 */
export interface WorkbenchHandoffIssue {
  readonly feedbackId: string;
  readonly issueId: string;
  readonly itemVersion: number;
  readonly intent: "note" | "rework";
  readonly state: "confirmed";
  readonly text: string;
  readonly target: WorkbenchFeedbackTarget;
  readonly referencedTags: readonly WorkbenchHandoffReferencedTag[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Real content carried in a handoff snapshot so an Agent can reconstruct input. */
export interface WorkbenchHandoffItem {
  readonly itemId: string;
  readonly title: string;
  readonly type: WorkbenchContentType;
  readonly itemVersion: number;
  readonly decisionRevision: number;
  readonly decision: WorkbenchDecision;
  readonly operator: "human";
  readonly contentRevisionId?: string;
  readonly feedbackIds: readonly string[];
  readonly feedbackText?: string;
  readonly referencedTagIds: readonly string[];
  readonly target?: WorkbenchFeedbackTarget;
  /** Execution-level issues (schema 2 snapshots). */
  readonly issues?: readonly WorkbenchHandoffIssue[];
  /** Full geometry of the image annotations at publish time. */
  readonly imageAnnotations?: readonly WorkbenchSpatialAnnotation[];
  /** Full video markers (PTS, optional frame index, nested annotations). */
  readonly videoMarkers?: readonly WorkbenchVideoMarker[];
  /** Explicit clock for video marker times; absence on legacy snapshots means unspecified. */
  readonly videoTimeBasis?: "browser-current-time";
  /** Content revisions frozen at publish time. */
  readonly revisions?: readonly WorkbenchContentRevision[];
  /** Provenance tags frozen at publish time (names/versions never re-resolve). */
  readonly provenanceTags?: readonly WorkbenchProvenanceTag[];
  /** Text decision: the exact revised text the human produced/approved. */
  readonly text?: { readonly entryId: string; readonly text: string };
  /** Data decision: the explicit cell patches that were applied. */
  readonly dataPatches?: readonly WorkbenchDataPatch[];
  /** Image/video decision: the media this decision applies to. */
  readonly mediaId?: string;
  readonly derivedMediaId?: string;
  readonly resourceId?: string;
}

export interface WorkbenchHandoff {
  /** Restored/migrated snapshots are evidence; they cannot resume external tasks. */
  readonly historicalOnly?: true;
  readonly handoffId: string;
  /** Stable idempotency key; publishing the same key twice returns the same handoff. */
  readonly idempotencyKey: string;
  readonly batchId: string;
  readonly batchName: string;
  readonly publishedAt: number;
  readonly deliveryState: "published_waiting" | "agent_acked" | "rework_returned";
  /** 2 = execution-level snapshot; absent on legacy snapshots (schema 1). */
  readonly snapshotSchemaVersion?: number;
  /** Previous handoff of the SAME batch that this publication supersedes. */
  readonly supersedesHandoffId?: string;
  /** Items of this handoff whose rework has already been returned. */
  readonly returnedItemIds?: readonly string[];
  readonly items: readonly WorkbenchHandoffItem[];
}

export interface WorkbenchProjectState {
  readonly schemaVersion: 1;
  readonly batches: readonly WorkbenchBatch[];
  readonly items: readonly WorkbenchItem[];
  readonly feedback: readonly WorkbenchFeedback[];
  readonly handoffs: readonly WorkbenchHandoff[];
}

export const WORKBENCH_MAX_ITEMS_PER_BATCH = 500;
export const WORKBENCH_MAX_BATCHES = 50;
export const WORKBENCH_MAX_TEXT_LENGTH = 200_000;
export const WORKBENCH_MAX_ROWS_PER_DATASET = 5_000;
export const WORKBENCH_MAX_FEEDBACK_PER_ITEM = 100;

export function emptyWorkbenchState(): WorkbenchProjectState {
  return {
    schemaVersion: 1,
    batches: [],
    items: [],
    feedback: [],
    handoffs: [],
  };
}

/** Current text of a text item (last version entry). */
export function currentWorkbenchText(
  content: WorkbenchTextContent,
): WorkbenchTextVersion {
  const latest = content.versions[content.versions.length - 1];
  if (!latest) {
    throw new Error(`Text entry ${content.entryId} has no versions`);
  }
  return latest;
}

/** Deterministic short hash (FNV-1a variants) for over-long composite ids. */
function workbenchStableHash(input: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    a ^= code;
    a = Math.imul(a, 0x01000193) >>> 0;
    b ^= code + index;
    b = Math.imul(b, 0x85ebca6b) >>> 0;
  }
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}

/**
 * Stable identity key for a feedback target (never a display string). The
 * data-cell key length-prefixes the row id so `(a-b, c)` and `(a, b-c)` cannot
 * collide. Shared by the GUI identity helpers and handoff snapshots.
 */
export function workbenchFeedbackTargetKey(
  target: WorkbenchFeedbackTarget | undefined,
): string | null {
  if (!target) return null;
  switch (target.kind) {
    case "model-view":
      return `model-${target.observationId}`;
    case "pixel-region":
      return `ann-${target.annotationId}`;
    case "video-marker":
      return `marker-${target.markerId}`;
    case "data-cell":
      return `cell-${target.rowId.length}:${target.rowId}:${target.columnId}`;
    case "text-range":
      return `range-${target.entryId}-v${target.version}-${target.startOffset}-${target.endOffset}`;
    case "whole-item":
      return "item";
  }
}

/** Deterministic, length-safe feedback id for one item version + target key. */
export function workbenchFeedbackId(
  itemId: string,
  itemVersion: number,
  targetKey: string,
): string {
  // Independent review items use UUID namespaces; retain the old identity for legacy short IDs.
  if (isUuid(itemId)) return uuidv5(`${itemVersion}:${targetKey}`, itemId);
  const readable = `fb-${itemId}-v${itemVersion}-${targetKey}`;
  if (readable.length <= 200) return readable;
  return `fb-${workbenchStableHash(`${itemId}|${itemVersion}|${targetKey}`)}`;
}

/** Stable issue id derived from the structured target (C2 contract). */
export function workbenchFeedbackIssueId(target: WorkbenchFeedbackTarget): string {
  return workbenchFeedbackTargetKey(target) ?? "item";
}

/**
 * Whether a rework feedback is an ACTIVE todo for the item's current version:
 * confirmed, explicit rework intent, not cleared, and bound to the current
 * version (a new content version expires older badges but keeps the history).
 */
export function isActiveReworkFeedback(
  feedback: WorkbenchFeedback,
  currentItemVersion: number,
): boolean {
  return (
    feedback.intent === "rework" &&
    feedback.state === "confirmed" &&
    feedback.clearedAt === undefined &&
    feedback.itemVersion === currentItemVersion
  );
}


/** Items of one batch in stable order. */
export function workbenchBatchItems(
  state: WorkbenchProjectState,
  batchId: string,
): readonly WorkbenchItem[] {
  const order = new Map(state.batches.find((b) => b.id === batchId)?.itemIds.map((id, i) => [id, i]) ?? []);
  return state.items
    .filter((item) => item.batchId === batchId)
    .sort((a, b) => (order.get(a.id) ?? a.orderIndex) - (order.get(b.id) ?? b.orderIndex));
}

/** Exact source reference, shared by versions, export and resource retention. */
export function workbenchContentResourceId(content: WorkbenchItemContent): string | undefined {
  if (content.type === "model3d") return content.resourceId;
  if (content.type === "image" || content.type === "video") return content.mediaId;
  return undefined;
}
