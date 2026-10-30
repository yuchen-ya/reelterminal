import type { ProjectCleanupHandoff } from "@reelterminal/core";
import type { ProjectNodeSummary, WorkspaceTarget } from "./workspace-manager";
import {
  workspaceManager,
  type CleanupNodeLifecycleAction,
  type CleanupNodeVersion,
} from "./workspace-manager";
import {
  deleteMediaBlobUnderReferenceWrite,
  deleteStoredCacheIfUnchanged,
  getAllStoredCache,
  getAllStoredMedia,
  hasCompleteControlledMediaFingerprint,
  isControlledMediaStorageAvailable,
  withMediaReferenceWrite,
  type ControlledMediaFileFingerprint,
  type StoredCacheEntry,
  type StoredMediaEntry,
} from "./media-storage";
import {
  scanMediaReferences,
  type MediaReference,
} from "./project-media-gc";
import { getExportingProjectIds } from "./project-export-activity";
import { advanceCleanupReviewPhase } from "./cleanup-handoff";
import { artifactPathKey } from "./artifact-paths";
import { scanArtifactPathReferences } from "./artifact-path-references";
import type { ProjectLibraryTrackedArtifactFile, ProjectLibraryTrackedWorkFingerprint } from "../../../desktop/src/shared/project-library-cleanup";

export interface CleanupTarget extends WorkspaceTarget {
  readonly exportId?: string;
  /** Requirement id that owns this review lifecycle, when a board task exists. */
  readonly cleanupTaskId?: string;
}

export type CleanupAction =
  | "purge-media"
  | "purge-deleted-nodes"
  | "recycle-nodes"
  | "restore-nodes"
  | "purge-cache"
  | "purge-failed-jobs"
  | "purge-work-files";

export interface CleanupSelection {
  readonly nodeIds?: readonly string[];
  readonly mediaIds?: readonly string[];
  readonly cacheKeys?: readonly string[];
  readonly jobIds?: readonly string[];
  readonly workFileIds?: readonly string[];
}

export interface CleanupWorkFile extends ProjectLibraryTrackedArtifactFile {
  readonly jobId: string;
  readonly selectionId: string;
  readonly taskState: CleanupTaskReviewEntry["state"];
  readonly retainedBy: readonly string[];
}

export interface CleanupTaskFile {
  readonly jobId: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly lastModifiedMs: number;
}

export interface CleanupFailedJobCandidate {
  readonly jobId: string;
  readonly kind: "export" | "analysis" | "audio-process";
  readonly state: "error" | "cancelled";
  readonly sourceRevision: number;
  readonly files: readonly CleanupTaskFile[];
  readonly reclaimableBytes: number;
  readonly retainedReason: string;
  readonly reasons: readonly string[];
}

export interface CleanupTaskReviewEntry {
  readonly jobId: string;
  readonly kind: "export" | "analysis" | "audio-process";
  readonly state: "queued" | "running" | "done" | "error" | "cancelled";
  readonly sourceRevision: number;
  readonly files: readonly CleanupTaskFile[];
  readonly retainedReason: string;
  readonly candidate: boolean;
}

export interface CleanupReferenceSummary {
  readonly mediaId: string;
  readonly projectId: string;
  readonly kind: MediaReference["kind"];
  readonly referenceId: string;
  readonly label?: string;
  readonly purpose?: MediaReference["purpose"];
}

export interface CleanupReviewNode {
  readonly nodeId: string;
  readonly name: string;
  readonly summary: string;
  readonly createdAt: number;
  readonly parentNodeIds: readonly string[];
  readonly childNodeIds: readonly string[];
  readonly dependentWorkspaceIds: readonly string[];
  readonly deletedAt?: number;
  readonly media: readonly {
    readonly mediaId: string;
    readonly sizeBytes: number | null;
    readonly relation: "shared" | "exclusive" | "unknown";
    readonly retainedBy: readonly CleanupReferenceSummary[];
  }[];
}

export interface CleanupReview {
  readonly target: CleanupTarget;
  readonly cleanupTask?: {
    readonly cleanupTaskId: string;
    readonly handoff: ProjectCleanupHandoff;
  };
  readonly revision: number;
  readonly workspaceInstanceId: string;
  readonly nodes: readonly CleanupReviewNode[];
  readonly selected: {
    readonly nodeIds: readonly string[];
    readonly mediaIds: readonly string[];
    readonly exclusiveMediaIds: readonly string[];
    readonly reclaimableBytes: number;
  };
  readonly retainedSummary: {
    readonly references: readonly CleanupReferenceSummary[];
    readonly unknown: boolean;
  };
  readonly cache: {
    readonly entries: number | null;
    readonly sizeBytes: number | null;
    readonly activeExport: boolean;
  };
  readonly failedJobs: {
    readonly tasks: readonly CleanupTaskReviewEntry[];
    readonly unknowns: readonly string[];
    readonly scanReady: boolean;
  };
  readonly workFiles: {
    readonly files: readonly CleanupWorkFile[];
    readonly scanReady: boolean;
    readonly unknowns: readonly string[];
  };
  readonly scanReady: boolean;
  readonly unknowns: readonly string[];
}

export interface CleanupConfirmation {
  readonly planId: string;
  readonly target: CleanupTarget;
  readonly action: CleanupAction;
  readonly revision: number;
  readonly workspaceInstanceId: string;
  readonly nodeIds: readonly string[];
  readonly mediaIds: readonly string[];
  readonly cacheKeys: readonly string[];
  readonly cleanupTaskNodeIds: readonly string[];
  readonly jobIds: readonly string[];
  readonly jobFiles: readonly CleanupTaskFile[];
  readonly workFiles?: readonly ProjectLibraryTrackedWorkFingerprint[];
}

export interface CleanupPlan {
  readonly planId: string;
  readonly target: CleanupTarget;
  readonly action: CleanupAction;
  readonly revision: number;
  readonly workspaceInstanceId: string;
  readonly selection: {
    readonly nodeIds: readonly string[];
    readonly mediaIds: readonly string[];
    readonly cacheKeys: readonly string[];
    readonly jobIds: readonly string[];
    readonly workFileIds?: readonly string[];
  };
  /** Exact scope the user must confirm. The executor additionally requires confirmed: true. */
  readonly confirmation: CleanupConfirmation;
  readonly status: "ready" | "review-required";
  readonly scanReady: boolean;
  readonly blockers: readonly string[];
  readonly candidateMedia: readonly {
    readonly mediaId: string;
    readonly sizeBytes: number;
    readonly files: readonly { readonly storage: "indexeddb" | "controlled-file"; readonly path: string; readonly sizeBytes: number; readonly lastModifiedMs?: number }[];
    readonly reasons: readonly string[];
  }[];
  readonly retainedMedia: readonly {
    readonly mediaId: string;
    readonly sizeBytes: number | null;
    readonly retainedBy: readonly CleanupReferenceSummary[];
    readonly reasons: readonly string[];
  }[];
  readonly candidateCache: readonly {
    readonly key: string;
    readonly sizeBytes: number;
    readonly timestamp: number;
    readonly reasons: readonly string[];
  }[];
  readonly candidateJobs: readonly CleanupFailedJobCandidate[];
  readonly retainedJobs: readonly CleanupTaskReviewEntry[];
  readonly candidateWorkFiles: readonly CleanupWorkFile[];
  readonly retainedWorkFiles: readonly CleanupWorkFile[];
  readonly unknowns: readonly string[];
  readonly reclaimableBytes: number;
  readonly createdAt: number;
  readonly cleanupTask?: {
    readonly cleanupTaskId: string;
    readonly handoff: ProjectCleanupHandoff;
  };
}

export interface CleanupExecutionInput extends CleanupConfirmation {
  readonly confirmed: true;
}

export interface CleanupExecutionResult {
  readonly planId: string;
  readonly status: "completed" | "partial" | "stale" | "blocked";
  readonly deletedNodeIds: readonly string[];
  readonly updatedNodeIds: readonly string[];
  readonly deletedMediaIds: readonly string[];
  readonly deletedCacheKeys: readonly string[];
  readonly deletedJobIds: readonly string[];
  readonly deletedJobFiles: readonly CleanupTaskFile[];
  readonly deletedWorkFiles?: readonly ProjectLibraryTrackedWorkFingerprint[];
  readonly reclaimedBytes: number;
  readonly reason?: string;
  readonly skipped: readonly { readonly kind: "node" | "media" | "cache" | "job"; readonly id: string; readonly reason: string }[];
  readonly failed: readonly { readonly kind: "node" | "media" | "cache" | "job"; readonly id: string; readonly reason: string }[];
}

