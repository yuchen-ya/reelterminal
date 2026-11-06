import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { GraphicsEngine } from "./graphics-engine";
import type { EmphasisAnimation, SVGClip } from "./types";
import type { EasingType } from "../types/timeline";

class MockCanvasContext {
  save = vi.fn();
  restore = vi.fn();
  clearRect = vi.fn();
  fillRect = vi.fn();
  translate = vi.fn();
  rotate = vi.fn();
  scale = vi.fn();
  beginPath = vi.fn();
  closePath = vi.fn();
  fill = vi.fn();
  stroke = vi.fn();
  arc = vi.fn();
  moveTo = vi.fn();
  lineTo = vi.fn();
  ellipse = vi.fn();
  quadraticCurveTo = vi.fn();
  rect = vi.fn();
  createLinearGradient = vi.fn(() => ({
    addColorStop: vi.fn(),
  }));
  createRadialGradient = vi.fn(() => ({
    addColorStop: vi.fn(),
  }));
  setLineDash = vi.fn();
  drawImage = vi.fn();
  globalAlpha = 1;
  globalCompositeOperation = "source-over";
  fillStyle = "";
  strokeStyle = "";
  lineWidth = 1;
  lineCap: CanvasLineCap = "butt";
  lineJoin: CanvasLineJoin = "miter";
  lineDashOffset = 0;
  shadowColor = "";
  shadowBlur = 0;
  shadowOffsetX = 0;
  shadowOffsetY = 0;
  filter = "";
}

class MockCanvas {
  width = 1920;
  height = 1080;
  private ctx = new MockCanvasContext();
  getContext() {
    return this.ctx;
  }
}

vi.stubGlobal("OffscreenCanvas", MockCanvas);
vi.stubGlobal("HTMLCanvasElement", class {});

