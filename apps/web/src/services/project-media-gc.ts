import type { ActionHistory, MediaItem, Project } from "@reelterminal/core";
import {
  historyRetainsMediaBytes,
  projectRetainsWorkAssetMediaBytes,
} from "@reelterminal/core";
import { createIdbMaterialStorage } from "./material-library/storage";
import { createIdbAgentTaskStorage } from "./agent-media-tasks/storage";
import { workspaceManager, type MediaReferencePurpose } from "./workspace-manager";
import { getExportMediaReferences } from "./project-export-activity";
import { projectManager } from "./project-manager";
import { autoSaveManager } from "./auto-save";
import {
  deleteMediaBlobUnderReferenceWrite,
  getAllStoredMedia,
  withMediaReferenceWrite,
  type StoredMediaEntry,
} from "./media-storage";

export type MediaReferenceKind =
  | "node"
  | "workspace-draft"
  | "recovery-draft"
  | "history"
  | "task"
  | "material"
  | "work-asset"
  | "pending";

export interface MediaReference {
  readonly mediaId: string;
  readonly projectId: string;
  readonly kind: MediaReferenceKind;
  readonly referenceId: string;
  readonly label?: string;
  /**
   * Machine-readable retention purpose; `label` is display-only. Retention
   * decisions key on this field. A task-kind reference without an explicit
   * purpose is conservatively retained (treated like a task result, never
   * as a purgeable task input).
   */
  readonly purpose?: MediaReferencePurpose;
}

export interface MediaReferenceScope {
  readonly projectId?: string;
  readonly mediaId?: string;
}

export type MediaReferenceProvider = (
  scope?: MediaReferenceScope,
) => Promise<readonly MediaReference[]>;

export interface MediaCleanupEntry {
  readonly projectId: string;
  readonly mediaId: string;
  readonly sizeBytes: number;
  readonly idbSizeBytes: number;
  readonly controlledSizeBytes: number;
  readonly controlledPath?: string;
  readonly controlledFiles: readonly { readonly path: string; readonly sizeBytes: number }[];
  readonly files: readonly {
    readonly storage: "indexeddb" | "controlled-file";
    readonly path: string;
    readonly sizeBytes: number;
  }[];
  readonly reasons: readonly string[];
}

export interface MediaCleanupPlan {
  readonly id: string;
  readonly projectId?: string;
  readonly createdAt: number;
  readonly referenceScanReady: boolean;
  readonly referenceScanError?: string;
  readonly candidates: readonly MediaCleanupEntry[];
  readonly retained: readonly MediaCleanupEntry[];
  readonly reclaimableBytes: number;
  readonly retainedBytes: number;
}

export interface MediaCleanupResult {
  readonly planId: string;
  readonly deleted: readonly MediaCleanupEntry[];
  readonly skipped: readonly { readonly entry: MediaCleanupEntry; readonly reason: string }[];
  readonly reclaimedBytes: number;
}

const referenceProviders = new Set<MediaReferenceProvider>();
const uncommittedMedia = new Map<string, string | undefined>();
const attachedHistories = new WeakMap<ActionHistory, () => void>();
const cleanupPlans = new Map<string, MediaCleanupPlan>();
const materialStorage = createIdbMaterialStorage();
const agentTaskStorage = createIdbAgentTaskStorage();

export function registerMediaReferenceProvider(
  provider: MediaReferenceProvider,
): () => void {
  referenceProviders.add(provider);
  return () => referenceProviders.delete(provider);
}

export function trackUncommittedMediaBlob(mediaId: string, projectId?: string): void {
  uncommittedMedia.set(mediaId, projectId);
}

export function releaseUncommittedMediaBlob(mediaId: string): void {
  uncommittedMedia.delete(mediaId);
}

function itemReference(project: Project, item: MediaItem): MediaReference {
  return {
    mediaId: item.id,
    projectId: project.id,
    kind: "workspace-draft",
    referenceId: "runtime-project",
    label: "Open workspace media library",
  };
}

