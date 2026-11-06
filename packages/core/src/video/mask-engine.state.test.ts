import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MaskEngine } from "./mask-engine";

class OffscreenCanvasMock {
  width: number;
  height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  getContext() {
    return {};
  }
}

describe("MaskEngine state operations", () => {
  beforeEach(() => {
    vi.stubGlobal("OffscreenCanvas", OffscreenCanvasMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("updates and clamps mask opacity", () => {
    const engine = new MaskEngine({ width: 1920, height: 1080 });
    const mask = engine.createDrawnMask("clip-1", {
      closed: true,
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
      ],
    });

    engine.setOpacity(mask.id, 0.42);
    expect(engine.getMask(mask.id)?.opacity).toBe(0.42);
    engine.setOpacity(mask.id, 2);
    expect(engine.getMask(mask.id)?.opacity).toBe(1);
    engine.setOpacity(mask.id, -1);
    expect(engine.getMask(mask.id)?.opacity).toBe(0);
  });

  it("duplicates the complete mask without sharing path or keyframe objects", () => {
    const engine = new MaskEngine({ width: 1920, height: 1080 });
    const source = engine.createTrackMatteMask(
      "clip-1",
      "matte-source",
      "luminance",
    );
    engine.setFeathering(source.id, 18);
    engine.setExpansion(source.id, -12);
    engine.setOpacity(source.id, 0.65);
    engine.setInverted(source.id, true);
    engine.addMaskKeyframe(source.id, 1, {
      closed: true,
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.1 },
        { x: 0.9, y: 0.9 },
      ],
    });

    const duplicate = engine.duplicateMask(source.id, "clip-2");

    expect(duplicate).toMatchObject({
      clipId: "clip-2",
      type: "track-matte",
      sourceClipId: "matte-source",
      matteSource: "luminance",
      feathering: 18,
      expansion: -12,
      opacity: 0.65,
      inverted: true,
    });
    expect(duplicate?.id).not.toBe(source.id);
    expect(duplicate?.keyframes).toHaveLength(1);
    expect(duplicate?.keyframes[0]?.id).not.toBe(
      engine.getMask(source.id)?.keyframes[0]?.id,
    );
    expect(duplicate?.path).not.toBe(engine.getMask(source.id)?.path);
    expect(duplicate?.keyframes[0]?.path).not.toBe(
      engine.getMask(source.id)?.keyframes[0]?.path,
    );
  });

  it("cuts the path out of an opaque full-frame mask when inverted", () => {
    const operations: string[] = [];
    const baseContext = {};
    const maskContext = {
      fillStyle: "",
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      bezierCurveTo: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      set globalCompositeOperation(value: string) {
        operations.push(value);
      },
      get globalCompositeOperation() {
        return operations.at(-1) ?? "source-over";
      },
    };
    let canvasCount = 0;
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        width: number;
        height: number;
        constructor(width: number, height: number) {
          this.width = width;
          this.height = height;
        }
        getContext() {
          canvasCount += 1;
          return canvasCount === 1 ? baseContext : maskContext;
        }
      },
    );
    const engine = new MaskEngine({ width: 100, height: 100 });

    (
      engine as unknown as {
        generateMaskFromPath: (
          path: { closed: boolean; points: Array<{ x: number; y: number }> },
          inverted: boolean,
        ) => void;
      }
    ).generateMaskFromPath(
      {
        closed: true,
        points: [
          { x: 0.2, y: 0.2 },
          { x: 0.8, y: 0.2 },
          { x: 0.5, y: 0.8 },
        ],
      },
      true,
    );

    expect(maskContext.fillRect).toHaveBeenCalledWith(0, 0, 100, 100);
    expect(operations).toContain("destination-out");
    expect(operations.at(-1)).toBe("source-over");
  });

  it("reuses the scratch canvas while resetting feather and opacity state across frames", async () => {
    const canvases: Canvas[] = [];
    const scratchDraws: Array<{ alpha: number; filter: string; composite: string; width: number; height: number }> = [];
    class Canvas {
      width: number;
      height: number;
      context = {
        globalAlpha: 1,
        filter: "none",
        globalCompositeOperation: "source-over",
        fillStyle: "",
        clearRect: vi.fn(),
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        bezierCurveTo: vi.fn(),
        closePath: vi.fn(),
        fill: vi.fn(),
        drawImage: vi.fn(() => {
          if (canvases[2] === this) {
            scratchDraws.push({
              alpha: this.context.globalAlpha,
              filter: this.context.filter,
              composite: this.context.globalCompositeOperation,
              width: this.width,
              height: this.height,
            });
          }
        }),
      };
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
        canvases.push(this);
      }
      getContext() { return this.context; }
    }
    vi.stubGlobal("OffscreenCanvas", Canvas);
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({})));
    const engine = new MaskEngine({ width: 100, height: 100 });
    const mask = engine.createDrawnMask("clip", {
      closed: true,
      points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
    });
    mask.feathering = 4;
    mask.opacity = 0.5;
    await engine.applyMask({ width: 100, height: 100 } as ImageBitmap, mask);
    mask.feathering = 8;
    mask.opacity = 0.25;
    await engine.applyMask({ width: 200, height: 120 } as ImageBitmap, mask);

    expect(canvases).toHaveLength(3);
    expect(scratchDraws).toEqual([
      { alpha: 1, filter: "blur(4px)", composite: "source-over", width: 100, height: 100 },
      { alpha: 0.5, filter: "none", composite: "source-over", width: 100, height: 100 },
      { alpha: 1, filter: "blur(8px)", composite: "source-over", width: 200, height: 120 },
      { alpha: 0.25, filter: "none", composite: "source-over", width: 200, height: 120 },
    ]);
    expect(canvases[2].context.clearRect).toHaveBeenCalledTimes(4);
  });
});
