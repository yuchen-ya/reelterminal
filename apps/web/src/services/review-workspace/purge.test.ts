/** @vitest-environment node */
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { buildWorkbenchIngestActions } from "@reelterminal/core/actions/workbench-actions";
import type { FileResource } from "@reelterminal/core/review/types";
import { getReviewContext } from "./context";
import { ReviewService } from "./service";

beforeEach(() => { vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", IDBKeyRange); });
afterEach(() => vi.unstubAllGlobals());

it("requires explicit history deletion, preserves other-node holds, and never resurrects a purged node through directory undo", async () => {
  const service = new ReviewService();
  const context = await getReviewContext();
  const first = await service.createNode({ target: context.target, expectedWorkspaceRevision: 0, name: "First", requestId: crypto.randomUUID() });
  const second = await service.createNode({ target: context.target, expectedWorkspaceRevision: 1, name: "Second", requestId: crypto.randomUUID() });
  const resource: FileResource = { id: crypto.randomUUID(), storage: { kind: "managed", relativePath: "resources/test.txt" },
    mime: "text/plain", originalFileName: "shared.txt", size: 12, sha256: "a".repeat(64), createdAt: 1, source: "user" };
  for (const node of [first, second]) {
    const target = { ...context.target, nodeId: node.id };
    await service.commit({ target, expectedNodeRevision: 0, requestId: crypto.randomUUID(), actor: "human", label: "Input", request: {}, resources: node.id === first.id ? [resource] : [], build: state => {
      const result = buildWorkbenchIngestActions(state, { batchId: crypto.randomUUID(), name: "Input", items: [{ id: crypto.randomUUID(), originalResourceId: resource.id, title: "Original", type: "text", content: { type: "text", entryId: crypto.randomUUID(), title: "Original", speakerOrContext: "", versions: [{ version: 1, text: "Exact source", origin: "ingest", createdAt: 1 }] } }] });
      if (!result.ok) throw new Error(result.message);
      return result.actions;
    } });
  }
  const target = { ...context.target, nodeId: first.id };
  await expect(service.purge.preview(target)).rejects.toMatchObject({ code: "CONFLICT" });
  await service.directory.commit({ target: context.target, expectedWorkspaceRevision: 2, requestId: crypto.randomUUID(), actor: "human",
    commands: [first, second].map(node => ({ kind: "node.update" as const, nodeId: node.id, patch: { trashed: true } })) });
  const preview = await service.purge.preview(target);
  expect(preview).toMatchObject({ nodeRevision: 1, reclaimableBytes: 0, resources: [{ id: resource.id, shared: true }] });
  expect(preview.retainedReferences.version).toBeGreaterThan(0);
  expect(preview.retainedReferences.journal).toBeGreaterThan(0);
  const request = { target, expectedNodeRevision: 1, expectedWorkspaceRevision: 3, requestId: crypto.randomUUID(), confirmDeleteHistory: true as const };
  await expect(service.purge.clear({ ...request, confirmDeleteHistory: false } as never)).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  await expect(service.purge.clear({ ...request, expectedNodeRevision: 2 })).rejects.toMatchObject({ code: "CONFLICT" });
  const result = await service.purge.clear(request);
  expect(result).toMatchObject({ workspaceRevision: 4, keptResourceIds: [resource.id], releasedResourceIds: [], replayed: false });
  expect(await service.purge.clear(request)).toMatchObject({ replayed: true, workspaceRevision: 4 });
  await expect(service.getNode(target)).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await service.getResources([resource.id])).toHaveLength(1);
  expect((await service.directory.get(context.target)).canUndo).toBe(false);
  await expect(service.directory.history({ target: context.target, expectedWorkspaceRevision: 4, requestId: crypto.randomUUID(), actor: "human", direction: "undo" })).rejects.toMatchObject({ code: "CONFLICT" });
  const other = { ...context.target, nodeId: second.id };
  expect((await service.getNode(other)).state.items[0].content).toMatchObject({ versions: [{ text: "Exact source" }] });
  expect((await service.purge.preview(other)).reclaimableBytes).toBe(12);
  expect(await service.purge.clear({ ...request, target: other, expectedWorkspaceRevision: 4, requestId: crypto.randomUUID() })).toMatchObject({ keptResourceIds: [], releasedResourceIds: [resource.id] });
  await expect(service.getResources([resource.id])).rejects.toMatchObject({ code: "NOT_FOUND" });
  await service.directory.commit({ target: context.target, expectedWorkspaceRevision: 5, requestId: crypto.randomUUID(), actor: "human", commands: [{ kind: "group.create", name: "After permanent clear" }] });
  await service.directory.history({ target: context.target, expectedWorkspaceRevision: 6, requestId: crypto.randomUUID(), actor: "human", direction: "undo" });
  expect((await service.listNodes(context.target, { view: "all" })).nodes).toHaveLength(0);
});
