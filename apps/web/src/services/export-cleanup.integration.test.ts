import { beforeAll, expect, it } from "vitest";
import { Blob as NodeBlob } from "node:buffer";
import { IDBFactory } from "fake-indexeddb";
import { StorageEngine, type MediaItem, type MediaMetadata } from "@reelterminal/core";
import { createEmptyProject } from "../stores/project/project-helpers";
import { getProjectHistoryResourceCountsForStore } from "../stores/project-store";
import { createCleanupPlan, executeCleanupPlan, getCleanupReview } from "./export-cleanup";
import { getAllStoredMedia, loadMediaBlob, saveMediaBlob } from "./media-storage";
import { scanMediaReferences } from "./project-media-gc";
import { workspaceManager } from "./workspace-manager";
import { advanceCleanupReviewPhase, publishCleanupReview } from "./cleanup-handoff";
import { scanArtifactPathReferences } from "./artifact-path-references";
import { openMaterialDatabase } from "./material-library/storage";
import { projectTemplateStorage } from "./project-template-storage";

const metadata: MediaMetadata = {
  duration: 1,
  width: 320,
  height: 180,
  frameRate: 30,
  codec: "h264",
  sampleRate: 0,
  channels: 0,
  fileSize: 5,
};

function mediaItem(id: string): MediaItem {
  return {
    id,
    name: `${id}.mp4`,
    type: "video",
    fileHandle: null,
    blob: null,
    metadata,
    thumbnailUrl: null,
    waveformData: null,
  };
}

function mediaBytes(value: string): Blob {
  return new NodeBlob([value]) as unknown as Blob;
}

function withMedia(project: ReturnType<typeof createEmptyProject>, item: MediaItem) {
  return {
    ...project,
    mediaLibrary: {
      ...project.mediaLibrary,
      items: [...project.mediaLibrary.items, item],
    },
  };
}

beforeAll(async () => {
  globalThis.indexedDB = new IDBFactory();
  await workspaceManager.initialize();
});

it("retains the complete ancestor chain when another workspace adopts a reviewed child before purge", async () => {
  const created = await workspaceManager.createProject(createEmptyProject(`Ancestor protection ${crypto.randomUUID()}`));
  const target = { projectId: created.project.id, workspaceId: created.defaultWorkspaceId };
  const branch = await workspaceManager.createWorkspace(target.projectId);
  const branchTarget = { projectId: target.projectId, workspaceId: branch.id };
  const context = await workspaceManager.getWorkspaceContext(branchTarget);
  await context.store.getState().createTextClipOnNewTrack(0, "Parent");
  const parent = await workspaceManager.saveNode({ target: branchTarget, name: "Parent" });
  await context.store.getState().createTextClipOnNewTrack(1, "Child");
  const child = await workspaceManager.saveNode({ target: branchTarget, name: "Child" });
  expect(child.node.parentNodeId).toBe(parent.node.id);
  const guard = await workspaceManager.getWorkspaceRevisionGuard(branchTarget);
  await workspaceManager.deleteWorkspace(branchTarget, { expectedRevision: guard.revision });
  await workspaceManager.deleteNode({ projectId: target.projectId, nodeId: parent.node.id });
  await workspaceManager.deleteNode({ projectId: target.projectId, nodeId: child.node.id });
  const plan = await createCleanupPlan(target, "purge-deleted-nodes", { nodeIds: [parent.node.id, child.node.id] });
  expect(plan.status).toBe("ready");
  const adopted = await workspaceManager.createWorkspace(target.projectId, { sourceNodeId: child.node.id });
  const result = await executeCleanupPlan({ ...plan.confirmation, confirmed: true });
  expect(result.status).toBe("partial");
  expect(result.deletedNodeIds).toEqual([]);
  expect(result.skipped.map((entry) => entry.id).sort()).toEqual([parent.node.id, child.node.id].sort());
  expect((await workspaceManager.getNode(target.projectId, child.node.id))?.parentNodeId).toBe(parent.node.id);
  expect(await workspaceManager.getNode(target.projectId, parent.node.id)).not.toBeNull();
  expect((await workspaceManager.getWorkspaceContext({ projectId: target.projectId, workspaceId: adopted.id })).store.getState().project.timeline.tracks.length).toBeGreaterThan(0);
});

