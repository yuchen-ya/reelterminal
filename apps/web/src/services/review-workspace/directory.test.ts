/** @vitest-environment node */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBIndex, IDBKeyRange } from "fake-indexeddb";
import { getReviewContext } from "./context";
import { ReviewService } from "./service";
import { buildWorkbenchIngestActions } from "@reelterminal/core/actions/workbench-actions";

beforeEach(() => { vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", IDBKeyRange); });
afterEach(() => vi.unstubAllGlobals());

describe("review directory history", () => {
  it("atomically rejects broken membership and retains node content while undoing display metadata", async () => {
    const { target } = await getReviewContext();
    const service = new ReviewService();
    const node = await service.createNode({ target, name: "Original", expectedWorkspaceRevision: 0, requestId: crypto.randomUUID() });
    const nodeTarget = { ...target, nodeId: node.id };
    const groupResult = await service.directory.commit({ target, expectedWorkspaceRevision: 1, requestId: crypto.randomUUID(), actor: "human", commands: [{ kind: "group.create", name: "Inputs" }] });
    const group = groupResult.groups[0];
    await service.directory.commit({ target, expectedWorkspaceRevision: 2, requestId: crypto.randomUUID(), actor: "human", commands: [{ kind: "node.update", nodeId: node.id, patch: { name: "Renamed", groupId: group.id, pinned: true } }] });
    const itemId = crypto.randomUUID();
    await service.commit({ target: nodeTarget, expectedNodeRevision: 0, requestId: crypto.randomUUID(), actor: "agent", label: "Input", request: {}, build: state => {
      const result = buildWorkbenchIngestActions(state, { batchId: crypto.randomUUID(), name: "Input", items: [{ id: itemId, title: "Text", type: "text", content: { type: "text", entryId: itemId, title: "Text", speakerOrContext: "", versions: [{ version: 1, text: "Retain this body", createdAt: 1, origin: "ingest" }] } }] });
      if (!result.ok) throw new Error(result.message);
      return result.actions;
    } });
    const listener = vi.fn();
    service.subscribe(listener);
    await expect(service.directory.commit({ target, expectedWorkspaceRevision: 3, requestId: crypto.randomUUID(), actor: "human", commands: [{ kind: "node.update", nodeId: node.id, patch: { name: "Must roll back" } }, { kind: "group.remove", groupId: group.id }] })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(listener).not.toHaveBeenCalled();
    expect((await service.directory.get(target)).revision).toBe(3);
    await new ReviewService().directory.history({ target, expectedWorkspaceRevision: 3, requestId: crypto.randomUUID(), actor: "human", direction: "undo" });
    const restored = await service.getNode(nodeTarget);
    expect(restored.node).toMatchObject({ name: "Original", revision: 1, pinned: false });
    expect(restored.node.groupId).toBeUndefined();
    expect(restored.state.items[0].content).toMatchObject({ versions: [{ text: "Retain this body" }] });
    await service.directory.history({ target, expectedWorkspaceRevision: 4, requestId: crypto.randomUUID(), actor: "human", direction: "redo" });
    expect((await service.getNode(nodeTarget)).node).toMatchObject({ name: "Renamed", groupId: group.id, revision: 1 });
  });

  it("persists directory receipts, monotonic undo/redo and external actor boundaries", async () => {
    const { target } = await getReviewContext();
    const service = new ReviewService();
    const create = { target, expectedWorkspaceRevision: 0, requestId: crypto.randomUUID(), actor: "human" as const, commands: [{ kind: "node.create" as const, name: "Node" }] };
    const result = await service.directory.commit(create);
    expect(await new ReviewService().directory.commit(create)).toMatchObject({ revision: 1, replayed: true, nodes: result.nodes });
    await service.directory.history({ target, expectedWorkspaceRevision: 1, requestId: crypto.randomUUID(), actor: "human", direction: "undo" });
    expect((await service.listNodes(target)).nodes).toHaveLength(0);
    await service.directory.history({ target, expectedWorkspaceRevision: 2, requestId: crypto.randomUUID(), actor: "human", direction: "redo" });
    expect((await service.listNodes(target)).nodes[0].id).toBe(result.nodes[0].id);
    await expect(service.directory.commit({ ...create, requestId: crypto.randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
    await service.directory.commit({ target, expectedWorkspaceRevision: 3, requestId: crypto.randomUUID(), actor: "agent", commands: [{ kind: "node.update", nodeId: result.nodes[0].id, patch: { trashed: true } }] });
    await expect(service.directory.history({ target, expectedWorkspaceRevision: 4, requestId: crypto.randomUUID(), actor: "human", direction: "undo" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await service.listNodes(target)).nodes[0].trashedAt).toBeGreaterThan(0);
  });

  it("appends ordinary directory changes without loading the retained undo journal", async () => {
    const { target } = await getReviewContext();
    const service = new ReviewService();
    const original = IDBIndex.prototype.getAll;
    const spy = vi.spyOn(IDBIndex.prototype, "getAll").mockImplementation(function (this: IDBIndex, ...args) {
      if (this.objectStore.name === "reviewJournal") throw new Error("Ordinary directory commits must not load history payloads");
      return original.apply(this, args);
    });
    let nodeId = "";
    try {
      const created = await service.createNode({ target, name: "Node", expectedWorkspaceRevision: 0, requestId: crypto.randomUUID() });
      nodeId = created.id;
      await service.directory.commit({ target, expectedWorkspaceRevision: 1, requestId: crypto.randomUUID(), actor: "human",
        commands: [{ kind: "node.update", nodeId, patch: { name: "Renamed" } }] });
    } finally { spy.mockRestore(); }

    expect((await service.directory.get(target)).canUndo).toBe(true);
    await service.directory.history({ target, expectedWorkspaceRevision: 2, requestId: crypto.randomUUID(), actor: "human", direction: "undo" });
    expect((await service.listNodes(target)).nodes[0].name).toBe("Node");
    expect((await service.directory.get(target)).canRedo).toBe(true);
    await service.directory.history({ target, expectedWorkspaceRevision: 3, requestId: crypto.randomUUID(), actor: "human", direction: "redo" });
    expect((await service.listNodes(target)).nodes[0].name).toBe("Renamed");
  });
});
