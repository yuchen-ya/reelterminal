import { isModelObservation } from "../review/model-observation";
import { v4 as uuidv4 } from "uuid";
import { validWorkbenchPlacement } from "../review/placement";
import type { Action } from "../types/actions";
import type {
  WorkbenchBatch,
  WorkbenchContentRevision,
  WorkbenchDecision,
  WorkbenchDecisionEntry,
  WorkbenchFeedback,
  WorkbenchFeedbackTarget,
  WorkbenchHandoff,
  WorkbenchHandoffIssue,
  WorkbenchHandoffItem,
  WorkbenchHandoffReferencedTag,
  WorkbenchItem,
  WorkbenchItemContent,
  WorkbenchProjectState,
  WorkbenchRepairBase,
  WorkbenchDataPatch,
  WorkbenchPixelStroke,
  WorkbenchSpatialAnnotation,
  WorkbenchVideoMarker,
  WorkbenchAgentGuidance,
  WorkbenchLineage,
  WorkbenchProvenanceTag,
} from "../types/workbench";
import {
  WORKBENCH_MAX_BATCHES,
  WORKBENCH_MAX_FEEDBACK_PER_ITEM,
  WORKBENCH_MAX_ITEMS_PER_BATCH,
  emptyWorkbenchState,
  isActiveReworkFeedback,
  workbenchFeedbackId,
  workbenchFeedbackIssueId,
  workbenchFeedbackTargetKey,
} from "../types/workbench";

/**
 * Workbench actions. All state changes flow through these actions so GUI and
 * CLI share one execution path, and every mutation carries a `workbench/restore`
 * inverse with the exact previous entities (workbench state is small structured
 * data — media bytes are never inlined here), giving exact undo/redo.
 */

export interface WorkbenchRestoreParams {
  readonly batches?: readonly WorkbenchBatch[];
  readonly removeBatchIds?: readonly string[];
  readonly items?: readonly WorkbenchItem[];
  readonly removeItemIds?: readonly string[];
  readonly feedback?: readonly WorkbenchFeedback[];
  readonly removeFeedbackIds?: readonly string[];
  readonly handoffs?: readonly WorkbenchHandoff[];
  readonly removeHandoffIds?: readonly string[];
}

export interface WorkbenchIngestParams {
  /** Complete merged batch (caller builds create-or-append via ingestWorkbenchBatch). */
  readonly batch: WorkbenchBatch;
  /** Only the NEW items; existing items stay untouched. */
  readonly items: readonly WorkbenchItem[];
}

export interface WorkbenchDecideTarget {
  readonly itemId: string;
  readonly baseVersion: number;
  readonly decision: WorkbenchDecision;
  readonly decisionRevision: number;
  readonly decidedAt: number;
  readonly operator: "human" | "agent";
  /** Required when decision === "modified": a real revision must exist. */
  readonly contentRevisionId?: string;
}

export interface WorkbenchDecideParams {
  readonly batchId: string;
  readonly decisions: readonly WorkbenchDecideTarget[];
}

export interface WorkbenchContentUpdateParams {
  readonly revision: WorkbenchContentRevision;
}

export interface WorkbenchAnnotationsSetParams {
  readonly itemId: string;
  /** Positions are bound to this content version; mismatching is a conflict. */
  readonly itemVersion: number;
  readonly annotations?: readonly WorkbenchSpatialAnnotation[];
  readonly strokes?: readonly WorkbenchPixelStroke[];
  readonly markers?: readonly WorkbenchVideoMarker[];
}

export interface WorkbenchFeedbackSaveParams {
  readonly feedback: WorkbenchFeedback;
}

export interface WorkbenchRevertParams {
  readonly itemIds: readonly string[];
}

export interface WorkbenchTagsSetParams {
  readonly itemId: string;
  readonly tags: readonly string[];
}

export interface WorkbenchDuplicateDismissParams {
  readonly itemId: string;
}

export interface WorkbenchHandoffPublishParams {
  readonly handoff: WorkbenchHandoff;
}

export interface WorkbenchHandoffAckParams {
  readonly handoffId: string;
  readonly ackedAt: number;
}

export interface WorkbenchReworkResult {
  readonly sourceItemId: string;
  readonly previousVersion: number;
  readonly producedVersion: number;
  /** Full replacement content (new text version / dataset / media ref). */
  readonly content: WorkbenchItemContent;
  readonly agentGuidance?: WorkbenchAgentGuidance;
  readonly lineage?: WorkbenchLineage;
  readonly reworkSummary?: string;
}

export interface WorkbenchReworkIngestParams {
  readonly handoffId: string;
  readonly results: readonly WorkbenchReworkResult[];
}

/** Explicit cancellation of rework markers (acceptance uses content.update). */
export interface WorkbenchReworkClearParams {
  readonly itemId: string;
  readonly itemVersion: number;
  readonly cells: readonly { readonly rowId: string; readonly columnId: string }[];
  readonly clearedBy: "accepted" | "cancelled";
  readonly clearedAt: number;
}

export interface WorkbenchMarkDataReworkInput {
  readonly itemId: string;
  readonly itemVersion: number;
  readonly cells: readonly {
    readonly rowId: string;
    readonly columnId: string;
    readonly proposalId?: string;
  }[];
  readonly reason?: string;
}

class WorkbenchActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkbenchActionError";
  }
}

export interface WorkbenchStateHost {
  readonly workbench?: WorkbenchProjectState;
  readonly reviewMigration?: { readonly nodeId: string };
}

function wb(project: WorkbenchStateHost): WorkbenchProjectState {
  return project.workbench ?? emptyWorkbenchState();
}

function mutableWorkbench(project: WorkbenchStateHost): WorkbenchProjectState {
  const holder = project as { workbench?: WorkbenchProjectState };
  if (!holder.workbench) holder.workbench = emptyWorkbenchState();
  return holder.workbench;
}

function findItem(
  state: WorkbenchProjectState,
  itemId: string,
): WorkbenchItem | undefined {
  return state.items.find((item) => item.id === itemId);
}

function requireItem(
  state: WorkbenchProjectState,
  itemId: string,
): WorkbenchItem {
  const item = findItem(state, itemId);
  if (!item) {
    throw new WorkbenchActionError(`workbench: item "${itemId}" not found`);
  }
  return item;
}

/** Last decision revision recorded for an item (0 when undecided). */
export function workbenchItemDecisionRevision(item: WorkbenchItem): number {
  return item.decisionLog.length
    ? item.decisionLog[item.decisionLog.length - 1].decisionRevision
    : 0;
}

export function nextWorkbenchContentVersion(item: WorkbenchItem): number {
  return Math.max(item.version, item.versionCeiling ?? item.version) + 1;
}

function sanitizeText(text: unknown, label: string): string {
  if (typeof text !== "string") {
    throw new WorkbenchActionError(`workbench: ${label} must be a string`);
  }
  return text;
}

