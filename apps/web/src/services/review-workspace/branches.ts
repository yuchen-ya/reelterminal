import { v5 as uuidv5 } from "uuid";
import type { Action } from "@reelterminal/core/types/actions";
import type { ReviewBranchOrigin, ReviewNode } from "@reelterminal/core/review/types";
import type { WorkbenchItem, WorkbenchItemContent, WorkbenchProjectState } from "@reelterminal/core/types/workbench";
import { forkReviewNodeArchive, type ReviewArchivedVersion, type ReviewIdMapping, type ReviewNodeArchive } from "@reelterminal/core/review/archive";
import { splitReviewContent } from "@reelterminal/core/review/content";
import { reviewError, sameReviewValue } from "./guards";

export interface ReviewBranchCheckpoint {
  readonly requestId: string;
  readonly resultItemId: string;
  readonly resultVersion: number;
  readonly sourceItem: WorkbenchItem;
  readonly sourceFeedback: WorkbenchProjectState["feedback"];
}

/** Stored under reviewArchives.nodeId. Purge removes it; portable restore never activates it. */
export interface ReviewBranchBaseline extends ReviewBranchOrigin {
  readonly branchNodeId: string;
  readonly workspaceId: string;
  readonly items: readonly WorkbenchItem[];
  readonly feedback: WorkbenchProjectState["feedback"];
  readonly idMap: readonly ReviewIdMapping[];
  readonly checkpoints: readonly ReviewBranchCheckpoint[];
}

export interface ReviewBranchSelection { readonly resultItemId: string; readonly resultVersion: number }
export interface ReviewBranchResult { readonly itemId: string; readonly expectedItemVersion: number; readonly content: WorkbenchItemContent }
export interface ReviewBranchDifference extends ReviewBranchSelection {
  readonly title: string;
  readonly sourceItemId?: string;
  readonly baseVersion?: number;
  readonly sourceVersion?: number;
  readonly state: "changed" | "added" | "unchanged" | "adopted" | "conflict";
  readonly conflict?: string;
}
export interface ReviewBranchComparison {
  readonly branch: ReviewNode;
  readonly source: ReviewNode;
  readonly items: readonly ReviewBranchDifference[];
  readonly idMap: readonly ReviewIdMapping[];
}

export function prepareReviewBranch(archive: ReviewNodeArchive, taskId: string) {
  const fork = forkReviewNodeArchive(archive, taskId);
  const baseline: ReviewBranchBaseline = {
    taskId, sourceNodeId: archive.node.id, sourceNodeRevision: archive.node.revision,
    branchNodeId: fork.nodeId, workspaceId: archive.node.workspaceId,
    items: archive.state.items, feedback: archive.state.feedback, idMap: fork.idMap, checkpoints: [],
  };
  return { ...fork, baseline };
}

function sameItem(a: WorkbenchItem, b: WorkbenchItem): boolean {
  // Undo retains allocated content versions; the allocation ceiling is not a user edit.
  const { versionCeiling: _a, updatedAt: _updatedA, incomingRevision: _incomingA, ...left } = a;
  const { versionCeiling: _b, updatedAt: _updatedB, incomingRevision: _incomingB, ...right } = b;
  return sameReviewValue(left, right);
}

function sourceItemId(baseline: ReviewBranchBaseline, resultItemId: string): string | undefined {
  return baseline.idMap.find(entry => entry.kind === "item" && entry.newId === resultItemId)?.oldId
    ?? baseline.checkpoints.find(entry => entry.resultItemId === resultItemId)?.sourceItem.id;
}

export function assertReviewBranch(node: ReviewNode, baseline: ReviewBranchBaseline, source: ReviewNode): void {
  if (node.id !== baseline.branchNodeId || node.workspaceId !== baseline.workspaceId ||
      source.id !== baseline.sourceNodeId || source.workspaceId !== baseline.workspaceId ||
      !sameReviewValue(node.branch, { taskId: baseline.taskId, sourceNodeId: baseline.sourceNodeId, sourceNodeRevision: baseline.sourceNodeRevision })) {
    throw reviewError("CONFLICT", "Branch, source and baseline identities do not match");
  }
  if (node.trashedAt || source.trashedAt) throw reviewError("CONFLICT", "Restore the branch and source from the recycle bin before adopting");
}

