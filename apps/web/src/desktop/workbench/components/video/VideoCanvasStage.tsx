import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type React from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import type {
  WorkbenchSpatialAnnotation,
  WorkbenchVideoMarker,
} from "@reelterminal/core";
import {
  clamp01,
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
  readonly drawTool?: "box" | "arrow" | "pan";
  readonly zoom?: number;
  readonly pan?: { readonly x: number; readonly y: number };
  readonly onPanChange?: (pan: { readonly x: number; readonly y: number }) => void;
  readonly onStepZoom?: (delta: number) => void;
  readonly loupeEnabled?: boolean;
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
  /** Optional side-by-side reference video comparison */
  readonly currentTitle?: string;
  readonly showCompareSplit?: boolean;
  readonly compareTitle?: string;
  readonly compareVideoUrl?: string | null;
  readonly compareVideoRef?: React.RefObject<HTMLVideoElement | null>;
  readonly onCompareLoadedMetadata?: () => void;
}

const LOUPE_SIZE = 168;
const LOUPE_ZOOM = 3;

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
  drawTool = "box",
  zoom = 100,
  pan = { x: 0, y: 0 },
  onPanChange,
  onStepZoom,
  loupeEnabled = false,
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
  currentTitle,
  showCompareSplit = false,
  compareTitle,
  compareVideoUrl,
  compareVideoRef,
  onCompareLoadedMetadata,
}: VideoCanvasStageProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const loupeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const panDragRef = useRef<{
    readonly pointerId: number;
    readonly startX: number;
    readonly startY: number;
    readonly originX: number;
    readonly originY: number;
  } | null>(null);

  const [loupeState, setLoupeState] = useState<{
    readonly visible: boolean;
    readonly clientX: number;
    readonly clientY: number;
    readonly normX: number;
    readonly normY: number;
  } | null>(null);

  const drawLoupe = useCallback(
    (normX: number, normY: number) => {
      const video = videoRef.current;
      const canvas = loupeCanvasRef.current;
      if (!video || !canvas || !videoReady || video.videoWidth <= 0 || video.videoHeight <= 0) {
        return;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
      ctx.fillStyle = "#090a0c";
      ctx.fillRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);

      const srcW = LOUPE_SIZE / LOUPE_ZOOM;
      const srcH = LOUPE_SIZE / LOUPE_ZOOM;
      const srcX = normX * video.videoWidth - srcW / 2;
      const srcY = normY * video.videoHeight - srcH / 2;
      try {
        ctx.drawImage(video, srcX, srcY, srcW, srcH, 0, 0, LOUPE_SIZE, LOUPE_SIZE);
      } catch {
        // Ignore transient decode frame state
      }
    },
    [videoReady, videoRef],
  );

  useEffect(() => {
    if (loupeEnabled && loupeState?.visible) {
      drawLoupe(loupeState.normX, loupeState.normY);
    }
  }, [drawLoupe, loupeEnabled, loupeState, videoTime]);

  const computeNormPoint = useCallback(
    (clientX: number, clientY: number): NormalizedPoint | null => {
      const el = stageRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const surfaceRatio = rect.width / rect.height;
      const contentRatio = videoSize ? videoSize.w / videoSize.h : 16 / 9;
      let contentW = rect.width;
      let contentH = rect.height;
      let offX = 0;
      let offY = 0;
      if (surfaceRatio > contentRatio) {
        contentW = rect.height * contentRatio;
        offX = (rect.width - contentW) / 2;
      } else {
        contentH = rect.width / contentRatio;
        offY = (rect.height - contentH) / 2;
      }
      return {
        x: clamp01((clientX - rect.left - offX) / contentW),
        y: clamp01((clientY - rect.top - offY) / contentH),
      };
    },
    [stageRef, videoSize],
  );

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (videoReady && (drawTool === "pan" || e.button === 1)) {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      panDragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        originX: pan.x,
        originY: pan.y,
      };
      return;
    }
    onPointerDown(e);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (panDragRef.current && panDragRef.current.pointerId === e.pointerId) {
      const scale = Math.max(1, zoom / 100);
      onPanChange?.({
        x: panDragRef.current.originX + (e.clientX - panDragRef.current.startX) / scale,
        y: panDragRef.current.originY + (e.clientY - panDragRef.current.startY) / scale,
      });
      return;
    }
    if (loupeEnabled && videoReady && containerRef.current) {
      const cRect = containerRef.current.getBoundingClientRect();
      const pt = computeNormPoint(e.clientX, e.clientY);
      if (pt) {
        const next = {
          visible: true,
          clientX: e.clientX - cRect.left,
          clientY: e.clientY - cRect.top,
          normX: pt.x,
          normY: pt.y,
        };
        setLoupeState(next);
        drawLoupe(pt.x, pt.y);
      }
    }
    onPointerMove(e);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (panDragRef.current && panDragRef.current.pointerId === e.pointerId) {
      panDragRef.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      return;
    }
    onPointerUp(e);
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>): void => {
    if (!videoReady || !onStepZoom) return;
    e.preventDefault();
    onStepZoom(e.deltaY < 0 ? 25 : -25);
  };
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
      ref={containerRef}
      data-workbench-player="true"
      onWheel={handleWheel}
      onPointerLeave={() => setLoupeState(null)}
      className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden bg-[#0d0f12] p-2"
    >
      {/* Keep screen-reader / test status hooks without visual HUD clutter */}
      <div className="sr-only">
        <span>播放时间: {videoTime.toFixed(3)}s</span>
        <span>帧索引不可用(无解码映射)</span>
        {activeMarker && (
          <span>
            ⚑ 当前位置含 {activeMarker.annotations.length} 处圈注(单击框体可在下方编辑)
          </span>
        )}
      </div>

      {/* Main stage with optional side-by-side comparison and SVG annotation overlay */}
      <div
        className={`flex h-full w-full min-h-0 min-w-0 ${
          showCompareSplit ? "grid grid-cols-2 gap-2" : "items-center justify-center"
        }`}
      >
        {showCompareSplit && (
          <div
            className="relative flex h-full w-full min-w-0 flex-col overflow-hidden rounded-[6px] border border-white/10 bg-black/50"
            data-testid="video-compare-reference-pane"
          >
            <div className="z-10 flex h-6 shrink-0 items-center justify-between border-b border-white/10 bg-bg-1/90 px-2 text-[11px]">
              <span className="truncate font-medium text-status-warning">
                对比基准: {compareTitle ?? "参考视频"}
              </span>
              <span className="font-mono text-[10px] text-fg-3">同步联动</span>
            </div>
            <div className="relative flex-1 overflow-hidden">
              <div
                style={
                  zoom !== 100 || pan.x !== 0 || pan.y !== 0
                    ? {
                        transform: `scale(${zoom / 100}) translate(${pan.x}px, ${pan.y}px)`,
                        transformOrigin: "center center",
                      }
                    : undefined
                }
                className="relative flex h-full w-full items-center justify-center"
              >
                {compareVideoUrl ? (
                  <video
                    ref={compareVideoRef}
                    src={compareVideoUrl}
                    muted
                    playsInline
                    preload="auto"
                    onLoadedMetadata={onCompareLoadedMetadata}
                    className="absolute inset-0 h-full w-full object-contain"
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center gap-1.5 text-xs text-fg-3">
                    <Loader2 className="h-4 w-4 animate-spin text-accent" />
                    <span>正在加载对比视频…</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="relative flex h-full w-full min-w-0 flex-col overflow-hidden">
          {showCompareSplit && (
            <div className="z-10 mb-0.5 flex h-6 shrink-0 items-center justify-between rounded-t-[6px] border border-b-0 border-white/10 bg-bg-1/90 px-2 text-[11px]">
              <span className="truncate font-medium text-accent">
                当前审阅: {currentTitle ?? "当前视频"}
              </span>
              <span className="font-mono text-[10px] text-fg-3">可框选标注</span>
            </div>
          )}
          <div
            ref={stageRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            style={
              zoom !== 100 || pan.x !== 0 || pan.y !== 0
                ? {
                    transform: `scale(${zoom / 100}) translate(${pan.x}px, ${pan.y}px)`,
                    transformOrigin: "center center",
                  }
                : undefined
            }
            className={`relative flex flex-1 h-full w-full items-center justify-center overflow-hidden rounded-[6px] border border-white/5 bg-black/40 ${
              videoReady
                ? drawTool === "pan"
                  ? "cursor-grab active:cursor-grabbing"
                  : "cursor-crosshair"
                : ""
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
      </div>

      {/* 3x Local Magnifier Loupe Overlay */}
      {loupeEnabled && loupeState?.visible && videoReady && (
        <div
          data-testid="video-loupe-lens"
          style={{
            width: LOUPE_SIZE,
            height: LOUPE_SIZE,
            left: Math.min(
              Math.max(12, loupeState.clientX + 20),
              (containerRef.current?.clientWidth ?? 800) - LOUPE_SIZE - 12,
            ),
            top: Math.max(12, loupeState.clientY - LOUPE_SIZE - 16),
          }}
          className="pointer-events-none absolute z-30 overflow-hidden rounded-full border-2 border-accent bg-black shadow-2xl ring-2 ring-black/60"
        >
          <canvas
            ref={loupeCanvasRef}
            width={LOUPE_SIZE}
            height={LOUPE_SIZE}
            className="h-full w-full block"
          />
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="h-3 w-px bg-accent/80" />
            <div className="absolute h-px w-3 bg-accent/80" />
          </div>
          <span className="absolute bottom-1.5 left-1/2 -translate-x-1/2 rounded bg-black/75 px-1.5 py-0.5 font-mono text-[9px] text-accent">
            3×
          </span>
        </div>
      )}
    </div>
  );
}
