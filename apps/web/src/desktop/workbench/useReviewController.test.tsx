import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IDBFactory, IDBIndex, IDBKeyRange } from "fake-indexeddb";
import { buildWorkbenchImageRepairAction, buildWorkbenchIngestActions } from "@reelterminal/core/actions/workbench-actions";
import { getReviewContext } from "../../services/review-workspace/context";
import { reviewService } from "../../services/review-workspace/service";
import { useReviewController } from "./useReviewController";
import { toItemView } from "./useWorkbenchController";
import type { WorkbenchItem } from "@reelterminal/core/types/workbench";
import type { FileResource } from "@reelterminal/core/review/types";
import { useWorkbenchUiStore } from "../../stores/workbench-ui-store";

// Independent review nodes do not use the legacy project store or initialize its video engines.
vi.mock("../../stores/project-store", () => ({ useProjectStore: vi.fn() }));

const originalIndexedDB = globalThis.indexedDB;
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  useWorkbenchUiStore.getState().resetProjectScopedState();
});
afterEach(() => { cleanup(); globalThis.indexedDB = originalIndexedDB; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("displays a replacement image rather than a repair from an older content version", () => {
  const item: WorkbenchItem = { id: crypto.randomUUID(), batchId: crypto.randomUUID(), orderIndex: 0, title: "Replacement", type: "image", version: 3, createdAt: 1,
    content: { type: "image", mediaId: "replacement", annotations: [], strokes: [] }, provenanceTags: [], userTags: [], status: "kept", decisionLog: [],
    revisions: [{ id: crypto.randomUUID(), itemId: "unused", kind: "image-repair", parentVersion: 1, producedVersion: 2, createdAt: 2, mediaId: "old-repair" },
      { id: crypto.randomUUID(), itemId: "unused", kind: "agent-rework", parentVersion: 2, producedVersion: 3, createdAt: 3 }] };
  expect(toItemView(item, () => undefined, [], null, null).imagePayload).toMatchObject({ initialDisplayMode: "original" });
  expect(toItemView(item, () => undefined, [], null, null).imagePayload?.repair).toBeUndefined();
  expect(toItemView({ ...item, version: 2 }, () => undefined, [], null, null).imagePayload?.repair).toMatchObject({ mediaId: "old-repair", producedVersion: 2 });
});

it("uses scoped planning and commits for decisions and emits a manual step only for a saved content edit", async () => {
  const { target: workspaceTarget } = await getReviewContext();
  const node = await reviewService.createNode({ target: workspaceTarget, name: "Controller scope", expectedWorkspaceRevision: 0, requestId: crypto.randomUUID() });
  const target = { ...workspaceTarget, nodeId: node.id };
  const batchId = crypto.randomUUID();
  const itemIds = [crypto.randomUUID(), crypto.randomUUID()];
  await reviewService.commit({ target, expectedNodeRevision: 0, requestId: crypto.randomUUID(), actor: "human", label: "Seed", request: {},
    build: state => {
      const built = buildWorkbenchIngestActions(state, { batchId, name: "Members", items: itemIds.map(id => ({
        id, title: id, type: "text", content: { type: "text", entryId: id, title: id, speakerOrContext: "",
          versions: [{ version: 1, text: "Original", createdAt: 1, origin: "ingest" }] },
      })) });
      if (!built.ok) throw new Error(built.message);
      return built.actions;
    } });
  const { result } = renderHook(() => useReviewController(target));
  await waitFor(() => expect(result.current.loading).toBe(false));
  const getAll = IDBIndex.prototype.getAll;
  let allowStepGraph = false;
  const readSpy = vi.spyOn(IDBIndex.prototype, "getAll").mockImplementation(function (this: IDBIndex, ...args) {
    if (this.name === "node" && ["reviewItems", "reviewVersions", "reviewFeedback", "reviewHandoffs"].includes(this.objectStore.name)) {
      throw new Error(`Controller loaded the whole node: ${this.objectStore.name}`);
    }
    if (this.objectStore.name === "reviewSteps" && !allowStepGraph) throw new Error("A decision loaded the processing graph");
    return getAll.apply(this, args);
  });
  try {
    await act(async () => { expect(await result.current.controller.commitDecision("kept", [itemIds[0]])).toEqual({ ok: true }); });
    await waitFor(() => expect(result.current.overview?.node.revision).toBe(2));
    await waitFor(() => expect(result.current.loading).toBe(false));
    allowStepGraph = true;
    await act(async () => { expect(await result.current.controller.saveTextRevision(itemIds[0], "Saved text")).toEqual({ ok: true }); });
    await waitFor(() => expect(result.current.overview?.node.revision).toBe(3));
  } finally { readSpy.mockRestore(); }
  const snapshot = await reviewService.getNode(target);
  expect(snapshot.state.batches[0].itemIds).toEqual(itemIds);
  expect(snapshot.state.items.find(item => item.id === itemIds[1])).toMatchObject({ version: 1, status: "pending" });
  expect(snapshot.state.items.find(item => item.id === itemIds[0])).toMatchObject({ version: 2, status: "modified" });
  expect(snapshot.steps).toMatchObject([{ state: "completed", inputs: [{ itemId: itemIds[0], version: 1 }], outputs: [{ itemId: itemIds[0], version: 2 }] }]);
  await act(async () => { expect(await result.current.controller.undoLast()).toEqual({ ok: true }); });
  expect((await reviewService.getItem(target, itemIds[0])).item).toMatchObject({ version: 1, status: "kept" });
});

async function imageBatches() {
  const { target: workspaceTarget } = await getReviewContext();
  const node = await reviewService.createNode({ target: workspaceTarget, name: "Detail lifetime", expectedWorkspaceRevision: 0, requestId: crypto.randomUUID() });
  const target = { ...workspaceTarget, nodeId: node.id };
  const batches = [];
  for (let index = 0; index < 2; index++) {
    const batchId = crypto.randomUUID();
    const itemIds = [crypto.randomUUID(), crypto.randomUUID()];
    const resources: FileResource[] = itemIds.map(() => ({ id: crypto.randomUUID(), storage: { kind: "blob", blobId: crypto.randomUUID() },
      originalFileName: "image.png", mime: "image/png", size: 1, createdAt: 1, source: "user",
      metadata: { type: "image", width: 100, height: 100, durationSec: 0, frameRate: 0, codec: "png" } }));
    await reviewService.commit({ target, expectedNodeRevision: index, requestId: crypto.randomUUID(), actor: "human", label: "Seed images", request: { batchId }, resources,
      build: state => {
        const built = buildWorkbenchIngestActions(state, { batchId, name: `Batch ${index}`, items: itemIds.map((id, itemIndex) => ({ id, title: id, type: "image",
          content: { type: "image", mediaId: resources[itemIndex].id, annotations: [], strokes: [] } })) });
        if (!built.ok) throw new Error(built.message);
        return built.actions;
      } });
    batches.push({ batchId, itemIds, resources });
  }
  return { target, batches };
}

it.each(["revision", "batch"] as const)("evicts collection details and media after a %s change, preserving reuse within the same scope", async change => {
  const { target, batches } = await imageBatches();
  const first = batches[0];
  const { result } = renderHook(() => useReviewController(target));
  await waitFor(() => expect(result.current.loading).toBe(false));
  act(() => result.current.controller.setActiveBatchId(first.batchId));
  await waitFor(() => expect(result.current.controller.currentItem?.id).toBe(first.itemIds[0]));
  await waitFor(() => expect(result.current.loading).toBe(false));
  const reads = vi.spyOn(reviewService, "getItem");
  await act(async () => { await result.current.controller.ensureItemsLoaded([first.itemIds[1]]); });
  expect(result.current.controller.mediaAssets.map(media => media.id)).toContain(first.resources[1].id);
  expect(result.current.controller.batchItems.find(item => item.id === first.itemIds[1])?.detailsLoaded).toBe(true);
  act(() => result.current.controller.focusItem(first.itemIds[1]));
  await waitFor(() => expect(result.current.loading).toBe(false));
  act(() => result.current.controller.focusItem(first.itemIds[0]));
  await waitFor(() => expect(result.current.loading).toBe(false));
  const beforeReuse = reads.mock.calls.length;
  await act(async () => { await result.current.controller.ensureItemsLoaded([first.itemIds[1]]); });
  expect(reads).toHaveBeenCalledTimes(beforeReuse);
  if (change === "revision") {
    await act(async () => { expect(await result.current.controller.commitDecision("kept", [first.itemIds[0]], { advance: false })).toEqual({ ok: true }); });
    await waitFor(() => expect(result.current.overview?.node.revision).toBe(3));
  } else {
    act(() => result.current.controller.setActiveBatchId(batches[1].batchId));
    await waitFor(() => expect(result.current.controller.currentItem?.batchId).toBe(batches[1].batchId));
  }
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.controller.mediaAssets.map(media => media.id)).not.toContain(first.resources[1].id);
  if (change === "revision") {
    expect(result.current.controller.batchItems.find(item => item.id === first.itemIds[1])?.detailsLoaded).toBe(false);
    await act(async () => { await result.current.controller.ensureItemsLoaded([first.itemIds[1]]); });
    expect(result.current.controller.batchItems.find(item => item.id === first.itemIds[1])?.detailsLoaded).toBe(true);
  } else {
    reads.mockClear();
    act(() => result.current.controller.setActiveBatchId(first.batchId));
    await waitFor(() => expect(result.current.controller.currentItem?.id).toBe(first.itemIds[0]));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.controller.batchItems.find(item => item.id === first.itemIds[1])?.detailsLoaded).toBe(false);
    await act(async () => { await result.current.controller.ensureItemsLoaded([first.itemIds[1]]); });
    expect(reads).toHaveBeenCalledWith(target, first.itemIds[1]);
  }
});

