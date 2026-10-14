import { expect, it } from "vitest";
import { createTransformMatrix } from "./index";

it("maps editor positive-down pixel positions to WebGPU positive-up clip space", () => {
  for (const position of [{ x: 500, y: -250 }, { x: -500, y: 250 }]) {
    const m = createTransformMatrix(position, { x: .3, y: .3 }, 0, { x: .5, y: .5 }, 1920, 1080);
    const center = { x: (m[12]! + 1) * 1920 / 2, y: (1 - m[13]!) * 1080 / 2 };
    expect(center.x).toBeCloseTo(960 + position.x, 3);
    expect(center.y).toBeCloseTo(540 + position.y, 3);
  }
});
