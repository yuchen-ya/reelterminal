import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { createProjectStore } from "../../stores/project-store";
import { createEmptyProject } from "../../stores/project/project-helpers";
import { getReviewContext } from "./context";
import { reviewService } from "./service";
import { previewReviewMigration, migrateReviewProject, ReviewMigrationSavePending } from "./migration";
import { readReviewMigration, recoverReviewMigration } from "./migration-records";
import { buildWorkbenchIngestActions, buildWorkbenchTextRevisionActions } from "@reelterminal/core/actions/workbench-actions";
import { emptyWorkbenchState } from "@reelterminal/core/types/workbench";
import { reduceReviewActions } from "@reelterminal/core/review/reducer";

const mocks = vi.hoisted(() => ({ context: undefined as unknown, flush: vi.fn(async () => {}) }));
vi.mock("../workspace-manager", () => ({ workspaceManager: { getWorkspaceContext: vi.fn(async () => mocks.context), flushWorkspace: mocks.flush } }));
const previousIndexedDB = globalThis.indexedDB;
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory(); vi.stubGlobal("IDBKeyRange", IDBKeyRange); vi.stubGlobal("crypto", webcrypto);
  mocks.flush.mockReset(); mocks.flush.mockResolvedValue(undefined);
});
afterEach(() => { globalThis.indexedDB = previousIndexedDB; vi.unstubAllGlobals(); });

it("bounds concurrent media preview probes and retains source order", async () => {
  const project = createEmptyProject("Concurrent migration preview");
  const mediaIds = Array.from({ length: 9 }, (_, index) => `media-${index}`);
  const built = buildWorkbenchIngestActions(emptyWorkbenchState(), { batchId: "images", name: "Images", items: mediaIds.map(id => ({
    id: `item-${id}`, title: id, type: "image", content: { type: "image", mediaId: id, annotations: [], strokes: [] },
  })) });
  if (!built.ok) throw new Error(built.message);
  const source = { ...project, workbench: reduceReviewActions(emptyWorkbenchState(), built.actions).state,
    mediaLibrary: { ...project.mediaLibrary, items: mediaIds.map(id => ({
      id, name: `${id}.png`, type: "image" as const, fileHandle: null, blob: null, thumbnailUrl: null, waveformData: null,
      metadata: { width: 1, height: 1, duration: 0, frameRate: 0, codec: "png", sampleRate: 0, channels: 0, fileSize: 1 },
    })) } };
  const store = createProjectStore({ workspaceId: "source", isForeground: false });
  store.getState().loadProject(source);
  mocks.context = { store, projectId: project.id, workspaceId: "source", instanceId: crypto.randomUUID() };
  let active = 0;
  let peak = 0;
  const completed: string[] = [];
  const native = {
    mediaStore: { getVersion: async (id: string) => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, id.endsWith("0") ? 30 : 5));
      active--; completed.push(id);
      return { path: `C:/fixture/${id}.png`, contentHash: "a".repeat(64) };
    } },
    fs: { pathStatus: async () => ({ exists: true, isFile: true, sizeBytes: 1, lastModifiedMs: 1 }) },
  };
  const previous = window.reelterminal;
  Object.assign(window, { reelterminal: native });
  try {
    const review = await getReviewContext();
    const preview = await previewReviewMigration(review.target, { projectId: project.id, workspaceId: "source" });
    expect(peak).toBe(4);
    expect(completed[0]).not.toBe(mediaIds[0]);
    expect(preview.media.map(plan => plan.oldId)).toEqual(mediaIds);
    expect(preview.media.every(plan => plan.sourcePath && !plan.unavailableReason)).toBe(true);
  } finally { Object.assign(window, { reelterminal: previous }); }
});

