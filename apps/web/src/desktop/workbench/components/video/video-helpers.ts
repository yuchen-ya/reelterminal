/**
 * Shared helper types and pure math functions for video review workspace.
 */

import type {
  WorkbenchDecisionStatus,
  WorkbenchSpatialAnnotation,
  WorkbenchVideoMarker,
} from "@reelterminal/core";

export const FRAME_MARKER_EPSILON_SEC = 0.02;
export const ACTIVE_MARKER_EPSILON_SEC = 0.05;
export const MIN_INTERVAL_SEC = 0.05;
export const DEFAULT_STEP_SEC = 0.1;
/** Below this drag distance a pointer gesture is a click, not a drawing. */
export const DRAW_MIN_DRAG = 0.025;
/** Hit-test radius (normalized) for picking arrows/points. */
export const ANNOTATION_HIT_RADIUS = 0.06;
export const DEFAULT_BOX_W = 0.18;
export const DEFAULT_BOX_H = 0.18;

export const STATUS_LABEL: Record<WorkbenchDecisionStatus, string> = {
  pending: "待决定",
  kept: "已保留",
  modified: "已修改",
  rework: "返工中",
  discarded: "已丢弃",
};

export interface VideoMarkerFeedback {
  readonly text: string;
  readonly referencedTagIds: readonly string[];
  readonly markRework: boolean;
  readonly state?: "draft" | "confirmed";
  readonly target?: import("@reelterminal/core").WorkbenchFeedbackTarget;
}

export interface MarkerAnchorView {
  /** Marker id or annotation id — one selectable "anchor". */
  readonly anchorId: string;
  readonly markerId: string;
  readonly kind: "marker" | "annotation";
  readonly indexNumber: number;
  readonly coordinateLabel: string;
}

export interface NormalizedPoint {
  readonly x: number;
  readonly y: number;
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function formatTimecode(seconds: number): string {
  const t = Math.max(0, seconds);
  const mm = Math.floor(t / 60);
  const ss = Math.floor(t % 60);
  const mmm = Math.floor((t - Math.floor(t)) * 1000);
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(mmm).padStart(3, "0")}`;
}

export function formatScrubLabel(seconds: number): string {
  return seconds < 10 ? `${seconds.toFixed(2)}s` : `${seconds.toFixed(1)}s`;
}

export function sortMarkers(
  markers: readonly WorkbenchVideoMarker[],
): WorkbenchVideoMarker[] {
  return [...markers].sort((a, b) => a.startPtsSec - b.startPtsSec);
}

export function isInsideBox(
  pt: NormalizedPoint,
  ann: WorkbenchSpatialAnnotation,
): boolean {
  const w = ann.w ?? DEFAULT_BOX_W;
  const h = ann.h ?? DEFAULT_BOX_H;
  return pt.x >= ann.x && pt.x <= ann.x + w && pt.y >= ann.y && pt.y <= ann.y + h;
}
