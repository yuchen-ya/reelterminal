import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
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
            title={t("Return to the current collection ({{v0}}); click to select, double-click to enlarge", { v0: batchImageItemsCount })}
          >
            <LayoutGrid className="h-3.5 w-3.5" />
            <span className="ml-1 font-mono text-[11px]">{batchImageItemsCount}</span>
            <span className="sr-only">{t("Back to collection ({{v0}})", { v0: batchImageItemsCount })}</span>
          </button>
          <button
            type="button"
            onClick={() => setViewMode("zoom")}
            className={wbButton.segmentedItem(viewMode === "zoom")}
            aria-pressed={viewMode === "zoom"}
            title={t("View full image")}
          >
            <Maximize2 className="h-3.5 w-3.5" />
            <span className="sr-only">{t("View full image")}</span>
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
              title={pinnedRefId === currentItemId ? t("Clear reference image") : t("Pin the current image as a reference")}
              className={`inline-flex h-6 w-6 items-center justify-center rounded-[5px] border transition-colors ${
                pinnedRefId === currentItemId
                  ? "border-status-warning/40 bg-status-warning/15 text-status-warning"
                  : "border-border bg-bg-2 text-fg-3 hover:text-fg"
              }`}
            >
              <Pin className="h-3 w-3" />
              <span className="sr-only">
                {pinnedRefId === currentItemId ? t("Clear reference image") : t("Set as reference")}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setShowCompareSplit((prev) => !prev)}
              disabled={!pinnedRefId}
              aria-pressed={showCompareSplit}
              title={pinnedRefId ? t("Compare the reference image on the left") : t("Set an image as the reference first")}
              className={`inline-flex h-6 w-6 items-center justify-center rounded-[5px] border transition-colors disabled:opacity-35 ${
                showCompareSplit
                  ? "border-accent/40 bg-accent/15 text-accent"
                  : "border-border bg-bg-2 text-fg-3 hover:text-fg"
              }`}
            >
              <Columns2 className="h-3.5 w-3.5" />
              <span className="sr-only">{t("Compare reference")}</span>
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
              title={t("Pan the image")}
            >
              <Move className="h-3.5 w-3.5" />
              <span className="sr-only">{t("Pan the image")}</span>
            </button>
            <button
              type="button"
              onClick={() => setWorkMode("annotate")}
              data-testid="image-mode-annotate"
              aria-pressed={workMode === "annotate"}
              title={t("Mark issues ({{v0}})", { v0: annotationsCount })}
              className={`${wbButton.segmentedItem(workMode === "annotate")} gap-1`}
            >
              <Square className="h-3.5 w-3.5" />
              {annotationsCount > 0 && (
                <span className="font-mono text-[10px]">{annotationsCount}</span>
              )}
              <span className="sr-only">{t("Mark issues ({{v0}})", { v0: annotationsCount })}</span>
            </button>
            <button
              type="button"
              onClick={() => setWorkMode("repair")}
              data-testid="image-mode-repair"
              aria-pressed={workMode === "repair"}
              title={t("Brush repair ({{v0}})", { v0: draftStrokesCount })}
              className={`${wbButton.segmentedItem(workMode === "repair")} gap-1`}
            >
              <Brush className="h-3.5 w-3.5" />
              {draftStrokesCount > 0 && (
                <span className="font-mono text-[10px]">{draftStrokesCount}</span>
              )}
              <span className="sr-only">{t("Brush repair ({{v0}})", { v0: draftStrokesCount })}</span>
            </button>
          </div>

          {workMode === "annotate" && (
            <div className="flex h-6 items-center gap-0.5 rounded-[5px] border border-border bg-bg-2 p-0.5">
              <button
                type="button"
                onClick={() => setAnnotateTool("box")}
                className={toolButton(annotateTool === "box", "bg-bg-3 text-fg")}
                title={t("Mark a rectangular area")}
              >
                <Square className="h-3 w-3" />
                <span className="sr-only">{t("Box")}</span>
              </button>
              <button
                type="button"
                onClick={() => setAnnotateTool("arrow")}
                className={toolButton(annotateTool === "arrow", "bg-bg-3 text-fg")}
                title={t("Point an arrow at the issue")}
              >
                <ArrowUpRight className="h-3 w-3" />
                <span className="sr-only">{t("Arrow")}</span>
              </button>
              <button
                type="button"
                onClick={() => setAnnotateTool("text")}
                className={toolButton(annotateTool === "text", "bg-bg-3 text-fg")}
                title={t("Click to anchor an issue point")}
              >
                <Type className="h-3 w-3" />
                <span className="sr-only">{t("Markers")}</span>
              </button>
              {annotationsCount > 0 && (
                <button
                  type="button"
                  onClick={() => void onClearAnnotations()}
                  className="inline-flex h-5 w-5 items-center justify-center rounded text-fg-3 transition-colors hover:text-status-error"
                  title={t("Clear all annotations")}
                >
                  <Trash2 className="h-3 w-3" />
                  <span className="sr-only">{t("Clear")}</span>
                </button>
              )}
            </div>
          )}

          {workMode === "repair" && (
            <div className="flex flex-wrap items-center gap-1 rounded-[5px] border border-border bg-bg-2 px-1.5 py-0.5">
              <span
                className="whitespace-nowrap font-mono text-[10px] text-fg-3"
                data-testid="repair-base-label"
              >{t("Base image: {{v0}}", { v0: repairBase === "latest" && repair ? t("Saved repair v{{v0}}", { v0: repair.producedVersion }) : t("production.original") })}</span>
              {repair && (
                <button
                  type="button"
                  onClick={() =>
                    setRepairBase((prev) => (prev === "latest" ? "source" : "latest"))
                  }
                  className="whitespace-nowrap rounded border border-border bg-bg-1 px-1.5 py-0.5 text-[10px] text-fg-2 hover:text-fg"
                  title={t("Switch the repair base. Saving records this baseline without applying the old baseline again.")}
                  data-testid="repair-base-toggle"
                >
                  {repairBase === "latest" ? t("Start a repair from the original") : t("Use the saved repair")}
                </button>
              )}
              <span className="mx-0.5 h-3.5 w-px bg-border" />
              <button
                type="button"
                onClick={() => setRepairTool("eyedropper")}
                className={toolButton(repairTool === "eyedropper", "bg-bg-3 text-fg")}
                title={t("Pick a color from the image for the brush")}
              >
                <Pipette className="h-3 w-3" />
                <span className="sr-only">{t("Pick color")}</span>
              </button>
              <button
                type="button"
                onClick={() => setRepairTool("brush")}
                className={toolButton(repairTool === "brush", "bg-bg-3 text-fg")}
                title={t("Repair brush")}
              >
                <Brush className="h-3 w-3" />
                <span className="sr-only">{t("Brush")}</span>
              </button>
              <button
                type="button"
                onClick={() => setRepairTool("eraser")}
                className={toolButton(repairTool === "eraser", "bg-bg-3 text-fg")}
                title={t("Eraser (repair layer only)")}
              >
                <Eraser className="h-3 w-3" />
                <span className="sr-only">{t("Eraser")}</span>
              </button>
              <input
                type="color"
                value={brushColor}
                onChange={(e) => setBrushColor(e.target.value)}
                className="h-4 w-4 cursor-pointer rounded border-0 bg-transparent p-0"
                title={t("Brush color")}
              />
              <button
                type="button"
                onClick={onUndoStroke}
                disabled={draftStrokesCount === 0}
                className="inline-flex h-5 w-5 items-center justify-center rounded text-fg-3 transition-colors hover:text-fg disabled:opacity-30"
                title={t("Undo the last stroke (uncommitted draft)")}
              >
                <RotateCcw className="h-3 w-3" />
                <span className="sr-only">{t("Undo stroke")}</span>
              </button>
              <button
                type="button"
                onClick={() => void onSaveRepair()}
                disabled={draftStrokesCount === 0 || savingRepair}
                className="inline-flex h-5 items-center justify-center rounded-[4px] bg-accent px-2 text-[11px] font-medium text-accent-fg transition-colors hover:brightness-110 disabled:opacity-40"
              >
                {savingRepair ? t("settings.autoSaveSaving") : t("Save repair ({{v0}} strokes)", { v0: draftStrokesCount })}
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
                  {t("production.original")}<span className="sr-only">{t("View original")}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setDisplayMode("repaired")}
                  disabled={!repairReady}
                  className={wbButton.segmentedItem(displayMode === "repaired")}
                  data-testid="image-display-repaired"
                >
                  {t("Repair")}<span className="sr-only">{t("View repair")}</span>
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
                title={t("Hold to view the original without strokes or repairs")}
              >
                <Eye className="h-3.5 w-3.5" />
                <span className="sr-only">{t("Hold to view original")}</span>
              </button>
            )}
            {onToggleLoupe && (
              <button
                type="button"
                onClick={onToggleLoupe}
                aria-pressed={loupeEnabled}
                data-testid="image-loupe-toggle"
                title={t("Magnifier (hover for 3× detail)")}
                className={`inline-flex h-6 w-6 items-center justify-center rounded-[5px] border transition-colors ${
                  loupeEnabled
                    ? "border-accent/60 bg-accent/15 text-accent"
                    : "border-border bg-bg-2 text-fg-3 hover:text-fg"
                }`}
              >
                <Search className="h-3.5 w-3.5" />
                <span className="sr-only">{t("Magnifier")}</span>
              </button>
            )}
            <div className="flex h-6 items-center rounded-[5px] border border-border bg-bg-2 px-0.5">
              <button
                type="button"
                onClick={() => stepZoom(-20)}
                className="p-0.5 text-fg-3 hover:text-fg"
                title={t("Zoom out (mouse wheel supported)")}
              >
                <ZoomOut className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={onResetZoom}
                className="px-1 font-mono text-[11px] tabular-nums text-fg-2 hover:text-accent"
                title={t("Click to reset to 100% (mouse wheel supported)")}
              >
                {zoom}%
              </button>
              <button
                type="button"
                onClick={() => stepZoom(20)}
                className="p-0.5 text-fg-3 hover:text-fg"
                title={t("Zoom in (mouse wheel supported)")}
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