interface ReviewSnapshot {
  readonly review: CleanupReview;
  readonly nodeVersions: ReadonlyMap<string, CleanupNodeVersion>;
  readonly mediaEntries: ReadonlyMap<string, StoredMediaEntry>;
  readonly cacheEntries: ReadonlyMap<string, StoredCacheEntry>;
  readonly references: readonly MediaReference[];
  readonly cleanupJobs: readonly CleanupTaskReviewEntry[];
}

interface StoredPlan {
  readonly plan: CleanupPlan;
  readonly nodeVersions: ReadonlyMap<string, CleanupNodeVersion>;
  readonly mediaEntries: ReadonlyMap<string, StoredMediaEntry>;
  readonly cacheEntries: ReadonlyMap<string, StoredCacheEntry>;
  readonly cleanupJobs: ReadonlyMap<string, CleanupTaskReviewEntry>;
  readonly cleanupTaskHandoff?: ProjectCleanupHandoff;
}

const plans = new Map<string, StoredPlan>();
const cleanupUnknowns = ["未登记产物清单的历史文件保留；文件分类不等于删除资格。"];

const failedTaskReasons = [
  "Only this failed or cancelled task's durable input and status records are removed. Task outputs, source media, and other files remain untouched.",
];

function newPlanId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function uniqueSorted(values: readonly string[] = []): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sortTaskFiles(files: readonly CleanupTaskFile[]): CleanupTaskFile[] {
  return [...files].sort((left, right) => left.jobId.localeCompare(right.jobId) || left.path.localeCompare(right.path));
}

function mediaSize(record: StoredMediaEntry): number {
  return (record.blob?.size ?? 0) + (record.controlledFiles ?? []).reduce((total, file) => total + file.sizeBytes, 0);
}

function recordOwners(record: StoredMediaEntry): readonly string[] {
  return record.projectIds ?? [record.projectId];
}

function foreignMediaOwners(record: StoredMediaEntry, projectId: string): string[] {
  return recordOwners(record).filter((owner) => owner !== projectId);
}

function mediaSnapshotKey(record: StoredMediaEntry): string {
  return JSON.stringify({
    id: record.id,
    projectId: record.projectId,
    projectIds: record.projectIds ?? [record.projectId],
    contentHash: record.contentHash ?? null,
    contentUrl: record.contentUrl ?? null,
    idbSizeBytes: record.blob?.size ?? 0,
    controlledFiles: record.controlledFiles ?? [],
  });
}

function cacheSnapshotKey(record: StoredCacheEntry): string {
  return JSON.stringify([record.key, record.sizeBytes, record.timestamp]);
}

function nodeVersion(node: ProjectNodeSummary): CleanupNodeVersion {
  return {
    id: node.id,
    createdAt: node.createdAt,
    parentNodeId: node.parentNodeId,
    ...(node.recycledAt !== undefined ? { recycledAt: node.recycledAt } : {}),
    mediaIds: [...node.mediaIds].sort(),
  };
}

function sameCleanupHandoffBinding(left: ProjectCleanupHandoff, right: ProjectCleanupHandoff): boolean {
  return left.projectId === right.projectId && left.workspaceId === right.workspaceId &&
    left.exportId === right.exportId && left.revision === right.revision &&
    left.scope === right.scope && left.retention === right.retention &&
    JSON.stringify(uniqueSorted(left.nodeIds)) === JSON.stringify(uniqueSorted(right.nodeIds));
}

async function readCleanupTaskBinding(target: CleanupTarget): Promise<{
  cleanupTaskId: string;
  handoff: ProjectCleanupHandoff;
} | undefined> {
  if (!target.cleanupTaskId) return undefined;
  const context = await workspaceManager.getWorkspaceContext(target);
  const project = context.store.getState().project;
  const requirement = project.requirements?.items.find((item) => item.id === target.cleanupTaskId);
  const handoff = requirement?.cleanupHandoff;
  if (!handoff) throw new Error(`Cleanup task ${target.cleanupTaskId} has no cleanup handoff`);
  if (handoff.projectId !== target.projectId || handoff.workspaceId !== target.workspaceId || handoff.exportId !== target.exportId) {
    throw new Error("Cleanup task target does not match the requested project, workspace, and export");
  }
  return { cleanupTaskId: target.cleanupTaskId, handoff: structuredClone(handoff) };
}

async function advanceBoundCleanupTask(
  target: CleanupTarget,
  binding: { cleanupTaskId: string; handoff: ProjectCleanupHandoff },
  nextPhase: ProjectCleanupHandoff["phase"],
): Promise<ProjectCleanupHandoff> {
  const context = await workspaceManager.getWorkspaceContext(target);
  const updated = await advanceCleanupReviewPhase({
    projectId: target.projectId,
    workspaceId: target.workspaceId,
    revision: binding.handoff.revision,
    ...(binding.handoff.exportId !== undefined ? { exportId: binding.handoff.exportId } : {}),
    scope: binding.handoff.scope,
    retention: binding.handoff.retention,
  }, binding.handoff.nodeIds, nextPhase, {
    ...(nextPhase === "executing" ? { confirmedExecution: true } : {}),
    store: context.store,
  });
  if (updated.id !== binding.cleanupTaskId || !updated.cleanupHandoff) {
    throw new Error("Cleanup lifecycle update did not match the bound cleanup task");
  }
  if (!sameCleanupHandoffBinding(updated.cleanupHandoff, binding.handoff) || updated.cleanupHandoff.phase !== nextPhase) {
    throw new Error("Cleanup lifecycle update changed the bound task scope");
  }
  return structuredClone(updated.cleanupHandoff);
}

function toReferenceSummary(reference: MediaReference): CleanupReferenceSummary {
  return {
    mediaId: reference.mediaId,
    projectId: reference.projectId,
    kind: reference.kind,
    referenceId: reference.referenceId,
    ...(reference.label ? { label: reference.label } : {}),
    ...(reference.purpose ? { purpose: reference.purpose } : {}),
  };
}

interface TaskLedgerCleanupFile {
  readonly path: string;
  readonly sizeBytes: number;
  readonly lastModifiedMs: number;
}

interface TaskLedgerCleanupTask {
  readonly jobId: string;
  readonly kind: "export" | "analysis" | "audio-process";
  readonly sourceRevision: number;
  readonly state: "queued" | "running" | "done" | "error" | "cancelled";
  readonly files: readonly TaskLedgerCleanupFile[];
  readonly retainedReason?: string;
  readonly artifactFiles?: readonly ProjectLibraryTrackedArtifactFile[];
}

interface TaskLedgerCleanupListing {
  readonly tasks: readonly TaskLedgerCleanupTask[];
  readonly unknowns: readonly string[];
  readonly artifactScanReady?: boolean;
}

interface CleanupJobSnapshot {
  readonly tasks: readonly CleanupTaskReviewEntry[];
  readonly unknowns: readonly string[];
  readonly scanReady: boolean;
  readonly workFiles: readonly CleanupWorkFile[];
  readonly workScanReady: boolean;
}

function isAbsoluteTaskFilePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value);
}

function isValidTaskRecordFilePair(jobId: string, files: readonly TaskLedgerCleanupFile[]): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(jobId) || files.length !== 2) return false;
  const pathParts = files.map((file) => file.path.split(/[\\/]/));
  const names = pathParts.map((parts) => parts[parts.length - 1]);
  if (names.sort().join("\0") !== [`${jobId}.json`, `${jobId}.status.json`].sort().join("\0")) return false;
  const parent = files[0]!.path.slice(0, Math.max(files[0]!.path.lastIndexOf("/"), files[0]!.path.lastIndexOf("\\")));
  return files.every((file, index) => isAbsoluteTaskFilePath(file.path) &&
    pathParts[index]!.every((part) => part !== "..") &&
    file.path.slice(0, Math.max(file.path.lastIndexOf("/"), file.path.lastIndexOf("\\"))) === parent &&
    Number.isSafeInteger(file.sizeBytes) && file.sizeBytes >= 0 &&
    Number.isFinite(file.lastModifiedMs) && file.lastModifiedMs >= 0);
}

