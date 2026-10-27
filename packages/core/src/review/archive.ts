import { isModelObservation } from "./model-observation";
import { v5 as uuidv5 } from "uuid";
import type { WorkbenchItemContent, WorkbenchProjectState } from "../types/workbench";
import type { FileResource, ReviewNode, ReviewStep } from "./types";
import { validateReviewSteps } from "./steps";

export interface ReviewArchivedVersion {
  readonly nodeId: string;
  readonly itemId: string;
  readonly version: number;
  readonly content?: WorkbenchItemContent;
  /** A legacy reference can survive even when its body was never persisted. */
  readonly unavailableReason?: string;
  readonly originalResourceId?: string;
  readonly revision?: WorkbenchProjectState["items"][number]["revisions"][number];
}
export interface ReviewIdMapping { readonly kind: string; readonly oldId: string; readonly newId: string }
export interface ReviewPackagePreview {
  readonly packageId: string; readonly digest: string; readonly name: string; readonly sourceNodeId: string;
  readonly itemCount: number; readonly versionCount: number; readonly stepCount: number;
  readonly resourceCount: number; readonly bytes: number; readonly handoffCount: number;
  readonly missingResourceCount: number; readonly missingVersionCount: number;
}
export interface ReviewJournalArchive {
  readonly sourceNodeId: string;
  readonly records: readonly unknown[];
  readonly idMap: readonly ReviewIdMapping[];
}
export interface ReviewNodeArchive {
  readonly schemaVersion: 1 | 2;
  readonly node: ReviewNode;
  readonly state: WorkbenchProjectState;
  readonly versions: readonly ReviewArchivedVersion[];
  readonly steps: readonly ReviewStep[];
  readonly resources: readonly (Omit<FileResource, "storage"> & { readonly unavailableReason?: string })[];
  /** Historical evidence only. Restoring never executes old journal actions. */
  readonly journal: readonly unknown[];
  readonly journalArchives: readonly ReviewJournalArchive[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function invalid(message: string): never { throw Object.assign(new Error(`Review package: ${message}`), { code: "INVALID_PARAMS" }); }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown, maximum = 200): value is string => typeof value === "string" && value.length > 0 && value.length <= maximum;
const integer = (value: unknown, minimum = 0): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
const id = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
function unique(values: readonly string[], label: string) { if (new Set(values).size !== values.length) invalid(`duplicate ${label}`); }
function annotations(value: unknown): void {
  if (!Array.isArray(value)) invalid("invalid annotation list");
  for (const mark of value) if (!object(mark) || !string(mark.id) || !["box", "arrow", "text"].includes(String(mark.tool)) || !finite(mark.x) || !finite(mark.y) || typeof mark.color !== "string" || (mark.label !== undefined && typeof mark.label !== "string")) invalid("invalid annotation");
}
function json(value: unknown, depth = 0): void {
  if (depth > 32) invalid("JSON nesting exceeds 32");
  if (value === undefined || value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") { if (!Number.isFinite(value)) invalid("nonfinite JSON number"); return; }
  if (Array.isArray(value)) { for (const entry of value) json(entry, depth + 1); return; }
  if (!object(value)) invalid("expected plain JSON");
  for (const entry of Object.values(value)) json(entry, depth + 1);
}

function content(value: unknown, version: number): asserts value is WorkbenchItemContent {
  if (!object(value)) invalid("missing version content");
  if (value.type === "text") {
    if (!string(value.entryId) || !Array.isArray(value.versions) || !value.versions.length || value.versions.at(-1)?.version !== version) invalid("invalid text version chain");
    for (const entry of value.versions) if (!object(entry) || !integer(entry.version, 1) || typeof entry.text !== "string" || entry.text.length > 200000) invalid("invalid text body");
  } else if (value.type === "image") {
    if (!id(value.mediaId) || !Array.isArray(value.annotations) || !Array.isArray(value.strokes)) invalid("invalid image content");
    annotations(value.annotations);
    for (const stroke of value.strokes) {
      if (!object(stroke) || !string(stroke.id) || !["brush", "eraser"].includes(String(stroke.tool)) || typeof stroke.color !== "string" || !finite(stroke.size) || !Array.isArray(stroke.points)) invalid("invalid pixel stroke");
      for (const point of stroke.points) if (!object(point) || !finite(point.x) || !finite(point.y) || !finite(point.pressure) || point.pressure > 1) invalid("invalid stroke point");
    }
  } else if (value.type === "model3d") {
    if (!id(value.resourceId)) invalid("invalid model resource");
  } else if (value.type === "video") {
    if (!id(value.mediaId) || !Array.isArray(value.markers)) invalid("invalid video content");
    for (const marker of value.markers) {
      if (!object(marker) || !string(marker.id) || !finite(marker.startPtsSec) || !integer(marker.version, 1) || typeof marker.note !== "string") invalid("invalid video marker");
      annotations(marker.annotations);
    }
  } else if (value.type === "data") {
    if (!string(value.datasetId) || !Array.isArray(value.columns) || value.columns.length > 64 || !Array.isArray(value.rows) || value.rows.length > 5000 || !Array.isArray(value.proposals)) invalid("invalid table content");
    const columns = value.columns as Record<string, unknown>[];
    const rows = value.rows as Record<string, unknown>[];
    for (const column of columns) if (!object(column) || !string(column.columnId) || typeof column.title !== "string") invalid("invalid column identity");
    for (const row of rows) {
      if (!object(row) || !string(row.rowId) || !object(row.cells)) invalid("invalid row identity");
      for (const cell of Object.values(row.cells)) if (cell !== null && typeof cell !== "string") invalid("cells must be strings or null");
    }
    unique(columns.map(column => column.columnId as string), "column IDs");
    unique(rows.map(row => row.rowId as string), "row IDs");
  } else invalid("unsupported content type");
}

/** Packages are external inputs. Validate structure/references before allocating any new identities. */
export function validateReviewNodeArchive(value: unknown): asserts value is ReviewNodeArchive {
  if (!object(value) || ![1, 2].includes(value.schemaVersion as number) || Object.keys(value).some(key => !["schemaVersion", "node", "state", "versions", "steps", "resources", "journal", "journalArchives"].includes(key))) invalid("unsupported package schema");
  json(value);
  if (!object(value.node) || !id(value.node.id) || !id(value.node.workspaceId) || !string(value.node.name) || !integer(value.node.revision) || typeof value.node.pinned !== "boolean" || !finite(value.node.createdAt) || !finite(value.node.updatedAt)) invalid("invalid node metadata");
  if (value.node.branch !== undefined && (!object(value.node.branch) || !id(value.node.branch.taskId) || !id(value.node.branch.sourceNodeId) || !integer(value.node.branch.sourceNodeRevision))) invalid("invalid historical branch origin");
  const state = value.state;
  if (!object(state) || state.schemaVersion !== 1 || !["batches", "items", "feedback", "handoffs"].every(key => Array.isArray(state[key]) && state[key].every(object))) invalid("invalid node state");
  if (!["versions", "steps", "resources", "journal", "journalArchives"].every(key => Array.isArray(value[key]))) invalid("missing package records");
  for (const key of ["versions", "steps", "resources", "journalArchives"]) if (!(value[key] as unknown[]).every(object)) invalid("invalid package record");
  const archive = value as unknown as ReviewNodeArchive;
  if (archive.schemaVersion === 1 && archive.versions.some(version => version.content?.type === "model3d")) invalid("model3d requires package schema 2");
  unique(archive.state.items.map(item => item.id), "item IDs");
  unique(archive.state.batches.map(batch => batch.id), "batch IDs");
  unique(archive.resources.map(resource => resource.id), "resource IDs");
  unique(archive.versions.map(version => `${version.itemId}:${version.version}`), "content versions");
  const resources = new Set(archive.resources.map(resource => resource.id));
  const versions = new Map(archive.versions.map(version => [`${version.itemId}:${version.version}`, version]));
  const items = new Map(archive.state.items.map(item => [item.id, item]));
  const batches = new Map(archive.state.batches.map(batch => [batch.id, batch]));
  for (const resource of archive.resources) {
    if (!id(resource.id) || !string(resource.originalFileName, 255) || /[\\/\0]/.test(resource.originalFileName) || !string(resource.mime, 200) || !integer(resource.size) || (resource.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(resource.sha256)) || "storage" in resource) invalid("invalid portable resource metadata");
    if (resource.unavailableReason !== undefined && !string(resource.unavailableReason, 2000)) invalid("invalid unavailable resource reason");
  }
  const requireResource = (resourceId: string) => { if (!id(resourceId) || !resources.has(resourceId)) invalid("missing referenced resource"); };
  for (const version of archive.versions) {
    if (version.nodeId !== archive.node.id || !id(version.itemId) || !integer(version.version, 1)) invalid("invalid version owner");
    if (version.content) content(version.content, version.version);
    else if (!string(version.unavailableReason, 2000)) invalid("missing version content without an explicit unavailable reason");
    if (version.content && version.unavailableReason) invalid("an available version cannot also claim a missing body");
    if (version.originalResourceId) requireResource(version.originalResourceId);
    if (version.content?.type === "image" || version.content?.type === "video") requireResource(version.content.mediaId);
    if (version.content?.type === "model3d") requireResource(version.content.resourceId);
    if (version.revision?.mediaId) requireResource(version.revision.mediaId);
  }
  for (const batch of archive.state.batches) {
    if (!id(batch.id) || !string(batch.name) || !Array.isArray(batch.itemIds) || batch.itemIds.some(itemId => items.get(itemId)?.batchId !== batch.id)) invalid("invalid batch membership");
    unique(batch.itemIds, "batch members");
  }
  for (const item of archive.state.items) {
    if (!id(item.id) || !batches.get(item.batchId)?.itemIds.includes(item.id) || !integer(item.version, 1) || !string(item.title, 1000) || !versions.has(`${item.id}:${item.version}`) || !["pending", "kept", "discarded", "modified", "rework"].includes(item.status) || !Array.isArray(item.decisionLog) || !Array.isArray(item.revisions) || !Array.isArray(item.provenanceTags) || !Array.isArray(item.userTags)) invalid("invalid review item");
    content(item.content, item.version);
    if (!versions.get(`${item.id}:${item.version}`)?.content) invalid("current item version must have real content");
    if (item.type !== item.content.type || !integer(item.orderIndex) || !finite(item.createdAt) || item.userTags.some(tag => typeof tag !== "string")) invalid("invalid item metadata");
    for (const tag of item.provenanceTags) if (!object(tag) || !string(tag.id) || typeof tag.shortName !== "string" || typeof tag.detailSummary !== "string" || !["declared", "verified", "unknown"].includes(String(tag.verification))) invalid("invalid provenance tag");
    if (item.agentGuidance && (!object(item.agentGuidance) || !["branchName", "nodeSlotLabel", "whatHappened", "whatToDoNext", "nodButtonLabel"].every(key => typeof (item.agentGuidance as unknown as Record<string, unknown>)[key] === "string"))) invalid("invalid agent guidance");
    for (const revision of item.revisions) if (!object(revision) || !id(revision.id) || revision.itemId !== item.id || !integer(revision.parentVersion, 1) || !integer(revision.producedVersion, 1) || !versions.has(`${item.id}:${revision.producedVersion}`)) invalid("invalid revision reference");
    for (const decision of item.decisionLog) if (!object(decision) || !integer(decision.baseVersion, 1) || !integer(decision.decisionRevision, 1) || !["kept", "discarded", "modified", "rework"].includes(String(decision.decision)) || !["human", "agent"].includes(String(decision.operator)) || !versions.has(`${item.id}:${decision.baseVersion}`)) invalid("invalid decision version");
  }
  for (const feedback of archive.state.feedback) {
    if (!id(feedback.id) || !versions.has(`${feedback.itemId}:${feedback.itemVersion}`) || typeof feedback.text !== "string" || !Array.isArray(feedback.referencedTagIds) || !["draft", "confirmed"].includes(feedback.state)) invalid("invalid feedback owner");
    if (feedback.target && (!object(feedback.target) || !["whole-item", "pixel-region", "text-range", "data-cell", "video-marker", "model-view"].includes(feedback.target.kind))) invalid("invalid feedback target");
  }
  const observation = (target: WorkbenchProjectState["feedback"][number]["target"]) => {
    if (target?.kind === "model-view") {
      if (archive.schemaVersion < 2 || !string(target.observationId) || !isModelObservation(target.observation)) invalid("invalid model observation");
      requireResource(target.resourceId); requireResource(target.screenshotResourceId);
    }
  };
  for (const feedback of archive.state.feedback) observation(feedback.target);
  for (const handoff of archive.state.handoffs) {
    if (!id(handoff.handoffId) || !batches.has(handoff.batchId) || !Array.isArray(handoff.items)) invalid("invalid handoff owner");
    for (const item of handoff.items) {
      if (!versions.has(`${item.itemId}:${item.itemVersion}`)) invalid("missing handoff version");
      if (item.resourceId) requireResource(item.resourceId);
      for (const issue of item.issues ?? []) observation(issue.target);
      if (item.mediaId) requireResource(item.mediaId);
      if (item.derivedMediaId) requireResource(item.derivedMediaId);
    }
  }
  validateReviewSteps(archive.node.id, [], archive.steps);
  for (const history of archive.journalArchives) {
    if (!id(history.sourceNodeId) || !Array.isArray(history.records) || !Array.isArray(history.idMap)) invalid("invalid historical journal archive");
    for (const entry of history.idMap) if (!object(entry) || !string(entry.kind) || !string(entry.oldId) || !id(entry.newId)) invalid("invalid historical identity map");
  }
  for (const step of archive.steps) for (const reference of [...step.inputs, ...step.outputs]) {
    if ("resourceId" in reference) requireResource(reference.resourceId);
    else if (!versions.has(`${reference.itemId}:${reference.version}`)) invalid("missing processing version");
  }
}

const fields: Readonly<Record<string, string>> = {
  screenshotResourceId: "resource", observationId: "observation",
  itemId: "item", sourceItemId: "item", parentNodeId: "item", batchId: "batch", mediaId: "resource", resourceId: "resource", originalResourceId: "resource", derivedMediaId: "resource",
  entryId: "entry", datasetId: "dataset", columnId: "column", rowId: "row", proposalId: "proposal", annotationId: "annotation", markerId: "marker", feedbackId: "feedback", issueId: "issue", tagId: "tag",
  revisionId: "revision", contentRevisionId: "revision", handoffId: "handoff", supersedesHandoffId: "handoff", fromHandoffId: "handoff", runId: "run", supersedesStepId: "step",
  provenanceTagId: "tag", compareWithItemId: "item", similarToEntryId: "entry",
};
const arrays: Readonly<Record<string, string>> = { itemIds: "item", returnedItemIds: "item", feedbackIds: "feedback", referencedTagIds: "tag" };
const collections: Readonly<Record<string, string>> = { batches: "batch", items: "item", feedback: "feedback", handoffs: "handoff", revision: "revision", revisions: "revision", annotations: "annotation", imageAnnotations: "annotation", strokes: "stroke", markers: "marker", videoMarkers: "marker", provenanceTags: "tag", referencedTags: "tag", issues: "issue", steps: "step" };

export function reviewRestoreId(restoreId: string, kind: string, oldId: string): string { return uuidv5(`${kind}:${oldId}`, restoreId); }

/** Remap identities/references only. User text and cell values that happen to contain IDs remain exact. */
export function remapReviewNodeArchive(archive: ReviewNodeArchive, restoreId: string, destinationNodeId?: string) {
  validateReviewNodeArchive(archive);
  if (destinationNodeId !== undefined && !id(destinationNodeId)) invalid("destination node must be a UUID");
  return remapArchiveIdentities(archive, restoreId, destinationNodeId);
}

/** A local fork shares registered resources; packages still allocate independent resources. */
export function forkReviewNodeArchive(archive: ReviewNodeArchive, taskId: string) {
  validateReviewNodeArchive(archive);
  return remapArchiveIdentities(archive, taskId, reviewRestoreId(taskId, "node", "branch"), true);
}

/** Internal legacy adapter: short source IDs become UUIDs before package validation. */
export function normalizeLegacyReviewNodeArchive(archive: ReviewNodeArchive, namespace: string) {
  const mapped = remapArchiveIdentities(archive, namespace);
  const resourceIds = new Map(mapped.idMap.filter(entry => entry.kind === "resource").map(entry => [entry.oldId, entry.newId]));
  const normalized: ReviewNodeArchive = { ...archive, node: { ...archive.node, id: mapped.nodeId }, state: mapped.state,
    versions: mapped.versions, steps: mapped.steps, resources: archive.resources.map(resource => ({ ...resource, id: resourceIds.get(resource.id)! })),
    journal: [], journalArchives: mapped.journalArchives };
  validateReviewNodeArchive(normalized);
  return { archive: normalized, idMap: mapped.idMap };
}

function remapArchiveIdentities(archive: ReviewNodeArchive, restoreId: string, destinationNodeId?: string, shareResources = false) {
  if (!id(restoreId)) invalid("restore operation must be a UUID");
  const allocated = new Map<string, ReviewIdMapping>();
  const map = (kind: string, oldId: string): string => {
    const key = `${kind}:${oldId}`;
    if (!oldId) invalid("empty source identity");
    const entry = allocated.get(key) ?? { kind, oldId, newId: shareResources && kind === "resource" ? oldId : kind === "node" && oldId === archive.node.id && destinationNodeId ? destinationNodeId : reviewRestoreId(restoreId, kind, oldId) };
    allocated.set(key, entry); return entry.newId;
  };
  const walk = (value: unknown, owner = "embedded"): unknown => {
    if (Array.isArray(value)) return value.map(entry => walk(entry, owner));
    if (!object(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      if (key === "cells" && object(entry)) return [key, Object.fromEntries(Object.entries(entry).map(([columnId, cell]) => [map("column", columnId), cell]))];
      if (key === "id" && typeof entry === "string") return [key, map(owner, entry)];
      if (key === "nodeId" && entry === archive.node.id) return [key, map("node", entry)];
      if (fields[key] && typeof entry === "string") return [key, map(fields[key], entry)];
      if (arrays[key] && Array.isArray(entry)) return [key, entry.map(id => map(arrays[key], id))];
      if (key === "parameters") return [key, structuredClone(entry)];
      return [key, walk(entry, collections[key] ?? owner)];
    }));
  };
  const state = walk(archive.state) as WorkbenchProjectState;
  const versions = walk(archive.versions) as ReviewArchivedVersion[];
  const steps = walk(archive.steps, "step") as ReviewStep[];
  const nodeId = map("node", archive.node.id);
  for (const resource of archive.resources) map("resource", resource.id);
  const historicalState = { ...state, handoffs: state.handoffs.map(handoff => ({ ...handoff, historicalOnly: true as const, idempotencyKey: `history:${restoreId}:${handoff.handoffId}` })) };
  const journalArchives: ReviewJournalArchive[] = archive.journalArchives.map(history => ({ ...history, idMap: history.idMap.map(entry => ({ ...entry, newId: map(entry.kind, entry.newId) })) }));
  journalArchives.push({ sourceNodeId: archive.node.id, records: archive.journal, idMap: [...allocated.values()] });
  return { nodeId, state: historicalState, versions, steps, idMap: [...allocated.values()], journalArchives };
}