async function collectReferences(scope: MediaReferenceScope = {}): Promise<MediaReference[]> {
  const references: MediaReference[] = [];
  for (const provider of referenceProviders) {
    references.push(...await provider(scope));
  }
  for (const [mediaId, projectId] of uncommittedMedia) {
    if (scope.mediaId && scope.mediaId !== mediaId) continue;
    references.push({
      mediaId,
      projectId: projectId ?? scope.projectId ?? "",
      kind: "pending",
      referenceId: mediaId,
      label: "Media import is not committed yet",
    });
  }
  return references;
}

function filterWorkspaceScope(
  references: readonly MediaReference[],
  workspaceId?: string,
): MediaReference[] {
  if (!workspaceId) return [...references];
  return references.filter((reference) =>
    reference.referenceId === workspaceId ||
    reference.kind === "node" ||
    reference.kind === "task" ||
    reference.kind === "material" ||
    reference.kind === "pending",
  );
}

export async function getMediaReferences(input: {
  projectId: string;
  mediaId: string;
  workspaceId?: string;
}): Promise<MediaReference[]> {
  const references = await collectReferences({ mediaId: input.mediaId });
  return filterWorkspaceScope(references, input.workspaceId);
}

function cleanupEntry(record: StoredMediaEntry, reasons: readonly string[]): MediaCleanupEntry {
  const idbSizeBytes = record.blob?.size ?? 0;
  const controlledFiles = record.controlledFiles ?? (record.contentUrl
    ? [{ path: record.contentUrl, sizeBytes: record.sizeBytes }]
    : []);
  const controlledSizeBytes = controlledFiles.reduce((total, file) => total + file.sizeBytes, 0);
  const files = [
    ...(idbSizeBytes > 0 ? [{
      storage: "indexeddb" as const,
      path: `IndexedDB media record ${record.id}`,
      sizeBytes: idbSizeBytes,
    }] : []),
    ...controlledFiles.map((file) => ({ storage: "controlled-file" as const, ...file })),
  ];
  return {
    projectId: record.projectId,
    mediaId: record.id,
    sizeBytes: idbSizeBytes + controlledSizeBytes,
    idbSizeBytes,
    controlledSizeBytes,
    ...(record.contentUrl ? { controlledPath: record.contentUrl } : {}),
    controlledFiles,
    files,
    reasons,
  };
}

function sizeOf(entries: readonly MediaCleanupEntry[]): number {
  return entries.reduce((total, entry) => total + entry.sizeBytes, 0);
}

/** Preview cleanup after these projects' workspaces/history have been removed. */
export async function estimateProjectPurge(projectIds: readonly string[]): Promise<{ bytes: number; mediaIds: string[] }> {
  const [records, references] = await Promise.all([getAllStoredMedia(), collectReferences()]);
  const ownReferences = references.filter((reference) => projectIds.includes(reference.projectId));
  const mediaIds = new Set(ownReferences.map((reference) => reference.mediaId));
  for (const record of records) {
    if ((record.projectIds ?? [record.projectId]).some((id) => projectIds.includes(id))) mediaIds.add(record.id);
  }
  // Retention keys on the explicit reference purpose, never the display
  // label: only retained task INPUTS are purge candidates with their project.
  // A task reference without a purpose (legacy or third-party producer) is
  // conservatively kept.
  const retained = references.filter((reference) =>
    !projectIds.includes(reference.projectId) || reference.kind === "material" ||
    reference.kind === "pending" ||
    (reference.kind === "task" && reference.purpose !== "task-input"),
  );
  const candidates = records.filter((record) => mediaIds.has(record.id) && !uncommittedMedia.has(record.id) &&
    !retained.some((reference) => reference.mediaId === record.id));
  return { bytes: sizeOf(candidates.map((record) => cleanupEntry(record, []))), mediaIds: [...mediaIds] };
}

