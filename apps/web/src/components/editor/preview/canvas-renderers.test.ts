import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAnimatedTransform,
  renderTextClipToCanvas,
} from "./canvas-renderers";
import { type ClipTransform } from "./types";
import { titleEngine, type Keyframe, type TextClip } from "@reelterminal/core";
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

    expect(renderText).toHaveBeenCalledWith(clip, 1920, 1080, 1.25);
    expect(drawImage).toHaveBeenCalledWith(
      renderedCanvas,
      0,
      0,
      1920,
      1080,
    );
  });
});
