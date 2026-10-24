import { ModelViewerWorkspace } from "../workbench/components/ModelViewerWorkspace";
import "../workbench/workbench.css";
import type { JSX, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  ClipboardCopy,
  FolderKanban,
  Inbox,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
} from "lucide-react";
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
import { PendingLineagePanel, type LineageTreeFilter } from "../workbench/components/PendingLineagePanel";
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
      className="group flex w-1.5 shrink-0 cursor-col-resize items-center justify-center rounded-full transition-colors hover:bg-accent/40"
    >
      <div className="h-10 w-0.5 rounded-full bg-border-strong group-hover:bg-accent" />
    </div>
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
      className="group flex h-1.5 shrink-0 cursor-row-resize items-center justify-center rounded-full transition-colors hover:bg-accent/40"
    >
      <div className="w-10 h-0.5 rounded-full bg-border-strong group-hover:bg-accent" />
    </div>
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
 * Exact, copyable Agent ingress instructions. The verb/argument names mirror
 * the real facade schemas (`workbench.ingest`, `media.import`) — this is a
 * documentation aid, not an executable shortcut, and it never contains a
 * token or enables write access by itself.
 */
const AGENT_INGEST_INSTRUCTIONS = `1) 导入真实媒体（图片/视频需先进入本项目素材库）
   reelctl call media.import --path "<本地文件路径>" --idempotency-key "<唯一键>"

2) 提交审阅批次
   reelctl call workbench.ingest --batchId "<批次ID>" --name "<批次名>" --items '<items JSON>'
   items JSON 形如：
   [
     {"id":"img-1","title":"图片条目","type":"image",
      "content":{"type":"image","mediaId":"<media.import 返回的 mediaId>"}},
     {"id":"vid-1","title":"视频条目","type":"video",
      "content":{"type":"video","mediaId":"<mediaId>","durationSec":12.5}},
     {"id":"txt-1","title":"语料条目","type":"text",
      "content":{"type":"text","entryId":"entry-1","title":"语料条目",
                 "speakerOrContext":"旁白","text":"正文…"}},
     {"id":"data-1","title":"数据表","type":"data",
      "content":{"type":"data","datasetId":"ds-1",
                 "columns":[{"columnId":"c1","title":"列"}],
                 "rows":[{"rowId":"r1","cells":{"c1":"值"}}],
                 "proposals":[]}}
   ]

3) 查看批次
   reelctl call workbench.get --batchId "<批次ID>"`;

function WorkbenchStartPanel({
  onCopy,
  copyState,
  onOpenDocs,
  onCreateBatch,
}: {
  onCopy: () => void;
  copyState: "idle" | "copied" | "failed";
  onOpenDocs: () => void;
  onCreateBatch: () => void;
}): JSX.Element {
  return (
    <div
      className="flex h-full items-center justify-center overflow-y-auto bg-stage-bg p-6"
      data-testid="workbench-start-panel"
    >
      <div className="w-full max-w-xl space-y-4 rounded-2xl border border-border bg-bg-1 p-5">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-fg">导入一批素材，或让 Agent 提交待审内容</h2>
          <p className="text-xs leading-relaxed text-fg-2">
            工作台显示本项目已接收的审阅批次。批次到达后，待审节点会出现在左侧队列，
            中间是当前素材的查看器与问题栏，底部是节点详情与决定按钮。
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onCreateBatch}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-xs font-semibold text-accent-foreground transition-colors hover:bg-accent-strong"
            data-testid="workbench-create-batch"
          >
            <Plus className="h-3.5 w-3.5" />
            从项目素材创建批次
          </button>
          <button
            type="button"
            onClick={onCopy}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-bg-2 px-3.5 py-1.5 text-xs font-medium text-fg-2 transition-colors hover:text-fg"
            data-testid="workbench-copy-ingest"
          >
            {copyState === "copied" ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <ClipboardCopy className="h-3.5 w-3.5" />
            )}
            {copyState === "copied" ? "已复制接入说明" : "复制接入说明"}
          </button>
          <button
            type="button"
            onClick={onOpenDocs}
            className="rounded-lg border border-border bg-bg-2 px-3 py-1.5 text-xs text-fg-2 transition-colors hover:text-fg"
            data-testid="workbench-ingest-help"
          >
            查看接入命令
          </button>
          {copyState === "failed" && (
            <span className="text-[11px] text-status-warning">
              复制失败，请展开下方命令手动复制
            </span>
          )}
        </div>

        <details className="rounded-xl border border-border bg-bg px-3 py-2" data-testid="workbench-ingest-help-panel">
          <summary className="cursor-pointer text-[11px] font-medium text-fg-2">
            Agent 接入说明（需已开启本项目 Agent 访问；不会自动开启写权限或发送消息）
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-fg-2">
            {AGENT_INGEST_INSTRUCTIONS}
          </pre>
        </details>

        <p className="text-[11px] leading-relaxed text-fg-3">
          演示素材不会写入正式项目；视觉验收使用隔离测试项目，并通过真实导入/ingest
          路径建立批次。
        </p>
      </div>
    </div>
  );
}

