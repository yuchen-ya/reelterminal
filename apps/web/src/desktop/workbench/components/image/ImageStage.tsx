import type { JSX, PointerEvent as ReactPointerEvent, RefObject } from "react";
import { LoaderCircle } from "lucide-react";
import type { WorkbenchSpatialAnnotation } from "@reelterminal/core";
import type { ImagePayloadView, WorkbenchMediaRef } from "../../types";
import { ImagePlaceholder } from "./ImagePlaceholder";
import { ImageAnnotationLayer } from "./ImageAnnotationLayer";
import type { AnnotateTool, CanvasWorkMode } from "./image-canvas-utils";

export interface ImageStageProps {
  readonly stageRef: RefObject<HTMLDivElement | null>;
  readonly imgRef: RefObject<HTMLImageElement | null>;
  readonly repairCanvasRef: RefObject<HTMLCanvasElement | null>;
  readonly activeMedia?: WorkbenchMediaRef;
  readonly payload?: ImagePayloadView;
  readonly activeUrl: string | null;
  readonly imgError: boolean;
  readonly currentItemTitle: string;
  readonly usingRepair: boolean;
  readonly natural: { readonly w: number; readonly h: number } | null;
  readonly display: { readonly w: number; readonly h: number } | null;
  readonly zoom: number;
  readonly pan: { readonly x: number; readonly y: number };
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
  readonly onStagePointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onStagePointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => void;
}

export function ImageStage({
  stageRef,
  imgRef,
  repairCanvasRef,
  activeMedia,
  payload,
  activeUrl,
  imgError,
  currentItemTitle,
  usingRepair,
  natural,
  display,
  zoom,
  pan,
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
  onStagePointerUp,
  onStagePointerCancel,
}: ImageStageProps): JSX.Element {
  if (!activeMedia || activeMedia.status !== "ready" || !activeUrl || imgError) {
    return (
      <ImagePlaceholder
        payload={payload}
        originalMedia={activeMedia}
        imgError={imgError}
        currentItemTitle={currentItemTitle}
      />
    );
  }

  const ready = natural !== null && display !== null;

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
        <img
          ref={imgRef}
          src={activeUrl}
          alt={activeMedia.displayName}
          draggable={false}
          data-display-mode={usingRepair ? "repaired" : "original"}
          onLoad={onImageLoad}
          onError={onImageError}
          className={ready ? "block h-full w-full" : "block h-px w-px opacity-0"}
        />

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
            onPointerDown={onStagePointerDown}
            onPointerMove={onStagePointerMove}
            onPointerUp={onStagePointerUp}
            onPointerCancel={onStagePointerCancel}
          />
        )}
      </div>
      {!ready && (
        <div className="absolute flex max-w-md flex-col items-center gap-2 rounded-xl border border-border bg-bg-1 px-6 py-8 text-center">
          <LoaderCircle className="h-6 w-6 animate-spin text-fg-3" />
          <div className="text-sm text-fg-2">媒体加载中…</div>
          <div className="text-xs text-fg-3">{activeMedia.displayName}</div>
        </div>
      )}
    </>
  );
}