function validId(id: unknown, label: string): string {
  if (typeof id !== "string" || id.length === 0 || id.length > 200) {
    throw new WorkbenchActionError(`workbench: ${label} must be a non-empty id`);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateWorkbenchAction(
  action: Action,
  project: WorkbenchStateHost,
): { valid: boolean; errors: Array<{ code: string; message: string; path?: string }> } {
  if (project.reviewMigration) return { valid: false, errors: [{ code: "CONFLICT", message: "MIGRATED: this project workbench is a read-only backup; use its independent review node." }] };
  try {
    validateWorkbenchActionOrThrow(action, project);
    return { valid: true, errors: [] };
  } catch (error) {
    if (error instanceof WorkbenchActionError) {
      return {
        valid: false,
        errors: [{ code: "INVALID_PARAMS", message: error.message }],
      };
    }
    throw error;
  }
}

function validateWorkbenchActionOrThrow(action: Action, project: WorkbenchStateHost): void {
  const state = wb(project);
  switch (action.type) {
    case "workbench/ingest": {
      const params = action.params as unknown as WorkbenchIngestParams;
      const batch = params.batch;
      validId(batch?.id, "batch.id");
      if (typeof batch.name !== "string" || !batch.name.trim()) {
        throw new WorkbenchActionError("workbench: batch.name is required");
      }
      if (!Array.isArray(batch.itemIds) || !Array.isArray(params.items)) {
        throw new WorkbenchActionError("workbench: ingest items must be an array");
      }
      if (params.items.length > WORKBENCH_MAX_ITEMS_PER_BATCH) {
        throw new WorkbenchActionError(
          `workbench: batch exceeds ${WORKBENCH_MAX_ITEMS_PER_BATCH} items`,
        );
      }
      const existing = state.batches.find((b) => b.id === batch.id);
      if (existing && existing.itemIds.length + params.items.length > WORKBENCH_MAX_ITEMS_PER_BATCH) {
        throw new WorkbenchActionError(
          `workbench: batch append exceeds ${WORKBENCH_MAX_ITEMS_PER_BATCH} items`,
        );
      }
      if (!existing && state.batches.length >= WORKBENCH_MAX_BATCHES) {
        throw new WorkbenchActionError(
          `workbench: project already has ${WORKBENCH_MAX_BATCHES} batches`,
        );
      }
      const seen = new Set<string>();
      for (const item of params.items) {
        validId(item?.id, "item.id");
        if (seen.has(item.id)) {
          throw new WorkbenchActionError(`workbench: duplicate new item id "${item.id}"`);
        }
        seen.add(item.id);
        if (item.batchId !== batch.id) {
          throw new WorkbenchActionError(
            `workbench: item "${item.id}" references batch ${item.batchId}, expected ${batch.id}`,
          );
        }
        if (item.version < 1) {
          throw new WorkbenchActionError(`workbench: item "${item.id}" version must be >= 1`);
        }
        validateItemContent(item);
        const conflict = findItem(state, item.id);
        if (conflict) {
          // Idempotent re-ingest of the identical item version is a no-op the
          // builder filters out; reaching here means a reused id with a
          // different version, which is an identity violation.
          throw new WorkbenchActionError(
            `workbench: item id "${item.id}" already exists (version ${conflict.version}); ids are never reused`,
          );
        }
        if (!existing && !batch.itemIds.includes(item.id)) {
          throw new WorkbenchActionError(
            `workbench: new batch is missing member item "${item.id}"`,
          );
        }
      }
      if (existing) {
        for (const id of existing.itemIds) {
          if (!batch.itemIds.includes(id)) {
            throw new WorkbenchActionError(
              `workbench: ingest cannot remove existing member "${id}"`,
            );
          }
        }
      }
      break;
    }
    case "workbench/decide": {
      const params = action.params as unknown as WorkbenchDecideParams;
      if (!Array.isArray(params.decisions) || params.decisions.length === 0) {
        throw new WorkbenchActionError("workbench: decide requires decisions");
      }
      const seen = new Set<string>();
      for (const entry of params.decisions) {
        validId(entry?.itemId, "decisions[].itemId");
        if (seen.has(entry.itemId)) {
          throw new WorkbenchActionError(`workbench: duplicate decision target "${entry.itemId}"`);
        }
        seen.add(entry.itemId);
        const item = requireItem(state, entry.itemId);
        if (item.batchId !== params.batchId) {
          throw new WorkbenchActionError(
            `workbench: item "${entry.itemId}" does not belong to batch ${params.batchId}`,
          );
        }
        if (item.version !== entry.baseVersion) {
          throw new WorkbenchActionError(
            `workbench: item "${entry.itemId}" is at version ${item.version}, decision targets ${entry.baseVersion}`,
          );
        }
        if (entry.decision === "modified") {
          if (!entry.contentRevisionId) {
            throw new WorkbenchActionError(
              `workbench: modified decision for "${entry.itemId}" requires a content revision (no real change, no modified status)`,
            );
          }
          if (!item.revisions.some((r) => r.id === entry.contentRevisionId)) {
            throw new WorkbenchActionError(
              `workbench: content revision ${entry.contentRevisionId} not found on item "${entry.itemId}"`,
            );
          }
        }
        if (entry.decisionRevision !== workbenchItemDecisionRevision(item) + 1) {
          throw new WorkbenchActionError(
            `workbench: decision revision for "${entry.itemId}" must be ${workbenchItemDecisionRevision(item) + 1}`,
          );
        }
      }
      break;
    }
    case "workbench/content.update": {
      const params = action.params as unknown as WorkbenchContentUpdateParams;
      const revision = params.revision;
      validId(revision?.itemId, "revision.itemId");
      const item = requireItem(state, revision.itemId);
      if (item.version !== revision.parentVersion) {
        throw new WorkbenchActionError(
          `workbench: item "${item.id}" is at version ${item.version}, revision parents ${revision.parentVersion} (concurrent edit)`,
        );
      }
      if (revision.producedVersion !== nextWorkbenchContentVersion(item)) {
        throw new WorkbenchActionError(
          `workbench: revision must produce version ${nextWorkbenchContentVersion(item)}`,
        );
      }
      if (item.revisions.some((r) => r.id === revision.id)) {
        throw new WorkbenchActionError(`workbench: revision id "${revision.id}" already exists`);
      }
      switch (revision.kind) {
        case "text": {
          if (item.content.type !== "text" || !revision.text) {
            throw new WorkbenchActionError("workbench: text revision on a non-text item");
          }
          sanitizeText(revision.text.text, "revision.text.text");
          break;
        }
        case "data": {
          if (item.content.type !== "data" || !revision.data || !Array.isArray(revision.data.patches)) {
            throw new WorkbenchActionError("workbench: data revision on a non-data item");
          }
          validateDataPatches(item.content, revision.data.patches);
          break;
        }
        case "image-repair": {
          if (item.content.type !== "image" || !revision.mediaId) {
            throw new WorkbenchActionError("workbench: image repair requires derived media");
          }
          break;
        }
        default:
          throw new WorkbenchActionError(`workbench: revision kind "${revision.kind}" not valid here`);
      }
      break;
    }
    case "workbench/annotations.set": {
      const params = action.params as unknown as WorkbenchAnnotationsSetParams;
      const item = requireItem(state, validId(params.itemId, "itemId"));
      if (item.version !== params.itemVersion) {
        throw new WorkbenchActionError(
          `workbench: annotations target version ${params.itemVersion} but item is at ${item.version}`,
        );
      }
      if (params.annotations !== undefined && item.type !== "image") {
        throw new WorkbenchActionError("workbench: spatial annotations are image-only");
      }
      if (params.strokes !== undefined && item.type !== "image") {
        throw new WorkbenchActionError("workbench: pixel strokes are image-only");
      }
      if (params.markers !== undefined && item.type !== "video") {
        throw new WorkbenchActionError("workbench: video markers are video-only");
      }
      break;
    }
    case "workbench/feedback.save": {
      const params = action.params as unknown as WorkbenchFeedbackSaveParams;
      const feedback = params.feedback;
      validId(feedback?.id, "feedback.id");
      validId(feedback?.itemId, "feedback.itemId");
      if (!Number.isInteger(feedback.itemVersion) || feedback.itemVersion < 1) {
        throw new WorkbenchActionError("workbench: feedback.itemVersion must be a positive integer");
      }
      if (feedback.state !== "draft" && feedback.state !== "confirmed") {
        throw new WorkbenchActionError("workbench: feedback.state must be draft or confirmed");
      }
      if (!Array.isArray(feedback.referencedTagIds)) {
        throw new WorkbenchActionError("workbench: feedback.referencedTagIds must be an array");
      }
      for (const tagId of feedback.referencedTagIds) {
        if (typeof tagId !== "string" || tagId.length === 0) {
          throw new WorkbenchActionError(
            "workbench: feedback.referencedTagIds must contain non-empty strings",
          );
        }
      }
      const item = requireItem(state, feedback.itemId);
      const itemFeedback = state.feedback.filter((f) => f.itemId === feedback.itemId);
      // IDs are globally unique in the persisted store, so ownership must be
      // resolved globally. Filtering by itemId first would hide a same-id
      // record owned by another item and let apply() move/overwrite it.
      const replacing = state.feedback.find((f) => f.id === feedback.id);
      if (replacing) {
        // Version is part of feedback identity; replacing a record may never
        // move it to another item or rewrite a different version's opinion.
        if (replacing.itemId !== feedback.itemId) {
          throw new WorkbenchActionError("workbench: feedback id belongs to another item");
        }
        if (replacing.itemVersion !== feedback.itemVersion) {
          throw new WorkbenchActionError(
            `workbench: feedback id belongs to version ${replacing.itemVersion}, not ${feedback.itemVersion}`,
          );
        }
      } else if (itemFeedback.length >= WORKBENCH_MAX_FEEDBACK_PER_ITEM) {
        throw new WorkbenchActionError(
          `workbench: item "${feedback.itemId}" already has ${WORKBENCH_MAX_FEEDBACK_PER_ITEM} feedback records`,
        );
      }
      if (!replacing && feedback.itemVersion !== item.version) {
        throw new WorkbenchActionError(
          `workbench: feedback targets version ${feedback.itemVersion} but item is at ${item.version}`,
        );
      }
      if (feedback.intent !== undefined && feedback.intent !== "note" && feedback.intent !== "rework") {
        throw new WorkbenchActionError('workbench: feedback.intent must be "note" or "rework"');
      }
      if (feedback.clearedBy !== undefined && feedback.clearedBy !== "accepted" && feedback.clearedBy !== "cancelled") {
        throw new WorkbenchActionError(
          'workbench: feedback.clearedBy must be "accepted" or "cancelled"',
        );
      }
      if (feedback.clearedBy !== undefined && !Number.isFinite(feedback.clearedAt)) {
        throw new WorkbenchActionError("workbench: cleared feedback requires clearedAt");
      }
      validateFeedbackTarget(state, item, feedback);
      sanitizeText(feedback.text, "feedback.text");
      break;
    }
    case "workbench/revert": {
      const params = action.params as unknown as WorkbenchRevertParams;
      if (!Array.isArray(params.itemIds) || params.itemIds.length === 0) {
        throw new WorkbenchActionError("workbench: revert requires itemIds");
      }
      for (const id of params.itemIds) {
        requireItem(state, id);
      }
      break;
    }
    case "workbench/tags.set": {
      const params = action.params as unknown as WorkbenchTagsSetParams;
      const item = requireItem(state, validId(params.itemId, "itemId"));
      void item;
      if (!Array.isArray(params.tags) || params.tags.some((t) => typeof t !== "string")) {
        throw new WorkbenchActionError("workbench: tags must be string[]");
      }
      break;
    }
    case "workbench/duplicateProposal.dismiss": {
      const params = action.params as unknown as WorkbenchDuplicateDismissParams;
      const item = requireItem(state, validId(params.itemId, "itemId"));
      if (item.content.type !== "text" || !item.content.duplicateProposal) {
        throw new WorkbenchActionError(
          `workbench: item "${item.id}" has no duplicate proposal to dismiss`,
        );
      }
      break;
    }
    case "workbench/handoff.publish": {
      const params = action.params as unknown as WorkbenchHandoffPublishParams;
      const handoff = params.handoff;
      validId(handoff?.handoffId, "handoff.handoffId");
      if (typeof handoff.idempotencyKey !== "string" || handoff.idempotencyKey.length < 4) {
        throw new WorkbenchActionError("workbench: handoff requires an idempotency key");
      }
      if (state.handoffs.some((h) => h.idempotencyKey === handoff.idempotencyKey)) {
        throw new WorkbenchActionError(
          `workbench: idempotency key already published as ${state.handoffs.find((h) => h.idempotencyKey === handoff.idempotencyKey)?.handoffId}`,
        );
      }
      const batch = state.batches.find((b) => b.id === handoff.batchId);
      if (!batch) {
        throw new WorkbenchActionError(`workbench: batch "${handoff.batchId}" not found`);
      }
      if (!Array.isArray(handoff.items) || handoff.items.length === 0) {
        throw new WorkbenchActionError("workbench: handoff requires decided items");
      }
      if (handoff.snapshotSchemaVersion !== undefined && handoff.snapshotSchemaVersion !== 2) {
        throw new WorkbenchActionError(
          `workbench: unsupported handoff snapshot schema ${handoff.snapshotSchemaVersion}`,
        );
      }
      for (const entry of handoff.items) {
        const item = requireItem(state, entry.itemId);
        if (item.batchId !== handoff.batchId) {
          throw new WorkbenchActionError(
            `workbench: handoff item "${entry.itemId}" is from another batch`,
          );
        }
        if (item.version !== entry.itemVersion) {
          throw new WorkbenchActionError(
            `workbench: handoff item "${entry.itemId}" drifted (snapshot v${entry.itemVersion}, live v${item.version})`,
          );
        }
        if (item.status === "pending" || item.status !== entry.decision) {
          throw new WorkbenchActionError(
            `workbench: handoff item "${entry.itemId}" snapshot decision does not match live state`,
          );
        }
        if (workbenchItemDecisionRevision(item) !== entry.decisionRevision) {
          throw new WorkbenchActionError(
            `workbench: handoff item "${entry.itemId}" decision revision drifted`,
          );
        }
        if (item.content.type === "text" && entry.text) {
          const liveText = item.content.versions[item.content.versions.length - 1];
          if (
            liveText.version !== item.version ||
            entry.text.text !== liveText.text ||
            entry.text.entryId !== item.content.entryId
          ) {
            throw new WorkbenchActionError(
              `workbench: handoff text for "${entry.itemId}" is not the current version's text`,
            );
          }
        }
        if (entry.derivedMediaId) {
          const repair = [...item.revisions]
            .reverse()
            .find((revision) => revision.kind === "image-repair" && revision.mediaId);
          if (repair?.mediaId !== entry.derivedMediaId) {
            throw new WorkbenchActionError(
              `workbench: handoff derived media for "${entry.itemId}" is not the latest repair`,
            );
          }
        }
        // Frozen geometry/revisions/tags must be the current item's real data,
        // not a caller-invented execution contract.
        if (
          entry.imageAnnotations !== undefined &&
          (item.content.type !== "image" ||
            JSON.stringify(entry.imageAnnotations) !==
              JSON.stringify(item.content.annotations))
        ) {
          throw new WorkbenchActionError(
            `workbench: handoff image annotations for "${entry.itemId}" do not match live content`,
          );
        }
        if (
          entry.videoMarkers !== undefined &&
          (item.content.type !== "video" ||
            JSON.stringify(entry.videoMarkers) !== JSON.stringify(item.content.markers))
        ) {
          throw new WorkbenchActionError(
            `workbench: handoff video markers for "${entry.itemId}" do not match live content`,
          );
        }
        if (
          entry.revisions !== undefined &&
          JSON.stringify(entry.revisions) !== JSON.stringify(item.revisions)
        ) {
          throw new WorkbenchActionError(
            `workbench: handoff revisions for "${entry.itemId}" do not match live content`,
          );
        }
        if (
          entry.provenanceTags !== undefined &&
          JSON.stringify(entry.provenanceTags) !== JSON.stringify(item.provenanceTags)
        ) {
          throw new WorkbenchActionError(
            `workbench: handoff provenance tags for "${entry.itemId}" do not match live content`,
          );
        }
        // Execution-level issues must reference real confirmed feedback of the
        // SAME snapshotted version; a handoff can never invent an issue.
        for (const issue of entry.issues ?? []) {
          const record = state.feedback.find((candidate) => candidate.id === issue.feedbackId);
          if (!record) {
            throw new WorkbenchActionError(
              `workbench: handoff issue "${issue.feedbackId}" does not exist`,
            );
          }
          if (
            record.itemId !== entry.itemId ||
            record.itemVersion !== entry.itemVersion ||
            record.state !== "confirmed" ||
            record.clearedAt !== undefined
          ) {
            throw new WorkbenchActionError(
              `workbench: handoff issue "${issue.feedbackId}" is not confirmed feedback of this version`,
            );
          }
          if (
            issue.issueId !==
            workbenchFeedbackIssueId(record.target ?? { kind: "whole-item" })
          ) {
            throw new WorkbenchActionError(
              `workbench: handoff issue "${issue.feedbackId}" has a mismatched issue id`,
            );
          }
          // The frozen issue must echo the record exactly; a snapshot may not
          // invent a different target/text/tag list for the same feedback id.
          const recordTarget = record.target ?? { kind: "whole-item" as const };
          if (JSON.stringify(issue.target) !== JSON.stringify(recordTarget)) {
            throw new WorkbenchActionError(
              `workbench: handoff issue "${issue.feedbackId}" target does not match the feedback record`,
            );
          }
          if (
            issue.state !== "confirmed" ||
            issue.itemVersion !== record.itemVersion ||
            issue.intent !== (record.intent ?? "note") ||
            issue.text !== record.text ||
            issue.createdAt !== record.createdAt ||
            issue.updatedAt !== record.updatedAt
          ) {
            throw new WorkbenchActionError(
              `workbench: handoff issue "${issue.feedbackId}" does not match the feedback record`,
            );
          }
          if (
            issue.referencedTags.length !== record.referencedTagIds.length ||
            issue.referencedTags.some(
              (tag: WorkbenchHandoffReferencedTag, index: number) =>
                tag.id !== record.referencedTagIds[index],
            )
          ) {
            throw new WorkbenchActionError(
              `workbench: handoff issue "${issue.feedbackId}" references drifted from the feedback record`,
            );
          }
        }
      }
      if (handoff.supersedesHandoffId) {
        const prev = state.handoffs.find((h) => h.handoffId === handoff.supersedesHandoffId);
        if (!prev) {
          throw new WorkbenchActionError("workbench: supersedes target not found");
        }
        if (prev.batchId !== handoff.batchId) {
          throw new WorkbenchActionError(
            "workbench: supersedes must reference a handoff of the same batch",
          );
        }
      }
      break;
    }
    case "workbench/handoff.ack": {
      const params = action.params as unknown as WorkbenchHandoffAckParams;
      const handoff = state.handoffs.find((h) => h.handoffId === validId(params.handoffId, "handoffId"));
      if (!handoff) {
        throw new WorkbenchActionError(`workbench: handoff "${params.handoffId}" not found`);
      }
      if (handoff.historicalOnly) throw new WorkbenchActionError("workbench: restored historical handoffs cannot resume external tasks");
      if (handoff.deliveryState !== "published_waiting") {
        throw new WorkbenchActionError(
          `workbench: handoff "${params.handoffId}" is already ${handoff.deliveryState}`,
        );
      }
      break;
    }
    case "workbench/rework.clear": {
      const params = action.params as unknown as WorkbenchReworkClearParams;
      const item = requireItem(state, validId(params.itemId, "itemId"));
      if (item.version !== params.itemVersion) {
        throw new WorkbenchActionError(
          `workbench: rework clear targets version ${params.itemVersion} but item is at ${item.version}`,
        );
      }
      if (item.content.type !== "data") {
        throw new WorkbenchActionError("workbench: rework clear is data-cell only");
      }
      if (params.clearedBy !== "cancelled" && params.clearedBy !== "accepted") {
        throw new WorkbenchActionError("workbench: rework clear requires a clearedBy reason");
      }
      if (!Array.isArray(params.cells) || params.cells.length === 0) {
        throw new WorkbenchActionError("workbench: rework clear requires cells");
      }
      const seen = new Set<string>();
      for (const cell of params.cells) {
        const key = `${cell.rowId}\u0000${cell.columnId}`;
        if (seen.has(key)) {
          throw new WorkbenchActionError("workbench: duplicate rework clear cell");
        }
        seen.add(key);
        if (!item.content.columns.some((column) => column.columnId === cell.columnId)) {
          throw new WorkbenchActionError(`workbench: rework clear column "${cell.columnId}" not found`);
        }
        if (!item.content.rows.some((row) => row.rowId === cell.rowId)) {
          throw new WorkbenchActionError(`workbench: rework clear row "${cell.rowId}" not found`);
        }
        const active = state.feedback.some(
          (record) =>
            record.itemId === item.id &&
            record.itemVersion === item.version &&
            record.target?.kind === "data-cell" &&
            record.target.rowId === cell.rowId &&
            record.target.columnId === cell.columnId &&
            isActiveReworkFeedback(record, item.version),
        );
        if (!active) {
          throw new WorkbenchActionError(
            `workbench: cell ${cell.rowId}:${cell.columnId} has no active rework marker`,
          );
        }
      }
      break;
    }
    case "workbench/rework.ingest": {
      const params = action.params as unknown as WorkbenchReworkIngestParams;
      const handoff = state.handoffs.find((h) => h.handoffId === validId(params.handoffId, "handoffId"));
      if (!handoff) {
        throw new WorkbenchActionError(`workbench: handoff "${params.handoffId}" not found`);
      }
      if (handoff.historicalOnly) throw new WorkbenchActionError("workbench: restored historical handoffs cannot receive rework; publish a new snapshot");
      if (!Array.isArray(params.results) || params.results.length === 0) {
        throw new WorkbenchActionError("workbench: rework requires results");
      }
      const reworkIds = new Set(
        handoff.items.filter((i) => i.decision === "rework").map((i) => i.itemId),
      );
      const returned = new Set(handoff.returnedItemIds ?? []);
      const seenResults = new Set<string>();
      for (const result of params.results) {
        const item = requireItem(state, validId(result.sourceItemId, "results[].sourceItemId"));
        if (seenResults.has(item.id)) {
          throw new WorkbenchActionError(`workbench: duplicate rework result for "${item.id}"`);
        }
        seenResults.add(item.id);
        if (item.batchId !== handoff.batchId) {
          throw new WorkbenchActionError(
            `workbench: rework item "${item.id}" is from another batch`,
          );
        }
        const handoffItem = handoff.items.find((entry) => entry.itemId === item.id);
        if (!handoffItem) {
          throw new WorkbenchActionError(
            `workbench: item "${item.id}" is not part of ${handoff.handoffId}`,
          );
        }
        if (!reworkIds.has(item.id) || handoffItem.decision !== "rework") {
          throw new WorkbenchActionError(
            `workbench: item "${item.id}" was not marked rework in ${handoff.handoffId}; confirmed items are not reopened`,
          );
        }
        if (returned.has(item.id)) {
          throw new WorkbenchActionError(
            `workbench: rework for "${item.id}" was already returned by ${handoff.handoffId}`,
          );
        }
        if (handoffItem.itemVersion !== result.previousVersion) {
          throw new WorkbenchActionError(
            `workbench: rework for "${item.id}" parents v${result.previousVersion} but ${handoff.handoffId} snapshotted v${handoffItem.itemVersion}`,
          );
        }
        if (item.version !== result.previousVersion) {
          throw new WorkbenchActionError(
            `workbench: rework for "${item.id}" parents v${result.previousVersion} but live is v${item.version} (human revision wins; no overwrite)`,
          );
        }
        // A published task is executable only while the human's decision and
        // retrieval state still match the snapshot.
        if (item.status !== "rework") {
          throw new WorkbenchActionError(
            `workbench: item "${item.id}" is ${item.status}, not the published rework task (retrieved or re-decided)`,
          );
        }
        if (workbenchItemDecisionRevision(item) !== handoffItem.decisionRevision) {
          throw new WorkbenchActionError(
            `workbench: rework for "${item.id}" targets decision revision ${handoffItem.decisionRevision} but live is ${workbenchItemDecisionRevision(item)} (decision changed)`,
          );
        }
        if (isHandoffItemSuperseded(state, handoff, item.id)) {
          throw new WorkbenchActionError(
            `workbench: rework for "${item.id}" belongs to a handoff superseded for this item`,
          );
        }
        if (result.producedVersion !== nextWorkbenchContentVersion(item)) {
          throw new WorkbenchActionError(
            `workbench: rework must produce version ${nextWorkbenchContentVersion(item)}`,
          );
        }
        validateReworkContent(item, result);
      }
      break;
    }
    case "workbench/restore": {
      const params = action.params as unknown as WorkbenchRestoreParams;
      if (
        !Array.isArray(params?.items ?? []) ||
        !Array.isArray(params?.feedback ?? []) ||
        !Array.isArray(params?.handoffs ?? [])
      ) {
        throw new WorkbenchActionError("workbench: restore params malformed");
      }
      for (const item of params.items ?? []) if (item.placement !== undefined && !validWorkbenchPlacement(item.placement)) throw new WorkbenchActionError("workbench: invalid item placement");
      break;
    }
    default:
      throw new WorkbenchActionError(`workbench: unknown action type "${action.type}"`);
  }
}

function validateItemContent(item: WorkbenchItem): void {
  if (item.placement !== undefined && !validWorkbenchPlacement(item.placement)) throw new WorkbenchActionError("workbench: invalid item placement");
  for (const mode of [item.groupMode, item.lineage?.groupMode]) {
    if (mode !== undefined && mode !== "board" && mode !== "category") {
      throw new WorkbenchActionError("workbench: groupMode must be board or category");
    }
  }
  for (const id of [item.compareWithItemId, item.videoPayload?.compareWithItemId]) {
    if (id !== undefined && (typeof id !== "string" || id.trim().length === 0)) {
      throw new WorkbenchActionError("workbench: compareWithItemId must be a non-empty string");
    }
  }
  const content = item.content;
  if (!content || typeof content !== "object") {
    throw new WorkbenchActionError(`workbench: item "${item.id}" has no content`);
  }
  if (content.type !== item.type) {
    throw new WorkbenchActionError(
      `workbench: item "${item.id}" type ${item.type} does not match content type ${content.type}`,
    );
  }
  if (content.type === "text") {
    if (!Array.isArray(content.versions) || content.versions.length === 0) {
      throw new WorkbenchActionError(`workbench: text item "${item.id}" needs versions`);
    }
    if (content.versions[content.versions.length - 1].version !== item.version) {
      throw new WorkbenchActionError(
        `workbench: text item "${item.id}" version ${item.version} does not match last text version`,
      );
    }
    for (const version of content.versions) {
      sanitizeText(version.text, `text version of "${item.id}"`);
    }
  }
  if (content.type === "model3d") validId(content.resourceId, "model resourceId");
  if ((content.type === "image" || content.type === "video") && typeof content.mediaId !== "string") {
    throw new WorkbenchActionError(`workbench: ${content.type} item "${item.id}" requires mediaId`);
  }
  if (content.type === "data") {
    if (!Array.isArray(content.rows) || !Array.isArray(content.columns)) {
      throw new WorkbenchActionError(`workbench: data item "${item.id}" needs rows and columns`);
    }
    for (const row of content.rows) {
      validId(row.rowId, "rowId");
    }
    for (const column of content.columns) {
      validId(column.columnId, "columnId");
    }
  }
}

function validateDataPatches(
  content: WorkbenchItemContent & { type: "data" },
  patches: readonly WorkbenchDataPatch[],
): void {
  const rowIds = new Set(content.rows.map((r) => r.rowId));
  const columnIds = new Set(content.columns.map((c) => c.columnId));
  const proposals = new Map(content.proposals.map((p) => [p.proposalId, p]));
  for (const patch of patches) {
    if (!rowIds.has(patch.rowId)) {
      throw new WorkbenchActionError(`workbench: patch row "${patch.rowId}" not found`);
    }
    if (!columnIds.has(patch.columnId)) {
      throw new WorkbenchActionError(`workbench: patch column "${patch.columnId}" not found`);
    }
    if (patch.value !== undefined && patch.value !== null && typeof patch.value !== "string") {
      throw new WorkbenchActionError("workbench: patch value must be string or null");
    }
    if (patch.value === undefined) {
      if (!patch.proposalId || !patch.proposalOutcome) {
        throw new WorkbenchActionError(
          "workbench: a patch without a value must resolve a proposal (proposalId + proposalOutcome)",
        );
      }
    }
    if (patch.proposalOutcome !== undefined && !patch.proposalId) {
      throw new WorkbenchActionError("workbench: proposalOutcome requires proposalId");
    }
    if (patch.proposalId) {
      const proposal = proposals.get(patch.proposalId);
      if (!proposal) {
        throw new WorkbenchActionError(`workbench: patch proposal "${patch.proposalId}" not found`);
      }
      // The proposal must actually own the addressed cell; a mismatched pair
      // would accept/reject one cell while writing another.
      if (proposal.rowId !== patch.rowId || proposal.columnId !== patch.columnId) {
        throw new WorkbenchActionError(
          `workbench: proposal "${patch.proposalId}" belongs to ${proposal.rowId}:${proposal.columnId}, not ${patch.rowId}:${patch.columnId}`,
        );
      }
      if (patch.proposalOutcome === "rejected" && patch.value !== undefined) {
        const row = content.rows.find((candidate) => candidate.rowId === patch.rowId);
        if ((row?.cells[patch.columnId] ?? null) !== patch.value) {
          throw new WorkbenchActionError(
            "workbench: rejecting a proposal must not change the cell value",
          );
        }
      }
    }
  }
}

/** Validate a structured feedback target against its item/version. */
function validateFeedbackTarget(
  _state: WorkbenchProjectState,
  item: WorkbenchItem,
  feedback: WorkbenchFeedback,
): void {
  const target = feedback.target;
  if (!target) return;
  const isCurrent = feedback.itemVersion === item.version;
  switch (target.kind) {
    case "model-view": {
      if (item.content.type !== "model3d" || (isCurrent && item.content.resourceId !== target.resourceId) || !isModelObservation(target.observation)) throw new WorkbenchActionError("workbench: invalid model observation target");
      validId(target.observationId, "observationId"); validId(target.resourceId, "resourceId"); validId(target.screenshotResourceId, "screenshotResourceId");
      break;
    }
    case "pixel-region": {
      if (item.content.type !== "image") {
        throw new WorkbenchActionError("workbench: pixel-region feedback on a non-image item");
      }
      if (
        isCurrent &&
        !item.content.annotations.some((annotation) => annotation.id === target.annotationId)
      ) {
        throw new WorkbenchActionError(
          `workbench: annotation "${target.annotationId}" does not exist on the current image version`,
        );
      }
      return;
    }
    case "video-marker": {
      if (item.content.type !== "video") {
        throw new WorkbenchActionError("workbench: video-marker feedback on a non-video item");
      }
      if (
        isCurrent &&
        !item.content.markers.some((marker) => marker.id === target.markerId)
      ) {
        throw new WorkbenchActionError(
          `workbench: marker "${target.markerId}" does not exist on the current video version`,
        );
      }
      return;
    }
    case "data-cell": {
      if (item.content.type !== "data") {
        throw new WorkbenchActionError("workbench: data-cell feedback on a non-data item");
      }
      if (!isCurrent) return;
      if (!item.content.columns.some((column) => column.columnId === target.columnId)) {
        throw new WorkbenchActionError(
          `workbench: feedback column "${target.columnId}" not found`,
        );
      }
      if (!item.content.rows.some((row) => row.rowId === target.rowId)) {
        throw new WorkbenchActionError(`workbench: feedback row "${target.rowId}" not found`);
      }
      if (target.proposalId) {
        const proposal = item.content.proposals.find(
          (candidate) => candidate.proposalId === target.proposalId,
        );
        if (!proposal) {
          throw new WorkbenchActionError(
            `workbench: feedback proposal "${target.proposalId}" not found`,
          );
        }
        if (proposal.rowId !== target.rowId || proposal.columnId !== target.columnId) {
          throw new WorkbenchActionError(
            `workbench: feedback proposal "${target.proposalId}" does not belong to ${target.rowId}:${target.columnId}`,
          );
        }
      }
      return;
    }
    case "text-range": {
      if (item.content.type !== "text") {
        throw new WorkbenchActionError("workbench: text-range feedback on a non-text item");
      }
      if (target.entryId !== item.content.entryId) {
        throw new WorkbenchActionError("workbench: text-range feedback targets another entry");
      }
      const version = item.content.versions.find(
        (candidate) => candidate.version === target.version,
      );
      if (!version) {
        throw new WorkbenchActionError(
          `workbench: text-range version ${target.version} is not retained`,
        );
      }
      if (
        !Number.isInteger(target.startOffset) ||
        !Number.isInteger(target.endOffset) ||
        target.startOffset < 0 ||
        target.endOffset < target.startOffset ||
        target.endOffset > version.text.length
      ) {
        throw new WorkbenchActionError("workbench: text-range offsets are outside the text");
      }
      return;
    }
    case "whole-item":
      return;
  }
}

// ---------------------------------------------------------------------------
// Apply (mutates project.workbench)
// ---------------------------------------------------------------------------

export function applyWorkbenchAction(action: Action, project: WorkbenchStateHost): void {
  if (project.reviewMigration) throw new WorkbenchActionError("MIGRATED: this project workbench is a read-only backup");
  const state = mutableWorkbench(project);
  switch (action.type) {
    case "workbench/ingest": {
      const params = action.params as unknown as WorkbenchIngestParams;
      const items = [...state.items];
      for (const item of params.items) {
        items.push(structuredClone(item));
      }
      const batches = state.batches.some((b) => b.id === params.batch.id)
        ? state.batches.map((b) => (b.id === params.batch.id ? structuredClone(params.batch) : b))
        : [...state.batches, structuredClone(params.batch)];
      Object.assign(state, { items, batches });
      break;
    }
    case "workbench/decide": {
      const params = action.params as unknown as WorkbenchDecideParams;
      const items = state.items.map((item) => {
        const entry = params.decisions.find((d) => d.itemId === item.id);
        if (!entry) return item;
        const logEntry: WorkbenchDecisionEntry = {
          decision: entry.decision,
          decisionRevision: entry.decisionRevision,
          baseVersion: entry.baseVersion,
          decidedAt: entry.decidedAt,
          operator: entry.operator,
          ...(entry.contentRevisionId ? { contentRevisionId: entry.contentRevisionId } : {}),
        };
        return { ...item, status: entry.decision, decisionLog: [...item.decisionLog, logEntry] };
      });
      Object.assign(state, { items });
      break;
    }
    case "workbench/content.update": {
      const params = action.params as unknown as WorkbenchContentUpdateParams;
      const revision = structuredClone(params.revision);
      let feedback = state.feedback;
      const items = state.items.map((item) => {
        if (item.id !== revision.itemId) return item;
        let content: WorkbenchItemContent;
        if (item.content.type === "text" && revision.kind === "text" && revision.text) {
          content = {
            ...item.content,
            versions: [
              ...item.content.versions,
              {
                version: revision.producedVersion,
                text: revision.text.text,
                createdAt: revision.createdAt,
                origin: "human-revision",
                parentVersion: revision.parentVersion,
              },
            ],
          };
        } else if (item.content.type === "data" && revision.kind === "data" && revision.data) {
          const rows = item.content.rows.map((row) => {
            const next = { ...row.cells };
            for (const patch of revision.data!.patches) {
              // Proposal-only patches (reject/accept without a value edit) must
              // never rewrite the cell text.
              if (patch.rowId === row.rowId && patch.value !== undefined) {
                next[patch.columnId] = patch.value;
              }
            }
            return { ...row, cells: next };
          });
          const proposals = item.content.proposals.map((proposal) => {
            const patch = revision.data!.patches.find((p) => p.proposalId === proposal.proposalId);
            if (!patch?.proposalOutcome) return proposal;
            return { ...proposal, status: patch.proposalOutcome };
          });
          // Accepting/modifying a proposal resolves the rework marker of that
          // cell in the SAME commit, with an explicit reason for the history.
          const resolvedCells = revision.data.patches.filter(
            (patch) =>
              patch.proposalOutcome === "accepted" || patch.proposalOutcome === "modified",
          );
          if (resolvedCells.length > 0) {
            feedback = feedback.map((record) => {
              const target = record.target;
              if (
                record.itemId !== item.id ||
                record.itemVersion !== revision.parentVersion ||
                !isActiveReworkFeedback(record, revision.parentVersion) ||
                target?.kind !== "data-cell"
              ) {
                return record;
              }
              const resolved = resolvedCells.some(
                (patch) =>
                  patch.rowId === target.rowId &&
                  patch.columnId === target.columnId,
              );
              return resolved
                ? {
                    ...record,
                    clearedAt: revision.createdAt,
                    clearedBy: "accepted" as const,
                  }
                : record;
            });
          }
          // Data cells have stable row/column identity across a data revision,
          // so rework markers on OTHER cells stay actionable: migrate them to
          // the produced version instead of silently dropping a still-pending
          // task. The resolved cell above keeps its parent-version history.
          const producedColumns = new Set(
            item.content.columns.map((column) => column.columnId),
          );
          const producedRows = new Set(rows.map((row) => row.rowId));
          feedback = feedback.map((record) => {
            const target = record.target;
            if (
              record.itemId !== item.id ||
              record.itemVersion !== revision.parentVersion ||
              !isActiveReworkFeedback(record, revision.parentVersion) ||
              target?.kind !== "data-cell"
            ) {
              return record;
            }
            const resolved = resolvedCells.some(
              (patch) =>
                patch.rowId === target.rowId &&
                patch.columnId === target.columnId,
            );
            if (
              resolved ||
              !producedRows.has(target.rowId) ||
              !producedColumns.has(target.columnId)
            ) {
              return record;
            }
            const targetKey = workbenchFeedbackTargetKey(target) as string;
            return {
              ...record,
              id: workbenchFeedbackId(item.id, revision.producedVersion, targetKey),
              itemVersion: revision.producedVersion,
              updatedAt: revision.createdAt,
            };
          });
          content = { ...item.content, rows, proposals };
        } else if (item.content.type === "image" && revision.kind === "image-repair") {
          content = {
            ...item.content,
            strokes: revision.strokes ? [...revision.strokes] : item.content.strokes,
          };
        } else {
          throw new WorkbenchActionError(
            `workbench: revision kind ${revision.kind} does not fit item ${item.id}`,
          );
        }
        // A new content version expires older rework markers; an item must not
        // keep showing "rework" with no active marker left.
        const hasActiveRework = feedback.some(
          (record) =>
            record.itemId === item.id &&
            isActiveReworkFeedback(record, revision.producedVersion),
        );
        return {
          ...item,
          version: revision.producedVersion,
          content,
          status:
            item.status === "rework" && !hasActiveRework ? ("pending" as const) : item.status,
          revisions: [...item.revisions, revision],
        };
      });
      Object.assign(state, { items, feedback });
      break;
    }
    case "workbench/annotations.set": {
      const params = action.params as unknown as WorkbenchAnnotationsSetParams;
      const items = state.items.map((item) => {
        if (item.id !== params.itemId) return item;
        let content = item.content;
        if (params.annotations !== undefined && content.type === "image") {
          content = { ...content, annotations: structuredClone(params.annotations) };
        }
        if (params.strokes !== undefined && content.type === "image") {
          content = { ...content, strokes: structuredClone(params.strokes) };
        }
        if (params.markers !== undefined && content.type === "video") {
          content = { ...content, markers: structuredClone(params.markers) };
        }
        return { ...item, content };
      });
      Object.assign(state, { items });
      break;
    }    case "workbench/feedback.save": {
      const params = action.params as unknown as WorkbenchFeedbackSaveParams;
      const record = structuredClone(params.feedback);
      const exists = state.feedback.some((f) => f.id === record.id);
      const feedback = exists
        ? state.feedback.map((f) => (f.id === record.id ? record : f))
        : [...state.feedback, record];
      Object.assign(state, { feedback });
      break;
    }
    case "workbench/revert": {
      const params = action.params as unknown as WorkbenchRevertParams;
      const ids = new Set(params.itemIds);
      const items = state.items.map((item) =>
        ids.has(item.id) ? { ...item, status: "pending" as const } : item,
      );
      // Retrieve keeps revisions and drafts — confirmed feedback becomes draft again.
      const feedback = state.feedback.map((f) =>
        ids.has(f.itemId) && f.state === "confirmed" ? { ...f, state: "draft" as const } : f,
      );
      Object.assign(state, { items, feedback });
      break;
    }
    case "workbench/tags.set": {
      const params = action.params as unknown as WorkbenchTagsSetParams;
      const items = state.items.map((item) =>
        item.id === params.itemId ? { ...item, userTags: [...params.tags] } : item,
      );
      Object.assign(state, { items });
      break;
    }
    case "workbench/duplicateProposal.dismiss": {
      const params = action.params as unknown as WorkbenchDuplicateDismissParams;
      const items = state.items.map((item) => {
        if (item.id !== params.itemId || item.content.type !== "text") return item;
        if (!item.content.duplicateProposal) return item;
        return {
          ...item,
          content: {
            ...item.content,
            duplicateProposal: { ...item.content.duplicateProposal, dismissed: true },
          },
        };
      });
      Object.assign(state, { items });
      break;
    }
    case "workbench/handoff.publish": {
      const params = action.params as unknown as WorkbenchHandoffPublishParams;
      Object.assign(state, {
        handoffs: [structuredClone(params.handoff), ...state.handoffs],
      });
      break;
    }
    case "workbench/handoff.ack": {
      const params = action.params as unknown as WorkbenchHandoffAckParams;
      const handoffs = state.handoffs.map((h) =>
        h.handoffId === params.handoffId
          ? { ...h, deliveryState: "agent_acked" as const }
          : h,
      );
      Object.assign(state, { handoffs });
      break;
    }
    case "workbench/rework.clear": {
      const params = action.params as unknown as WorkbenchReworkClearParams;
      const keys = new Set(params.cells.map((cell) => `${cell.rowId}\u0000${cell.columnId}`));
      const feedback = state.feedback.map((record) => {
        if (
          record.itemId !== params.itemId ||
          record.itemVersion !== params.itemVersion ||
          !isActiveReworkFeedback(record, params.itemVersion) ||
          record.target?.kind !== "data-cell"
        ) {
          return record;
        }
        const key = `${record.target.rowId}\u0000${record.target.columnId}`;
        if (!keys.has(key)) return record;
        return {
          ...record,
          clearedAt: params.clearedAt,
          clearedBy: params.clearedBy,
        };
      });
      const items = state.items.map((item) => {
        if (item.id !== params.itemId) return item;
        if (item.status !== "rework") return item;
        const stillActive = feedback.some(
          (record) =>
            record.itemId === item.id &&
            isActiveReworkFeedback(record, item.version),
        );
        return stillActive ? item : { ...item, status: "pending" as const };
      });
      Object.assign(state, { items, feedback });
      break;
    }
    case "workbench/rework.ingest": {
      const params = action.params as unknown as WorkbenchReworkIngestParams;
      const results = new Map(params.results.map((result) => [result.sourceItemId, result]));
      const items = state.items.map((item) => {
        const result = results.get(item.id);
        if (!result) return item;
        const revision: WorkbenchContentRevision = {
          id: uuidv4(),
          itemId: item.id,
          parentVersion: result.previousVersion,
          producedVersion: result.producedVersion,
          createdAt: Date.now(),
          kind: "agent-rework",
          ...(item.content.type === "text" && result.content.type === "text"
            ? {
                text: {
                  entryId: result.content.entryId,
                  text: result.content.versions[result.content.versions.length - 1].text,
                },
              }
            : {}),
        };
        return {
          ...item,
          version: result.producedVersion,
          content: structuredClone(result.content),
          status: "pending" as const,
          decisionLog: [...item.decisionLog],
          revisions: [...item.revisions, revision],
          ...(result.agentGuidance ? { agentGuidance: result.agentGuidance } : {}),
          ...(result.lineage ? { lineage: result.lineage } : {}),
          reworkOrigin: {
            fromHandoffId: params.handoffId,
            previousVersion: result.previousVersion,
            ...(result.reworkSummary ? { summary: result.reworkSummary } : {}),
          },
        };
      });
      const handoffs = state.handoffs.map((handoff) => {
        if (handoff.handoffId !== params.handoffId) return handoff;
        const returned = new Set(handoff.returnedItemIds ?? []);
        const reworkIds = handoff.items
          .filter((entry) => entry.decision === "rework")
          .map((entry) => entry.itemId);
        for (const result of params.results) returned.add(result.sourceItemId);
        const complete = reworkIds.length > 0 && reworkIds.every((id) => returned.has(id));
        return {
          ...handoff,
          returnedItemIds: [...returned],
          deliveryState: complete ? ("rework_returned" as const) : handoff.deliveryState,
        };
      });
      Object.assign(state, { items, handoffs });
      break;
    }
    case "workbench/restore": {
      const params = action.params as unknown as WorkbenchRestoreParams;
      applyWorkbenchRestore(state, params);
      break;
    }
    default:
      throw new WorkbenchActionError(`workbench: unknown action type "${action.type}"`);
  }
}

function applyWorkbenchRestore(
  state: WorkbenchProjectState,
  params: WorkbenchRestoreParams,
): void {
  let batches = state.batches;
  let items = state.items;
  let feedback = state.feedback;
  let handoffs = state.handoffs;
  if (params.removeBatchIds?.length) {
    const remove = new Set(params.removeBatchIds);
    batches = batches.filter((b) => !remove.has(b.id));
  }
  if (params.batches?.length) {
    const restore = new Map(params.batches.map((b) => [b.id, b]));
    batches = batches.map((b) => restore.get(b.id) ?? b);
    for (const [id, batch] of restore) {
      if (!batches.some((b) => b.id === id)) batches = [...batches, batch];
    }
  }
  if (params.removeItemIds?.length) {
    const remove = new Set(params.removeItemIds);
    items = items.filter((i) => !remove.has(i.id));
  }
  if (params.items?.length) {
    const restore = new Map(params.items.map((i) => [i.id, i]));
    items = items.map((i) => restore.get(i.id) ?? i);
    for (const [id, item] of restore) {
      if (!items.some((i) => i.id === id)) items = [...items, item];
    }
  }
  if (params.removeFeedbackIds?.length) {
    const remove = new Set(params.removeFeedbackIds);
    feedback = feedback.filter((f) => !remove.has(f.id));
  }
  if (params.feedback?.length) {
    const restore = new Map(params.feedback.map((f) => [f.id, f]));
    feedback = feedback.map((f) => restore.get(f.id) ?? f);
    for (const [id, record] of restore) {
      if (!feedback.some((f) => f.id === id)) feedback = [...feedback, record];
    }
  }
  if (params.removeHandoffIds?.length) {
    const remove = new Set(params.removeHandoffIds);
    handoffs = handoffs.filter((h) => !remove.has(h.handoffId));
  }
  if (params.handoffs?.length) {
    const restore = new Map(params.handoffs.map((h) => [h.handoffId, h]));
    handoffs = handoffs.map((h) => restore.get(h.handoffId) ?? h);
    for (const [id, handoff] of restore) {
      if (!handoffs.some((h) => h.handoffId === id)) handoffs = [...handoffs, handoff];
    }
  }
  Object.assign(state, { batches, items, feedback, handoffs });
}

// ---------------------------------------------------------------------------
// Inverse generation
// ---------------------------------------------------------------------------

export function invertWorkbenchAction(
  action: Action,
  projectBefore: WorkbenchStateHost,
): Action | null {
  const before = wb(projectBefore);
  const restore = (
    params: WorkbenchRestoreParams,
  ): Action => ({
    type: "workbench/restore",
    id: uuidv4(),
    timestamp: Date.now(),
    params: params as unknown as Record<string, unknown>,
  });
  switch (action.type) {
    case "workbench/restore": {
      const params = action.params as unknown as WorkbenchRestoreParams;
      const batchIds = new Set([...(params.removeBatchIds ?? []), ...(params.batches ?? []).map(row => row.id)]);
      const itemIds = new Set([...(params.removeItemIds ?? []), ...(params.items ?? []).map(row => row.id)]);
      const feedbackIds = new Set([...(params.removeFeedbackIds ?? []), ...(params.feedback ?? []).map(row => row.id)]);
      const handoffIds = new Set([...(params.removeHandoffIds ?? []), ...(params.handoffs ?? []).map(row => row.handoffId)]);
      return restore({
        batches: before.batches.filter(row => batchIds.has(row.id)),
        removeBatchIds: [...batchIds].filter(id => !before.batches.some(row => row.id === id)),
        items: before.items.filter(row => itemIds.has(row.id)),
        removeItemIds: [...itemIds].filter(id => !before.items.some(row => row.id === id)),
        feedback: before.feedback.filter(row => feedbackIds.has(row.id)),
        removeFeedbackIds: [...feedbackIds].filter(id => !before.feedback.some(row => row.id === id)),
        handoffs: before.handoffs.filter(row => handoffIds.has(row.handoffId)),
        removeHandoffIds: [...handoffIds].filter(id => !before.handoffs.some(row => row.handoffId === id)),
      });
    }
    case "workbench/ingest": {
      const params = action.params as unknown as WorkbenchIngestParams;
      const previousBatch = before.batches.find((b) => b.id === params.batch.id);
      return restore({
        ...(previousBatch ? { batches: [previousBatch] } : { removeBatchIds: [params.batch.id] }),
        removeItemIds: params.items.map((i) => i.id),
      });
    }
    case "workbench/decide": {
      const params = action.params as unknown as WorkbenchDecideParams;
      const ids = params.decisions.map((d) => d.itemId);
      return restore({ items: ids.map((id) => findItem(before, id)).filter((i): i is WorkbenchItem => !!i) });
    }
    case "workbench/content.update": {
      const params = action.params as unknown as WorkbenchContentUpdateParams;
      const item = findItem(before, params.revision.itemId);
      const itemFeedbackBefore = before.feedback.filter(
        (record) => record.itemId === params.revision.itemId,
      );
      // Content updates may clear accepted rework markers and migrate other
      // cell markers to the produced version; ONE undo must restore those
      // feedback records together with the item.
      const migratedFeedbackIds =
        params.revision.kind === "data"
          ? before.feedback
              .filter(
                (record) =>
                  record.itemId === params.revision.itemId &&
                  record.itemVersion === params.revision.parentVersion &&
                  isActiveReworkFeedback(record, params.revision.parentVersion) &&
                  record.target?.kind === "data-cell",
              )
              .map((record) =>
                workbenchFeedbackId(
                  params.revision.itemId,
                  params.revision.producedVersion,
                  workbenchFeedbackTargetKey(record.target) as string,
                ),
              )
          : [];
      return restore({
        ...(item ? { items: [item] } : { removeItemIds: [params.revision.itemId] }),
        ...(itemFeedbackBefore.length ? { feedback: itemFeedbackBefore } : {}),
        ...(migratedFeedbackIds.length ? { removeFeedbackIds: migratedFeedbackIds } : {}),
      });
    }
    case "workbench/annotations.set": {
      const params = action.params as unknown as WorkbenchAnnotationsSetParams;
      const item = findItem(before, params.itemId);
      return restore(item ? { items: [item] } : {});
    }
    case "workbench/feedback.save": {
      const params = action.params as unknown as WorkbenchFeedbackSaveParams;
      const previous = before.feedback.find((f) => f.id === params.feedback.id);
      return restore(previous ? { feedback: [previous] } : { removeFeedbackIds: [params.feedback.id] });
    }
    case "workbench/revert":
    case "workbench/tags.set":
    case "workbench/duplicateProposal.dismiss": {
      const itemId =
        action.type === "workbench/revert"
          ? undefined
          : (action.params as unknown as { itemId: string }).itemId;
      if (action.type === "workbench/revert") {
        const params = action.params as unknown as WorkbenchRevertParams;
        return restore({
          items: params.itemIds
            .map((id) => findItem(before, id))
            .filter((i): i is WorkbenchItem => !!i),
          feedback: before.feedback.filter((f) => params.itemIds.includes(f.itemId)),
        });
      }
      const item = itemId ? findItem(before, itemId) : undefined;
      return restore(item ? { items: [item] } : {});
    }
    case "workbench/handoff.publish": {
      const params = action.params as unknown as WorkbenchHandoffPublishParams;
      return restore({ removeHandoffIds: [params.handoff.handoffId] });
    }
    case "workbench/handoff.ack": {
      const params = action.params as unknown as WorkbenchHandoffAckParams;
      const previous = before.handoffs.find((h) => h.handoffId === params.handoffId);
      return restore(previous ? { handoffs: [previous] } : {});
    }
    case "workbench/rework.clear": {
      const params = action.params as unknown as WorkbenchReworkClearParams;
      const item = findItem(before, params.itemId);
      const keys = new Set(params.cells.map((cell) => `${cell.rowId}\u0000${cell.columnId}`));
      const feedback = before.feedback.filter(
        (record) =>
          record.itemId === params.itemId &&
          record.itemVersion === params.itemVersion &&
          record.target?.kind === "data-cell" &&
          keys.has(`${record.target.rowId}\u0000${record.target.columnId}`),
      );
      return restore({
        ...(item ? { items: [item] } : {}),
        ...(feedback.length ? { feedback } : {}),
      });
    }
    case "workbench/rework.ingest": {
      const params = action.params as unknown as WorkbenchReworkIngestParams;
      const previousHandoff = before.handoffs.find((h) => h.handoffId === params.handoffId);
      return restore({
        items: params.results
          .map((r) => findItem(before, r.sourceItemId))
          .filter((i): i is WorkbenchItem => !!i),
        ...(previousHandoff ? { handoffs: [previousHandoff] } : {}),
      });
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Shared builders (GUI slice and agent facade both call these)
// ---------------------------------------------------------------------------

export type WorkbenchBuilderResult =
  | {
      readonly ok: true;
      readonly actions: readonly Action[];
      /** Set by publishes so callers can report the snapshot identity. */
      readonly handoffId?: string;
      /** True when an identical publication already existed (retry). */
      readonly replayed?: boolean;
    }
  | {
      readonly ok: false;
      readonly code: "NOT_FOUND" | "CONFLICT" | "INVALID_PARAMS";
      readonly message: string;
      readonly details?: Record<string, unknown>;
    };

export interface WorkbenchIngestItemInput {
  readonly placement?: WorkbenchItem["placement"];
  readonly groupMode?: WorkbenchItem["groupMode"];
  readonly compareWithItemId?: string;
  readonly videoPayload?: WorkbenchItem["videoPayload"];
  readonly originalResourceId?: string;
  /** Stable id provided by the caller (Agent or fixture import). */
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly type: WorkbenchItem["type"];
  readonly content: WorkbenchItemContent;
  readonly provenanceTags?: readonly WorkbenchProvenanceTag[];
  readonly userTags?: readonly string[];
  readonly agentGuidance?: WorkbenchAgentGuidance;
  readonly lineage?: WorkbenchLineage;
  readonly reworkOrigin?: WorkbenchItem["reworkOrigin"];
}

export interface WorkbenchIngestInput {
  readonly batchId: string;
  readonly name: string;
  readonly description?: string;
  readonly items: readonly WorkbenchIngestItemInput[];
}

function makeAction(type: string, params: unknown): Action {
  return { type, id: uuidv4(), timestamp: Date.now(), params: params as Record<string, unknown> };
}

/**
 * Build the ingest action(s): create the batch or append to it. Items whose
 * (itemId, version) already exist are idempotently skipped; an existing id
 * with a different version is an error (ids are never reused).
 */
export function buildWorkbenchIngestActions(
  state: WorkbenchProjectState,
  input: WorkbenchIngestInput,
  now: number = Date.now(),
): WorkbenchBuilderResult {
  if (!input.items.length) {
    return { ok: false, code: "INVALID_PARAMS", message: "workbench ingest requires items" };
  }
  const existingBatch = state.batches.find((b) => b.id === input.batchId);
  const newItems: WorkbenchItem[] = [];
  const mergedItemIds = existingBatch ? [...existingBatch.itemIds] : [];
  for (const input_ of input.items) {
    const existing = findItem(state, input_.id);
    if (existing) {
      if (existing.batchId !== input.batchId) {
        return {
          ok: false,
          code: "CONFLICT",
          message: `workbench item id "${input_.id}" already exists in batch ${existing.batchId}`,
        };
      }
      continue; // idempotent re-ingest of the same identity
    }
    const version = 1;
    const compareWithItemId = input_.compareWithItemId ?? input_.videoPayload?.compareWithItemId;
    const item: WorkbenchItem = {
      ...(input_.groupMode !== undefined ? { groupMode: input_.groupMode } : {}),
      ...(compareWithItemId !== undefined ? { compareWithItemId } : {}),
      ...(input_.videoPayload !== undefined || compareWithItemId !== undefined
        ? { videoPayload: { ...input_.videoPayload, ...(compareWithItemId !== undefined ? { compareWithItemId } : {}) } }
        : {}),
      ...(input_.originalResourceId ? { originalResourceId: input_.originalResourceId } : {}),
      id: input_.id,
      batchId: input.batchId,
      orderIndex: mergedItemIds.length,
      title: input_.title,
      ...(input_.subtitle !== undefined ? { subtitle: input_.subtitle } : {}),
      type: input_.type,
      version,
      createdAt: now,
      content: structuredClone(input_.content),
      provenanceTags: [...(input_.provenanceTags ?? [])],
      userTags: [...(input_.userTags ?? [])],
      ...(input_.agentGuidance ? { agentGuidance: input_.agentGuidance } : {}),
      ...(input_.lineage ? { lineage: input_.lineage } : {}),
      ...(input_.placement ? { placement: input_.placement } : {}),
      ...(input_.reworkOrigin ? { reworkOrigin: input_.reworkOrigin } : {}),
      status: "pending",
      decisionLog: [],
      revisions: [],
    };
    try {
      validateItemContent(item);
    } catch (error) {
      return {
        ok: false,
        code: "INVALID_PARAMS",
        message: error instanceof Error ? error.message : "invalid item content",
      };
    }
    newItems.push(item);
    mergedItemIds.push(item.id);
  }
  if (!newItems.length) {
    return { ok: true, actions: [] }; // fully idempotent no-op
  }
  const batch: WorkbenchBatch = existingBatch
    ? {
        ...existingBatch,
        itemIds: mergedItemIds,
        revision: existingBatch.revision + 1,
      }
    : {
        id: input.batchId,
        name: input.name,
        ...(input.description !== undefined ? { description: input.description } : {}),
        createdAt: now,
        revision: 1,
        itemIds: mergedItemIds,
      };
  return {
    ok: true,
    actions: [makeAction("workbench/ingest", { batch, items: newItems })],
  };
}

export function buildWorkbenchDecideAction(
  state: WorkbenchProjectState,
  batchId: string,
  targets: ReadonlyArray<{ itemId: string; decision: WorkbenchDecision; contentRevisionId?: string }>,
  operator: "human" | "agent",
  now: number = Date.now(),
): WorkbenchBuilderResult {
  if (!targets.length) {
    return { ok: false, code: "INVALID_PARAMS", message: "decide requires targets" };
  }
  const decisions: WorkbenchDecideTarget[] = targets.map((target) => {
    const item = findItem(state, target.itemId);
    if (!item) {
      throw new WorkbenchActionError(`workbench: item "${target.itemId}" not found`);
    }
    return {
      itemId: target.itemId,
      baseVersion: item.version,
      decision: target.decision,
      decisionRevision: workbenchItemDecisionRevision(item) + 1,
      decidedAt: now,
      operator,
      ...(target.contentRevisionId ? { contentRevisionId: target.contentRevisionId } : {}),
    };
  });
  return {
    ok: true,
    actions: [makeAction("workbench/decide", { batchId, decisions })],
  };
}

export interface WorkbenchRevisionGuard {
  /** Explicit item version the caller derived the revision from (CAS). */
  readonly expectedItemVersion?: number;
}

export function buildWorkbenchTextRevisionActions(
  state: WorkbenchProjectState,
  itemId: string,
  newText: string,
  now: number = Date.now(),
  guard?: WorkbenchRevisionGuard,
): WorkbenchBuilderResult {
  const item = findItem(state, itemId);
  if (!item || item.content.type !== "text") {
    return { ok: false, code: "NOT_FOUND", message: `workbench text item "${itemId}" not found` };
  }
  if (guard?.expectedItemVersion !== undefined && guard.expectedItemVersion !== item.version) {
    return {
      ok: false,
      code: "CONFLICT",
      message: `workbench item "${itemId}" is at version ${item.version}, the revision expected v${guard.expectedItemVersion}`,
      details: {
        itemId,
        currentVersion: item.version,
        expectedVersion: guard.expectedItemVersion,
      },
    };
  }
  const current = item.content.versions[item.content.versions.length - 1];
  if (current.text === newText) {
    return {
      ok: false,
      code: "INVALID_PARAMS",
      message: "text unchanged: a revision with no content change cannot be marked modified",
    };
  }
  const revision: WorkbenchContentRevision = {
    id: uuidv4(),
    itemId,
    parentVersion: item.version,
    producedVersion: nextWorkbenchContentVersion(item),
    createdAt: now,
    kind: "text",
    text: { entryId: item.content.entryId, text: newText },
  };  return { ok: true, actions: [makeAction("workbench/content.update", { revision })] };
}

export function buildWorkbenchDataPatchActions(
  state: WorkbenchProjectState,
  itemId: string,
  patches: readonly WorkbenchDataPatch[],
  now: number = Date.now(),
  guard?: WorkbenchRevisionGuard,
): WorkbenchBuilderResult {
  const item = findItem(state, itemId);
  if (!item || item.content.type !== "data") {
    return { ok: false, code: "NOT_FOUND", message: `workbench data item "${itemId}" not found` };
  }
  if (guard?.expectedItemVersion !== undefined && guard.expectedItemVersion !== item.version) {
    return {
      ok: false,
      code: "CONFLICT",
      message: `workbench item "${itemId}" is at version ${item.version}, the revision expected v${guard.expectedItemVersion}`,
      details: {
        itemId,
        currentVersion: item.version,
        expectedVersion: guard.expectedItemVersion,
      },
    };
  }
  if (!patches.length) {
    return {
      ok: false,
      code: "INVALID_PARAMS",
      message: "data update requires explicit cell patches (whole-table overwrite is not supported)",
    };
  }
  const dataset = item.content;
  try {
    validateDataPatches(dataset, patches);
  } catch (error) {
    return {
      ok: false,
      code: "INVALID_PARAMS",
      message: error instanceof Error ? error.message : "invalid data patches",
    };
  }
  // A proposal status transition IS a real change even when the cell text is
  // unchanged (rejecting a suggestion must be recordable without rewriting
  // the value). Only a patch that changes neither is a no-op.
  const changed = patches.some((patch) => {
    const row = dataset.rows.find((r) => r.rowId === patch.rowId);
    const valueChanged = patch.value !== undefined && (!row || row.cells[patch.columnId] !== patch.value);
    const proposal = patch.proposalId
      ? dataset.proposals.find((candidate) => candidate.proposalId === patch.proposalId)
      : undefined;
    const proposalChanged =
      patch.proposalOutcome !== undefined && proposal?.status !== patch.proposalOutcome;
    return valueChanged || proposalChanged;
  });
  if (!changed) {
    return {
      ok: false,
      code: "INVALID_PARAMS",
      message: "patches change nothing: no-op cannot be marked modified",
    };
  }
  const revision: WorkbenchContentRevision = {
    id: uuidv4(),
    itemId,
    parentVersion: item.version,
    producedVersion: nextWorkbenchContentVersion(item),
    createdAt: now,
    kind: "data",
    data: { patches },
  };
  return { ok: true, actions: [makeAction("workbench/content.update", { revision })] };
}

export function buildWorkbenchImageRepairAction(
  state: WorkbenchProjectState,
  itemId: string,
  derivedMediaId: string,
  strokes: readonly WorkbenchPixelStroke[],
  base?: WorkbenchRepairBase,
  now: number = Date.now(),
): WorkbenchBuilderResult {
  const item = findItem(state, itemId);
  if (!item || item.type !== "image") {
    return { ok: false, code: "NOT_FOUND", message: `workbench image item "${itemId}" not found` };
  }
  if (!strokes.length) {
    return {
      ok: false,
      code: "INVALID_PARAMS",
      message: "image repair requires at least one stroke",
    };
  }
  const revision: WorkbenchContentRevision = {
    id: uuidv4(),
    itemId,
    parentVersion: item.version,
    producedVersion: nextWorkbenchContentVersion(item),
    createdAt: now,
    kind: "image-repair",
    mediaId: derivedMediaId,
    strokes: [...strokes],
    ...(base ? { base } : {}),
  };
  return { ok: true, actions: [makeAction("workbench/content.update", { revision })] };
}

/**
 * Explicit "mark rework" for selected data cells: one confirmed feedback per
 * cell (stable data-cell target, pending proposal id when one owns the cell)
 * plus the item-level rework decision, all in ONE action batch so the GUI
 * commits a single undo group and a single invalid cell leaves nothing behind.
 */
export function buildWorkbenchMarkDataReworkActions(
  state: WorkbenchProjectState,
  input: WorkbenchMarkDataReworkInput,
  now: number = Date.now(),
): WorkbenchBuilderResult {
  const item = findItem(state, input.itemId);
  if (!item || item.content.type !== "data") {
    return { ok: false, code: "NOT_FOUND", message: `workbench data item "${input.itemId}" not found` };
  }
  if (item.version !== input.itemVersion) {
    return {
      ok: false,
      code: "CONFLICT",
      message: `workbench item "${item.id}" is at version ${item.version}, rework targets v${input.itemVersion}`,
      details: { itemId: item.id, currentVersion: item.version, expectedVersion: input.itemVersion },
    };
  }
  if (!Array.isArray(input.cells) || input.cells.length === 0) {
    return { ok: false, code: "INVALID_PARAMS", message: "mark rework requires at least one cell" };
  }
  const columns = new Set(item.content.columns.map((column) => column.columnId));
  const rows = new Set(item.content.rows.map((row) => row.rowId));
  const proposals = new Map(
    item.content.proposals.map((proposal) => [proposal.proposalId, proposal]),
  );
  const seen = new Set<string>();
  const feedback: WorkbenchFeedback[] = [];
  for (const cell of input.cells) {
    if (!rows.has(cell.rowId)) {
      return { ok: false, code: "INVALID_PARAMS", message: `row "${cell.rowId}" not found` };
    }
    if (!columns.has(cell.columnId)) {
      return { ok: false, code: "INVALID_PARAMS", message: `column "${cell.columnId}" not found` };
    }
    const key = `${cell.rowId}\u0000${cell.columnId}`;
    if (seen.has(key)) {
      return { ok: false, code: "INVALID_PARAMS", message: `duplicate rework cell ${cell.rowId}:${cell.columnId}` };
    }
    seen.add(key);
    const pendingProposal = cell.proposalId
      ? proposals.get(cell.proposalId)
      : item.content.proposals.find(
          (proposal) =>
            proposal.rowId === cell.rowId &&
            proposal.columnId === cell.columnId &&
            proposal.status === "proposed",
        );
    if (cell.proposalId && !pendingProposal) {
      return {
        ok: false,
        code: "INVALID_PARAMS",
        message: `proposal "${cell.proposalId}" not found`,
      };
    }
    if (
      pendingProposal &&
      (pendingProposal.rowId !== cell.rowId || pendingProposal.columnId !== cell.columnId)
    ) {
      return {
        ok: false,
        code: "INVALID_PARAMS",
        message: `proposal "${pendingProposal.proposalId}" does not belong to ${cell.rowId}:${cell.columnId}`,
      };
    }
    const target: WorkbenchFeedbackTarget = {
      kind: "data-cell",
      rowId: cell.rowId,
      columnId: cell.columnId,
      ...(pendingProposal ? { proposalId: pendingProposal.proposalId } : {}),
    };
    const targetKey = workbenchFeedbackTargetKey(target) as string;
    const existing = state.feedback.find(
      (record) =>
        record.itemId === item.id &&
        record.itemVersion === item.version &&
        workbenchFeedbackTargetKey(record.target) === targetKey,
    );
    feedback.push({
      id:
        existing?.id ??
        workbenchFeedbackId(item.id, item.version, targetKey),
      itemId: item.id,
      itemVersion: item.version,
      text: input.reason?.trim() || existing?.text || "标记返工",
      referencedTagIds: existing ? [...existing.referencedTagIds] : [],
      target,
      intent: "rework",
      state: "confirmed",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }
  const decide = buildWorkbenchDecideAction(
    state,
    item.batchId,
    [{ itemId: item.id, decision: "rework" }],
    "human",
    now,
  );
  if (!decide.ok) return decide;
  return {
    ok: true,
    actions: [
      ...feedback.map((record) =>
        makeAction("workbench/feedback.save", { feedback: record }),
      ),
      ...decide.actions,
    ],
  };
}

/**
 * A new handoff may only carry feedback that applies to the item's CURRENT
 * version and whose target still exists in that content. Historical versions
 * stay in the project; deleting an issue never silently deletes its history,
 * but it also must not be published as a live execution instruction.
 */
function feedbackAppliesToItem(item: WorkbenchItem, feedback: WorkbenchFeedback): boolean {
  if (feedback.itemVersion !== item.version) return false;
  const target = feedback.target;
  if (!target) return true; // legacy item-level note: no dangling issue target
  switch (target.kind) {
    case "model-view":
      return item.content.type === "model3d" && target.resourceId === item.content.resourceId;
    case "pixel-region":
      return (
        item.content.type === "image" &&
        item.content.annotations.some((annotation) => annotation.id === target.annotationId)
      );
    case "video-marker":
      return (
        item.content.type === "video" &&
        item.content.markers.some((marker) => marker.id === target.markerId)
      );
    case "data-cell":
      return (
        item.content.type === "data" &&
        item.content.columns.some((column) => column.columnId === target.columnId) &&
        item.content.rows.some((row) => row.rowId === target.rowId)
      );
    case "text-range": {
      if (item.content.type !== "text") return false;
      if (target.version !== item.version) return false;
      if (target.entryId !== item.content.entryId) return false;
      const version = item.content.versions.find(
        (candidate) => candidate.version === target.version,
      );
      if (!version) return false;
      return (
        Number.isInteger(target.startOffset) &&
        Number.isInteger(target.endOffset) &&
        target.startOffset >= 0 &&
        target.endOffset >= target.startOffset &&
        target.endOffset <= version.text.length
      );
    }
    case "whole-item":
      return true;
  }
}

/**
 * Member-scoped supersede check: handoffs are stored newest-first, and only a
 * NEWER handoff of the same batch that actually covers the item supersedes an
 * older one for that item. A subset handoff therefore never cancels the
 * untouched members of an earlier handoff.
 */
function isHandoffItemSuperseded(
  state: WorkbenchProjectState,
  handoff: WorkbenchHandoff,
  itemId: string,
): boolean {
  const index = state.handoffs.findIndex((entry) => entry.handoffId === handoff.handoffId);
  if (index < 0) return false;
  return state.handoffs
    .slice(0, index)
    .some(
      (newer) =>
        newer.batchId === handoff.batchId &&
        newer.items.some((entry) => entry.itemId === itemId),
    );
}

/**
 * Rework results must carry content of the SAME item type. The content is
 * validated for the produced version: a text rework appends one new version
 * (older bodies stay byte-identical so old range comments keep their text),
 * and data rework keeps the stable dataset/row/column identity.
 */
function validateReworkContent(item: WorkbenchItem, result: WorkbenchReworkResult): void {
  if (result.content.type !== item.type) {
    throw new WorkbenchActionError(
      `workbench: rework content type ${result.content.type} does not match item type ${item.type}`,
    );
  }
  if (item.content.type === "text" && result.content.type === "text") {
    if (result.content.entryId !== item.content.entryId) {
      throw new WorkbenchActionError("workbench: text rework must keep the original entry id");
    }
    if (result.content.versions.length !== item.content.versions.length + 1) {
      throw new WorkbenchActionError(
        "workbench: text rework must append exactly one new version (older versions are retained)",
      );
    }
    for (const [index, previous] of item.content.versions.entries()) {
      const next = result.content.versions[index];
      if (
        !next ||
        next.version !== previous.version ||
        next.text !== previous.text ||
        next.createdAt !== previous.createdAt ||
        next.origin !== previous.origin
      ) {
        throw new WorkbenchActionError(
          `workbench: text rework rewrote retained version ${previous.version}; append a new version instead`,
        );
      }
    }
    const produced = result.content.versions[result.content.versions.length - 1];
    if (produced.version !== result.producedVersion) {
      throw new WorkbenchActionError(
        `workbench: text rework last version must be the produced version ${result.producedVersion}`,
      );
    }
  }
  if (item.content.type === "data" && result.content.type === "data") {
    if (result.content.datasetId !== item.content.datasetId) {
      throw new WorkbenchActionError("workbench: data rework must keep the dataset id");
    }
    const previousColumns = item.content.columns.map((column) => column.columnId);
    const nextColumns = result.content.columns.map((column) => column.columnId);
    if (
      previousColumns.length !== nextColumns.length ||
      previousColumns.some((id, index) => id !== nextColumns[index])
    ) {
      throw new WorkbenchActionError(
        "workbench: data rework must keep the stable column identity and order",
      );
    }
    const previousRows = item.content.rows.map((row) => row.rowId);
    const nextRows = result.content.rows.map((row) => row.rowId);
    if (
      previousRows.length !== nextRows.length ||
      previousRows.some((id, index) => id !== nextRows[index])
    ) {
      throw new WorkbenchActionError(
        "workbench: data rework must keep the stable row identity and order",
      );
    }
  }
  // Validate against the item's real type and the produced version (never a
  // temporarily overridden type).
  validateItemContent({
    ...item,
    version: result.producedVersion,
    content: result.content,
  });
}

function handoffTagReferences(
  referencedTagIds: readonly string[],
  provenanceTags: readonly WorkbenchProvenanceTag[],
): readonly WorkbenchHandoffReferencedTag[] {
  const byId = new Map(provenanceTags.map((tag) => [tag.id, tag]));
  return referencedTagIds.map((id) => {
    const tag = byId.get(id);
    if (!tag) {
      // Unresolved references keep their raw value; never silently dropped.
      return { id, referenceState: "unresolved" as const, raw: id };
    }
    return {
      id,
      name: tag.shortName,
      ...(tag.version !== undefined ? { version: tag.version } : {}),
      referenceState: "resolved" as const,
    };
  });
}

function shortSnapshotHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
/**
 * Build a publish action from the CURRENT state. Only items with a non-pending
 * decision are eligible; `itemIds` selects a subset (undefined = all decided).
 * Confirmed feedback is embedded; draft feedback never enters the snapshot.
 */
export function buildWorkbenchHandoffPublishAction(
  state: WorkbenchProjectState,
  batchId: string,
  options: {
    itemIds?: readonly string[];
    idempotencyKey?: string;
  },
  now: number = Date.now(),
): WorkbenchBuilderResult {
  const batch = state.batches.find((b) => b.id === batchId);
  if (!batch) {
    return { ok: false, code: "NOT_FOUND", message: `workbench batch "${batchId}" not found` };
  }
  const batchItems = state.items.filter((i) => i.batchId === batchId);
  const decided = batchItems.filter((i) => i.status !== "pending");
  const selected = options.itemIds
    ? decided.filter((i) => options.itemIds!.includes(i.id))
    : decided;
  if (!selected.length) {
    return {
      ok: false,
      code: "INVALID_PARAMS",
      message: "no decided items to publish (pending items and drafts never enter a handoff)",
    };
  }
  if (options.itemIds && selected.length !== options.itemIds.length) {
    const missing = options.itemIds.filter(
      (id) => !decided.some((i) => i.id === id),
    );
    return {
      ok: false,
      code: "INVALID_PARAMS",
      message: "cannot publish pending items",
      details: { pendingItemIds: missing },
    };
  }
  const lastDecisionOf = (item: WorkbenchItem): WorkbenchDecisionEntry | undefined =>
    item.decisionLog.length ? item.decisionLog[item.decisionLog.length - 1] : undefined;
  const snapshotItems: WorkbenchHandoffItem[] = selected.map((item) => {
    const lastDecision = lastDecisionOf(item);
    const confirmed = state.feedback.filter(
      (f) =>
        f.itemId === item.id &&
        f.state === "confirmed" &&
        f.clearedAt === undefined &&
        feedbackAppliesToItem(item, f),
    );
    // In-place upsert keeps the array slot, so "last element" is not "newest".
    const latestConfirmed = confirmed.reduce<
      (typeof confirmed)[number] | undefined
    >((latest, candidate) => {
      if (!latest) return candidate;
      if (candidate.updatedAt > latest.updatedAt) return candidate;
      if (candidate.updatedAt === latest.updatedAt && candidate.id > latest.id) {
        return candidate;
      }
      return latest;
    }, undefined);
    const revision =
      item.status === "modified"
        ? item.revisions[item.revisions.length - 1]
        : undefined;
    const derivedMediaId =
      revision?.kind === "image-repair" ? revision.mediaId : undefined;
    const decision: WorkbenchDecision =
      item.status === "pending" ? "kept" : item.status;
    const issues: WorkbenchHandoffIssue[] = confirmed.map((record) => ({
      feedbackId: record.id,
      issueId: workbenchFeedbackIssueId(record.target ?? { kind: "whole-item" }),
      itemVersion: record.itemVersion,
      intent: record.intent ?? "note",
      state: "confirmed" as const,
      text: record.text,
      target: structuredClone(record.target ?? { kind: "whole-item" as const }),
      referencedTags: handoffTagReferences(record.referencedTagIds, item.provenanceTags),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }));
    const handoffItem = Object.assign(
      {
        itemId: item.id,
        title: item.title,
        type: item.type,
        itemVersion: item.version,
        decisionRevision: workbenchItemDecisionRevision(item),
        decision,
        operator: "human" as const,
        feedbackIds: confirmed.map((f) => f.id),
        issues,
        provenanceTags: structuredClone(item.provenanceTags),
        revisions: structuredClone(item.revisions),
      },
      lastDecision?.contentRevisionId ? { contentRevisionId: lastDecision.contentRevisionId } : {},
      latestConfirmed?.text ? { feedbackText: latestConfirmed.text } : {},
      // Always emit the id array (including []); the snapshot type requires it
      // and readers must never have to guess whether the field is missing.
      { referencedTagIds: latestConfirmed ? [...latestConfirmed.referencedTagIds] : [] },
      latestConfirmed?.target ? { target: latestConfirmed.target } : {},
      item.content.type === "text"
        ? {
            text: {
              entryId: item.content.entryId,
              text: item.content.versions[item.content.versions.length - 1].text,
            },
          }
        : {},
      revision?.kind === "data" && revision.data
        ? { dataPatches: structuredClone(revision.data.patches) }
        : {},
      item.content.type === "image"
        ? { imageAnnotations: structuredClone(item.content.annotations) }
        : {},
      item.content.type === "video"
        ? { videoMarkers: structuredClone(item.content.markers), videoTimeBasis: "browser-current-time" }
        : {},
      item.content.type === "model3d" ? { resourceId: item.content.resourceId } :
      item.content.type === "image" || item.content.type === "video"
        ? {
            mediaId: item.content.mediaId,
            ...(derivedMediaId ? { derivedMediaId } : {}),
          }
        : {},
    ) as WorkbenchHandoffItem;
    return handoffItem;
  });
  const selectedIds = new Set(selected.map((item) => item.id));
  // Member-scoped supersede: only a newer handoff that COVERS one of the
  // published items supersedes; untouched members of an older handoff remain
  // executable. Handoffs are stored newest-first.
  const previousHandoff = state.handoffs.find(
    (handoff) =>
      handoff.batchId === batchId &&
      handoff.items.some((entry) => selectedIds.has(entry.itemId)),
  );
  // Every frozen execution field participates, including geometry, marker
  // timing and provenance. Delivery bookkeeping and publish time do not.
  const contentKey = JSON.stringify({ batchName: batch.name, items: snapshotItems });
  const defaultKey = `wb-${batchId}-${contentKey}`;
  const idempotencyKey =
    options.idempotencyKey ??
    (defaultKey.length <= 400 ? defaultKey : `wb-${batchId}-${shortSnapshotHash(contentKey)}`);
  const existing = state.handoffs.find((h) => h.idempotencyKey === idempotencyKey);
  if (existing) {
    // An identical retry reuses the already published snapshot identity; it
    // does not publish a second copy.
    return {
      ok: true,
      actions: [],
      handoffId: existing.handoffId,
      replayed: true,
    };
  }
  const handoff: WorkbenchHandoff = {
    handoffId: uuidv4(),
    idempotencyKey,
    batchId,
    batchName: batch.name,
    publishedAt: now,
    deliveryState: "published_waiting",
    snapshotSchemaVersion: 2,
    ...(previousHandoff ? { supersedesHandoffId: previousHandoff.handoffId } : {}),
    returnedItemIds: [],
    items: snapshotItems,
  };
  return {
    ok: true,
    actions: [makeAction("workbench/handoff.publish", { handoff })],
    handoffId: handoff.handoffId,
    replayed: false,
  };
}

export function buildWorkbenchReworkIngestActions(
  _state: WorkbenchProjectState,
  handoffId: string,
  results: readonly WorkbenchReworkResult[],
): WorkbenchBuilderResult {
  if (!results.length) {
    return { ok: false, code: "INVALID_PARAMS", message: "rework requires results" };
  }
  return {
    ok: true,
    actions: [makeAction("workbench/rework.ingest", { handoffId, results })],
  };
}
