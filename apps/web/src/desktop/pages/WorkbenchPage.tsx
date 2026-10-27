import { ModelViewerWorkspace } from "../workbench/components/ModelViewerWorkspace";
import "../workbench/workbench.css";
import type { JSX, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronUp, LayoutGrid, PanelLeftOpen } from "lucide-react";
import type { WorkbenchDecision } from "@reelterminal/core";
import { ToolcraftDialog, ToolcraftDialogHeader } from "@reelterminal/ui";
import { CollectionInteractionContext, type CollectionAction, type CollectionScope } from "../workbench/components/CollectionActions";
import { useCollectionExport, type CollectionExportTarget } from "../workbench/useCollectionExport";
import { ReviewExportDialog } from "../workbench/components/ReviewExportDialog";
import { wbButton } from "../workbench/wb-button";
import {
  LEGACY_LS_WORKBENCH_ISSUE_WIDTH,
  LEGACY_LS_WORKBENCH_TREE_WIDTH,
} from "../../services/legacy-storage-keys";
import { useResizable } from "../editor/useResizable";
import { CollabStatusBar } from "../editor/CollabStatusBar";
import { useWorkbenchController } from "../workbench/useWorkbenchController";
import type {
  SelectModifiers,
  WorkbenchController,
  WorkbenchItemView,
} from "../workbench/types";
import { applyWorkbenchSelection, useWorkbenchUiStore } from "../../stores/workbench-ui-store";
import { TextCorpusWorkspace } from "../workbench/components/TextCorpusWorkspace";
import { DataCleaningWorkspace } from "../workbench/components/DataCleaningWorkspace";
import { ImageViewerWorkspace } from "../workbench/components/ImageViewerWorkspace";
import { VideoFrameWorkspace } from "../workbench/components/VideoFrameWorkspace";
import { AdaptiveBoardWorkspace } from "../workbench/components/AdaptiveBoardWorkspace";
import type {
  LineageTreeFilter,
  SelectedBoardScope,
} from "../workbench/components/PendingLineagePanel";
import {
  buildWorkbenchLineageGroups,
  collectSubtreeItems,
  collectGroupItems,
  getWorkbenchTypeIcon,
  type WorkbenchLineageNode,
} from "../workbench/components/lineage-tree-utils";
import { WorkbenchQueueColumn } from "../workbench/components/WorkbenchQueueColumn";
import {
  WorkbenchStartPanel,
  AGENT_INGEST_INSTRUCTIONS,
} from "../workbench/components/WorkbenchStartPanel";
import { WorkbenchQueueState } from "../workbench/components/WorkbenchQueueState";
import { VisualMindMapModal } from "../workbench/components/VisualMindMapModal";
import { SimpleBottomDetailsTimeline } from "../workbench/components/SimpleBottomDetailsTimeline";
import { HandoffDialog } from "../workbench/components/HandoffDialog";
import { CreateWorkbenchBatchDialog } from "../workbench/components/CreateWorkbenchBatchDialog";
import { useUIStore } from "../../stores/ui-store";

function ColumnHandle({
  onPointerDown,
  title,
}: {
  onPointerDown: (event: React.PointerEvent) => void;
  title: string;
}): JSX.Element {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title={title}
      onPointerDown={onPointerDown}
      className="-ml-px w-1 shrink-0 cursor-col-resize select-none transition-colors hover:bg-accent/50 z-10"
    />
  );
}

function isTextEntry(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT" ||
    element.isContentEditable
  );
}

/** Same predicate for the tree filter and its count (no drift). */
function inReworkChain(item: WorkbenchItemView): boolean {
  return (
    item.status === "rework" ||
    item.reworkOrigin !== undefined ||
    (item.lineage?.failStreak ?? 0) > 0
  );
}

function findLineageNodeById(
  nodes: readonly WorkbenchLineageNode[],
  itemId: string,
): WorkbenchLineageNode | null {
  for (const node of nodes) {
    if (node.item.id === itemId) return node;
    const found = findLineageNodeById(node.children, itemId);
    if (found) return found;
  }
  return null;
}

/**
 * Workbench page: the single functional container for the AI material
 * workbench. It owns the layout (resizable panels via useResizable with
 * workbench-specific storage keys), keyboard routing, and assembles the
 * migrated prototype components. All state flows through
 * useWorkbenchController — this page holds no content state of its own.
 */
export function WorkbenchPage(): JSX.Element {
  const controller = useWorkbenchController();
  return <WorkbenchPanel controller={controller} />;
}