/** Only the selected item's state matters; unrelated source commits do not create conflicts. */
export function compareReviewBranchItem(baseline: ReviewBranchBaseline, source: WorkbenchProjectState, result: WorkbenchItem): ReviewBranchDifference {
  const id = sourceItemId(baseline, result.id);
  const original = baseline.items.find(item => item.id === id);
  const current = source.items.find(item => item.id === id);
  const identity = { resultItemId: result.id, resultVersion: result.version, title: result.title,
    ...(id ? { sourceItemId: id } : {}), ...(original ? { baseVersion: original.version } : {}),
    ...(current ? { sourceVersion: current.version } : {}) };
  const checkpoints = baseline.checkpoints.filter(entry => entry.resultItemId === result.id);
  if (!id || (!current && !original)) return { ...identity, state: "added" };
  if (!current) return { ...identity, state: "conflict", conflict: "Source item was removed" };
  const feedback = source.feedback.filter(entry => entry.itemId === id);
  const checkpoint = [...checkpoints].reverse().find(entry => sameItem(entry.sourceItem, current) && sameReviewValue(entry.sourceFeedback, feedback));
  const originalMatches = original && sameItem(original, current) && sameReviewValue(baseline.feedback.filter(entry => entry.itemId === id), feedback);
  if (!checkpoint && !originalMatches) return { ...identity, state: "conflict", conflict: "Source content, decisions, annotations or feedback changed" };
  if (checkpoint?.resultVersion === result.version) return { ...identity, state: "adopted" };
  const normalized = mapBranchContent(baseline, result.content);
  if (original && result.version === original.version && sameReviewValue(splitReviewContent(normalized).body, splitReviewContent(current.content).body)) {
    return { ...identity, state: "unchanged" };
  }
  return { ...identity, state: "changed" };
}

/** Convert known content identities back to their source; new identities remain stable per task. */
export function mapBranchContent(baseline: ReviewBranchBaseline, content: WorkbenchItemContent): WorkbenchItemContent {
  const map = (kind: string, id: string) => branchSourceIdentity(baseline, kind, id);
  if (content.type === "text") return { ...content, entryId: map("entry", content.entryId), duplicateProposal: undefined };
  if (content.type === "data") return { ...content, datasetId: map("dataset", content.datasetId),
    columns: content.columns.map(column => ({ ...column, columnId: map("column", column.columnId) })),
    rows: content.rows.map(row => ({ rowId: map("row", row.rowId), cells: Object.fromEntries(Object.entries(row.cells).map(([id, value]) => [map("column", id), value])) })),
    proposals: content.proposals.map(proposal => ({ ...proposal, proposalId: map("proposal", proposal.proposalId), rowId: map("row", proposal.rowId),
      columnId: map("column", proposal.columnId), provenanceTagId: map("tag", proposal.provenanceTagId) })) };
  // File resources are shared, never remapped to an unrelated or unregistered resource.
  return structuredClone(content);
}

function branchSourceIdentity(baseline: ReviewBranchBaseline, kind: string, id: string): string {
  return baseline.idMap.find(entry => entry.kind === kind && entry.newId === id)?.oldId ?? uuidv5(`adopt:${kind}:${id}`, baseline.taskId);
}

