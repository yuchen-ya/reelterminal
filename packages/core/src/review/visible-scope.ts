/**
 * Visible workbench scope: type filter + search define which items may become
 * the cursor, join a selection or receive a keyboard decision. The cursor
 * NEVER falls back to a hidden item when the visible set is empty.
 */
import type { WorkbenchContentType } from "../types/workbench";

export interface WorkbenchScopeItem {
  readonly id: string;
  readonly type: WorkbenchContentType;
  readonly status: string;
  readonly title: string;
  readonly lineage?: {
    readonly upstreamSourceNode?: string;
    readonly basedOnLabel?: string;
  };
  readonly provenanceTags: readonly { readonly shortName: string }[];
}

/** Apply the controller's type filter + case-insensitive search. */
export function filterVisibleWorkbenchItems<T extends WorkbenchScopeItem>(
  items: readonly T[],
  typeFilter: WorkbenchContentType | "all",
  searchQuery: string,
): T[] {
  const query = searchQuery.trim().toLowerCase();
  return items.filter((item) => {
    if (typeFilter !== "all" && item.type !== typeFilter) return false;
    if (!query) return true;
    const haystack = [
      item.title,
      item.lineage?.upstreamSourceNode ?? "",
      item.lineage?.basedOnLabel ?? "",
      ...item.provenanceTags.map((tag) => tag.shortName),
    ]
      .join("\n")
      .toLowerCase();
    return haystack.includes(query);
  });
}

/**
 * Resolve the current item strictly inside the visible set: the cursor when
 * still visible, otherwise the first visible pending item, otherwise the
 * first visible item, otherwise null. A hidden cursor is never returned.
 */
export function resolveVisibleWorkbenchCursor<T extends WorkbenchScopeItem>(
  visibleItems: readonly T[],
  cursorId: string | null | undefined,
): T | null {
  if (visibleItems.length === 0) return null;
  if (cursorId) {
    const cursor = visibleItems.find((item) => item.id === cursorId);
    if (cursor) return cursor;
  }
  return visibleItems.find((item) => item.status === "pending") ?? visibleItems[0];
}
