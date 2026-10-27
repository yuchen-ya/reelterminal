import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IDBFactory, IDBIndex, IDBKeyRange } from "fake-indexeddb";
import { buildWorkbenchIngestActions } from "@reelterminal/core/actions/workbench-actions";
import { getReviewContext } from "../../services/review-workspace/context";
import { reviewService } from "../../services/review-workspace/service";
import { useReviewController } from "./useReviewController";
import { toItemView } from "./useWorkbenchController";
import type { WorkbenchItem } from "@reelterminal/core/types/workbench";

// Independent review nodes do not use the legacy project store or initialize its video engines.
vi.mock("../../stores/project-store", () => ({ useProjectStore: vi.fn() }));

const originalIndexedDB = globalThis.indexedDB;
beforeEach(() => { globalThis.indexedDB = new IDBFactory(); vi.stubGlobal("IDBKeyRange", IDBKeyRange); });
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
