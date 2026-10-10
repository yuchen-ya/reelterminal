import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaItem, Project } from "@reelterminal/core";
import type { ProjectNodeRecord } from "../../services/workspace-manager";
import type { MediaReference } from "../../services/project-media-gc";
import { useProjectStore } from "../project-store";
import { createEmptyProject } from "./index";
import { loadMediaBlob } from "../../services/media-storage";
import { projectManager } from "../../services/project-manager";
import { autoSaveManager } from "../../services/auto-save";
import {
  compareNodes,
  createMediaCleanupPlan,
  estimateProjectPurge,
  executeMediaCleanupPlan,
  releaseUncommittedMediaBlob,
  trackUncommittedMediaBlob,
} from "../../services/project-media-gc";

const { importFile, saveMediaBlob, deleteMediaBlob, deleteUnderLock, storedMedia, storedMaterials, storedJournal, storedTasks, workspace } = vi.hoisted(
  () => ({
    importFile: vi.fn(),
    saveMediaBlob: vi.fn(),
    deleteMediaBlob: vi.fn(),
    deleteUnderLock: vi.fn(),
    storedMedia: new Map<string, { projectId: string; blob: Blob }>(),
    storedMaterials: [] as unknown[],
    storedJournal: [] as unknown[],
    storedTasks: [] as unknown[],
    workspace: {
      initialize: vi.fn(async () => undefined),
      listProjects: vi.fn(async () => []),
      getMediaReferences: vi.fn(async () => [] as MediaReference[]),
      getRuntimeMediaReferences: vi.fn(async () => []),
      getNode: vi.fn(async (_projectId: string, _nodeId: string): Promise<ProjectNodeRecord | null> => null),
    },
  }),
);

saveMediaBlob.mockImplementation(
  async (projectId: string, mediaId: string, blob: Blob) => {
    storedMedia.set(mediaId, { projectId, blob });
    return { contentHash: `hash-${mediaId}`, created: true };
  },
);
deleteMediaBlob.mockImplementation(async (mediaId: string) => {
  storedMedia.delete(mediaId);
});

vi.mock("../../services/media-storage", () => ({
  saveMediaBlob,
  deleteMediaBlob,
  deleteMediaBlobUnderReferenceWrite: deleteUnderLock,
  withMediaReferenceWrite: async <T>(operation: () => Promise<T> | T) => operation(),
  loadMediaBlob: vi.fn(async (mediaId: string) =>
    storedMedia.get(mediaId)?.blob ?? null,
  ),
  loadMediaRecord: vi.fn(async (mediaId: string) => {
    const record = storedMedia.get(mediaId);
    return record ? { ...record, id: mediaId, metadata: { fileSize: record.blob.size } } : null;
  }),
  getMediaIdsByProject: vi.fn(async (projectId: string) =>
    [...storedMedia.entries()]
      .filter(([, record]) => record.projectId === projectId)
      .map(([mediaId]) => mediaId),
  ),
  getAllStoredMedia: vi.fn(async () => [...storedMedia.entries()].map(([id, record]) => ({
    id,
    ...record,
    metadata: { fileSize: record.blob.size },
    sizeBytes: record.blob.size,
    controlledFiles: [],
  }))),
  loadProjectMedia: vi.fn(async () => []),
  loadFileHandle: vi.fn(async () => null),
  loadDirectoryHandle: vi.fn(async () => null),
}));

vi.mock("../../services/workspace-manager", () => ({ workspaceManager: workspace }));
vi.spyOn(projectManager, "listStoredProjects").mockResolvedValue([]);
vi.spyOn(autoSaveManager, "listRecoveryProjects").mockResolvedValue([]);
vi.mock("../../services/material-library/storage", () => ({
  createIdbMaterialStorage: () => ({
    loadAllMaterials: async () => storedMaterials,
    loadJournal: async () => storedJournal,
  }),
}));
vi.mock("../../services/agent-media-tasks/storage", () => ({
  createIdbAgentTaskStorage: () => ({ loadAll: async () => storedTasks }),
}));

