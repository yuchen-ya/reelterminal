import type { HandlePosition, InteractionMode } from "./index";
import { snapCanvasPosition } from "./canvas-snapping";

export interface TransformStart {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
}

export interface TransformPatch {
  position?: { x: number; y: number };
  scale?: { x: number; y: number };
}

export interface TransformCalculation {
  transform: TransformPatch;
  guides: { x: number | null; y: number | null };
}

export type CanvasTransformTarget = "clip" | "text-clip" | "shape-clip";

export interface PendingCanvasTransform {
  target: CanvasTransformTarget;
  targetId: string;
  transform: TransformPatch;
}

export interface PendingCanvasTransformRef {
  current: PendingCanvasTransform | null;
}

export interface CanvasTransformCommitHandlers {
  clip: (id: string, transform: TransformPatch) => unknown;
  text: (id: string, transform: TransformPatch) => unknown;
  shape: (id: string, transform: TransformPatch) => unknown;
}

/**
 * Takes and commits the newest pointer transform exactly once. Clearing the
 * ref before invoking a handler makes a cancelled/late RAF harmless.
 */
export function commitPendingCanvasTransform(
  pendingRef: PendingCanvasTransformRef,
  handlers: CanvasTransformCommitHandlers,
): boolean {
  const pending = pendingRef.current;
  if (!pending) return false;
  pendingRef.current = null;
  if (pending.target === "text-clip") {
    handlers.text(pending.targetId, pending.transform);
  } else if (pending.target === "shape-clip") {
    handlers.shape(pending.targetId, pending.transform);
  } else {
    handlers.clip(pending.targetId, pending.transform);
  }
  return true;
}

interface SharedTransformInput {
  mode: InteractionMode;
  handle: HandlePosition | null;
  start: TransformStart;
  deltaX: number;
  deltaY: number;
  displayScale: number;
  boundsWidth: number;
  boundsHeight: number;
  lockAspectRatio: boolean;
  snappingEnabled: boolean;
}

export function calculateOverlayTransform(
  input: SharedTransformInput & {
    canvasWidth: number;
    canvasHeight: number;
  },
): TransformCalculation {
  const {
    mode,
    handle,
    start,
    deltaX,
    deltaY,
    displayScale,
    boundsWidth,
    boundsHeight,
    canvasWidth,
    canvasHeight,
    lockAspectRatio,
    snappingEnabled,
  } = input;

  if (mode === "move") {
    const rawX = start.x + deltaX / displayScale / canvasWidth;
    const rawY = start.y + deltaY / displayScale / canvasHeight;
    const halfWidth = boundsWidth / displayScale / canvasWidth / 2;
    const halfHeight = boundsHeight / displayScale / canvasHeight / 2;
    const snapped = snapCanvasPosition({
      x: rawX,
      y: rawY,
      xCandidates: [
        { value: halfWidth, guide: 0 },
        { value: 0.5, guide: 0.5 },
        { value: 1 - halfWidth, guide: 1 },
      ],
      yCandidates: [
        { value: halfHeight, guide: 0 },
        { value: 0.5, guide: 0.5 },
        { value: 1 - halfHeight, guide: 1 },
      ],
      thresholdX: 8 / displayScale / canvasWidth,
      thresholdY: 8 / displayScale / canvasHeight,
      enabled: snappingEnabled,
    });
    return {
      transform: { position: { x: snapped.x, y: snapped.y } },
      guides: { x: snapped.guideX, y: snapped.guideY },
    };
  }

  if (mode !== "resize" || !handle) {
    return { transform: {}, guides: { x: null, y: null } };
  }

  let scaleX = start.scaleX;
  let scaleY = start.scaleY;
  const scaleDeltaX = deltaX / displayScale / 100;
  const scaleDeltaY = deltaY / displayScale / 100;
  if (handle === "e" || handle === "se" || handle === "ne") {
    scaleX = Math.max(0.1, start.scaleX + scaleDeltaX);
    if (lockAspectRatio) scaleY = scaleX;
  } else if (handle === "w" || handle === "sw" || handle === "nw") {
    scaleX = Math.max(0.1, start.scaleX - scaleDeltaX);
    if (lockAspectRatio) scaleY = scaleX;
  } else if (handle === "s") {
    scaleY = Math.max(0.1, start.scaleY + scaleDeltaY);
    if (lockAspectRatio) scaleX = scaleY;
  } else if (handle === "n") {
    scaleY = Math.max(0.1, start.scaleY - scaleDeltaY);
    if (lockAspectRatio) scaleX = scaleY;
  }
  return {
    transform: {
      position: { x: start.x, y: start.y },
      scale: { x: scaleX, y: scaleY },
    },
    guides: { x: null, y: null },
  };
}

