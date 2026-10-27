/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { buildWorkbenchIngestActions, buildWorkbenchTextRevisionActions } from "@reelterminal/core/actions/workbench-actions";
import { emptyWorkbenchState, type WorkbenchItem, type WorkbenchProjectState } from "@reelterminal/core/types/workbench";
import { reduceReviewActions } from "@reelterminal/core/review/reducer";
import type { ReviewNodeArchive } from "@reelterminal/core/review/archive";
import { compareReviewBranchItem, planReviewBranchAdoption, prepareReviewBranch } from "./branches";

function fixture() {
  const itemId = crypto.randomUUID();
  const secondId = crypto.randomUUID();
  const batchId = crypto.randomUUID();
  const built = buildWorkbenchIngestActions(emptyWorkbenchState(), { batchId, name: "Input", items: [itemId, secondId].map(id => ({
    id, title: id === itemId ? "First" : "Second", type: "text", content: { type: "text", entryId: crypto.randomUUID(), title: "Text",
      speakerOrContext: "", versions: [{ version: 1, text: "original", createdAt: 1, origin: "ingest" }] },
  })) });
  if (!built.ok) throw new Error(built.message);
  const state = reduceReviewActions(emptyWorkbenchState(), built.actions).state;
  const archive: ReviewNodeArchive = { schemaVersion: 1,
    node: { id: crypto.randomUUID(), workspaceId: crypto.randomUUID(), name: "Source", pinned: false, revision: 1, createdAt: 1, updatedAt: 1 },
    state, versions: state.items.map(item => ({ itemId: item.id, nodeId: "", version: 1, content: item.content })), steps: [], resources: [], journal: [], journalArchives: [] };
  const validArchive = { ...archive, versions: archive.versions.map(version => ({ ...version, nodeId: archive.node.id })) };
  const fork = prepareReviewBranch(validArchive, crypto.randomUUID());
  const resultId = fork.idMap.find(entry => entry.kind === "item" && entry.oldId === itemId)!.newId;
  return { itemId, secondId, archive: validArchive, fork, resultId };
}
function revise(state: WorkbenchProjectState, itemId: string, text: string) {
  const built = buildWorkbenchTextRevisionActions(state, itemId, text);
  if (!built.ok) throw new Error(built.message);
  return reduceReviewActions(state, built.actions).state;
}
function text(item: WorkbenchItem) { return item.content.type === "text" ? item.content.versions.at(-1)!.text : ""; }

