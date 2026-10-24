import type { JSX } from "react";

export interface WorkbenchQueueStateProps {
  kind: "filter-empty" | "queue-done";
  processedCount: number;
  onResetFilters: () => void;
  onOpenHandoff: () => void;
  onSwitchToAll: () => void;
}

export function WorkbenchQueueState({
  kind,
  processedCount,
  onResetFilters,
  onOpenHandoff,
  onSwitchToAll,
}: WorkbenchQueueStateProps): JSX.Element {
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
