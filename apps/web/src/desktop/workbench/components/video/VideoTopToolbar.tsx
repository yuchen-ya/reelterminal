import { useTranslation } from "react-i18next";
import type { JSX, ReactNode } from "react";
import {
  ArrowUpRight,
  Columns2,
  Hand,
  Pin,
  RotateCcw,
  Search,
  Square,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { wbButton } from "../../wb-button";

export interface VideoCompareCandidate {
  readonly id: string;
  readonly title: string;
}

export interface VideoTopToolbarProps {
  readonly leadingSlot?: ReactNode;
  readonly resolution?: string;
  readonly durationLabel: string;
  readonly version: number;
  readonly drawTool: "box" | "arrow" | "pan";
  readonly onSelectDrawTool: (tool: "box" | "arrow" | "pan") => void;
  readonly videoReady: boolean;
  readonly zoom?: number;
  readonly onStepZoom?: (delta: number) => void;
  readonly onResetZoom?: () => void;
  readonly loupeEnabled?: boolean;
  readonly onToggleLoupe?: () => void;
  /** Video comparison controls */
  readonly compareCandidates?: readonly VideoCompareCandidate[];
  readonly compareTargetId?: string | null;
  readonly onSelectCompareTarget?: (id: string | null) => void;
  readonly showCompareSplit?: boolean;
  readonly onToggleCompareSplit?: () => void;
  readonly isPinnedRef?: boolean;
  readonly onTogglePinCurrent?: () => void;
}

export function VideoTopToolbar({
  leadingSlot,
  resolution,
  durationLabel,
  version,
  drawTool,
  onSelectDrawTool,
  videoReady,
  zoom = 100,
  onStepZoom,
  onResetZoom,
  loupeEnabled = false,
  onToggleLoupe,
  compareCandidates = [],
  compareTargetId = null,
  onSelectCompareTarget,
  showCompareSplit = false,
  onToggleCompareSplit,
  isPinnedRef = false,
  onTogglePinCurrent,
}: VideoTopToolbarProps): JSX.Element {
  const { t } = useTranslation();
  const hasCompareOptions = compareCandidates.length > 0;

  return (
    <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border bg-bg-1 px-2.5 select-none">
      <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-fg-3">
        {leadingSlot && (
          <>
            <div className="font-sans">{leadingSlot}</div>
            <span className="mx-0.5 h-3.5 w-px bg-border" />
          </>
        )}
        <span className="text-fg-2">{resolution ?? "—"}</span>
        <span>·</span>
        <span>{durationLabel}</span>
        <span>·</span>
        <span>v{version}</span>

        {/* Video side-by-side comparison controls */}
        {(onTogglePinCurrent || onToggleCompareSplit) && (
          <>
            <span className="mx-0.5 h-3.5 w-px bg-border" />
            {onTogglePinCurrent && (
              <button
                type="button"
                onClick={onTogglePinCurrent}
                aria-pressed={isPinnedRef}
                data-testid="video-pin-reference"
                title={
                  isPinnedRef
                    ? t("This video is pinned as the comparison baseline (click to clear)")
                    : t("Pin this video as a baseline, then open another video for side-by-side comparison")
                }
                className={`inline-flex h-6 items-center gap-1 rounded-[5px] border px-1.5 font-sans text-[11px] transition-colors ${
                  isPinnedRef
                    ? "border-status-warning/50 bg-status-warning/15 text-status-warning"
                    : "border-border bg-bg-2 text-fg-3 hover:text-fg"
                }`}
              >
                <Pin className="h-3 w-3" />
                <span className="hidden sm:inline">
                  {isPinnedRef ? t("Baseline pinned") : t("Pin as baseline")}
                </span>
              </button>
            )}

            {onToggleCompareSplit && (
              <button
                type="button"
                onClick={onToggleCompareSplit}
                disabled={!hasCompareOptions && !compareTargetId}
                aria-pressed={showCompareSplit}
                data-testid="video-compare-toggle"
                title={
                  hasCompareOptions
                    ? t("Toggle synchronized side-by-side videos (shared playback and frame controls)")
                    : t("No other video in this batch is available for comparison")
                }
                className={`inline-flex h-6 items-center gap-1 rounded-[5px] border px-1.5 font-sans text-[11px] transition-colors disabled:opacity-40 ${
                  showCompareSplit
                    ? "border-accent/60 bg-accent/15 text-accent font-medium"
                    : "border-border bg-bg-2 text-fg-3 hover:text-fg"
                }`}
              >
                <Columns2 className="h-3 w-3" />
                <span>{t("Side-by-side comparison")}</span>
              </button>
            )}

            {showCompareSplit && hasCompareOptions && onSelectCompareTarget && (
              <select
                value={compareTargetId ?? ""}
                onChange={(e) => onSelectCompareTarget(e.target.value || null)}
                aria-label={t("Choose comparison video")}
                data-testid="video-compare-select"
                className="h-6 max-w-[160px] truncate rounded-[5px] border border-border bg-bg-2 px-1.5 font-sans text-[11px] text-fg focus:border-accent focus:outline-none"
              >
                {compareCandidates.map((cand) => (
                  <option key={cand.id} value={cand.id}>{t("Compare: {{v0}}", { v0: cand.title })}</option>
                ))}
              </select>
            )}
          </>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        <div className={wbButton.segmentedContainer}>
          <button
            type="button"
            onClick={() => onSelectDrawTool("box")}
            disabled={!videoReady}
            title={t("Mark the issue area")}
            aria-label={t("Mark the issue area")}
            className={`inline-flex h-6 w-6 items-center justify-center rounded-[4px] text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              drawTool === "box"
                ? "bg-bg-3 font-medium text-fg shadow-sm"
                : "text-fg-3 hover:text-fg-2"
            }`}
          >
            <Square className="h-3.5 w-3.5" />
            <span className="sr-only">{t("Mark the issue area")}</span>
          </button>
          <button
            type="button"
            onClick={() => onSelectDrawTool("arrow")}
            disabled={!videoReady}
            title={t("Point to the location")}
            aria-label={t("Point to the location")}
            className={`inline-flex h-6 w-6 items-center justify-center rounded-[4px] text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              drawTool === "arrow"
                ? "bg-bg-3 font-medium text-fg shadow-sm"
                : "text-fg-3 hover:text-fg-2"
            }`}
          >
            <ArrowUpRight className="h-3.5 w-3.5" />
            <span className="sr-only">{t("Point to the location")}</span>
          </button>
          <button
            type="button"
            onClick={() => onSelectDrawTool("pan")}
            disabled={!videoReady}
            title={t("Pan the view (middle-drag also works)")}
            aria-label={t("Pan the image")}
            className={`inline-flex h-6 w-6 items-center justify-center rounded-[4px] text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              drawTool === "pan"
                ? "bg-bg-3 font-medium text-fg shadow-sm"
                : "text-fg-3 hover:text-fg-2"
            }`}
          >
            <Hand className="h-3.5 w-3.5" />
            <span className="sr-only">{t("Pan the image")}</span>
          </button>
        </div>

        <div className="h-3.5 w-px bg-border" />

        {/* Local Magnifier Loupe & Zoom Controls */}
        {onToggleLoupe && (
          <button
            type="button"
            onClick={onToggleLoupe}
            disabled={!videoReady}
            aria-pressed={loupeEnabled}
            data-testid="video-loupe-toggle"
            title={t("Magnifier (hover for 3× detail)")}
            className={`inline-flex h-6 w-6 items-center justify-center rounded-[5px] border transition-colors disabled:opacity-40 ${
              loupeEnabled
                ? "border-accent/60 bg-accent/15 text-accent"
                : "border-border bg-bg-2 text-fg-3 hover:text-fg"
            }`}
          >
            <Search className="h-3.5 w-3.5" />
            <span className="sr-only">{t("Magnifier")}</span>
          </button>
        )}

        {onStepZoom && (
          <div className="flex h-6 items-center rounded-[5px] border border-border bg-bg-2 px-0.5">
            <button
              type="button"
              onClick={() => onStepZoom(-25)}
              disabled={!videoReady || zoom <= 100}
              className="p-0.5 text-fg-3 hover:text-fg disabled:opacity-30"
              title={t("Zoom out (mouse wheel supported)")}
            >
              <ZoomOut className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={onResetZoom}
              disabled={!videoReady}
              className="px-1 font-mono text-[11px] tabular-nums text-fg-2 hover:text-accent"
              title={t("Click to reset to 100% (scroll to zoom around the pointer)")}
            >
              {zoom}%
            </button>
            <button
              type="button"
              onClick={() => onStepZoom(25)}
              disabled={!videoReady || zoom >= 500}
              className="p-0.5 text-fg-3 hover:text-fg disabled:opacity-30"
              title={t("Zoom in (mouse wheel supported)")}
            >
              <ZoomIn className="h-3 w-3" />
            </button>
            {zoom !== 100 && onResetZoom && (
              <button
                type="button"
                onClick={onResetZoom}
                className="p-0.5 text-fg-3 hover:text-accent"
                title={t("Reset zoom and position")}
              >
                <RotateCcw className="h-3 w-3" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
