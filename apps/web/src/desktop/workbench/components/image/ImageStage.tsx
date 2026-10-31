import type {
  JSX,
  PointerEvent as ReactPointerEvent,
  RefObject,
  WheelEvent as ReactWheelEvent,
} from "react";
import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import type { WorkbenchSpatialAnnotation } from "@reelterminal/core";
import type { ImagePayloadView, WorkbenchMediaRef } from "../../types";
import { ImagePlaceholder } from "./ImagePlaceholder";
import { ImageAnnotationLayer } from "./ImageAnnotationLayer";
import type { AnnotateTool, CanvasWorkMode } from "./image-canvas-utils";

const LOUPE_SIZE_PX = 168;
const LOUPE_ZOOM_FACTOR = 3;

export interface ImageStageProps {
  readonly stageRef: RefObject<HTMLDivElement | null>;
  readonly imgRef: RefObject<HTMLImageElement | null>;
  readonly repairCanvasRef: RefObject<HTMLCanvasElement | null>;
  readonly activeMedia?: WorkbenchMediaRef;
  readonly payload?: ImagePayloadView;
  readonly activeUrl: string | null;
  readonly displayedUrl: string | null;
  readonly imgError: boolean;
  readonly imageError?: string;
  readonly currentItemTitle: string;
  readonly usingRepair: boolean;
  readonly natural: { readonly w: number; readonly h: number } | null;
  readonly display: { readonly w: number; readonly h: number } | null;
  readonly zoom: number;
  readonly pan: { readonly x: number; readonly y: number };
  readonly loupeEnabled?: boolean;
  readonly onDisableLoupe?: () => void;
  readonly workMode: CanvasWorkMode;
  readonly stageCursorClass: string;
  readonly holdOriginal: boolean;
  readonly annotations: readonly WorkbenchSpatialAnnotation[];
  readonly selectedAnnotationId: string | null;
  readonly annotateTool: AnnotateTool;
  readonly draftStart: { readonly x: number; readonly y: number } | null;
  readonly draftCurrent: { readonly x: number; readonly y: number } | null;
  readonly onImageLoad: (e: React.SyntheticEvent<HTMLImageElement>) => void;
  readonly onImageError: () => void;
  readonly onStagePointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onStagePointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onDeleteSelected?: () => void;
  readonly onStagePointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onStagePointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onWheel?: (e: ReactWheelEvent<HTMLDivElement>) => void;
}