it.each(["revision", "batch"] as const)("discards collection media that finishes loading after a %s change", async change => {
  const { target, batches } = await imageBatches();
  const first = batches[0];
  const { result } = renderHook(() => useReviewController(target));
  await waitFor(() => expect(result.current.loading).toBe(false));
  act(() => result.current.controller.setActiveBatchId(first.batchId));
  await waitFor(() => expect(result.current.controller.currentItem?.id).toBe(first.itemIds[0]));
  await waitFor(() => expect(result.current.loading).toBe(false));
  let finish!: (resources: readonly FileResource[]) => void;
  const pending = new Promise<readonly FileResource[]>(resolve => { finish = resolve; });
  const getResources = reviewService.getResources.bind(reviewService);
  const reads = vi.spyOn(reviewService, "getResources").mockImplementation(ids => ids.includes(first.resources[1].id) ? pending : getResources(ids));
  let load!: Promise<void>;
  act(() => { load = result.current.controller.ensureItemsLoaded([first.itemIds[1]]); });
  await waitFor(() => expect(reads).toHaveBeenCalledWith([first.resources[1].id]));
  if (change === "revision") {
    await act(async () => { expect(await result.current.controller.commitDecision("kept", [first.itemIds[0]], { advance: false })).toEqual({ ok: true }); });
    await waitFor(() => expect(result.current.overview?.node.revision).toBe(3));
  } else {
    act(() => result.current.controller.setActiveBatchId(batches[1].batchId));
    await waitFor(() => expect(result.current.controller.currentItem?.batchId).toBe(batches[1].batchId));
  }
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async () => { finish([first.resources[1]]); await load; });
  expect(result.current.controller.mediaAssets.map(media => media.id)).not.toContain(first.resources[1].id);
});