export async function createMediaCleanupPlan(
  projectId?: string | readonly string[],
  mediaIds: readonly string[] = [],
): Promise<MediaCleanupPlan> {
  await workspaceManager.initialize();
  const scopeIds = projectId === undefined
    ? []
    : typeof projectId === "string"
      ? [projectId]
      : [...projectId];
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let records: StoredMediaEntry[] = [];
  let references: MediaReference[] = [];
  let referenceScanError: string | undefined;
  try {
    [records, references] = await Promise.all([
      getAllStoredMedia(),
      collectReferences(),
    ]);
  } catch (error) {
    referenceScanError = error instanceof Error ? error.message : "Media references could not be read";
  }

  const candidates: MediaCleanupEntry[] = [];
  const retained: MediaCleanupEntry[] = [];
  for (const record of records) {
    const recordProjectIds = record.projectIds ?? [record.projectId];
    const projectReferences = references.filter((reference) =>
      reference.mediaId === record.id && scopeIds.includes(reference.projectId),
    );
    if (scopeIds.length > 0 && !recordProjectIds.some((pid) => scopeIds.includes(pid)) && projectReferences.length === 0 && !mediaIds.includes(record.id)) continue;
    const reasons = references
      .filter((reference) => reference.mediaId === record.id)
      .map((reference) => reference.label
        ? `${reference.kind}: ${reference.label} (${reference.referenceId})`
        : `${reference.kind}: ${reference.referenceId}`);
    if (uncommittedMedia.has(record.id)) {
      reasons.push("pending: Media import is not committed yet");
    }
    if (referenceScanError) {
      retained.push(cleanupEntry(record, [`Reference scan failed: ${referenceScanError}`]));
    } else if (reasons.length > 0) {
      retained.push(cleanupEntry(record, reasons));
    } else {
      candidates.push(cleanupEntry(record, ["No retained node, workspace, recovery, task, history, or material reference was found."]));
    }
  }

  const plan: MediaCleanupPlan = {
    id,
    ...(scopeIds.length === 1 ? { projectId: scopeIds[0] } : {}),
    createdAt: Date.now(),
    referenceScanReady: !referenceScanError,
    ...(referenceScanError ? { referenceScanError } : {}),
    candidates,
    retained,
    reclaimableBytes: sizeOf(candidates),
    retainedBytes: sizeOf(retained),
  };
  cleanupPlans.set(plan.id, plan);
  while (cleanupPlans.size > 20) {
    const oldest = cleanupPlans.keys().next().value;
    if (oldest === undefined) break;
    cleanupPlans.delete(oldest);
  }
  return plan;
}

export async function planMediaCleanup(input: { projectId?: string } = {}): Promise<MediaCleanupPlan> {
  return createMediaCleanupPlan(input.projectId);
}

export async function executeMediaCleanupPlan(
  input: MediaCleanupPlan | { readonly projectId?: string; readonly plan: MediaCleanupPlan },
): Promise<MediaCleanupResult> {
  const plan = "plan" in input ? input.plan : input;
  const requestedProjectId = input.projectId;
  const approvedPlan = cleanupPlans.get(plan.id);
  if (!approvedPlan || JSON.stringify(approvedPlan) !== JSON.stringify(plan)) {
    throw new Error("Cleanup plan is unknown, expired, or was modified after review");
  }
  if (requestedProjectId && plan.projectId && requestedProjectId !== plan.projectId) {
    throw new Error("Cleanup project does not match the reviewed plan");
  }
  if (!plan.referenceScanReady) {
    cleanupPlans.delete(plan.id);
    return {
      planId: plan.id,
      deleted: [],
      skipped: plan.candidates.map((entry) => ({
        entry,
        reason: plan.referenceScanError ?? "The cleanup plan did not include a complete reference scan",
      })),
      reclaimedBytes: 0,
    };
  }

  // initialize() may migrate the open project and uses the same reference
  // write queue; finish that work before entering the final scan/delete lock.
  await workspaceManager.initialize();

  const result = await withMediaReferenceWrite(async () => {
      const [records, references] = await Promise.all([
      getAllStoredMedia(),
      collectReferences(),
    ]);
    const recordsByKey = new Map(records.map((record) => [`${record.projectId}:${record.id}`, record]));
    const deleted: MediaCleanupEntry[] = [];
    const skipped: Array<{ entry: MediaCleanupEntry; reason: string }> = [];
    for (const entry of plan.candidates) {
      const record = recordsByKey.get(`${entry.projectId}:${entry.mediaId}`);
      if (!record) {
        skipped.push({ entry, reason: "Media bytes were already removed" });
        continue;
      }
      const current = cleanupEntry(record, []);
      if (
        current.idbSizeBytes !== entry.idbSizeBytes ||
      current.controlledSizeBytes !== entry.controlledSizeBytes ||
        current.controlledPath !== entry.controlledPath ||
        JSON.stringify(current.controlledFiles) !== JSON.stringify(entry.controlledFiles)
      ) {
        skipped.push({ entry, reason: "Stored media changed after the cleanup plan was created" });
        continue;
      }
      const reasons = references.filter((reference) =>
        reference.mediaId === entry.mediaId,
      );
      if (reasons.length > 0 || uncommittedMedia.has(entry.mediaId)) {
        skipped.push({
          entry,
          reason: reasons.length > 0
            ? `A media reference appeared after planning (${reasons[0].kind}: ${reasons[0].referenceId})`
            : "A media import is still being committed",
        });
        continue;
      }
      try {
        await deleteMediaBlobUnderReferenceWrite(entry.mediaId);
        deleted.push(entry);
      } catch (error) {
        skipped.push({
          entry,
          reason: error instanceof Error ? error.message : "Media bytes could not be removed",
        });
      }
    }
    return {
      planId: plan.id,
      deleted,
      skipped,
      reclaimedBytes: sizeOf(deleted),
    };
  });
  cleanupPlans.delete(plan.id);
  return result;
}