async function readCleanupJobSnapshot(target: CleanupTarget): Promise<CleanupJobSnapshot> {
  const projectLibrary = typeof window === "undefined" ? undefined : window.reelterminal?.projectLibrary;
  if (!projectLibrary) {
    return {
      tasks: [],
      unknowns: ["Durable failed-task cleanup is unavailable in this runtime; task records were not scanned."],
      scanReady: false,
      workFiles: [], workScanReady: false,
    };
  }
  let listing: TaskLedgerCleanupListing;
  try {
    listing = await projectLibrary.listCleanupCandidates({ projectId: target.projectId, workspaceId: target.workspaceId });
  } catch (error) {
    return {
      tasks: [],
      unknowns: [`Durable task records could not be scanned: ${error instanceof Error ? error.message : String(error)}`],
      scanReady: false,
      workFiles: [], workScanReady: false,
    };
  }

  const unknowns = [...listing.unknowns];
  let scanReady = true;
  const tasks = listing.tasks.map((task): CleanupTaskReviewEntry => {
    const failed = task.state === "error" || task.state === "cancelled";
    const validPair = isValidTaskRecordFilePair(task.jobId, task.files);
    const hasArtifacts = (task.artifactFiles?.length ?? 0) > 0;
    const candidate = failed && validPair && !hasArtifacts;
    if (failed && !validPair) {
      unknowns.push(`Failed task ${task.jobId} does not have an exact, fingerprinted input/status file pair and cannot be purged.`);
      scanReady = false;
    }
    return {
      jobId: task.jobId,
      kind: task.kind,
      state: task.state,
      sourceRevision: task.sourceRevision,
      files: task.files.map((file) => ({
        jobId: task.jobId,
        path: file.path,
        sizeBytes: file.sizeBytes,
        lastModifiedMs: file.lastModifiedMs,
      })),
      retainedReason: hasArtifacts ? "仍有产物文件，保留任务清单；先审查过程文件。" : candidate ? failedTaskReasons[0]! : task.retainedReason ?? "No durable cleanup reason was provided.",
      candidate,
    };
  });
  const tracked = listing.tasks.flatMap((task) => (task.artifactFiles ?? []).map((file) => ({
    ...file, jobId: task.jobId, taskState: task.state,
  })));
  let pathReferences: Awaited<ReturnType<typeof scanArtifactPathReferences>> = [];
  let workScanReady = listing.artifactScanReady !== false;
  if (tracked.length > 0) {
    try { pathReferences = await scanArtifactPathReferences(); }
    catch (error) {
      workScanReady = false;
      unknowns.push(`产物引用扫描失败，过程文件全部保留：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const workFiles = tracked.map((file): CleanupWorkFile => {
    const key = artifactPathKey(file.path);
    const retainedBy = pathReferences.filter((reference) => reference.pathKey === key)
      .map((reference) => `${reference.kind}: ${reference.referenceId}`);
    const retainedReason = file.retainedReason ??
      (!workScanReady ? "引用扫描不完整" : !key ? "文件路径无效" :
        file.kind !== "work" ? "正式素材、工程与成片单独保留" :
          file.deliveryStatus === "delivered" ? "已交付的产物保留" :
            file.taskState === "queued" || file.taskState === "running" ? "活动作业保护" :
              retainedBy.length > 0 ? "仍有工程、历史、素材库、审阅或任务引用" : undefined);
    return { ...file, selectionId: `${file.jobId}:${file.fileId}`, retainedBy, ...(retainedReason ? { retainedReason } : {}) };
  });
  return { tasks, unknowns, scanReady, workFiles, workScanReady };
}

async function readCleanupSnapshot(
  target: CleanupTarget,
  selectedNodeIds: readonly string[] = [],
  cleanupTask?: { cleanupTaskId: string; handoff: ProjectCleanupHandoff },
): Promise<ReviewSnapshot> {
  await workspaceManager.initialize();
  await workspaceManager.flushWorkspace(target);
  const context = await workspaceManager.getWorkspaceContext(target);
  const guard = await workspaceManager.getWorkspaceRevisionGuard(target);
  const [activeNodes, deletedNodes, workspaceResult, mediaResult, referenceResult, cacheResult, jobsResult] = await Promise.allSettled([
    workspaceManager.listNodes(target.projectId),
    workspaceManager.listDeletedNodes(target.projectId),
    workspaceManager.listWorkspaces(target.projectId),
    getAllStoredMedia(),
    scanMediaReferences(),
    getAllStoredCache(),
    readCleanupJobSnapshot(target),
  ]);

  const unknowns = [...cleanupUnknowns];
  const nodes: ProjectNodeSummary[] = [];
  if (activeNodes.status === "fulfilled" && deletedNodes.status === "fulfilled") {
    nodes.push(...activeNodes.value, ...deletedNodes.value);
  } else {
    const cause = activeNodes.status === "rejected" ? activeNodes.reason : deletedNodes.status === "rejected" ? deletedNodes.reason : undefined;
    unknowns.push(`Project nodes could not be scanned: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  const mediaEntries = mediaResult.status === "fulfilled" ? mediaResult.value : [];
  if (mediaResult.status === "rejected") {
    unknowns.push(`Stored media could not be scanned: ${mediaResult.reason instanceof Error ? mediaResult.reason.message : String(mediaResult.reason)}`);
  } else if (mediaEntries.some((record) => !hasCompleteControlledMediaFingerprint(record))) {
    unknowns.push("Some controlled media files lack a complete last-modified fingerprint and cannot be safely removed.");
  }
  const references = referenceResult.status === "fulfilled" ? referenceResult.value : [];
  if (referenceResult.status === "rejected") {
    unknowns.push(`Media references could not be scanned: ${referenceResult.reason instanceof Error ? referenceResult.reason.message : String(referenceResult.reason)}`);
  }
  const cacheEntries = cacheResult.status === "fulfilled" ? cacheResult.value : [];
  if (cacheResult.status === "rejected") {
    unknowns.push(`Frame cache could not be scanned: ${cacheResult.reason instanceof Error ? cacheResult.reason.message : String(cacheResult.reason)}`);
  }
  const cleanupJobs = jobsResult.status === "fulfilled"
    ? jobsResult.value
    : { tasks: [], unknowns: [`Durable task records could not be scanned: ${jobsResult.reason instanceof Error ? jobsResult.reason.message : String(jobsResult.reason)}`], scanReady: false, workFiles: [], workScanReady: false };
  unknowns.push(...cleanupJobs.unknowns);

  const nodeIds = new Set(nodes.map((node) => node.id));
  const dependentWorkspaces = workspaceResult.status === "fulfilled" ? workspaceResult.value : [];
  if (workspaceResult.status === "rejected") {
    unknowns.push(`Workspace dependencies could not be scanned: ${workspaceResult.reason instanceof Error ? workspaceResult.reason.message : String(workspaceResult.reason)}`);
  }
  const selected = new Set(uniqueSorted(selectedNodeIds));
  const mediaById = new Map(mediaEntries.map((record) => [record.id, record]));
  const referencesByMedia = new Map<string, MediaReference[]>();
  for (const reference of references) {
    const current = referencesByMedia.get(reference.mediaId) ?? [];
    current.push(reference);
    referencesByMedia.set(reference.mediaId, current);
  }
  const childIds = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parentNodeId || !nodeIds.has(node.parentNodeId)) continue;
    childIds.set(node.parentNodeId, [...(childIds.get(node.parentNodeId) ?? []), node.id]);
  }
  const reviewNodes: CleanupReviewNode[] = nodes.map((node) => {
    const nodeRefs = node.mediaIds.map((mediaId) => {
      const refs = referencesByMedia.get(mediaId) ?? [];
      const retainedBy = refs.filter((reference) => !(reference.kind === "node" && reference.referenceId === node.id));
      const relation = referenceResult.status !== "fulfilled"
        ? "unknown"
        : refs.some((reference) => !(reference.kind === "node" && reference.referenceId === node.id))
          ? "shared"
          : "exclusive";
      return {
        mediaId,
        sizeBytes: mediaById.has(mediaId) ? mediaSize(mediaById.get(mediaId)!) : null,
        relation,
        retainedBy: retainedBy.map(toReferenceSummary),
      } as const;
    });
    return {
      nodeId: node.id,
      name: node.name,
      summary: node.summary,
      createdAt: node.createdAt,
      parentNodeIds: node.parentNodeId ? [node.parentNodeId] : [],
      childNodeIds: [...(childIds.get(node.id) ?? [])].sort(),
      dependentWorkspaceIds: dependentWorkspaces.filter((workspace) => workspace.baseNodeId === node.id).map((workspace) => workspace.id).sort(),
      ...(node.recycledAt !== undefined ? { deletedAt: node.recycledAt } : {}),
      media: nodeRefs,
    };
  });

  const selectedNodeVersions = nodes.filter((node) => selected.has(node.id)).map(nodeVersion);
  const selectedUnionMedia = new Set(selectedNodeVersions.flatMap((node) => node.mediaIds));
  const exclusiveMediaIds = [...selectedUnionMedia].filter((mediaId) => {
    const refs = referencesByMedia.get(mediaId) ?? [];
    return mediaById.has(mediaId) && refs.length > 0 && refs.every((reference) => reference.kind === "node" && selected.has(reference.referenceId));
  }).sort();
  const exclusiveByteCount = exclusiveMediaIds.reduce((total, id) => total + mediaSize(mediaById.get(id)!), 0);
  const allReferences = references.map(toReferenceSummary);
  const activeExport = getExportingProjectIds().has(target.projectId);
  const revision = Math.max(context.revision, guard.revision);
  const workspaceInstanceId = context.instanceId;
  let finalGuard;
  try {
    finalGuard = await workspaceManager.getWorkspaceRevisionGuard(target);
  } catch (error) {
    unknowns.push(`Workspace identity could not be rechecked: ${error instanceof Error ? error.message : String(error)}`);
  }
  const scanReady = activeNodes.status === "fulfilled" && deletedNodes.status === "fulfilled" && workspaceResult.status === "fulfilled" &&
    mediaResult.status === "fulfilled" && referenceResult.status === "fulfilled" && cacheResult.status === "fulfilled" &&
    context.revision === guard.revision && guard.persistedRevision === guard.revision && guard.instanceId === workspaceInstanceId &&
    finalGuard?.revision === revision && finalGuard.persistedRevision === revision && finalGuard.instanceId === workspaceInstanceId;
  if (context.revision !== guard.revision) unknowns.push("Workspace revision changed while opening the reviewed target.");
  if (guard.persistedRevision !== guard.revision) unknowns.push("Workspace has pending edits that could not be captured as one durable revision.");
  if (guard.instanceId !== workspaceInstanceId) unknowns.push("Workspace runtime identity changed during the review scan.");
  if (finalGuard && (finalGuard.revision !== revision || finalGuard.persistedRevision !== revision || finalGuard.instanceId !== workspaceInstanceId)) {
    unknowns.push("Workspace revision or runtime identity changed during the review scan.");
  }

  const review: CleanupReview = {
    target: { ...target },
    ...(cleanupTask ? { cleanupTask } : {}),
    revision,
    workspaceInstanceId,
    nodes: reviewNodes,
    selected: {
      nodeIds: [...selected].filter((id) => nodeIds.has(id)).sort(),
      mediaIds: [...selectedUnionMedia].sort(),
      exclusiveMediaIds,
      reclaimableBytes: exclusiveByteCount,
    },
    retainedSummary: {
      references: allReferences,
      unknown: referenceResult.status !== "fulfilled",
    },
    cache: {
      entries: cacheResult.status === "fulfilled" ? cacheEntries.filter((entry) => entry.key.startsWith(`${target.projectId}:`)).length : null,
      sizeBytes: cacheResult.status === "fulfilled" ? cacheEntries
        .filter((entry) => entry.key.startsWith(`${target.projectId}:`))
        .reduce((total, entry) => total + entry.sizeBytes, 0) : null,
      activeExport,
    },
    failedJobs: cleanupJobs,
    workFiles: { files: cleanupJobs.workFiles, scanReady: cleanupJobs.workScanReady, unknowns: cleanupJobs.unknowns },
    scanReady,
    unknowns,
  };
  return {
    review,
    nodeVersions: new Map(nodes.map((node) => [node.id, nodeVersion(node)])),
    mediaEntries: new Map(mediaEntries.map((entry) => [entry.id, entry])),
    cacheEntries: new Map(cacheEntries.map((entry) => [entry.key, entry])),
    references,
    cleanupJobs: cleanupJobs.tasks,
  };
}

export async function getCleanupReview(
  target: CleanupTarget,
  selectedNodeIds: readonly string[] = [],
): Promise<CleanupReview> {
  const cleanupTask = await readCleanupTaskBinding(target);
  const providedNodeIds = uniqueSorted(selectedNodeIds);
  if (cleanupTask && providedNodeIds.length > 0 &&
    JSON.stringify(providedNodeIds) !== JSON.stringify(uniqueSorted(cleanupTask.handoff.nodeIds))) {
    throw new Error("Cleanup review node selection does not match its bound task");
  }
  const scopedNodeIds = cleanupTask ? cleanupTask.handoff.nodeIds : providedNodeIds;
  return (await readCleanupSnapshot(target, scopedNodeIds, cleanupTask)).review;
}

function referenceIdsForMedia(references: readonly MediaReference[], mediaId: string): MediaReference[] {
  return references.filter((reference) => reference.mediaId === mediaId);
}

function nodeAction(action: CleanupAction): CleanupNodeLifecycleAction | undefined {
  if (action === "purge-deleted-nodes") return "purge";
  if (action === "recycle-nodes") return "recycle";
  if (action === "restore-nodes") return "restore";
  return undefined;
}

function formatNodeSelectionError(action: CleanupAction, node: CleanupReviewNode | undefined): string | undefined {
  if (action === "purge-deleted-nodes" && node && node.deletedAt === undefined) return "Only deleted nodes can be permanently removed";
  if (action === "recycle-nodes" && node?.deletedAt !== undefined) return "Node is already in the recycle bin";
  if (action === "restore-nodes" && node?.deletedAt === undefined) return "Only deleted nodes can be restored";
  return undefined;
}

export async function createCleanupPlan(
  target: CleanupTarget,
  action: CleanupAction,
  selection: CleanupSelection = {},
): Promise<CleanupPlan> {
  const cleanupTask = await readCleanupTaskBinding(target);
  const requestedNodeIds = uniqueSorted(selection.nodeIds);
  const selectedNodeIds = action === "purge-cache" || action === "purge-failed-jobs" || action === "purge-work-files"
    ? requestedNodeIds
    : uniqueSorted(cleanupTask?.handoff.nodeIds ?? requestedNodeIds);
  const requestedMediaIds = uniqueSorted(selection.mediaIds);
  const requestedCacheKeys = uniqueSorted(selection.cacheKeys);
  const requestedJobIds = uniqueSorted(selection.jobIds);
  const requestedWorkFileIds = uniqueSorted(selection.workFileIds);
  const snapshot = await readCleanupSnapshot(target, selectedNodeIds, cleanupTask);
  const { review } = snapshot;
  const nodeById = new Map(review.nodes.map((node) => [node.nodeId, node]));
  const blockers: string[] = [];
  if (!review.scanReady) blockers.push("A complete workspace, storage, cache, and reference scan is required before cleanup can execute.");
  if (cleanupTask && JSON.stringify(requestedNodeIds) !== JSON.stringify(selectedNodeIds) && requestedNodeIds.length > 0) {
    blockers.push("Node selection does not match the bound cleanup task");
  }
  if (cleanupTask && (action === "purge-cache" || action === "purge-failed-jobs" || action === "purge-work-files") && cleanupTask.handoff.nodeIds.length > 0) {
    blockers.push("Workspace-level cache or failed-job cleanup cannot use a node-scoped cleanup task");
  }
  if (cleanupTask && cleanupTask.handoff.phase !== "awaiting_confirmation") {
    blockers.push(`Cleanup task must be in awaiting_confirmation before a final plan; current phase is ${cleanupTask.handoff.phase}`);
  }

  const selectedVersions: CleanupNodeVersion[] = [];
  for (const nodeId of selectedNodeIds) {
    const node = nodeById.get(nodeId);
    if (!node) {
      blockers.push(`Node ${nodeId} was not found in the reviewed project`);
      continue;
    }
    const stateError = formatNodeSelectionError(action, node);
    if (stateError) blockers.push(`${nodeId}: ${stateError}`);
    if (action === "purge-deleted-nodes" && node) {
      if (node.dependentWorkspaceIds.length > 0) blockers.push(`${nodeId}: current workspace base (${node.dependentWorkspaceIds.join(", ")})`);
      const retainedChildren = node.childNodeIds.filter((childId) => !selectedNodeIds.includes(childId));
      if (retainedChildren.length > 0) blockers.push(`${nodeId}: parent of retained node(s) ${retainedChildren.join(", ")}`);
    }
    const version = snapshot.nodeVersions.get(nodeId);
    if (version) selectedVersions.push(version);
  }

  if ((action === "purge-deleted-nodes" || action === "recycle-nodes" || action === "restore-nodes") && selectedNodeIds.length === 0) {
    blockers.push("Select at least one version node for this action");
  }
  if (action === "purge-cache" && (selectedNodeIds.length > 0 || requestedMediaIds.length > 0)) blockers.push("Cache cleanup accepts cache keys only");
  if (action === "purge-cache" && review.cache.activeExport) blockers.push("Frame cache cannot be cleaned while this project has an active export");
  if (action === "purge-failed-jobs") {
    if (!review.failedJobs.scanReady) blockers.push("A complete durable task-record scan is required before failed-job cleanup can execute.");
    if (review.cache.activeExport) blockers.push("Failed task records cannot be cleaned while this project has an active export.");
    if (selectedNodeIds.length > 0 || requestedMediaIds.length > 0 || requestedCacheKeys.length > 0) {
      blockers.push("Failed-job cleanup accepts jobIds only");
    }
  } else if (action !== "purge-work-files" && requestedJobIds.length > 0) {
    blockers.push("jobIds are only valid for failed-job cleanup");
  }
  if (action === "purge-work-files") {
    if (!review.workFiles.scanReady) blockers.push("过程文件的完整引用扫描未通过");
    if (selectedNodeIds.length > 0 || requestedMediaIds.length > 0 || requestedCacheKeys.length > 0) blockers.push("过程文件清理只接受 workFileIds 与 jobIds");
    if (requestedWorkFileIds.length === 0) blockers.push("请明确选择要删除的过程文件；未采用尝试不会默认全选");
    if (getExportingProjectIds().size > 0) blockers.push("请等待活动导出结束后重新确认过程文件清理");
  } else if (requestedWorkFileIds.length > 0) blockers.push("workFileIds 只适用于过程文件清理");

  const candidateWorkFiles = action === "purge-work-files" && review.workFiles.scanReady
    ? review.workFiles.files.filter((file) => requestedWorkFileIds.includes(file.selectionId) &&
      (requestedJobIds.length === 0 || requestedJobIds.includes(file.jobId)) && !file.retainedReason)
    : [];
  if (action === "purge-work-files") {
    for (const fileId of requestedWorkFileIds) {
      if (!candidateWorkFiles.some((file) => file.selectionId === fileId)) blockers.push(`过程文件 ${fileId} 不在可清理范围或仍受引用保护`);
    }
  }
  const workFiles: ProjectLibraryTrackedWorkFingerprint[] = candidateWorkFiles.map(({ jobId, fileId, path, sizeBytes, lastModifiedMs }) => ({ jobId, fileId, path, sizeBytes, lastModifiedMs }));

  const selectedNodeSet = new Set(selectedNodeIds);
  const selectedNodeMedia = new Set(selectedVersions.flatMap((node) => node.mediaIds));
  const mediaRecords = [...snapshot.mediaEntries.values()];
  const candidateMediaIds = new Set<string>();
  if (action === "purge-media" && review.scanReady) {
    for (const record of mediaRecords) {
      if (!recordOwners(record).includes(target.projectId)) continue;
      if (selectedNodeIds.length > 0 && !selectedNodeMedia.has(record.id)) continue;
      if (foreignMediaOwners(record, target.projectId).length > 0) continue;
      if (!hasCompleteControlledMediaFingerprint(record)) continue;
      if (referenceIdsForMedia(snapshot.references, record.id).length === 0) candidateMediaIds.add(record.id);
    }
  } else if (action === "purge-deleted-nodes" && review.scanReady) {
    const requested = requestedMediaIds.length > 0 ? requestedMediaIds : [...selectedNodeMedia];
    for (const mediaId of requested) {
      if (!selectedNodeMedia.has(mediaId)) {
        blockers.push(`Media ${mediaId} is outside the selected node snapshots`);
        continue;
      }
      const mediaRecord = snapshot.mediaEntries.get(mediaId);
      if (mediaRecord && foreignMediaOwners(mediaRecord, target.projectId).length > 0) continue;
      if (mediaRecord && !hasCompleteControlledMediaFingerprint(mediaRecord)) continue;
      const refs = referenceIdsForMedia(snapshot.references, mediaId);
      if (refs.length > 0 && refs.every((reference) => reference.kind === "node" && selectedNodeSet.has(reference.referenceId))) {
        candidateMediaIds.add(mediaId);
      }
    }
  }

  let mediaIds = [...candidateMediaIds].sort();
  if (action === "purge-media" && requestedMediaIds.length > 0) {
    const allowed = new Set(requestedMediaIds);
    mediaIds = mediaIds.filter((id) => allowed.has(id));
  }
  let cacheKeys: string[] = [];
  if (action === "purge-cache") {
    if (review.scanReady) {
      const projectCache = [...snapshot.cacheEntries.values()].filter((entry) => entry.key.startsWith(`${target.projectId}:`));
      const allowed = requestedCacheKeys.length > 0 ? new Set(requestedCacheKeys) : undefined;
      cacheKeys = projectCache.filter((entry) => !allowed || allowed.has(entry.key)).map((entry) => entry.key).sort();
      const invalidKeys = requestedCacheKeys.filter((key) => !projectCache.some((entry) => entry.key === key));
      if (invalidKeys.length > 0) blockers.push(`Cache keys are outside the target project: ${invalidKeys.join(", ")}`);
    }
  } else if (requestedCacheKeys.length > 0) {
    blockers.push("Cache keys are only valid for cache cleanup");
  }
  const candidateJobById = new Map(snapshot.cleanupJobs.filter((task) => task.candidate).map((task) => [task.jobId, task]));
  let jobIds: string[] = [];
  if (action === "purge-failed-jobs" && review.failedJobs.scanReady) {
    const requested = requestedJobIds.length > 0 ? requestedJobIds : [...candidateJobById.keys()].sort();
    for (const jobId of requested) {
      if (!candidateJobById.has(jobId)) {
        blockers.push(`Failed or cancelled task ${jobId} is not a purgeable task record in the reviewed project/workspace`);
      }
    }
    jobIds = requested.filter((jobId) => candidateJobById.has(jobId)).sort();
    if (jobIds.length === 0) blockers.push("No failed or cancelled task records are available in this project/workspace");
  }
  if (!review.scanReady) {
    mediaIds = [];
    cacheKeys = [];
  }
  if (action === "purge-failed-jobs" && (!review.failedJobs.scanReady || !review.scanReady)) jobIds = [];
  if (action === "purge-media" && mediaIds.length === 0) blockers.push("No media is available for this cleanup action");
  if (action === "purge-cache" && cacheKeys.length === 0) blockers.push("No cache entries are available for this cleanup action");

  const reclaimableBytes = mediaIds.reduce((total, id) => total + mediaSize(snapshot.mediaEntries.get(id)!), 0) +
    cacheKeys.reduce((total, key) => total + (snapshot.cacheEntries.get(key)?.sizeBytes ?? 0), 0) +
    jobIds.reduce((total, jobId) => total + (candidateJobById.get(jobId)?.files.reduce((sum, file) => sum + file.sizeBytes, 0) ?? 0), 0) +
    candidateWorkFiles.reduce((total, file) => total + file.sizeBytes, 0);
  const retainedMediaIds = action === "purge-deleted-nodes"
    ? [...selectedNodeMedia].filter((id) => !candidateMediaIds.has(id)).sort()
    : action === "purge-media" && requestedMediaIds.length > 0
      ? requestedMediaIds.filter((id) => !candidateMediaIds.has(id))
      : action === "purge-media"
        ? mediaRecords.filter((record) => recordOwners(record).includes(target.projectId) && !candidateMediaIds.has(record.id)).map((record) => record.id).sort()
        : [];
  const candidateMedia = mediaIds.flatMap((mediaId) => {
    const record = snapshot.mediaEntries.get(mediaId);
    if (!record) return [];
    const idbSize = record.blob?.size ?? 0;
    const files = [
      ...(idbSize > 0 ? [{ storage: "indexeddb" as const, path: `IndexedDB media record ${record.id}`, sizeBytes: idbSize }] : []),
      ...(record.controlledFiles ?? []).map((file) => ({
        storage: "controlled-file" as const,
        path: file.path,
        sizeBytes: file.sizeBytes,
        ...(typeof file.lastModifiedMs === "number" ? { lastModifiedMs: file.lastModifiedMs } : {}),
      })),
    ];
    return [{
      mediaId,
      sizeBytes: mediaSize(record),
      files,
      reasons: [action === "purge-deleted-nodes" ? "Only the selected deleted nodes retain these bytes." : "No retained media references were found."],
    }];
  });
  const retainedMedia = retainedMediaIds.map((mediaId) => {
    const refs = referenceIdsForMedia(snapshot.references, mediaId).map(toReferenceSummary);
    const record = snapshot.mediaEntries.get(mediaId);
    const foreignOwners = record ? foreignMediaOwners(record, target.projectId) : [];
    const reasons = [
      ...refs.map((reference) => `${reference.kind}: ${reference.label ?? reference.referenceId}`),
      ...(foreignOwners.length > 0 ? [`Stored media is also owned by project(s): ${foreignOwners.join(", ")}`] : []),
      ...(record && !hasCompleteControlledMediaFingerprint(record) ? ["Controlled media file fingerprint is incomplete; removal is blocked."] : []),
      ...(!review.scanReady ? ["Cleanup scan is incomplete; current retention is unknown."] : []),
    ];
    return {
      mediaId,
      sizeBytes: record ? mediaSize(record) : null,
      retainedBy: refs,
      reasons: reasons.length > 0 ? reasons : ["Media was outside the selected cleanup scope or has no stored bytes."],
    };
  });
  const candidateCache = cacheKeys.flatMap((key) => {
    const entry = snapshot.cacheEntries.get(key);
    return entry ? [{ ...entry, reasons: ["Project frame cache can be regenerated."] }] : [];
  });
  const candidateJobs: CleanupFailedJobCandidate[] = jobIds.flatMap((jobId) => {
    const task = candidateJobById.get(jobId);
    return task ? [{
      jobId: task.jobId,
      kind: task.kind,
      state: task.state as "error" | "cancelled",
      sourceRevision: task.sourceRevision,
      files: sortTaskFiles(task.files),
      reclaimableBytes: task.files.reduce((total, file) => total + file.sizeBytes, 0),
      retainedReason: task.retainedReason,
      reasons: failedTaskReasons,
    }] : [];
  });
  const selectedJobSet = new Set(jobIds);
  const retainedJobs = review.failedJobs.tasks.filter((task) => !selectedJobSet.has(task.jobId));
  const jobFiles = sortTaskFiles(candidateJobs.flatMap((task) => task.files));
  const planId = newPlanId();
  const planTarget = { ...target };
  const normalizedSelection = { nodeIds: selectedNodeIds, mediaIds, cacheKeys, jobIds, workFileIds: candidateWorkFiles.map((file) => file.selectionId).sort() };
  const confirmation: CleanupConfirmation = {
    planId,
    target: planTarget,
    action,
    revision: review.revision,
    workspaceInstanceId: review.workspaceInstanceId,
    nodeIds: selectedNodeIds,
    mediaIds,
    cacheKeys,
    cleanupTaskNodeIds: cleanupTask?.handoff.nodeIds ?? [],
    jobIds,
    jobFiles,
    workFiles,
  };
  const plan: CleanupPlan = {
    planId,
    target: planTarget,
    action,
    revision: review.revision,
    workspaceInstanceId: review.workspaceInstanceId,
    selection: normalizedSelection,
    confirmation,
    status: blockers.length === 0 ? "ready" : "review-required",
    scanReady: review.scanReady,
    blockers,
    candidateMedia,
    retainedMedia,
    candidateCache,
    candidateJobs,
    retainedJobs,
    candidateWorkFiles,
    retainedWorkFiles: review.workFiles.files.filter((file) => !candidateWorkFiles.includes(file)),
    unknowns: review.unknowns,
    reclaimableBytes,
    createdAt: Date.now(),
    ...(cleanupTask ? { cleanupTask } : {}),
  };
  plans.set(planId, {
    plan: structuredClone(plan),
    nodeVersions: new Map(selectedVersions.map((node) => [node.id, node])),
    mediaEntries: new Map(mediaIds.flatMap((id) => snapshot.mediaEntries.has(id) ? [[id, snapshot.mediaEntries.get(id)!] as const] : [])),
    cacheEntries: new Map(cacheKeys.flatMap((key) => snapshot.cacheEntries.has(key) ? [[key, snapshot.cacheEntries.get(key)!] as const] : [])),
    cleanupJobs: new Map(jobIds.flatMap((id) => {
      const task = snapshot.cleanupJobs.find((candidate) => candidate.jobId === id);
      return task ? [[id, task] as const] : [];
    })),
    ...(cleanupTask ? { cleanupTaskHandoff: cleanupTask.handoff } : {}),
  });
  while (plans.size > 50) {
    const oldestPlanId = plans.keys().next().value;
    if (oldestPlanId === undefined) break;
    plans.delete(oldestPlanId);
  }
  return structuredClone(plan);
}

function sameConfirmation(input: CleanupExecutionInput, expected: CleanupConfirmation): boolean {
  return input.confirmed === true && input.planId === expected.planId &&
    input.target.projectId === expected.target.projectId &&
    input.target.workspaceId === expected.target.workspaceId &&
    input.target.exportId === expected.target.exportId &&
    input.target.cleanupTaskId === expected.target.cleanupTaskId &&
    input.action === expected.action && input.revision === expected.revision &&
    input.workspaceInstanceId === expected.workspaceInstanceId &&
    JSON.stringify(uniqueSorted(input.cleanupTaskNodeIds)) === JSON.stringify(uniqueSorted(expected.cleanupTaskNodeIds)) &&
    JSON.stringify(uniqueSorted(input.nodeIds)) === JSON.stringify(expected.nodeIds) &&
    JSON.stringify(uniqueSorted(input.mediaIds)) === JSON.stringify(expected.mediaIds) &&
    JSON.stringify(uniqueSorted(input.cacheKeys)) === JSON.stringify(expected.cacheKeys) &&
    JSON.stringify(uniqueSorted(input.jobIds)) === JSON.stringify(expected.jobIds) &&
    JSON.stringify(sortTaskFiles(input.jobFiles)) === JSON.stringify(expected.jobFiles) &&
    JSON.stringify(sortWorkFiles(input.workFiles ?? [])) === JSON.stringify(sortWorkFiles(expected.workFiles ?? []));
}

function sortWorkFiles(files: readonly ProjectLibraryTrackedWorkFingerprint[]): ProjectLibraryTrackedWorkFingerprint[] {
  return [...files].sort((left, right) => left.jobId.localeCompare(right.jobId) || left.fileId.localeCompare(right.fileId));
}

function sameTaskFileSnapshot(left: readonly CleanupTaskFile[], right: readonly CleanupTaskFile[]): boolean {
  return JSON.stringify(sortTaskFiles(left)) === JSON.stringify(sortTaskFiles(right));
}

function emptyResult(planId: string, status: CleanupExecutionResult["status"], reason?: string): CleanupExecutionResult {
  return {
    planId,
    status,
    deletedNodeIds: [],
    updatedNodeIds: [],
    deletedMediaIds: [],
    deletedCacheKeys: [],
    deletedJobIds: [],
    deletedJobFiles: [],
    reclaimedBytes: 0,
    ...(reason ? { reason } : {}),
    skipped: [],
    failed: [],
  };
}

export async function executeCleanupPlan(input: CleanupExecutionInput): Promise<CleanupExecutionResult> {
  const stored = plans.get(input.planId);
  if (!stored) throw new Error("Cleanup plan is unknown or expired; review the target again");
  if (!sameConfirmation(input, stored.plan.confirmation)) throw new Error("Cleanup confirmation does not match the reviewed plan scope");
  if (stored.plan.status !== "ready" || !stored.plan.scanReady) {
    plans.delete(input.planId);
    return emptyResult(input.planId, "blocked", stored.plan.blockers.join("; ") || "The cleanup plan is not ready");
  }

  await workspaceManager.initialize();
  await workspaceManager.flushWorkspace(stored.plan.target);
  let executionRevision = stored.plan.revision;
  const taskHandoff = stored.cleanupTaskHandoff;
  const cleanupTaskId = stored.plan.target.cleanupTaskId;
  const reopenConfirmation = async (): Promise<void> => {
    if (!taskHandoff || !cleanupTaskId) return;
    const current = await readCleanupTaskBinding(stored.plan.target);
    if (current && sameCleanupHandoffBinding(current.handoff, taskHandoff) && current.handoff.phase === "executing") {
      await advanceBoundCleanupTask(stored.plan.target, current, "awaiting_confirmation");
      await workspaceManager.flushWorkspace(stored.plan.target);
    }
  };
  if (taskHandoff && cleanupTaskId) {
    const beforeTaskPhase = await workspaceManager.getWorkspaceRevisionGuard(stored.plan.target);
    if (beforeTaskPhase.revision !== stored.plan.revision || beforeTaskPhase.persistedRevision !== stored.plan.revision ||
      beforeTaskPhase.instanceId !== stored.plan.workspaceInstanceId) {
      plans.delete(input.planId);
      return emptyResult(input.planId, "stale", "Workspace changed before the confirmed cleanup could start");
    }
    const currentTask = await readCleanupTaskBinding(stored.plan.target);
    if (!currentTask || currentTask.cleanupTaskId !== cleanupTaskId ||
      !sameCleanupHandoffBinding(currentTask.handoff, taskHandoff) || currentTask.handoff.phase !== "awaiting_confirmation") {
      plans.delete(input.planId);
      return emptyResult(input.planId, "stale", "The bound cleanup task changed after review");
    }
    await advanceBoundCleanupTask(stored.plan.target, currentTask, "executing");
    await workspaceManager.flushWorkspace(stored.plan.target);
    const afterTaskPhase = await workspaceManager.getWorkspaceRevisionGuard(stored.plan.target);
    if (afterTaskPhase.revision !== stored.plan.revision + 1 ||
      afterTaskPhase.persistedRevision !== stored.plan.revision + 1 ||
      afterTaskPhase.instanceId !== stored.plan.workspaceInstanceId) {
      plans.delete(input.planId);
      await reopenConfirmation();
      return emptyResult(input.planId, "stale", "Cleanup task lifecycle changed the workspace by more than its own single revision");
    }
    executionRevision = afterTaskPhase.revision;
  }
  const deletedNodeIds: string[] = [];
  const updatedNodeIds: string[] = [];
  const deletedMediaIds: string[] = [];
  const deletedCacheKeys: string[] = [];
  const deletedJobIds: string[] = [];
  const deletedJobFiles: CleanupTaskFile[] = [];
  const deletedWorkFiles: ProjectLibraryTrackedWorkFingerprint[] = [];
  const skipped: Array<{ kind: "node" | "media" | "cache" | "job"; id: string; reason: string }> = [];
  const failed: Array<{ kind: "node" | "media" | "cache" | "job"; id: string; reason: string }> = [];
  let reclaimedBytes = 0;

  const result = await withMediaReferenceWrite(async () => {
    const guard = await workspaceManager.getWorkspaceRevisionGuard(stored.plan.target);
    if (guard.projectId !== stored.plan.target.projectId || guard.workspaceId !== stored.plan.target.workspaceId ||
      guard.revision !== executionRevision || guard.persistedRevision !== executionRevision ||
      guard.instanceId !== stored.plan.workspaceInstanceId) {
      return emptyResult(input.planId, "stale", "Workspace identity or revision changed after review");
    }

    let beforeReferences: MediaReference[];
    let beforeMedia: StoredMediaEntry[];
    let beforeCache: StoredCacheEntry[];
    let beforeJobs: CleanupJobSnapshot;
    try {
      [beforeReferences, beforeMedia, beforeCache, beforeJobs] = await Promise.all([
        scanMediaReferences(),
        getAllStoredMedia(),
        getAllStoredCache(),
        readCleanupJobSnapshot(stored.plan.target),
      ]);
    } catch (error) {
      return emptyResult(input.planId, "blocked", `Final reference or storage scan failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const scannedGuard = await workspaceManager.getWorkspaceRevisionGuard(stored.plan.target);
    if (scannedGuard.projectId !== stored.plan.target.projectId || scannedGuard.workspaceId !== stored.plan.target.workspaceId ||
      scannedGuard.revision !== executionRevision || scannedGuard.persistedRevision !== executionRevision ||
      scannedGuard.instanceId !== stored.plan.workspaceInstanceId) {
      return emptyResult(input.planId, "stale", "Workspace identity or revision changed during the final scan");
    }

    if (stored.plan.action === "purge-cache" && getExportingProjectIds().has(stored.plan.target.projectId)) {
      return emptyResult(input.planId, "blocked", "Frame cache cannot be cleaned while this project has an active export");
    }
    if (stored.plan.action === "purge-failed-jobs" && getExportingProjectIds().has(stored.plan.target.projectId)) {
      return emptyResult(input.planId, "blocked", "Failed task records cannot be cleaned while this project has an active export");
    }
    if (stored.plan.action === "purge-work-files" && getExportingProjectIds().size > 0) {
      return emptyResult(input.planId, "blocked", "活动导出期间保留过程文件；导出结束后请重新审查");
    }

    const lifecycleAction = nodeAction(stored.plan.action);
    if (lifecycleAction) {
      const expectedNodes = stored.plan.selection.nodeIds.flatMap((id) => {
        const version = stored.nodeVersions.get(id);
        return version ? [version] : [];
      });
      const nodeResult = await workspaceManager.applyCleanupNodeLifecycleUnderReferenceWrite({
        projectId: stored.plan.target.projectId,
        action: lifecycleAction,
        expectedNodes,
      });
      deletedNodeIds.push(...nodeResult.appliedNodeIds.filter(() => lifecycleAction === "purge"));
      updatedNodeIds.push(...nodeResult.appliedNodeIds.filter(() => lifecycleAction !== "purge"));
      skipped.push(...nodeResult.skipped.map((entry) => ({ kind: "node" as const, id: entry.nodeId, reason: entry.reason })));
    }

    if (stored.plan.action === "purge-media" || stored.plan.action === "purge-deleted-nodes") {
      let references = beforeReferences;
      let records = beforeMedia;
      if (stored.plan.action === "purge-deleted-nodes" && deletedNodeIds.length > 0) {
        try {
          [references, records] = await Promise.all([scanMediaReferences(), getAllStoredMedia()]);
        } catch (error) {
          for (const mediaId of stored.plan.selection.mediaIds) skipped.push({
            kind: "media", id: mediaId,
            reason: `Nodes were removed, but media could not be rescanned: ${error instanceof Error ? error.message : String(error)}`,
          });
          return {
            planId: input.planId,
            status: "partial" as const,
            deletedNodeIds,
            updatedNodeIds,
            deletedMediaIds,
            deletedCacheKeys,
            deletedJobIds,
            deletedJobFiles,
            reclaimedBytes,
            skipped,
            failed,
          };
        }
        const postPurgeGuard = await workspaceManager.getWorkspaceRevisionGuard(stored.plan.target);
        if (postPurgeGuard.projectId !== stored.plan.target.projectId || postPurgeGuard.workspaceId !== stored.plan.target.workspaceId ||
          postPurgeGuard.revision !== executionRevision || postPurgeGuard.persistedRevision !== executionRevision ||
          postPurgeGuard.instanceId !== stored.plan.workspaceInstanceId) {
          for (const mediaId of stored.plan.selection.mediaIds) skipped.push({
            kind: "media", id: mediaId, reason: "Workspace identity or revision changed after node removal; media cleanup needs a fresh review",
          });
          return {
            planId: input.planId,
            status: "partial" as const,
            deletedNodeIds,
            updatedNodeIds,
            deletedMediaIds,
            deletedCacheKeys,
            deletedJobIds,
            deletedJobFiles,
            reclaimedBytes,
            skipped,
            failed,
          };
        }
      }
      const currentMediaById = new Map(records.map((record) => [record.id, record]));
      const reviewedMediaById = new Map(beforeMedia.map((record) => [record.id, record]));
      for (const mediaId of stored.plan.selection.mediaIds) {
        const entry = stored.mediaEntries.get(mediaId);
        const current = currentMediaById.get(mediaId);
        const reviewed = reviewedMediaById.get(mediaId);
        if (!entry || !reviewed) {
          skipped.push({ kind: "media", id: mediaId, reason: "Stored media was missing from the reviewed plan" });
          continue;
        }
        if (!current) {
          skipped.push({ kind: "media", id: mediaId, reason: "Stored media was already removed" });
          continue;
        }
        if (mediaSnapshotKey(current) !== mediaSnapshotKey(entry)) {
          skipped.push({ kind: "media", id: mediaId, reason: "Stored media changed after review" });
          continue;
        }
        const foreignOwners = foreignMediaOwners(current, stored.plan.target.projectId);
        if (foreignOwners.length > 0) {
          skipped.push({ kind: "media", id: mediaId, reason: `Stored media is also owned by project(s): ${foreignOwners.join(", ")}` });
          continue;
        }
        const refs = referenceIdsForMedia(references, mediaId);
        if (refs.length > 0) {
          skipped.push({
            kind: "media",
            id: mediaId,
            reason: `A retained reference remains (${refs[0]!.kind}: ${refs[0]!.referenceId})`,
          });
          continue;
        }
        try {
          const expectedFiles: ControlledMediaFileFingerprint[] = (current.controlledFiles ?? []).map((file) => {
            if (typeof file.lastModifiedMs !== "number" || !Number.isFinite(file.lastModifiedMs)) {
              throw new Error("Controlled media storage does not provide a complete guarded-delete fingerprint");
            }
            return { path: file.path, sizeBytes: file.sizeBytes, lastModifiedMs: file.lastModifiedMs };
          });
          if (expectedFiles.length > 0 || isControlledMediaStorageAvailable()) {
            await deleteMediaBlobUnderReferenceWrite(mediaId, undefined, expectedFiles);
          } else {
            await deleteMediaBlobUnderReferenceWrite(mediaId);
          }
          deletedMediaIds.push(mediaId);
          reclaimedBytes += mediaSize(current);
        } catch (error) {
          try {
            const remaining = (await getAllStoredMedia()).find((record) => record.id === mediaId);
            const released = Math.max(0, mediaSize(current) - (remaining ? mediaSize(remaining) : 0));
            reclaimedBytes += released;
            failed.push({ kind: "media", id: mediaId, reason: error instanceof Error ? error.message : String(error) });
          } catch (scanError) {
            failed.push({
              kind: "media", id: mediaId,
              reason: `${error instanceof Error ? error.message : String(error)}; remaining bytes could not be measured: ${scanError instanceof Error ? scanError.message : String(scanError)}`,
            });
          }
        }
      }
    }

    if (stored.plan.action === "purge-cache") {
      const currentCacheByKey = new Map(beforeCache.map((entry) => [entry.key, entry]));
      for (const key of stored.plan.selection.cacheKeys) {
        if (getExportingProjectIds().has(stored.plan.target.projectId)) {
          skipped.push({ kind: "cache", id: key, reason: "An export became active during cache cleanup" });
          continue;
        }
        const entry = stored.cacheEntries.get(key);
        const current = currentCacheByKey.get(key);
        if (!entry || !current || cacheSnapshotKey(entry) !== cacheSnapshotKey(current)) {
          skipped.push({ kind: "cache", id: key, reason: "Cache entry changed after review" });
          continue;
        }
        try {
          const deleted = await deleteStoredCacheIfUnchanged(entry);
          if (!deleted) {
            skipped.push({ kind: "cache", id: key, reason: "Cache entry changed before it could be removed" });
            continue;
          }
          deletedCacheKeys.push(key);
          reclaimedBytes += entry.sizeBytes;
        } catch (error) {
          failed.push({ kind: "cache", id: key, reason: error instanceof Error ? error.message : String(error) });
        }
      }
    }

    if (stored.plan.action === "purge-work-files") {
      if (!beforeJobs.workScanReady) return emptyResult(input.planId, "blocked", "过程文件最终引用扫描未通过");
      const expected = stored.plan.confirmation.workFiles ?? [];
      const matching: ProjectLibraryTrackedWorkFingerprint[] = [];
      for (const file of expected) {
        const current = beforeJobs.workFiles.find((entry) => entry.jobId === file.jobId && entry.fileId === file.fileId);
        if (!current || current.retainedReason || current.path !== file.path || current.sizeBytes !== file.sizeBytes || current.lastModifiedMs !== file.lastModifiedMs) {
          skipped.push({ kind: "job", id: `${file.jobId}:${file.fileId}`, reason: current?.retainedReason ?? "过程文件身份、状态或引用在审查后发生变化" });
        } else matching.push(file);
      }
      if (matching.length > 0) {
        if (getExportingProjectIds().size > 0) return emptyResult(input.planId, "blocked", "引用扫描期间开始了导出，过程文件保留");
        const projectLibrary = typeof window === "undefined" ? undefined : window.reelterminal?.projectLibrary;
        if (!projectLibrary) return emptyResult(input.planId, "blocked", "当前环境无法清理过程文件");
        try {
          const cleanupResult = await projectLibrary.purgeTrackedWorkFiles({
            projectId: stored.plan.target.projectId,
            workspaceId: stored.plan.target.workspaceId,
            jobIds: uniqueSorted(matching.map((file) => file.jobId)),
            expectedFiles: matching,
          });
          reclaimedBytes += cleanupResult.actualBytes;
          deletedWorkFiles.push(...cleanupResult.deleted);
          skipped.push(...cleanupResult.skipped.map((entry) => ({ kind: "job" as const, id: `${entry.jobId}:${entry.fileId}`, reason: entry.reason })));
          failed.push(...cleanupResult.failed.map((entry) => ({ kind: "job" as const, id: `${entry.jobId}:${entry.fileId}`, reason: entry.reason })));
        } catch (error) {
          for (const file of matching) failed.push({ kind: "job", id: `${file.jobId}:${file.fileId}`, reason: error instanceof Error ? error.message : String(error) });
        }
      }
    }

    if (stored.plan.action === "purge-failed-jobs") {
      if (!beforeJobs.scanReady) {
        return emptyResult(input.planId, "blocked", beforeJobs.unknowns.join("; ") || "Durable task records could not be scanned");
      }
      const currentTasks = new Map(beforeJobs.tasks.map((task) => [task.jobId, task]));
      const confirmedJobIds = stored.plan.confirmation.jobIds;
      const matchingJobIds: string[] = [];
      for (const jobId of confirmedJobIds) {
        const reviewed = stored.cleanupJobs.get(jobId);
        const current = currentTasks.get(jobId);
        if (!reviewed || !current || !current.candidate || current.state !== reviewed.state ||
          current.sourceRevision !== reviewed.sourceRevision || !sameTaskFileSnapshot(current.files, reviewed.files)) {
          skipped.push({ kind: "job", id: jobId, reason: "Failed task identity, state, or ledger files changed after review" });
          continue;
        }
        matchingJobIds.push(jobId);
      }
      if (matchingJobIds.length > 0) {
        const projectLibrary = typeof window === "undefined" ? undefined : window.reelterminal?.projectLibrary;
        if (!projectLibrary) {
          for (const jobId of matchingJobIds) failed.push({ kind: "job", id: jobId, reason: "Durable task cleanup is unavailable in this runtime" });
        } else {
          const expectedFiles = stored.plan.confirmation.jobFiles.filter((file) => matchingJobIds.includes(file.jobId));
          try {
            const cleanupResult = await projectLibrary.purgeFailedTaskRecords({
              projectId: stored.plan.target.projectId,
              workspaceId: stored.plan.target.workspaceId,
              jobIds: matchingJobIds,
              expectedFiles,
            });
            reclaimedBytes += cleanupResult.actualBytes;
            deletedJobIds.push(...cleanupResult.deleted.map((item) => item.jobId));
            deletedJobFiles.push(...cleanupResult.deleted.flatMap((item) => item.files.flatMap((path) =>
              expectedFiles.filter((file) => file.jobId === item.jobId && file.path === path))));
            skipped.push(...cleanupResult.skipped.map((item) => ({ kind: "job" as const, id: item.jobId, reason: item.reason })));
            failed.push(...cleanupResult.failed.map((item) => ({ kind: "job" as const, id: item.jobId, reason: item.reason })));
          } catch (error) {
            for (const jobId of matchingJobIds) {
              failed.push({ kind: "job", id: jobId, reason: error instanceof Error ? error.message : String(error) });
            }
          }
        }
      }
    }

    return {
      planId: input.planId,
      status: failed.length > 0 || skipped.length > 0 ? "partial" as const : "completed" as const,
      deletedNodeIds,
      updatedNodeIds,
      deletedMediaIds,
      deletedCacheKeys,
      deletedJobIds,
      deletedJobFiles,
      deletedWorkFiles,
      reclaimedBytes,
      skipped,
      failed,
    };
  }).catch(async (error: unknown) => {
    await reopenConfirmation();
    throw error;
  });
  plans.delete(input.planId);
  if (result.status !== "completed") await reopenConfirmation();
  if (taskHandoff && cleanupTaskId && result.status === "completed") {
    try {
      await workspaceManager.flushWorkspace(stored.plan.target);
      const beforeCompletion = await workspaceManager.getWorkspaceRevisionGuard(stored.plan.target);
      if (beforeCompletion.revision !== executionRevision || beforeCompletion.persistedRevision !== executionRevision ||
        beforeCompletion.instanceId !== stored.plan.workspaceInstanceId) {
        await reopenConfirmation();
        return { ...result, status: "partial", reason: "Cleanup completed, but the workspace changed before its board task could be closed" };
      }
      const currentTask = await readCleanupTaskBinding(stored.plan.target);
      if (!currentTask || currentTask.cleanupTaskId !== cleanupTaskId ||
        !sameCleanupHandoffBinding(currentTask.handoff, taskHandoff) || currentTask.handoff.phase !== "executing") {
        await reopenConfirmation();
        return { ...result, status: "partial", reason: "Cleanup completed, but its bound board task changed before completion could be recorded" };
      }
      await advanceBoundCleanupTask(stored.plan.target, currentTask, "completed");
      await workspaceManager.flushWorkspace(stored.plan.target);
    } catch (error) {
      await reopenConfirmation();
      return {
        ...result,
        status: "partial",
        reason: `Cleanup completed, but the board task could not be marked complete: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return result;
}
