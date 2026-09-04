import { describe, expect, it } from "vitest";
import { changedPixelRegion, changedPixelRegions } from "./visual-state";

function pixels(width: number, height: number): ImageData {
  return {
    width,
    height,
    colorSpace: "srgb",
    data: new Uint8ClampedArray(width * height * 4),
  } as ImageData;
}

describe("visual state pixel deltas", () => {
  it("omits an image when the state board is visually unchanged", () => {
    expect(changedPixelRegion(pixels(64, 64), pixels(64, 64))).toBeNull();
  });

  it("pads and aligns a small changed area to 32px image patches", () => {
    const before = pixels(96, 64);
    const after = pixels(96, 64);
    const offset = (20 * after.width + 40) * 4;
    after.data[offset] = 255;
    expect(changedPixelRegion(before, after)).toEqual({
      x: 0,
      y: 0,
      width: 64,
      height: 64,
    });
  });

  it("returns a full region when dimensions change", () => {
    expect(changedPixelRegion(pixels(32, 32), pixels(64, 32))).toEqual({
      x: 0,
      y: 0,
      width: 64,
      height: 32,
    });
  });

  it("keeps disjoint preview and timeline changes as compact tiles", () => {
    const before = pixels(960, 540);
    const after = pixels(960, 540);
    after.data[(100 * 960 + 100) * 4] = 255;
    after.data[(450 * 960 + 100) * 4] = 255;
    expect(changedPixelRegions(before, after)).toEqual([
      { x: 64, y: 64, width: 64, height: 64 },
      { x: 64, y: 416, width: 64, height: 64 },
    ]);
  });
});
