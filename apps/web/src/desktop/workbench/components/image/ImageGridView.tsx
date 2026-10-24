import type { JSX, MouseEvent as ReactMouseEvent } from "react";
import { Check, ImageOff } from "lucide-react";
import type { WorkbenchDecision } from "@reelterminal/core";
import type { WorkbenchItemView } from "../../types";
import { DECISION_STATUS_LABEL, STATUS_TEXT_CLASS } from "./image-canvas-utils";

export interface ImageGridViewProps {
  readonly batchImageItems: readonly WorkbenchItemView[];
  readonly currentItem: WorkbenchItemView;
  readonly selectedIds: readonly string[];
  readonly pinnedRefId: string | null;
  readonly selectedCount: number;
  readonly onCardSelect: (item: WorkbenchItemView, e: ReactMouseEvent) => void;
  readonly onCardOpen: (item: WorkbenchItemView) => void;
  readonly onCardDecision: (
    item: WorkbenchItemView,
    decision: WorkbenchDecision,
  ) => Promise<void>;
}

export function ImageGridView({
  batchImageItems,
  currentItem,
  selectedIds,
  pinnedRefId,
  selectedCount,
  onCardSelect,
  onCardOpen,
  onCardDecision,
}: ImageGridViewProps): JSX.Element {
  return (
    <div className="flex-1 overflow-y-auto bg-stage-bg p-4">
      <div className="mb-3 flex items-center justify-between text-xs text-fg-2">
        <span>
          网格批量筛选视图 · 单击选择，支持 <code className="text-fg">Ctrl/Cmd</code> 多选与{" "}
          <code className="text-fg">Shift</code> 连选；双击卡片进入精修画板
        </span>
        <span className="font-mono tabular-nums">
          当前图片集已选 {selectedCount} / {batchImageItems.length} 项
        </span>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {batchImageItems.map((item) => {
          const isSelected = selectedIds.includes(item.id);
          const isCurrent = currentItem.id === item.id;
          const isPinned = pinnedRefId === item.id;
          const thumbnail = item.imagePayload?.originalMedia.thumbnailUrl ?? null;
          const annotationCount = item.imagePayload?.annotations.length ?? 0;

          return (
            <div
              key={item.id}
              onClick={(e) => onCardSelect(item, e)}
              onDoubleClick={() => onCardOpen(item)}
              className={`group relative cursor-pointer overflow-hidden rounded-xl border bg-bg-1 transition-all ${
                isSelected
                  ? "border-accent shadow-glow"
                  : isCurrent
                    ? "border-border-strong"
                    : "border-border hover:border-border-strong"
              }`}
            >
              <div className="relative aspect-video w-full overflow-hidden bg-bg-2">
                {thumbnail ? (
                  <img
                    src={thumbnail}
                    alt={item.imagePayload?.originalMedia.displayName ?? item.title}
                    draggable={false}
                    className="h-full w-full select-none object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-fg-3">
                    <ImageOff className="h-5 w-5" />
                    <span className="text-[11px]">未提供缩略图</span>
                  </div>
                )}
                <div className="absolute left-2.5 top-2.5 flex items-center gap-1.5">
                  {item.imagePayload?.repair && (
                    <span className="rounded border border-status-info/40 bg-status-info/15 px-1 py-0.5 font-mono text-[10px] text-status-info">
                      已修补
                    </span>
                  )}
                  <div
                    className={`flex h-5 w-5 items-center justify-center rounded border font-mono text-xs ${
                      isSelected
                        ? "border-accent bg-accent font-bold text-accent-foreground"
                        : "border-white/25 bg-black/65 text-transparent group-hover:border-white/50"
                    }`}
                  >
                    <Check className="h-3.5 w-3.5" />
                  </div>
                  {isPinned && (
                    <span className="rounded border border-status-warning/30 bg-black/75 px-2 py-0.5 text-[11px] font-medium text-status-warning">
                      参考基准
                    </span>
                  )}
                </div>

                <div className="absolute right-2.5 top-2.5 flex items-center gap-1.5 rounded bg-black/75 px-2 py-0.5 text-[11px] text-fg-2">
                  <span className={STATUS_TEXT_CLASS[item.status]}>
                    {DECISION_STATUS_LABEL[item.status]}
                  </span>
                  {annotationCount > 0 && (
                    <>
                      <span>·</span>
                      <span className="text-status-warning">{annotationCount} 圈注</span>
                    </>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between gap-2 p-3">
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold text-fg">{item.title}</div>
                  <div className="mt-0.5 truncate text-[11px] text-fg-3">
                    {item.provenanceTags.map((tag) => `@${tag.shortName}`).join(" · ") ||
                      "无溯源标签"}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void onCardDecision(item, "kept");
                    }}
                    className="inline-flex h-6 items-center justify-center rounded-[4px] border border-accent/40 bg-accent/10 px-2 text-[11px] font-medium text-accent transition-colors hover:bg-accent/20"
                    title="保留此图片（仅此条目）"
                    data-testid="image-card-keep"
                  >
                    保留
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void onCardDecision(item, "discarded");
                    }}
                    className="inline-flex h-6 items-center justify-center rounded-[4px] border border-border bg-bg-2 px-2 text-[11px] text-fg-2 transition-colors hover:text-status-error"
                    title="丢弃此图片（只写本批状态，不删除源文件）"
                    data-testid="image-card-discard"
                  >
                    丢弃
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
