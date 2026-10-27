/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBIndex, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";
import { buildWorkbenchDecideAction, buildWorkbenchHandoffPublishAction, buildWorkbenchIngestActions, type WorkbenchBuilderResult } from "@reelterminal/core/actions/workbench-actions";
import type { Action } from "@reelterminal/core/types/actions";
import type { WorkbenchFeedback } from "@reelterminal/core/types/workbench";
import { handleReviewCommand } from "../agent/review-bridge";
import { getReviewContext } from "./context";
import { ReviewService, reviewService } from "./service";

// Attaching to a video project initializes the rendering engines; this suite exercises only review storage.
vi.mock("./attach", () => ({ attachReviewMedia: vi.fn() }));

beforeEach(() => { vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", IDBKeyRange); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function actions(result: WorkbenchBuilderResult): readonly Action[] {
  if (!result.ok) throw new Error(result.message);
  return result.actions;
}

function feedback(itemId: string, id: string = crypto.randomUUID(), itemVersion = 1): WorkbenchFeedback {
  return { id, itemId, itemVersion, text: "Keep this note", referencedTagIds: [], state: "confirmed",
    intent: "note", target: { kind: "whole-item" }, createdAt: 1, updatedAt: 1 };
}

function agentFeedback(record: WorkbenchFeedback) {
  return { id: record.id, itemId: record.itemId, itemVersion: record.itemVersion, text: record.text,
    referencedTagIds: record.referencedTagIds, state: record.state, target: record.target };
}

async function setup() {
  const { target: workspaceTarget } = await getReviewContext();
  const node = await reviewService.createNode({ target: workspaceTarget, name: "Scoped reads", expectedWorkspaceRevision: 0, requestId: crypto.randomUUID() });
  const target = { ...workspaceTarget, nodeId: node.id };
  const batchId = crypto.randomUUID();
  const itemIds = [crypto.randomUUID(), crypto.randomUUID()];
  const items = itemIds.map(id => ({ id, title: id, type: "text" as const,
    content: { type: "text" as const, entryId: id, title: id, speakerOrContext: "",
      versions: [{ version: 1, text: "Original", createdAt: 1, origin: "ingest" as const }] } }));
  const otherFeedback = feedback(itemIds[1]);
  await reviewService.commit({ target, expectedNodeRevision: 0, requestId: crypto.randomUUID(), actor: "human", label: "Seed", request: {},
    build: state => [...actions(buildWorkbenchIngestActions(state, { batchId, name: "Two members", items })),
      { type: "workbench/feedback.save", id: crypto.randomUUID(), timestamp: 1, params: { feedback: otherFeedback } } as Action] });
  return { target, batchId, itemIds, otherFeedback };
}

/** Fail the regression at the storage boundary, before unrelated bodies can be cloned. */
function forbidNodeScans(includeSteps = false) {
  const getAll = IDBIndex.prototype.getAll;
  return vi.spyOn(IDBIndex.prototype, "getAll").mockImplementation(function (this: IDBIndex, ...args) {
    if ((this.name === "node" && ["reviewItems", "reviewVersions", "reviewFeedback", "reviewBatches", "reviewHandoffs"].includes(this.objectStore.name)) ||
        (!includeSteps && this.objectStore.name === "reviewSteps")) throw new Error(`Unexpected full-node read: ${this.objectStore.name}.${this.name}`);
    return getAll.apply(this, args);
  });
}

describe("explicit review read scopes", () => {
  it("runs real agent feedback/decisions with CAS and replay, preserving batch siblings, handoffs and undo/redo", async () => {
    const { target, batchId, itemIds, otherFeedback } = await setup();
    await reviewService.commit({ target, expectedNodeRevision: 1, requestId: crypto.randomUUID(), actor: "human", label: "Decide sibling", request: {},
      build: state => actions(buildWorkbenchDecideAction(state, batchId, [{ itemId: itemIds[1], decision: "rework" }], "human")) });
    await reviewService.commit({ target, expectedNodeRevision: 2, requestId: crypto.randomUUID(), actor: "human", label: "Publish sibling", request: {},
      build: state => actions(buildWorkbenchHandoffPublishAction(state, batchId, { itemIds: [itemIds[1]] })) });
    const before = await reviewService.getNode(target);
    const note = feedback(itemIds[0]);
    const input = { target, expectedNodeRevision: 3, requestId: crypto.randomUUID(), ops: [
      { op: "workbench.feedback.save", feedback: agentFeedback(note) },
      { op: "workbench.decide", batchId, decisions: [{ itemId: itemIds[0], decision: "kept", expectedItemVersion: 1 }] },
    ] };
    const scan = forbidNodeScans();
    try {
      const otherInput = { ...input, requestId: crypto.randomUUID() };
      const competing = await Promise.allSettled([handleReviewCommand("review.apply", input), handleReviewCommand("review.apply", otherInput)]);
      expect(competing.filter(result => result.status === "fulfilled"), JSON.stringify(competing)).toHaveLength(1);
      expect(competing.filter(result => result.status === "rejected")).toMatchObject([{ reason: { code: "CONFLICT" } }]);
      const winner = competing[0].status === "fulfilled" ? input : otherInput;
      expect(await handleReviewCommand("review.apply", winner)).toMatchObject({ revision: 4, replayed: true });
      await expect(handleReviewCommand("review.apply", { ...winner, ops: [{ op: "workbench.feedback.save", feedback: { ...agentFeedback(note), text: "Changed intent" } }] }))
        .rejects.toMatchObject({ code: "CONFLICT" });
    } finally { scan.mockRestore(); }
    const after = await new ReviewService().getNode(target);
    expect(after.state.batches).toEqual(before.state.batches);
    expect(after.state.items.find(item => item.id === itemIds[1])).toEqual(before.state.items.find(item => item.id === itemIds[1]));
    expect(after.state.handoffs).toEqual(before.state.handoffs);
    expect(after.state.feedback).toEqual(expect.arrayContaining([expect.objectContaining(otherFeedback), expect.objectContaining({ id: note.id })]));
    expect(after.state.items.find(item => item.id === itemIds[0])?.status).toBe("kept");
    await reviewService.history({ target, expectedNodeRevision: 4, requestId: crypto.randomUUID(), actor: "agent", direction: "undo" });
    expect((await reviewService.getNode(target)).state).toEqual(before.state);
    await reviewService.history({ target, expectedNodeRevision: 5, requestId: crypto.randomUUID(), actor: "agent", direction: "redo" });
    expect((await reviewService.getNode(target)).state).toEqual(after.state);
    expect((await reviewService.archiveNode(target, 6)).journal).toHaveLength(6);
  });

  it("rejects same-node feedback ID theft and unsupported global actions without persisting partial work", async () => {
    const { target, itemIds, otherFeedback } = await setup();
    const before = await reviewService.getNode(target);
    const listener = vi.fn();
    const unsubscribe = reviewService.subscribe(listener);
    try {
      await expect(handleReviewCommand("review.apply", { target, expectedNodeRevision: 1, requestId: crypto.randomUUID(), ops: [
        { op: "workbench.feedback.save", feedback: agentFeedback(feedback(itemIds[0], otherFeedback.id)) },
      ] })).rejects.toMatchObject({ code: "INVALID_PARAMS", message: "Review feedback identity belongs to another item or version" });
      const item = before.state.items.find(item => item.id === itemIds[0])!;
      await expect(reviewService.commit({ target, expectedNodeRevision: 1, requestId: crypto.randomUUID(), actor: "human", label: "Bad scope", request: {},
        readScope: { itemIds: [itemIds[0]] }, build: state => actions(buildWorkbenchIngestActions(state, {
          batchId: crypto.randomUUID(), name: "Unscoped batch", items: [{ id: crypto.randomUUID(), title: "New item", type: item.type, content: item.content }],
        })) })).rejects.toMatchObject({ code: "INVALID_PARAMS", message: "Review actions exceed the declared item read scope" });
      expect(listener).not.toHaveBeenCalled();
      expect(await reviewService.getNode(target)).toEqual(before);
      expect((await reviewService.archiveNode(target, 1)).journal).toHaveLength(1);
    } finally { unsubscribe(); }
  });

  it("keeps retained version ceilings and full history compatible with scoped content builders", async () => {
    const { target, itemIds } = await setup();
    const apply = (revision: number, expectedItemVersion: number, texts: string[]) => handleReviewCommand("review.apply", {
      target, expectedNodeRevision: revision, requestId: crypto.randomUUID(), ops: texts.map((text, index) => ({
        op: "workbench.content.update", itemId: itemIds[0], expectedItemVersion: expectedItemVersion + index, kind: "text", text,
      })),
    });
    await apply(1, 1, ["Second", "Third"]);
    await reviewService.history({ target, expectedNodeRevision: 2, requestId: crypto.randomUUID(), actor: "agent", direction: "undo" });
    expect((await reviewService.getItem(target, itemIds[0])).item).toMatchObject({ version: 1, versionCeiling: 3 });
    await apply(3, 1, ["New revision"]);
    expect((await new ReviewService().getItem(target, itemIds[0])).item).toMatchObject({ version: 4, versionCeiling: 4 });
    expect((await reviewService.getVersion(target, itemIds[0], 3)).content).toMatchObject({ versions: expect.arrayContaining([{ version: 3, text: "Third", createdAt: expect.any(Number), origin: "human-revision", parentVersion: 2 }]) });
    await expect(reviewService.history({ target, expectedNodeRevision: 4, requestId: crypto.randomUUID(), actor: "agent", direction: "redo" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("starts/fails/completes real processing with exact input reads and the complete lifecycle graph", async () => {
    const { target, itemIds } = await setup();
    const start = (revision: number, stepId: string, version: number, supersedesStepId?: string) => handleReviewCommand("review.steps.start", {
      target, expectedNodeRevision: revision, requestId: crypto.randomUUID(), stepId, runId: crypto.randomUUID(), label: "Real tool",
      inputs: [{ nodeId: target.nodeId, itemId: itemIds[0], version, role: "source" }],
      method: { kind: "algorithm", name: "tool" }, ...(supersedesStepId ? { supersedesStepId } : {}),
    });
    const first = crypto.randomUUID(), second = crypto.randomUUID();
    const get = IDBObjectStore.prototype.get;
    const itemReads: unknown[] = [];
    const primary = vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (this: IDBObjectStore, key) {
      if (this.name === "reviewItems") itemReads.push(key);
      return get.call(this, key);
    });
    const scan = forbidNodeScans(true);
    try {
      await start(1, first, 1);
      await handleReviewCommand("review.steps.fail", { target, expectedNodeRevision: 2, requestId: crypto.randomUUID(), stepId: first, error: "Tool failed" });
      await start(3, second, 1, first);
      expect(itemReads).toHaveLength(0);
      await handleReviewCommand("review.steps.complete", { target, expectedNodeRevision: 4, requestId: crypto.randomUUID(), stepId: second,
        ops: [{ op: "workbench.content.update", itemId: itemIds[0], expectedItemVersion: 1, kind: "text", text: "Produced by tool" }],
        outputs: [{ nodeId: target.nodeId, itemId: itemIds[0], version: 2, role: "result" }] });
      await expect(handleReviewCommand("review.steps.fail", { target, expectedNodeRevision: 5, requestId: crypto.randomUUID(), stepId: second, error: "Overwrite terminal" }))
        .rejects.toMatchObject({ code: "CONFLICT" });
      await expect(start(5, crypto.randomUUID(), 99)).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally { primary.mockRestore(); scan.mockRestore(); }
    const after = await reviewService.getNode(target);
    expect(after.node.revision).toBe(5);
    expect(after.steps).toEqual(expect.arrayContaining([expect.objectContaining({ id: first, state: "failed" }),
      expect.objectContaining({ id: second, state: "completed", supersedesStepId: first })]));
    expect(after.state.items.find(item => item.id === itemIds[0])).toMatchObject({ version: 2 });
    await reviewService.history({ target, expectedNodeRevision: 5, requestId: crypto.randomUUID(), actor: "agent", direction: "undo" });
    expect((await reviewService.getNode(target)).steps).toEqual(after.steps);
  });
});
