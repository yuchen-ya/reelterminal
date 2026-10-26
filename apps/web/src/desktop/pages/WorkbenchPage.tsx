import { ModelViewerWorkspace } from "../workbench/components/ModelViewerWorkspace";
import "../workbench/workbench.css";
import type { JSX, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronUp, LayoutGrid, PanelLeftOpen } from "lucide-react";
import type { WorkbenchDecision } from "@reelterminal/core";
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
import { useWorkbenchUiStore } from "../../stores/workbench-ui-store";
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
}: {
  controller: WorkbenchController;
  independent?: boolean;
  onImport?: () => void;
  emptyContent?: ReactNode;
  loading?: boolean;
  paginationFooter?: ReactNode;
}): JSX.Element {
  const leftCollapsed = useWorkbenchUiStore((s) => s.leftCollapsed);
  const ui = useWorkbenchUiStore.getState;
  const [treeFilter, setTreeFilter] = useState<LineageTreeFilter>("all");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [activeBoard, setActiveBoard] = useState<SelectedBoardScope | null>(null);
  const [drilledFromBoard, setDrilledFromBoard] =
    useState<SelectedBoardScope | null>(null);

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
  }, [controller.activeBatch?.id]);

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

  const effectiveBoard =
    activeBoard ?? (drilledFromBoard ? null : currentBoardParentScope);

  const effectiveBoardItems = useMemo(() => {
    if (!effectiveBoard) return [];
    const idSet = new Set(effectiveBoard.itemIds);
    return batchItems.filter((item) => idSet.has(item.id));
  }, [batchItems, effectiveBoard]);

  const handleSelectItemFromTree = useCallback(
    (itemId: string, modifiers?: SelectModifiers) => {
      setActiveBoard(null);
      setDrilledFromBoard(null);
      controller.selectItem(itemId, modifiers);
    },
    [controller],
  );

  const handleSelectBoard = useCallback((board: SelectedBoardScope) => {
    setDrilledFromBoard(null);
    setActiveBoard(board);
  }, []);

  const handleDrillIntoBoardItem = useCallback(
    (itemId: string) => {
      if (effectiveBoard) {
        setDrilledFromBoard(effectiveBoard);
      }
      setActiveBoard(null);
      controller.selectItem(itemId);
    },
    [controller, effectiveBoard],
  );

  // Keyboard routing: decision shortcuts only when a list/canvas area owns the focus.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (loading) return;
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
        const targetIds = controller.selectedIds.filter((id) =>
          controller.visibleItemIds.includes(id),
        );
        const targets =
          targetIds.length > 0
            ? targetIds
            : currentItem
              ? [currentItem.id]
              : undefined;
        if (!targets) return;
        void report(controller.commitDecision(decision, targets));
      } else if (key === "j" || key === "ArrowDown") {
        if (isTextEntry(target)) return;
        event.preventDefault();
        setActiveBoard(null);
        controller.skipNext();
      } else if (key === "k" || key === "ArrowUp") {
        event.preventDefault();
        setActiveBoard(null);
        controller.skipPrev();
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
  }, [controller, currentItem, independent, loading, report, showToast]);

  const batchTextItems = useMemo(
    () => batchItems.filter((item) => item.type === "text"),
    [batchItems],
  );
  const batchImageItems = useMemo(
    () => batchItems.filter((item) => item.type === "image"),
    [batchItems],
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
        <div className="pointer-events-none fixed top-14 left-1/2 z-[var(--z-toast)] -translate-x-1/2 rounded-xl border border-accent/50 bg-bg-2 px-4 py-2 text-xs text-fg shadow-2xl">
          {toast}
        </div>
      )}

      {/* Main 1px divider panel layout */}
      <div className="flex min-h-0 flex-1 overflow-hidden bg-bg">
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
                  setActiveBoard(null);
                  controller.skipPrev();
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
                  setActiveBoard(null);
                  controller.skipNext();
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
                onCreateBatch={createBatch}
                onCollapse={() => ui().setLeftCollapsed(true)}
                onOpenHandoff={() => ui().setHandoffDialogOpen(true)}
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
          {drilledFromBoard && !effectiveBoard && (
            <div
              className="flex h-7 shrink-0 items-center justify-between border-b border-border bg-bg-1 px-3 text-[11px]"
              data-testid="board-drilldown-breadcrumb"
            >
              <button
                type="button"
                onClick={() => {
                  setActiveBoard(drilledFromBoard);
                  setDrilledFromBoard(null);
                }}
                className="inline-flex items-center gap-1.5 font-medium text-accent hover:underline"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                <LayoutGrid className="h-3.5 w-3.5" />
                <span>返回聚合画板：{drilledFromBoard.title}</span>
              </button>
              <span className="text-fg-3">
                当前单节点精修：{currentItem?.agentGuidance?.nodeSlotLabel ?? currentItem?.title}
              </span>
            </div>
          )}

          <div className="relative min-h-0 flex-1 overflow-hidden" data-testid="workbench-content">
            {!hasBatch ? (
              emptyContent ?? (
                <WorkbenchStartPanel
                  onCopy={() => void copyInstructions()}
                  copyState={copyState}
                  onOpenDocs={openIngestHelp}
                  onCreateBatch={createBatch}
                />
              )
            ) : effectiveBoard && effectiveBoardItems.length > 0 ? (
              <AdaptiveBoardWorkspace
                boardTitle={effectiveBoard.title}
                items={effectiveBoardItems}
                currentItem={currentItem}
                selectedIds={controller.selectedIds}
                onSelectItem={controller.selectItem}
                onOpenChildItem={handleDrillIntoBoardItem}
                onCommitDecision={(decision, targetIds) =>
                  report(
                    controller.commitDecision(decision, targetIds),
                    `已对画板执行决定:${decision}`,
                  )
                }
                ensureItemsLoaded={controller.ensureItemsLoaded}
                openMediaUrl={controller.openMediaUrl}
              />
            ) : !currentItem ? (
              <WorkbenchQueueState
                kind={filteredEmpty ? "filter-empty" : "queue-done"}
                processedCount={processedCount}
                onResetFilters={resetFilters}
                onOpenHandoff={() => ui().setHandoffDialogOpen(true)}
                onSwitchToAll={switchToAll}
              />
            ) : currentItem.type === "image" ? (
              <ImageViewerWorkspace
                currentItem={currentItem}
                batchImageItems={batchImageItems}
                selectedIds={controller.selectedIds}
                onSelectItem={controller.selectItem}
                onUpdateImageAnnotations={controller.updateImageAnnotations}
                onSaveImageRepair={controller.saveImageRepair}
                onCommitDecision={controller.commitDecision}
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
                batchTextItems={batchTextItems}
                selectedIds={controller.selectedIds}
                onSelectItem={controller.selectItem}
                onSaveTextRevision={controller.saveTextRevision}
                onAddRangeComment={controller.addRangeComment}
                onConfirmDuplicate={controller.confirmDuplicate}
                onCommitDecision={controller.commitDecision}
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
            currentItem={currentItem}
            canUndo={controller.canUndo}
            canRedo={controller.canRedo}
            selectedIds={controller.selectedIds}
            onSelectItemById={(itemId) => handleSelectItemFromTree(itemId)}
            onCommitDecision={(decision, targetIds) =>
              report(
                controller.commitDecision(decision, targetIds),
                `已执行决定:${decision}`,
              )
            }
            onSkipNext={controller.skipNext}
            onUndoLast={() => report(controller.undoLast())}
            onRedoLast={() => report(controller.redoLast())}
            onAddUserTag={(itemId, tag) => report(controller.addUserTag(itemId, tag))}
          />
        </div>
      </div>

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