export function ImageStage({
  stageRef,
  imgRef,
  repairCanvasRef,
  activeMedia,
  payload,
  activeUrl,
  displayedUrl,
  imgError,
  imageError,
  currentItemTitle,
  usingRepair,
  natural,
  display,
  zoom,
  pan,
  loupeEnabled = false,
  onDisableLoupe,
  workMode,
  stageCursorClass,
  holdOriginal,
  annotations,
  selectedAnnotationId,
  annotateTool,
  draftStart,
  draftCurrent,
  onImageLoad,
  onImageError,
  onStagePointerDown,
  onStagePointerMove,
  onDeleteSelected,
  onStagePointerUp,
  onStagePointerCancel,
  onWheel,
}: ImageStageProps): JSX.Element {
  const loupeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [loupePos, setLoupePos] = useState<{
    readonly normX: number;
    readonly normY: number;
    readonly flipBelow: boolean;
  } | null>(null);

  const drawLoupe = (normX: number, normY: number): void => {
    const canvas = loupeCanvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img || !natural || !display || !img.complete || img.naturalWidth <= 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // 1:1 isotropic square sampling in source pixels so wide/tall images never stretch.
    // Relative to current on-screen zoom, magnify by LOUPE_ZOOM_FACTOR (3x).
    const screenPxPerNaturalPx = (display.w / natural.w) * (zoom / 100);
    const sampleSize = Math.max(
      12,
      LOUPE_SIZE_PX / Math.max(0.1, screenPxPerNaturalPx * LOUPE_ZOOM_FACTOR),
    );
    const centerX = normX * natural.w;
    const centerY = normY * natural.h;
    const rawSx = centerX - sampleSize / 2;
    const rawSy = centerY - sampleSize / 2;

    // Compute valid source sub-rectangle and corresponding destination sub-rectangle
    // so the center crosshair always stays locked to (centerX, centerY) even near image edges.
    const sx0 = Math.max(0, rawSx);
    const sy0 = Math.max(0, rawSy);
    const sx1 = Math.min(natural.w, rawSx + sampleSize);
    const sy1 = Math.min(natural.h, rawSy + sampleSize);
    const sw = sx1 - sx0;
    const sh = sy1 - sy0;

    ctx.clearRect(0, 0, LOUPE_SIZE_PX, LOUPE_SIZE_PX);
    ctx.fillStyle = "#18181b";
    ctx.fillRect(0, 0, LOUPE_SIZE_PX, LOUPE_SIZE_PX);
    if (sw <= 0 || sh <= 0) return;

    const scale = LOUPE_SIZE_PX / sampleSize;
    const dx = (sx0 - rawSx) * scale;
    const dy = (sy0 - rawSy) * scale;
    const dw = sw * scale;
    const dh = sh * scale;

    ctx.imageSmoothingEnabled = false;
    try {
      ctx.drawImage(img, sx0, sy0, sw, sh, dx, dy, dw, dh);
      const repairLayer = repairCanvasRef.current;
      if (workMode === "repair" && repairLayer && repairLayer.width > 0 && repairLayer.height > 0) {
        ctx.drawImage(repairLayer, sx0, sy0, sw, sh, dx, dy, dw, dh);
      }
    } catch {
      // Ignore cross-origin draw issues
    }
  };

  useEffect(() => {
    if (loupeEnabled && loupePos) {
      drawLoupe(loupePos.normX, loupePos.normY);
    }
  });
  if (!displayedUrl && (!activeMedia || activeMedia.status !== "ready" || !activeUrl || imgError)) {
    return (
      <ImagePlaceholder
        payload={payload}
        originalMedia={activeMedia}
        imgError={imgError}
        imageError={imageError}
        currentItemTitle={currentItemTitle}
      />
    );
  }

  const ready = natural !== null && display !== null;
  const imageUrls = [...new Set([displayedUrl, activeMedia?.status === "ready" && !imgError ? activeUrl : null])]
    .filter((url): url is string => url !== null);

  return (
    <>
      <div
        ref={stageRef}
        data-testid="image-stage"
        className={`relative select-none ${ready ? `shadow-lg ${stageCursorClass}` : ""}`}
        style={
          ready && display
            ? {
                width: display.w,
                height: display.h,
                transform: `scale(${zoom / 100}) translate(${pan.x}px, ${pan.y}px)`,
              }
            : undefined
        }
      >
        {imageUrls.map(url => {
          const visible = url === displayedUrl;
          return <img
            key={url}
            ref={visible || !displayedUrl ? imgRef : undefined}
            src={url}
            alt={visible || !displayedUrl ? activeMedia?.displayName ?? currentItemTitle : ""}
            aria-hidden={!visible && !!displayedUrl}
            draggable={false}
            data-testid={visible ? "image-stage-image" : "image-stage-pending-image"}
            data-display-mode={usingRepair ? "repaired" : "original"}
            onLoad={url === activeUrl ? onImageLoad : undefined}
            onError={url === activeUrl ? onImageError : undefined}
            className={visible && ready ? "block h-full w-full" : "pointer-events-none absolute h-px w-px opacity-0"}
          />;
        })}

        {ready && workMode === "repair" && (
          <canvas
            ref={repairCanvasRef}
            className="pointer-events-none absolute inset-0 h-full w-full"
          />
        )}

        {ready && (
          <ImageAnnotationLayer
            natural={natural}
            holdOriginal={holdOriginal}
            annotations={annotations}
            selectedAnnotationId={selectedAnnotationId}
            isDraftBoxVisible={workMode === "annotate" && annotateTool === "box"}
            isDraftArrowVisible={workMode === "annotate" && annotateTool === "arrow"}
            draftStart={draftStart}
            draftCurrent={draftCurrent}
          />
        )}

        {ready && (
          <div
            className={`absolute inset-0 touch-none ${stageCursorClass}`}
            data-testid="image-stage-pointer-surface"
            onWheel={onWheel}
            onContextMenu={(e) => {
              if (loupeEnabled) {
                e.preventDefault();
                e.stopPropagation();
                setLoupePos(null);
                onDisableLoupe?.();
              }
            }}
            onPointerDown={(e) => {
              if (e.button === 2 && loupeEnabled) {
                e.preventDefault();
                e.stopPropagation();
                setLoupePos(null);
                onDisableLoupe?.();
                return;
              }
              onStagePointerDown(e);
            }}
            onPointerMove={(e) => {
              onStagePointerMove(e);
              if (loupeEnabled && stageRef.current) {
                const rect = stageRef.current.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                  const normX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                  const normY = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
                  const parentRect = stageRef.current.parentElement?.getBoundingClientRect();
                  const topSpace = parentRect ? e.clientY - parentRect.top : e.clientY;
                  const flipBelow = topSpace < LOUPE_SIZE_PX + 28;
                  setLoupePos({ normX, normY, flipBelow });
                  drawLoupe(normX, normY);
                }
              }
            }}
            onPointerLeave={() => setLoupePos(null)}
            tabIndex={0}
            onKeyDown={event => {
              if (event.key === "Escape" && loupeEnabled) {
                event.preventDefault();
                event.stopPropagation();
                setLoupePos(null);
                onDisableLoupe?.();
                return;
              }
              if (event.target !== event.currentTarget || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
              if ((event.key === "Delete" || event.key === "Backspace") && onDeleteSelected) {
                event.preventDefault();
                event.stopPropagation();
                onDeleteSelected();
              }
            }}
            onPointerUp={onStagePointerUp}
            onPointerCancel={onStagePointerCancel}
          />
        )}

        {ready && loupeEnabled && loupePos && (
          <div
            className="pointer-events-none absolute z-30"
            style={{
              left: `${loupePos.normX * 100}%`,
              top: `${loupePos.normY * 100}%`,
              transformOrigin: "0 0",
              transform: `scale(${100 / zoom})`,
            }}
          >
            <div
              data-testid="image-loupe"
              className="overflow-hidden rounded-full border-2 border-accent bg-bg-1 shadow-xl"
              style={{
                width: LOUPE_SIZE_PX,
                height: LOUPE_SIZE_PX,
                transform: loupePos.flipBelow
                  ? "translate(-50%, 16px)"
                  : "translate(-50%, calc(-100% - 16px))",
              }}
            >
              <canvas
                ref={loupeCanvasRef}
                width={LOUPE_SIZE_PX}
                height={LOUPE_SIZE_PX}
                className="block h-full w-full"
              />
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="h-3 w-px bg-accent/70" />
                <div className="absolute h-px w-3 bg-accent/70" />
              </div>
              <span className="pointer-events-none absolute bottom-1.5 left-1/2 -translate-x-1/2 rounded bg-bg-1/85 px-1.5 py-0.5 font-mono text-[9px] text-fg-2">
                {LOUPE_ZOOM_FACTOR}×
              </span>
            </div>
          </div>
        )}
      </div>
      {!ready && (
        <div className="absolute flex max-w-md flex-col items-center gap-2 rounded-xl border border-border bg-bg-1 px-6 py-8 text-center">
          <LoaderCircle className="h-6 w-6 animate-spin text-fg-3" />
          <div className="text-sm text-fg-2">媒体加载中…</div>
          <div className="text-xs text-fg-3">{activeMedia?.displayName}</div>
        </div>
      )}
    </>
  );
}
