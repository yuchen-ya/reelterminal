import type { JSX, ReactNode } from "react";
import { useMemo, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
} from "@reelterminal/ui";
import {
  ChevronDown,
  FastForward,
  Inbox,
  ListFilter,
  Network,
  PanelLeftClose,
  Plus,
  Search,
  Send,
} from "lucide-react";
import type {
  SelectModifiers,
  WorkbenchController,
  WorkbenchItemView,
  WorkbenchMutationResult,
} from "../types";
import {
  PendingLineagePanel,
  type LineageTreeFilter,
  type SelectedBoardScope,
} from "./PendingLineagePanel";

export interface WorkbenchQueueColumnProps {
  readonly controller: WorkbenchController;
  readonly hasBatch: boolean;
  readonly independent?: boolean;
  readonly onCreateBatch: () => void;
  readonly onCollapse: () => void;
  readonly onOpenHandoff: () => void;
  readonly treeFilter: LineageTreeFilter;
  readonly onTreeFilterChange: (mode: LineageTreeFilter) => void;
  readonly treeFilterCounts: {
    readonly all: number;
    readonly pending: number;
    readonly rework: number;
  };
  readonly treeItems: readonly WorkbenchItemView[];
  readonly activeBoardId?: string | null;
  readonly onSelectBoard?: (board: SelectedBoardScope) => void;
  readonly onSelectItem?: (itemId: string, modifiers: SelectModifiers) => void;
  readonly paginationFooter?: ReactNode;
  readonly onRetrieveItem: (
    itemId: string,
  ) => void | Promise<WorkbenchMutationResult>;
}

