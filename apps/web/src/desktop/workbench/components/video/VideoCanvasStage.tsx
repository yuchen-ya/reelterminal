import type { JSX } from "react";
import type React from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import type {
  WorkbenchSpatialAnnotation,
  WorkbenchVideoMarker,
} from "@reelterminal/core";
import {
  DEFAULT_BOX_H,
  DEFAULT_BOX_W,
  type MarkerAnchorView,
  type NormalizedPoint,
} from "./video-helpers";

export interface VideoCanvasStageProps {
  readonly stageRef: React.RefObject<HTMLDivElement | null>;
  readonly videoRef: React.RefObject<HTMLVideoElement | null>;
  readonly videoUrl?: string | null;
  readonly mediaStatus: "ready" | "loading" | "error" | "unavailable";
  readonly mediaError?: string | null;
  readonly videoReady: boolean;
  readonly videoTime: number;
  readonly videoSize: { w: number; h: number } | null;
  readonly svgViewBox: string;
  readonly activeMarker: WorkbenchVideoMarker | null;
  readonly activeAnnotations: readonly WorkbenchSpatialAnnotation[];
  readonly selectedAnchorId: string | null;
  readonly anchors: readonly MarkerAnchorView[];
  readonly isDrawing: boolean;
  readonly draftStart: NormalizedPoint | null;
  readonly draftCurrent: NormalizedPoint | null;
  readonly videoErrorMsg: string | null;
  readonly onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  readonly onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  readonly onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
  readonly onLoadedMetadata: () => void;
  readonly onDurationChange: () => void;
  readonly onTimeUpdate: () => void;
  readonly onSeeked: () => void;
  readonly onPlay: () => void;
  readonly onPause: () => void;
  readonly onEnded: () => void;
  readonly onError: () => void;
}

