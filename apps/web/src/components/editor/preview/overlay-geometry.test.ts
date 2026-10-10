import { describe, expect, it } from "vitest";
import { computeLetterboxGeometry } from "./overlay-geometry";

describe("computeLetterboxGeometry", () => {
  it("letterboxes top/bottom-free wide elements (horizontal bars)", () => {
    // Canvas 16:9 inside a wider 2:1 element: content is pillarboxed
    // (bars left/right), full element height is used.
    // canvasAspect = 1920/1080 = 16/9; elementAspect = 2000/1000 = 2 > 16/9
    // actualHeight = 1000; actualWidth = 1000 * 16/9 = 16000/9
    // letterboxOffsetX = (2000 - 16000/9) / 2 = 1000/9
    // displayScale = (16000/9) / 1920 = 25/27
    const geo = computeLetterboxGeometry(1920, 1080, 2000, 1000);
    expect(geo.actualHeight).toBe(1000);
    expect(geo.actualWidth).toBeCloseTo(16000 / 9, 10);
    expect(geo.letterboxOffsetX).toBeCloseTo(1000 / 9, 10);
    expect(geo.letterboxOffsetY).toBe(0);
    expect(geo.displayScale).toBeCloseTo(25 / 27, 10);
  });

  it("letterboxes left/right-free tall elements (vertical bars)", () => {
    // Canvas 16:9 inside a narrower 5:6 element: content is letterboxed
    // (bars top/bottom), full element width is used.
    // elementAspect = 1000/1200 < 16/9
    // actualWidth = 1000; actualHeight = 1000 / (16/9) = 562.5
    // letterboxOffsetY = (1200 - 562.5) / 2 = 318.75
    // displayScale = 1000 / 1920
    const geo = computeLetterboxGeometry(1920, 1080, 1000, 1200);
    expect(geo.actualWidth).toBe(1000);
    expect(geo.actualHeight).toBeCloseTo(562.5, 10);
    expect(geo.letterboxOffsetX).toBe(0);
    expect(geo.letterboxOffsetY).toBeCloseTo(318.75, 10);
    expect(geo.displayScale).toBeCloseTo(1000 / 1920, 10);
  });

  it("centers with zero offsets for equal aspect and scales by elementWidth/canvasWidth", () => {
    // Half-resolution 16:9 element over a 16:9 canvas: the strict `>`
    // comparison takes the else branch, giving full-cover geometry.
    const geo = computeLetterboxGeometry(1280, 720, 640, 360);
    expect(geo.actualWidth).toBe(640);
    expect(geo.actualHeight).toBe(360);
    expect(geo.letterboxOffsetX).toBe(0);
    expect(geo.letterboxOffsetY).toBe(0);
    expect(geo.displayScale).toBe(0.5);
  });

  it("reproduces the original zero-size guards (NaN/Infinity propagation)", () => {
    // canvasWidth = 0: canvasAspect = 0, wide branch -> actualWidth = 0,
    // displayScale = 0/0 = NaN, offset centers the empty content.
    const zeroCanvasWidth = computeLetterboxGeometry(0, 1080, 1920, 1080);
    expect(zeroCanvasWidth.actualWidth).toBe(0);
    expect(zeroCanvasWidth.letterboxOffsetX).toBe(960);
    expect(Number.isNaN(zeroCanvasWidth.displayScale)).toBe(true);

    // canvasHeight = 0: canvasAspect = Infinity, narrow branch ->
    // actualHeight = 0, offsetY = elementHeight / 2, scale stays finite.
    const zeroCanvasHeight = computeLetterboxGeometry(1920, 0, 1920, 1080);
    expect(zeroCanvasHeight.actualHeight).toBe(0);
    expect(zeroCanvasHeight.letterboxOffsetY).toBe(540);
    expect(zeroCanvasHeight.displayScale).toBe(1);

    // elementWidth = 0: elementAspect = 0, narrow branch -> all-zero content
    // centered vertically, displayScale = 0.
    const zeroElementWidth = computeLetterboxGeometry(1920, 1080, 0, 1080);
    expect(zeroElementWidth.actualWidth).toBe(0);
    expect(zeroElementWidth.actualHeight).toBe(0);
    expect(zeroElementWidth.letterboxOffsetY).toBe(540);
    expect(zeroElementWidth.displayScale).toBe(0);

    // Both canvas dimensions zero: canvasAspect = NaN, comparisons are false,
    // narrow branch -> NaN height/offset and Infinite scale.
    const zeroCanvas = computeLetterboxGeometry(0, 0, 1920, 1080);
    expect(Number.isNaN(zeroCanvas.actualHeight)).toBe(true);
    expect(Number.isNaN(zeroCanvas.letterboxOffsetY)).toBe(true);
    expect(zeroCanvas.displayScale).toBe(Infinity);
  });
});
