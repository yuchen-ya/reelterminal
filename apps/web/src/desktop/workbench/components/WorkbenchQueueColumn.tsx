import { useTranslation } from "react-i18next";
import { t as translate } from "../../../i18n";
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
  readonly paginated?: boolean;
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
  paginated = false,
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
  const { t } = useTranslation();
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
    { id: "all", label: translate("All ({{v0}})", { v0: typeCounts.all }), count: typeCounts.all },
    { id: "image", label: translate("Images ({{v0}})", { v0: typeCounts.image }), count: typeCounts.image },
    { id: "text", label: translate("Text ({{v0}})", { v0: typeCounts.text }), count: typeCounts.text },
    { id: "data", label: translate("Tables ({{v0}})", { v0: typeCounts.data }), count: typeCounts.data },
    ...(independent || typeCounts.model3d > 0
      ? [
          {
            id: "model3d" as const,
            label: translate("3D models ({{v0}})", { v0: typeCounts.model3d }),
            count: typeCounts.model3d,
          },
        ]
      : []),
    { id: "video", label: translate("Videos ({{v0}})", { v0: typeCounts.video }), count: typeCounts.video },
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
      {/* Batch scope stays visible; tools do not compete with its name. */}
      <div className="shrink-0 space-y-1.5 border-b border-border p-1.5">
        <div className="flex h-7 items-center justify-between px-1">
          <span className="text-xs font-semibold text-fg">{t("Review content")}</span>
          <button type="button" onClick={onCreateBatch} data-testid="workbench-new-batch" aria-label={independent ? t("Import content") : t("New batch")} className="inline-flex items-center gap-1 text-xs text-accent">
            <Plus className="h-3.5 w-3.5" />{independent ? t("review.import") : t("New batch")}
          </button>
        </div>
        <div className="flex items-center">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={!hasBatch}
                aria-label={t("Switch batch")}
                title={activeBatch?.name ?? t("No batches yet")}
                data-testid="workbench-batch-select"
                data-batch-id={activeBatch?.id}
                className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-bg-2 px-2 text-left text-xs font-semibold text-fg hover:bg-bg-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
              >
                <span className="min-w-0 flex-1 truncate">{activeBatch?.name ?? t("No batches yet")}</span>
                {controller.batches.some(batch => batch.isNew) && <span data-testid="workbench-batch-new" className="shrink-0 rounded bg-accent px-1 py-0.5 text-[10px] font-bold leading-none text-bg" title={t("A batch has unseen updates")}>{t("New updates")}</span>}
                <ChevronDown className="h-3 w-3 shrink-0 text-fg-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="w-72 max-w-[calc(100vw-24px)] border-border bg-bg-1 text-fg"
              data-testid="workbench-batch-menu"
            >
              <DropdownMenuLabel className="text-xs text-fg-2">{t("Content batches ({{v0}})", { v0: controller.batches.length })}</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={activeBatch?.id ?? ""} onValueChange={controller.setActiveBatchId}>
                {controller.batches.map((batch) => (
                  <DropdownMenuRadioItem
                    key={batch.id}
                    value={batch.id}
                    onSelect={() => controller.setActiveBatchId(batch.id)}
                    textValue={batch.name}
                    className="cursor-pointer whitespace-normal break-words py-1.5 text-xs focus:bg-bg-3 focus:text-fg data-[state=checked]:text-accent"
                  >
                    <span className="min-w-0 flex-1">{batch.name}</span>
                    {batch.isNew && <span className="ml-2 shrink-0 rounded bg-accent px-1 text-[10px] font-bold text-bg">{t("New updates")}</span>}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="flex h-7 items-center gap-1">
          <span className="min-w-0 flex-1 px-1 text-[11px] text-fg-3">{t("Groups and items")}</span>
          <button
            type="button"
            onClick={() => setFilterOpen((v) => !v)}
            disabled={!hasBatch}
            aria-expanded={showFilterDrawer}
            title={t("Filter and search items")}
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
            aria-label={t("Provenance overview")}
            title={hasBatch ? t("Open the provenance overview") : t("No batches or items to locate yet")}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-bg-2 text-fg-3 transition-colors hover:bg-bg-3 hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Network className="h-3.5 w-3.5" />
          </button>

          <button
            type="button"
            onClick={onCollapse}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-bg-2 text-fg-3 transition-colors hover:bg-bg-3 hover:text-fg"
            title={t("Collapse the sidebar")}
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
            >{t("All ({{v0}})", { v0: treeFilterCounts.all })}</button>
            <button
              type="button"
              onClick={() => onTreeFilterChange("pending")}
              className={`flex-1 rounded py-0.5 text-center text-[11px] font-medium transition-colors ${
                treeFilter === "pending"
                  ? "bg-bg-3 text-accent shadow-xs"
                  : "text-fg-3 hover:text-fg"
              }`}
            >{t("Pending ({{v0}})", { v0: treeFilterCounts.pending })}</button>
            <button
              type="button"
              onClick={() => onTreeFilterChange("rework_chain")}
              className={`flex-1 rounded py-0.5 text-center text-[11px] font-medium transition-colors ${
                treeFilter === "rework_chain"
                  ? "bg-status-warning/15 text-status-warning shadow-xs"
                  : "text-fg-3 hover:text-status-warning"
              }`}
            >{t("Rework ({{v0}})", { v0: treeFilterCounts.rework })}</button>
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
              placeholder={t("Filter items…")}
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
            allItems={controller.batchItems}
            paginated={paginated}
            filtered={independent && (controller.typeFilter !== "all" || controller.searchQuery.length > 0)}
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
            <p className="text-xs font-medium text-fg-2">{t("No pending items")}</p>
            <p className="text-[11px] leading-relaxed text-fg-3">{t("Pending items appear here when a batch arrives. Reopen processed items from All.")}</p>
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
            title={t("Processed {{v0}} / {{v1}} · Pending {{v2}}", { v0: processedCount, v1: batchItems.length, v2: activeBatch?.pendingCount ?? 0 })}
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
            title={t("Advance to the next item after a review decision ({{v0}})", { v0: controller.autoAdvance ? t("Enabled") : t("Disabled") })}
            aria-label={t("Auto-advance: {{v0}}", { v0: controller.autoAdvance ? t("On") : t("Off") })}
          >
            <FastForward className="h-3 w-3" />
            <span className="sr-only">{t("Auto-advance: {{v0}}", { v0: controller.autoAdvance ? t("On") : t("Off") })}</span>
          </button>

          <button
            type="button"
            onClick={onOpenHandoff}
            disabled={processedCount === 0}
            title={
              processedCount === 0
                ? t("No processed items are ready to publish")
                : t("Preview the processed results, then confirm publication for the Agent to read.")
            }
            className="flex h-7 flex-1 items-center justify-center gap-1 rounded-md bg-accent px-2 text-xs font-semibold text-accent-fg transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Send className="h-3 w-3 shrink-0" />
            <span className="truncate">{t("Publish ({{v0}})", { v0: processedCount })}</span>
            <span className="sr-only">{t("Publish review results ({{v0}})", { v0: processedCount })}</span>
          </button>
        </div>

        {paginationFooter}
      </div>
    </div>
  );
}
export default WorkbenchQueueColumn;
