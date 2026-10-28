import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectNodeSummary } from "./workspace-manager";
import type { StoredCacheEntry, StoredMediaEntry } from "./media-storage";
import type { ProjectLibraryTrackedArtifactFile, ProjectLibraryTrackedWorkFingerprint } from "../../../desktop/src/shared/project-library-cleanup";

const state = vi.hoisted(() => ({
  revision: 4,
  persistedRevision: 4,
  instanceId: "runtime-cleanup-1",
  activeNodes: [] as Array<Record<string, unknown>>,
  deletedNodes: [] as Array<Record<string, unknown>>,
  workspaces: [] as Array<Record<string, unknown>>,
  media: [] as StoredMediaEntry[],
  cache: [] as Array<Record<string, unknown>>,
  references: [] as Array<Record<string, unknown>>,
  exportingProjectIds: new Set<string>(),
  deleteFailures: new Set<string>(),
  guardedDeleteCalls: [] as Array<{ mediaId: string; expectedFiles: readonly { path: string; sizeBytes: number; lastModifiedMs: number }[] }>,
  scanFailure: undefined as Error | undefined,
  requirements: [] as Array<Record<string, unknown>>,
  taskRecords: [] as Array<{
    jobId: string;
    kind: "export" | "analysis" | "audio-process";
    sourceRevision: number;
    state: "queued" | "running" | "done" | "error" | "cancelled";
    files: Array<{ path: string; sizeBytes: number; lastModifiedMs: number }>;
    retainedReason: string;
    artifactFiles?: ProjectLibraryTrackedArtifactFile[];
  }>,
  taskCleanupUnknowns: [] as string[],
  taskScanFailure: undefined as Error | undefined,
  taskDeleteFailures: new Set<string>(),
  taskPurgeCalls: [] as Array<{ projectId: string; workspaceId: string; jobIds: readonly string[]; expectedFiles: readonly { jobId: string; path: string; sizeBytes: number; lastModifiedMs: number }[] }>,
  pathReferences: [] as Array<{ pathKey: string; kind: "material"; referenceId: string }>,
  pathScanFailure: undefined as Error | undefined,
  editDuringExecutionPhase: false,
}));

vi.mock("./artifact-path-references", () => ({
  scanArtifactPathReferences: async () => {
    if (state.pathScanFailure) throw state.pathScanFailure;
    return [...state.pathReferences];
  },
}));

vi.mock("./workspace-manager", () => ({
  workspaceManager: {
    initialize: vi.fn(async () => undefined),
    flushWorkspace: vi.fn(async () => undefined),
    getWorkspaceContext: vi.fn(async (target: { projectId: string; workspaceId: string }) => ({
      projectId: target.projectId,
      workspaceId: target.workspaceId,
      revision: state.revision,
      instanceId: state.instanceId,
      store: {
        getState: () => ({
          project: { id: target.projectId, requirements: { items: state.requirements } },
          workspaceId: target.workspaceId,
        }),
      },
    })),
    getWorkspaceRevisionGuard: vi.fn(async (target: { projectId: string; workspaceId: string }) => ({
      projectId: target.projectId,
      workspaceId: target.workspaceId,
      revision: state.revision,
      persistedRevision: state.persistedRevision,
      instanceId: state.instanceId,
    })),
    listNodes: vi.fn(async (projectId: string) => state.activeNodes.filter((node) => node.projectId === projectId)),
    listDeletedNodes: vi.fn(async (projectId: string) => state.deletedNodes.filter((node) => node.projectId === projectId)),
    listWorkspaces: vi.fn(async (projectId: string) => state.workspaces.filter((workspace) => workspace.projectId === projectId)),
    applyCleanupNodeLifecycleUnderReferenceWrite: vi.fn(async (input: {
      projectId: string;
      action: "recycle" | "restore" | "purge";
      expectedNodes: readonly { id: string; createdAt: number; parentNodeId: string | null; recycledAt?: number; mediaIds: readonly string[] }[];
    }) => {
      const appliedNodeIds: string[] = [];
      const skipped: Array<{ nodeId: string; reason: string }> = [];
      for (const expected of input.expectedNodes) {
        const collection = [...state.activeNodes, ...state.deletedNodes];
        const found = collection.find((node) => node.id === expected.id && node.projectId === input.projectId);
        if (!found || found.recycledAt !== expected.recycledAt || found.createdAt !== expected.createdAt ||
          found.parentNodeId !== expected.parentNodeId || JSON.stringify([...(found.mediaIds as string[])].sort()) !== JSON.stringify([...expected.mediaIds].sort())) {
          skipped.push({ nodeId: expected.id, reason: "Node state or media references changed after review" });
          continue;
        }
        if (input.action === "purge") {
          state.activeNodes = state.activeNodes.filter((node) => node.id !== expected.id);
          state.deletedNodes = state.deletedNodes.filter((node) => node.id !== expected.id);
          state.references = state.references.filter((reference) => !(reference.kind === "node" && reference.referenceId === expected.id));
        } else if (input.action === "recycle") {
          const updated = { ...found, recycledAt: 10 };
          state.activeNodes = state.activeNodes.filter((node) => node.id !== expected.id);
          state.deletedNodes = [...state.deletedNodes.filter((node) => node.id !== expected.id), updated];
        } else {
          const { recycledAt: _recycledAt, ...updated } = found;
          state.deletedNodes = state.deletedNodes.filter((node) => node.id !== expected.id);
          state.activeNodes = [...state.activeNodes.filter((node) => node.id !== expected.id), updated];
        }
        appliedNodeIds.push(expected.id);
      }
      return { appliedNodeIds, skipped };
    }),
  },
}));

