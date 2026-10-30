import { create } from "zustand";
import type { WorkbenchContentType } from "@reelterminal/core";

/**
 * Pure selection semantics shared by every selectable surface (tree, grid,
 * mind-map). Shift ranges are computed over the CURRENT visible list only —
 * items hidden by filter/search can never join a selection.
 */
export function applyWorkbenchSelection(
  visibleIds: readonly string[],
  currentItemId: string | null,
  existingSelection: readonly string[],
  itemId: string,
  modifiers: { shift?: boolean; ctrl?: boolean; meta?: boolean },
): { selection: readonly string[]; cursor: string } {
  // A selection may only contain visible ids; a stale hidden id is dropped
  // before it can be extended by shift/ctrl.
  const visible = new Set(visibleIds);
  const scopedSelection = existingSelection.filter((id) => visible.has(id));
  if (modifiers.shift && currentItemId) {
    const idxA = visibleIds.indexOf(currentItemId);
    const idxB = visibleIds.indexOf(itemId);
    if (idxA !== -1 && idxB !== -1) {
      const [start, end] = idxA < idxB ? [idxA, idxB] : [idxB, idxA];
      const rangeIds = visibleIds.slice(start, end + 1);
      return {
        selection: Array.from(new Set([...scopedSelection, ...rangeIds])),
        cursor: itemId,
      };
    }
  }
  if (modifiers.ctrl || modifiers.meta) {
    const next = scopedSelection.includes(itemId)
      ? scopedSelection.filter((id) => id !== itemId)
      : [...scopedSelection, itemId];
    return { selection: next, cursor: itemId };
  }
  return { selection: [itemId], cursor: itemId };
}

/** Drop selection ids that left the visible scope; returns the same array when nothing changed. */
export function pruneWorkbenchSelection(
  selection: readonly string[],
  visibleIds: readonly string[],
): readonly string[] {
  const visible = new Set(visibleIds);
  let pruned: string[] | null = null;
  selection.forEach((id, index) => {
    if (visible.has(id)) {
      pruned?.push(id);
      return;
    }
    if (pruned === null) pruned = selection.slice(0, index);
  });
  return pruned ?? selection;
}

/** Display state only — see the store below. */

/**
 * Workbench DISPLAY state only: filters, cursors, selections, panel toggles.
 * This store never holds content — persisted batches/items/decisions/feedback
 * live exclusively in the project store (`project.workbench`) through real
 * actions. Per-batch cursors/selections keep batch switching from leaking
 * selection state across batches.
 */
export interface WorkbenchUiState {
  scopeId: string;
  viewsByScope: Record<string, WorkbenchViewState>;
  activateScope: (scopeId: string) => void;
  reviewView: "content" | "process";
  setReviewView: (view: "content" | "process") => void;
  reviewPageCursor: string | undefined;
  reviewPreviousCursors: Array<string | undefined>;
  setReviewPage: (cursor: string | undefined, previous: Array<string | undefined>) => void;
  activeBatchId: string | null;
  typeFilter: WorkbenchContentType | "all";
  searchQuery: string;
  autoAdvance: boolean;
  leftCollapsed: boolean;
  mindMapModalOpen: boolean;
  handoffDialogOpen: boolean;
  cursorByBatch: Readonly<Record<string, string>>;
  selectionByBatch: Readonly<Record<string, readonly string[]>>;

  setActiveBatchId: (batchId: string | null) => void;
  setTypeFilter: (filter: WorkbenchContentType | "all") => void;
  setSearchQuery: (query: string) => void;
  setAutoAdvance: (enabled: boolean) => void;
  setLeftCollapsed: (collapsed: boolean) => void;
  setMindMapModalOpen: (open: boolean) => void;
  setHandoffDialogOpen: (open: boolean) => void;
  setCursor: (batchId: string, itemId: string) => void;
  setSelection: (batchId: string, itemIds: readonly string[]) => void;
  /** Drop ids that left the visible scope (filter/search changed). */
  pruneSelection: (batchId: string, visibleIds: readonly string[]) => void;
  resetProjectScopedState: () => void;
}