function WorkbenchQueueState({
  kind,
  processedCount,
  onResetFilters,
  onOpenHandoff,
  onSwitchToAll,
}: {
  kind: "filter-empty" | "queue-done";
  processedCount: number;
  onResetFilters: () => void;
  onOpenHandoff: () => void;
  onSwitchToAll: () => void;
}): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-stage-bg p-8 text-center">
      {kind === "filter-empty" ? (
        <>
          <p className="text-sm font-semibold text-fg" data-testid="workbench-filter-empty">
            当前筛选范围内没有条目
          </p>
          <p className="max-w-md text-xs leading-relaxed text-fg-2">
            批次里仍有其他类型的节点。清除搜索或切换类型筛选即可继续审阅。
          </p>
          <button
            type="button"
            onClick={onResetFilters}
            className="rounded-lg border border-border bg-bg-2 px-3.5 py-1.5 text-xs text-fg-2 transition-colors hover:text-fg"
          >
            重置筛选
          </button>
        </>
      ) : (
        <>
          <p className="text-sm font-semibold text-fg" data-testid="workbench-queue-done">
            当前队列已全部处理
          </p>
          <p className="max-w-md text-xs leading-relaxed text-fg-2">
            已处理 {processedCount} 项。可交回本轮决策，或切换到左侧「全部」查看并取回已处理节点。
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onOpenHandoff}
              className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-accent-foreground transition-colors hover:bg-accent-strong"
            >
              查看并交回本轮决策 ({processedCount})
            </button>
            <button
              type="button"
              onClick={onSwitchToAll}
              className="rounded-lg border border-border bg-bg-2 px-3 py-2 text-xs text-fg-2 transition-colors hover:text-fg"
            >
              查看已处理
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Workbench page: the single functional container for the AI material
 * workbench. It owns the layout (resizable panels via useResizable with
 * workbench-specific storage keys), keyboard routing, and assembles the
 * migrated prototype components. All state flows through
 * useWorkbenchController — this page holds no content state of its own.
 *
 * Layout restored to the prototype hierarchy: the workspace is always
 * mounted; the centre card holds the type-specific viewer (which renders the
 * in-canvas issue panel for image/video) and the bottom details dock that
 * spans the full centre width. There is no permanent right-hand review
 * column — processed items/retrieval live in the left queue's status switch.
 */
export function WorkbenchPage(): JSX.Element {
  const controller = useWorkbenchController();
  return <WorkbenchPanel controller={controller} />;
}

export function WorkbenchPanel({ controller, independent = false, onImport, emptyContent, loading = false }: {
  controller: WorkbenchController; independent?: boolean; onImport?: () => void; emptyContent?: ReactNode; loading?: boolean;
}): JSX.Element {
  const { t } = useTranslation();
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
  const createBatch = () => onImport ? onImport() : setCreateBatchOpen(true);
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
  const processedCount = batchItems.length - batchItems.filter((i) => i.status === "pending").length;
  const hasBatch = controller.batches.length > 0;

  // Keyboard routing: decision shortcuts only when a list/canvas area owns the
  // focus. Text entry, dialogs and the video player keep their own keys
  // (space = play/pause inside the player is handled by the player itself).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (loading) return;
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (independent && !target?.closest("[data-review-content-scope]")) return;
      if (isTextEntry(target)) return;
      // Any open dialog owns the keyboard.
      if (document.querySelector("[data-workbench-modal='true']")) return;
      const inPlayer = !!target?.closest("[data-workbench-player='true']");
      const key = event.key;
      if (key === " " && inPlayer) return; // player: space plays/pauses
      if (key === "1" || key === "2" || key === "3" || key === "4") {
        if (inPlayer) return;
        if (controller.selectionCount === 0 && !currentItem) return;
        if (key === "2") {
          // "modified" is only reachable through saving a real content
          // revision — a bare shortcut must not fake it.
          event.preventDefault();
          showToast("“已修改”需先保存实际内容修订(文字/数据/修补),不能用快捷键直接标记");
          return;
        }
        const decision: WorkbenchDecision = key === "1" ? "kept" : key === "3" ? "rework" : "discarded";
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
        // Shift+Z is redo, matching the host shortcut registry.
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

  // Tree panel's status scope (pending / all / rework chains) narrows within
  // the controller-visible set; selection still flows through the controller.
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

  const filterTabs: Array<{ id: typeof controller.typeFilter; label: string }> = [
    { id: "all", label: `全部 (${batchItems.length})` },
    { id: "image", label: `图片 (${batchItems.filter((i) => i.type === "image").length})` },
    { id: "text", label: `语料 (${batchItems.filter((i) => i.type === "text").length})` },
    { id: "data", label: `数据表 (${batchItems.filter((i) => i.type === "data").length})` },
    ...(independent ? [{ id: "model3d" as const, label: `3D 模型 (${batchItems.filter(i => i.type === "model3d").length})` }] : []),
    { id: "video", label: `视频 (${batchItems.filter((i) => i.type === "video").length})` },
  ];

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
    <div className="relative flex h-full min-h-0 flex-col bg-bg text-fg" data-testid="workbench-page" data-workbench-scope="true" data-review-content-scope={independent ? "true" : undefined} tabIndex={-1}>
      {/* Agent access / live status (shared with the editor shell) */}
      {!independent && <div className="h-9 shrink-0 border-b border-border bg-bg-1">
        <CollabStatusBar />
      </div>}
      {/* Batch toolbar */}
      <div className="flex h-11 shrink-0 items-center justify-between gap-4 overflow-x-auto border-b border-border bg-bg-1 px-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex items-center gap-1.5 whitespace-nowrap text-xs text-fg-2">
            <FolderKanban className="h-3.5 w-3.5 text-accent" />
            <select
              value={controller.activeBatch?.id ?? ""}
              onChange={(event) => controller.setActiveBatchId(event.target.value)}
              disabled={!hasBatch}
              className="rounded-lg border border-border-strong bg-bg-2 px-2.5 py-1 text-xs font-semibold text-fg focus:border-accent focus:outline-none disabled:opacity-50"
              aria-label={t(independent ? "review.batchName" : "desktop.workspace.workbench")}
            >
              {!hasBatch && <option value="">暂无批次</option>}
              {controller.batches.map((batch) => (
                <option key={batch.id} value={batch.id}>
                  {batch.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={createBatch}
              className="flex items-center gap-1 whitespace-nowrap rounded-lg border border-border bg-bg-2 px-2 py-1 text-xs font-medium text-fg-2 transition-colors hover:text-fg"
              title={independent ? "导入图片、视频、文本或数据" : "从项目素材库选择图片/视频创建本地批次"}
              data-testid="workbench-new-batch"
            >
              <Plus className="h-3.5 w-3.5" />
              {independent ? "导入内容" : "新建批次"}
            </button>
          </div>
          {controller.activeBatch && (
            <div className="hidden items-center gap-2 whitespace-nowrap rounded-lg border border-border bg-bg px-2.5 py-1 text-xs lg:flex">
              <span className="text-fg-2">
                已处理 <strong className="text-fg">{processedCount}</strong> / {batchItems.length}
              </span>
              <div className="h-1.5 w-20 overflow-hidden rounded-full bg-bg-3">
                <div
                  style={{
                    width: `${(processedCount / Math.max(1, batchItems.length)) * 100}%`,
                  }}
                  className="h-full bg-accent transition-all duration-200"
                />
              </div>
              <span className="text-accent">待处理 {controller.activeBatch.pendingCount}</span>
            </div>
          )}
        </div>

        <div className="flex items-center rounded-lg border border-border bg-bg p-0.5">
          {filterTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => controller.setTypeFilter(tab.id)}
              disabled={!hasBatch}
              className={`whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-40 ${
                controller.typeFilter === tab.id
                  ? "bg-bg-3 text-fg shadow-sm"
                  : "text-fg-3 hover:text-fg-2"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => controller.setAutoAdvance(!controller.autoAdvance)}
            disabled={!hasBatch}
            className={`whitespace-nowrap rounded-lg border px-2.5 py-1 text-xs transition-colors disabled:opacity-40 ${
              controller.autoAdvance
                ? "border-accent/50 bg-accent/10 text-accent"
                : "border-border bg-bg-2 text-fg-3"
            }`}
          >
            自动下一项: {controller.autoAdvance ? "开" : "关"}
          </button>
          <button
            type="button"
            onClick={controller.openMindMapModal}
            disabled={!hasBatch}
            title={hasBatch ? "打开全景血缘导图" : "暂无批次，无可定位的节点"}
            className="flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-border bg-bg-2 px-2.5 py-1 text-xs text-fg-2 transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Network className="h-3.5 w-3.5 text-accent" />
            全景血缘导图
          </button>
          <button
            type="button"
            onClick={() => ui().setHandoffDialogOpen(true)}
            disabled={processedCount === 0}
            title={processedCount === 0 ? "还没有可发布的已处理条目" : "交回本轮已处理决策"}
            className="whitespace-nowrap rounded-lg bg-accent px-3.5 py-1.5 text-xs font-semibold text-accent-foreground transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40"
          >
            交回本轮决策 ({processedCount})
          </button>
        </div>
      </div>

      {toast && (
        <div className="pointer-events-none fixed top-14 left-1/2 z-[var(--z-toast)] -translate-x-1/2 rounded-xl border border-accent/50 bg-bg-2 px-4 py-2 text-xs text-fg shadow-2xl">
          {toast}
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-1 overflow-hidden bg-bg p-2">
        {/* Left: lineage tree / processed switch — always mounted */}
        {leftCollapsed ? (
          <div className="flex w-11 shrink-0 flex-col items-center gap-3 rounded-xl border border-border bg-bg-1 py-2.5">
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
              className="relative flex shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-bg-1"
              data-testid="workbench-tree-panel"
            >
              {hasBatch ? (
                <PendingLineagePanel
                  items={treeItems}
                  filterCounts={treeFilterCounts}
                  filterMode={treeFilter}
                  onFilterModeChange={setTreeFilter}
                  currentItem={currentItem}
                  selectedIds={controller.selectedIds}
                  searchQuery={controller.searchQuery}
                  onSearchChange={controller.setSearchQuery}
                  onSelectItem={controller.selectItem}
                  onRetrieveItem={(itemId) =>
                    report(controller.retrieveToPending(itemId), "已取回至待审状态")
                  }
                  onOpen2DMindMapModal={controller.openMindMapModal}
                />
              ) : (
                <div
                  className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center"
                  data-testid="workbench-tree-empty"
                >
                  <Inbox className="h-5 w-5 text-fg-3" />
                  <p className="text-xs font-medium text-fg-2">暂无待处理条目</p>
                  <p className="text-[11px] leading-relaxed text-fg-3">
                    批次到达后，待审节点会出现在这里；已处理节点可在「全部」中取回。
                  </p>
                </div>
              )}
              <button
                type="button"
                onClick={() => ui().setLeftCollapsed(true)}
                className="absolute right-2.5 bottom-2.5 rounded-lg border border-border-strong bg-bg-2 p-1.5 text-fg-3 hover:text-fg"
                title="折叠侧栏"
              >
                <PanelLeftClose className="h-3.5 w-3.5" />
              </button>
            </div>
            <ColumnHandle onPointerDown={treeW.onHandlePointerDown} title="拖拽调整队列宽度" />
          </>
        )}

        {/* Centre card: viewer (with issue panel for image/video) + bottom dock */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-bg-1">
          <div className="relative min-h-0 flex-1 overflow-hidden" data-testid="workbench-content">
            {!hasBatch ? (
              emptyContent ?? <WorkbenchStartPanel
                onCopy={() => void copyInstructions()}
                copyState={copyState}
                onOpenDocs={openIngestHelp}
                onCreateBatch={createBatch}
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
              <ModelViewerWorkspace key={`${currentItem.id}:${currentItem.version}`} item={currentItem} save={controller.saveModelObservation} />
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

/**
 * HandoffDialog lives open-state in the UI store so the toolbar and the empty
 * state can both open it; state changes must not remount the page.
 */
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