export function calculateClipTransform(
  input: SharedTransformInput & {
    canvasWidth: number;
    canvasHeight: number;
  },
): TransformCalculation {
  const {
    mode,
    handle,
    start,
    deltaX,
    deltaY,
    displayScale,
    boundsWidth,
    boundsHeight,
    canvasWidth,
    canvasHeight,
    lockAspectRatio,
    snappingEnabled,
  } = input;

  if (mode === "move") {
    const rawX = start.x + deltaX / displayScale;
    const rawY = start.y + deltaY / displayScale;
    const halfWidth = boundsWidth / displayScale / 2;
    const halfHeight = boundsHeight / displayScale / 2;
    const snapped = snapCanvasPosition({
      x: rawX,
      y: rawY,
      xCandidates: [
        { value: -canvasWidth / 2 + halfWidth, guide: 0 },
        { value: 0, guide: 0.5 },
        { value: canvasWidth / 2 - halfWidth, guide: 1 },
      ],
      yCandidates: [
        { value: -canvasHeight / 2 + halfHeight, guide: 0 },
        { value: 0, guide: 0.5 },
        { value: canvasHeight / 2 - halfHeight, guide: 1 },
      ],
      thresholdX: 8 / displayScale,
      thresholdY: 8 / displayScale,
      enabled: snappingEnabled,
    });
    return {
      transform: { position: { x: snapped.x, y: snapped.y } },
      guides: { x: snapped.guideX, y: snapped.guideY },
    };
  }

  if (mode !== "resize" || !handle) {
    return { transform: {}, guides: { x: null, y: null } };
  }

  let scaleX = start.scaleX;
  let scaleY = start.scaleY;
  let x = start.x;
  let y = start.y;
  const baseWidth = boundsWidth / displayScale / Math.max(0.001, start.scaleX);
  const baseHeight = boundsHeight / displayScale / Math.max(0.001, start.scaleY);
  const dx = deltaX / displayScale / (baseWidth / 2);
  const dy = deltaY / displayScale / (baseHeight / 2);
  const lock = (delta: number) => {
    scaleX = Math.max(0.1, start.scaleX + delta);
    scaleY = scaleX;
  };

  switch (handle) {
    case "e":
      scaleX = Math.max(0.1, start.scaleX + dx);
      if (lockAspectRatio) scaleY = scaleX;
      break;
    case "w":
      scaleX = Math.max(0.1, start.scaleX - dx);
      if (lockAspectRatio) scaleY = scaleX;
      x += deltaX / displayScale / 2;
      break;
    case "s":
      scaleY = Math.max(0.1, start.scaleY + dy);
      if (lockAspectRatio) scaleX = scaleY;
      break;
    case "n":
      scaleY = Math.max(0.1, start.scaleY - dy);
      if (lockAspectRatio) scaleX = scaleY;
      y += deltaY / displayScale / 2;
      break;
    case "se":
      if (lockAspectRatio) lock((dx + dy) / 2);
      else {
        scaleX = Math.max(0.1, start.scaleX + dx);
        scaleY = Math.max(0.1, start.scaleY + dy);
      }
      break;
    case "sw":
      if (lockAspectRatio) lock((-dx + dy) / 2);
      else {
        scaleX = Math.max(0.1, start.scaleX - dx);
        scaleY = Math.max(0.1, start.scaleY + dy);
      }
      x += deltaX / displayScale / 2;
      break;
    case "ne":
      if (lockAspectRatio) lock((dx - dy) / 2);
      else {
        scaleX = Math.max(0.1, start.scaleX + dx);
        scaleY = Math.max(0.1, start.scaleY - dy);
      }
      y += deltaY / displayScale / 2;
      break;
    case "nw":
      if (lockAspectRatio) lock((-dx - dy) / 2);
      else {
        scaleX = Math.max(0.1, start.scaleX - dx);
        scaleY = Math.max(0.1, start.scaleY - dy);
      }
      x += deltaX / displayScale / 2;
      y += deltaY / displayScale / 2;
      break;
  }
  return {
    transform: { position: { x, y }, scale: { x: scaleX, y: scaleY } },
    guides: { x: null, y: null },
  };
}
