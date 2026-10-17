import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAnimatedTransform,
  renderSubtitleToCanvas,
  renderTextClipToCanvas,
} from "./canvas-renderers";
import { type ClipTransform } from "./types";
import {
  titleEngine,
  type Keyframe,
  type Subtitle,
  type TextClip,
} from "@reelterminal/core";
afterEach(() => {
  vi.restoreAllMocks();
});

describe("getAnimatedTransform", () => {
  const baseTransform: ClipTransform = {
    position: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    opacity: 1,
    anchor: { x: 0.5, y: 0.5 },
    borderRadius: 0,
  };

  it("should return base transform when no keyframes", () => {
    const result = getAnimatedTransform(baseTransform, [], 0);
    expect(result).toEqual(baseTransform);
  });

  it("should return base transform when keyframes is undefined", () => {
    const result = getAnimatedTransform(baseTransform, undefined, 0);
    expect(result).toEqual(baseTransform);
  });

  it("should interpolate position keyframes", () => {
    const keyframes: Keyframe[] = [
      { id: "1", property: "position.x", time: 0, value: 0, easing: "linear" },
      { id: "2", property: "position.x", time: 1, value: 100, easing: "linear" },
    ];

    const result = getAnimatedTransform(baseTransform, keyframes, 0.5);
    expect(result.position.x).toBeCloseTo(50, 1);
  });

  it("should preserve transform position at time 0", () => {
    const customTransform: ClipTransform = {
      ...baseTransform,
      position: { x: 100, y: 50 },
    };

    const result = getAnimatedTransform(customTransform, [], 0);
    expect(result.position.x).toBe(100);
    expect(result.position.y).toBe(50);
  });

  it("should preserve transform position regardless of clipLocalTime when no keyframes", () => {
    const customTransform: ClipTransform = {
      ...baseTransform,
      position: { x: 200, y: 150 },
    };

    const times = [0, 0.5, 1, 2, 5, 10];
    for (const time of times) {
      const result = getAnimatedTransform(customTransform, [], time);
      expect(result.position.x).toBe(200);
      expect(result.position.y).toBe(150);
    }
  });
});

describe("Playback Transform Consistency", () => {
  it("transform should be identical during playback regardless of speed", () => {
    const clipTransform: ClipTransform = {
      position: { x: 100, y: -50 },
      scale: { x: 1.5, y: 1.5 },
      rotation: 45,
      opacity: 0.8,
      anchor: { x: 0.5, y: 0.5 },
      borderRadius: 10,
    };

    const speed1xTransform = getAnimatedTransform(clipTransform, [], 2.5);
    const speed2xTransform = getAnimatedTransform(clipTransform, [], 2.5);

    expect(speed1xTransform).toEqual(speed2xTransform);
    expect(speed1xTransform.position).toEqual(clipTransform.position);
  });
});

describe("text preview/export renderer parity", () => {
  it("routes Paper-shader text through the shared title renderer", () => {
    const renderedCanvas = document.createElement("canvas");
    const renderText = vi.spyOn(titleEngine, "renderText").mockReturnValue({
      canvas: renderedCanvas,
      width: 1920,
      height: 1080,
      textMetrics: { width: 100, height: 40, lines: [] },
    });
    const drawImage = vi.fn();
    const clip: TextClip = {
      id: "paper-text",
      trackId: "text-track",
      startTime: 2,
      duration: 5,
      text: "Paper title",
      style: {
        fontFamily: "Inter",
        fontSize: 72,
        fontWeight: 700,
        fontStyle: "normal",
        color: "#ffffff",
        textAlign: "center",
        verticalAlign: "middle",
        lineHeight: 1.2,
        letterSpacing: 0,
        shader: {
          shaderId: "paper-mesh-gradient",
          params: {
            color1: "#e0eaff",
            color2: "#241d9a",
          },
        },
      },
      transform: {
        position: { x: 0.5, y: 0.5 },
        scale: { x: 1, y: 1 },
        rotation: 0,
        anchor: { x: 0.5, y: 0.5 },
        opacity: 1,
      },
      keyframes: [],
    };

    renderTextClipToCanvas(
      { drawImage } as unknown as CanvasRenderingContext2D,
      clip,
      1920,
      1080,
      3.25,
    );

    expect(renderText).toHaveBeenCalledWith(clip, 1920, 1080, 1.25, {
      width: 1920,
      height: 1080,
    });
    expect(drawImage).toHaveBeenCalledWith(
      renderedCanvas,
      0,
      0,
      1920,
      1080,
    );
  });
});