vi.mock("./media-storage", () => ({
  withMediaReferenceWrite: async <T>(operation: () => Promise<T> | T) => operation(),
  getAllStoredMedia: async () => [...state.media],
  getAllStoredCache: async () => [...state.cache],
  hasCompleteControlledMediaFingerprint: (record: { controlledFiles?: Array<{ lastModifiedMs?: number }> }) =>
    (record.controlledFiles ?? []).every((file) => Number.isFinite(file.lastModifiedMs)),
  isControlledMediaStorageAvailable: () => false,
  deleteMediaBlobUnderReferenceWrite: async (mediaId: string, _projectId?: string, expectedFiles?: readonly { path: string; sizeBytes: number; lastModifiedMs: number }[]) => {
    if (state.deleteFailures.has(mediaId)) throw new Error("controlled storage is busy");
    if (expectedFiles) state.guardedDeleteCalls.push({ mediaId, expectedFiles: [...expectedFiles] });
    state.media = state.media.filter((record) => record.id !== mediaId);
  },
  deleteStoredCacheIfUnchanged: async (entry: StoredCacheEntry) => {
    const current = state.cache.find((record) => record.key === entry.key);
    if (!current || current.sizeBytes !== entry.sizeBytes || current.timestamp !== entry.timestamp) return false;
    state.cache = state.cache.filter((record) => record.key !== entry.key);
    return true;
  },
}));

vi.mock("./project-media-gc", () => ({
  scanMediaReferences: async () => {
    if (state.scanFailure) throw state.scanFailure;
    return [...state.references];
  },
}));

vi.mock("./project-export-activity", () => ({
  getExportingProjectIds: () => new Set(state.exportingProjectIds),
}));

vi.mock("./cleanup-handoff", () => ({
  advanceCleanupReviewPhase: vi.fn(async (
    target: { projectId: string; workspaceId: string; revision: number; exportId?: string; scope: string; retention: string },
    nodeIds: readonly string[],
    phase: string,
    options: { confirmedExecution?: boolean } = {},
  ) => {
    const requirement = state.requirements.find((item) => item.id === state.requirements[0]?.id) as {
      id: string;
      cleanupHandoff: Record<string, unknown>;
    } | undefined;
    if (!requirement || !requirement.cleanupHandoff || requirement.cleanupHandoff.phase === "completed") throw new Error("Cleanup review task was not found");
    if (phase === "executing" && options.confirmedExecution !== true) throw new Error("confirmation required");
    const handoff = requirement.cleanupHandoff;
    if (handoff.projectId !== target.projectId || handoff.workspaceId !== target.workspaceId || handoff.exportId !== target.exportId ||
      handoff.revision !== target.revision || handoff.scope !== target.scope || handoff.retention !== target.retention ||
      JSON.stringify([...(handoff.nodeIds as string[])].sort()) !== JSON.stringify([...nodeIds].sort())) throw new Error("bound task mismatch");
    handoff.phase = phase;
    state.revision += 1;
    if (phase === "executing" && state.editDuringExecutionPhase) state.revision += 1;
    state.persistedRevision = state.revision;
    return { ...requirement, cleanupHandoff: { ...handoff, nodeIds: [...nodeIds] } };
  }),
}));

