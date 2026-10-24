import type { JSX } from "react";
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
}

export function ImageViewerToolbar({
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
}: ImageViewerToolbarProps): JSX.Element {
  const toolButton = (active: boolean, activeColorClass: string) =>
    `inline-flex h-7 w-7 items-center justify-center rounded-[5px] text-xs transition-colors ${
      active
        ? `${activeColorClass} font-semibold shadow-sm`
        : "text-fg-3 hover:bg-bg-2 hover:text-fg"
    }`;

  return (
    <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border bg-bg-1 px-3">
      {/* Left: View switcher + compare */}
      <div className="flex items-center gap-1.5">
        <div className={wbButton.segmentedContainer}>
          <button
            type="button"
            onClick={() => setViewMode("grid")}
            className={wbButton.segmentedItem(viewMode === "grid")}
          >
            <LayoutGrid className="mr-1 h-3.5 w-3.5" />
            网格筛选 ({batchImageItemsCount})
          </button>
          <button
            type="button"
            onClick={() => setViewMode("zoom")}
            className={wbButton.segmentedItem(viewMode === "zoom")}
          >
            <Maximize2 className="mr-1 h-3.5 w-3.5" />
            画板精审
          </button>
        </div>

        {viewMode === "zoom" && (
          <>
            <div className="mx-0.5 h-3.5 w-px bg-border" />
            <button
              type="button"
              onClick={() => setShowCompareSplit((prev) => !prev)}
              className={
                showCompareSplit
                  ? "inline-flex h-7 items-center justify-center gap-1.5 rounded-[6px] border border-accent/40 bg-accent/15 px-2.5 text-xs font-medium text-accent whitespace-nowrap transition-colors"
                  : wbButton.secondary
              }
            >
              <Columns2 className="h-3.5 w-3.5" />
              并排参考对比
            </button>
            <button
              type="button"
              onClick={() =>
                setPinnedRefId((prev) => (prev === currentItemId ? null : currentItemId))
              }
              className={
                pinnedRefId === currentItemId
                  ? "inline-flex h-7 items-center justify-center gap-1 rounded-[6px] border border-status-warning/40 bg-status-warning/15 px-2.5 text-xs font-medium text-status-warning whitespace-nowrap transition-colors"
                  : wbButton.ghost
              }
            >
              <Pin className="h-3 w-3" />
              {pinnedRefId === currentItemId ? "已设为参考图" : "固定为参考"}
            </button>
          </>
        )}
      </div>

      {/* Center: Work Mode Switcher + tool groups */}
      {viewMode === "zoom" && (
        <div className="flex items-center gap-1.5">
          <div className={wbButton.segmentedContainer}>
            <button
              type="button"
              onClick={() => setWorkMode("navigate")}
              className={wbButton.segmentedItem(workMode === "navigate")}
              data-testid="image-mode-navigate"
            >
              <Move className="mr-1 h-3.5 w-3.5" />
              平移查看
            </button>
            <button
              type="button"
              onClick={() => setWorkMode("annotate")}
              data-testid="image-mode-annotate"
              className={`${wbButton.segmentedItem(workMode === "annotate")} gap-1`}
            >
              <Square className="h-3.5 w-3.5" />
              Agent 问题圈注 ({annotationsCount})
              {annotationsCount > 0 && (
                <span className="h-1.5 w-1.5 rounded-full bg-status-warning" />
              )}
            </button>
            <button
              type="button"
              onClick={() => setWorkMode("repair")}
              data-testid="image-mode-repair"
              className={`${wbButton.segmentedItem(workMode === "repair")} gap-1`}
            >
              <Brush className="h-3.5 w-3.5" />
              像素轻修层 ({draftStrokesCount})
              {draftStrokesCount > 0 && (
                <span className="h-1.5 w-1.5 rounded-full bg-status-info" />
              )}
            </button>
          </div>

          {workMode === "annotate" && (
            <div className="flex h-7 items-center gap-0.5 rounded-[6px] border border-border bg-bg-2 p-0.5">
              <button
                type="button"
                onClick={() => setAnnotateTool("box")}
                className={toolButton(annotateTool === "box", "bg-bg-3 text-fg")}
                title="矩形框选位置"
              >
                <Square className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setAnnotateTool("arrow")}
                className={toolButton(annotateTool === "arrow", "bg-bg-3 text-fg")}
                title="箭头指向问题"
              >
                <ArrowUpRight className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setAnnotateTool("text")}
                className={toolButton(annotateTool === "text", "bg-bg-3 text-fg")}
                title="点击锚定问题点"
              >
                <Type className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => void onClearAnnotations()}
                disabled={annotationsCount === 0}
                className="inline-flex h-6 w-6 items-center justify-center rounded p-1 text-fg-3 transition-colors hover:text-status-error disabled:opacity-30"
                title="清空全部圈注"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {workMode === "repair" && (
            <div className="flex h-7 items-center gap-1 rounded-[6px] border border-border bg-bg-2 px-1.5">
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
                <Pipette className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setRepairTool("brush")}
                className={toolButton(repairTool === "brush", "bg-bg-3 text-fg")}
                title="修补画笔"
              >
                <Brush className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setRepairTool("eraser")}
                className={toolButton(repairTool === "eraser", "bg-bg-3 text-fg")}
                title="橡皮擦(仅擦除修补层)"
              >
                <Eraser className="h-3.5 w-3.5" />
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
                className="inline-flex h-6 w-6 items-center justify-center rounded text-fg-3 transition-colors hover:text-fg disabled:opacity-30"
                title="撤销上一笔(未提交草稿)"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => void onSaveRepair()}
                disabled={draftStrokesCount === 0 || savingRepair}
                className="inline-flex h-6 items-center justify-center rounded-[4px] bg-accent px-2 text-xs font-medium text-accent-fg transition-colors hover:brightness-110 disabled:opacity-40"
              >
                {savingRepair ? "提交中…" : `提交修补(${draftStrokesCount} 笔)`}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Right: Hold-to-Compare & Zoom */}
      <div className="flex items-center gap-1.5">
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
                  查看原图
                </button>
                <button
                  type="button"
                  onClick={() => setDisplayMode("repaired")}
                  disabled={!repairReady}
                  className={wbButton.segmentedItem(displayMode === "repaired")}
                  data-testid="image-display-repaired"
                >
                  查看修补
                </button>
              </div>
            )}
            <button
              type="button"
              onPointerDown={() => setHoldOriginal(true)}
              onPointerUp={() => setHoldOriginal(false)}
              onPointerLeave={() => setHoldOriginal(false)}
              onPointerCancel={() => setHoldOriginal(false)}
              className={holdOriginal ? wbButton.primary : wbButton.secondary}
              title={repair ? "按住临时查看真原图（无笔画/无修补）" : "暂无已保存修补，当前即原图"}
            >
              <Eye className="h-3.5 w-3.5" />
              按住看原图
            </button>
            <div className="flex h-7 items-center rounded-[6px] border border-border bg-bg-2 px-1">
              <button
                type="button"
                onClick={() => stepZoom(-20)}
                className="p-1 text-fg-3 hover:text-fg"
                title="缩小"
              >
                <ZoomOut className="h-3.5 w-3.5" />
              </button>
              <span className="px-1.5 font-mono text-xs tabular-nums text-fg-2">{zoom}%</span>
              <button
                type="button"
                onClick={() => stepZoom(20)}
                className="p-1 text-fg-3 hover:text-fg"
                title="放大"
              >
                <ZoomIn className="h-3.5 w-3.5" />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