export function WorkbenchPanel({
  controller,
  independent = false,
  onImport,
  emptyContent,
  loading = false,
  paginationFooter,
  exportTarget,
  paginated = false,
  pageKey,
  browserDemo = false,
}: {
  controller: WorkbenchController;
  independent?: boolean;
  onImport?: () => void;
  emptyContent?: ReactNode;
  loading?: boolean;
  paginationFooter?: ReactNode;
  exportTarget?: CollectionExportTarget;
  paginated?: boolean;
  pageKey?: number;
  browserDemo?: boolean;
}): JSX.Element {
  const leftCollapsed = useWorkbenchUiStore((s) => s.leftCollapsed);
  const ui = useWorkbenchUiStore.getState;
  const [treeFilter, setTreeFilter] = useState<LineageTreeFilter>("all");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [activeBoard, setActiveBoard] = useState<SelectedBoardScope | null>(null);
  const [drilledFromBoard, setDrilledFromBoard] =
    useState<SelectedBoardScope | null>(null);
  const [operation, setOperation] = useState<{ action: CollectionAction; scope: CollectionScope; revision?: number } | null>(null);
  const [exportScope, setExportScope] = useState<(CollectionScope & { revision?: number }) | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const committing = useRef(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const quickExport = useCollectionExport(exportTarget);

  const treeW = useResizable({
    initial: 220,
    min: 180,
    max: 480,
    axis: "x",
    direction: 1,
    storageKey: LEGACY_LS_WORKBENCH_TREE_WIDTH,
  });
  const issueW = useResizable({
    initial: 280,
    min: 240,
    max: 480,
    axis: "x",
    direction: -1,
    storageKey: LEGACY_LS_WORKBENCH_ISSUE_WIDTH,
  });
  const [toast, setToast] = useState<string | null>(null);
  const [createBatchOpen, setCreateBatchOpen] = useState(false);
  const createBatch = () => (onImport ? onImport() : setCreateBatchOpen(true));
  const toastTimer = useRef<number | null>(null);
  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3200);
  }, []);
  const openHandoff = () => browserDemo ? showToast("请使用桌面版将审阅结果交给 Agent") : ui().setHandoffDialogOpen(true);
  useEffect(() => {
    return () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    };
  }, []);

  const report = useCallback(
    async <T extends { ok: true } | { ok: false; code: string; message: string }>(
      promise: Promise<T>,
      success?: string,
    ): Promise<T> => {
      const result = await promise;
      if (result.ok) {
        if (success) showToast(success);
      } else {
        showToast(result.message ?? "操作失败");
      }
      return result;
    },
    [showToast],
  );

  const { currentItem, batchItems, visibleItems, pendingItems } = controller;
  const processedCount =
    batchItems.length - batchItems.filter((i) => i.status === "pending").length;
  const hasBatch = controller.batches.length > 0;

  // Reset board state when switching batches
  useEffect(() => {
    setActiveBoard(null);
    setDrilledFromBoard(null);
  }, [controller.activeBatch?.id, pageKey]);

  // Build lineage groups over batchItems so we can detect if currentItem is a board parent node
  const batchLineageGroups = useMemo(
    () => buildWorkbenchLineageGroups(batchItems),
    [batchItems],
  );

  const currentBoardParentScope = useMemo<SelectedBoardScope | null>(() => {
    if (!currentItem) return null;
    for (const group of batchLineageGroups) {
      const node = findLineageNodeById(group.roots, currentItem.id);
      if (node && node.children.length > 0 && node.mode !== "category") {
        const subtree = collectSubtreeItems(node);
        return {
          id: `node:${currentItem.id}`,
          title: currentItem.agentGuidance?.nodeSlotLabel ?? currentItem.title,
          itemIds: subtree.map((i) => i.id),
        };
      }
    }
    return null;
  }, [batchLineageGroups, currentItem]);

  const collection = activeBoard ?? drilledFromBoard ?? currentBoardParentScope;
  const effectiveBoard = drilledFromBoard ? null : collection;
  const collectionItems = useMemo(() => {
    if (!collection) return [];
    if (collection.id.startsWith("batch:")) return batchItems;
    if (collection.id.startsWith("group:")) {
      const group = batchLineageGroups.find(group => `group:${group.id}` === collection.id);
      return group ? collectGroupItems(group) : [];
    }
    if (collection.id.startsWith("node:")) {
      const node = findLineageNodeById(batchLineageGroups.flatMap(group => group.roots), collection.id.slice(5));
      return node ? collectSubtreeItems(node) : [];
    }
    return batchItems.filter(item => collection.itemIds.includes(item.id));
  }, [batchItems, batchLineageGroups, collection]);

  const effectiveBoardItems = useMemo(() => {
    if (!collection) return [];
    const idSet = new Set(collectionItems.map(item => item.id));
    return visibleItems.filter(item => idSet.has(item.id) &&
      (treeFilter === "all" || (treeFilter === "pending" ? item.status === "pending" : inReworkChain(item))));
  }, [visibleItems, collection, collectionItems, treeFilter]);

  const scopeForItem = (itemId: string): SelectedBoardScope | null => {
    const group = batchLineageGroups.find(group => collectGroupItems(group).some(item => item.id === itemId));
    if (!group) return null;
    return { id: `group:${group.id}`, title: group.isUngrouped ? "未分组" : group.baseName, itemIds: collectGroupItems(group).map(item => item.id) };
  };

  const returnScope = drilledFromBoard ?? (currentItem ? scopeForItem(currentItem.id) : null);
  const navigationItems = collection ? effectiveBoardItems : visibleItems;
  const currentNavigationIndex = navigationItems.findIndex(item => item.id === currentItem?.id);

  const handleSelectItemFromTree = useCallback(
    (itemId: string, modifiers?: SelectModifiers) => {
      const scope = scopeForItem(itemId);
      if (!scope) {
        showToast("该条目不在当前页，请切换分页或筛选后查看");
        return;
      }
      setActiveBoard(null);
      setDrilledFromBoard(scope);
      controller.selectItem(itemId, modifiers);
    },
    [controller, batchLineageGroups, showToast],
  );

  const handleSelectBoard = useCallback((board: SelectedBoardScope) => {
    setDrilledFromBoard(null);
    setActiveBoard(board);
    controller.clearSelection();
  }, [controller]);

  const handleDrillIntoBoardItem = useCallback(
    (itemId: string) => {
      if (effectiveBoard) {
        setDrilledFromBoard(effectiveBoard);
      }
      setActiveBoard(null);
      controller.focusItem(itemId);
    },
    [controller, effectiveBoard],
  );

  const selectInCollection = (itemId: string, modifiers: SelectModifiers = {}) => {
    const result = applyWorkbenchSelection(effectiveBoardItems.map(item => item.id), currentItem?.id ?? null,
      controller.selectedIds.filter(id => effectiveBoardItems.some(item => item.id === id)), itemId, modifiers);
    controller.setSelection(result.selection);
    if (result.cursor) controller.focusItem(result.cursor);
  };
  const decisionTargets = effectiveBoard
    ? controller.selectedIds.filter(id => effectiveBoardItems.some(item => item.id === id))
    : currentItem ? [currentItem.id] : [];
  const navigate = (direction: number) => {
    if (!collection) {
      if (direction > 0) controller.skipNext();
      else controller.skipPrev();
      return;
    }
    const index = effectiveBoardItems.findIndex(item => item.id === currentItem?.id);
    const next = effectiveBoardItems[index + direction];
    if (next) handleDrillIntoBoardItem(next.id);
  };
  const commit = async (decision: WorkbenchDecision, ids: readonly string[] = decisionTargets, reworkReason?: string) => {
    if (decision === "rework" && reworkReason === undefined) {
      const items = batchItems.filter(item => ids.includes(item.id));
      if (!items.length) return { ok: false as const, code: "EMPTY", message: "请先选择条目" };
      setReason(""); setOperationError(null);
      setOperation({ action: "rework", scope: { title: items.length === 1 ? items[0].title : "选中条目", items, folder: items.length > 1 }, revision: exportTarget?.revision });
      return { ok: true as const };
    }
    if (committing.current) return { ok: false as const, code: "BUSY", message: "正在提交上一项操作" };
    committing.current = true;
    setBusy(true);
    try {
      const result = await report(controller.commitDecision(decision, ids, { reason: reworkReason, advance: !collection }),
        `已${decision === "kept" ? "保留" : decision === "discarded" ? "丢弃" : "标记返工"} ${ids.length} 项，可撤销`);
      if (result.ok && !effectiveBoard && collection && controller.autoAdvance) {
        const index = effectiveBoardItems.findIndex(item => item.id === currentItem?.id);
        const ordered = [...effectiveBoardItems.slice(index + 1), ...effectiveBoardItems.slice(0, index)];
        const next = ordered.find(item => item.status === "pending" && !ids.includes(item.id));
        if (next) handleDrillIntoBoardItem(next.id);
      }
      return result;
    } finally {
      committing.current = false;
      setBusy(false);
    }
  };
  const runCollectionAction = async (action: CollectionAction, scope: CollectionScope, reworkReason?: string) => {
    const items = scope.items.filter(item => action.endsWith("pending") ? item.status === "pending" : action === "retrieve" ? item.status !== "pending" : true);
    if (committing.current) return;
    setBusy(true); setOperationError(null);
    try {
      const result = action === "retrieve"
        ? await (async () => {
          committing.current = true;
          try { return await report(controller.retrieveItemsToPending(items.map(item => item.id)), `已将 ${items.length} 项恢复待审，可撤销`); }
          finally { committing.current = false; }
        })()
        : await commit(action.startsWith("keep") ? "kept" : action.startsWith("discard") ? "discarded" : "rework", items.map(item => item.id), reworkReason);
      if (result.ok) setOperation(null);
      else setOperationError(result.message);
    } finally { setBusy(false); }
  };
  const collectionAction = (action: CollectionAction, scope: CollectionScope) => {
    if (action === "select") {
      setDrilledFromBoard(null);
      setActiveBoard({ id: `selection:${scope.items[0].id}`, title: scope.title, itemIds: scope.items.map(item => item.id) });
      controller.setSelection(scope.items.map(item => item.id));
      return;
    }
    if (action === "export") { setExportScope({ ...scope, revision: exportTarget?.revision }); return; }
    if (action === "rework" || (action.endsWith("all") && scope.items.some(item => item.status !== "pending"))) {
      setReason(""); setOperationError(null); setOperation({ action, scope, revision: exportTarget?.revision }); return;
    }
    void runCollectionAction(action, scope);
  };
  useEffect(() => {
    controller.clearSelection();
    setOperation(null); setExportScope(null);
  }, [controller.typeFilter, controller.searchQuery, treeFilter, controller.activeBatch?.id, pageKey]);

  // Keyboard routing: decision shortcuts only when a list/canvas area owns the focus.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (loading) return;
      if (busy) return;
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (independent && !target?.closest("[data-review-content-scope]")) return;
      if (isTextEntry(target)) return;
      if (document.querySelector("[data-workbench-modal='true']")) return;
      const inPlayer = !!target?.closest("[data-workbench-player='true']");
      const key = event.key;
      if (key === " " && inPlayer) return;
      if (key === "1" || key === "2" || key === "3" || key === "4") {
        if (inPlayer) return;
        if (controller.selectionCount === 0 && !currentItem) return;
        if (key === "2") {
          event.preventDefault();
          showToast("“已修改”需先保存实际内容修订(文字/数据/修补),不能用快捷键直接标记");
          return;
        }
        const decision: WorkbenchDecision =
          key === "1" ? "kept" : key === "3" ? "rework" : "discarded";
        event.preventDefault();
        if (!decisionTargets.length) return;
        void commit(decision, decisionTargets);
      } else if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "a" && effectiveBoard) {
        event.preventDefault(); controller.setSelection(effectiveBoardItems.map(item => item.id));
      } else if (key === "Escape" && effectiveBoard) {
        controller.clearSelection();
      } else if (key === "j" && !effectiveBoard) {
        if (isTextEntry(target)) return;
        event.preventDefault();
        navigate(1);
      } else if (key === "k" && !effectiveBoard) {
        event.preventDefault();
        navigate(-1);
      } else if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "z") {
        event.preventDefault();
        void report(event.shiftKey ? controller.redoLast() : controller.undoLast());
      } else if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "y") {
        event.preventDefault();
        void report(controller.redoLast());
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [controller, currentItem, independent, loading, busy, report, showToast, collection, effectiveBoardItems, decisionTargets]);

  const batchImageItems = useMemo(
    () => (collection ? effectiveBoardItems : visibleItems).filter((item) => item.type === "image"),
    [collection, effectiveBoardItems, visibleItems],
  );
  const batchVideoItems = useMemo(
    () => batchItems.filter((item) => item.type === "video"),
    [batchItems],
  );

  const treeItems = useMemo(() => {
    if (treeFilter === "all") return visibleItems;
    if (treeFilter === "pending") return visibleItems.filter((i) => i.status === "pending");
    return visibleItems.filter(inReworkChain);
  }, [visibleItems, treeFilter]);

  const treeFilterCounts = useMemo(
    () => ({
      all: visibleItems.length,
      pending: visibleItems.filter((i) => i.status === "pending").length,
      rework: visibleItems.filter(inReworkChain).length,
    }),
    [visibleItems],
  );

  const copyInstructions = useCallback(async () => {
    const text = AGENT_INGEST_INSTRUCTIONS;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
      showToast("接入说明已复制（不含 token，不会自动开启写权限）");
    } catch {
      setCopyState("failed");
      showToast("复制失败，请展开命令手动复制");
    }
  }, [showToast]);

  const openIngestHelp = useCallback(() => {
    const detail = document.querySelector<HTMLDetailsElement>(
      "[data-testid='workbench-ingest-help-panel']",
    );
    if (detail) detail.open = true;
  }, []);

  const resetFilters = useCallback(() => {
    controller.setTypeFilter("all");
    controller.setSearchQuery("");
  }, [controller]);

  const openMediaLibrary = useCallback(() => {
    sessionStorage.setItem("reelterminal.assets.openMedia", "1");
    useUIStore.getState().setDesktopPage("edit");
  }, []);

  const switchToAll = useCallback(() => {
    setTreeFilter("all");
  }, []);

  const filteredEmpty =
    hasBatch && batchItems.length > 0 && visibleItems.length === 0;

  return (
    <CollectionInteractionContext.Provider value={{ action: collectionAction, busy,
      selectedItems: (effectiveBoard ? effectiveBoardItems : visibleItems).filter(item => controller.selectedIds.includes(item.id)),
      ...(exportTarget ? { prepareDrag: quickExport.prepare, drag: quickExport.drag } : {}) }}>
    <div
      className="relative flex h-full min-h-0 flex-col bg-bg text-fg"
      data-testid="workbench-page"
      data-workbench-scope="true"
      data-review-content-scope={independent ? "true" : undefined}
      tabIndex={-1}
    >
      {/* Agent access / live status (shared with the editor shell) */}
      {!independent && (
        <div className="h-9 shrink-0 border-b border-border bg-bg-1">
          <CollabStatusBar />
        </div>
      )}

      {toast && (
        <div role="status" className="fixed top-14 left-1/2 z-[var(--z-toast)] -translate-x-1/2 rounded-xl border border-accent/50 bg-bg-2 px-4 py-2 text-xs text-fg shadow-2xl">
          {toast}
          {controller.canUndo && <button className="ml-3 text-accent" onClick={() => { void report(controller.undoLast()); setToast(null); }}>撤销</button>}
        </div>
      )}

      {/* Main 1px divider panel layout */}
      <div className="flex min-h-0 flex-1 overflow-hidden bg-bg" inert={busy}>
        {/* Left: lineage tree queue column — always mounted */}
        {leftCollapsed ? (
          <div
            className="flex w-10 shrink-0 flex-col items-center gap-1.5 border-r border-border bg-bg-1 py-2"
            data-testid="collapsed-pending-switcher"
          >
            <button
              type="button"
              onClick={() => ui().setLeftCollapsed(false)}
              className="rounded-lg bg-bg-2 p-1.5 text-accent hover:bg-bg-3"
              title="展开上游血缘树"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
            <span
              className="font-mono text-[10px] font-bold text-accent"
              title={`剩余待处理节点: ${pendingItems.length}`}
            >
              {pendingItems.length}
            </span>

            {/* Prev / Next unhandled node steppers */}
            <div className="flex flex-col items-center gap-0.5 border-y border-border/70 py-1">
              <button
                type="button"
                onClick={() => {
                  navigate(-1);
                }}
                disabled={pendingItems.length === 0}
                className="rounded p-1 text-fg-2 hover:bg-bg-2 hover:text-fg disabled:opacity-35"
                title="上一个待处理节点 (K / ↑)"
                data-testid="collapsed-prev-pending"
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => {
                  navigate(1);
                }}
                disabled={pendingItems.length === 0}
                className="rounded p-1 text-fg-2 hover:bg-bg-2 hover:text-fg disabled:opacity-35"
                title="下一个待处理节点 (J / ↓)"
                data-testid="collapsed-next-pending"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* Compact mini-node switcher for unhandled items */}
            <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto px-1 py-0.5">
              {pendingItems.map((pendingItem, idx) => {
                const isActive =
                  !effectiveBoard && currentItem?.id === pendingItem.id;
                const shortLabel =
                  pendingItem.agentGuidance?.nodeSlotLabel ?? pendingItem.title;
                const failStreak = pendingItem.lineage?.failStreak ?? 0;
                return (
                  <button
                    key={pendingItem.id}
                    type="button"
                    onClick={() => handleSelectItemFromTree(pendingItem.id)}
                    className={`relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[10px] transition-colors ${
                      isActive
                        ? "bg-accent/20 text-fg ring-1 ring-accent"
                        : failStreak >= 2
                          ? "bg-status-warning/15 text-fg-2 hover:bg-status-warning/25"
                          : "bg-bg-2/60 text-fg-3 hover:bg-bg-2 hover:text-fg"
                    }`}
                    title={`${idx + 1}. ${shortLabel}`}
                    data-testid={`collapsed-pending-node-${pendingItem.id}`}
                  >
                    {getWorkbenchTypeIcon(pendingItem.type)}
                    <span
                      className={`absolute right-0.5 bottom-0.5 h-1.5 w-1.5 rounded-full ${
                        failStreak >= 2
                          ? "bg-status-error"
                          : isActive
                            ? "bg-accent"
                            : "bg-fg-3/60"
                      }`}
                    />
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <>
            <div
              style={{ width: treeW.value }}
              className="relative flex shrink-0 flex-col overflow-hidden border-r border-border bg-bg-1"
              data-testid="workbench-tree-panel"
            >
              <WorkbenchQueueColumn
                controller={controller}
                hasBatch={hasBatch}
                independent={independent}
                paginated={paginated}
                onCreateBatch={createBatch}
                onCollapse={() => ui().setLeftCollapsed(true)}
                onOpenHandoff={openHandoff}
                treeFilter={treeFilter}
                onTreeFilterChange={setTreeFilter}
                treeFilterCounts={treeFilterCounts}
                treeItems={treeItems}
                activeBoardId={effectiveBoard?.id ?? null}
                onSelectBoard={handleSelectBoard}
                onSelectItem={handleSelectItemFromTree}
                paginationFooter={paginationFooter}
                onRetrieveItem={(itemId) =>
                  report(controller.retrieveToPending(itemId), "已取回至待审状态")
                }
              />
            </div>
            <ColumnHandle onPointerDown={treeW.onHandlePointerDown} title="拖拽调整队列宽度" />
          </>
        )}

        {/* Centre/Right main workspace: viewer + bottom dock */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-bg">
          {quickExport.feedback}
          {!loading && controller.activeBatch && controller.activeBatch.totalCount > 0 && controller.activeBatch.pendingCount === 0 && (
            <div role="status" data-testid="review-complete" className="flex shrink-0 items-center gap-3 border-b border-accent/30 bg-accent/10 px-3 py-2 text-xs">
              <span>本批 {controller.activeBatch.totalCount} 条已全部审完</span>
              <button className={wbButton.secondary} onClick={openHandoff}>发布本批结果</button>
              {controller.batches.some(batch => batch.id !== controller.activeBatch?.id && batch.pendingCount > 0) &&
                <button className={wbButton.ghost} onClick={() => controller.setActiveBatchId(controller.batches.find(batch => batch.id !== controller.activeBatch?.id && batch.pendingCount > 0)!.id)}>下一待审批次</button>}
            </div>
          )}
          {!loading && controller.activeBatch && controller.activeBatch.pendingCount > 0 && collectionItems.length > 0 && !paginated && collectionItems.every(item => item.status !== "pending") && (
            <div role="status" className="shrink-0 border-b border-border px-3 py-2 text-xs text-fg-2">本组已审完，本批还有 {controller.activeBatch.pendingCount} 项待审。</div>
          )}
          {returnScope && !effectiveBoard && (
            <div
              className="flex h-7 shrink-0 items-center justify-between border-b border-border bg-bg-1 px-3 text-[11px]"
              data-testid="board-drilldown-breadcrumb"
            >
              <button
                type="button"
                onClick={() => {
                  setActiveBoard(returnScope);
                  setDrilledFromBoard(null);
                }}
                className="inline-flex items-center gap-1.5 font-medium text-accent hover:underline"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                <LayoutGrid className="h-3.5 w-3.5" />
                <span>返回集合：{returnScope.title}</span>
              </button>
              <div className="flex min-w-0 items-center gap-2 text-fg-3">
                <span className="truncate">{currentItem?.agentGuidance?.nodeSlotLabel ?? currentItem?.title}</span>
                <button type="button" aria-label="上一项" disabled={currentNavigationIndex <= 0} onClick={() => navigate(-1)} className={wbButton.ghost}>上一项</button>
                <button type="button" aria-label="下一项" disabled={currentNavigationIndex >= navigationItems.length - 1} onClick={() => navigate(1)} className={wbButton.ghost}>下一项</button>
              </div>
            </div>
          )}

          <div className="relative min-h-0 flex-1 overflow-hidden" data-testid="workbench-content">
            {collection && <div className={effectiveBoard ? "h-full" : "hidden"}>
              <AdaptiveBoardWorkspace key={collection.id} boardId={collection.id}
                boardTitle={`${paginated ? "本页 · " : ""}${independent && (controller.typeFilter !== "all" || controller.searchQuery) ? "筛选结果 · " : ""}${collection.title}`}
                items={effectiveBoardItems} currentItem={currentItem} selectedIds={controller.selectedIds}
                allItems={collectionItems}
                onSelectItem={selectInCollection} onOpenChildItem={handleDrillIntoBoardItem}
                onCommitDecision={commit} onSelectAll={() => controller.setSelection(effectiveBoardItems.map(item => item.id))}
                onClearSelection={controller.clearSelection}
                onOpenBatch={() => handleSelectBoard({ id: `batch:${controller.activeBatch!.id}`, title: controller.activeBatch!.name, itemIds: batchItems.map(item => item.id) })}
                ensureItemsLoaded={controller.ensureItemsLoaded} openMediaUrl={controller.openMediaUrl} />
            </div>}
            {!hasBatch ? (
              emptyContent ?? (
                <WorkbenchStartPanel
                  onCopy={() => void copyInstructions()}
                  copyState={copyState}
                  onOpenDocs={openIngestHelp}
                  onCreateBatch={createBatch}
                />
              )
            ) : effectiveBoard ? null : !currentItem ? (
              <WorkbenchQueueState
                kind={filteredEmpty ? "filter-empty" : "queue-done"}
                processedCount={processedCount}
                onResetFilters={resetFilters}
                onOpenHandoff={openHandoff}
                onSwitchToAll={switchToAll}
              />
            ) : currentItem.type === "image" ? (
              <ImageViewerWorkspace
                currentItem={currentItem}
                batchImageItems={batchImageItems}
                hideCollectionNavigation={!!returnScope}
                onOpenCollection={() => { setActiveBoard(drilledFromBoard ?? scopeForItem(currentItem.id)); setDrilledFromBoard(null); }}
                selectedIds={controller.selectedIds}
                onSelectItem={controller.selectItem}
                onUpdateImageAnnotations={controller.updateImageAnnotations}
                onSaveImageRepair={controller.saveImageRepair}
                onCommitDecision={(decision, ids, options) => commit(decision, ids, options?.reason)}
                issuePanelWidth={issueW.value}
                onStartResizeIssuePanel={issueW.onHandlePointerDown}
              />
            ) : currentItem.type === "model3d" ? (
              <ModelViewerWorkspace
                key={`${currentItem.id}:${currentItem.version}`}
                item={currentItem}
                save={controller.saveModelObservation}
              />
            ) : currentItem.type === "text" ? (
              <TextCorpusWorkspace
                currentItem={currentItem}
                singleItem
                batchTextItems={[currentItem]}
                selectedIds={[]}
                onSelectItem={controller.selectItem}
                onSaveTextRevision={controller.saveTextRevision}
                onAddRangeComment={controller.addRangeComment}
                onConfirmDuplicate={controller.confirmDuplicate}
              />
            ) : currentItem.type === "data" ? (
              <DataCleaningWorkspace
                currentItem={currentItem}
                onUpdateDataCells={controller.updateDataCells}
                onMarkDataRework={controller.markDataRework}
                onClearDataRework={controller.clearDataRework}
              />
            ) : (
              <VideoFrameWorkspace
                item={currentItem}
                batchVideoItems={batchVideoItems}
                ensureItemsLoaded={controller.ensureItemsLoaded}
                openMediaUrl={controller.openMediaUrl}
                onUpdateVideoMarkers={controller.updateVideoMarkers}
                issuePanelWidth={issueW.value}
                onStartResizeIssuePanel={issueW.onHandlePointerDown}
              />
            )}
          </div>

          <SimpleBottomDetailsTimeline
            currentItem={effectiveBoard ? null : currentItem}
            canUndo={controller.canUndo}
            canRedo={controller.canRedo}
            selectedIds={effectiveBoard ? decisionTargets : undefined}
            onSelectItemById={(itemId) => handleSelectItemFromTree(itemId)}
            onCommitDecision={commit}
            onSkipNext={() => navigate(1)}
            onUndoLast={() => report(controller.undoLast())}
            onRedoLast={() => report(controller.redoLast())}
            onAddUserTag={(itemId, tag) => report(controller.addUserTag(itemId, tag))}
          />
        </div>
      </div>

      {exportScope && exportTarget && <ReviewExportDialog target={exportTarget.target} revision={exportScope.revision!}
        selectedIds={exportScope.items.map(item => item.id)} initialScope="selected" scopeName={exportScope.title}
        filter={{ batchId: controller.activeBatch?.id, type: controller.typeFilter, query: controller.searchQuery }}
        onClose={() => setExportScope(null)} />}
      {operation && <ToolcraftDialog isOpen width={480} onOpenChange={open => { if (!open && !busy) setOperation(null); }}>
        <ToolcraftDialogHeader title={operation.action === "rework" ? (operation.scope.items.length === 1 ? "返工说明" : "批量返工") : "覆盖本组审核结论"} />
        <form className="space-y-3 p-4 text-sm" data-workbench-modal="true" onSubmit={event => {
          event.preventDefault();
          if (busy || (operation.action === "rework" && !reason.trim())) return;
          if (operation.revision !== exportTarget?.revision) { setOperationError("内容已更新，请关闭后重新选择操作范围。"); return; }
          void runCollectionAction(operation.action, operation.scope, reason.trim());
        }}>
          <p>{operation.scope.title} · {operation.scope.items.length} 项 · 当前版本</p>
          {operation.action === "rework" ? <label className="block">共同修改要求（保留已有圈注）
            <textarea autoFocus value={reason} onChange={event => setReason(event.target.value)}
              onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}
              className="mt-2 min-h-24 w-full rounded border border-border bg-bg-2 p-2" />
          </label> : <p>将全部设为{operation.action === "keep-all" ? "保留" : "丢弃"}，包括已有结论的条目。操作后可以整体撤销。</p>}
          {operationError && <p role="alert" className="text-status-error">{operationError}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className={wbButton.secondary} disabled={busy} onClick={() => setOperation(null)}>取消</button>
            <button type="submit" className={wbButton.primary} disabled={busy || (operation.action === "rework" && !reason.trim())}>确认{operation.action === "rework" ? "返工" : "覆盖"}</button>
          </div>
        </form>
      </ToolcraftDialog>}
      <VisualMindMapModal
        isOpen={controller.isMindMapModalOpen}
        onClose={controller.closeMindMapModal}
        batch={controller.activeBatch}
        items={batchItems}
        currentItemId={currentItem?.id ?? null}
        onSelectAndFocusItem={(itemId) => handleSelectItemFromTree(itemId)}
        onNodSingleItem={(item) =>
          item.agentGuidance
            ? report(controller.commitDecision(item.agentGuidance.nodDecision, [item.id]))
            : Promise.resolve({ ok: false, code: "NO_GUIDANCE", message: "该条目没有 Agent 建议" })
        }
        onNodEntireGroup={(items) =>
          report(controller.commitBranchNod(items), "整枝确认已执行")
        }
      />

      <HandoffDialogWrapper
        controller={controller}
        batchItems={batchItems}
        preparing={loading}
        onPublish={(itemIds) =>
          report(controller.publishHandoff(itemIds), "已发布交接快照,等待 Agent 读取")
        }
      />
      <CreateWorkbenchBatchDialog
        isOpen={createBatchOpen}
        onOpenChange={setCreateBatchOpen}
        assets={controller.mediaAssets}
        onOpenMediaLibrary={openMediaLibrary}
        onCreate={async (input) => {
          const result = await controller.createBatchFromMedia(input);
          if (result.ok) showToast("已创建本地批次，等待审阅");
          return result;
        }}
      />
    </div>
    </CollectionInteractionContext.Provider>
  );
}

function HandoffDialogWrapper({
  controller,
  batchItems,
  onPublish,
  preparing,
}: {
  controller: ReturnType<typeof useWorkbenchController>;
  batchItems: ReturnType<typeof useWorkbenchController>["batchItems"];
  onPublish: (itemIds?: readonly string[]) => Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  preparing?: boolean;
}): JSX.Element | null {
  const open = useWorkbenchUiStore((s) => s.handoffDialogOpen);
  const setOpen = useWorkbenchUiStore((s) => s.setHandoffDialogOpen);
  if (!controller.activeBatch) return null;
  return (
    <HandoffDialog
      isOpen={open}
      onOpenChange={setOpen}
      batch={controller.activeBatch}
      batchItems={batchItems}
      handoffs={controller.handoffs}
      onPublishHandoff={onPublish}
      preparing={preparing}
    />
  );
}

export default WorkbenchPage;