function adoptedContent(baseline: ReviewBranchBaseline, result: WorkbenchItem, current: WorkbenchItem | undefined, version: number, now: number): WorkbenchItemContent {
  const content = mapBranchContent(baseline, result.content);
  if (content.type === "text") {
    const entry = content.versions.find(entry => entry.version === result.version);
    if (!entry) throw reviewError("CONFLICT", "The selected result has no immutable text body");
    return { ...content, entryId: current?.content.type === "text" ? current.content.entryId : content.entryId,
      versions: [...(current?.content.type === "text" ? current.content.versions : []),
        { version, text: entry.text, createdAt: now, origin: "agent-rework", ...(current ? { parentVersion: current.version } : {}) }] };
  }
  if (content.type === "image") return { ...content,
    mediaId: result.revisions.find(revision => revision.producedVersion === result.version)?.mediaId ?? content.mediaId,
    annotations: current?.content.type === "image" ? current.content.annotations : [], strokes: [] };
  if (content.type === "video") return { ...content, markers: current?.content.type === "video" ? current.content.markers : [] };
  return content;
}

/** Produces ordinary reversible actions; the service owns all CAS, retention and receipts. */
export function planReviewBranchAdoption(baseline: ReviewBranchBaseline, source: WorkbenchProjectState, results: readonly WorkbenchItem[],
  selections: readonly ReviewBranchSelection[], requestId: string, now: number,
  retainedVersions: readonly Pick<ReviewArchivedVersion, "itemId" | "version">[] = []): { actions: readonly Action[]; checkpoints: readonly ReviewBranchCheckpoint[] } {
  if (!selections.length || new Set(selections.map(entry => entry.resultItemId)).size !== selections.length) throw reviewError("INVALID_PARAMS", "Select distinct branch results to adopt");
  const items: WorkbenchItem[] = [];
  const checkpoints: ReviewBranchCheckpoint[] = [];
  const batches = new Map<string, WorkbenchProjectState["batches"][number]>();
  const versionCeilings = new Map<string, number>();
  for (const retained of retainedVersions) versionCeilings.set(retained.itemId, Math.max(versionCeilings.get(retained.itemId) ?? 0, retained.version));
  for (const selection of selections) {
    const result = results.find(item => item.id === selection.resultItemId);
    if (!result || result.version !== selection.resultVersion) throw reviewError("CONFLICT", "Selected result version changed or belongs to another branch");
    const difference = compareReviewBranchItem(baseline, source, result);
    if (difference.state === "conflict") throw reviewError("CONFLICT", `${result.title}: ${difference.conflict}`);
    if (difference.state === "adopted" || difference.state === "unchanged") throw reviewError("CONFLICT", `${result.title}: this result has no new content to adopt`);
    const current = source.items.find(item => item.id === difference.sourceItemId);
    if (current && current.type !== result.type) throw reviewError("CONFLICT", "A branch result cannot change the source item's content kind");
    const id = difference.sourceItemId ?? uuidv5(`adopt:item:${result.id}`, baseline.taskId);
    // An undone new item has no current row, but its allocated versions remain immutable.
    const version = Math.max(versionCeilings.get(id) ?? 0, current?.versionCeiling ?? 0, current?.version ?? 0) + 1;
    const revisionId = uuidv5(`revision:${result.id}`, requestId);
    const content = adoptedContent(baseline, result, current, version, now);
    const provenanceTags = [...(current?.provenanceTags ?? [])];
    for (const tag of result.provenanceTags) {
      const mapped = { ...tag, id: branchSourceIdentity(baseline, "tag", tag.id) };
      if (!provenanceTags.some(tag => tag.id === mapped.id)) provenanceTags.push(mapped);
    }
    const originTagId = uuidv5(`branch-origin:${result.id}`, baseline.taskId);
    if (!provenanceTags.some(tag => tag.id === originTagId)) provenanceTags.push({ id: originTagId, category: "source", shortName: "Task branch", verification: "verified",
      upstreamRef: baseline.branchNodeId, detailSummary: `Source ${baseline.sourceNodeId} at revision ${baseline.sourceNodeRevision}; branch result ${result.id}` });
    if (content.type === "data" && content.proposals.some(proposal => !provenanceTags.some(tag => tag.id === proposal.provenanceTagId))) {
      throw reviewError("CONFLICT", "A data proposal references a missing provenance tag");
    }
    const batchId = current?.batchId ?? uuidv5("adopt:batch", baseline.taskId);
    const item: WorkbenchItem = {
      ...(current ?? { id, batchId, orderIndex: source.items.length + items.length, title: result.title, type: result.type, createdAt: now,
        provenanceTags: [], userTags: [], status: "pending", decisionLog: [], revisions: [],
        ...(result.originalResourceId ? { originalResourceId: result.originalResourceId } : {}) }),
      content, version, versionCeiling: version, status: "kept", provenanceTags,
      revisions: [...(current?.revisions ?? []), ...(current ? [{ id: revisionId, itemId: id, parentVersion: current.version,
        producedVersion: version, createdAt: now, kind: "agent-rework" as const }] : [])],
      decisionLog: [...(current?.decisionLog ?? []), { decision: "kept", decisionRevision: Math.max(0, ...(current?.decisionLog.map(entry => entry.decisionRevision) ?? [])) + 1,
        baseVersion: version, decidedAt: now, operator: "human", ...(current ? { contentRevisionId: revisionId } : {}) }],
    };
    items.push(item);
    checkpoints.push({ requestId, resultItemId: result.id, resultVersion: result.version, sourceItem: item, sourceFeedback: source.feedback.filter(entry => entry.itemId === id) });
    if (!current) {
      const batch = batches.get(batchId) ?? source.batches.find(batch => batch.id === batchId) ?? { id: batchId, name: "Adopted branch results", createdAt: now, revision: 0, itemIds: [] };
      batches.set(batchId, { ...batch, revision: batch.revision + 1, itemIds: [...batch.itemIds, id] });
    }
  }
  return { actions: [{ id: requestId, type: "workbench/restore", timestamp: now, params: { items, ...(batches.size ? { batches: [...batches.values()] } : {}) } }], checkpoints };
}

