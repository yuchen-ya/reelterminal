import { useCallback, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import type {
  WorkbenchPixelStroke,
  WorkbenchSpatialAnnotation,
} from "@reelterminal/core";
import {
  clamp,
  drawStrokeOnContext,
  drawStrokeSegmentOnContext,
  pointerPressure,
  ANNOTATION_COLOR_ARROW,
  ANNOTATION_COLOR_BOX,
  ANNOTATION_COLOR_TEXT,
  BRUSH_SIZE_SOURCE_PX,
  MIN_ANNOTATION_DRAG,
  type AnnotateTool,
  type CanvasWorkMode,
  type RepairTool,
} from "./image-canvas-utils";

export interface InProgressRepairStroke extends Omit<WorkbenchPixelStroke, "points"> {
  points: WorkbenchPixelStroke["points"][number][];
}

export interface UseImagePointerInteractionsProps {
  readonly canDraw: boolean;
  readonly zoom?: number;
  readonly workMode: CanvasWorkMode;
  readonly repairTool: RepairTool;
  readonly annotateTool: AnnotateTool;
  readonly brushColor: string;
  readonly stageRef: RefObject<HTMLDivElement | null>;
  readonly imgRef: RefObject<HTMLImageElement | null>;
  readonly repairCanvasRef: RefObject<HTMLCanvasElement | null>;
  readonly natural: { readonly w: number; readonly h: number } | null;
  readonly annotations: readonly WorkbenchSpatialAnnotation[];
  readonly setBrushColor: (c: string) => void;
  readonly setRepairTool: (t: RepairTool) => void;
  readonly setSelectedAnnotationId: (id: string | null) => void;
  readonly commitAnnotations: (
    ann: readonly WorkbenchSpatialAnnotation[],
    selectId?: string,
  ) => Promise<void>;
  readonly onStrokeFinished: (stroke: WorkbenchPixelStroke) => void;
  readonly redrawRepairCanvas: () => void;
  readonly setMutationError: (err: string | null) => void;
  readonly nextId: (prefix: string) => string;
}

export function useImagePointerInteractions({
  canDraw,
  zoom = 100,
  workMode,
  repairTool,
  annotateTool,
  brushColor,
  stageRef,
  imgRef,
  repairCanvasRef,
  natural,
  annotations,
  setBrushColor,
  setRepairTool,
  setSelectedAnnotationId,
  commitAnnotations,
  onStrokeFinished,
  redrawRepairCanvas,
  setMutationError,
  nextId,
}: UseImagePointerInteractionsProps) {
  const [pan, setPan] = useState<{ readonly x: number; readonly y: number }>({ x: 0, y: 0 });
  const [draftStart, setDraftStart] = useState<{ readonly x: number; readonly y: number } | null>(
    null,
  );
  const [draftCurrent, setDraftCurrent] = useState<{
    readonly x: number;
    readonly y: number;
  } | null>(null);

  const draftStrokeRef = useRef<{
    readonly pointerId: number;
    readonly stroke: InProgressRepairStroke;
  } | null>(null);

  const panDragRef = useRef<{
    readonly pointerId: number;
    readonly startX: number;
    readonly startY: number;
    readonly originX: number;
    readonly originY: number;
  } | null>(null);

  const toStagePoint = useCallback(
    (clientX: number, clientY: number) => {
      const stage = stageRef.current;
      const nat = natural;
      if (!stage || !nat) return null;
      const rect = stage.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const nx = clamp((clientX - rect.left) / rect.width, 0, 1);
      const ny = clamp((clientY - rect.top) / rect.height, 0, 1);
      return {
        normalized: { x: nx, y: ny },
        source: { x: Math.round(nx * nat.w), y: Math.round(ny * nat.h) },
      };
    },
    [natural, stageRef],
  );

  const capturePointer = (e: ReactPointerEvent<HTMLDivElement>): void => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Pointer may already be released; drawing continues from move events.
    }
  };

  const findHitAnnotation = useCallback(
    (pt: { readonly x: number; readonly y: number }): WorkbenchSpatialAnnotation | null => {
      for (let i = annotations.length - 1; i >= 0; i -= 1) {
        const ann = annotations[i];
        if (ann.tool === "box") {
          const w = ann.w ?? 0.15;
          const h = ann.h ?? 0.15;
          if (pt.x >= ann.x && pt.x <= ann.x + w && pt.y >= ann.y && pt.y <= ann.y + h) {
            return ann;
          }
        } else if (Math.hypot(pt.x - ann.x, pt.y - ann.y) < 0.04) {
          return ann;
        }
      }
      return null;
    },
    [annotations],
  );

  const sampleColor = useCallback(
    (source: { readonly x: number; readonly y: number }): void => {
      const img = imgRef.current;
      const repairLayer = repairCanvasRef.current;
      const nat = natural;
      if (!img || !nat || !img.complete || !img.naturalWidth) {
        setMutationError("取色失败:原图尚未就绪");
        return;
      }
      const scratch = document.createElement("canvas");
      scratch.width = nat.w;
      scratch.height = nat.h;
      const ctx = scratch.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        setMutationError("取色失败:无法创建采样画布");
        return;
      }
      try {
        ctx.drawImage(img, 0, 0, nat.w, nat.h);
        if (repairLayer && repairLayer.width > 0 && repairLayer.height > 0) {
          ctx.drawImage(repairLayer, 0, 0);
        }
        const px = Math.floor(clamp(source.x, 0, nat.w - 1));
        const py = Math.floor(clamp(source.y, 0, nat.h - 1));
        const data = ctx.getImageData(px, py, 1, 1).data;
        const hex = `#${[data[0], data[1], data[2]]
          .map((v) => v.toString(16).padStart(2, "0"))
          .join("")}`;
        setBrushColor(hex);
        setRepairTool("brush");
        setMutationError(null);
      } catch {
        setMutationError("取色失败:图像数据不可读");
      }
    },
    [imgRef, natural, repairCanvasRef, setBrushColor, setMutationError, setRepairTool],
  );

  const handleStagePointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!natural) return;
    if (e.button === 1 || (e.button === 0 && workMode === "navigate")) {
      capturePointer(e);
      panDragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        originX: pan.x,
        originY: pan.y,
      };
      return;
    }
    if (!canDraw) return;
    if (e.button !== 0) return;
    e.currentTarget.focus();
    capturePointer(e);

    const pt = toStagePoint(e.clientX, e.clientY);
    if (!pt) return;

    if (workMode === "repair") {
      if (draftStrokeRef.current) return;
      if (repairTool === "eyedropper") {
        sampleColor(pt.source);
        return;
      }
      const stroke: InProgressRepairStroke = {
        id: nextId("stroke"),
        tool: repairTool === "eraser" ? "eraser" : "brush",
        color: brushColor,
        size: BRUSH_SIZE_SOURCE_PX,
        points: [{ x: pt.source.x, y: pt.source.y, pressure: pointerPressure(e) }],
      };
      draftStrokeRef.current = { pointerId: e.pointerId, stroke };
      const context = repairCanvasRef.current?.getContext("2d");
      if (context) drawStrokeOnContext(context, stroke);
      return;
    }

    if (annotateTool === "text") {
      const hit = findHitAnnotation(pt.normalized);
      if (hit) {
        setSelectedAnnotationId(hit.id);
        return;
      }
      const ann: WorkbenchSpatialAnnotation = {
        id: nextId("ann"),
        tool: "text",
        x: pt.normalized.x,
        y: pt.normalized.y,
        label: "问题点",
        color: ANNOTATION_COLOR_TEXT,
      };
      const next = [...annotations, ann];
      void commitAnnotations(next, ann.id);
      return;
    }
    setDraftStart(pt.normalized);
    setDraftCurrent(pt.normalized);
  };

  const handleStagePointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const panDrag = panDragRef.current;
    if (panDrag && panDrag.pointerId === e.pointerId) {
      const scale = Math.max(0.2, zoom / 100);
      setPan({
        x: panDrag.originX + (e.clientX - panDrag.startX) / scale,
        y: panDrag.originY + (e.clientY - panDrag.startY) / scale,
      });
      return;
    }
    if (!canDraw) return;
    const pt = toStagePoint(e.clientX, e.clientY);
    if (!pt) return;
    const activeStroke = draftStrokeRef.current;
    if (activeStroke) {
      if (activeStroke.pointerId !== e.pointerId) return;
      const draftStroke = activeStroke.stroke;
      const last = draftStroke.points[draftStroke.points.length - 1];
      if (Math.abs(last.x - pt.source.x) + Math.abs(last.y - pt.source.y) < 1) return;
      const nextPoint = {
        x: pt.source.x,
        y: pt.source.y,
        pressure: pointerPressure(e),
      };
      draftStroke.points.push(nextPoint);
      const context = repairCanvasRef.current?.getContext("2d");
      if (context) drawStrokeSegmentOnContext(context, draftStroke, last, nextPoint);
    } else if (draftStart) {
      setDraftCurrent(pt.normalized);
    }
  };

  const handleStagePointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (panDragRef.current?.pointerId === e.pointerId) {
      panDragRef.current = null;
      return;
    }

    const activeStroke = draftStrokeRef.current;
    if (activeStroke) {
      if (activeStroke.pointerId !== e.pointerId) return;
      const finished: WorkbenchPixelStroke = activeStroke.stroke;
      draftStrokeRef.current = null;
      if (finished.points.length > 0) {
        onStrokeFinished(finished);
      }
      return;
    }

    if (draftStart && draftCurrent && annotateTool !== "text") {
      const start = draftStart;
      const current = draftCurrent;
      const nat = natural;
      setDraftStart(null);
      setDraftCurrent(null);
      if (!nat) return;
      const dragDist = Math.hypot(current.x - start.x, current.y - start.y);
      if (dragDist < MIN_ANNOTATION_DRAG) {
        setSelectedAnnotationId(findHitAnnotation(start)?.id ?? null);
        return;
      }

      if (annotateTool === "box") {
        const x = Math.min(start.x, current.x);
        const y = Math.min(start.y, current.y);
        const w = Math.max(0.03, Math.abs(current.x - start.x));
        const h = Math.max(0.03, Math.abs(current.y - start.y));
        const ann: WorkbenchSpatialAnnotation = {
          id: nextId("ann"),
          tool: "box",
          x,
          y,
          w,
          h,
          label: "圈注区域",
          color: ANNOTATION_COLOR_BOX,
        };
        const next = [...annotations, ann];
        void commitAnnotations(next, ann.id);
      } else {
        const ann: WorkbenchSpatialAnnotation = {
          id: nextId("ann"),
          tool: "arrow",
          x: start.x,
          y: start.y,
          endX: current.x,
          endY: current.y,
          label: "指向问题",
          color: ANNOTATION_COLOR_ARROW,
        };
        const next = [...annotations, ann];
        void commitAnnotations(next, ann.id);
      }
    }
  };

  const handleStagePointerCancel = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (draftStrokeRef.current && draftStrokeRef.current.pointerId !== e.pointerId) return;
    if (panDragRef.current && panDragRef.current.pointerId !== e.pointerId) return;
    panDragRef.current = null;
    draftStrokeRef.current = null;
    setDraftStart(null);
    setDraftCurrent(null);
    redrawRepairCanvas();
  };

  const resetPointerState = useCallback(() => {
    draftStrokeRef.current = null;
    panDragRef.current = null;
    setDraftStart(null);
    setDraftCurrent(null);
  }, []);

  return {
    pan,
    setPan,
    draftStart,
    draftCurrent,
    handleStagePointerDown,
    handleStagePointerMove,
    handleStagePointerUp,
    handleStagePointerCancel,
    resetPointerState,
  };
}
