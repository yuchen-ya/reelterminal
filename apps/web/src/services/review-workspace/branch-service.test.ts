/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { buildWorkbenchDecideAction, buildWorkbenchIngestActions, buildWorkbenchTextRevisionActions, type WorkbenchBuilderResult } from "@reelterminal/core/actions/workbench-actions";
import type { Action } from "@reelterminal/core/types/actions";
import { ReviewService } from "./service";
import { getReviewContext } from "./context";
import { handleReviewCommand } from "../agent/review-bridge";
import { reviewService } from "./service";
import type { FileResource } from "@reelterminal/core/review/types";
import { readReviewComparable } from "./comparison";
import { openMaterialDatabase } from "../material-library/storage";

vi.mock("./attach", () => ({ attachReviewMedia: vi.fn() }));

beforeEach(() => { vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("IDBKeyRange", IDBKeyRange); });
afterEach(() => vi.unstubAllGlobals());
function actions(result: WorkbenchBuilderResult): readonly Action[] { if (!result.ok) throw new Error(result.message); return result.actions; }
async function setup() {
  const service = new ReviewService();
  const context = await getReviewContext();
  const node = await service.createNode({ target: context.target, name: "Source", expectedWorkspaceRevision: 0, requestId: crypto.randomUUID() });
  const target = { ...context.target, nodeId: node.id };
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  const batchId = crypto.randomUUID();
  await service.commit({ target, expectedNodeRevision: 0, requestId: crypto.randomUUID(), actor: "human", label: "Input", request: {},
    build: state => actions(buildWorkbenchIngestActions(state, { batchId, name: "Input", items: ids.map((id, index) => ({ id, title: index ? "Other" : "Target", type: "text",
      content: { type: "text", entryId: crypto.randomUUID(), title: "Text", speakerOrContext: "", versions: [{ version: 1, text: "original", createdAt: 1, origin: "ingest" }] } })) })) });
  const create = { target, expectedNodeRevision: 1, expectedWorkspaceRevision: 1, requestId: crypto.randomUUID(), taskId: crypto.randomUUID(), name: "Task" };
  const branch = await service.createBranch(create);
  const result = (await service.getNode(branch.target)).state.items.find(item => item.title === "Target")!;
  const revise = async (text: string, expectedNodeRevision: number) => service.commit({ target: branch.target, expectedNodeRevision, requestId: crypto.randomUUID(), actor: "agent", label: "Branch result", request: { text },
    readScope: { itemIds: [result.id] }, build: state => actions(buildWorkbenchTextRevisionActions(state, result.id, text)) });
  return { service, context, target, ids, batchId, create, branch, result, revise };
}

