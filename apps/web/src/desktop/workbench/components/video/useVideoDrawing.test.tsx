import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type React from "react";
import { useVideoDrawing } from "./useVideoDrawing";

it("draws a nested box and selects an existing box only on click release", () => {
  const onAnnotationCreated = vi.fn();
  const onSelectAnchor = vi.fn();
  const surface = {
    getBoundingClientRect: () => new DOMRect(0, 0, 100, 100),
    setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn(), focus: vi.fn(),
  } as unknown as HTMLDivElement;
  const { result } = renderHook(() => useVideoDrawing({
    stageRef: { current: surface }, videoRef: { current: null }, videoReady: true,
    videoSize: { w: 100, h: 100 }, activeAnnotations: [{ id: "large", color: "#f43f5e", tool: "box", x: 0.1, y: 0.1, w: 0.8, h: 0.8 }],
    drawTool: "box", realTime: () => 0, makeId: () => "nested", onAnnotationCreated, onSelectAnchor,
  }));
  const event = (x: number, y: number) => ({ currentTarget: surface, button: 0, pointerId: 1, clientX: x, clientY: y }) as React.PointerEvent<HTMLDivElement>;
  act(() => result.current.handleStagePointerDown(event(20, 20)));
  expect(onSelectAnchor).not.toHaveBeenCalled();
  act(() => result.current.handleStagePointerMove(event(40, 40)));
  act(() => result.current.handleStagePointerUp(event(40, 40)));
  expect(onAnnotationCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "nested", x: 0.2, y: 0.2, w: 0.2, h: 0.2 }), 0);
  act(() => result.current.handleStagePointerDown(event(25, 25)));
  act(() => result.current.handleStagePointerUp(event(25, 25)));
  expect(onSelectAnchor).toHaveBeenCalledWith("large");
  expect(onAnnotationCreated).toHaveBeenCalledTimes(1);
});