export function VideoCanvasStage({
  stageRef,
  videoRef,
  videoUrl,
  mediaStatus,
  mediaError,
  videoReady,
  videoTime,
  videoSize,
  svgViewBox,
  activeMarker,
  activeAnnotations,
  selectedAnchorId,
  anchors,
  isDrawing,
  draftStart,
  draftCurrent,
  videoErrorMsg,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onLoadedMetadata,
  onDurationChange,
  onTimeUpdate,
  onSeeked,
  onPlay,
  onPause,
  onEnded,
  onError,
}: VideoCanvasStageProps): JSX.Element {
  const renderMediaFallback = (): JSX.Element => {
    if (mediaStatus === "loading") {
      return (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-fg-2">
          <Loader2 className="h-6 w-6 animate-spin text-accent" />
          <span className="text-xs">媒体加载中…</span>
        </div>
      );
    }
    if (mediaStatus === "error") {
      return (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-6 text-center">
          <TriangleAlert className="h-6 w-6 text-status-error" />
          <span className="text-sm font-medium text-status-error">媒体加载失败</span>
          <span className="text-xs text-fg-3">{mediaError ?? "未知错误"}</span>
        </div>
      );
    }
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-6 text-center">
        <TriangleAlert className="h-6 w-6 text-status-warning" />
        <span className="text-sm font-medium text-fg-2">媒体不可用</span>
        <span className="text-xs text-fg-3">
          该条目的源媒体未挂载(无可用 URL),无法播放或标注
        </span>
      </div>
    );
  };

  return (
    <div
      data-workbench-player="true"
      className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden bg-[#0d0f12] p-2"
    >
      {/* Floating HUD over canvas (clean semi-transparent dark chips) */}
      <div className="pointer-events-none absolute left-3 top-3 z-10 flex flex-wrap items-center gap-2">
        <span className="rounded-[4px] border border-white/10 bg-black/60 px-2 py-0.5 font-mono text-xs tabular-nums text-fg backdrop-blur-sm">
          播放时间: {videoTime.toFixed(3)}s
        </span>
        <span className="rounded-[4px] border border-white/10 bg-black/60 px-2 py-0.5 text-xs text-fg-2 backdrop-blur-sm">
          帧索引不可用(无解码映射)
        </span>
        {activeMarker && (
          <span className="rounded-[4px] border border-rose-500/40 bg-rose-950/70 px-2 py-0.5 text-xs font-medium text-rose-300 backdrop-blur-sm">
            ⚑ 当前位置含 {activeMarker.annotations.length} 处圈注(单击框体可在下方编辑)
          </span>
        )}
      </div>

      {/* Main stage with video and SVG annotation overlay */}
      <div
        ref={stageRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className={`relative flex h-full w-full items-center justify-center overflow-hidden rounded-[6px] border border-white/5 bg-black/40 ${
          videoReady ? "cursor-crosshair" : ""
        }`}
      >
        {mediaStatus === "ready" && videoUrl ? (
          <>
            <video
              ref={videoRef}
              src={videoUrl}
              className="absolute inset-0 h-full w-full object-contain"
              playsInline
              preload="auto"
              onLoadedMetadata={onLoadedMetadata}
              onDurationChange={onDurationChange}
              onTimeUpdate={onTimeUpdate}
              onSeeked={onSeeked}
              onPlay={onPlay}
              onPause={onPause}
              onEnded={onEnded}
              onError={onError}
            />
            {/* Annotation overlay: anchored to the paused frame's PTS */}
            <svg
              viewBox={svgViewBox}
              preserveAspectRatio="xMidYMid meet"
              className="pointer-events-none absolute inset-0 h-full w-full"
            >
              <defs>
                <marker
                  id="vfw-arrowhead"
                  markerWidth="8"
                  markerHeight="8"
                  refX="7"
                  refY="4"
                  orient="auto"
                >
                  <path d="M0,0 L8,4 L0,8 Z" className="fill-status-warning" />
                </marker>
              </defs>
              {activeAnnotations.map((ann) => {
                const isSelected = selectedAnchorId === ann.id;
                const anchorNumber =
                  anchors.find((a) => a.anchorId === ann.id)?.indexNumber ?? 1;

                if (ann.tool === "box") {
                  const rx = ann.x * (videoSize?.w ?? 1000);
                  const ry = ann.y * (videoSize?.h ?? 562.5);
                  const rw = (ann.w ?? DEFAULT_BOX_W) * (videoSize?.w ?? 1000);
                  const rh = (ann.h ?? DEFAULT_BOX_H) * (videoSize?.h ?? 562.5);
                  return (
                    <g key={ann.id}>
                      <rect
                        x={rx}
                        y={ry}
                        width={rw}
                        height={rh}
                        rx="4"
                        className={
                          isSelected
                            ? "fill-accent-soft stroke-accent"
                            : "fill-rose-500/10 stroke-rose-500"
                        }
                        strokeWidth={isSelected ? 3 : 2}
                        strokeDasharray={isSelected ? "none" : "6 4"}
                      />
                      <rect
                        x={rx}
                        y={Math.max(2, ry - 24)}
                        width={isSelected ? Math.min(340, (ann.label?.length ?? 6) * 13 + 48) : 38}
                        height="22"
                        rx="4"
                        className={
                          isSelected
                            ? "fill-accent stroke-accent"
                            : "fill-bg-2 stroke-rose-500"
                        }
                        strokeWidth="1"
                      />
                      <text
                        x={rx + 8}
                        y={Math.max(17, ry - 9)}
                        fontSize="12"
                        fontWeight="700"
                        className={isSelected ? "fill-accent-foreground" : "fill-rose-300"}
                      >
                        {isSelected ? `#${anchorNumber} ${(ann.label ?? "").slice(0, 22)}` : `#${anchorNumber}`}
                      </text>
                    </g>
                  );
                }

                const x1 = ann.x * (videoSize?.w ?? 1000);
                const y1 = ann.y * (videoSize?.h ?? 562.5);
                const x2 = (ann.endX ?? ann.x + 0.1) * (videoSize?.w ?? 1000);
                const y2 = (ann.endY ?? ann.y + 0.1) * (videoSize?.h ?? 562.5);
                return (
                  <g key={ann.id}>
                    <line
                      x1={x1}
                      y1={y1}
                      x2={x2}
                      y2={y2}
                      markerEnd="url(#vfw-arrowhead)"
                      className={isSelected ? "stroke-accent" : "stroke-status-warning"}
                      strokeWidth={isSelected ? 3.5 : 2.5}
                    />
                    <rect
                      x={x1 - 4}
                      y={Math.max(2, y1 - 24)}
                      width={isSelected ? Math.min(320, (ann.label?.length ?? 6) * 13 + 48) : 38}
                      height="20"
                      rx="4"
                      className={isSelected ? "fill-accent" : "fill-bg-2"}
                    />
                    <text
                      x={x1 + 4}
                      y={Math.max(16, y1 - 10)}
                      fontSize="12"
                      fontWeight="700"
                      className={isSelected ? "fill-accent-foreground" : "fill-status-warning"}
                    >
                      {isSelected ? `#${anchorNumber} ${(ann.label ?? "").slice(0, 20)}` : `#${anchorNumber}`}
                    </text>
                  </g>
                );
              })}

              {isDrawing && draftStart && draftCurrent && (
                <rect
                  x={Math.min(draftStart.x, draftCurrent.x) * (videoSize?.w ?? 1000)}
                  y={Math.min(draftStart.y, draftCurrent.y) * (videoSize?.h ?? 562.5)}
                  width={Math.abs(draftCurrent.x - draftStart.x) * (videoSize?.w ?? 1000)}
                  height={Math.abs(draftCurrent.y - draftStart.y) * (videoSize?.h ?? 562.5)}
                  className="fill-accent-soft stroke-accent"
                  strokeWidth="2.5"
                />
              )}
            </svg>
            {videoErrorMsg && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-bg px-6 text-center">
                <TriangleAlert className="h-6 w-6 text-status-error" />
                <span className="text-sm font-medium text-status-error">{videoErrorMsg}</span>
              </div>
            )}
          </>
        ) : (
          renderMediaFallback()
        )}
      </div>
    </div>
  );
}