/** Full media/table results live on the branch; no published human handoff is fabricated. */
export function planReviewBranchResults(state: WorkbenchProjectState, results: readonly ReviewBranchResult[], requestId: string, now: number): readonly Action[] {
  if (!results.length || new Set(results.map(result => result.itemId)).size !== results.length) throw reviewError("INVALID_PARAMS", "Submit distinct branch items");
  const items = results.map(result => {
    const item = state.items.find(item => item.id === result.itemId);
    if (!item || item.version !== result.expectedItemVersion || item.type !== result.content.type) throw reviewError("CONFLICT", "Branch result must match its owning item, content kind and input version");
    const version = Math.max(item.versionCeiling ?? item.version, item.version) + 1;
    let content = result.content;
    if (content.type === "text" && item.content.type === "text") {
      if (content.versions.at(-1)!.text === item.content.versions.at(-1)!.text && content.title === item.content.title && content.speakerOrContext === item.content.speakerOrContext) throw reviewError("INVALID_PARAMS", "A branch text result must change content");
      content = { ...content, entryId: item.content.entryId,
        versions: [...item.content.versions, { version, text: content.versions.at(-1)!.text, createdAt: now, origin: "agent-rework", parentVersion: item.version }] };
    }
    if (sameReviewValue(splitReviewContent(item.content).body, splitReviewContent(content).body)) throw reviewError("INVALID_PARAMS", "A branch result must change content");
    if (content.type === "data" && content.proposals.some(proposal => !item.provenanceTags.some(tag => tag.id === proposal.provenanceTagId))) throw reviewError("INVALID_PARAMS", "A branch data proposal must reference its owning item's provenance tag");
    return { ...item, content, version, versionCeiling: version, status: "pending" as const,
      revisions: [...item.revisions, { id: uuidv5(`result:${item.id}`, requestId), itemId: item.id, parentVersion: item.version,
        producedVersion: version, createdAt: now, kind: "agent-rework" as const }] };
  });
  return [{ id: requestId, type: "workbench/restore", timestamp: now, params: { items } }];
}