// A 3840x2160 project on Auto quality previews at 960x540
// (PREVIEW_MAX_DIMENSION 1920 * auto scale 0.5 = 960). Text styles live in
// project pixels, so the renderers must receive the project size as the
// layout space or fonts rasterize 4x too large and overlap/overflow the
// preview canvas.
const PROJECT_4K = { width: 3840, height: 2160 } as const;
const PREVIEW_QUARTER = { width: 960, height: 540 } as const;

function plainTextClip(): TextClip {
  return {
    id: "layout-size-text",
    trackId: "text-track",
    startTime: 0,
    duration: 5,
    text: "Quarter-scale title",
    style: {
      fontFamily: "Inter",
      fontSize: 164,
      fontWeight: 700,
      fontStyle: "normal",
      color: "#ffffff",
      textAlign: "center",
      verticalAlign: "middle",
      lineHeight: 1.2,
      letterSpacing: 0,
    },
    transform: {
      position: { x: 0.5, y: 0.5 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      anchor: { x: 0.5, y: 0.5 },
      opacity: 1,
    },
    keyframes: [],
  };
}

interface RecordedSubtitleContext {
  ctx: CanvasRenderingContext2D;
  scale: ReturnType<typeof vi.fn>;
  font: string[];
  fillText: ReturnType<typeof vi.fn>;
  fillRect: ReturnType<typeof vi.fn>;
}

function recordingSubtitleContext(
  charWidth = 100,
): RecordedSubtitleContext {
  const scale = vi.fn();
  const fillText = vi.fn();
  const fillRect = vi.fn();
  const font: string[] = [];
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    scale,
    fillText,
    fillRect,
    measureText: (text: string) => ({ width: text.length * charWidth }),
    get font() {
      return font[0] ?? "";
    },
    set font(value: string) {
      font[0] = value;
    },
    textAlign: "center",
    textBaseline: "middle",
    fillStyle: "",
    globalAlpha: 1,
    translate: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
  return { ctx, scale, font, fillText, fillRect };
}

describe("text layout scaling for downscaled previews", () => {
  it("passes the project layout size to the shared title renderer", () => {
    const renderedCanvas = document.createElement("canvas");
    const renderText = vi.spyOn(titleEngine, "renderText").mockReturnValue({
      canvas: renderedCanvas,
      width: PREVIEW_QUARTER.width,
      height: PREVIEW_QUARTER.height,
      textMetrics: { width: 100, height: 40, lines: [] },
    });
    const clip = plainTextClip();

    renderTextClipToCanvas(
      { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D,
      clip,
      PREVIEW_QUARTER.width,
      PREVIEW_QUARTER.height,
      1.25,
      PROJECT_4K,
    );

    // Raster canvas stays at the preview size; layout stays in project
    // pixels — the same contract the export path relies on.
    expect(renderText).toHaveBeenCalledWith(
      clip,
      PREVIEW_QUARTER.width,
      PREVIEW_QUARTER.height,
      1.25,
      { width: PROJECT_4K.width, height: PROJECT_4K.height },
    );
  });

  it("defaults the layout size to the canvas size when omitted", () => {
    const renderText = vi.spyOn(titleEngine, "renderText").mockReturnValue({
      canvas: document.createElement("canvas"),
      width: PREVIEW_QUARTER.width,
      height: PREVIEW_QUARTER.height,
      textMetrics: { width: 0, height: 0, lines: [] },
    });

    renderTextClipToCanvas(
      { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D,
      plainTextClip(),
      PREVIEW_QUARTER.width,
      PREVIEW_QUARTER.height,
      1.25,
    );

    expect(renderText).toHaveBeenCalledWith(
      expect.anything(),
      PREVIEW_QUARTER.width,
      PREVIEW_QUARTER.height,
      1.25,
      { width: PREVIEW_QUARTER.width, height: PREVIEW_QUARTER.height },
    );
  });
});

describe("subtitle layout scaling for downscaled previews", () => {
  function subtitleFixture(overrides?: Partial<Subtitle>): Subtitle {
    return {
      id: "sub-1",
      text: "hello",
      startTime: 0,
      endTime: 2,
      style: {
        fontFamily: "Inter",
        fontSize: 164,
        color: "#ffffff",
        backgroundColor: "rgba(0, 0, 0, 0.7)",
        position: "bottom",
      },
      ...overrides,
    };
  }

  it("scales static subtitles from project pixels into the preview canvas", () => {
    const { ctx, scale, font, fillText, fillRect } = recordingSubtitleContext();

    renderSubtitleToCanvas(
      ctx,
      subtitleFixture(),
      PREVIEW_QUARTER.width,
      PREVIEW_QUARTER.height,
      1,
      PROJECT_4K,
    );

    expect(scale).toHaveBeenCalledWith(0.25, 0.25);
    expect(font[0]).toBe('bold 164px "Inter"');
    // Layout coordinates stay in project space: centered on x=1920, bottom
    // anchor at 2160 - 2*164 - 164*1.3 (+ half line) ≈ y 1725.4.
    expect(fillText).toHaveBeenCalledTimes(1);
    expect(fillText.mock.calls[0][0]).toBe("hello");
    expect(fillText.mock.calls[0][1]).toBe(1920);
    expect(fillText.mock.calls[0][2]).toBeCloseTo(1725.4, 5);
    const [rectX, rectY, rectW, rectH] = fillRect.mock.calls[0];
    expect(rectX).toBeCloseTo(1920 - (5 * 100 + 20) / 2, 5);
    expect(rectY).toBeCloseTo(1725.4 - (164 * 1.3) / 2, 5);
    expect(rectW).toBe(5 * 100 + 20);
    expect(rectH).toBeCloseTo(164 * 1.3, 5);
  });

  it("keeps animated subtitles in project pixels too", () => {
    const { ctx, scale, font, fillText } = recordingSubtitleContext();
    const subtitle = subtitleFixture({
      animationStyle: "word-by-word",
      words: [
        { text: "hello", startTime: 0, endTime: 1 },
        { text: "world", startTime: 1, endTime: 2 },
      ],
    });

    renderSubtitleToCanvas(
      ctx,
      subtitle,
      PREVIEW_QUARTER.width,
      PREVIEW_QUARTER.height,
      0.5,
      PROJECT_4K,
    );

    expect(scale).toHaveBeenCalledWith(0.25, 0.25);
    expect(font[0]).toBe('bold 164px "Inter"');
    expect(fillText).toHaveBeenCalled();
    // The first word is drawn left of the project-space center.
    const [, x] = fillText.mock.calls[0];
    expect(x).toBeLessThan(1920);
  });

  it("is a no-op scale when no layout size is provided", () => {
    const { ctx, scale, fillText } = recordingSubtitleContext();

    renderSubtitleToCanvas(
      ctx,
      subtitleFixture(),
      PREVIEW_QUARTER.width,
      PREVIEW_QUARTER.height,
      1,
    );

    expect(scale).toHaveBeenCalledWith(1, 1);
    // Without a layout size the font stays 164px on a 540px canvas — the
    // overlapping-text bug this suite guards against.
    expect(fillText.mock.calls[0][1]).toBe(480);
    expect(fillText.mock.calls[0][2]).toBeCloseTo(105.4, 5);
  });
});