it("recovers a project-save interruption once, locks legacy writes, and imports changed source as an undoable new batch", async () => {
  const project = createEmptyProject("Legacy migration fixture");
  const store = createProjectStore({ workspaceId: "legacy-workspace", isForeground: false, submitWorkspaceWrite: async operation => operation() });
  store.getState().loadProject(project);
  const context = { store, projectId: project.id, workspaceId: "legacy-workspace", instanceId: crypto.randomUUID(), revision: 0 };
  mocks.context = context;
  expect((await store.getState().executeAction({ type: "track/add", id: crypto.randomUUID(), timestamp: 1, params: { trackType: "video" } })).success).toBe(true);
  expect((await store.getState().ingestWorkbenchBatch({ batchId: "old-batch", name: "Old batch", items: [
    { id: "old-text", title: "Text", type: "text", content: { type: "text", entryId: "old-entry", title: "Text", speakerOrContext: "", versions: [{ version: 1, text: "Exact 👀\r\n", createdAt: 1, origin: "ingest" }] } },
    { id: "old-table", title: "Table", type: "data", content: { type: "data", datasetId: "old-dataset", columns: [{ columnId: "old-column", title: "Value" }], rows: [{ rowId: "old-row", cells: { "old-column": "001" } }], proposals: [] } },
  ] })).ok).toBe(true);
  expect((await store.getState().saveWorkbenchTextRevision("old-text", "Saved revision 👀\r\n")).ok).toBe(true);
  expect((await store.getState().saveWorkbenchDataPatches("old-table", [{ rowId: "old-row", columnId: "old-column", value: "002" }])).ok).toBe(true);
  const source = structuredClone(store.getState().project.workbench);
  const review = await getReviewContext();
  const preview = await previewReviewMigration(review.target, context);
  expect(preview.missingVersionCount).toBe(1);
  mocks.flush.mockRejectedValueOnce(new Error("simulated source storage interruption"));
  await expect(migrateReviewProject(preview, () => {})).rejects.toBeInstanceOf(ReviewMigrationSavePending);
  const pending = await readReviewMigration({ sourceProjectId: project.id, sourceWorkspaceId: context.workspaceId, sourceDigest: preview.sourceDigest });
  expect(pending).toMatchObject({ projectSaved: false });
  expect((await reviewService.listNodes(review.target)).nodes).toHaveLength(1);
  expect(store.getState().project.workbench).toEqual(source);
  expect(store.getState().actionHistory.getHistoryEntries().map(entry => entry.action.type)).toEqual(["track/add"]);
  expect((await store.getState().undo()).success).toBe(true);
  expect(store.getState().project.timeline.tracks).toHaveLength(0);
  expect(store.getState().project.workbench).toEqual(source);
  expect((await store.getState().saveWorkbenchTextRevision("old-text", "stale legacy result"))).toMatchObject({ ok: false, code: "CONFLICT" });
  const saved = await migrateReviewProject(preview, () => {});
  expect(saved).toMatchObject({ migrationId: pending!.migrationId, nodeId: pending!.nodeId, projectSaved: true });
  const revision = store.getState().workspaceRevision;
  await migrateReviewProject(preview, () => {});
  expect(store.getState().workspaceRevision).toBe(revision);
  expect((await reviewService.listNodes(review.target)).nodes).toHaveLength(1);
  const target = { ...review.target, nodeId: saved.nodeId };
  const initial = await reviewService.getNode(target);
  expect(initial.state.items).toHaveLength(2);
  const textId = saved.mapping.find(entry => entry.kind === "item" && entry.oldId === "old-text")!.newId;
  const tableId = saved.mapping.find(entry => entry.kind === "item" && entry.oldId === "old-table")!.newId;
  expect((await reviewService.getVersion(target, textId, 1)).content).toMatchObject({ versions: [{ text: "Exact 👀\r\n" }] });
  await expect(reviewService.getVersion(target, tableId, 1)).rejects.toMatchObject({ code: "NOT_FOUND" });
  const changed = buildWorkbenchTextRevisionActions(source!, "old-text", "Changed by an old app");
  if (!changed.ok) throw new Error(changed.message);
  const oldAppState = reduceReviewActions(source!, changed.actions).state;
  store.setState({ project: { ...store.getState().project, reviewMigration: undefined, workbench: oldAppState } });
  await recoverReviewMigration(store);
  expect(store.getState().project.reviewMigration?.nodeId).toBe(saved.nodeId);
  const changedPreview = await previewReviewMigration(review.target, context);
  expect(changedPreview.prior).toBeUndefined();
  expect(changedPreview.latest?.nodeId).toBe(saved.nodeId);
  const appended = await migrateReviewProject(changedPreview, () => {});
  expect(appended.nodeId).toBe(saved.nodeId);
  const updated = await reviewService.getNode(target);
  expect(updated.state.items).toHaveLength(4);
  expect(updated.state.batches).toHaveLength(2);
  expect(updated.state.items.find(item => item.id === textId)?.content).toMatchObject({ versions: [{ text: "Exact 👀\r\n" }, { text: "Saved revision 👀\r\n" }] });
  expect(updated.state.items.filter(item => item.type === "text").some(item => item.content.type === "text" && item.content.versions.at(-1)?.text === "Changed by an old app")).toBe(true);
  await reviewService.history({ target, expectedNodeRevision: updated.node.revision, requestId: crypto.randomUUID(), actor: "human", direction: "undo" });
  expect((await reviewService.getNode(target)).state.items).toHaveLength(2);
  expect(store.getState().project.workbench).toEqual(oldAppState);
});