export function WorkbenchQueueColumn({
  controller,
  hasBatch,
  independent = false,
  onCreateBatch,
  onCollapse,
  onOpenHandoff,
  treeFilter,
  onTreeFilterChange,
  treeFilterCounts,
  treeItems,
  activeBoardId,
  onSelectBoard,
  onSelectItem,
  paginationFooter,
  onRetrieveItem,
}: WorkbenchQueueColumnProps): JSX.Element {
  const { batchItems, activeBatch } = controller;
  const processedCount =
    batchItems.length - batchItems.filter((i) => i.status === "pending").length;

  const typeCounts = useMemo(
    () => ({
      all: batchItems.length,
      image: batchItems.filter((i) => i.type === "image").length,
      text: batchItems.filter((i) => i.type === "text").length,
      data: batchItems.filter((i) => i.type === "data").length,
      model3d: batchItems.filter((i) => i.type === "model3d").length,
      video: batchItems.filter((i) => i.type === "video").length,
    }),
    [batchItems],
  );

  const allFilterTabs: Array<{
    id: typeof controller.typeFilter;
    label: string;
    count: number;
  }> = [
    { id: "all", label: `全部 (${typeCounts.all})`, count: typeCounts.all },
    { id: "image", label: `图片 (${typeCounts.image})`, count: typeCounts.image },
    { id: "text", label: `语料 (${typeCounts.text})`, count: typeCounts.text },
    { id: "data", label: `数据表 (${typeCounts.data})`, count: typeCounts.data },
    ...(independent || typeCounts.model3d > 0
      ? [
          {
            id: "model3d" as const,
            label: `3D 模型 (${typeCounts.model3d})`,
            count: typeCounts.model3d,
          },
        ]
      : []),
    { id: "video", label: `视频 (${typeCounts.video})`, count: typeCounts.video },
  ];

  // Only render "all", types with count > 0, or the currently active filter type
  const visibleTabs = allFilterTabs.filter(
    (tab) => tab.id === "all" || tab.count > 0 || controller.typeFilter === tab.id,
  );

  const [filterOpen, setFilterOpen] = useState(false);
  const hasActiveFilter =
    treeFilter !== "all" ||
    controller.typeFilter !== "all" ||
    Boolean(controller.searchQuery);
  const showFilterDrawer = filterOpen || hasActiveFilter;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg-1">
      {/* Queue column top toolbar: 1 compact row + on-demand filter drawer */}
      <div className="shrink-0 space-y-1.5 border-b border-border p-1.5">
        <div className="flex h-7 items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={!hasBatch}
                aria-label="切换批次"
                title={activeBatch?.name ?? "暂无批次"}
                data-testid="workbench-batch-select"
                data-batch-id={activeBatch?.id}
                className="flex h-7 min-w-0 flex-1 items-center justify-between gap-1 rounded-md border border-border bg-bg-2 px-2 text-left text-xs font-semibold text-fg hover:bg-bg-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
              >
                <span className="min-w-0 truncate">{activeBatch?.name ?? "暂无批次"}</span>
                <ChevronDown className="h-3 w-3 shrink-0 text-fg-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="w-72 max-w-[calc(100vw-24px)] border-border bg-bg-1 text-fg"
              data-testid="workbench-batch-menu"
            >
              <DropdownMenuLabel className="text-xs text-fg-2">
                内容批次 ({controller.batches.length})
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup value={activeBatch?.id ?? ""} onValueChange={controller.setActiveBatchId}>
                {controller.batches.map((batch) => (
                  <DropdownMenuRadioItem
                    key={batch.id}
                    value={batch.id}
                    textValue={batch.name}
                    className="cursor-pointer whitespace-normal break-words py-1.5 text-xs focus:bg-bg-3 focus:text-fg data-[state=checked]:text-accent"
                  >
                    {batch.name}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <button
            type="button"
            onClick={() => setFilterOpen((v) => !v)}
            disabled={!hasBatch}
            aria-expanded={showFilterDrawer}
            title="筛选与检索条目"
            className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-colors disabled:opacity-40 ${
              hasActiveFilter
                ? "border-accent/50 bg-accent/15 text-accent"
                : "border-border bg-bg-2 text-fg-3 hover:bg-bg-3 hover:text-fg"
            }`}
          >
            <ListFilter className="h-3.5 w-3.5" />
          </button>

          <button
            type="button"
            onClick={controller.openMindMapModal}
            disabled={!hasBatch}
            aria-label="全景血缘导图"
            title={hasBatch ? "打开全景血缘导图" : "暂无批次，无可定位的节点"}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-bg-2 text-fg-3 transition-colors hover:bg-bg-3 hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Network className="h-3.5 w-3.5" />
          </button>

          <button
            type="button"
            onClick={onCreateBatch}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-bg-2 text-fg-2 transition-colors hover:bg-bg-3 hover:text-fg"
            title={
              independent
                ? "导入图片、视频、文本或数据"
                : "从项目素材库选择图片/视频创建本地批次"
            }
            aria-label={independent ? "导入内容" : "新建批次"}
            data-testid="workbench-new-batch"
          >
            <Plus className="h-3.5 w-3.5" />
            <span className="sr-only">{independent ? "导入内容" : "新建批次"}</span>
          </button>

          <button
            type="button"
            onClick={onCollapse}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-bg-2 text-fg-3 transition-colors hover:bg-bg-3 hover:text-fg"
            title="折叠侧栏"
          >
            <PanelLeftClose className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Collapsible filter + search drawer */}
        <div className={showFilterDrawer ? "space-y-1.5 pt-0.5" : "sr-only"}>
          <div className="flex items-center gap-0.5 rounded-md border border-border bg-bg p-0.5">
            <button
              type="button"
              onClick={() => onTreeFilterChange("all")}
              className={`flex-1 rounded py-0.5 text-center text-[11px] font-medium transition-colors ${
                treeFilter === "all"
                  ? "bg-bg-3 text-fg shadow-xs"
                  : "text-fg-3 hover:text-fg"
              }`}
            >
              全部 ({treeFilterCounts.all})
            </button>
            <button
              type="button"
              onClick={() => onTreeFilterChange("pending")}
              className={`flex-1 rounded py-0.5 text-center text-[11px] font-medium transition-colors ${
                treeFilter === "pending"
                  ? "bg-bg-3 text-accent shadow-xs"
                  : "text-fg-3 hover:text-fg"
              }`}
            >
              待审 ({treeFilterCounts.pending})
            </button>
            <button
              type="button"
              onClick={() => onTreeFilterChange("rework_chain")}
              className={`flex-1 rounded py-0.5 text-center text-[11px] font-medium transition-colors ${
                treeFilter === "rework_chain"
                  ? "bg-status-warning/15 text-status-warning shadow-xs"
                  : "text-fg-3 hover:text-status-warning"
              }`}
            >
              有返工 ({treeFilterCounts.rework})
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-1">
            {visibleTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => controller.setTypeFilter(tab.id)}
                disabled={!hasBatch}
                className={`rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-40 ${
                  controller.typeFilter === tab.id
                    ? "bg-accent/15 text-accent font-semibold"
                    : "bg-bg-2 text-fg-3 hover:bg-bg-3 hover:text-fg"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="relative flex items-center">
            <Search className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-fg-3" />
            <input
              type="text"
              value={controller.searchQuery}
              onChange={(e) => controller.setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="筛选条目..."
              className="w-full rounded-md border border-border bg-bg py-1 pl-7 pr-6 text-xs text-fg placeholder:text-fg-3 focus:border-accent focus:outline-none"
            />
            {controller.searchQuery && (
              <button
                type="button"
                onClick={() => controller.setSearchQuery("")}
                className="absolute right-2 text-xs text-fg-3 hover:text-fg"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Queue column middle: tree or empty state */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {hasBatch ? (
          <PendingLineagePanel
            items={treeItems}
            currentItem={controller.currentItem}
            selectedIds={controller.selectedIds}
            activeBoardId={activeBoardId}
            onSelectBoard={onSelectBoard}
            onSelectItem={onSelectItem ?? controller.selectItem}
            onRetrieveItem={onRetrieveItem}
          />
        ) : (
          <div
            className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center"
            data-testid="workbench-tree-empty"
          >
            <Inbox className="h-5 w-5 text-fg-3" />
            <p className="text-xs font-medium text-fg-2">暂无待处理条目</p>
            <p className="text-[11px] leading-relaxed text-fg-3">
              批次到达后，待审条目会出现在这里；已处理条目可在「全部」中取回。
            </p>
          </div>
        )}
      </div>

      {/* Queue column bottom: ultra-compact single-row footer */}
      <div className="shrink-0 space-y-1.5 border-t border-border bg-bg-1 p-2">
        <div className="h-1 w-full overflow-hidden rounded-full bg-bg-3">
          <div
            style={{
              width: `${(processedCount / Math.max(1, batchItems.length)) * 100}%`,
            }}
            className="h-full bg-accent transition-all duration-200"
          />
        </div>

        <div className="flex items-center justify-between gap-1.5">
          <span
            className="font-mono text-[11px] text-fg-2 tabular-nums"
            title={`已处理 ${processedCount} / ${batchItems.length} · 待处理 ${activeBatch?.pendingCount ?? 0}`}
          >
            <strong className="text-fg">{processedCount}</strong>/{batchItems.length}
          </span>

          <button
            type="button"
            onClick={() => controller.setAutoAdvance(!controller.autoAdvance)}
            disabled={!hasBatch}
            className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors disabled:opacity-40 ${
              controller.autoAdvance
                ? "border border-accent/40 bg-accent/10 text-accent"
                : "border border-border bg-bg-2 text-fg-3 hover:text-fg"
            }`}
            title={`审阅决定后自动跳转至下一项 (${controller.autoAdvance ? "已开启" : "已关闭"})`}
            aria-label={`自动下一项: ${controller.autoAdvance ? "开" : "关"}`}
          >
            <FastForward className="h-3 w-3" />
            <span className="sr-only">自动下一项: {controller.autoAdvance ? "开" : "关"}</span>
          </button>

          <button
            type="button"
            onClick={onOpenHandoff}
            disabled={processedCount === 0}
            title={
              processedCount === 0
                ? "还没有可发布的已处理条目"
                : "预览本轮已处理结果，确认后发布给 Agent 读取"
            }
            className="flex h-7 flex-1 items-center justify-center gap-1 rounded-md bg-accent px-2 text-xs font-semibold text-accent-fg transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Send className="h-3 w-3 shrink-0" />
            <span className="truncate">发布 ({processedCount})</span>
            <span className="sr-only">发布审阅结果 ({processedCount})</span>
          </button>
        </div>

        {paginationFooter}
      </div>
    </div>
  );
}
export default WorkbenchQueueColumn;
