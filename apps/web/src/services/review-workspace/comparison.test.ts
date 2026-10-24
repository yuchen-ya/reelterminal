import { describe, expect, it } from "vitest";
import type { WorkbenchDataContent } from "@reelterminal/core/types/workbench";
import { compareReviewData, compareReviewText } from "./comparison";

describe("review comparisons preserve source identity", () => {
  it("keeps emoji, duplicate phrases, whitespace and CRLF differences in the actual texts", () => {
    const before = "same phrase 👀\r\nsame phrase\n ";
    const after = "same phrase 👀\r\nchanged phrase\n";
    const diff = compareReviewText(before, after)!;
    expect(diff.filter(part => !part.added).map(part => part.value).join("")).toBe(before);
    expect(diff.filter(part => !part.removed).map(part => part.value).join("")).toBe(after);
  });
  it("matches reordered rows and duplicate-title columns by IDs and distinguishes null, empty and missing", () => {
    const base: WorkbenchDataContent = { type: "data", datasetId: "dataset", columns: [{ columnId: "c1", title: "same" }, { columnId: "c2", title: "same" }], rows: [{ rowId: "r1", cells: { c1: null, c2: "" } }, { rowId: "r2", cells: { c1: "B", c2: "kept" } }], proposals: [] };
    const changed = { ...base, rows: [{ rowId: "r2", cells: { c1: "B", c2: "kept" } }, { rowId: "r1", cells: { c1: "", c2: "" } }, { rowId: "r3", cells: { c1: null, c2: "new" } }] };
    expect(compareReviewData(base, changed)).toEqual([
      { rowId: "r1", columnId: "c1", columnTitle: "same", kind: "changed", before: null, after: "" },
      { rowId: "r3", columnId: "c1", columnTitle: "same", kind: "added", before: undefined, after: null },
      { rowId: "r3", columnId: "c2", columnTitle: "same", kind: "added", before: undefined, after: "new" },
    ]);
    expect(base.rows[0].cells.c1).toBeNull();
  });
});
