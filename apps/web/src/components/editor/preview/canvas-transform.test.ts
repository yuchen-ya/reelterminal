import { describe, expect, it, vi } from "vitest";
import {
  calculateClipTransform,
  calculateOverlayTransform,
  commitPendingCanvasTransform,
  type PendingCanvasTransformRef,
  type TransformStart,
} from "./canvas-transform";

const start: TransformStart = { x: 0, y: 0, scaleX: 1, scaleY: 1 };

describe("canvas transform calculations", () => {
  it("snaps normalized overlays to the canvas center", () => {
    const result = calculateOverlayTransform({
      mode: "move",
      handle: null,
      start: { ...start, x: 0.499, y: 0.501 },
      deltaX: 0,
      deltaY: 0,
      displayScale: 1,
      boundsWidth: 100,
      boundsHeight: 100,
      canvasWidth: 1920,
      canvasHeight: 1080,
      lockAspectRatio: true,
      snappingEnabled: true,
    });
    expect(result.transform.position).toEqual({ x: 0.5, y: 0.5 });
    expect(result.guides).toEqual({ x: 0.5, y: 0.5 });
  });

  it("preserves unlocked clip scale and shifts the opposite corner", () => {
    const result = calculateClipTransform({
      mode: "resize",
      handle: "nw",
      start,
      deltaX: 20,
      deltaY: 10,
      displayScale: 1,
      boundsWidth: 200,
      boundsHeight: 100,
      canvasWidth: 1920,
      canvasHeight: 1080,
      lockAspectRatio: false,
      snappingEnabled: true,
    });
    expect(result.transform.position).toEqual({ x: 10, y: 5 });
    expect(result.transform.scale?.x).toBeCloseTo(0.8);
    expect(result.transform.scale?.y).toBeCloseTo(0.8);
  });

  it("clamps overlay resize scale to a usable minimum", () => {
    const result = calculateOverlayTransform({
      mode: "resize",
      handle: "w",
      start,
      deltaX: 1000,
      deltaY: 0,
      displayScale: 1,
      boundsWidth: 100,
      boundsHeight: 100,
      canvasWidth: 1920,
      canvasHeight: 1080,
      lockAspectRatio: true,
      snappingEnabled: false,
    });
    expect(result.transform.scale).toEqual({ x: 0.1, y: 0.1 });
  });

  it.each([
    ["clip", "clip"] as const,
    ["text-clip", "text"] as const,
    ["shape-clip", "shape"] as const,
  ])(
    "commits the final %s transform when mouseup wins the RAF race",
    (target, handlerName) => {
    const handlers = { clip: vi.fn(), text: vi.fn(), shape: vi.fn() };
    const pending: PendingCanvasTransformRef = {
      current: {
        target,
        targetId: "target-1",
        transform: { position: { x: 0.62, y: 0.4 } },
      },
    };
    const queuedRaf = () =>
      commitPendingCanvasTransform(pending, handlers);

    expect(commitPendingCanvasTransform(pending, handlers)).toBe(true);
    expect(queuedRaf()).toBe(false);
    expect(handlers[handlerName]).toHaveBeenCalledOnce();
    expect(handlers[handlerName]).toHaveBeenCalledWith("target-1", {
      position: { x: 0.62, y: 0.4 },
    });
    expect(
      Object.values(handlers).reduce(
        (count, handler) => count + handler.mock.calls.length,
        0,
      ),
    ).toBe(1);
  });
});
