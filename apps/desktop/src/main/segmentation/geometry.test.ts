import { describe, expect, it } from "vitest";
import { displaySize, frameCacheKey, orientedRgb, promptTensors, validateRequest } from "./geometry";
import type { SegmentationFrame } from "./types";

const frame: SegmentationFrame = {
  id: "task-a/image", revision: "v1", width: 2, height: 3, rotation: 0,
  rgba: Uint8Array.from([1,2,3,255, 4,5,6,255, 7,8,9,255, 10,11,12,255, 13,14,15,255, 16,17,18,255]),
};

describe("oriented display geometry", () => {
  it.each([
    [0, 2, 3, [1,4,7,10,13,16]],
    [90, 3, 2, [13,7,1,16,10,4]],
    [180, 2, 3, [16,13,10,7,4,1]],
    [270, 3, 2, [4,10,16,1,7,13]],
  ] as const)("rotates %s° clockwise before model preprocessing", (rotation, width, height, red) => {
    const rotated = { ...frame, rotation };
    expect(displaySize(rotated)).toEqual({ width, height });
    const rgb = orientedRgb(rotated);
    expect([...rgb.filter((_, index) => index % 3 === 0)]).toEqual(red);
    expect([...rgb.filter((_, index) => index % 3 === 1)]).toEqual(red.map(value => value + 1));
    expect([...rgb.filter((_, index) => index % 3 === 2)]).toEqual(red.map(value => value + 2));
  });

  it("maps normalized display x/y independently to pixel width/height, with positive, negative and box labels", () => {
    const result = promptTensors({
      points: [{ x: 0.25, y: 0.75, foreground: true }, { x: 1, y: 0, foreground: false }],
      box: { left: 0.1, top: 0.2, right: 0.9, bottom: 0.8 },
    }, 200, 100);
    const expected = [256,384,1024,0,102.4,102.4,921.6,409.6];
    result.coords.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 3));
    expect([...result.labels]).toEqual([1,0,2,3]);
    expect([...promptTensors({ points: [{ x: 0.5, y: 0.5, foreground: true }] }, 200, 100).labels]).toEqual([1,-1]);
  });

  it("invalidates embeddings when image identity, pixels, dimensions or orientation change", () => {
    const key = frameCacheKey(frame);
    for (const change of [{ id: "task-b/image" }, { revision: "v2" }, { width: 3, height: 2 }, { rotation: 90 as const }]) {
      expect(frameCacheKey({ ...frame, ...change })).not.toBe(key);
    }
  });

  it("rejects bad pixels, invalid coordinates and excess prompts instead of silently truncating", () => {
    const point = { x: 0.5, y: 0.5, foreground: true };
    expect(() => validateRequest({ frame, refinementId: "edit", prompts: { points: [point] } })).not.toThrow();
    expect(() => validateRequest({ frame: { ...frame, rgba: new Uint8Array(4) }, refinementId: "edit", prompts: { points: [point] } })).toThrow(/frame/);
    expect(() => validateRequest({ frame, refinementId: "edit", prompts: { points: [{ ...point, x: NaN }] } })).toThrow(/normalized/);
    expect(() => validateRequest({ frame, refinementId: "edit", prompts: { points: Array(8).fill(point) } })).not.toThrow();
    expect(() => validateRequest({ frame, refinementId: "edit", prompts: { points: Array(33).fill(point) } })).toThrow(/1–32/);
    expect(() => validateRequest({ frame, refinementId: "edit", prompts: { points: Array(31).fill(point), box: { left: 0, top: 0, right: 1, bottom: 1 } } })).toThrow(/two/);
    expect(() => validateRequest({ frame, refinementId: "edit", prompts: { points: [] } })).toThrow();
  });
});