describe("GraphicsEngine", () => {
  let engine: GraphicsEngine;

  beforeEach(() => {
    engine = new GraphicsEngine();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("shape creation and management", () => {
    it("should create a rectangle shape with correct properties", () => {
      const clip = engine.createRectangle("track-1", 0, 5, 100, 50);

      expect(clip.id).toBeDefined();
      expect(clip.id.length).toBeGreaterThan(0);
      expect(clip.shapeType).toBe("rectangle");
      expect(clip.trackId).toBe("track-1");
      expect(clip.startTime).toBe(0);
      expect(clip.duration).toBe(5);
      expect(clip.type).toBe("shape");
      expect(clip.transform).toBeDefined();
      expect(clip.transform.position).toBeDefined();
      expect(clip.transform.scale).toBeDefined();
      expect(clip.transform.rotation).toBeDefined();
      expect(clip.transform.opacity).toBeDefined();
      expect(clip.keyframes).toEqual([]);
    });

    it("should create unique IDs for each shape", () => {
      const clip1 = engine.createRectangle("track-1", 0, 5, 100, 50);
      const clip2 = engine.createRectangle("track-1", 0, 5, 100, 50);
      const clip3 = engine.createCircle("track-1", 0, 5, 50);

      expect(clip1.id).not.toBe(clip2.id);
      expect(clip2.id).not.toBe(clip3.id);
      expect(clip1.id).not.toBe(clip3.id);
    });

    it("should create a circle shape", () => {
      const clip = engine.createCircle("track-1", 0, 5, 50);

      expect(clip.shapeType).toBe("circle");
      expect(clip.type).toBe("shape");
    });

    it("should create an arrow shape", () => {
      const clip = engine.createArrow("track-1", 0, 5, 100, 50);

      expect(clip.shapeType).toBe("arrow");
    });

    it("should update shape clip properties", () => {
      const clip = engine.createRectangle("track-1", 0, 5, 100, 50);
      const updated = engine.updateShapeClip(clip.id, {
        duration: 10,
        transform: {
          ...clip.transform,
          position: { x: 0.25, y: 0.75 },
        },
      });

      expect(updated?.duration).toBe(10);
      expect(updated?.transform.position).toEqual({ x: 0.25, y: 0.75 });
    });

    it("should get shape clip by id", () => {
      const clip = engine.createRectangle("track-1", 0, 5, 100, 50);
      const retrieved = engine.getShapeClip(clip.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(clip.id);
      expect(retrieved?.shapeType).toBe(clip.shapeType);
    });

    it("should get all shape clips", () => {
      engine.createRectangle("track-1", 0, 5, 100, 50);
      engine.createCircle("track-1", 5, 5, 50);

      const clips = engine.getAllShapeClips();

      expect(clips.length).toBe(2);
    });

    it("should get shape clips for specific track", () => {
      engine.createRectangle("track-1", 0, 5, 100, 50);
      engine.createCircle("track-2", 5, 5, 50);
      engine.createRectangle("track-1", 10, 5, 100, 80);

      const track1Clips = engine.getShapeClipsForTrack("track-1");

      expect(track1Clips.length).toBe(2);
      track1Clips.forEach((clip) => {
        expect(clip.trackId).toBe("track-1");
      });
    });

    it("should delete shape clip", () => {
      const clip = engine.createRectangle("track-1", 0, 5, 100, 50);
      const deleteResult = engine.deleteShapeClip(clip.id);

      expect(deleteResult).toBe(true);
      const retrieved = engine.getShapeClip(clip.id);
      expect(retrieved).toBeUndefined();
    });

    it("should return undefined when updating non-existent clip", () => {
      const result = engine.updateShapeClip("non-existent", { duration: 10 });
      expect(result).toBeUndefined();
    });

    it("should return false when deleting non-existent clip", () => {
      const result = engine.deleteShapeClip("non-existent");
      expect(result).toBe(false);
    });
  });

  describe("emphasis animation configuration", () => {
    it("should set emphasis animation on shape clip", () => {
      const clip = engine.createRectangle("track-1", 0, 10, 100, 100);
      const animation: EmphasisAnimation = {
        type: "pulse",
        speed: 1,
        intensity: 1,
        loop: true,
      };

      const updated = engine.updateShapeClip(clip.id, {
        emphasisAnimation: animation,
      });

      expect(updated?.emphasisAnimation).toEqual(animation);
    });

    it("should set emphasis animation with startTime", () => {
      const clip = engine.createRectangle("track-1", 0, 10, 100, 100);
      const animation: EmphasisAnimation = {
        type: "shake",
        speed: 1,
        intensity: 1,
        loop: true,
        startTime: 2,
      };

      const updated = engine.updateShapeClip(clip.id, {
        emphasisAnimation: animation,
      });

      expect(updated?.emphasisAnimation?.startTime).toBe(2);
    });

    it("should set emphasis animation with animationDuration", () => {
      const clip = engine.createRectangle("track-1", 0, 10, 100, 100);
      const animation: EmphasisAnimation = {
        type: "bounce",
        speed: 1,
        intensity: 1,
        loop: true,
        startTime: 1,
        animationDuration: 3,
      };

      const updated = engine.updateShapeClip(clip.id, {
        emphasisAnimation: animation,
      });

      expect(updated?.emphasisAnimation?.startTime).toBe(1);
      expect(updated?.emphasisAnimation?.animationDuration).toBe(3);
    });

    it("should preserve emphasis animation when updating other properties", () => {
      const clip = engine.createRectangle("track-1", 0, 10, 100, 100);
      const animation: EmphasisAnimation = {
        type: "pulse",
        speed: 2,
        intensity: 0.5,
        loop: false,
        startTime: 1,
        animationDuration: 5,
      };

      engine.updateShapeClip(clip.id, { emphasisAnimation: animation });
      const updated = engine.updateShapeClip(clip.id, { duration: 20 });

      expect(updated?.emphasisAnimation).toEqual(animation);
      expect(updated?.duration).toBe(20);
    });

    it("should support all emphasis animation types", () => {
      const animationTypes: EmphasisAnimation["type"][] = [
        "pulse",
        "shake",
        "bounce",
        "float",
        "spin",
        "flash",
        "heartbeat",
        "swing",
        "wobble",
        "jello",
        "rubber-band",
        "tada",
        "vibrate",
        "flicker",
        "glow",
        "breathe",
        "wave",
        "tilt",
        "zoom-pulse",
        "focus-zoom",
        "pan-left",
        "pan-right",
        "pan-up",
        "pan-down",
        "ken-burns",
        "none",
      ];

      for (const type of animationTypes) {
        const clip = engine.createRectangle("track-1", 0, 5, 100, 50);
        const updated = engine.updateShapeClip(clip.id, {
          emphasisAnimation: {
            type,
            speed: 1,
            intensity: 1,
            loop: true,
          },
        });

        expect(updated?.emphasisAnimation?.type).toBe(type);
      }
    });

    it("should support focus-zoom animation with custom properties", () => {
      const clip = engine.createRectangle("track-1", 0, 10, 100, 100);
      const animation: EmphasisAnimation = {
        type: "focus-zoom",
        speed: 1,
        intensity: 1,
        loop: false,
        focusPoint: { x: 0.3, y: 0.7 },
        zoomScale: 2.0,
        holdDuration: 0.5,
      };

      const updated = engine.updateShapeClip(clip.id, {
        emphasisAnimation: animation,
      });

      expect(updated?.emphasisAnimation?.focusPoint).toEqual({
        x: 0.3,
        y: 0.7,
      });
      expect(updated?.emphasisAnimation?.zoomScale).toBe(2.0);
      expect(updated?.emphasisAnimation?.holdDuration).toBe(0.5);
    });

    it("should handle emphasis animation with zero startTime", () => {
      const clip = engine.createRectangle("track-1", 0, 10, 100, 100);
      const animation: EmphasisAnimation = {
        type: "pulse",
        speed: 1,
        intensity: 1,
        loop: true,
        startTime: 0,
      };

      const updated = engine.updateShapeClip(clip.id, {
        emphasisAnimation: animation,
      });

      expect(updated?.emphasisAnimation?.startTime).toBe(0);
    });

    it("should handle emphasis animation with zero animationDuration", () => {
      const clip = engine.createRectangle("track-1", 0, 10, 100, 100);
      const animation: EmphasisAnimation = {
        type: "shake",
        speed: 1,
        intensity: 1,
        loop: true,
        animationDuration: 0,
      };

      const updated = engine.updateShapeClip(clip.id, {
        emphasisAnimation: animation,
      });

      expect(updated?.emphasisAnimation?.animationDuration).toBe(0);
    });

    it("should handle emphasis animation with varying speed values", () => {
      const speeds = [0.1, 0.5, 1, 2, 5, 10];

      for (const speed of speeds) {
        const clip = engine.createRectangle("track-1", 0, 10, 100, 100);
        const updated = engine.updateShapeClip(clip.id, {
          emphasisAnimation: {
            type: "pulse",
            speed,
            intensity: 1,
            loop: true,
          },
        });

        expect(updated?.emphasisAnimation?.speed).toBe(speed);
      }
    });

    it("should handle emphasis animation with varying intensity values", () => {
      const intensities = [0, 0.1, 0.5, 1, 2, 5];

      for (const intensity of intensities) {
        const clip = engine.createRectangle("track-1", 0, 10, 100, 100);
        const updated = engine.updateShapeClip(clip.id, {
          emphasisAnimation: {
            type: "shake",
            speed: 1,
            intensity,
            loop: true,
          },
        });

        expect(updated?.emphasisAnimation?.intensity).toBe(intensity);
      }
    });
  });

  describe("rendering with emphasis animations", () => {
    it("should render shape with emphasis animation", async () => {
      const clip = engine.createRectangle("track-1", 0, 10, 100, 100);
      engine.updateShapeClip(clip.id, {
        emphasisAnimation: {
          type: "pulse",
          speed: 1,
          intensity: 1,
          loop: true,
        },
      });

      const updatedClip = engine.getShapeClip(clip.id)!;
      const result = await engine.renderGraphic(updatedClip, 0.5, 1920, 1080);

      expect(result.canvas).toBeDefined();
      expect(result.width).toBe(1920);
      expect(result.height).toBe(1080);
    });

    it("should render shape with emphasis animation timing controls", async () => {
      const clip = engine.createRectangle("track-1", 0, 10, 100, 100);
      engine.updateShapeClip(clip.id, {
        emphasisAnimation: {
          type: "shake",
          speed: 1,
          intensity: 1,
          loop: true,
          startTime: 2,
          animationDuration: 3,
        },
      });

      const updatedClip = engine.getShapeClip(clip.id)!;

      const resultBefore = await engine.renderGraphic(
        updatedClip,
        1,
        1920,
        1080,
      );
      expect(resultBefore.canvas).toBeDefined();

      const resultDuring = await engine.renderGraphic(
        updatedClip,
        3,
        1920,
        1080,
      );
      expect(resultDuring.canvas).toBeDefined();

      const resultAfter = await engine.renderGraphic(
        updatedClip,
        6,
        1920,
        1080,
      );
      expect(resultAfter.canvas).toBeDefined();
    });

    it("should render shape to canvas", async () => {
      const clip = engine.createRectangle("track-1", 0, 5, 100, 50);
      const result = await engine.renderGraphic(clip, 0, 1920, 1080);

      expect(result.canvas).toBeDefined();
      expect(result.width).toBe(1920);
      expect(result.height).toBe(1080);
    });

    it("should return empty canvas when opacity is 0", async () => {
      const clip = engine.createRectangle("track-1", 0, 5, 100, 50);
      engine.updateShapeClip(clip.id, {
        transform: {
          ...clip.transform,
          opacity: 0,
        },
      });

      const updatedClip = engine.getShapeClip(clip.id)!;
      const result = await engine.renderGraphic(updatedClip, 0, 1920, 1080);

      expect(result.canvas).toBeDefined();
    });

    it("should render at different time points", async () => {
      const clip = engine.createRectangle("track-1", 0, 10, 100, 100);
      engine.updateShapeClip(clip.id, {
        emphasisAnimation: {
          type: "pulse",
          speed: 1,
          intensity: 1,
          loop: true,
        },
      });

      const updatedClip = engine.getShapeClip(clip.id)!;
      const times = [0, 0.25, 0.5, 0.75, 1, 2, 5, 9.99];

      for (const time of times) {
        const result = await engine.renderGraphic(
          updatedClip,
          time,
          1920,
          1080,
        );
        expect(result.canvas).toBeDefined();
      }
    });

    it("should render at different resolutions", async () => {
      const clip = engine.createRectangle("track-1", 0, 5, 100, 50);
      const resolutions = [
        { width: 640, height: 480 },
        { width: 1280, height: 720 },
        { width: 1920, height: 1080 },
        { width: 3840, height: 2160 },
      ];

      for (const { width, height } of resolutions) {
        const result = await engine.renderGraphic(clip, 0, width, height);
        expect(result.width).toBe(width);
        expect(result.height).toBe(height);
      }
    });
  });

  describe("SVG image reuse", () => {
    const createUrl = vi.fn();
    const revokeUrl = vi.fn();

    beforeEach(() => {
      createUrl.mockImplementation(
        () => `blob:test-${createUrl.mock.calls.length}`,
      );
      vi.stubGlobal("URL", {
        createObjectURL: createUrl,
        revokeObjectURL: revokeUrl,
      });
      vi.stubGlobal(
        "DOMParser",
        class {
          parseFromString() {
            return { querySelector: () => ({ setAttribute: vi.fn() }) };
          }
        },
      );
      vi.stubGlobal(
        "XMLSerializer",
        class {
          serializeToString() {
            return "<svg/>";
          }
        },
      );
      vi.stubGlobal(
        "Image",
        class {
          crossOrigin = "";
          onload: (() => void) | null = null;
          set src(_url: string) {
            queueMicrotask(() => this.onload?.());
          }
        },
      );
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.stubGlobal("OffscreenCanvas", MockCanvas);
      vi.stubGlobal("HTMLCanvasElement", class {});
    });

    function makeClip(): SVGClip {
      const shape = engine.createRectangle("track", 0, 5, 100, 100);
      return {
        ...shape,
        type: "svg",
        svgContent: '<svg viewBox="0 0 100 100"/>',
        viewBox: { minX: 0, minY: 0, width: 100, height: 100 },
        preserveAspectRatio: "xMidYMid",
      };
    }

    it("reuses images across frames while applying each frame's transform and opacity", async () => {
      const clip = makeClip();
      const first = await engine.renderGraphic(clip, 0, 100, 100);
      const moved = {
        ...clip,
        transform: {
          ...clip.transform,
          position: { x: 0.2, y: 0.3 },
          opacity: 0.5,
        },
      };
      const second = await engine.renderGraphic(moved, 1, 100, 100);
      for (let i = 0; i < 100; i++)
        await engine.renderGraphic(clip, i / 30, 100, 100);

      const firstContext = first.canvas.getContext(
        "2d",
      ) as unknown as MockCanvasContext;
      const secondContext = second.canvas.getContext(
        "2d",
      ) as unknown as MockCanvasContext;
      expect(createUrl).toHaveBeenCalledTimes(1);
      expect(revokeUrl).toHaveBeenCalledTimes(1);
      expect(firstContext.drawImage.mock.calls[0][0]).toBe(
        secondContext.drawImage.mock.calls[0][0],
      );
      expect(secondContext.translate).not.toHaveBeenCalledWith(
        ...firstContext.translate.mock.calls[0],
      );
      expect(secondContext.globalAlpha).toBe(0.5);
    });

    it("reloads changed content and raster dimensions and releases the cache on clear", async () => {
      const clip = makeClip();
      await engine.renderGraphic(clip, 0, 100, 100);
      await engine.renderGraphic(
        { ...clip, svgContent: "<svg>changed</svg>" } as SVGClip,
        0,
        100,
        100,
      );
      await engine.renderGraphic(clip, 0, 200, 200);
      expect(createUrl).toHaveBeenCalledTimes(3);
      engine.clearCache();
      await engine.renderGraphic(clip, 0, 100, 100);
      expect(createUrl).toHaveBeenCalledTimes(4);
      expect(revokeUrl).toHaveBeenCalledTimes(4);
    });

    it("evicts older images when the cache reaches its limit", async () => {
      const clip = makeClip();
      for (let i = 0; i < 129; i++) {
        await engine.renderGraphic(
          { ...clip, svgContent: `<svg>${i}</svg>` } as SVGClip,
          0,
          10,
          10,
        );
      }
      await engine.renderGraphic(clip, 0, 10, 10);
      await engine.renderGraphic(
        { ...clip, svgContent: "<svg>0</svg>" } as SVGClip,
        0,
        10,
        10,
      );
      expect(createUrl).toHaveBeenCalledTimes(131);
    });
  });

  describe("sticker image caching", () => {
    let images: Array<{ onload: (() => void) | null; onerror: (() => void) | null }>;

    beforeEach(() => {
      images = [];
      vi.stubGlobal("Image", class {
        crossOrigin = "";
        width = 10;
        height = 10;
        naturalWidth = 10;
        naturalHeight = 10;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        constructor() { images.push(this); }
        set src(_url: string) {}
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.stubGlobal("OffscreenCanvas", MockCanvas);
      vi.stubGlobal("HTMLCanvasElement", class {});
    });

    function sticker(url: string) {
      return { ...engine.createRectangle("track", 0, 5, 10, 10), type: "sticker" as const, imageUrl: url };
    }

    it("shares concurrent loads, retries failures, and does not restore entries cleared while loading", async () => {
      const clip = sticker("image-a");
      const first = engine.renderGraphic(clip, 0, 100, 100);
      const second = engine.renderGraphic(clip, 1, 100, 100);
      expect(images).toHaveLength(1);
      images[0]!.onload!();
      const [a, b] = await Promise.all([first, second]);
      const contextA = a.canvas.getContext("2d") as unknown as MockCanvasContext;
      const contextB = b.canvas.getContext("2d") as unknown as MockCanvasContext;
      expect(contextA.drawImage.mock.calls[0][0]).toBe(contextB.drawImage.mock.calls[0][0]);

      const pending = engine.renderGraphic(sticker("image-b"), 0, 100, 100);
      engine.clearCache();
      images[1]!.onload!();
      await pending;
      const retry = engine.renderGraphic(sticker("image-b"), 0, 100, 100);
      expect(images).toHaveLength(3);
      images[2]!.onerror!();
      await expect(retry).rejects.toThrow("Failed to load image");
      const afterFailure = engine.renderGraphic(sticker("image-b"), 0, 100, 100);
      expect(images).toHaveLength(4);
      images[3]!.onload!();
      await afterFailure;
    });

    it("evicts decoded images when their estimated memory exceeds the limit", async () => {
      const first = engine.renderGraphic(sticker("large-a"), 0, 100, 100);
      Object.assign(images[0]!, { naturalWidth: 4096, naturalHeight: 4096 });
      images[0]!.onload!();
      await first;
      const second = engine.renderGraphic(sticker("large-b"), 0, 100, 100);
      Object.assign(images[1]!, { naturalWidth: 5000, naturalHeight: 5000 });
      images[1]!.onload!();
      await second;
      const reload = engine.renderGraphic(sticker("large-a"), 0, 100, 100);
      expect(images).toHaveLength(3);
      images[2]!.onload!();
      await reload;
    });

    it("evicts least recently used images at the entry limit", async () => {
      for (let i = 0; i < 129; i++) {
        const rendering = engine.renderGraphic(sticker(`image-${i}`), 0, 100, 100);
        images[i]!.onload!();
        await rendering;
      }
      const rendering = engine.renderGraphic(sticker("image-0"), 0, 100, 100);
      expect(images).toHaveLength(130);
      images[129]!.onload!();
      await rendering;
    });
  });

  describe("keyframe animations", () => {
    it("should add keyframe to shape clip", () => {
      const clip = engine.createRectangle("track-1", 0, 5, 100, 50);
      const updated = engine.addKeyframe(clip, {
        id: "kf-1",
        time: 0,
        property: "position.x",
        value: 0.2,
        easing: "linear",
      });

      expect(updated.keyframes.length).toBe(1);
      expect(updated.keyframes[0].id).toBe("kf-1");
      expect(updated.keyframes[0].time).toBe(0);
      expect(updated.keyframes[0].property).toBe("position.x");
      expect(updated.keyframes[0].value).toBe(0.2);
      expect(updated.keyframes[0].easing).toBe("linear");
    });

    it("should add multiple keyframes", () => {
      let clip = engine.createRectangle("track-1", 0, 5, 100, 50);
      clip = engine.addKeyframe(clip, {
        id: "kf-1",
        time: 0,
        property: "position.x",
        value: 0.2,
        easing: "linear",
      });
      clip = engine.addKeyframe(clip, {
        id: "kf-2",
        time: 5,
        property: "position.x",
        value: 0.8,
        easing: "linear",
      });

      expect(clip.keyframes.length).toBe(2);
      expect(clip.keyframes[0].time).toBe(0);
      expect(clip.keyframes[1].time).toBe(5);
    });

    it("should add keyframes for different properties", () => {
      let clip = engine.createRectangle("track-1", 0, 5, 100, 50);
      clip = engine.addKeyframe(clip, {
        id: "kf-x",
        time: 0,
        property: "position.x",
        value: 0.2,
        easing: "linear",
      });
      clip = engine.addKeyframe(clip, {
        id: "kf-y",
        time: 0,
        property: "position.y",
        value: 0.3,
        easing: "linear",
      });
      clip = engine.addKeyframe(clip, {
        id: "kf-opacity",
        time: 0,
        property: "opacity",
        value: 0.5,
        easing: "linear",
      });

      expect(clip.keyframes.length).toBe(3);
      const properties = clip.keyframes.map((kf) => kf.property);
      expect(properties).toContain("position.x");
      expect(properties).toContain("position.y");
      expect(properties).toContain("opacity");
    });

    it("should remove keyframe", () => {
      let clip = engine.createRectangle("track-1", 0, 5, 100, 50);
      clip = engine.addKeyframe(clip, {
        id: "kf-1",
        time: 0,
        property: "position.x",
        value: 0.2,
        easing: "linear",
      });

      clip = engine.removeKeyframe(clip, "kf-1");

      expect(clip.keyframes.length).toBe(0);
    });

    it("should remove only the specified keyframe", () => {
      let clip = engine.createRectangle("track-1", 0, 5, 100, 50);
      clip = engine.addKeyframe(clip, {
        id: "kf-1",
        time: 0,
        property: "position.x",
        value: 0.2,
        easing: "linear",
      });
      clip = engine.addKeyframe(clip, {
        id: "kf-2",
        time: 5,
        property: "position.x",
        value: 0.8,
        easing: "linear",
      });

      clip = engine.removeKeyframe(clip, "kf-1");

      expect(clip.keyframes.length).toBe(1);
      expect(clip.keyframes[0].id).toBe("kf-2");
    });

    it("should support different easing types", () => {
      const easings: EasingType[] = [
        "linear",
        "ease-in",
        "ease-out",
        "ease-in-out",
      ];

      for (const easing of easings) {
        const clip = engine.createRectangle("track-1", 0, 5, 100, 50);
        const updated = engine.addKeyframe(clip, {
          id: `kf-${easing}`,
          time: 0,
          property: "position.x",
          value: 0.2,
          easing,
        });

        expect(updated.keyframes[0].easing).toBe(easing);
      }
    });
  });

  describe("fill and stroke styles", () => {
    it("should update fill style", () => {
      const clip = engine.createRectangle("track-1", 0, 5, 100, 50);
      const updated = engine.updateFill(clip, {
        type: "solid",
        color: "#FF0000",
        opacity: 0.8,
      });

      expect(updated.style.fill.color).toBe("#FF0000");
      expect(updated.style.fill.opacity).toBe(0.8);
      expect(updated.style.fill.type).toBe("solid");
    });

    it("should update stroke style", () => {
      const clip = engine.createRectangle("track-1", 0, 5, 100, 50);
      const updated = engine.updateStroke(clip, {
        color: "#00FF00",
        width: 3,
        opacity: 1,
      });

      expect(updated.style.stroke.color).toBe("#00FF00");
      expect(updated.style.stroke.width).toBe(3);
      expect(updated.style.stroke.opacity).toBe(1);
    });

    it("should update gradient fill", () => {
      const clip = engine.createRectangle("track-1", 0, 5, 100, 50);
      const updated = engine.updateFill(clip, {
        type: "gradient",
        opacity: 1,
        gradient: {
          type: "linear",
          angle: 45,
          stops: [
            { offset: 0, color: "#FF0000" },
            { offset: 1, color: "#0000FF" },
          ],
        },
      });

      expect(updated.style.fill.type).toBe("gradient");
      expect(updated.style.fill.gradient?.type).toBe("linear");
      expect(updated.style.fill.gradient?.angle).toBe(45);
      expect(updated.style.fill.gradient?.stops.length).toBe(2);
    });

    it("should update radial gradient fill", () => {
      const clip = engine.createRectangle("track-1", 0, 5, 100, 50);
      const updated = engine.updateFill(clip, {
        type: "gradient",
        opacity: 1,
        gradient: {
          type: "radial",
          stops: [
            { offset: 0, color: "#FFFFFF" },
            { offset: 1, color: "#000000" },
          ],
        },
      });

      expect(updated.style.fill.gradient?.type).toBe("radial");
    });

    it("should update stroke dash array", () => {
      const clip = engine.createRectangle("track-1", 0, 5, 100, 50);
      const updated = engine.updateStroke(clip, {
        color: "#000000",
        width: 2,
        opacity: 1,
        dashArray: [5, 5],
        dashOffset: 0,
      });

      expect(updated.style.stroke.dashArray).toEqual([5, 5]);
      expect(updated.style.stroke.dashOffset).toBe(0);
    });

    it("should update stroke line cap and join", () => {
      const clip = engine.createRectangle("track-1", 0, 5, 100, 50);
      const updated = engine.updateStroke(clip, {
        color: "#000000",
        width: 2,
        opacity: 1,
        lineCap: "round",
        lineJoin: "round",
      });

      expect(updated.style.stroke.lineCap).toBe("round");
      expect(updated.style.stroke.lineJoin).toBe("round");
    });
  });

  describe("transform operations", () => {
    it("should update position", () => {
      const clip = engine.createRectangle("track-1", 0, 5, 100, 50);
      const updated = engine.updateShapeClip(clip.id, {
        transform: {
          ...clip.transform,
          position: { x: 0.3, y: 0.7 },
        },
      });

      expect(updated?.transform.position).toEqual({ x: 0.3, y: 0.7 });
    });

    it("should update scale", () => {
      const clip = engine.createRectangle("track-1", 0, 5, 100, 50);
      const updated = engine.updateShapeClip(clip.id, {
        transform: {
          ...clip.transform,
          scale: { x: 1.5, y: 2.0 },
        },
      });

      expect(updated?.transform.scale).toEqual({ x: 1.5, y: 2.0 });
    });

    it("should update rotation", () => {
      const clip = engine.createRectangle("track-1", 0, 5, 100, 50);
      const updated = engine.updateShapeClip(clip.id, {
        transform: {
          ...clip.transform,
          rotation: 45,
        },
      });

      expect(updated?.transform.rotation).toBe(45);
    });

    it("should update opacity", () => {
      const clip = engine.createRectangle("track-1", 0, 5, 100, 50);
      const updated = engine.updateShapeClip(clip.id, {
        transform: {
          ...clip.transform,
          opacity: 0.5,
        },
      });

      expect(updated?.transform.opacity).toBe(0.5);
    });

    it("should update anchor point", () => {
      const clip = engine.createRectangle("track-1", 0, 5, 100, 50);
      const updated = engine.updateShapeClip(clip.id, {
        transform: {
          ...clip.transform,
          anchor: { x: 0, y: 0 },
        },
      });

      expect(updated?.transform.anchor).toEqual({ x: 0, y: 0 });
    });

    it("should handle extreme position values", () => {
      const clip = engine.createRectangle("track-1", 0, 5, 100, 50);

      const extremePositions = [
        { x: -1, y: -1 },
        { x: 2, y: 2 },
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ];

      for (const position of extremePositions) {
        const updated = engine.updateShapeClip(clip.id, {
          transform: { ...clip.transform, position },
        });
        expect(updated?.transform.position).toEqual(position);
      }
    });

    it("should handle extreme scale values", () => {
      const clip = engine.createRectangle("track-1", 0, 5, 100, 50);

      const extremeScales = [
        { x: 0, y: 0 },
        { x: 0.01, y: 0.01 },
        { x: 10, y: 10 },
        { x: -1, y: -1 },
      ];

      for (const scale of extremeScales) {
        const updated = engine.updateShapeClip(clip.id, {
          transform: { ...clip.transform, scale },
        });
        expect(updated?.transform.scale).toEqual(scale);
      }
    });

    it("should handle rotation values outside 0-360 range", () => {
      const clip = engine.createRectangle("track-1", 0, 5, 100, 50);

      const rotations = [-180, -90, 0, 90, 180, 270, 360, 720, -360];

      for (const rotation of rotations) {
        const updated = engine.updateShapeClip(clip.id, {
          transform: { ...clip.transform, rotation },
        });
        expect(updated?.transform.rotation).toBe(rotation);
      }
    });
  });

  describe("timing and duration operations", () => {
    it("should update start time", () => {
      const clip = engine.createRectangle("track-1", 0, 5, 100, 50);
      const updated = engine.updateShapeClip(clip.id, {
        startTime: 2.5,
      });

      expect(updated?.startTime).toBe(2.5);
    });

    it("should update duration", () => {
      const clip = engine.createRectangle("track-1", 0, 5, 100, 50);
      const updated = engine.updateShapeClip(clip.id, {
        duration: 10,
      });

      expect(updated?.duration).toBe(10);
    });

    it("should handle fractional timing values", () => {
      const clip = engine.createRectangle("track-1", 0, 5, 100, 50);
      const updated = engine.updateShapeClip(clip.id, {
        startTime: 1.333,
        duration: 2.666,
      });

      expect(updated?.startTime).toBe(1.333);
      expect(updated?.duration).toBe(2.666);
    });
  });
});
