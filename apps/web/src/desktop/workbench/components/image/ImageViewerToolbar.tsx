import type { JSX, ReactNode } from "react";
import {
  ArrowUpRight,
  Brush,
  Columns2,
  Eraser,
  Eye,
  LayoutGrid,
  Maximize2,
  Move,
  Pin,
  Pipette,
  RotateCcw,
  Search,
  Square,
  Trash2,
  Type,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { ImageDisplayMode, WorkbenchImageRepairView } from "../../types";
import { wbButton } from "../../wb-button";
import type { AnnotateTool, CanvasWorkMode, RepairTool } from "./image-canvas-utils";

export type RepairBaseChoice = "latest" | "source";

export interface ImageViewerToolbarProps {
  readonly leadingSlot?: ReactNode;
  readonly trailingSlot?: ReactNode;
  readonly hideCollectionNavigation?: boolean;
  readonly viewMode: "grid" | "zoom";
  readonly setViewMode: (mode: "grid" | "zoom") => void;
  readonly batchImageItemsCount: number;
  readonly showCompareSplit: boolean;
  readonly setShowCompareSplit: (updater: (prev: boolean) => boolean) => void;
  readonly pinnedRefId: string | null;
  readonly setPinnedRefId: (updater: (prev: string | null) => string | null) => void;
  readonly currentItemId: string;
  readonly workMode: CanvasWorkMode;
  readonly setWorkMode: (mode: CanvasWorkMode) => void;
  readonly annotationsCount: number;
  readonly draftStrokesCount: number;
  readonly annotateTool: AnnotateTool;
  readonly setAnnotateTool: (tool: AnnotateTool) => void;
  readonly onClearAnnotations: () => Promise<void>;
  readonly repair?: WorkbenchImageRepairView;
  readonly repairBase: RepairBaseChoice;
  readonly setRepairBase: (updater: (prev: RepairBaseChoice) => RepairBaseChoice) => void;
  readonly repairTool: RepairTool;
  readonly setRepairTool: (tool: RepairTool) => void;
  readonly brushColor: string;
  readonly setBrushColor: (color: string) => void;
  readonly onUndoStroke: () => void;
  readonly onSaveRepair: () => Promise<void>;
  readonly savingRepair: boolean;
  readonly repairReady: boolean;
  readonly displayMode: ImageDisplayMode;
  readonly setDisplayMode: (mode: ImageDisplayMode) => void;
  readonly holdOriginal: boolean;
  readonly setHoldOriginal: (val: boolean) => void;
  readonly zoom: number;
  readonly stepZoom: (delta: number) => void;
  readonly onResetZoom?: () => void;
  readonly loupeEnabled?: boolean;
  readonly onToggleLoupe?: () => void;
}

export function ImageViewerToolbar({
  leadingSlot,
  trailingSlot,
  hideCollectionNavigation = false,
  viewMode,
  setViewMode,
  batchImageItemsCount,
  showCompareSplit,
  setShowCompareSplit,
  pinnedRefId,
  setPinnedRefId,
  currentItemId,
  workMode,
  setWorkMode,
  annotationsCount,
  draftStrokesCount,
  annotateTool,
  setAnnotateTool,
  onClearAnnotations,
  repair,
  repairBase,
  setRepairBase,
  repairTool,
  setRepairTool,
  brushColor,
  setBrushColor,
  onUndoStroke,
  onSaveRepair,
  savingRepair,
  repairReady,
  displayMode,
  setDisplayMode,
  holdOriginal,
  setHoldOriginal,
  zoom,
  stepZoom,
  onResetZoom,
  loupeEnabled = false,
  onToggleLoupe,
}: ImageViewerToolbarProps): JSX.Element {
  const toolButton = (active: boolean, activeColorClass: string) =>
    `inline-flex h-6 items-center justify-center gap-1 px-1.5 whitespace-nowrap rounded-[4px] text-xs transition-colors ${
      active
        ? `${activeColorClass} font-semibold shadow-sm`
        : "text-fg-3 hover:bg-bg-2 hover:text-fg"
    }`;

  return (
    <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-bg-1 px-2.5 py-1" data-testid="image-toolbar">
      {/* Left: Drilldown breadcrumb + View switcher + compare */}
      <div className="flex items-center gap-1">
        {leadingSlot}
        {!hideCollectionNavigation && <div className={wbButton.segmentedContainer}>
          <button
            type="button"
            onClick={() => setViewMode("grid")}
            className={wbButton.segmentedItem(viewMode === "grid")}
            aria-pressed={viewMode === "grid"}
            title={`返回当前集合 (${batchImageItemsCount})，点击选择，双击放大查看`}
          >
            <LayoutGrid className="h-3.5 w-3.5" />
            <span className="ml-1 font-mono text-[11px]">{batchImageItemsCount}</span>
            <span className="sr-only">返回集合 ({batchImageItemsCount})</span>
          </button>
          <button
            type="button"
            onClick={() => setViewMode("zoom")}
            className={wbButton.segmentedItem(viewMode === "zoom")}
            aria-pressed={viewMode === "zoom"}
            title="查看大图"
          >
            <Maximize2 className="h-3.5 w-3.5" />
            <span className="sr-only">查看大图</span>
          </button>
        </div>}

        {viewMode === "zoom" && (
          <>
            {(leadingSlot || !hideCollectionNavigation) && (
              <div className="mx-0.5 h-3.5 w-px bg-border" />
            )}
            <button
              type="button"
              onClick={() =>
                setPinnedRefId((prev) => (prev === currentItemId ? null : currentItemId))
              }
              aria-pressed={pinnedRefId === currentItemId}
              title={pinnedRefId === currentItemId ? "取消参考图" : "固定当前图片作为参考图"}
              className={`inline-flex h-6 w-6 items-center justify-center rounded-[5px] border transition-colors ${
                pinnedRefId === currentItemId
                  ? "border-status-warning/40 bg-status-warning/15 text-status-warning"
                  : "border-border bg-bg-2 text-fg-3 hover:text-fg"
              }`}
            >
              <Pin className="h-3 w-3" />
              <span className="sr-only">
                {pinnedRefId === currentItemId ? "取消参考图" : "设为参考图"}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setShowCompareSplit((prev) => !prev)}
              disabled={!pinnedRefId}
              aria-pressed={showCompareSplit}
              title={pinnedRefId ? "在左侧并排对比参考图" : "先将一张图片设为参考图"}
              className={`inline-flex h-6 w-6 items-center justify-center rounded-[5px] border transition-colors disabled:opacity-35 ${
                showCompareSplit
                  ? "border-accent/40 bg-accent/15 text-accent"
                  : "border-border bg-bg-2 text-fg-3 hover:text-fg"
              }`}
            >
              <Columns2 className="h-3.5 w-3.5" />
              <span className="sr-only">对比参考图</span>
            </button>
          </>
        )}
      </div>

      {/* Center: Work Mode Switcher + tool groups (inline on the same row) */}
      {viewMode === "zoom" && (
        <div className="flex flex-wrap items-center gap-1.5">
          <div className={wbButton.segmentedContainer}>
            <button
              type="button"
              onClick={() => setWorkMode("navigate")}
              className={wbButton.segmentedItem(workMode === "navigate")}
              data-testid="image-mode-navigate"
              aria-pressed={workMode === "navigate"}
              title="拖动画面"
            >
              <Move className="h-3.5 w-3.5" />
              <span className="sr-only">拖动画面</span>
            </button>
            <button
              type="button"
              onClick={() => setWorkMode("annotate")}
              data-testid="image-mode-annotate"
              aria-pressed={workMode === "annotate"}
              title={`标记问题 (${annotationsCount})`}
              className={`${wbButton.segmentedItem(workMode === "annotate")} gap-1`}
            >
              <Square className="h-3.5 w-3.5" />
              {annotationsCount > 0 && (
                <span className="font-mono text-[10px]">{annotationsCount}</span>
              )}
              <span className="sr-only">标记问题 ({annotationsCount})</span>
            </button>
            <button
              type="button"
              onClick={() => setWorkMode("repair")}
              data-testid="image-mode-repair"
              aria-pressed={workMode === "repair"}
              title={`画笔修补 (${draftStrokesCount})`}
              className={`${wbButton.segmentedItem(workMode === "repair")} gap-1`}
            >
              <Brush className="h-3.5 w-3.5" />
              {draftStrokesCount > 0 && (
                <span className="font-mono text-[10px]">{draftStrokesCount}</span>
              )}
              <span className="sr-only">画笔修补 ({draftStrokesCount})</span>
            </button>
          </div>

          {workMode === "annotate" && (
            <div className="flex h-6 items-center gap-0.5 rounded-[5px] border border-border bg-bg-2 p-0.5">
              <button
                type="button"
                onClick={() => setAnnotateTool("box")}
                className={toolButton(annotateTool === "box", "bg-bg-3 text-fg")}
                title="矩形框选位置"
              >
                <Square className="h-3 w-3" />
                <span className="sr-only">方框</span>
              </button>
              <button
                type="button"
                onClick={() => setAnnotateTool("arrow")}
                className={toolButton(annotateTool === "arrow", "bg-bg-3 text-fg")}
                title="箭头指向问题"
              >
                <ArrowUpRight className="h-3 w-3" />
                <span className="sr-only">箭头</span>
              </button>
              <button
                type="button"
                onClick={() => setAnnotateTool("text")}
                className={toolButton(annotateTool === "text", "bg-bg-3 text-fg")}
                title="点击锚定问题点"
              >
                <Type className="h-3 w-3" />
                <span className="sr-only">标记点</span>
              </button>
              {annotationsCount > 0 && (
                <button
                  type="button"
                  onClick={() => void onClearAnnotations()}
                  className="inline-flex h-5 w-5 items-center justify-center rounded text-fg-3 transition-colors hover:text-status-error"
                  title="清空全部圈注"
                >
                  <Trash2 className="h-3 w-3" />
                  <span className="sr-only">清空</span>
                </button>
              )}
            </div>
          )}

          {workMode === "repair" && (
            <div className="flex flex-wrap items-center gap-1 rounded-[5px] border border-border bg-bg-2 px-1.5 py-0.5">
              <span
                className="whitespace-nowrap font-mono text-[10px] text-fg-3"
                data-testid="repair-base-label"
              >
                底图：{repairBase === "latest" && repair ? `已保存修补 v${repair.producedVersion}` : "原图"}
              </span>
              {repair && (
                <button
                  type="button"
                  onClick={() =>
                    setRepairBase((prev) => (prev === "latest" ? "source" : "latest"))
                  }
                  className="whitespace-nowrap rounded border border-border bg-bg-1 px-1.5 py-0.5 text-[10px] text-fg-2 hover:text-fg"
                  title="切换修补底图；保存会记录本次基线，不会把旧基线再叠加一次"
                  data-testid="repair-base-toggle"
                >
                  {repairBase === "latest" ? "从原图重新修补" : "使用已保存修补"}
                </button>
              )}
              <span className="mx-0.5 h-3.5 w-px bg-border" />
              <button
                type="button"
                onClick={() => setRepairTool("eyedropper")}
                className={toolButton(repairTool === "eyedropper", "bg-bg-3 text-fg")}
                title="取色(吸取画面颜色作为画笔色)"
              >
                <Pipette className="h-3 w-3" />
                <span className="sr-only">取色</span>
              </button>
              <button
                type="button"
                onClick={() => setRepairTool("brush")}
                className={toolButton(repairTool === "brush", "bg-bg-3 text-fg")}
                title="修补画笔"
              >
                <Brush className="h-3 w-3" />
                <span className="sr-only">画笔</span>
              </button>
              <button
                type="button"
                onClick={() => setRepairTool("eraser")}
                className={toolButton(repairTool === "eraser", "bg-bg-3 text-fg")}
                title="橡皮擦(仅擦除修补层)"
              >
                <Eraser className="h-3 w-3" />
                <span className="sr-only">橡皮擦</span>
              </button>
              <input
                type="color"
                value={brushColor}
                onChange={(e) => setBrushColor(e.target.value)}
                className="h-4 w-4 cursor-pointer rounded border-0 bg-transparent p-0"
                title="画笔颜色"
              />
              <button
                type="button"
                onClick={onUndoStroke}
                disabled={draftStrokesCount === 0}
                className="inline-flex h-5 w-5 items-center justify-center rounded text-fg-3 transition-colors hover:text-fg disabled:opacity-30"
                title="撤销上一笔(未提交草稿)"
              >
                <RotateCcw className="h-3 w-3" />
                <span className="sr-only">撤销一笔</span>
              </button>
              <button
                type="button"
                onClick={() => void onSaveRepair()}
                disabled={draftStrokesCount === 0 || savingRepair}
                className="inline-flex h-5 items-center justify-center rounded-[4px] bg-accent px-2 text-[11px] font-medium text-accent-fg transition-colors hover:brightness-110 disabled:opacity-40"
              >
                {savingRepair ? "保存中…" : `保存修补(${draftStrokesCount} 笔)`}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Right: Hold-to-Compare, Local Magnifier Loupe, Zoom & Trailing actions */}
      <div className="ml-auto flex items-center gap-1">
        {viewMode === "zoom" && (
          <>
            {repair && (
              <div className={wbButton.segmentedContainer}>
                <button
                  type="button"
                  onClick={() => setDisplayMode("original")}
                  className={wbButton.segmentedItem(displayMode === "original")}
                  data-testid="image-display-original"
                >
                  原图
                  <span className="sr-only">查看原图</span>
                </button>
                <button
                  type="button"
                  onClick={() => setDisplayMode("repaired")}
                  disabled={!repairReady}
                  className={wbButton.segmentedItem(displayMode === "repaired")}
                  data-testid="image-display-repaired"
                >
                  修补
                  <span className="sr-only">查看修补</span>
                </button>
              </div>
            )}
            {repair && (
              <button
                type="button"
                onPointerDown={() => setHoldOriginal(true)}
                onPointerUp={() => setHoldOriginal(false)}
                onPointerLeave={() => setHoldOriginal(false)}
                onPointerCancel={() => setHoldOriginal(false)}
                className={holdOriginal ? wbButton.primary : wbButton.ghost}
                title="按住临时查看真原图（无笔画/无修补）"
              >
                <Eye className="h-3.5 w-3.5" />
                <span className="sr-only">按住看原图</span>
              </button>
            )}
            {onToggleLoupe && (
              <button
                type="button"
                onClick={onToggleLoupe}
                aria-pressed={loupeEnabled}
                data-testid="image-loupe-toggle"
                title="局部放大镜 (悬停画面 3x 放大细节)"
                className={`inline-flex h-6 w-6 items-center justify-center rounded-[5px] border transition-colors ${
                  loupeEnabled
                    ? "border-accent/60 bg-accent/15 text-accent"
                    : "border-border bg-bg-2 text-fg-3 hover:text-fg"
                }`}
              >
                <Search className="h-3.5 w-3.5" />
                <span className="sr-only">局部放大镜</span>
              </button>
            )}
            <div className="flex h-6 items-center rounded-[5px] border border-border bg-bg-2 px-0.5">
              <button
                type="button"
                onClick={() => stepZoom(-20)}
                className="p-0.5 text-fg-3 hover:text-fg"
                title="缩小 (支持滚轮缩放)"
              >
                <ZoomOut className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={onResetZoom}
                className="px-1 font-mono text-[11px] tabular-nums text-fg-2 hover:text-accent"
                title="点击重置 100% (支持滚轮缩放)"
              >
                {zoom}%
              </button>
              <button
                type="button"
                onClick={() => stepZoom(20)}
                className="p-0.5 text-fg-3 hover:text-fg"
                title="放大 (支持滚轮缩放)"
              >
                <ZoomIn className="h-3 w-3" />
              </button>
            </div>
          </>
        )}
        {trailingSlot && (
          <>
            <div className="mx-0.5 h-3.5 w-px bg-border" />
            {trailingSlot}
          </>
        )}
      </div>
    </div>
  );
}
