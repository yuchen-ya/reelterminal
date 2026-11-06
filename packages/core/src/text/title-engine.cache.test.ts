import { afterEach, describe, expect, it, vi } from "vitest";
import { TitleEngine } from "./title-engine";

describe("static title rendering", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reuses static glyphs while keeping results independent and invalidating changes", () => {
    const fillText = vi.fn();
    const measureText = vi.fn(() => ({ width: 42 }));
    const drawImage = vi.fn();
    class Canvas {
      constructor(public width: number, public height: number) {}
      getContext() {
        return {
          clearRect() {}, save() {}, restore() {}, scale() {}, translate() {}, rotate() {},
          fillRect() {}, strokeText() {}, fillText, measureText, drawImage,
        };
      }
    }
    const fonts = new Set<object>();
    const fontSet = Object.assign(fonts, { status: "loaded" });
    vi.stubGlobal("document", { fonts: fontSet });
    vi.stubGlobal("OffscreenCanvas", Canvas);

    const engine = new TitleEngine();
    const clip = engine.createTextClip({ trackId: "titles", startTime: 0, text: "字幕" });
    const first = engine.renderText(clip, 320, 180, 0);
    const measured = measureText.mock.calls.length;
    const second = engine.renderText(clip, 320, 180, 1);
    expect(fillText).toHaveBeenCalledTimes(1);
    expect(measureText).toHaveBeenCalledTimes(measured);
    expect(second.canvas).not.toBe(first.canvas);
    expect(second.textMetrics).not.toBe(first.textMetrics);

    // Mutating a returned surface or metrics cannot corrupt the cached copy.
    first.canvas.width = 0;
    Reflect.set(first.textMetrics.lines[0], "width", 0);
    expect(engine.renderText(clip, 320, 180, 2).textMetrics.lines[0].width).toBe(42);

    engine.renderText({ ...clip, text: "新字幕" }, 320, 180, 2);
    engine.renderText(clip, 640, 360, 2);
    engine.renderText(clip, 320, 180, 2, { width: 640, height: 360 });
    engine.renderText({ ...clip, style: { ...clip.style, fontSize: 40 } }, 320, 180, 2);
    expect(fillText).toHaveBeenCalledTimes(5);

    const face = { status: "loaded", family: "Custom", weight: "400" };
    fonts.add(face);
    engine.renderText(clip, 320, 180, 2);
    face.weight = "700";
    engine.renderText(clip, 320, 180, 2);
    fonts.delete(face);
    engine.renderText(clip, 320, 180, 2);
    expect(fillText).toHaveBeenCalledTimes(8);

    fontSet.status = "loading";
    engine.renderText(clip, 320, 180, 2);
    engine.renderText(clip, 320, 180, 2);
    expect(fillText).toHaveBeenCalledTimes(10);
    fontSet.status = "loaded";
    engine.clear();
    engine.renderText(clip, 320, 180, 2);
    expect(fillText).toHaveBeenCalledTimes(11);
    const animated = {
      ...clip,
      animation: { preset: "fade" as const, inDuration: 1, outDuration: 1, params: {} },
    };
    engine.renderText(animated, 320, 180, 0.5);
    engine.renderText(animated, 320, 180, 0.8);
    expect(fillText).toHaveBeenCalledTimes(13);

    // Two 16 MiB entries fit; adding a third evicts the least recently used.
    engine.clear();
    engine.renderText(clip, 2048, 2048, 0);
    engine.renderText({ ...clip, text: "B" }, 2048, 2048, 0);
    engine.renderText(clip, 2048, 2048, 1);
    engine.renderText({ ...clip, text: "C" }, 2048, 2048, 0);
    engine.renderText({ ...clip, text: "B" }, 2048, 2048, 1);
    expect(fillText).toHaveBeenCalledTimes(17);
    expect(drawImage).toHaveBeenCalled();
  });
});
