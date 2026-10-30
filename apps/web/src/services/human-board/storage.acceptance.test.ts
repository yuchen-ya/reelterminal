/** @vitest-environment node */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { buildWorkbenchIngestActions } from "@reelterminal/core/actions/workbench-actions";
import type { FileResource } from "@reelterminal/core/review/types";
import { humanBoardStorage } from "./storage";
import { ReviewService } from "../review-workspace/service";
import { getReviewContext } from "../review-workspace/context";

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
});
afterEach(() => vi.unstubAllGlobals());

function image(name: string): FileResource {
  return { id: crypto.randomUUID(), storage: { kind: "managed", relativePath: `${name}.png` }, originalFileName: `${name}.png`, mime: "image/png", size: 1_000_000,
    createdAt: 1, source: "user", metadata: { type: "image", width: 1024, height: 1024, durationSec: 0, frameRate: 0, codec: "png" } };
}

test("board saves keep imported resources through scene removal and reject a stale save", async () => {
  const board = await humanBoardStorage.create("Private image study");
  const first = image("source");
  const replacement = image("replacement");
  await humanBoardStorage.retain(board.id, [first]);
  const saved = await humanBoardStorage.save({ ...board, imageFiles: { "image-file": first.id } });
  await humanBoardStorage.retain(board.id, [replacement]);
  const removed = await humanBoardStorage.save({ ...saved, imageFiles: {} });
  expect([...removed.resourceIds].sort()).toEqual([first.id, replacement.id].sort());
  expect((await humanBoardStorage.resources(board.id)).map(resource => resource.id).sort()).toEqual([first.id, replacement.id].sort());
  await expect(humanBoardStorage.save({ ...saved, name: "Stale overwrite" })).rejects.toThrow(/其他窗口修改/);
  const reopened = (await humanBoardStorage.list())[0];
  expect(reopened).toEqual(removed);
  expect(reopened).not.toHaveProperty("files");
  expect(JSON.stringify(reopened)).not.toContain("data:image");
  expect(JSON.stringify(reopened).length).toBeLessThan(2_000);
});

test("private board is absent from review discovery and its deletion preserves a published resource", async () => {
  const service = new ReviewService();
  const context = await getReviewContext();
  const board = await humanBoardStorage.create("Private unreleased study");
  const resource = image("shared-snapshot");
  const privateResource = image("unpublished");
  await humanBoardStorage.retain(board.id, [resource, privateResource]);
  expect((await service.listNodes(context.target)).nodes).toEqual([]);
  expect((await service.directory.get(context.target)).revision).toBe(0);
  const node = await service.createNode({ target: context.target, name: "Explicit snapshot", expectedWorkspaceRevision: 0, requestId: crypto.randomUUID() });
  const target = { ...context.target, nodeId: node.id };
  await expect(service.freezeExport({ target, expectedNodeRevision: 0, exportId: crypto.randomUUID(), mode: "version", scope: "selected", reference: {
    resourceId: privateResource.id, role: "attempt-private-read",
  } })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await service.commit({ target, expectedNodeRevision: 0, requestId: crypto.randomUUID(), actor: "human", label: "Publish one image", request: {}, build: state => {
    const result = buildWorkbenchIngestActions(state, { batchId: crypto.randomUUID(), name: "One frozen container", items: [{ id: crypto.randomUUID(), title: "Frozen image", type: "image", content: {
      type: "image", mediaId: resource.id, naturalWidth: 1024, naturalHeight: 1024, annotations: [], strokes: [],
    } }] });
    if (!result.ok) throw new Error(result.message);
    return result.actions;
  } });
  await humanBoardStorage.remove(board.id);
  expect(await humanBoardStorage.list()).toEqual([]);
  expect((await service.getResources([resource.id]))[0]).toEqual(resource);
  await expect(service.getResources([privateResource.id])).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect((await service.getNode(target)).state.items[0].content).toMatchObject({ type: "image", mediaId: resource.id });
  await expect(service.getNode({ ...target, nodeId: board.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
});