vi.mock("../../bridges/media-bridge", () => ({
  getMediaBridge: vi.fn(() => ({
    isInitialized: vi.fn(() => true),
    importFile,
  })),
  initializeMediaBridge: vi.fn(async () => undefined),
}));

// Eviction/flush/sweep reclamation runs fire-and-forget; one macrotask drains
// the awaited mock storage calls.
const drain = () => new Promise((resolve) => setTimeout(resolve, 0));

const readBlobText = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });

describe("project media byte reclamation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storedMedia.clear();
    storedMaterials.length = 0;
    storedJournal.length = 0;
    storedTasks.length = 0;
    deleteUnderLock.mockImplementation(async (mediaId: string) => { storedMedia.delete(mediaId); });
    importFile.mockImplementation(async (file: File) => ({
      success: true,
      media: {
        blob: file,
        thumbnails: [],
        waveformData: null,
        metadata: {
          duration: 2,
          width: 320,
          height: 180,
          frameRate: 30,
          codec: "h264",
          sampleRate: 0,
          channels: 0,
          hasVideo: true,
          hasAudio: false,
        },
      },
    }));
    useProjectStore.getState().createNewProject("Media GC");
  });

  const importAsset = async (
    content: string,
    name: string,
    options: Parameters<
      ReturnType<typeof useProjectStore.getState>["importMedia"]
    >[1] = undefined,
  ) => {
    const imported = await useProjectStore
      .getState()
      .importMedia(new File([content], name, { type: "video/mp4" }), options);
    if (!imported.success || !imported.actionId) {
      throw new Error("seed import failed");
    }
    return imported.actionId;
  };

  const hasItem = (mediaId: string) =>
    useProjectStore
      .getState()
      .project.mediaLibrary.items.some((item) => item.id === mediaId);

  const comparisonNode = (
    id: string,
    items: MediaItem[],
    clips: Array<{ id: string; mediaId: string }>,
  ): ProjectNodeRecord => {
    const empty = createEmptyProject("Comparison");
    const project: Project = {
      ...empty,
      id: "comparison-project",
      mediaLibrary: { ...empty.mediaLibrary, items },
      timeline: { ...empty.timeline, tracks: [{ id: "track", clips } as Project["timeline"]["tracks"][number]] },
    };
    return {
      id, projectId: project.id, project, parentNodeId: null, name: id, summary: "",
      createdAt: 0, formatVersion: 1, mediaIds: items.map((item) => item.id), missingDependencies: [],
    };
  };
  const compare = async (from: ProjectNodeRecord, to: ProjectNodeRecord) => {
    workspace.getNode.mockImplementation(async (_projectId, nodeId) => nodeId === from.id ? from : to);
    return compareNodes({ projectId: from.projectId, fromNodeId: from.id, toNodeId: to.id });
  };
  const mediaVersion = (id: string, sourceId?: string): MediaItem => ({
    id,
    ...(sourceId ? { versionSource: { supersedesMediaIdInProject: sourceId } } : {}),
  } as MediaItem);

  it("reports no differences when comparing a node containing replacement lineage with itself", async () => {
    const node = comparisonNode("same", [mediaVersion("old"), mediaVersion("new", "old")], [{ id: "clip", mediaId: "new" }]);
    expect(await compare(node, node)).toMatchObject({
      added: [], removed: [], replaced: [], used: { added: [], removed: [], replaced: [] },
    });
  });

  it("recognizes candidate swaps by clip identity while retaining partially used original media", async () => {
    const items = [mediaVersion("old"), mediaVersion("candidate")];
    const from = comparisonNode("before", items, [
      { id: "changed-1", mediaId: "old" }, { id: "changed-2", mediaId: "old" }, { id: "unchanged", mediaId: "old" },
    ]);
    const to = comparisonNode("after", items, [
      { id: "changed-1", mediaId: "candidate" }, { id: "changed-2", mediaId: "candidate" }, { id: "unchanged", mediaId: "old" },
    ]);
    expect(await compare(from, to)).toMatchObject({
      added: [], removed: [], replaced: [],
      used: { added: [], removed: [], replaced: [{ fromMediaId: "old", toMediaId: "candidate" }] },
    });
  });

  it("does not infer a clip swap when a separately added clip uses an existing descendant version", async () => {
    const items = [mediaVersion("old"), mediaVersion("new", "old")];
    const original = { id: "original", mediaId: "old" };
    expect(await compare(
      comparisonNode("before", items, [original]),
      comparisonNode("after", items, [original, { id: "added", mediaId: "new" }]),
    )).toMatchObject({
      added: [], removed: [], replaced: [], used: { added: ["new"], removed: [], replaced: [] },
    });
  });

  it("separates newly introduced library lineage from timeline swaps and actual removals", async () => {
    expect(await compare(
      comparisonNode("before", [mediaVersion("old"), mediaVersion("unused")], [{ id: "clip", mediaId: "old" }]),
      comparisonNode("after", [mediaVersion("old"), mediaVersion("new", "old")], [{ id: "clip", mediaId: "new" }]),
    )).toMatchObject({
      added: [], removed: ["unused"], replaced: [{ fromMediaId: "old", toMediaId: "new" }],
      used: { added: [], removed: [], replaced: [{ fromMediaId: "old", toMediaId: "new" }] },
    });
  });

  it("keeps bytes readable when a delete is undone", async () => {
    const mediaId = await importAsset("kept-bytes", "clip.mp4");

    const deleted = await useProjectStore.getState().deleteMedia(mediaId);
    expect(deleted.success).toBe(true);
    expect(hasItem(mediaId)).toBe(false);
    await drain();
    expect(storedMedia.has(mediaId)).toBe(true);

    const undone = await useProjectStore.getState().undo();
    expect(undone.success).toBe(true);
    expect(hasItem(mediaId)).toBe(true);

    const bytes = await loadMediaBlob(mediaId);
    expect(bytes).not.toBeNull();
    expect(await readBlobText(bytes as Blob)).toBe("kept-bytes");
  });

  it("keeps bytes when a delete is undone and redone", async () => {
    const mediaId = await importAsset("roundtrip", "clip.mp4");
    await useProjectStore.getState().deleteMedia(mediaId);
    await useProjectStore.getState().undo();
    await drain();

    const redone = await useProjectStore.getState().redo();
    expect(redone.success).toBe(true);
    expect(hasItem(mediaId)).toBe(false);
    await drain();
    expect(storedMedia.has(mediaId)).toBe(true);
  });

  it("keeps unreferenced bytes after history eviction until reviewed cleanup", async () => {
    const mediaId = await importAsset("doomed", "clip.mp4");
    await useProjectStore.getState().deleteMedia(mediaId);
    await drain();
    expect(storedMedia.has(mediaId)).toBe(true);

    useProjectStore.getState().actionExecutor.getHistory().clear();
    await drain();
    expect(storedMedia.has(mediaId)).toBe(true);

    const plan = await createMediaCleanupPlan(useProjectStore.getState().project.id);
    expect(plan.candidates.map((entry) => entry.mediaId)).toContain(mediaId);
    await executeMediaCleanupPlan(plan);
    expect(storedMedia.has(mediaId)).toBe(false);
    expect(await loadMediaBlob(mediaId)).toBeNull();
  });

  it("keeps bytes a work asset references even after the delete entry is gone", async () => {
    const mediaId = await importAsset("referenced", "clip.mp4");
    const current = useProjectStore.getState().project;
    useProjectStore.setState({
      project: {
        ...current,
        workAssets: [
          {
            schemaVersion: 1,
            id: "wa-gc-1",
            kind: "single",
            name: "Kept trim",
            sourceMediaId: mediaId,
            sourceRange: { inSec: 0, outSec: 1 },
            unsupportedParams: [],
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      } as Project,
    });

    await useProjectStore.getState().deleteMedia(mediaId);
    await drain();
    expect(hasItem(mediaId)).toBe(false);

    // Nothing in history can restore the media item anymore, but the work
    // asset still references it (missingSource state), so the bytes stay.
    useProjectStore.getState().actionExecutor.getHistory().clear();
    await drain();
    expect(storedMedia.has(mediaId)).toBe(true);
  });

  it("keeps bytes for an undone agent import and redoes with data", async () => {
    const mediaId = await importAsset("agent-import", "clip.mp4", {
      historyOwner: "agent",
      historyGroupLabel: "agent: import",
    });
    expect(hasItem(mediaId)).toBe(true);

    const undone = await useProjectStore.getState().undo();
    expect(undone.success).toBe(true);
    expect(hasItem(mediaId)).toBe(false);
    await drain();
    // The import entry sits on the redo stack: its bytes must survive.
    expect(storedMedia.has(mediaId)).toBe(true);

    const redone = await useProjectStore.getState().redo();
    expect(redone.success).toBe(true);
    expect(hasItem(mediaId)).toBe(true);
    const bytes = await loadMediaBlob(mediaId);
    expect(await readBlobText(bytes as Blob)).toBe("agent-import");
  });

  it("keeps an evicted undone import until reviewed cleanup", async () => {
    const mediaId = await importAsset("orphan-to-be", "clip.mp4", {
      historyOwner: "agent",
      historyGroupLabel: "agent: import",
    });
    await useProjectStore.getState().undo();
    await drain();
    expect(storedMedia.has(mediaId)).toBe(true);

    // Any new history push drops the redo stack, taking the import entry with
    // it. Physical cleanup remains a separately reviewed operation.
    await useProjectStore.getState().renameProject("Another name");
    await drain();
    expect(storedMedia.has(mediaId)).toBe(true);

    const plan = await createMediaCleanupPlan(useProjectStore.getState().project.id);
    await executeMediaCleanupPlan(plan);
    expect(storedMedia.has(mediaId)).toBe(false);
  });

  it("keeps a deleted project's bytes after switching until a reviewed cleanup runs", async () => {
    const mediaId = await importAsset("switched-away", "clip.mp4");
    await useProjectStore.getState().deleteMedia(mediaId);
    await drain();
    // The open history still restores it, so the bytes are kept while the
    // project stays open.
    expect(storedMedia.has(mediaId)).toBe(true);

    useProjectStore.getState().createNewProject("Next project");
    await drain();
    // Switching drops runtime history roots but does not make a deletion
    // decision. A reviewed cleanup plan owns that decision.
    expect(storedMedia.has(mediaId)).toBe(true);

    const plan = await createMediaCleanupPlan();
    expect(plan.candidates.map((entry) => entry.mediaId)).toContain(mediaId);
    await executeMediaCleanupPlan(plan);
    expect(storedMedia.has(mediaId)).toBe(false);
  });

  it("keeps load-time orphans until a reviewed cleanup leaves loaded media intact", async () => {
    const mediaId = await importAsset("loaded-and-kept", "clip.mp4");
    const current = useProjectStore.getState().project;
    storedMedia.set("orphan-1", { projectId: current.id, blob: new Blob(["orphan"]) });

    const incoming = {
      ...createEmptyProject("Reloaded"),
      id: current.id,
      mediaLibrary: {
        ...current.mediaLibrary,
        items: [...current.mediaLibrary.items],
      },
    } as Project;
    useProjectStore.getState().loadProject(incoming);
    await drain();

    expect(storedMedia.has("orphan-1")).toBe(true);
    expect(storedMedia.has(mediaId)).toBe(true);
    expect(hasItem(mediaId)).toBe(true);

    const plan = await createMediaCleanupPlan(current.id);
    expect(plan.candidates.map((entry) => entry.mediaId)).toContain("orphan-1");
    expect(plan.retained.map((entry) => entry.mediaId)).toContain(mediaId);
    await executeMediaCleanupPlan(plan);
    expect(storedMedia.has("orphan-1")).toBe(false);
    expect(storedMedia.has(mediaId)).toBe(true);
  });

  it("retains shared bytes referenced from another project and rechecks before deletion", async () => {
    const projectId = useProjectStore.getState().project.id;
    storedMedia.set("shared-version", { projectId, blob: new Blob(["shared"]) });
    let references: Array<{
      mediaId: string;
      projectId: string;
      kind: "node";
      referenceId: string;
    }> = [];
    workspace.getMediaReferences.mockImplementation(async () => references);

    const plan = await createMediaCleanupPlan(projectId);
    expect(plan.candidates.map((entry) => entry.mediaId)).toContain("shared-version");

    // Another project may adopt the same immutable media id after the plan
    // is shown. The execution scan must protect it globally.
    references = [{
      mediaId: "shared-version",
      projectId: "another-project",
      kind: "node",
      referenceId: "saved-node",
    }];
    const result = await executeMediaCleanupPlan(plan);

    expect(result.deleted).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        entry: expect.objectContaining({ mediaId: "shared-version" }),
        reason: expect.stringContaining("node: saved-node"),
      }),
    ]);
    expect(storedMedia.has("shared-version")).toBe(true);
  });

  it("retains every material usage version and task result while their records remain", async () => {
    const projectId = useProjectStore.getState().project.id;
    for (const mediaId of ["material-historical", "material-replaced", "material-replaces", "journal-usage", "task-result"]) {
      storedMedia.set(mediaId, { projectId, blob: new Blob([mediaId]) });
    }
    storedMaterials.push({
      id: "material-1",
      title: "Versioned source",
      usages: [{
        projectId: "another-project",
        status: "historical",
        mediaIdInProject: "material-historical",
        replacedByMediaIdInProject: "material-replaced",
        replacesMediaIdInProject: "material-replaces",
      }],
    });
    storedJournal.push({
      id: "journal-1",
      changes: [{
        materialId: "material-removed-but-undoable",
        before: {
          id: "material-removed-but-undoable",
          title: "Undoable material",
          usages: [{ projectId: "another-project", mediaIdInProject: "journal-usage", status: "historical" }],
        },
        after: null,
      }],
    });
    storedTasks.push({
      id: "amt_old_output",
      targetProjectId: "removed-project",
      resultMediaId: "task-result",
    });

    const plan = await createMediaCleanupPlan(projectId);

    for (const mediaId of ["material-historical", "material-replaced", "material-replaces", "journal-usage", "task-result"]) {
      expect(plan.retained.map((entry) => entry.mediaId)).toContain(mediaId);
    }
    expect(plan.retained.find((entry) => entry.mediaId === "material-historical")?.reasons)
      .toEqual(expect.arrayContaining([expect.stringContaining("material: Versioned source")]));
    expect(plan.retained.find((entry) => entry.mediaId === "task-result")?.reasons)
      .toEqual(expect.arrayContaining([expect.stringContaining("task: Imported task result")]));
    expect(plan.retained.find((entry) => entry.mediaId === "journal-usage")?.reasons)
      .toEqual(expect.arrayContaining([expect.stringContaining("material: Undo/redo: Undoable material")]));
  });

  it("treats in-flight import bytes as live during reviewed cleanup", async () => {
    const mediaId = await importAsset("committed", "clip.mp4");
    const current = useProjectStore.getState().project;

    // Simulate bytes persisted by an import whose entry is not published yet.
    const pendingId = "pending-import";
    storedMedia.set(pendingId, { projectId: current.id, blob: new Blob(["pending"]) });
    trackUncommittedMediaBlob(pendingId);
    // ...and a plain orphan with no protection for contrast.
    storedMedia.set("plain-orphan", { projectId: current.id, blob: new Blob(["orphan"]) });

    const firstPlan = await createMediaCleanupPlan(current.id);
    expect(firstPlan.retained.map((entry) => entry.mediaId)).toContain(pendingId);
    await executeMediaCleanupPlan(firstPlan);
    expect(storedMedia.has("plain-orphan")).toBe(false);
    expect(storedMedia.has(pendingId)).toBe(true);
    expect(storedMedia.has(mediaId)).toBe(true);

    releaseUncommittedMediaBlob(pendingId);
    const secondPlan = await createMediaCleanupPlan(current.id);
    await executeMediaCleanupPlan(secondPlan);
    expect(storedMedia.has(pendingId)).toBe(false);
  });

  it("purges task-input bytes by purpose even when their display label was edited", async () => {
    const projectId = useProjectStore.getState().project.id;
    storedMedia.set("ti-labeled", { projectId, blob: new Blob(["1"]) });
    storedMedia.set("ti-relabeled", { projectId, blob: new Blob(["1"]) });
    workspace.getMediaReferences.mockImplementation(async () => [
      { mediaId: "ti-labeled", projectId, kind: "task", referenceId: "job-1", label: "Task input", purpose: "task-input" },
      // Editing the display label must not change the retention decision.
      { mediaId: "ti-relabeled", projectId, kind: "task", referenceId: "job-2", label: "Display label was edited", purpose: "task-input" },
    ]);

    const estimate = await estimateProjectPurge([projectId]);

    expect(estimate.mediaIds.sort()).toEqual(["ti-labeled", "ti-relabeled"]);
    // Both task inputs are purge candidates; every 1-byte record is counted.
    expect(estimate.bytes).toBe(2);
  });

  it("keeps task results and purpose-less task references retained regardless of label", async () => {
    const projectId = useProjectStore.getState().project.id;
    storedMedia.set("result-crafted-label", { projectId, blob: new Blob(["1"]) });
    storedMedia.set("legacy-task-ref", { projectId, blob: new Blob(["1"]) });
    storedMedia.set("unreferenced-bytes", { projectId, blob: new Blob(["1"]) });
    workspace.getMediaReferences.mockImplementation(async () => [
      // A task RESULT whose display label was crafted to mimic a task input.
      { mediaId: "result-crafted-label", projectId, kind: "task", referenceId: "amt_result", label: "Task input", purpose: "task-result" },
      // Legacy or foreign producers may omit the purpose entirely: kept.
      { mediaId: "legacy-task-ref", projectId, kind: "task", referenceId: "active-export", label: "Running export" },
    ]);

    const estimate = await estimateProjectPurge([projectId]);

    expect(estimate.mediaIds.sort()).toEqual([
      "legacy-task-ref",
      "result-crafted-label",
      "unreferenced-bytes",
    ]);
    // Only the unreferenced bytes are candidates; both task references held.
    expect(estimate.bytes).toBe(1);
  });

  it("reports an individual deletion failure without rejecting the cleanup", async () => {
    const projectId = useProjectStore.getState().project.id;
    storedMedia.set("orphan-with-delete-error", {
      projectId,
      blob: new Blob(["orphan"]),
    });
    deleteUnderLock.mockRejectedValueOnce(new Error("filesystem is busy"));

    const plan = await createMediaCleanupPlan(projectId);
    expect(plan.candidates.map((entry) => entry.mediaId)).toContain("orphan-with-delete-error");
    const result = await executeMediaCleanupPlan(plan);

    expect(deleteUnderLock).toHaveBeenCalledWith("orphan-with-delete-error");
    expect(result.skipped).toEqual([
      expect.objectContaining({
        entry: expect.objectContaining({ mediaId: "orphan-with-delete-error" }),
        reason: "filesystem is busy",
      }),
    ]);
    expect(storedMedia.has("orphan-with-delete-error")).toBe(true);
  });
});