it("finds adopted file paths in real project history, material journal, templates and independent review resources", async () => {
  const suffix = crypto.randomUUID();
  const created = await workspaceManager.createProject(createEmptyProject(`Path references ${suffix}`));
  const target = { projectId: created.project.id, workspaceId: created.defaultWorkspaceId };
  const context = await workspaceManager.getWorkspaceContext(target);
  const sourcePath = `E:\\artifacts\\${suffix}.mp4`;
  const item = { ...mediaItem(`path-${suffix}`), originalUrl: sourcePath };
  context.store.setState({ project: withMedia(context.store.getState().project, item) });
  const template = projectTemplateStorage.createFromProject(context.store.getState().project, { name: `Paths ${suffix}`, description: "", category: "custom", tags: [], placeholders: [] });
  await projectTemplateStorage.saveTemplate({ ...template, projectSnapshot: context.store.getState().project });
  expect((await context.store.getState().deleteMedia(item.id)).success).toBe(true);
  await workspaceManager.flushWorkspace(target);
  const database = await openMaterialDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(["journal", "fileResources"], "readwrite");
      transaction.objectStore("journal").put({ id: `journal-${suffix}`, changes: [{ before: { fileRef: { path: sourcePath } } }] });
      transaction.objectStore("fileResources").put({ id: `review-${suffix}`, sourcePath });
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { database.close(); }
  const references = (await scanArtifactPathReferences()).filter((reference) => reference.pathKey === sourcePath.replace(/\\/g, "/").toLowerCase());
  expect(references.map((reference) => reference.kind)).toEqual(expect.arrayContaining(["history", "material", "template", "review"]));
  expect(context.store.getState().project.mediaLibrary.items).toEqual([]);
});