it("retains the selected detail through an external repair refresh and blocks edits until the new snapshot arrives", async () => {
  const { target, batches } = await imageBatches();
  const first = batches[0];
  const frames: Array<string | null> = [];
  let record = false;
  const { result } = renderHook(() => {
    const state = useReviewController(target);
    if (record) frames.push(state.controller.currentItem?.id ?? null);
    return state;
  });
  await waitFor(() => expect(result.current.loading).toBe(false));
  act(() => result.current.controller.setActiveBatchId(first.batchId));
  await waitFor(() => expect(result.current.controller.currentItem?.id).toBe(first.itemIds[0]));
  await waitFor(() => expect(result.current.loading).toBe(false));

  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const readItem = reviewService.getItem.bind(reviewService);
  vi.spyOn(reviewService, "getItem").mockImplementation(async (scope, id) => {
    const item = await readItem(scope, id);
    if (item.node.revision === 3) await pending;
    return item;
  });
  const repaired = { ...first.resources[0], id: crypto.randomUUID() };
  record = true;
  await act(async () => {
    await reviewService.commit({ target, expectedNodeRevision: 2, requestId: crypto.randomUUID(), actor: "agent", label: "External repair", request: {}, resources: [repaired],
      readScope: { itemIds: [first.itemIds[0]] }, build: state => {
        const built = buildWorkbenchImageRepairAction(state, first.itemIds[0], repaired.id,
          [{ id: crypto.randomUUID(), tool: "brush", color: "#800080", size: 2, points: [{ x: 10, y: 10, pressure: 1 }] }]);
        if (!built.ok) throw new Error(built.message);
        return built.actions;
      } });
  });
  await waitFor(() => expect(result.current.overview?.node.revision).toBe(3));
  expect(result.current.controller.currentItem).toMatchObject({ id: first.itemIds[0], version: 1 });
  expect(result.current.loading).toBe(true);
  await act(async () => {
    expect(await result.current.controller.commitDecision("kept", [first.itemIds[0]], { advance: false }))
      .toMatchObject({ ok: false, code: "CONFLICT" });
  });
  await act(async () => finish());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.controller.currentItem).toMatchObject({ id: first.itemIds[0], version: 2 });
  expect(frames.length).toBeGreaterThan(1);
  expect(frames.every(id => id === first.itemIds[0])).toBe(true);

  record = false;
  act(() => result.current.controller.focusItem(first.itemIds[1]));
  expect(result.current.controller.currentItem).toBeNull();
  await waitFor(() => expect(result.current.controller.currentItem?.id).toBe(first.itemIds[1]));
});