describe("task branch plans", () => {
  it("clones under stable task identities with an immutable source baseline", () => {
    const { archive, fork, resultId } = fixture();
    const again = prepareReviewBranch(archive, fork.baseline.taskId);
    expect(again.nodeId).toBe(fork.nodeId);
    expect(again.state.items.map(item => item.id)).toEqual(fork.state.items.map(item => item.id));
    expect(fork.baseline.sourceNodeId).toBe(archive.node.id);
    expect(resultId).not.toBe(archive.state.items[0].id);
    expect(compareReviewBranchItem(fork.baseline, archive.state, fork.state.items[0]).state).toBe("unchanged");
  });

  it("allows unrelated source edits, preserves decisions and feedback, and undoes adoption", () => {
    const { archive, fork, resultId, itemId, secondId } = fixture();
    const source = revise(archive.state, secondId, "user continues reviewing another item");
    const branch = revise(fork.state, resultId, "agent result");
    const plan = planReviewBranchAdoption(fork.baseline, source, branch.items, [{ resultItemId: resultId, resultVersion: 2 }], crypto.randomUUID(), 10);
    const applied = reduceReviewActions(source, plan.actions);
    expect(text(applied.state.items.find(item => item.id === itemId)!)).toBe("agent result");
    expect(text(applied.state.items.find(item => item.id === secondId)!)).toBe("user continues reviewing another item");
    expect(applied.state.items.find(item => item.id === itemId)!.decisionLog.at(-1)).toMatchObject({ operator: "human", decision: "kept", baseVersion: 2 });
    expect(reduceReviewActions(applied.state, applied.inverse).state).toEqual(source);
    expect(text(archive.state.items[0])).toBe("original");
  });

  it("conflicts on source decisions, feedback and content even when the content version is unchanged", () => {
    const { archive, fork, resultId, itemId } = fixture();
    const result = revise(fork.state, resultId, "agent result").items[0];
    const decision = { ...archive.state, items: archive.state.items.map(item => item.id === itemId ? { ...item, status: "discarded" as const } : item) };
    expect(compareReviewBranchItem(fork.baseline, decision, result).state).toBe("conflict");
    const feedback = { ...archive.state, feedback: [{ id: crypto.randomUUID(), itemId, itemVersion: 1, text: "new human note", referencedTagIds: [], state: "confirmed" as const, createdAt: 1, updatedAt: 1 }] };
    expect(compareReviewBranchItem(fork.baseline, feedback, result).state).toBe("conflict");
    expect(compareReviewBranchItem(fork.baseline, revise(archive.state, itemId, "human result"), result).state).toBe("conflict");
  });

  it("continues the same branch across adoptions and requires a new explicit request after undo", () => {
    const { archive, fork, resultId } = fixture();
    const branch = revise(fork.state, resultId, "result 2");
    const first = planReviewBranchAdoption(fork.baseline, archive.state, branch.items, [{ resultItemId: resultId, resultVersion: 2 }], crypto.randomUUID(), 10);
    const applied = reduceReviewActions(archive.state, first.actions);
    const baseline = { ...fork.baseline, checkpoints: first.checkpoints };
    expect(compareReviewBranchItem(baseline, applied.state, branch.items[0]).state).toBe("adopted");
    expect(() => planReviewBranchAdoption(baseline, applied.state, branch.items, [{ resultItemId: resultId, resultVersion: 2 }], crypto.randomUUID(), 11)).toThrow(/no new content/);
    const continued = revise(branch, resultId, "result 3");
    const next = planReviewBranchAdoption(baseline, applied.state, continued.items, [{ resultItemId: resultId, resultVersion: 3 }], crypto.randomUUID(), 12);
    expect(text(reduceReviewActions(applied.state, next.actions).state.items[0])).toBe("result 3");
    const undone = reduceReviewActions(applied.state, applied.inverse).state;
    expect(compareReviewBranchItem(baseline, undone, branch.items[0]).state).toBe("changed");
  });

  it("accepts explicit new results without importing the branch's reviewer decisions", () => {
    const { archive, fork } = fixture();
    const result: WorkbenchItem = { ...fork.state.items[0], id: crypto.randomUUID(), status: "discarded", userTags: ["branch only"], decisionLog: [] };
    const plan = planReviewBranchAdoption(fork.baseline, archive.state, [result], [{ resultItemId: result.id, resultVersion: 1 }], crypto.randomUUID(), 10);
    const applied = reduceReviewActions(archive.state, plan.actions);
    const added = applied.state.items.at(-1)!;
    expect(added.id).not.toBe(result.id);
    expect(added.status).toBe("kept");
    expect(added.userTags).toEqual([]);
    expect(added.decisionLog).toHaveLength(1);
    expect(applied.state.batches.at(-1)!.itemIds).toEqual([added.id]);
    expect(reduceReviewActions(applied.state, applied.inverse).state).toEqual(archive.state);
  });

  it("shares media resources and adopts the effective repaired image and replacement video", () => {
    const { archive } = fixture();
    const imageId = crypto.randomUUID(), videoId = crypto.randomUUID(), originalImage = crypto.randomUUID(), repairedImage = crypto.randomUUID();
    const originalVideo = crypto.randomUUID(), replacementVideo = crypto.randomUUID();
    const batchId = crypto.randomUUID();
    const built = buildWorkbenchIngestActions(archive.state, { batchId, name: "Media", items: [
      { id: imageId, title: "Image", type: "image", originalResourceId: originalImage,
        content: { type: "image", mediaId: originalImage, annotations: [], strokes: [] } },
      { id: videoId, title: "Video", type: "video", content: { type: "video", mediaId: originalVideo, markers: [] } },
    ] });
    if (!built.ok) throw new Error(built.message);
    const state = reduceReviewActions(archive.state, built.actions).state;
    const mediaArchive: ReviewNodeArchive = { ...archive, state,
      versions: state.items.map(item => ({ nodeId: archive.node.id, itemId: item.id, version: item.version, content: item.content, originalResourceId: item.originalResourceId })),
      resources: [originalImage, originalVideo].map(id => ({ id, mime: id === originalImage ? "image/png" : "video/mp4", size: 1, originalFileName: id === originalImage ? "image.png" : "video.mp4", createdAt: 1, source: "user" })) };
    const fork = prepareReviewBranch(mediaArchive, crypto.randomUUID());
    const image = fork.state.items.find(item => item.type === "image")!;
    const video = fork.state.items.find(item => item.type === "video")!;
    expect(image.content).toMatchObject({ mediaId: originalImage });
    expect(fork.versions.find(version => version.itemId === image.id)!.originalResourceId).toBe(originalImage);
    const resultImage: WorkbenchItem = { ...image, version: 2, revisions: [{ id: crypto.randomUUID(), itemId: image.id, kind: "image-repair", mediaId: repairedImage, parentVersion: 1, producedVersion: 2, createdAt: 2 }] };
    const resultVideo: WorkbenchItem = { ...video, version: 2, content: { type: "video", mediaId: replacementVideo, markers: [] } };
    const plan = planReviewBranchAdoption(fork.baseline, state, [resultImage, resultVideo], [{ resultItemId: image.id, resultVersion: 2 }, { resultItemId: video.id, resultVersion: 2 }], crypto.randomUUID(), 10);
    const adopted = reduceReviewActions(state, plan.actions).state;
    expect(adopted.items.find(item => item.id === imageId)!.content).toMatchObject({ mediaId: repairedImage });
    expect(adopted.items.find(item => item.id === videoId)!.content).toMatchObject({ mediaId: replacementVideo });
    expect(adopted.items.find(item => item.id === imageId)!.originalResourceId).toBe(originalImage);
  });

  it("maps table identities and proposal provenance back to the source without dangling tags", () => {
    const { archive } = fixture();
    const rowId = crypto.randomUUID(), columnId = crypto.randomUUID(), tagId = crypto.randomUUID(), itemId = crypto.randomUUID();
    const built = buildWorkbenchIngestActions(archive.state, { batchId: crypto.randomUUID(), name: "Table", items: [{ id: itemId, title: "Data", type: "data",
      provenanceTags: [{ id: tagId, category: "model", shortName: "Tool", verification: "declared", detailSummary: "Original source attribution" }],
      content: { type: "data", datasetId: crypto.randomUUID(), columns: [{ columnId, title: "Value" }], rows: [{ rowId, cells: { [columnId]: "old" } }],
        proposals: [{ proposalId: crypto.randomUUID(), rowId, columnId, originalValue: "old", proposedValue: "new", reason: "fix", provenanceTagId: tagId, status: "proposed" }] } }] });
    if (!built.ok) throw new Error(built.message);
    const state = reduceReviewActions(archive.state, built.actions).state;
    const tableArchive: ReviewNodeArchive = { ...archive, state, versions: state.items.map(item => ({ nodeId: archive.node.id, itemId: item.id, version: item.version, content: item.content })) };
    const fork = prepareReviewBranch(tableArchive, crypto.randomUUID());
    const table = fork.state.items.find(item => item.type === "data")!;
    if (table.content.type !== "data") throw new Error("Expected table");
    const result: WorkbenchItem = { ...table, version: 2, content: { ...table.content, rows: table.content.rows.map(row => ({ ...row, cells: { [table.content.type === "data" ? table.content.columns[0].columnId : ""]: "new" } })) } };
    const plan = planReviewBranchAdoption(fork.baseline, state, [result], [{ resultItemId: table.id, resultVersion: 2 }], crypto.randomUUID(), 10);
    const adopted = reduceReviewActions(state, plan.actions).state.items.find(item => item.id === itemId)!;
    expect(adopted.content).toMatchObject({ rows: [{ rowId, cells: { [columnId]: "new" } }], proposals: [{ rowId, columnId, provenanceTagId: tagId }] });
    expect(adopted.provenanceTags.find(tag => tag.id === tagId)!.detailSummary).toBe("Original source attribution");
    const malformed = { ...result, provenanceTags: [] };
    // Existing source tags still resolve even when the result omits its duplicate attribution.
    expect(() => planReviewBranchAdoption(fork.baseline, state, [malformed], [{ resultItemId: table.id, resultVersion: 2 }], crypto.randomUUID(), 11)).not.toThrow();
  });
});