it("uses real workspace and media-reference providers to purge a shared node union while retaining undo history and preserving it through cache cleanup", async () => {
  const suffix = crypto.randomUUID();
  const project = createEmptyProject(`Cleanup integration ${suffix}`);
  const created = await workspaceManager.createProject(project);
  const target = { projectId: project.id, workspaceId: created.defaultWorkspaceId };
  const defaultContext = await workspaceManager.getWorkspaceContext(target);

  // This unrelated media is removed through a real undoable edit. The real
  // history provider must keep its bytes while cleanup removes the node media.
  const historyMediaId = `cleanup-history-${suffix}`;
  await saveMediaBlob(project.id, historyMediaId, mediaBytes("history"), metadata);
  defaultContext.store.setState({ project: withMedia(defaultContext.store.getState().project, mediaItem(historyMediaId)) });
  const historyDelete = await defaultContext.store.getState().deleteMedia(historyMediaId);
  expect(historyDelete.success).toBe(true);
  await workspaceManager.flushWorkspace(target);
  expect(await scanMediaReferences({ projectId: project.id, mediaId: historyMediaId }))
    .toEqual(expect.arrayContaining([expect.objectContaining({ kind: "history", mediaId: historyMediaId })]));

  // Save two immutable snapshots in a disposable workspace, then delete that
  // workspace so neither snapshot remains a workspace base.
  const branch = await workspaceManager.createWorkspace(project.id, { name: `Node branch ${suffix}` });
  const branchTarget = { projectId: project.id, workspaceId: branch.id };
  const branchContext = await workspaceManager.getWorkspaceContext(branchTarget);
  const sharedMediaId = `cleanup-shared-${suffix}`;
  await saveMediaBlob(project.id, sharedMediaId, mediaBytes("video"), metadata);
  expect(await getAllStoredMedia()).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: sharedMediaId, sizeBytes: 5 }),
  ]));
  branchContext.store.setState({ project: withMedia(branchContext.store.getState().project, mediaItem(sharedMediaId)) });
  await workspaceManager.flushWorkspace(branchTarget);
  const first = await workspaceManager.saveNode({ target: branchTarget, name: "Shared source" });

  const projectWithMarker = branchContext.store.getState().project;
  branchContext.store.setState({
    project: {
      ...projectWithMarker,
      name: `${projectWithMarker.name} second snapshot`,
    },
  });
  await workspaceManager.flushWorkspace(branchTarget);
  const second = await workspaceManager.saveNode({ target: branchTarget, name: "Shared edit" });
  const branchGuard = await workspaceManager.getWorkspaceRevisionGuard(branchTarget);
  await workspaceManager.deleteWorkspace(branchTarget, { expectedRevision: branchGuard.revision });

  const selectedNodeIds = [first.node.id, second.node.id];
  const review = await getCleanupReview(target, selectedNodeIds);
  expect(review.nodes.filter((node) => selectedNodeIds.includes(node.nodeId))).toHaveLength(2);
  expect(review.nodes.filter((node) => selectedNodeIds.includes(node.nodeId)).map((node) => node.media[0]?.relation))
    .toEqual(["shared", "shared"]);
  expect(review.selected).toMatchObject({
    mediaIds: [sharedMediaId],
    exclusiveMediaIds: [sharedMediaId],
    reclaimableBytes: 5,
  });

  const recyclePlan = await createCleanupPlan(target, "recycle-nodes", { nodeIds: selectedNodeIds });
  expect([...(await executeCleanupPlan({ ...recyclePlan.confirmation, confirmed: true })).updatedNodeIds].sort())
    .toEqual([...selectedNodeIds].sort());

  await workspaceManager.activateWorkspace(target);
  const beforeHandoff = await workspaceManager.getWorkspaceRevisionGuard(target);
  const handoffTarget = {
    ...target,
    revision: beforeHandoff.revision,
    scope: "Permanently purge the two selected deleted version nodes and their shared unreferenced media",
    retention: "Keep undo history, saved templates, recovery drafts, and every other project reference",
  };
  const decoy = await workspaceManager.createProject(createEmptyProject(`Cleanup decoy ${suffix}`));
  const decoyTarget = { projectId: decoy.project.id, workspaceId: decoy.defaultWorkspaceId };
  await workspaceManager.activateWorkspace(decoyTarget);
  expect((await workspaceManager.getActiveWorkspace())?.id).toBe(decoyTarget.workspaceId);
  const published = await publishCleanupReview(handoffTarget, selectedNodeIds, { store: defaultContext.store });
  await advanceCleanupReviewPhase(handoffTarget, selectedNodeIds, "reviewing", { store: defaultContext.store });
  await advanceCleanupReviewPhase(handoffTarget, selectedNodeIds, "awaiting_confirmation", { store: defaultContext.store });
  const cleanupTarget = { ...target, cleanupTaskId: published.id };

  const purgePlan = await createCleanupPlan(cleanupTarget, "purge-deleted-nodes");
  expect(purgePlan.candidateMedia.map((candidate) => candidate.mediaId)).toEqual([sharedMediaId]);
  expect(purgePlan.reclaimableBytes).toBe(5);

  const purgeResult = await executeCleanupPlan({ ...purgePlan.confirmation, confirmed: true });
  expect(purgeResult).toMatchObject({
    status: "completed",
    deletedNodeIds: [...selectedNodeIds].sort(),
    deletedMediaIds: [sharedMediaId],
    reclaimedBytes: 5,
  });
  expect(await getAllStoredMedia()).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: sharedMediaId })]));
  expect(await loadMediaBlob(sharedMediaId)).toBeNull();
  expect(await loadMediaBlob(historyMediaId)).not.toBeNull();
  expect(await scanMediaReferences({ projectId: project.id, mediaId: historyMediaId }))
    .toEqual(expect.arrayContaining([expect.objectContaining({ kind: "history", mediaId: historyMediaId })]));
  expect((await workspaceManager.getWorkspaceContext(target)).store.getState().project.requirements?.items
    .find((item) => item.id === published.id)?.cleanupHandoff?.phase).toBe("completed");

  await defaultContext.store.getState().createTextClipOnNewTrack(0, "History survives cache cleanup");
  const historyBeforeCacheCleanup = getProjectHistoryResourceCountsForStore(defaultContext.store);
  const cacheKey = `${project.id}:cleanup-integration:0.000`;
  await new StorageEngine().saveCache({
    key: cacheKey,
    data: new Uint8Array([1, 2, 3, 4]).buffer,
    size: 4,
    timestamp: Date.now(),
  });
  const cachePlan = await createCleanupPlan(target, "purge-cache");
  expect(cachePlan.candidateCache.map((candidate) => candidate.key)).toContain(cacheKey);
  const cacheResult = await executeCleanupPlan({ ...cachePlan.confirmation, confirmed: true });
  expect(cacheResult.deletedCacheKeys).toContain(cacheKey);
  expect(await new StorageEngine().loadCache(cacheKey)).toBeNull();
  expect(getProjectHistoryResourceCountsForStore(defaultContext.store)).toEqual(historyBeforeCacheCleanup);
});
