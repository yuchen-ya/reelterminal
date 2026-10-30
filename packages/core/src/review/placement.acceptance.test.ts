import { expect, it } from "vitest";
import { buildWorkbenchIngestActions } from "../actions/workbench-actions";
import { emptyWorkbenchState, type WorkbenchProjectState } from "../types/workbench";
import { buildWorkbenchPlacementActions, workbenchPlacementGroup } from "./placement";
import { reduceReviewActions } from "./reducer";

function fixture(): WorkbenchProjectState {
  const items = [
    ["parent", "source-a", undefined], ["child", "source-a", "parent"],
    ["grandchild", "source-a", "child"], ["other", "source-b", undefined],
  ].map(([id, group, parent]) => ({
    id: id!, title: id!, type: "text" as const,
    content: { type: "text" as const, entryId: id!, title: id!, speakerOrContext: "",
      versions: [{ version: 1, text: id!, createdAt: 1, origin: "ingest" as const }] },
    lineage: { upstreamGroupId: group!, upstreamGroupTitle: group!, upstreamSourceNode: id!,
      ...(parent ? { parentNodeId: parent } : {}), basedOnLabel: "original", connectorEdgeLabel: "based on", failStreak: 0, steps: [] },
  }));
  const built = buildWorkbenchIngestActions(emptyWorkbenchState(), { batchId: "batch", name: "All descendants", items });
  if (!built.ok) throw new Error(built.message);
  const state = reduceReviewActions(emptyWorkbenchState(), built.actions).state;
  return { ...state, feedback: [{ id: "feedback", itemId: "child", itemVersion: 1, text: "Keep feedback", referencedTagIds: [], state: "confirmed", createdAt: 1, updatedAt: 1 }] };
}

it("moves a subtree from the full batch without changing source identity, decisions or feedback and one inverse restores it", () => {
  const initial = fixture();
  // Only the root is the drag selection; descendants can be filtered or paged out in the UI.
  const actions = buildWorkbenchPlacementActions(initial, { batchId: "batch", itemIds: ["parent"], groupId: "source-b" }, 100);
  const moved = reduceReviewActions(initial, actions);
  expect(moved.state.items.map(workbenchPlacementGroup)).toEqual(["source-b", "source-b", "source-b", "source-b"]);
  expect(moved.state.feedback).toEqual(initial.feedback);
  for (const item of moved.state.items) {
    const original = initial.items.find(candidate => candidate.id === item.id)!;
    const { placement: _placement, updatedAt: _updatedAt, ...content } = item;
    const { updatedAt: _originalTime, ...originalContent } = original;
    expect(content).toEqual(originalContent);
  }
  expect(reduceReviewActions(moved.state, moved.inverse).state).toEqual(initial);
  expect(buildWorkbenchPlacementActions(moved.state, { batchId: "batch", itemIds: ["parent"], groupId: "source-b" })).toEqual([]);
});

it("moves selected items to ungrouped and rejects invalid targets and self/descendant drops", () => {
  const initial = fixture();
  const moved = reduceReviewActions(initial, buildWorkbenchPlacementActions(initial, { batchId: "batch", itemIds: ["child", "other"], groupId: null }));
  expect(moved.state.items.map(workbenchPlacementGroup)).toEqual(["source-a", null, null, null]);
  expect(reduceReviewActions(moved.state, moved.inverse).state).toEqual(initial);
  for (const input of [
    { batchId: "elsewhere", itemIds: ["parent"], groupId: null },
    { batchId: "batch", itemIds: ["missing"], groupId: null },
    { batchId: "batch", itemIds: ["parent"], groupId: "unknown" },
    { batchId: "batch", itemIds: ["parent"], groupId: "source-b", targetItemId: "child" },
  ]) expect(() => buildWorkbenchPlacementActions(initial, input)).toThrow();
  expect(initial.items.map(workbenchPlacementGroup)).toEqual(["source-a", "source-a", "source-a", "source-b"]);
});
