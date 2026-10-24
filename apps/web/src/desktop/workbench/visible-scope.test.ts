import { describe, expect, it } from "vitest";
import {
  filterVisibleWorkbenchItems,
  resolveVisibleWorkbenchCursor,
  type WorkbenchScopeItem,
} from "./visible-scope";

const ITEMS: WorkbenchScopeItem[] = [
  {
    id: "txt-1",
    type: "text",
    status: "pending",
    title: "第一段旁白",
    provenanceTags: [{ shortName: "母版" }],
  },
  {
    id: "img-1",
    type: "image",
    status: "pending",
    title: "主视觉",
    provenanceTags: [{ shortName: "边缘清理" }],
  },
  {
    id: "txt-done",
    type: "text",
    status: "kept",
    title: "已处理旁白",
    provenanceTags: [],
  },
];

describe("workbench visible scope", () => {
  it("filters by type and search over the real display fields", () => {
    expect(filterVisibleWorkbenchItems(ITEMS, "text", "").map((i) => i.id)).toEqual([
      "txt-1",
      "txt-done",
    ]);
    expect(filterVisibleWorkbenchItems(ITEMS, "all", "边缘").map((i) => i.id)).toEqual([
      "img-1",
    ]);
    expect(filterVisibleWorkbenchItems(ITEMS, "all", "  旁白 ").map((i) => i.id)).toEqual([
      "txt-1",
      "txt-done",
    ]);
    expect(filterVisibleWorkbenchItems(ITEMS, "video", "")).toEqual([]);
  });

  it("never resolves a hidden cursor and returns null for an empty scope", () => {
    const visibleTexts = filterVisibleWorkbenchItems(ITEMS, "text", "第一段");
    expect(visibleTexts.map((i) => i.id)).toEqual(["txt-1"]);

    // The cursor belongs to a hidden image → fall back inside the visible set.
    expect(resolveVisibleWorkbenchCursor(visibleTexts, "img-1")?.id).toBe("txt-1");

    // A visible non-pending cursor is honoured (explicit processed retrieval).
    const allTexts = filterVisibleWorkbenchItems(ITEMS, "text", "");
    expect(resolveVisibleWorkbenchCursor(allTexts, "txt-done")?.id).toBe("txt-done");

    // No visible item at all → null, never the hidden raw item.
    expect(resolveVisibleWorkbenchCursor([], "img-1")).toBeNull();
    expect(resolveVisibleWorkbenchCursor(filterVisibleWorkbenchItems(ITEMS, "video", ""), "img-1")).toBeNull();
  });

  it("prefers the first visible pending item when the cursor is not visible", () => {
    const all = filterVisibleWorkbenchItems(ITEMS, "all", "");
    expect(resolveVisibleWorkbenchCursor(all, "img-1")?.id).toBe("img-1");
    expect(resolveVisibleWorkbenchCursor(all, null)?.id).toBe("txt-1");
    // Cursor hidden by a search → first visible pending wins.
    const pendingTexts = filterVisibleWorkbenchItems(ITEMS, "text", "旁白");
    expect(resolveVisibleWorkbenchCursor(pendingTexts, "img-1")?.id).toBe("txt-1");
  });
});