describe("durable task branches", () => {
  it("creates once, preserves source history, and rejects task identity reuse and nested forks", async () => {
    const { service, target, create, branch } = await setup();
    expect((await service.getNode(target)).node).toMatchObject({ revision: 1, history: { undoActor: "human" } });
    expect(await service.createBranch(create)).toMatchObject({ replayed: true, node: { id: branch.node.id } });
    expect(await service.createBranch({ ...create, requestId: crypto.randomUUID() })).toMatchObject({ replayed: true, node: { id: branch.node.id } });
    expect((await service.listNodes(target)).nodes).toHaveLength(2);
    await expect(service.createBranch({ ...create, target: branch.target, expectedNodeRevision: 1, expectedWorkspaceRevision: 2, requestId: crypto.randomUUID(), taskId: crypto.randomUUID() })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await expect(service.createBranch({ ...create, name: "Different intent" })).rejects.toMatchObject({ code: "CONFLICT" });
    const alias = { ...create, requestId: crypto.randomUUID() };
    await service.createBranch(alias);
    await expect(service.createBranch({ ...alias, taskId: crypto.randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("adopts selected results beside unrelated human review, undoes, and only replays an old request", async () => {
    const { service, target, ids, batchId, branch, result, revise } = await setup();
    await service.commit({ target, expectedNodeRevision: 1, requestId: crypto.randomUUID(), actor: "human", label: "Review another item", request: {},
      readScope: { itemIds: [ids[1]] }, build: state => actions(buildWorkbenchDecideAction(state, batchId, [{ itemId: ids[1], decision: "kept" }], "human")) });
    await revise("result 2", 1);
    expect((await service.getNode(target)).node.history?.undoActor).toBe("human");
    const comparison = await service.compareBranch(branch.target);
    expect(comparison.items.find(item => item.resultItemId === result.id)!.state).toBe("changed");
    const adopt = { target: branch.target, expectedNodeRevision: 2, requestId: crypto.randomUUID(), selections: [{ resultItemId: result.id, resultVersion: 2 }] };
    await service.adoptBranch(adopt);
    let source = await service.getNode(target);
    expect(source.state.items.find(item => item.id === ids[0])).toMatchObject({ version: 2, status: "kept" });
    expect(source.state.items.find(item => item.id === ids[1])!.status).toBe("kept");
    await service.history({ target, expectedNodeRevision: source.node.revision, requestId: crypto.randomUUID(), actor: "human", direction: "undo" });
    expect(await new ReviewService().adoptBranch(adopt)).toMatchObject({ replayed: true });
    source = await service.getNode(target);
    expect(source.state.items.find(item => item.id === ids[0])!.version).toBe(1);
    expect(source.state.items.find(item => item.id === ids[1])!.status).toBe("kept");
    await revise("result 3", 2);
    await expect(service.adoptBranch({ ...adopt, expectedNodeRevision: 3, selections: [{ resultItemId: result.id, resultVersion: 3 }] })).rejects.toMatchObject({ code: "CONFLICT" });
    await service.adoptBranch({ ...adopt, requestId: crypto.randomUUID(), expectedNodeRevision: 3, selections: [{ resultItemId: result.id, resultVersion: 3 }] });
    source = await service.getNode(target);
    expect(source.state.items.find(item => item.id === ids[0])!.version).toBe(3);
    expect((await service.getVersion(target, ids[0], 2)).content).toMatchObject({ versions: expect.arrayContaining([expect.objectContaining({ text: "result 2" })]) });
    await revise("result 4", 3);
    await service.adoptBranch({ ...adopt, requestId: crypto.randomUUID(), expectedNodeRevision: 4, selections: [{ resultItemId: result.id, resultVersion: 4 }] });
    expect((await service.getItem(target, ids[0])).item.version).toBe(4);
  });

  it("rejects stale results, foreign item identities, source feedback changes and changed request intent atomically", async () => {
    const { service, target, ids, branch, result, revise } = await setup();
    await revise("agent result", 1);
    const input = { target: branch.target, expectedNodeRevision: 2, requestId: crypto.randomUUID(), selections: [{ resultItemId: result.id, resultVersion: 2 }] };
    await expect(service.adoptBranch({ ...input, selections: [{ resultItemId: ids[0], resultVersion: 1 }] })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(service.adoptBranch({ ...input, expectedNodeRevision: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
    await service.commit({ target, expectedNodeRevision: 1, requestId: crypto.randomUUID(), actor: "human", label: "Feedback", request: {}, build: () => [{
      type: "workbench/feedback.save", id: crypto.randomUUID(), timestamp: 2, params: { feedback: { id: crypto.randomUUID(), itemId: ids[0], itemVersion: 1,
        text: "New source review", referencedTagIds: [], state: "confirmed", createdAt: 2, updatedAt: 2 } },
    }] });
    expect((await service.compareBranch(branch.target)).items.find(item => item.resultItemId === result.id)!.state).toBe("conflict");
    await expect(service.adoptBranch(input)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await service.getItem(target, ids[0])).item.version).toBe(1);
  });

  it.each([0, 2])("readopts an undone new item above retained versions after %i human edits", async humanEdits => {
    const { service, target, branch } = await setup();
    const resultId = crypto.randomUUID();
    await service.commit({ target: branch.target, expectedNodeRevision: 1, requestId: crypto.randomUUID(), actor: "agent", label: "New result", request: {},
      build: state => actions(buildWorkbenchIngestActions(state, { batchId: crypto.randomUUID(), name: "New output", items: [{ id: resultId, title: "Added result", type: "text",
        content: { type: "text", entryId: crypto.randomUUID(), title: "Added result", speakerOrContext: "", versions: [{ version: 1, text: "candidate 1", origin: "ingest", createdAt: 1 }] } }] })) });
    await service.adoptBranch({ target: branch.target, expectedNodeRevision: 2, requestId: crypto.randomUUID(), selections: [{ resultItemId: resultId, resultVersion: 1 }] });
    const sourceItem = (await service.getNode(target)).state.items.find(item => item.title === "Added result")!;
    expect(sourceItem.version).toBe(1);
    for (let index = 0; index < humanEdits; index++) {
      const source = await service.getNode(target);
      await service.commit({ target, expectedNodeRevision: source.node.revision, requestId: crypto.randomUUID(), actor: "human", label: "Human edit", request: { index },
        build: state => actions(buildWorkbenchTextRevisionActions(state, sourceItem.id, `human ${index + 1}`)) });
    }
    for (let index = 0; index <= humanEdits; index++) {
      const source = await service.getNode(target);
      await service.history({ target, expectedNodeRevision: source.node.revision, requestId: crypto.randomUUID(), actor: "human", direction: "undo" });
    }
    expect((await service.getNode(target)).state.items.some(item => item.id === sourceItem.id)).toBe(false);
    await service.commit({ target: branch.target, expectedNodeRevision: 2, requestId: crypto.randomUUID(), actor: "agent", label: "Continue result", request: {},
      build: state => actions(buildWorkbenchTextRevisionActions(state, resultId, "candidate 2")) });
    await service.adoptBranch({ target: branch.target, expectedNodeRevision: 3, requestId: crypto.randomUUID(), selections: [{ resultItemId: resultId, resultVersion: 2 }] });
    const readopted = await service.getItem(target, sourceItem.id);
    expect(readopted.item.version).toBe(humanEdits + 2);
    expect(readopted.item.content).toMatchObject({ versions: [{ version: humanEdits + 2, text: "candidate 2" }] });
    expect((await service.getVersion(target, sourceItem.id, 1)).content).toMatchObject({ versions: [{ version: 1, text: "candidate 1" }] });
    if (humanEdits) expect((await service.getVersion(target, sourceItem.id, humanEdits + 1)).content).toMatchObject({
      versions: expect.arrayContaining([expect.objectContaining({ version: humanEdits + 1, text: `human ${humanEdits}` })]),
    });
    await service.history({ target, expectedNodeRevision: readopted.node.revision, requestId: crypto.randomUUID(), actor: "human", direction: "undo" });
    const undone = await service.getNode(target);
    expect(undone.state.items.some(item => item.id === sourceItem.id)).toBe(false);
    await service.history({ target, expectedNodeRevision: undone.node.revision, requestId: crypto.randomUUID(), actor: "human", direction: "redo" });
    expect((await service.getItem(target, sourceItem.id)).item.version).toBe(humanEdits + 2);
  });

  it("restores a branch package as an independent historical node and purges its baseline", async () => {
    const { service, branch, context, create } = await setup();
    const archive = await service.archiveNode(branch.target, 1);
    expect(archive.node.branch).toBeDefined();
    expect(archive.journalArchives.some(history => history.records.some(record => (record as { kind?: string }).kind === "task-branch-baseline"))).toBe(true);
    const restored = await service.restoreNode({ target: context.target, expectedWorkspaceRevision: 2, requestId: crypto.randomUUID(), actor: "human", archive, resources: [] });
    const restoredTarget = { ...context.target, nodeId: restored.node.id };
    expect(restored.node.branch).toBeUndefined();
    await expect(service.compareBranch(restoredTarget)).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    await service.directory.commit({ target: context.target, expectedWorkspaceRevision: 3, requestId: crypto.randomUUID(), actor: "human", commands: [{ kind: "node.update", nodeId: branch.node.id, patch: { trashed: true } }] });
    await service.purge.clear({ target: branch.target, expectedWorkspaceRevision: 4, expectedNodeRevision: 1, requestId: crypto.randomUUID(), confirmDeleteHistory: true });
    await expect(service.getNode(branch.target)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await service.createBranch(create)).toMatchObject({ replayed: true, node: { id: branch.node.id } });
    const newRequest = { ...create, expectedWorkspaceRevision: 5, requestId: crypto.randomUUID() };
    await expect(service.createBranch(newRequest)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.getNode(branch.target)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await service.getNode(restoredTarget)).state.items).toHaveLength(2);
    const fresh = await service.createBranch({ ...newRequest, taskId: crypto.randomUUID() });
    expect(fresh.replayed).toBe(false);
    expect((await service.getNode(fresh.target)).state.items).toHaveLength(2);
  });

  it("submits inherited image/video/table replacements through the command bridge, retains resources and undoes adoption", async () => {
    const context = await getReviewContext();
    const node = await reviewService.createNode({ target: context.target, name: "Media source", expectedWorkspaceRevision: 0, requestId: crypto.randomUUID() });
    const target = { ...context.target, nodeId: node.id };
    const imageId = crypto.randomUUID(), videoId = crypto.randomUUID(), dataId = crypto.randomUUID();
    const sourceImage = crypto.randomUUID(), sourceVideo = crypto.randomUUID(), nextImage = crypto.randomUUID(), nextVideo = crypto.randomUUID();
    const columnId = crypto.randomUUID(), rowId = crypto.randomUUID();
    const resources = new Map<string, FileResource>([sourceImage, sourceVideo, nextImage, nextVideo].map(id => {
      const image = id === sourceImage || id === nextImage;
      return [id, { id, storage: { kind: "managed", relativePath: `resources/${id}/original.${image ? "png" : "mp4"}` }, size: 42, mime: image ? "image/png" : "video/mp4",
        originalFileName: image ? "actual.png" : "actual.mp4", source: "agent", createdAt: 1,
        metadata: { type: image ? "image" : "video", width: 64, height: 48, durationSec: image ? 0 : 2, frameRate: image ? 0 : 25, codec: image ? "png" : "h264" } }];
    }));
    const prepare = vi.fn(async ({ resourceId }: { resourceId: string }) => ({ ok: true, value: resources.get(resourceId)! }));
    vi.stubGlobal("window", { reelterminal: { reviewFiles: { prepare, resolve: vi.fn(async (id: string) => ({ ok: true, value: { resource: resources.get(id), path: `C:/managed/${id}` } })) } } });
    await handleReviewCommand("review.ingest", { target, expectedNodeRevision: 0, requestId: crypto.randomUUID(), batchId: crypto.randomUUID(), name: "Sources",
      files: [{ resourceId: sourceImage, sourcePath: "C:/allowed/source.png", mime: "image/png" }, { resourceId: sourceVideo, sourcePath: "C:/allowed/source.mp4", mime: "video/mp4" }],
      items: [{ id: imageId, title: "Image", type: "image", content: { type: "image", mediaId: sourceImage } },
        { id: videoId, title: "Video", type: "video", content: { type: "video", mediaId: sourceVideo } },
        { id: dataId, title: "Data", type: "data", content: { type: "data", datasetId: crypto.randomUUID(), columns: [{ columnId, title: "Value" }], rows: [{ rowId, cells: { [columnId]: "old" } }], proposals: [] } }] });
    const branch = await handleReviewCommand("review.branches.create", { target, expectedNodeRevision: 1, expectedWorkspaceRevision: 1, taskId: crypto.randomUUID(), requestId: crypto.randomUUID(), name: "Media task" }) as Awaited<ReturnType<ReviewService["createBranch"]>>;
    const items = (await reviewService.getNode(branch.target)).state.items;
    const image = items.find(item => item.type === "image")!, video = items.find(item => item.type === "video")!, data = items.find(item => item.type === "data")!;
    if (data.content.type !== "data") throw new Error("Expected table");
    const stepId = crypto.randomUUID();
    await handleReviewCommand("review.steps.start", { target: branch.target, expectedNodeRevision: 1, requestId: crypto.randomUUID(), stepId,
      runId: crypto.randomUUID(), label: "Local replacements", inputs: [{ nodeId: branch.node.id, itemId: image.id, version: 1, role: "source" }], method: { kind: "algorithm", name: "Fixture tool" } });
    const submit = { target: branch.target, expectedNodeRevision: 2, requestId: crypto.randomUUID(), stepId,
      files: [{ resourceId: nextImage, sourcePath: "C:/allowed/result.png", mime: "image/png" }, { resourceId: nextVideo, sourcePath: "C:/allowed/result.mp4", mime: "video/mp4" }],
      results: [{ itemId: image.id, expectedItemVersion: 1, content: { type: "image", mediaId: nextImage } },
        { itemId: video.id, expectedItemVersion: 1, content: { type: "video", mediaId: nextVideo } },
        { itemId: data.id, expectedItemVersion: 1, content: { ...data.content, rows: [{ rowId: data.content.rows[0].rowId, cells: { [data.content.columns[0].columnId]: "new" } }] } }] };
    expect(await handleReviewCommand("review.branches.submit", submit)).toMatchObject({ revision: 3, replayed: false });
    const preparations = prepare.mock.calls.length;
    expect(await handleReviewCommand("review.branches.submit", submit)).toMatchObject({ replayed: true });
    expect(prepare.mock.calls).toHaveLength(preparations);
    expect((await reviewService.getStep(branch.target, stepId))).toMatchObject({ state: "completed", outputs: expect.arrayContaining([expect.objectContaining({ itemId: image.id, version: 2 })]) });
    const adopt = { target: branch.target, expectedNodeRevision: 3, requestId: crypto.randomUUID(), selections: [image, video, data].map(item => ({ resultItemId: item.id, resultVersion: 2 })) };
    await reviewService.adoptBranch(adopt);
    expect((await reviewService.getItem(target, imageId)).item.content).toMatchObject({ mediaId: nextImage });
    expect((await reviewService.getItem(target, videoId)).item.content).toMatchObject({ mediaId: nextVideo });
    expect((await reviewService.getItem(target, dataId)).item.content).toMatchObject({ rows: [{ rowId, cells: { [columnId]: "new" } }] });
    expect(await readReviewComparable(target, { nodeId: node.id, itemId: imageId, version: 2, role: "display" })).toMatchObject({ kind: "image", url: `app://reelterminal/review-media/${nextImage}` });
    expect(await readReviewComparable(target, { nodeId: node.id, itemId: videoId, version: 2, role: "display" })).toMatchObject({ kind: "video", url: `app://reelterminal/review-media/${nextVideo}` });
    await reviewService.history({ target, expectedNodeRevision: 2, requestId: crypto.randomUUID(), actor: "human", direction: "undo" });
    expect(await reviewService.adoptBranch(adopt)).toMatchObject({ replayed: true });
    expect((await reviewService.getItem(target, imageId)).item.content).toMatchObject({ mediaId: sourceImage });
    expect((await reviewService.getItem(target, videoId)).item.content).toMatchObject({ mediaId: sourceVideo });
    const database = await openMaterialDatabase();
    const refs = await new Promise<Array<{ nodeId: string; resourceId: string }>>((resolve, reject) => {
      const transaction = database.transaction("resourceRefs", "readonly");
      const request = transaction.objectStore("resourceRefs").index("resource").getAll(nextImage);
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
    expect(new Set(refs.map(ref => ref.nodeId))).toEqual(new Set([node.id, branch.node.id]));
    expect((await reviewService.archiveNode(target, 3)).resources.map(resource => resource.id)).toEqual(expect.arrayContaining([sourceImage, sourceVideo, nextImage, nextVideo]));
    await expect(handleReviewCommand("review.branches.submit", { ...submit, target, expectedNodeRevision: 3, requestId: crypto.randomUUID() })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    expect(prepare.mock.calls).toHaveLength(preparations);
  });
});
