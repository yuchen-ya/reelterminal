import { describe, expect, it } from "vitest";
import {
  applyWorkbenchSelection,
  pruneWorkbenchSelection,
  useWorkbenchUiStore,
} from "./workbench-ui-store";

describe("workbench selection semantics", () => {
  const visible = ["a", "b", "c", "d", "e"];

  it("plain click replaces the selection and moves the cursor", () => {
    const result = applyWorkbenchSelection(visible, "a", ["a", "c"], "d", {});
    expect(result.selection).toEqual(["d"]);
    expect(result.cursor).toBe("d");
  });

  it("shift range spans only the current visible list", () => {
    const result = applyWorkbenchSelection(visible, "b", ["b"], "d", { shift: true });
    expect(result.selection).toEqual(["b", "c", "d"]);
  });

  it("shift selection never pulls hidden ids in and drops stale hidden ids", () => {
    // The pool is the filtered visible list; a previously selected id that is
    // filtered out is dropped so the selection is always constrained.
    const filtered = ["a", "d", "e"];
    const result = applyWorkbenchSelection(filtered, "a", ["a", "b"], "d", { shift: true });
    expect(result.selection).toEqual(["a", "d"]);
    expect(result.selection).not.toContain("b");
    expect(result.selection).not.toContain("c");
  });

  it("shift from an id outside the visible pool falls back to plain select", () => {
    const result = applyWorkbenchSelection(["a", "b"], "zzz", ["zzz"], "b", { shift: true });
    expect(result.selection).toEqual(["b"]);
  });

  it("ctrl toggles without affecting others", () => {
    const add = applyWorkbenchSelection(visible, "a", ["a"], "c", { ctrl: true });
    expect(add.selection).toEqual(["a", "c"]);
    const remove = applyWorkbenchSelection(visible, "a", ["a", "c"], "a", { ctrl: true });
    expect(remove.selection).toEqual(["c"]);
  });

  it("prune drops ids that left the visible scope", () => {
    expect(pruneWorkbenchSelection(["a", "b", "c"], ["a", "c"])).toEqual(["a", "c"]);
    const unchanged = ["a", "b"];
    expect(pruneWorkbenchSelection(unchanged, ["b", "a"])).toBe(unchanged);
  });
});

it("restores each review tab's filters, group, item selection, page and process view", () => {
  const store = useWorkbenchUiStore.getState();
  store.resetProjectScopedState();
  store.setSearchQuery("video project");
  store.activateScope("review:a");
  store.setActiveBatchId("group-a");
  store.setSearchQuery("opening");
  store.setTypeFilter("text");
  store.setCursor("group-a", "item-a");
  store.setSelection("group-a", ["item-a"]);
  store.setReviewPage("page-2", [undefined]);
  store.setReviewView("process");
  store.activateScope("review:b");
  expect(useWorkbenchUiStore.getState()).toMatchObject({ activeBatchId: null, searchQuery: "", typeFilter: "all", selectionByBatch: {}, reviewView: "content", reviewPreviousCursors: [] });
  store.setSearchQuery("closing");
  store.activateScope("review:a");
  expect(useWorkbenchUiStore.getState()).toMatchObject({ activeBatchId: "group-a", searchQuery: "opening", typeFilter: "text", cursorByBatch: { "group-a": "item-a" }, selectionByBatch: { "group-a": ["item-a"] }, reviewView: "process", reviewPageCursor: "page-2", reviewPreviousCursors: [undefined] });
  store.activateScope("project");
  expect(useWorkbenchUiStore.getState().searchQuery).toBe("video project");
  store.resetProjectScopedState();
});
