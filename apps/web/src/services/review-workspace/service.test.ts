/** @vitest-environment node */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange, IDBIndex, IDBObjectStore } from "fake-indexeddb";
import { buildWorkbenchDecideAction, buildWorkbenchHandoffPublishAction, buildWorkbenchIngestActions, buildWorkbenchTextRevisionActions, type WorkbenchBuilderResult } from "@reelterminal/core/actions/workbench-actions";
import type { Action } from "@reelterminal/core/types/actions";
import type { WorkspaceTarget } from "@reelterminal/core/review/types";
import type { ReviewStep } from "@reelterminal/core/review/types";
import { getReviewContext } from "./context";
import { ReviewService } from "./service";
import { reduceReviewActions } from "@reelterminal/core/review/reducer";

beforeEach(() => { vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", IDBKeyRange); });
afterEach(() => vi.unstubAllGlobals());
const actions = (result: WorkbenchBuilderResult): readonly Action[] => {
  if (!result.ok) throw new Error(result.message);
  return result.actions;
};
async function setup() {
  const service = new ReviewService();
  const context = await getReviewContext();
  const node = await service.createNode({ target: context.target, name: "Independent node", expectedWorkspaceRevision: 0, requestId: crypto.randomUUID() });
  const target: Extract<WorkspaceTarget, { kind: "review" }> = { ...context.target, nodeId: node.id };
  const batchId = crypto.randomUUID();
  const itemId = crypto.randomUUID();
  return { service, target, batchId, itemId };
}
function ingest(batchId: string, itemId: string, text = "original") {
  return { batchId, name: "Input", items: [{ id: itemId, title: "Text", type: "text" as const,
    content: { type: "text" as const, entryId: itemId, title: "Text", speakerOrContext: "", versions: [{ version: 1, text, createdAt: 1, origin: "ingest" as const }] } }] };
}

describe("independent review transactions", () => {
  it("submits guarded versions in the same task without creating a branch and replays the request", async () => {
    const { service, target, batchId, itemId } = await setup();
    await service.commit({ target, expectedNodeRevision: 0, requestId: crypto.randomUUID(), actor: "agent", label: "Input", request: {},
      build: state => actions(buildWorkbenchIngestActions(state, ingest(batchId, itemId))) });
    const current = (await service.getItem(target, itemId)).item;
    if (current.content.type !== "text") throw new Error("Expected text fixture");
    const input = { target, expectedNodeRevision: 1, requestId: crypto.randomUUID(), request: { text: "# Revised" },
      results: [{ itemId, expectedItemVersion: 1, content: { ...current.content, versions: [{ ...current.content.versions[0], text: "# Revised" }] } }] };
    expect(await service.submitResults(input)).toMatchObject({ nodeId: target.nodeId, revision: 2 });
    expect(await service.submitResults(input)).toMatchObject({ replayed: true });
    expect((await service.listNodes(target)).nodes).toHaveLength(1);
    expect((await service.getItem(target, itemId)).item).toMatchObject({ id: itemId, version: 2, status: "pending" });
    expect((await service.overview(target)).batches[0].incomingRevision).toBe(2);
    expect((await service.getItem(target, itemId)).item.incomingRevision).toBe(2);
    await expect(service.submitResults({ ...input, requestId: crypto.randomUUID(), expectedNodeRevision: 2 })).rejects.toMatchObject({ code: "CONFLICT" });
    await service.history({ target, expectedNodeRevision: 2, requestId: crypto.randomUUID(), actor: "agent", direction: "undo" });
    expect((await service.getItem(target, itemId)).item.version).toBe(1);
    expect((await service.overview(target)).batches[0].incomingRevision).toBe(2);
    await service.commit({ target, expectedNodeRevision: 3, requestId: crypto.randomUUID(), actor: "human", label: "Edit", request: {},
      build: state => actions(buildWorkbenchTextRevisionActions(state, itemId, "Manual edit")) });
    expect((await service.overview(target)).batches[0].incomingRevision).toBe(2);
  });

  it("persists feedback modification time for unloaded summaries and updates it on undo", async () => {
    const { service, target, batchId, itemId } = await setup();
    await service.commit({ target, expectedNodeRevision: 0, requestId: crypto.randomUUID(), actor: "human", label: "Input", request: {},
      build: state => actions(buildWorkbenchIngestActions(state, ingest(batchId, itemId))) });
    const before = (await service.listItems(target)).items[0].updatedAt!;
    const clock = vi.spyOn(Date, "now").mockReturnValue(before + 1000);
    try {
      const feedback = { id: crypto.randomUUID(), itemId, itemVersion: 1, text: "Note", state: "confirmed", referencedTagIds: [], createdAt: Date.now(), updatedAt: Date.now() };
      await service.commit({ target, expectedNodeRevision: 1, requestId: crypto.randomUUID(), actor: "human", label: "Note", request: {},
        readScope: { itemIds: [itemId] }, build: () => [{ type: "workbench/feedback.save", id: crypto.randomUUID(), timestamp: Date.now(), params: { feedback } }] });
      expect((await service.listItems(target)).items[0].updatedAt).toBe(before + 1000);
      clock.mockReturnValue(before + 2000);
      await service.history({ target, expectedNodeRevision: 2, requestId: crypto.randomUUID(), actor: "human", direction: "undo" });
      expect((await service.listItems(target)).items[0].updatedAt).toBe(before + 2000);
    } finally { clock.mockRestore(); }
  });
  it("resolves only titles owned by the requested node, including missing references", async () => {
    const { service, target, batchId, itemId } = await setup();
    const payload = ingest(batchId, itemId);
    await service.commit({ target, expectedNodeRevision: 0, requestId: crypto.randomUUID(), actor: "agent",
      label: "Ingest", request: payload, build: state => actions(buildWorkbenchIngestActions(state, payload)) });
    expect(await service.getItemTitles(target, [itemId, itemId, crypto.randomUUID()])).toEqual({ [itemId]: "Text" });
    const other = await service.createNode({ target, name: "Other", expectedWorkspaceRevision: 1, requestId: crypto.randomUUID() });
    expect(await service.getItemTitles({ ...target, nodeId: other.id }, [itemId])).toEqual({});
  });
  it("retains parent modes in stored items and list summaries", async () => {
    const { service, target, batchId, itemId } = await setup();
    const original = ingest(batchId, itemId);
    const payload = { ...original, items: original.items.map(item => ({
      ...item, groupMode: "board" as const,
      lineage: { upstreamGroupId: "group", upstreamGroupTitle: "候选", upstreamSourceNode: "生成",
        groupMode: "category" as const, basedOnLabel: "初版", connectorEdgeLabel: "候选", failStreak: 0, steps: [] },
    })) };
    await service.commit({ target, expectedNodeRevision: 0, requestId: crypto.randomUUID(),
      actor: "agent", label: "Ingest", request: payload,
      build: state => actions(buildWorkbenchIngestActions(state, payload)) });
    expect((await service.getNode(target)).state.items[0]).toMatchObject({
      groupMode: "board", lineage: { groupMode: "category" },
    });
    expect((await service.listItems(target, { batchId })).items[0]).toMatchObject({
      groupMode: "board", lineage: { groupMode: "category" },
    });
  });

  it("reads and appends without loading history payloads, while archives retain undo history", async () => {
    const { service, target, batchId, itemId } = await setup();
    const original = IDBIndex.prototype.getAll;
    const spy = vi.spyOn(IDBIndex.prototype, "getAll").mockImplementation(function (this: IDBIndex, ...args) {
      if (this.objectStore.name === "reviewJournal") throw new Error("Ordinary node operations must not load journal payloads");
      return original.apply(this, args);
    });
    try {
      const payload = ingest(batchId, itemId);
      await service.commit({ target, expectedNodeRevision: 0, requestId: crypto.randomUUID(), actor: "human", label: "Ingest", request: payload,
        build: state => actions(buildWorkbenchIngestActions(state, payload)) });
      await service.commit({ target, expectedNodeRevision: 1, requestId: crypto.randomUUID(), actor: "human", label: "Revision", request: { text: "second" },
        build: state => actions(buildWorkbenchTextRevisionActions(state, itemId, "second")) });
      expect((await service.getNode(target)).node.history).toEqual({ undoActor: "human", redoActor: undefined });
    } finally { spy.mockRestore(); }
    expect((await service.archiveNode(target, 2)).journal).toHaveLength(2);
  });

  it("restores a complete node under fresh identities, preserves user bytes, and makes old tasks historical", async () => {
    const { service, target, batchId, itemId } = await setup();
    const tableId = crypto.randomUUID(), rowId = crypto.randomUUID(), columnId = crypto.randomUUID();
    const text = `Original literal ${itemId} 👀\r\n`;
    const payload = { ...ingest(batchId, itemId, text), items: [...ingest(batchId, itemId, text).items, { id: tableId, title: "Table", type: "data" as const,
      content: { type: "data" as const, datasetId: crypto.randomUUID(), columns: [{ columnId, title: "Value" }], rows: [{ rowId, cells: { [columnId]: itemId } }], proposals: [] } }] };
    let revision = 0;
    const commit = (build: (state: Parameters<typeof buildWorkbenchIngestActions>[0]) => readonly Action[]) => service.commit({ target, expectedNodeRevision: revision++, requestId: crypto.randomUUID(), actor: "human", label: "Prepare package fixture", request: {}, build });
    await commit(state => actions(buildWorkbenchIngestActions(state, payload)));
    await commit(state => actions(buildWorkbenchTextRevisionActions(state, itemId, `Revised ${text}`)));
    const feedbackId = crypto.randomUUID();
    await commit(() => [{ type: "workbench/feedback.save", id: crypto.randomUUID(), timestamp: 3, params: { feedback: {
      id: feedbackId, itemId, itemVersion: 2, text: "Keep this note", referencedTagIds: [], target: { kind: "whole-item" }, intent: "rework", state: "confirmed", createdAt: 3, updatedAt: 3,
    } } } as Action]);
    await commit(state => actions(buildWorkbenchDecideAction(state, batchId, [{ itemId, decision: "rework" }], "human")));
    await commit(state => actions(buildWorkbenchHandoffPublishAction(state, batchId, { itemIds: [itemId] })));
    const archive = await service.archiveNode(target, revision);
    const request = { target, expectedWorkspaceRevision: 1, requestId: crypto.randomUUID(), actor: "human" as const, archive, resources: [] };
    const restored = await service.restoreNode(request);
    expect(restored.node.id).not.toBe(target.nodeId);
    const restoredTarget = { ...target, nodeId: restored.node.id };
    const readback = await service.getNode(restoredTarget);
    await expect(service.history({ target: restoredTarget, expectedNodeRevision: 1, requestId: crypto.randomUUID(), actor: "human", direction: "undo" })).rejects.toMatchObject({ code: "CONFLICT" });
    const restoredText = readback.state.items.find(item => item.type === "text")!;
    const restoredTable = readback.state.items.find(item => item.type === "data")!;
    expect(restoredText.id).not.toBe(itemId);
    expect(restoredText.content).toMatchObject({ versions: [{ text }, { text: `Revised ${text}` }] });
    if (restoredTable.content.type !== "data") throw new Error("Restored table missing");
    expect(restoredTable.content.columns[0].columnId).not.toBe(columnId);
    expect(restoredTable.content.rows[0].cells[restoredTable.content.columns[0].columnId]).toBe(itemId);
    expect(readback.state.feedback[0].itemId).toBe(restoredText.id);
    expect(readback.state.handoffs[0].items[0].feedbackIds).toContain(readback.state.feedback[0].id);
    expect(readback.state.handoffs[0].historicalOnly).toBe(true);
    const exact = await service.getVersion(restoredTarget, restoredText.id, 2);
    expect(exact.revision!.id).toBe(restoredText.revisions[0].id);
    await expect(service.commit({ target: restoredTarget, expectedNodeRevision: 1, requestId: crypto.randomUUID(), actor: "agent", label: "Old task", request: {}, build: () => [
      { type: "workbench/handoff.ack", id: crypto.randomUUID(), timestamp: 5, params: { handoffId: readback.state.handoffs[0].handoffId, ackedAt: 5 } } as Action,
    ] })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    const restoredArchive = await service.archiveNode(restoredTarget, 1);
    expect(restoredArchive.journalArchives[0].sourceNodeId).toBe(target.nodeId);
    expect(restoredArchive.journalArchives[0].records).toHaveLength(revision);
    expect((await service.restoreNode(request)).replayed).toBe(true);
    await expect(service.restoreNode({ ...request, archive: { ...archive, node: { ...archive.node, name: "Different package" } } })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await service.getNode(target)).node.revision).toBe(revision);
    expect((await service.listNodes(target)).nodes).toHaveLength(2);
  });
  it("freezes original and human-adopted exact versions independently of current selection", async () => {
    const { service, target, batchId, itemId } = await setup();
    await service.commit({ target, expectedNodeRevision: 0, requestId: crypto.randomUUID(), actor: "human", label: "Input", request: {},
      build: state => actions(buildWorkbenchIngestActions(state, ingest(batchId, itemId, "Original 👀\r\n"))) });
    await service.commit({ target, expectedNodeRevision: 1, requestId: crypto.randomUUID(), actor: "human", label: "Revise", request: {},
      build: state => actions(buildWorkbenchTextRevisionActions(state, itemId, "Adopted")) });
    await service.commit({ target, expectedNodeRevision: 2, requestId: crypto.randomUUID(), actor: "human", label: "Adopt", request: {},
      build: state => actions(buildWorkbenchDecideAction(state, batchId, [{ itemId, decision: "kept" }], "human")) });
    const input = { target, expectedNodeRevision: 3, exportId: crypto.randomUUID(), scope: "node" as const };
    const original = await service.freezeExport({ ...input, mode: "original" });
    const adopted = await service.freezeExport({ ...input, exportId: crypto.randomUUID(), mode: "adopted" });
    expect(original.entries).toMatchObject([{ itemVersion: 1, text: "Original 👀\r\n", serialization: "utf8-text" }]);
    expect(adopted.entries).toMatchObject([{ itemVersion: 2, text: "Adopted" }]);
    const exact = await service.freezeExport({ ...input, exportId: crypto.randomUUID(), mode: "version", scope: "selected",
      reference: { nodeId: target.nodeId!, itemId, version: 1, role: "source" } });
    expect(exact).toMatchObject({ mode: "version", entries: [{ itemVersion: 1, text: "Original 👀\r\n" }] });
    await expect(service.freezeExport({ ...input, mode: "version", scope: "selected", reference: { resourceId: crypto.randomUUID(), role: "source" } })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await service.history({ target, expectedNodeRevision: 3, requestId: crypto.randomUUID(), direction: "undo", actor: "human" });
    expect(adopted.entries[0].text).toBe("Adopted");
    await expect(service.freezeExport({ ...input, mode: "original" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(service.freezeExport({ ...input, expectedNodeRevision: 4, mode: "original", scope: "selected", itemIds: [crypto.randomUUID()] })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("exports the current saved version even before adoption and keeps frozen output stable", async () => {
    const { service, target, batchId, itemId } = await setup();
    await service.commit({ target, expectedNodeRevision: 0, requestId: crypto.randomUUID(), actor: "human", label: "Input", request: {},
      build: state => actions(buildWorkbenchIngestActions(state, ingest(batchId, itemId, "Original"))) });
    const input = { target, exportId: crypto.randomUUID(), mode: "current" as const, scope: "selected" as const, itemIds: [itemId] };
    const pending = await service.freezeExport({ ...input, expectedNodeRevision: 1 });
    expect(pending.entries).toMatchObject([{ itemVersion: 1, text: "Original" }]);
    await service.commit({ target, expectedNodeRevision: 1, requestId: crypto.randomUUID(), actor: "human", label: "Revise", request: {},
      build: state => actions(buildWorkbenchTextRevisionActions(state, itemId, "Saved edit")) });
    const current = await service.freezeExport({ ...input, exportId: crypto.randomUUID(), expectedNodeRevision: 2 });
    expect(current.entries).toMatchObject([{ itemVersion: 2, text: "Saved edit" }]);
    expect(pending.entries[0].text).toBe("Original");
    await expect(service.freezeExport({ ...input, expectedNodeRevision: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("serializes two clients by node CAS, persists one receipt and replays the same intent", async () => {
    const { service, target, batchId, itemId } = await setup();
    const secondClient = new ReviewService();
    const payload = ingest(batchId, itemId);
    const requestId = crypto.randomUUID();
    const input = { target, expectedNodeRevision: 0, requestId, actor: "agent" as const, label: "Ingest", request: payload,
      build: (state: Parameters<typeof buildWorkbenchIngestActions>[0]) => actions(buildWorkbenchIngestActions(state, payload)) };
    const competingInput = { ...input, requestId: crypto.randomUUID(), request: { otherClient: true } };
    const results = await Promise.allSettled([service.commit(input), secondClient.commit(competingInput)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((await secondClient.getNode(target)).state.items).toHaveLength(1);
    const winningInput = results[0].status === "fulfilled" ? input : competingInput;
    expect(await secondClient.commit(winningInput)).toMatchObject({ revision: 1, replayed: true });
    await expect(secondClient.commit({ ...winningInput, request: { changed: true } })).rejects.toMatchObject({ code: "CONFLICT" });
    const snapshot = await secondClient.getNode(target);
    expect(snapshot.node.revision).toBe(1);
    expect(snapshot.state.items[0].content).toMatchObject({ versions: [{ text: "original" }] });
  });

  it("aborts content, journal and notification together when a later core action fails", async () => {
    const { service, target, batchId, itemId } = await setup();
    const listener = vi.fn();
    service.subscribe(listener);
    await expect(service.commit({ target, expectedNodeRevision: 0, requestId: crypto.randomUUID(), actor: "human", label: "Invalid atomic input", request: {},
      build: state => [...actions(buildWorkbenchIngestActions(state, ingest(batchId, itemId))), {
        type: "workbench/feedback.save", id: crypto.randomUUID(), timestamp: 1, params: { feedback: { id: "bad", itemId: "missing" } },
      } as Action],
    })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    expect(listener).not.toHaveBeenCalled();
    const snapshot = await service.getNode(target);
    expect(snapshot.node.revision).toBe(0);
    expect(snapshot.state.items).toHaveLength(0);
  });

  it("retains every intermediate immutable version inside one commit", async () => {
    const { service, target, batchId, itemId } = await setup();
    const payload = ingest(batchId, itemId);
    await service.commit({ target, expectedNodeRevision: 0, requestId: crypto.randomUUID(), actor: "human", label: "Ingest", request: payload,
      build: state => actions(buildWorkbenchIngestActions(state, payload)) });
    await service.commit({ target, expectedNodeRevision: 1, requestId: crypto.randomUUID(), actor: "human", label: "Two revisions", request: { texts: ["second", "third"] },
      build: state => {
        const first = actions(buildWorkbenchTextRevisionActions(state, itemId, "second"));
        const afterFirst = reduceReviewActions(state, first).state;
        return [...first, ...actions(buildWorkbenchTextRevisionActions(afterFirst, itemId, "third"))];
      } });
    const snapshot = await new ReviewService().getNode(target);
    expect(snapshot.node.revision).toBe(2);
    expect(snapshot.state.items[0]).toMatchObject({ version: 3, versionCeiling: 3, revisions: [
      { kind: "text", parentVersion: 1, producedVersion: 2 }, { kind: "text", parentVersion: 2, producedVersion: 3 },
    ] });
    expect(snapshot.state.items[0].content).toMatchObject({ versions: [{ text: "original" }, { text: "second" }, { text: "third" }] });
    expect((await service.getVersion(target, itemId, 2)).content).toMatchObject({ versions: [{ text: "original" }, { text: "second" }] });
    expect((await service.getVersion(target, itemId, 3)).content).toMatchObject({ versions: [{ text: "original" }, { text: "second" }, { text: "third" }] });
    const originalGetAll = IDBIndex.prototype.getAll;
    const originalGet = IDBObjectStore.prototype.get;
    const historyKeys: IDBValidKey[] = [];
    const getAllSpy = vi.spyOn(IDBIndex.prototype, "getAll").mockImplementation(function (this: IDBIndex, ...args) {
      if (this.objectStore.name === "reviewJournal") throw new Error("Undo and redo must not load history payloads");
      return originalGetAll.apply(this, args);
    });
    const getSpy = vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === "reviewJournal") historyKeys.push(args[0] as IDBValidKey);
      return originalGet.apply(this, args);
    });
    try {
      await service.history({ target, expectedNodeRevision: 2, requestId: crypto.randomUUID(), direction: "undo", actor: "human" });
      expect((await service.getNode(target)).state.items[0].version).toBe(1);
      await service.history({ target, expectedNodeRevision: 3, requestId: crypto.randomUUID(), direction: "redo", actor: "human" });
      expect((await service.getNode(target)).state.items[0].version).toBe(3);
      expect(historyKeys).toEqual([[target.nodeId, 2], [target.nodeId, 3]]);

      await service.commit({ target, expectedNodeRevision: 4, requestId: crypto.randomUUID(), actor: "agent", label: "External branch", request: {},
        build: () => [{ type: "workbench/feedback.save", id: crypto.randomUUID(), timestamp: 4, params: { feedback: {
          id: crypto.randomUUID(), itemId, itemVersion: 3, text: "Agent note", referencedTagIds: [], target: { kind: "whole-item" },
          state: "confirmed", createdAt: 4, updatedAt: 4,
        } } } as Action] });
      await expect(service.history({ target, expectedNodeRevision: 5, requestId: crypto.randomUUID(), direction: "redo", actor: "human" })).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(service.history({ target, expectedNodeRevision: 5, requestId: crypto.randomUUID(), direction: "undo", actor: "human" })).rejects.toMatchObject({ code: "CONFLICT" });
      expect(historyKeys).toEqual([[target.nodeId, 2], [target.nodeId, 3], [target.nodeId, 5]]);
      expect((await service.getNode(target)).node.revision).toBe(5);
    } finally {
      getSpy.mockRestore();
      getAllSpy.mockRestore();
    }
    await expect(service.getNode({ ...target, instanceId: crypto.randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("keeps image geometry in presentation and feedback outside the immutable content version", async () => {
    const { service, target } = await setup();
    const batchId = crypto.randomUUID();
    const imageId = crypto.randomUUID();
    const mediaId = crypto.randomUUID();
    const feedbackId = crypto.randomUUID();
    const resource = { id: mediaId, storage: { kind: "unavailable" as const, reason: "Fixture only" }, originalFileName: "fixture.png", mime: "image/png", size: 1,
      sha256: "a".repeat(64), createdAt: 1, source: "user" as const, metadata: { type: "image" as const, width: 100, height: 100, durationSec: 0, frameRate: 0, codec: "png" } };
    const payload = { batchId, name: "Geometry", items: [{ id: imageId, title: "Image", type: "image" as const,
      content: { type: "image" as const, mediaId, annotations: [], strokes: [] } }] };
    await service.commit({ target, expectedNodeRevision: 0, requestId: crypto.randomUUID(), actor: "human", label: "Ingest image", request: payload,
      resources: [resource], build: state => actions(buildWorkbenchIngestActions(state, payload)) });
    await service.commit({ target, expectedNodeRevision: 1, requestId: crypto.randomUUID(), actor: "human", label: "Annotate", request: {},
      build: () => [{ type: "workbench/annotations.set", id: crypto.randomUUID(), timestamp: 2, params: { itemId: imageId, itemVersion: 1,
        annotations: [{ id: "box-1", tool: "box", x: 0.1, y: 0.2, w: 0.3, h: 0.4, color: "#ffffff" }],
        strokes: [{ id: "stroke-1", tool: "brush", color: "#ffffff", size: 1, points: [{ x: 1, y: 1, pressure: 0.5 }] }],
      } } as Action] });
    await service.commit({ target, expectedNodeRevision: 2, requestId: crypto.randomUUID(), actor: "human", label: "Feedback", request: {},
      build: () => [{ type: "workbench/feedback.save", id: crypto.randomUUID(), timestamp: 3, params: { feedback: {
        id: feedbackId, itemId: imageId, itemVersion: 1, text: "Keep geometry", referencedTagIds: [], target: { kind: "whole-item" },
        state: "confirmed", createdAt: 3, updatedAt: 3,
      } } } as Action] });
    const snapshot = await service.getNode(target);
    expect(snapshot.state.items[0]).toMatchObject({ version: 1, content: {
      annotations: [{ id: "box-1", x: 0.1, y: 0.2 }], strokes: [{ id: "stroke-1", points: [{ x: 1, y: 1, pressure: 0.5 }] }],
    } });
    expect(snapshot.state.feedback).toMatchObject([{ id: feedbackId, itemVersion: 1, text: "Keep geometry" }]);
    expect(await service.getVersion(target, imageId, 1)).toMatchObject({ content: { type: "image", mediaId, annotations: [], strokes: [] } });
  });

  it("rejects a restore that replaces a stored body under the same item and version", async () => {
    const { service, target, batchId, itemId } = await setup();
    const payload = ingest(batchId, itemId, "Original immutable text");
    await service.commit({ target, expectedNodeRevision: 0, requestId: crypto.randomUUID(), actor: "human", label: "Ingest", request: payload,
      build: state => actions(buildWorkbenchIngestActions(state, payload)) });
    const original = (await service.getNode(target)).state.items.find(item => item.id === itemId)!;
    const listener = vi.fn();
    service.subscribe(listener);

    await expect(service.commit({ target, expectedNodeRevision: 1, requestId: crypto.randomUUID(), actor: "human", label: "Tamper immutable body", request: {},
      build: state => {
        const item = state.items.find(candidate => candidate.id === itemId)!;
        if (item.content.type !== "text") throw new Error("Expected text fixture");
        const altered = { ...item, content: { ...item.content, versions: item.content.versions.map(version => ({ ...version, text: "Tampered under version 1" })) } };
        return [{ type: "workbench/restore", id: crypto.randomUUID(), timestamp: 2, params: { items: [altered] } } as Action];
      } })).rejects.toMatchObject({ code: "CONFLICT" });

    const snapshot = await service.getNode(target);
    expect(snapshot.node.revision).toBe(1);
    expect(snapshot.state.items.find(item => item.id === itemId)).toEqual(original);
    expect(listener).not.toHaveBeenCalled();
  });

  it("rejects a same-version restore that drops a persisted revision reference", async () => {
    const { service, target, batchId, itemId } = await setup();
    const payload = ingest(batchId, itemId);
    await service.commit({ target, expectedNodeRevision: 0, requestId: crypto.randomUUID(), actor: "human", label: "Ingest", request: payload,
      build: state => actions(buildWorkbenchIngestActions(state, payload)) });
    await service.commit({ target, expectedNodeRevision: 1, requestId: crypto.randomUUID(), actor: "human", label: "Revise", request: {},
      build: state => actions(buildWorkbenchTextRevisionActions(state, itemId, "revised")) });
    const before = await service.getNode(target);
    const item = before.state.items.find(candidate => candidate.id === itemId)!;

    await expect(service.commit({ target, expectedNodeRevision: 2, requestId: crypto.randomUUID(), actor: "human", label: "Drop revision", request: {},
      build: () => [{ type: "workbench/restore", id: crypto.randomUUID(), timestamp: 3, params: { items: [{ ...item, revisions: [] }] } } as Action],
    })).rejects.toMatchObject({ code: "CONFLICT" });

    const after = await service.getNode(target);
    expect(after.node.revision).toBe(2);
    expect(after.state.items.find(candidate => candidate.id === itemId)?.revisions).toEqual(item.revisions);
  });

  it("rejects a same-version restore that substitutes an unpersisted revision ID", async () => {
    const { service, target, batchId, itemId } = await setup();
    const payload = ingest(batchId, itemId);
    await service.commit({ target, expectedNodeRevision: 0, requestId: crypto.randomUUID(), actor: "human", label: "Ingest", request: payload,
      build: state => actions(buildWorkbenchIngestActions(state, payload)) });
    await service.commit({ target, expectedNodeRevision: 1, requestId: crypto.randomUUID(), actor: "human", label: "Revise", request: {},
      build: state => actions(buildWorkbenchTextRevisionActions(state, itemId, "revised")) });
    const before = await service.getNode(target);
    const item = before.state.items.find(candidate => candidate.id === itemId)!;
    const revisions = item.revisions.map(revision => ({ ...revision, id: crypto.randomUUID() }));

    await expect(service.commit({ target, expectedNodeRevision: 2, requestId: crypto.randomUUID(), actor: "human", label: "Substitute revision", request: {},
      build: () => [{ type: "workbench/restore", id: crypto.randomUUID(), timestamp: 3, params: { items: [{ ...item, revisions }] } } as Action],
    })).rejects.toMatchObject({ code: "CONFLICT" });

    const after = await service.getNode(target);
    expect(after.node.revision).toBe(2);
    expect(after.state.items.find(candidate => candidate.id === itemId)?.revisions).toEqual(item.revisions);
  });

  it("persists undo/redo, rejects old requests after undo, and allocates a new branch version", async () => {
    const { service, target, batchId, itemId } = await setup();
    const payload = ingest(batchId, itemId);
    await service.commit({ target, expectedNodeRevision: 0, requestId: crypto.randomUUID(), actor: "human", label: "Ingest", request: payload,
      build: state => actions(buildWorkbenchIngestActions(state, payload)) });
    await service.commit({ target, expectedNodeRevision: 1, requestId: crypto.randomUUID(), actor: "human", label: "Revision", request: { text: "second" },
      build: state => actions(buildWorkbenchTextRevisionActions(state, itemId, "second")) });
    await new ReviewService().history({ target, expectedNodeRevision: 2, requestId: crypto.randomUUID(), actor: "human", direction: "undo" });
    expect((await service.getNode(target)).state.items[0]).toMatchObject({ version: 1, versionCeiling: 2 });
    await expect(service.commit({ target, expectedNodeRevision: 1, requestId: crypto.randomUUID(), actor: "agent", label: "Stale", request: {}, build: () => [] })).rejects.toMatchObject({ code: "CONFLICT" });
    await new ReviewService().history({ target, expectedNodeRevision: 3, requestId: crypto.randomUUID(), actor: "human", direction: "redo" });
    expect((await service.getNode(target)).state.items[0].version).toBe(2);
    await service.history({ target, expectedNodeRevision: 4, requestId: crypto.randomUUID(), actor: "human", direction: "undo" });
    await service.commit({ target, expectedNodeRevision: 5, requestId: crypto.randomUUID(), actor: "human", label: "Branch", request: { text: "branch" },
      build: state => actions(buildWorkbenchTextRevisionActions(state, itemId, "branch")) });
    const reopened = await new ReviewService().getNode(target);
    expect(reopened.node.revision).toBe(6);
    expect(reopened.state.items[0]).toMatchObject({ version: 3, versionCeiling: 3 });
    expect(reopened.state.items[0].content).toMatchObject({ versions: [{ text: "original" }, { version: 3, text: "branch" }] });
    await expect(service.history({ target, expectedNodeRevision: 6, requestId: crypto.randomUUID(), actor: "human", direction: "redo" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("persists processing lifecycle without fabricating outputs or adding content undo entries", async () => {
    const { service, target, batchId, itemId } = await setup();
    const payload = ingest(batchId, itemId);
    await service.commit({ target, expectedNodeRevision: 0, requestId: crypto.randomUUID(), actor: "human", label: "Ingest", request: payload,
      build: state => actions(buildWorkbenchIngestActions(state, payload)) });
    const running: ReviewStep = { id: crypto.randomUUID(), nodeId: target.nodeId!, runId: crypto.randomUUID(), label: "Try local tool", actor: "tool", state: "running", startedAt: 1,
      inputs: [{ nodeId: target.nodeId!, itemId, version: 1, role: "source" }], outputs: [], method: { kind: "algorithm", name: "local-tool", verification: "declared" }, parameters: {} };
    await service.commit({ target, expectedNodeRevision: 1, requestId: crypto.randomUUID(), actor: "agent", label: "Start", request: { running }, build: () => [], steps: [running] });
    const failed: ReviewStep = { ...running, state: "failed", finishedAt: 2, error: "Tool rejected the input" };
    await service.commit({ target, expectedNodeRevision: 2, requestId: crypto.randomUUID(), actor: "agent", label: "Fail", request: { failed }, build: () => [], steps: [failed] });
    const snapshot = await new ReviewService().getNode(target);
    expect(snapshot.steps).toHaveLength(1);
    expect(snapshot.steps[0]).toMatchObject({ state: "failed", outputs: [] });
    expect(snapshot.node.history).toMatchObject({ undoActor: "human" });
    expect(snapshot.node.history?.undoActor).toBe("human");
    await expect(service.commit({ target, expectedNodeRevision: 3, requestId: crypto.randomUUID(), actor: "agent", label: "Overwrite", request: {}, build: () => [], steps: [running] })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await service.history({ target, expectedNodeRevision: 3, requestId: crypto.randomUUID(), actor: "human", direction: "undo" });
    expect((await service.getNode(target)).state.items).toHaveLength(0);
    expect((await service.getNode(target)).steps[0].state).toBe("failed");
  });

  it("rejects unregistered resource references without persisting an item or notifying", async () => {
    const { service, target, batchId, itemId } = await setup();
    const listener = vi.fn();
    service.subscribe(listener);
    const payload = { batchId, name: "Missing bytes", items: [{ id: itemId, title: "Image", type: "image" as const,
      content: { type: "image" as const, mediaId: crypto.randomUUID(), annotations: [], strokes: [] } }] };
    await expect(service.commit({ target, expectedNodeRevision: 0, requestId: crypto.randomUUID(), actor: "human", label: "Invalid resource", request: payload,
      build: state => actions(buildWorkbenchIngestActions(state, payload)) })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await service.getNode(target)).state.items).toHaveLength(0);
    expect(listener).not.toHaveBeenCalled();
  });
});