const projectLibraryApi = {
  purgeTrackedWorkFiles: vi.fn(async (args: { expectedFiles: readonly ProjectLibraryTrackedWorkFingerprint[] }) => ({
    actualBytes: args.expectedFiles.reduce((total, file) => total + file.sizeBytes, 0),
    deleted: args.expectedFiles,
    skipped: [], failed: [],
  })),
  listCleanupCandidates: vi.fn(async (_target: { projectId: string; workspaceId: string }) => {
    if (state.taskScanFailure) throw state.taskScanFailure;
    return { tasks: structuredClone(state.taskRecords), unknowns: [...state.taskCleanupUnknowns] };
  }),
  purgeFailedTaskRecords: vi.fn(async (args: {
    projectId: string;
    workspaceId: string;
    jobIds: readonly string[];
    expectedFiles: readonly { jobId: string; path: string; sizeBytes: number; lastModifiedMs: number }[];
  }) => {
    state.taskPurgeCalls.push(args);
    let actualBytes = 0;
    const deleted: Array<{ jobId: string; files: Array<{ path: string; sizeBytes: number; lastModifiedMs: number }> }> = [];
    const skipped: Array<{ jobId: string; reason: string }> = [];
    const failed: Array<{ jobId: string; reason: string }> = [];
    for (const jobId of args.jobIds) {
      const task = state.taskRecords.find((record) => record.jobId === jobId);
      const expected = args.expectedFiles.filter((file) => file.jobId === jobId).map(({ jobId: _jobId, ...file }) => file).sort((a, b) => a.path.localeCompare(b.path));
      const current = task?.files.map((file) => ({ ...file })).sort((a, b) => a.path.localeCompare(b.path)) ?? [];
      if (!task || (task.state !== "error" && task.state !== "cancelled") || JSON.stringify(expected) !== JSON.stringify(current)) {
        skipped.push({ jobId, reason: "Task identity or files changed" });
      } else if (state.taskDeleteFailures.has(jobId)) {
        failed.push({ jobId, reason: "Task ledger file is busy" });
      } else {
        deleted.push({ jobId, files: task.files });
        actualBytes += task.files.reduce((total, file) => total + file.sizeBytes, 0);
        state.taskRecords = state.taskRecords.filter((record) => record.jobId !== jobId);
      }
    }
    return { actualBytes, deleted, skipped, failed };
  }),
};

const { getCleanupReview, createCleanupPlan, executeCleanupPlan } = await import("./export-cleanup");

const target = { projectId: "project-1", workspaceId: "workspace-1" };

function node(id: string, mediaIds: string[], recycledAt?: number, parentNodeId: string | null = null): ProjectNodeSummary {
  return {
    id,
    projectId: target.projectId,
    parentNodeId,
    name: id,
    summary: "",
    createdAt: 1,
    formatVersion: 1,
    mediaIds,
    missingDependencies: [],
    ...(recycledAt !== undefined ? { recycledAt } : {}),
  };
}

function media(
  id: string,
  bytes: string,
  projectIds = [target.projectId],
  controlledFiles?: StoredMediaEntry["controlledFiles"],
): StoredMediaEntry {
  return {
    id,
    projectId: target.projectId,
    projectIds,
    blob: new Blob([bytes]),
    metadata: {} as StoredMediaEntry["metadata"],
    sizeBytes: bytes.length,
    ...(controlledFiles !== undefined ? { controlledFiles } : {}),
  };
}

