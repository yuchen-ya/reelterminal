import { ModelViewerWorkspace } from "../workbench/components/ModelViewerWorkspace";
import "../workbench/workbench.css";
import type { JSX, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelLeftOpen } from "lucide-react";
import type { WorkbenchDecision } from "@reelterminal/core";
import {
  LEGACY_LS_WORKBENCH_BOTTOM_HEIGHT,
  LEGACY_LS_WORKBENCH_ISSUE_WIDTH,
  LEGACY_LS_WORKBENCH_TREE_WIDTH,
} from "../../services/legacy-storage-keys";
import { useResizable } from "../editor/useResizable";
import { CollabStatusBar } from "../editor/CollabStatusBar";
import { useWorkbenchController } from "../workbench/useWorkbenchController";
import type { WorkbenchController, WorkbenchItemView } from "../workbench/types";
import { useWorkbenchUiStore } from "../../stores/workbench-ui-store";
import { TextCorpusWorkspace } from "../workbench/components/TextCorpusWorkspace";
import { DataCleaningWorkspace } from "../workbench/components/DataCleaningWorkspace";
import { ImageViewerWorkspace } from "../workbench/components/ImageViewerWorkspace";
import { VideoFrameWorkspace } from "../workbench/components/VideoFrameWorkspace";
import type { LineageTreeFilter } from "../workbench/components/PendingLineagePanel";
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

function RowHandle({
  onPointerDown,
  title,
}: {
  onPointerDown: (event: React.PointerEvent) => void;
  title: string;
}): JSX.Element {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      title={title}
      onPointerDown={onPointerDown}
      className="-mt-0.5 h-1 shrink-0 cursor-row-resize select-none transition-colors hover:bg-accent/50 z-10"
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
  const bottomCollapsed = useWorkbenchUiStore((s) => s.bottomCollapsed);
  const ui = useWorkbenchUiStore.getState;
  const [treeFilter, setTreeFilter] = useState<LineageTreeFilter>("all");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  const treeW = useResizable({
    initial: 280,
    min: 240,
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
  const bottomH = useResizable({
    initial: 138,
    min: 115,
    max: 340,
    axis: "y",
    direction: -1,
    storageKey: LEGACY_LS_WORKBENCH_BOTTOM_HEIGHT,
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
        controller.skipNext();
      } else if (key === "k" || key === "ArrowUp") {
        event.preventDefault();
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
          <div className="flex w-10 shrink-0 flex-col items-center gap-2 border-r border-border bg-bg-1 py-2.5">
            <button
              type="button"
              onClick={() => ui().setLeftCollapsed(false)}
              className="rounded-lg bg-bg-2 p-1.5 text-accent hover:bg-bg-3"
              title="展开上游血缘树"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
            <span className="text-[11px] font-bold text-accent">{pendingItems.length}</span>
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
                onUpdateVideoMarkers={controller.updateVideoMarkers}
                issuePanelWidth={issueW.value}
                onStartResizeIssuePanel={issueW.onHandlePointerDown}
              />
            )}
          </div>

          {!bottomCollapsed && (
            <RowHandle onPointerDown={bottomH.onHandlePointerDown} title="拖拽调整底部详情高度" />
          )}

          <SimpleBottomDetailsTimeline
            currentItem={currentItem}
            heightPx={bottomH.value}
            collapsed={bottomCollapsed}
            canUndo={controller.canUndo}
            canRedo={controller.canRedo}
            selectedIds={controller.selectedIds}
            onToggleCollapse={() => ui().setBottomCollapsed(!bottomCollapsed)}
            onSelectItemById={(itemId) => controller.selectItem(itemId)}
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
        onSelectAndFocusItem={(itemId) => controller.selectItem(itemId)}
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