type WorkbenchViewState = Pick<WorkbenchUiState, "activeBatchId" | "typeFilter" | "searchQuery" | "autoAdvance" | "leftCollapsed" | "cursorByBatch" | "selectionByBatch" | "reviewView" | "reviewPageCursor" | "reviewPreviousCursors">;
const emptyView = (): WorkbenchViewState => ({ activeBatchId: null, typeFilter: "all", searchQuery: "", autoAdvance: true, leftCollapsed: false, cursorByBatch: {}, selectionByBatch: {}, reviewView: "content", reviewPageCursor: undefined, reviewPreviousCursors: [] });
const snapshotView = (state: WorkbenchUiState): WorkbenchViewState => ({ activeBatchId: state.activeBatchId, typeFilter: state.typeFilter, searchQuery: state.searchQuery, autoAdvance: state.autoAdvance, leftCollapsed: state.leftCollapsed, cursorByBatch: state.cursorByBatch, selectionByBatch: state.selectionByBatch, reviewView: state.reviewView, reviewPageCursor: state.reviewPageCursor, reviewPreviousCursors: state.reviewPreviousCursors });

export const useWorkbenchUiStore = create<WorkbenchUiState>((set) => ({
  scopeId: "project",
  viewsByScope: {},
  activateScope: (scopeId) => set(state => state.scopeId === scopeId ? state : ({
    ...emptyView(), ...state.viewsByScope[scopeId], scopeId,
    viewsByScope: { ...state.viewsByScope, [state.scopeId]: snapshotView(state) },
    mindMapModalOpen: false, handoffDialogOpen: false,
  })),
  reviewView: "content",
  setReviewView: (reviewView) => set({ reviewView }),
  reviewPageCursor: undefined,
  reviewPreviousCursors: [],
  setReviewPage: (reviewPageCursor, reviewPreviousCursors) => set({ reviewPageCursor, reviewPreviousCursors }),
  activeBatchId: null,
  typeFilter: "all",
  searchQuery: "",
  autoAdvance: true,
  leftCollapsed: false,
  mindMapModalOpen: false,
  handoffDialogOpen: false,
  cursorByBatch: {},
  selectionByBatch: {},

  setActiveBatchId: (batchId) => set(state => state.activeBatchId === batchId ? state : { activeBatchId: batchId, reviewPageCursor: undefined, reviewPreviousCursors: [] }),
  setTypeFilter: (filter) => set({ typeFilter: filter, reviewPageCursor: undefined, reviewPreviousCursors: [] }),
  setSearchQuery: (query) => set({ searchQuery: query, reviewPageCursor: undefined, reviewPreviousCursors: [] }),
  setAutoAdvance: (enabled) => set({ autoAdvance: enabled }),
  setLeftCollapsed: (collapsed) => set({ leftCollapsed: collapsed }),
  setMindMapModalOpen: (open) => set({ mindMapModalOpen: open }),
  setHandoffDialogOpen: (open) => set({ handoffDialogOpen: open }),
  setCursor: (batchId, itemId) =>
    set((state) => ({ cursorByBatch: { ...state.cursorByBatch, [batchId]: itemId } })),
  setSelection: (batchId, itemIds) =>
    set((state) => ({
      selectionByBatch: { ...state.selectionByBatch, [batchId]: [...itemIds] },
    })),
  pruneSelection: (batchId, visibleIds) =>
    set((state) => {
      const current = state.selectionByBatch[batchId];
      if (!current?.length) return state;
      const pruned = pruneWorkbenchSelection(current, visibleIds);
      if (pruned === current) return state;
      return { selectionByBatch: { ...state.selectionByBatch, [batchId]: pruned } };
    }),
  resetProjectScopedState: () =>
    set({
      scopeId: "project",
      viewsByScope: {},
      reviewView: "content",
      reviewPageCursor: undefined,
      reviewPreviousCursors: [],
      activeBatchId: null,
      cursorByBatch: {},
      selectionByBatch: {},
      typeFilter: "all",
      searchQuery: "",
      mindMapModalOpen: false,
      handoffDialogOpen: false,
    }),
}));