export async function executeMediaCleanupById(
  planId: string,
  projectId?: string,
): Promise<MediaCleanupResult> {
  const plan = cleanupPlans.get(planId);
  if (!plan) throw new Error("Cleanup plan is unknown or expired; create a fresh plan before execution");
  return executeMediaCleanupPlan({ projectId, plan });
}

export async function executeMediaCleanup(
  input: MediaCleanupPlan | { readonly projectId?: string; readonly plan: MediaCleanupPlan },
): Promise<MediaCleanupResult> {
  return executeMediaCleanupPlan(input);
}

export async function listNodeMedia(input: {
  projectId: string;
  nodeId: string;
}): Promise<{
  projectId: string;
  nodeId: string;
  media: MediaItem[];
  missingDependencyIds: string[];
  timelineUsedMediaIds: string[];
}> {
  const node = await workspaceManager.getNode(input.projectId, input.nodeId);
  if (!node || node.projectId !== input.projectId) throw new Error("Version node was not found in this project");
  const project = node.project;
  const timelineUsedMediaIds = [...new Set(project.timeline.tracks.flatMap((track) =>
    track.clips.map((clip) => clip.mediaId),
  ))];
  return {
    projectId: input.projectId,
    nodeId: input.nodeId,
    media: project.mediaLibrary.items.map((item) => ({ ...item, blob: null, fileHandle: null })),
    missingDependencyIds: [...node.missingDependencies],
    timelineUsedMediaIds,
  };
}

export async function compareNodes(input: {
  projectId: string;
  fromNodeId: string;
  toNodeId: string;
}): Promise<{
  projectId: string;
  fromNodeId: string;
  toNodeId: string;
  added: string[];
  replaced: Array<{ fromMediaId: string; toMediaId: string }>;
  removed: string[];
  used: { added: string[]; removed: string[]; replaced: Array<{ fromMediaId: string; toMediaId: string }> };
}> {
  const [from, to] = await Promise.all([
    workspaceManager.getNode(input.projectId, input.fromNodeId),
    workspaceManager.getNode(input.projectId, input.toNodeId),
  ]);
  if (!from || !to || from.projectId !== input.projectId || to.projectId !== input.projectId) {
    throw new Error("Both version nodes must belong to the requested project");
  }
  const fromItems = new Map(from.project.mediaLibrary.items.map((item) => [item.id, item]));
  const toItems = new Map(to.project.mediaLibrary.items.map((item) => [item.id, item]));
  const replacements = [...toItems.values()].flatMap((item) => {
    const sourceId = item.versionSource?.supersedesMediaIdInProject;
    // A retained version's lineage is not a change between these snapshots.
    return sourceId && !fromItems.has(item.id) && fromItems.has(sourceId)
      ? [{ fromMediaId: sourceId, toMediaId: item.id }]
      : [];
  });
  const replacedFrom = new Set(replacements.map((replacement) => replacement.fromMediaId));
  const replacedTo = new Set(replacements.map((replacement) => replacement.toMediaId));
  const added = [...toItems.keys()].filter((id) => !fromItems.has(id) && !replacedTo.has(id));
  const removed = [...fromItems.keys()].filter((id) => !toItems.has(id) && !replacedFrom.has(id));

  const timelineIds = (project: Project) => new Set(project.timeline.tracks.flatMap((track) =>
    track.clips.map((clip) => clip.mediaId),
  ));
  const fromUsed = timelineIds(from.project);
  const toUsed = timelineIds(to.project);
  const fromClips = new Map(from.project.timeline.tracks.flatMap((track) =>
    track.clips.map((clip) => [clip.id, clip.mediaId] as const),
  ));
  const usedReplacements: Array<{ fromMediaId: string; toMediaId: string }> = [];
  for (const track of to.project.timeline.tracks) {
    for (const clip of track.clips) {
      const fromMediaId = fromClips.get(clip.id);
      if (fromMediaId === undefined || fromMediaId === clip.mediaId) continue;
      if (usedReplacements.some((pair) => pair.fromMediaId === fromMediaId && pair.toMediaId === clip.mediaId)) continue;
      usedReplacements.push({ fromMediaId, toMediaId: clip.mediaId });
    }
  }
  const usedReplacedFrom = new Set(usedReplacements.map((replacement) => replacement.fromMediaId));
  const usedReplacedTo = new Set(usedReplacements.map((replacement) => replacement.toMediaId));
  return {
    projectId: input.projectId,
    fromNodeId: input.fromNodeId,
    toNodeId: input.toNodeId,
    added,
    replaced: replacements,
    removed,
    used: {
      added: [...toUsed].filter((id) => !fromUsed.has(id) && !usedReplacedTo.has(id)),
      removed: [...fromUsed].filter((id) => !toUsed.has(id) && !usedReplacedFrom.has(id)),
      replaced: usedReplacements,
    },
  };
}

