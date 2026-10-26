import { useCallback, useState } from "react";
import type React from "react";
import type { WorkbenchSpatialAnnotation } from "@reelterminal/core";
import {
  ANNOTATION_HIT_RADIUS,
  clamp01,
  DRAW_MIN_DRAG,
  isInsideBox,
  type NormalizedPoint,
} from "./video-helpers";

export interface UseVideoDrawingOptions {
  readonly stageRef: React.RefObject<HTMLDivElement | null>;
  readonly videoRef: React.RefObject<HTMLVideoElement | null>;
  readonly videoReady: boolean;
  readonly videoSize: { w: number; h: number } | null;
  readonly activeAnnotations: readonly WorkbenchSpatialAnnotation[];
  readonly drawTool: "box" | "arrow" | "pan";
  readonly realTime: () => number;
  readonly makeId: (prefix: string) => string;
  readonly onAnnotationCreated: (
    ann: WorkbenchSpatialAnnotation,
    ptsSec: number,
  ) => void;
  readonly onSelectAnchor: (anchorId: string) => void;
}

export function useVideoDrawing({
  stageRef,
  videoRef,
  videoReady,
  videoSize,
  activeAnnotations,
  drawTool,
  realTime,
  makeId,
  onAnnotationCreated,
  onSelectAnchor,
}: UseVideoDrawingOptions) {
  const [isDrawing, setIsDrawing] = useState<boolean>(false);
  const [draftStart, setDraftStart] = useState<NormalizedPoint | null>(null);
  const [draftCurrent, setDraftCurrent] = useState<NormalizedPoint | null>(null);

  const resetDrawing = useCallback(() => {
    setIsDrawing(false);
    setDraftStart(null);
    setDraftCurrent(null);
  }, []);

  const getNormalizedPoint = useCallback(
    (clientX: number, clientY: number): NormalizedPoint => {
      const el = stageRef.current;
      if (!el) return { x: 0.5, y: 0.5 };
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return { x: 0.5, y: 0.5 };
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

  const hitTestAnnotation = useCallback(
    (pt: NormalizedPoint): WorkbenchSpatialAnnotation | null => {
      for (let i = activeAnnotations.length - 1; i >= 0; i--) {
        const ann = activeAnnotations[i];
        if (ann.tool === "box") {
          if (isInsideBox(pt, ann)) return ann;
        } else if (
          Math.hypot(pt.x - ann.x, pt.y - ann.y) < ANNOTATION_HIT_RADIUS
        ) {
          return ann;
        }
      }
      return null;
    },
    [activeAnnotations],
  );

  const handleStagePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (!videoReady || drawTool === "pan" || e.button !== 0) return;
      videoRef.current?.pause();
      const pt = getNormalizedPoint(e.clientX, e.clientY);
      const hit = hitTestAnnotation(pt);
      if (hit) {
        onSelectAnchor(hit.id);
        return;
      }
      e.currentTarget.setPointerCapture(e.pointerId);
      setIsDrawing(true);
      setDraftStart(pt);
      setDraftCurrent(pt);
    },
    [
      drawTool,
      getNormalizedPoint,
      hitTestAnnotation,
      onSelectAnchor,
      videoReady,
      videoRef,
    ],
  );

  const handleStagePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (!isDrawing) return;
      setDraftCurrent(getNormalizedPoint(e.clientX, e.clientY));
    },
    [getNormalizedPoint, isDrawing],
  );

  const handleStagePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      if (!isDrawing || !draftStart || !draftCurrent) return;
      setIsDrawing(false);

      const dragDist = Math.hypot(
        draftCurrent.x - draftStart.x,
        draftCurrent.y - draftStart.y,
      );
      setDraftStart(null);
      setDraftCurrent(null);
      if (dragDist < DRAW_MIN_DRAG) return;

      const t = Number(realTime().toFixed(3));
      const defaultNote = `播放时间 ${t.toFixed(3)}s 局部异常`;
      const annotation: WorkbenchSpatialAnnotation =
        drawTool === "box"
          ? {
              id: makeId("v_ann"),
              tool: "box",
              x: Math.min(draftStart.x, draftCurrent.x),
              y: Math.min(draftStart.y, draftCurrent.y),
              w: Math.max(DRAW_MIN_DRAG, Math.abs(draftCurrent.x - draftStart.x)),
              h: Math.max(DRAW_MIN_DRAG, Math.abs(draftCurrent.y - draftStart.y)),
              label: defaultNote,
              color: "#f43f5e",
              ptsSec: t,
            }
          : {
              id: makeId("v_ann"),
              tool: "arrow",
              x: draftStart.x,
              y: draftStart.y,
              endX: draftCurrent.x,
              endY: draftCurrent.y,
              label: defaultNote,
              color: "#f59e0b",
              ptsSec: t,
            };

      onAnnotationCreated(annotation, t);
    },
    [
      draftCurrent,
      draftStart,
      drawTool,
      isDrawing,
      makeId,
      onAnnotationCreated,
      realTime,
    ],
  );

  return {
    isDrawing,
    draftStart,
    draftCurrent,
    resetDrawing,
    handleStagePointerDown,
    handleStagePointerMove,
    handleStagePointerUp,
  };
}