function taskRecord(
  jobId: string,
  state: "queued" | "running" | "done" | "error" | "cancelled" = "error",
) {
  const files = state === "error" || state === "cancelled"
    ? [
      { path: `C:\\task-records\\${jobId}.json`, sizeBytes: 100, lastModifiedMs: 10 },
      { path: `C:\\task-records\\${jobId}.status.json`, sizeBytes: 20, lastModifiedMs: 11 },
    ]
    : [{ path: `C:\\task-records\\outputs\\${jobId}.mp4`, sizeBytes: 900, lastModifiedMs: 12 }];
  return {
    jobId,
    kind: "export" as const,
    sourceRevision: 3,
    state,
    files,
    retainedReason: state === "done" ? "Successful task output is retained." : "Terminal task record.",
  };
}

function confirm(plan: Awaited<ReturnType<typeof createCleanupPlan>>) {
  return { ...plan.confirmation, confirmed: true as const };
}

describe("shared export cleanup service", () => {
  beforeEach(() => {
    state.revision = 4;
    state.persistedRevision = 4;
    state.instanceId = "runtime-cleanup-1";
    state.activeNodes = [];
    state.deletedNodes = [];
    state.workspaces = [{ id: target.workspaceId, projectId: target.projectId, baseNodeId: null }];
    state.media = [];
    state.cache = [];
    state.references = [];
    state.exportingProjectIds.clear();
    state.deleteFailures.clear();
    state.guardedDeleteCalls = [];
    state.scanFailure = undefined;
    state.requirements = [];
    state.taskRecords = [];
    state.taskCleanupUnknowns = [];
    state.taskScanFailure = undefined;
    state.taskDeleteFailures.clear();
    state.taskPurgeCalls = [];
    state.pathReferences = [];
    state.pathScanFailure = undefined;
    state.editDuringExecutionPhase = false;
    Object.defineProperty(window, "reelterminal", { configurable: true, value: { projectLibrary: projectLibraryApi } });
    vi.clearAllMocks();
  });

  it("rejects an unconfirmed plan before deleting media", async () => {
    state.media = [media("orphan", "123")];
    const plan = await createCleanupPlan(target, "purge-media");
    expect(plan.status).toBe("ready");
    await expect(executeCleanupPlan({ ...confirm(plan), confirmed: false as true })).rejects.toThrow("confirmation does not match");
    expect(state.media).toHaveLength(1);
    expect(state.guardedDeleteCalls).toHaveLength(0);
  });

  it("requires explicit work-file selection, retains adopted files and outputs, and rechecks references before deletion", async () => {
    const artifact = (fileId: string, kind: "work" | "output" = "work"): ProjectLibraryTrackedArtifactFile => ({
      fileId, kind, path: `C:\\artifacts\\${fileId}.mp4`, purpose: "generation-attempt", origin: "agent", rebuildable: false,
      deliveryStatus: "pending", sizeBytes: 700, lastModifiedMs: 42,
    });
    state.taskRecords = [{ ...taskRecord("work-job", "done"), artifactFiles: [artifact("unused"), artifact("adopted"), artifact("final", "output")] }];
    state.pathReferences = [{ pathKey: "c:/artifacts/adopted.mp4", kind: "material", referenceId: "library" }];
    const review = await getCleanupReview(target);
    expect(review.workFiles.files.find((file) => file.fileId === "adopted")?.retainedBy).toEqual(["material: library"]);
    expect(review.workFiles.files.find((file) => file.fileId === "final")?.retainedReason).toBeTruthy();
    expect((await createCleanupPlan(target, "purge-work-files")).status).toBe("review-required");
    const plan = await createCleanupPlan(target, "purge-work-files", { workFileIds: ["work-job:unused"] });
    expect(plan.status).toBe("ready");
    expect(plan.reclaimableBytes).toBe(700);
    await expect(executeCleanupPlan({ ...confirm(plan), workFiles: [] })).rejects.toThrow("does not match");
    state.pathReferences.push({ pathKey: "c:/artifacts/unused.mp4", kind: "material", referenceId: "new-adoption" });
    const retained = await executeCleanupPlan(confirm(plan));
    expect(retained.status).toBe("partial");
    expect(retained.reclaimedBytes).toBe(0);
    expect(projectLibraryApi.purgeTrackedWorkFiles).not.toHaveBeenCalled();

    state.pathReferences.pop();
    const fresh = await createCleanupPlan(target, "purge-work-files", { workFileIds: ["work-job:unused"] });
    expect(await executeCleanupPlan(confirm(fresh))).toMatchObject({ status: "completed", reclaimedBytes: 700, deletedWorkFiles: [{ fileId: "unused" }] });
    state.pathScanFailure = new Error("unreadable review resources");
    const failedScan = await createCleanupPlan(target, "purge-work-files", { workFileIds: ["work-job:unused"] });
    expect(failedScan.status).toBe("review-required");
    expect(failedScan.candidateWorkFiles).toEqual([]);
    state.pathScanFailure = undefined;
    const beforeExport = await createCleanupPlan(target, "purge-work-files", { workFileIds: ["work-job:unused"] });
    state.exportingProjectIds.add("another-project");
    expect((await executeCleanupPlan(confirm(beforeExport))).status).toBe("blocked");
  });

  it("computes shared media as a union and frees it only after all selected deleted nodes are purged", async () => {
    state.deletedNodes = [node("node-a", ["shared-media"], 20), node("node-b", ["shared-media"], 30)];
    state.media = [media("shared-media", "1234")];
    state.references = [
      { mediaId: "shared-media", projectId: target.projectId, kind: "node", referenceId: "node-a" },
      { mediaId: "shared-media", projectId: target.projectId, kind: "node", referenceId: "node-b" },
    ];

    const review = await getCleanupReview(target, ["node-a", "node-b"]);
    expect(review.nodes.map((entry) => entry.nodeId)).toEqual(["node-a", "node-b"]);
    expect(review.nodes[0]?.media[0]).toMatchObject({ mediaId: "shared-media", relation: "shared", sizeBytes: 4 });
    expect(review.selected).toMatchObject({ mediaIds: ["shared-media"], exclusiveMediaIds: ["shared-media"], reclaimableBytes: 4 });

    const plan = await createCleanupPlan(target, "purge-deleted-nodes", { nodeIds: ["node-a", "node-b"] });
    expect(plan.candidateMedia).toMatchObject([{ mediaId: "shared-media", sizeBytes: 4 }]);
    expect(plan.reclaimableBytes).toBe(4);
    const result = await executeCleanupPlan(confirm(plan));

    expect(result).toMatchObject({ status: "completed", deletedNodeIds: ["node-a", "node-b"], deletedMediaIds: ["shared-media"], reclaimedBytes: 4 });
    expect(state.media).toEqual([]);
  });

  it("retains template and undo-history roots while listing a true orphan as a candidate", async () => {
    state.media = [media("template-media", "keep"), media("history-media", "undo"), media("orphan", "free")];
    state.references = [
      { mediaId: "template-media", projectId: target.projectId, kind: "template", referenceId: "template-1", label: "Reusable title" },
      { mediaId: "history-media", projectId: target.projectId, kind: "history", referenceId: target.workspaceId, label: "Undo/redo history" },
    ];

    const plan = await createCleanupPlan(target, "purge-media");
    expect(plan.selection.mediaIds).toEqual(["orphan"]);
    expect(plan.retainedMedia.find((entry) => entry.mediaId === "template-media")?.reasons)
      .toContain("template: Reusable title");
    expect(plan.retainedMedia.find((entry) => entry.mediaId === "history-media")?.reasons)
      .toContain("history: Undo/redo history");

    const result = await executeCleanupPlan(confirm(plan));
    expect(result.deletedMediaIds).toEqual(["orphan"]);
    expect(state.media.map((entry) => entry.id).sort()).toEqual(["history-media", "template-media"]);
  });

  it("fails closed when any reference scan fails", async () => {
    state.media = [media("unknown-retention", "keep")];
    state.scanFailure = new Error("template index is unreadable");

    const plan = await createCleanupPlan(target, "purge-media");
    expect(plan).toMatchObject({ status: "review-required", scanReady: false, candidateMedia: [], reclaimableBytes: 0 });
    const result = await executeCleanupPlan(confirm(plan));
    expect(result).toMatchObject({ status: "blocked", deletedMediaIds: [], reclaimedBytes: 0 });
    expect(state.media).toHaveLength(1);
  });

  it("marks a plan stale when the target revision changes after review", async () => {
    state.media = [media("orphan", "keep")];
    const plan = await createCleanupPlan(target, "purge-media");
    state.revision += 1;
    state.persistedRevision += 1;

    const result = await executeCleanupPlan(confirm(plan));
    expect(result).toMatchObject({ status: "stale", deletedMediaIds: [], reclaimedBytes: 0 });
    expect(state.media).toHaveLength(1);
  });

  it("reports a partial deletion with only bytes that were actually released", async () => {
    state.media = [media("deleted", "1234"), media("failed", "abcdef")];
    state.deleteFailures.add("failed");
    const plan = await createCleanupPlan(target, "purge-media");

    const result = await executeCleanupPlan(confirm(plan));
    expect(result.status).toBe("partial");
    expect(result.deletedMediaIds).toEqual(["deleted"]);
    expect(result.reclaimedBytes).toBe(4);
    expect(result.failed).toEqual([{ kind: "media", id: "failed", reason: "controlled storage is busy" }]);
    expect(state.media.map((entry) => entry.id)).toEqual(["failed"]);
  });

  it("requires complete controlled-file fingerprints and passes the approved file set to guarded deletion", async () => {
    state.media = [
      media("legacy-file", "old", [target.projectId], [{ path: "C:/media/legacy.mp4", sizeBytes: 3 }]),
      media("guarded-file", "new", [target.projectId], [{ path: "C:/media/guarded.mp4", sizeBytes: 3, lastModifiedMs: 123 }]),
    ];
    const plan = await createCleanupPlan(target, "purge-media");
    expect(plan.selection.mediaIds).toEqual(["guarded-file"]);
    expect(plan.retainedMedia.find((entry) => entry.mediaId === "legacy-file")?.reasons)
      .toContain("Controlled media file fingerprint is incomplete; removal is blocked.");

    const result = await executeCleanupPlan(confirm(plan));
    expect(result.deletedMediaIds).toEqual(["guarded-file"]);
    expect(state.guardedDeleteCalls).toEqual([{
      mediaId: "guarded-file",
      expectedFiles: [{ path: "C:/media/guarded.mp4", sizeBytes: 3, lastModifiedMs: 123 }],
    }]);
    expect(state.media.map((entry) => entry.id)).toEqual(["legacy-file"]);
  });

  it("skips a same-size controlled-file replacement after review", async () => {
    state.media = [media("guarded-file", "old", [target.projectId], [{
      path: "C:/media/guarded.mp4", sizeBytes: 3, lastModifiedMs: 123,
    }])];
    const plan = await createCleanupPlan(target, "purge-media");
    state.media = [media("guarded-file", "new", [target.projectId], [{
      path: "C:/media/guarded.mp4", sizeBytes: 3, lastModifiedMs: 124,
    }])];

    const result = await executeCleanupPlan(confirm(plan));
    expect(result.status).toBe("partial");
    expect(result.skipped).toContainEqual({ kind: "media", id: "guarded-file", reason: "Stored media changed after review" });
    expect(state.guardedDeleteCalls).toEqual([]);
    expect(state.media).toHaveLength(1);
  });

  it("scopes cache cleanup to the project and blocks it while an export is active", async () => {
    state.cache = [
      { key: `${target.projectId}:clip-a:0.000`, sizeBytes: 8, timestamp: 1 },
      { key: "project-2:clip-b:0.000", sizeBytes: 9, timestamp: 1 },
    ];
    state.exportingProjectIds.add(target.projectId);
    const blockedPlan = await createCleanupPlan(target, "purge-cache");
    expect(blockedPlan.status).toBe("review-required");
    expect((await executeCleanupPlan(confirm(blockedPlan))).status).toBe("blocked");
    expect(state.cache).toHaveLength(2);

    state.exportingProjectIds.clear();
    const plan = await createCleanupPlan(target, "purge-cache");
    expect(plan.selection.cacheKeys).toEqual([`${target.projectId}:clip-a:0.000`]);
    const result = await executeCleanupPlan(confirm(plan));
    expect(result).toMatchObject({ status: "completed", deletedCacheKeys: [`${target.projectId}:clip-a:0.000`], reclaimedBytes: 8 });
    expect(state.cache.map((entry) => entry.key)).toEqual(["project-2:clip-b:0.000"]);
  });

  it("reviews and plans only target failed task ledger records, leaving successful outputs retained", async () => {
    state.taskRecords = [taskRecord("failed-a", "error"), taskRecord("cancelled-b", "cancelled"), taskRecord("done-c", "done")];

    const review = await getCleanupReview(target);
    expect(review.failedJobs).toMatchObject({ scanReady: true, unknowns: [] });
    expect(review.failedJobs.tasks.map(({ jobId, candidate }) => [jobId, candidate])).toEqual([
      ["failed-a", true], ["cancelled-b", true], ["done-c", false],
    ]);

    const plan = await createCleanupPlan(target, "purge-failed-jobs");
    expect(plan.status).toBe("ready");
    expect(plan.selection.jobIds).toEqual(["cancelled-b", "failed-a"]);
    expect(plan.candidateJobs.map(({ jobId }) => jobId)).toEqual(["cancelled-b", "failed-a"]);
    expect(plan.candidateJobs.every((job) => job.files.length === 2 && job.files.every((file) => file.path.endsWith(".json")))).toBe(true);
    expect(plan.candidateJobs[0]?.reasons[0]).toContain("Task outputs, source media");
    expect(plan.retainedJobs.map(({ jobId }) => jobId)).toEqual(["done-c"]);
    expect(plan.reclaimableBytes).toBe(240);
  });

  it("requires exact job ids and file fingerprints, then reports actual ledger bytes", async () => {
    state.taskRecords = [taskRecord("failed-a")];
    const plan = await createCleanupPlan(target, "purge-failed-jobs", { jobIds: [] });
    expect(plan.confirmation).toMatchObject({ jobIds: ["failed-a"], jobFiles: [
      { jobId: "failed-a", path: "C:\\task-records\\failed-a.json", sizeBytes: 100, lastModifiedMs: 10 },
      { jobId: "failed-a", path: "C:\\task-records\\failed-a.status.json", sizeBytes: 20, lastModifiedMs: 11 },
    ] });

    const changed = structuredClone(confirm(plan));
    (changed.jobFiles[0] as { path: string }).path = "C:\\task-records\\other.json";
    await expect(executeCleanupPlan(changed)).rejects.toThrow("confirmation does not match");

    const result = await executeCleanupPlan(confirm(plan));
    expect(result).toMatchObject({ status: "completed", deletedJobIds: ["failed-a"], reclaimedBytes: 120 });
    expect(state.taskPurgeCalls).toEqual([{
      projectId: target.projectId,
      workspaceId: target.workspaceId,
      jobIds: ["failed-a"],
      expectedFiles: plan.confirmation.jobFiles,
    }]);
    expect(state.taskRecords).toEqual([]);
  });

  it("blocks failed-job cleanup when the durable task scan fails", async () => {
    state.taskRecords = [taskRecord("failed-a")];
    state.taskScanFailure = new Error("task ledger unavailable");
    const plan = await createCleanupPlan(target, "purge-failed-jobs");

    expect(plan).toMatchObject({ status: "review-required", candidateJobs: [], reclaimableBytes: 0 });
    expect(plan.blockers.join(" ")).toContain("durable task-record scan");
    expect((await executeCleanupPlan(confirm(plan))).status).toBe("blocked");
    expect(projectLibraryApi.purgeFailedTaskRecords).not.toHaveBeenCalled();
  });

  it("does not bind failed-job cleanup to a node-scoped board handoff", async () => {
    const cleanupTaskId = "requirement-node-cleanup";
    state.requirements = [{
      id: cleanupTaskId,
      cleanupHandoff: {
        projectId: target.projectId,
        workspaceId: target.workspaceId,
        revision: 1,
        nodeIds: ["node-a"],
        scope: "Purge selected node",
        retention: "Keep shared media",
        phase: "awaiting_confirmation",
      },
    }];
    state.taskRecords = [taskRecord("failed-a")];

    const plan = await createCleanupPlan({ ...target, cleanupTaskId }, "purge-failed-jobs");
    expect(plan.status).toBe("review-required");
    expect(plan.blockers).toContain("Workspace-level cache or failed-job cleanup cannot use a node-scoped cleanup task");
  });

  it("skips changed task records after review and reports only bytes from successful purges", async () => {
    state.taskRecords = [taskRecord("changed-a"), taskRecord("failed-b")];
    state.taskDeleteFailures.add("failed-b");
    const plan = await createCleanupPlan(target, "purge-failed-jobs");
    state.taskRecords = state.taskRecords.map((task) => task.jobId === "changed-a"
      ? { ...task, files: task.files.map((file) => ({ ...file, lastModifiedMs: file.lastModifiedMs + 1 })) }
      : task);

    const result = await executeCleanupPlan(confirm(plan));
    expect(result.status).toBe("partial");
    expect(result.deletedJobIds).toEqual([]);
    expect(result.reclaimedBytes).toBe(0);
    expect(result.skipped).toContainEqual({ kind: "job", id: "changed-a", reason: "Failed task identity, state, or ledger files changed after review" });
    expect(result.failed).toEqual([{ kind: "job", id: "failed-b", reason: "Task ledger file is busy" }]);
    expect(state.taskPurgeCalls[0]?.jobIds).toEqual(["failed-b"]);
  });

  it("keeps the stored confirmation isolated from a mutated review object", async () => {
    state.media = [media("orphan", "123")];
    const plan = await createCleanupPlan(target, "purge-media");
    (plan.confirmation.mediaIds as string[]).push("foreign-media");

    await expect(executeCleanupPlan(confirm(plan))).rejects.toThrow("confirmation does not match");
    expect(state.media).toHaveLength(1);
  });

  it("advances only the bound board task and accounts for its single revision during execution", async () => {
    const cleanupTaskId = "requirement-cleanup-1";
    const handoff = {
      projectId: target.projectId,
      workspaceId: target.workspaceId,
      exportId: "export-1",
      revision: 1,
      nodeIds: ["deleted-node"],
      scope: "Selected deleted node and exclusively retained media",
      retention: "Keep shared media and all other project references",
      phase: "awaiting_confirmation",
    };
    state.requirements = [{ id: cleanupTaskId, cleanupHandoff: handoff }];
    state.deletedNodes = [node("deleted-node", ["node-media"], 20)];
    state.media = [media("node-media", "1234")];
    state.references = [{ mediaId: "node-media", projectId: target.projectId, kind: "node", referenceId: "deleted-node" }];
    const cleanupTarget = { ...target, exportId: "export-1", cleanupTaskId };

    const plan = await createCleanupPlan(cleanupTarget, "purge-deleted-nodes");
    expect(plan).toMatchObject({ status: "ready", cleanupTask: { cleanupTaskId, handoff: { phase: "awaiting_confirmation" } } });
    expect(plan.confirmation.cleanupTaskNodeIds).toEqual(["deleted-node"]);

    state.editDuringExecutionPhase = true;
    const stale = await executeCleanupPlan(confirm(plan));
    expect(stale.status).toBe("stale");
    expect(state.deletedNodes).toHaveLength(1);
    expect((state.requirements[0]?.cleanupHandoff as Record<string, unknown> | undefined)?.phase).toBe("awaiting_confirmation");
    state.editDuringExecutionPhase = false;
    const retry = await createCleanupPlan(cleanupTarget, "purge-deleted-nodes");
    const result = await executeCleanupPlan(confirm(retry));
    expect(result).toMatchObject({ status: "completed", deletedNodeIds: ["deleted-node"], deletedMediaIds: ["node-media"] });
    expect((state.requirements[0]?.cleanupHandoff as Record<string, unknown> | undefined)?.phase).toBe("completed");
    expect(state.revision).toBe(9);
  });
});