export function attachProjectMediaGc(
  history: ActionHistory,
  getProject: () => Project,
): void {
  const previousDetach = attachedHistories.get(history);
  if (previousDetach) return;
  const unregister = registerMediaReferenceProvider(async (scope) => {
    const project = getProject();
    if (scope?.projectId && scope.projectId !== project.id) return [];
    const references = project.mediaLibrary.items
      .filter((item) => !scope?.mediaId || scope.mediaId === item.id)
      .map((item) => itemReference(project, item));
    for (const item of project.mediaLibrary.items) {
      if (scope?.mediaId && item.id !== scope.mediaId) continue;
      if (projectRetainsWorkAssetMediaBytes(project, item.id)) {
        references.push({
          mediaId: item.id,
          projectId: project.id,
          kind: "work-asset",
          referenceId: "workAssets",
          label: "Saved work asset source",
        });
      }
    }
    const stored = await getAllStoredMedia();
    for (const record of stored) {
      if (record.projectId !== project.id || (scope?.mediaId && scope.mediaId !== record.id)) continue;
      if (projectRetainsWorkAssetMediaBytes(project, record.id)) {
        references.push({
          mediaId: record.id,
          projectId: project.id,
          kind: "work-asset",
          referenceId: "workAssets",
          label: "Saved work asset source",
        });
      }
      if (historyRetainsMediaBytes(history, record.id)) {
        references.push({
          mediaId: record.id,
          projectId: project.id,
          kind: "history",
          referenceId: "runtime-history",
          label: "Undo or redo can restore this media",
        });
      }
    }
    return references;
  });
  attachedHistories.set(history, () => {
    unregister();
  });
}

export function detachProjectMediaGc(history: ActionHistory): void {
  const detach = attachedHistories.get(history);
  if (!detach) return;
  attachedHistories.delete(history);
  detach();
}

export function ensureProjectMediaGc(
  history: ActionHistory,
  getProject: () => Project,
): void {
  if (attachedHistories.has(history)) return;
  attachProjectMediaGc(history, getProject);
}

registerMediaReferenceProvider(async (scope) => [
  ...getExportMediaReferences().filter((reference) =>
    (!scope?.projectId || scope.projectId === reference.projectId) && (!scope?.mediaId || scope.mediaId === reference.mediaId)),
  ...await workspaceManager.getMediaReferences(scope),
  ...await workspaceManager.getRuntimeMediaReferences(scope),
]);

