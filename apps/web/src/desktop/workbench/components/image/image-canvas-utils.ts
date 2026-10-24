import type { PointerEvent as ReactPointerEvent } from "react";
import type {
  WorkbenchPixelStroke,
  WorkbenchSpatialAnnotation,
} from "@reelterminal/core";
import type { WorkbenchItemView } from "../../types";

export type CanvasWorkMode = "navigate" | "annotate" | "repair";
export type RepairTool = "brush" | "eraser" | "eyedropper";
export type AnnotateTool = "box" | "arrow" | "text";

/** Brush size in source pixels (stored on WorkbenchPixelStroke.size). */
export const BRUSH_SIZE_SOURCE_PX = 14;
/** New-annotation colors use host token values (tailwind status tokens / --accent). */
export const ANNOTATION_COLOR_BOX = "#eab308";
export const ANNOTATION_COLOR_ARROW = "#ef4444";
export const ANNOTATION_COLOR_TEXT = "#10b981";
export const FALLBACK_ACCENT = "#10b981";
/** Neutral dark used for on-image label chips (readable over any media). */
export const LABEL_CHIP_BG = "rgba(17, 24, 39, 0.92)";

export const MIN_ANNOTATION_DRAG = 0.02;
export const EMPTY_STROKES: readonly WorkbenchPixelStroke[] = [];
export const EMPTY_ANNOTATIONS: readonly WorkbenchSpatialAnnotation[] = [];

export const DECISION_STATUS_LABEL: Record<WorkbenchItemView["status"], string> = {
  pending: "待审阅",
  kept: "已保留",
  modified: "已修改",
  rework: "待返工",
  discarded: "已丢弃",
};

export const STATUS_TEXT_CLASS: Record<WorkbenchItemView["status"], string> = {
  pending: "text-fg-2",
  kept: "text-accent",
  modified: "text-accent",
  rework: "text-status-warning",
  discarded: "text-status-error",
};

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function readAccentColor(): string {
  if (typeof window === "undefined") return FALLBACK_ACCENT;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue("--accent")
    .trim();
  return value.length > 0 ? value : FALLBACK_ACCENT;
}

/** Pointer pressure for stroke width; devices without pressure report 0.5. */
export function pointerPressure(e: ReactPointerEvent): number {
  return e.pressure > 0 ? e.pressure : 0.5;
}

export function pressureFactor(pressure: number): number {
  return 0.35 + 0.65 * clamp(pressure, 0, 1);
}

/**
 * Renders one repair stroke onto the transparent repair canvas. Eraser
 * strokes erase previously drawn repair content only (destination-out) —
 * they never paint the background color.
 */
export function drawStrokeOnContext(
  ctx: CanvasRenderingContext2D,
  stroke: WorkbenchPixelStroke,
): void {
  const points = stroke.points;
  if (points.length === 0) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (stroke.tool === "eraser") {
    ctx.globalCompositeOperation = "destination-out";
    ctx.strokeStyle = "rgba(0, 0, 0, 1)";
    ctx.fillStyle = "rgba(0, 0, 0, 1)";
  } else {
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
  }
  if (points.length === 1) {
    const radius = Math.max((stroke.size * pressureFactor(points[0].pressure)) / 2, 0.5);
    ctx.beginPath();
    ctx.arc(points[0].x, points[0].y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    ctx.lineWidth = Math.max(
      stroke.size * pressureFactor((a.pressure + b.pressure) / 2),
      0.5,
    );
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.restore();
}

/** Paint one newly sampled segment without clearing or replaying earlier strokes. */
export function drawStrokeSegmentOnContext(
  ctx: CanvasRenderingContext2D,
  stroke: WorkbenchPixelStroke,
  from: WorkbenchPixelStroke["points"][number],
  to: WorkbenchPixelStroke["points"][number],
): void {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (stroke.tool === "eraser") {
    ctx.globalCompositeOperation = "destination-out";
    ctx.strokeStyle = "rgba(0, 0, 0, 1)";
  } else {
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = stroke.color;
  }
  ctx.lineWidth = Math.max(
    stroke.size * pressureFactor((from.pressure + to.pressure) / 2),
    0.5,
  );
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.restore();
}

export function annotationCoordinateLabel(
  ann: WorkbenchSpatialAnnotation,
  natural: { readonly w: number; readonly h: number } | null,
): string {
  if (!natural) return "源像素坐标未提供";
  if (ann.tool === "box") {
    const px = Math.round(ann.x * natural.w);
    const py = Math.round(ann.y * natural.h);
    const pw = Math.round((ann.w ?? 0) * natural.w);
    const ph = Math.round((ann.h ?? 0) * natural.h);
    return `源像素 [${px}, ${py}, ${pw}×${ph}]`;
  }
  return `源像素 (${Math.round(ann.x * natural.w)}, ${Math.round(ann.y * natural.h)})`;
}
