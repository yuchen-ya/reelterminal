import { describe, expect, it } from "vitest";
import { bt709PlaneRgba } from "./accurate-video-frame";

describe("limited BT.709 frame conversion", () => {
  // Known source-plane samples and normal GPU reference pixels, including
  // head/footroom that must not be clipped before matrix conversion.
  it.each([
    [[62, 102, 239], [253, 0, 0]], [[172, 42, 26], [0, 254, 0]],
    [[31, 239, 117], [0, 0, 252]], [[128, 128, 128], [130, 130, 130]],
    [[100, 150, 80], [12, 119, 144]], [[10, 180, 128], [0, 0, 103]],
    [[240, 16, 128], [255, 255, 24]],
  ])("matches reference %j", (yuv, rgb) => {
    const result = bt709PlaneRgba(new Uint8Array(yuv), [{ offset: 0, stride: 1 }, { offset: 1, stride: 1 }, { offset: 2, stride: 1 }], 1, 1, "I420");
    expect([...result]).toEqual([...rgb, 255]);
  });

  it("uses cropped-copy plane offsets, row strides, odd chroma sizes and alpha", () => {
    const data = new Uint8Array(42).fill(99);
    for (const index of [2, 3, 4, 7, 8, 9, 12, 13, 14]) data[index] = 31;
    for (const index of [17, 18, 21, 22]) data[index] = 239;
    for (const index of [25, 26, 29, 30]) data[index] = 117;
    for (const index of [32, 33, 34, 35, 36, 37, 38, 39, 40]) data[index] = index - 32;
    const rgba = bt709PlaneRgba(data, [{ offset: 2, stride: 5 }, { offset: 17, stride: 4 }, { offset: 25, stride: 4 }, { offset: 32, stride: 3 }], 3, 3, "I420A");
    for (let index = 0; index < 9; index++) expect([...rgba.slice(index * 4, index * 4 + 4)]).toEqual([0, 0, 252, index]);
  });

  it("handles interleaved NV12 chroma without switching U and V", () => {
    const rgba = bt709PlaneRgba(new Uint8Array([31, 31, 31, 31, 239, 117]), [{ offset: 0, stride: 2 }, { offset: 4, stride: 2 }], 2, 2, "NV12");
    expect([...rgba]).toEqual(Array.from({ length: 4 }, () => [0, 0, 252, 255]).flat());
  });

  it("respects 4:2:2 and 4:4:4 chroma block boundaries", () => {
    expect([...bt709PlaneRgba(new Uint8Array([31, 31, 62, 239, 102, 117, 239]), [{ offset: 0, stride: 3 }, { offset: 3, stride: 2 }, { offset: 5, stride: 2 }], 3, 1, "I422")])
      .toEqual([0, 0, 252, 255, 0, 0, 252, 255, 253, 0, 0, 255]);
    expect([...bt709PlaneRgba(new Uint8Array([31, 62, 239, 102, 117, 239]), [{ offset: 0, stride: 2 }, { offset: 2, stride: 2 }, { offset: 4, stride: 2 }], 2, 1, "I444")])
      .toEqual([0, 0, 252, 255, 253, 0, 0, 255]);
  });

  it("rejects a truncated plane instead of publishing uninitialized pixels", () => {
    expect(() => bt709PlaneRgba(new Uint8Array(2), [{ offset: 0, stride: 1 }, { offset: 1, stride: 1 }, { offset: 2, stride: 1 }], 1, 1, "I420")).toThrow("exceeds");
  });
});