registerMediaReferenceProvider(async (scope) => {
  const [snapshots, recoveries, projects] = await Promise.all([
    projectManager.listStoredProjects(), autoSaveManager.listRecoveryProjects(), workspaceManager.listProjects(true),
  ]);
  const deleted = new Set(projects.filter((project) => project.deletedAt !== undefined).map((project) => project.id));
  const retained = [
    ...snapshots.map((project) => ({ id: `legacy:${project.id}`, project })),
    ...recoveries.map((record) => ({ ...record, id: `autosave:${record.id}` })),
  ];
  return retained.filter(({ project }) => !deleted.has(project.id) && (!scope?.projectId || scope.projectId === project.id))
    .flatMap(({ id, project }) => project.mediaLibrary.items
      .filter((item) => !scope?.mediaId || scope.mediaId === item.id)
      .map((item): MediaReference => ({ mediaId: item.id, projectId: project.id, kind: "recovery-draft", referenceId: id, label: "Retained local recovery" })));
});

registerMediaReferenceProvider(async (scope) => {
  const query = scope ?? {};
  const { materials: records, journal } = await materialStorage.loadSnapshot();
  const undoableRecords = journal.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const changes = (entry as { changes?: unknown }).changes;
    if (!Array.isArray(changes)) return [];
    return changes.flatMap((change) => {
      if (!change || typeof change !== "object") return [];
      const recordChange = change as { before?: unknown; after?: unknown; materialId?: unknown };
      return [recordChange.before, recordChange.after]
        .filter((record) => record && typeof record === "object")
        .map((record) => ({
          record,
          journalId: (entry as { id?: unknown }).id,
          materialId: recordChange.materialId,
        }));
    });
  });
  const references: MediaReference[] = [];
  const allRecords = [
    ...records.map((record) => ({ record, journalId: undefined, materialId: undefined })),
    ...undoableRecords,
  ];
  for (const item of allRecords) {
    const value = item.record;
    if (!value || typeof value !== "object") continue;
    const material = value as {
      id?: unknown;
      title?: unknown;
      usages?: unknown;
    };
    if (typeof material.id !== "string" || !Array.isArray(material.usages)) continue;
    for (const [usageIndex, rawUsage] of material.usages.entries()) {
      if (!rawUsage || typeof rawUsage !== "object") continue;
      const usage = rawUsage as {
        projectId?: unknown;
        status?: unknown;
        mediaIdInProject?: unknown;
        replacedByMediaIdInProject?: unknown;
        replacesMediaIdInProject?: unknown;
      };
      if (query.projectId && usage.projectId !== query.projectId) continue;
      const mediaIds = new Set([
        usage.mediaIdInProject,
        usage.replacedByMediaIdInProject,
        usage.replacesMediaIdInProject,
      ].filter((mediaId): mediaId is string => typeof mediaId === "string" && mediaId.length > 0));
      for (const mediaId of mediaIds) {
        if (query.mediaId && mediaId !== query.mediaId) continue;
        references.push({
          mediaId,
          projectId: typeof usage.projectId === "string" ? usage.projectId : "",
          kind: "material",
          referenceId: item.journalId
            ? `${item.journalId}:${String(item.materialId ?? material.id)}:${usageIndex}`
            : `${material.id}:${usageIndex}`,
          ...(typeof material.title === "string"
            ? { label: item.journalId ? `Undo/redo: ${material.title}` : material.title }
            : {}),
        });
      }
    }
  }
  return references;
});

registerMediaReferenceProvider(async (scope) => {
  const query = scope ?? {};
  const rows = await agentTaskStorage.loadAll();
  return rows.flatMap((value): MediaReference[] => {
    if (!value || typeof value !== "object") return [];
    const task = value as { id?: unknown; targetProjectId?: unknown; resultMediaId?: unknown };
    if (typeof task.resultMediaId !== "string" || task.resultMediaId.length === 0) return [];
    if (query.mediaId && query.mediaId !== task.resultMediaId) return [];
    if (query.projectId && query.projectId !== task.targetProjectId) return [];
    return [{
      mediaId: task.resultMediaId,
      projectId: typeof task.targetProjectId === "string" ? task.targetProjectId : "",
      kind: "task",
      referenceId: typeof task.id === "string" ? task.id : task.resultMediaId,
      label: "Imported task result",
      purpose: "task-result",
    }];
  });
});
