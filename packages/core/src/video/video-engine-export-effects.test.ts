import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../types/project";
import type { Clip, Effect, Transform } from "../types/timeline";
import type {
  ClipColorGrading,
  ColorWheelValues,
  CurvesValues,
  HSLValues,
} from "./color-grading-engine";

const mocks = vi.hoisted(() => {
  const effectsInitialize = vi.fn();
  const effectsApply = vi.fn();
  const effectsDispose = vi.fn();
  const colorGradingInitialize = vi.fn();
  const applyColorWheels = vi.fn();
  const applyCpuGrading = vi.fn();
  const colorGradingDispose = vi.fn();

  return {
    effectsInitialize,
    effectsApply,
    effectsDispose,
    colorGradingInitialize,
    applyColorWheels,
    applyCpuGrading,
    colorGradingDispose,
    VideoEffectsEngine: vi.fn().mockImplementation(function () {
      return {
        initialize: effectsInitialize,
        applyEffects: effectsApply,
        dispose: effectsDispose,
      };
    }),
    ColorGradingEngine: vi.fn().mockImplementation(function () {
      return {
        initialize: colorGradingInitialize,
        applyColorWheels,
        applyCpuGrading,
        dispose: colorGradingDispose,
      };
    }),
  };
});

vi.mock("./video-effects-engine", async () => {
  const actual = await vi.importActual<typeof import("./video-effects-engine")>(
    "./video-effects-engine",
  );
  return {
    ...actual,
    VideoEffectsEngine: mocks.VideoEffectsEngine,
  };
});

vi.mock("./color-grading-engine", async () => {
  const actual = await vi.importActual<typeof import("./color-grading-engine")>(
    "./color-grading-engine",
  );
  return {
    ...actual,
    ColorGradingEngine: mocks.ColorGradingEngine,
  };
});

const makeBitmap = (id: string, width = 640, height = 360): ImageBitmap =>
  ({
    id,
    width,
    height,
    close: vi.fn(),
  }) as unknown as ImageBitmap;

const transform: Transform = {
  position: { x: 0, y: 0 },
  scale: { x: 1, y: 1 },
  rotation: 0,
  anchor: { x: 0.5, y: 0.5 },
  opacity: 1,
  fitMode: "contain",
};

const curves: CurvesValues = {
  rgb: [
    { x: 0, y: 0 },
    { x: 1, y: 0.85 },
  ],
  red: [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ],
  green: [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ],
  blue: [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ],
};

const colorWheels: ColorWheelValues = {
  shadows: { r: 0.12, g: -0.04, b: -0.08 },
  midtones: { r: 0, g: 0, b: 0 },
  highlights: { r: 0, g: 0, b: 0 },
  shadowsLift: 0,
  midtonesGamma: 1,
  highlightsGain: 1,
};

const hsl: HSLValues = {
  hue: [12, 0, 0, 0, 0, 0, 0, 0],
  saturation: [0, 0.2, 0, 0, 0, 0, 0, 0],
  luminance: [0, 0, -0.1, 0, 0, 0, 0, 0],
};

const lut = {
  data: [0, 0, 0, 255, 255, 255],
  size: 2,
  intensity: 0.5,
};

const makeClip = (
  effects: Effect[],
  colorGrading: ClipColorGrading,
): Clip => ({
  id: "clip-1",
  mediaId: "media-1",
  trackId: "track-1",
  startTime: 0,
  duration: 5,
  inPoint: 0,
  outPoint: 5,
  effects,
  audioEffects: [],
  transform,
  colorGrading,
  volume: 1,
  keyframes: [],
});

const makeProject = (clip: Clip): Project => ({
  id: "project-1",
  name: "Export effects",
  createdAt: 0,
  modifiedAt: 0,
  settings: {
    width: 640,
    height: 360,
    frameRate: 30,
    sampleRate: 48000,
    channels: 2,
  },
  mediaLibrary: {
    items: [
      {
        id: "media-1",
        name: "clip.mp4",
        type: "video",
        fileHandle: null,
        blob: new Blob(["video"]),
        metadata: {
          duration: 5,
          width: 640,
          height: 360,
          frameRate: 30,
          codec: "h264",
          sampleRate: 48000,
          channels: 2,
          fileSize: 1024,
        },
        thumbnailUrl: null,
        waveformData: null,
      },
    ],
  },
  timeline: {
    tracks: [
      {
        id: "track-1",
        type: "video",
        name: "Video",
        clips: [clip],
        transitions: [],
        locked: false,
        hidden: false,
        muted: false,
        solo: false,
      },
    ],
    subtitles: [],
    duration: 5,
    markers: [],
  },
});

describe("VideoEngine export frame effects", () => {
  const ctx = {
    canvas: {} as OffscreenCanvas,
    fillStyle: "",
    globalAlpha: 1,
    globalCompositeOperation: "source-over" as GlobalCompositeOperation,
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    measureText: vi.fn(() => ({ width: 0 })),
    fillText: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.effectsInitialize.mockResolvedValue(true);
    mocks.colorGradingInitialize.mockReturnValue(undefined);

    class MockOffscreenCanvas {
      width: number;
      height: number;

      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }

      getContext(): typeof ctx {
        return ctx;
      }
    }

    vi.stubGlobal("OffscreenCanvas", MockOffscreenCanvas);
    vi.stubGlobal("self", {
      onmessage: null,
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("composites text and graphics in track order above video", async () => {
    const { VideoEngine } = await import("./video-engine");
    const engine = new VideoEngine();
    const internal = engine as any;
    internal.initialized = true;
    internal.mediabunny = {};
    const project = makeProject(makeClip([], {} as ClipColorGrading));
    const base = { ...project.timeline.tracks[0]!, clips: [] };
    const graphics = { ...base, id: "graphics", type: "graphics" as const };
    const text = { ...base, id: "text", type: "text" as const };
    vi.spyOn(internal, "getActiveTextClips").mockReturnValue([{ trackId: "text" }]);
    vi.spyOn(internal, "getActiveSVGClips").mockReturnValue([{ trackId: "graphics" }]);
    vi.spyOn(internal, "getActiveShapeClips").mockReturnValue([]);
    vi.spyOn(internal, "getActiveStickerClips").mockReturnValue([]);
    const order: string[] = [];
    vi.spyOn(internal, "renderSVGClipToCanvasCtx").mockImplementation(async () => { order.push("svg"); });
    vi.spyOn(internal, "renderTextClipWithSubjectMask").mockImplementation(async () => { order.push("text"); });
    vi.stubGlobal("createImageBitmap", vi.fn(async () => makeBitmap("composite")));

    await engine.renderFrame({ ...project, timeline: { ...project.timeline, tracks: [base, graphics, text] } }, 1);
    expect(order).toEqual(["text", "svg"]);
    order.length = 0;
    await engine.renderFrame({ ...project, timeline: { ...project.timeline, tracks: [base, text, graphics] } }, 1);
    expect(order).toEqual(["svg", "text"]);
  });

  it("renders canonical overlays even when editor singleton state belongs to another project", async () => {
    const { VideoEngine } = await import("./video-engine");
    const { titleEngine, TitleEngine } = await import("../text/title-engine");
    const { graphicsEngine, GraphicsEngine } = await import("../graphics/graphics-engine");
    const engine = new VideoEngine();
    Object.assign(engine, { initialized: true, mediabunny: {} });
    const project = makeProject(makeClip([], {} as ClipColorGrading));
    const base = { ...project.timeline.tracks[0]!, clips: [] };
    const text = titleEngine.createTextClip({ trackId: "text", startTime: 0, duration: 2, text: "snapshot" });
    const shape = graphicsEngine.createShape({ shapeType: "circle", width: 100, height: 100 }, "graphics", 0, 2);
    const svg = { ...shape, id: "snapshot-svg", type: "svg" as const, svgContent: "<svg/>", viewBox: { minX: 0, minY: 0, width: 100, height: 100 }, preserveAspectRatio: "xMidYMid" as const };
    const sticker = { ...shape, id: "snapshot-sticker", type: "sticker" as const, imageUrl: "data:image/png;base64," };
    titleEngine.loadTextClips([{ ...text, text: "another project" }]);
    graphicsEngine.loadShapeClips([]);
    const raster = new OffscreenCanvas(640, 360);
    const renderText = vi.spyOn(TitleEngine.prototype, "renderText").mockReturnValue({ canvas: raster } as any);
    const renderGraphic = vi.spyOn(GraphicsEngine.prototype, "renderGraphic").mockResolvedValue({ canvas: raster, width: 640, height: 360 });
    vi.stubGlobal("createImageBitmap", vi.fn(async () => makeBitmap("composite")));
    const snapshot = {
      ...project,
      textClips: [text], shapeClips: [shape], svgClips: [svg], stickerClips: [sticker],
      timeline: { ...project.timeline, tracks: [{ ...base, id: "text", type: "text" as const }, { ...base, id: "graphics", type: "graphics" as const }] },
    } as Project;
    await engine.renderFrame(snapshot, 1, 320, 180);
    expect(renderText).toHaveBeenCalledWith(text, 320, 180, 1, { width: 640, height: 360 });
    expect(renderGraphic.mock.calls.map(([clip]) => clip)).toEqual([shape, svg, sticker]);
    renderText.mockClear(); renderGraphic.mockClear();
    await engine.renderFrame({ ...snapshot, textClips: undefined, shapeClips: undefined, svgClips: undefined, stickerClips: undefined }, 1);
    expect(renderText).not.toHaveBeenCalled();
    expect(renderGraphic).not.toHaveBeenCalled();
    renderText.mockRestore(); renderGraphic.mockRestore();
  });

  it("maps host decoding from snapshot speed and freeze state without speed-engine hydration", async () => {
    const { VideoEngine } = await import("./video-engine");
    const engine = new VideoEngine();
    Object.assign(engine, { initialized: true, mediabunny: {} });
    const clip = { ...makeClip([], {} as ClipColorGrading), inPoint: 2, outPoint: 10, speed: 2 };
    const decodeSourceFrame = vi.fn(async (_clip: Clip, _media: unknown, _time: number, _width: number, _height: number) => makeBitmap("host-source"));
    vi.stubGlobal("createImageBitmap", vi.fn(async () => makeBitmap("composite")));
    await engine.renderFrame(makeProject(clip), 1, 640, 360, { decodeSourceFrame });
    expect(decodeSourceFrame.mock.calls[0]![2]).toBe(4);
    const reversed = { ...clip, reversed: true };
    await engine.renderFrame(makeProject(reversed), 1, 640, 360, { decodeSourceFrame });
    expect(decodeSourceFrame.mock.calls[1]![2]).toBe(8);
    const frozen = { ...clip, freezeFrames: [{ id: "freeze", clipId: clip.id, startTime: 0.5, duration: 1, sourceTime: 3 }] };
    await engine.renderFrame(makeProject(frozen), 1, 640, 360, { decodeSourceFrame });
    expect(decodeSourceFrame.mock.calls[2]![2]).toBe(5);
    for (const result of decodeSourceFrame.mock.results) expect((await result.value).close).toHaveBeenCalledOnce();
  });

  it("serializes shared composition and restores the per-frame rendering mode after failure", async () => {
    const { VideoEngine } = await import("./video-engine");
    const engine = new VideoEngine();
    Object.assign(engine, { initialized: true, mediabunny: {} });
    const project = makeProject(makeClip([], {} as ClipColorGrading));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const modes: boolean[] = [];
    const decodeSourceFrame = vi.fn(async () => {
      modes.push(engine.exportMode);
      if (modes.length === 1) { await gate; throw new Error("decoder failure"); }
      return makeBitmap("host-source");
    });
    vi.stubGlobal("createImageBitmap", vi.fn(async () => makeBitmap("composite")));
    const first = engine.renderFrame(project, 1, 640, 360, { decodeSourceFrame, realtime: true });
    const second = engine.renderFrame(project, 2, 640, 360, { decodeSourceFrame });
    await vi.waitFor(() => expect(decodeSourceFrame).toHaveBeenCalledOnce());
    release();
    await expect(first).rejects.toThrow("decoder failure");
    await second;
    expect(modes).toEqual([false, true]);
    expect(engine.exportMode).toBe(false);
  });

  it("decodes persisted stabilized ranges at their own source origin and rejects missing derived bytes", async () => {
    const { VideoEngine } = await import("./video-engine");
    const engine = new VideoEngine();
    Object.assign(engine, { initialized: true, mediabunny: {} });
    const clip = {
      ...makeClip([], {} as ClipColorGrading),
      stabilization: { enabled: true, strength: 50, cropMode: "auto" as const,
        renderedSource: { mediaId: "stabilized", inPoint: 1, outPoint: 3 } },
    };
    const project = makeProject(clip);
    const derived = { ...project.mediaLibrary.items[0]!, id: "stabilized", blob: new Blob(["stabilized"]) };
    project.mediaLibrary.items.push(derived);
    const decodeSourceFrame = vi.fn(async (_clip: Clip, _media: unknown, _time: number, _width: number, _height: number) => makeBitmap("source"));
    vi.stubGlobal("createImageBitmap", vi.fn(async () => makeBitmap("composite")));
    const frame = await engine.renderFrame(project, 2, 640, 360, { decodeSourceFrame });
    expect(decodeSourceFrame).toHaveBeenLastCalledWith(clip, derived, 1, 640, 360);
    expect(frame.decodedClipIds).toEqual([clip.id]);
    await engine.renderFrame(project, 0.5, 640, 360, { decodeSourceFrame });
    expect(decodeSourceFrame).toHaveBeenLastCalledWith(clip, project.mediaLibrary.items[0], 0.5, 640, 360);
    await engine.renderFrame(project, 3, 640, 360, { decodeSourceFrame });
    expect(decodeSourceFrame).toHaveBeenLastCalledWith(clip, project.mediaLibrary.items[0], 3, 640, 360);
    await expect(engine.renderFrame({ ...project, mediaLibrary: { items: [project.mediaLibrary.items[0]!] } }, 2, 640, 360, { decodeSourceFrame })).rejects.toThrow("Stabilized media stabilized");
  });

  it("uses the same optical-flow interpolation for realtime and exact frames on the absolute source grid", async () => {
    const { VideoEngine } = await import("./video-engine");
    const { FrameInterpolationEngine } = await import("./frame-interpolation");
    const initialize = vi.spyOn(FrameInterpolationEngine.prototype, "initialize").mockResolvedValue();
    const interpolate = vi.spyOn(FrameInterpolationEngine.prototype, "interpolate").mockImplementation(async () => ({ frame: makeBitmap("interpolated"), computeTimeMs: 0, method: "optical-flow" }));
    const engine = new VideoEngine();
    Object.assign(engine, { initialized: true, mediabunny: {} });
    const clip = { ...makeClip([], {} as ClipColorGrading), inPoint: 0.01, speed: 0.5, smoothSlowMo: true };
    const project = makeProject(clip);
    const decodeSourceFrame = vi.fn(async (_clip: Clip, _media: unknown, _time: number, _width: number, _height: number) => makeBitmap("sample"));
    vi.stubGlobal("createImageBitmap", vi.fn(async () => makeBitmap("composite")));
    const drawn: string[] = [];
    ctx.drawImage.mockImplementation((source: any) => { if (source.id) drawn.push(source.id); });
    try {
      await engine.renderFrame(project, 0.1, 640, 360, { decodeSourceFrame, realtime: true });
      await engine.renderFrame(project, 0.1, 640, 360, { decodeSourceFrame });
      expect(decodeSourceFrame.mock.calls.map((call) => call[2])).toEqual([1 / 30, 2 / 30]);
      expect(interpolate).toHaveBeenCalledTimes(2);
      expect(interpolate.mock.calls.map((call) => call[2])).toEqual([expect.closeTo(0.8), expect.closeTo(0.8)]);
      expect(drawn).toEqual(["interpolated", "interpolated"]);
    } finally {
      ctx.drawImage.mockReset(); initialize.mockRestore(); interpolate.mockRestore(); engine.dispose();
    }
  });

  it("blends transformed video and each transition endpoint against the underlying scene", async () => {
    const { VideoEngine } = await import("./video-engine");
    const engine = new VideoEngine();
    Object.assign(engine, { initialized: true, mediabunny: {} });
    const clipA = { ...makeClip([], {} as ClipColorGrading), blendMode: "multiply" as const, blendOpacity: 40 };
    const clipB = { ...clipA, id: "clip-b", blendMode: "screen" as const, blendOpacity: 60 };
    const project = makeProject(clipA);
    const calls: Array<[string, string, number]> = [];
    ctx.drawImage.mockImplementation((source: any) => { if (source.id) calls.push([source.id, ctx.globalCompositeOperation, ctx.globalAlpha]); });
    const decodeSourceFrame = vi.fn(async (clip: Clip) => makeBitmap(clip.id));
    vi.stubGlobal("createImageBitmap", vi.fn(async () => makeBitmap("composite")));
    try {
      await engine.renderFrame(project, 1, 640, 360, { decodeSourceFrame });
      expect(calls).toContainEqual([clipA.id, "multiply", 0.4]);
      calls.length = 0;
      const transition = { id: "transition", type: "crossfade", duration: 1, clipAId: clipA.id, clipBId: clipB.id, params: {}, easing: "linear" };
      const internal = engine as any;
      internal.transitionEngine = {
        getEngineDimensions: () => ({ width: 640, height: 360 }),
        isTimeInTransition: () => true,
        calculateTransitionProgress: () => 0.5,
        renderTransition: vi.fn(async () => ({ frame: makeBitmap("transition") })),
      };
      const track = { ...project.timeline.tracks[0]!, clips: [clipA, clipB], transitions: [transition] };
      const frame = await engine.renderFrame({ ...project, timeline: { ...project.timeline, tracks: [track] } } as Project, 1, 640, 360, { decodeSourceFrame });
      expect(calls).toContainEqual([clipA.id, "multiply", 0.4]);
      expect(calls).toContainEqual([clipB.id, "screen", 0.6]);
      expect(frame.decodedClipIds).toEqual([clipA.id, clipB.id]);
    } finally { ctx.drawImage.mockReset(); }
  });

  it("rejects a frame after unrecoverable effects failure and releases its decoded bitmap", async () => {
    const { VideoEngine } = await import("./video-engine");
    const engine = new VideoEngine();
    Object.assign(engine, { initialized: true, mediabunny: {} });
    const source = makeBitmap("source");
    const effect: Effect = { id: "effect", type: "brightness", enabled: true, params: { value: 2 } };
    const project = makeProject(makeClip([effect], {} as ClipColorGrading));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.effectsApply.mockRejectedValue(new Error("effect device lost"));
    try {
      await expect(engine.renderFrame(project, 1, 640, 360, { decodeSourceFrame: async () => source })).rejects.toThrow("Failed to apply effects");
      expect(source.close).toHaveBeenCalledOnce();
    } finally { warning.mockRestore(); }
  });

  it("releases the frame queue and rendering mode even when export-scope cleanup fails", async () => {
    const { VideoEngine } = await import("./video-engine");
    const { getMediaEngine } = await import("../media/mediabunny-engine");
    const engine = new VideoEngine();
    Object.assign(engine, { initialized: true, mediabunny: {} });
    const clip = makeClip([], {} as ClipColorGrading);
    const project = makeProject(clip);
    const finish = vi.spyOn(getMediaEngine(), "endExportFrame").mockImplementationOnce(() => { throw new Error("scope cleanup failed"); });
    vi.stubGlobal("createImageBitmap", vi.fn(async () => makeBitmap("composite")));
    const decodeSourceFrame = async () => makeBitmap("source");
    try {
      await expect(engine.renderFrame(project, 1, 640, 360, { decodeSourceFrame })).rejects.toThrow("scope cleanup failed");
      const next = await engine.renderFrame(project, 1, 640, 360, { decodeSourceFrame });
      expect(next.decodedClipIds).toEqual([clip.id]);
      expect(engine.exportMode).toBe(false);
    } finally { finish.mockRestore(); }
  });

  it("exports active clip effects and every color-grading stage", async () => {
    const sourceBitmap = makeBitmap("source");
    const effectsBitmap = makeBitmap("effects");
    const colorWheelsBitmap = makeBitmap("color-wheels");
    const cpuGradedBitmap = makeBitmap("cpu-graded");
    const whiteBalancedBitmap = makeBitmap("white-balanced");
    const finalBitmap = makeBitmap("final");

    mocks.effectsApply.mockImplementation(
      async (_image: ImageBitmap, effects: Effect[]) => ({
        image: effects.some((effect) => effect.id.startsWith("wb-"))
          ? whiteBalancedBitmap
          : effectsBitmap,
        processingTime: 1,
        gpuAccelerated: false,
      }),
    );
    mocks.applyColorWheels.mockResolvedValue({
      image: colorWheelsBitmap,
      processingTime: 1,
    });
    mocks.applyCpuGrading.mockResolvedValue({
      image: cpuGradedBitmap,
      processingTime: 1,
    });
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(finalBitmap));

    const clipEffect: Effect = {
      id: "brightness-1",
      type: "brightness",
      enabled: true,
      params: { value: 1.2 },
    };
    const colorGrading: ClipColorGrading = {
      colorWheels,
      curves,
      lut,
      hsl,
      temperature: 22,
      tint: -14,
    };
    const clip = makeClip([clipEffect], colorGrading);
    const project = makeProject(clip);
    const { VideoEngine } = await import("./video-engine");
    const engine = new VideoEngine();

    Object.assign(engine as unknown as Record<string, unknown>, {
      initialized: true,
      mediabunny: {},
    });
    vi.spyOn(
      engine as unknown as {
        decodeFrameWithMediaBunny: () => Promise<ImageBitmap>;
      },
      "decodeFrameWithMediaBunny",
    ).mockResolvedValue(sourceBitmap);

    const result = await engine.renderFrame(project, 1, 640, 360);

    expect(result.image).toBe(finalBitmap);
    expect(mocks.effectsApply).toHaveBeenNthCalledWith(1, sourceBitmap, [
      clipEffect,
    ]);
    expect(mocks.applyColorWheels).toHaveBeenCalledWith(
      effectsBitmap,
      colorWheels,
    );
    expect(mocks.applyCpuGrading).toHaveBeenCalledWith(colorWheelsBitmap, {
      curves,
      lut: {
        ...lut,
        data: new Uint8Array(lut.data),
      },
      hsl,
    });
    expect(mocks.effectsApply).toHaveBeenNthCalledWith(2, cpuGradedBitmap, [
      {
        id: "wb-temperature",
        type: "temperature",
        enabled: true,
        params: { value: 22 },
      },
      {
        id: "wb-tint",
        type: "tint",
        enabled: true,
        params: { value: -14 },
      },
    ]);
    expect(ctx.drawImage).toHaveBeenCalledWith(
      whiteBalancedBitmap,
      -320,
      -180,
      640,
      360,
    );
    expect(sourceBitmap.close).toHaveBeenCalledTimes(1);
    expect(effectsBitmap.close).toHaveBeenCalledTimes(1);
    expect(colorWheelsBitmap.close).toHaveBeenCalledTimes(1);
    expect(cpuGradedBitmap.close).toHaveBeenCalledTimes(1);
    expect(whiteBalancedBitmap.close).toHaveBeenCalledTimes(1);
  });

  it("recreates the effects engine and retries a transient export failure", async () => {
    const sourceBitmap = makeBitmap("retry-source");
    const processedBitmap = makeBitmap("retry-processed");
    const finalBitmap = makeBitmap("retry-final");
    const clipEffect: Effect = {
      id: "contrast-retry",
      type: "contrast",
      enabled: true,
      params: { value: 1.2 },
    };

    mocks.effectsApply
      .mockRejectedValueOnce(new Error("transient effects failure"))
      .mockResolvedValueOnce({
        image: processedBitmap,
        processingTime: 1,
        gpuAccelerated: false,
      });
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(finalBitmap));

    const project = makeProject(makeClip([clipEffect], {} as ClipColorGrading));
    const { VideoEngine } = await import("./video-engine");
    const engine = new VideoEngine();
    engine.exportMode = true;
    Object.assign(engine as unknown as Record<string, unknown>, {
      initialized: true,
      mediabunny: {},
    });
    vi.spyOn(
      engine as unknown as {
        decodeFrameWithMediaBunny: () => Promise<ImageBitmap>;
      },
      "decodeFrameWithMediaBunny",
    ).mockResolvedValue(sourceBitmap);

    const result = await engine.renderFrame(project, 1, 640, 360);

    expect(result.image).toBe(finalBitmap);
    expect(mocks.effectsApply).toHaveBeenCalledTimes(2);
    expect(mocks.effectsDispose).toHaveBeenCalledTimes(1);
    expect(mocks.VideoEffectsEngine).toHaveBeenCalledTimes(2);
    expect(ctx.drawImage).toHaveBeenCalledWith(
      processedBitmap,
      -320,
      -180,
      640,
      360,
    );
  });

  it("applies ordered effects to isolated overlay canvases before compositing", async () => {
    const sourceBitmap = makeBitmap("overlay-source");
    const processedBitmap = makeBitmap("overlay-processed");
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(sourceBitmap));
    mocks.effectsApply.mockResolvedValue({
      image: processedBitmap,
      processingTime: 1,
      gpuAccelerated: false,
    });
    const effects: Effect[] = [
      {
        id: "shader-first",
        type: "shader",
        enabled: true,
        params: { shaderId: "paper-halftone-dots" },
      },
      {
        id: "brightness-second",
        type: "brightness",
        enabled: true,
        params: { value: 20 },
      },
    ];
    const { VideoEngine } = await import("./video-engine");
    const engine = new VideoEngine() as unknown as {
      drawOverlayCanvasWithEffects: (
        context: typeof ctx,
        source: OffscreenCanvas,
        overlayEffects: readonly Effect[],
        width: number,
        height: number,
      ) => Promise<void>;
    };
    const overlayCanvas = new OffscreenCanvas(640, 360);

    await engine.drawOverlayCanvasWithEffects(
      ctx,
      overlayCanvas,
      effects,
      640,
      360,
    );

    expect(mocks.effectsApply).toHaveBeenCalledWith(sourceBitmap, effects);
    expect(ctx.drawImage).toHaveBeenCalledWith(
      processedBitmap,
      0,
      0,
      640,
      360,
    );
    expect(sourceBitmap.close).toHaveBeenCalledTimes(1);
    expect(processedBitmap.close).toHaveBeenCalledTimes(1);
  });

  it("renders active adjustment-layer effects into the final preview/export composite", async () => {
    const sourceBitmap = makeBitmap("adjustment-clip");
    const compositeSnapshot = makeBitmap("adjustment-source");
    const adjustedBitmap = makeBitmap("adjustment-result");
    const finalBitmap = makeBitmap("adjustment-final");
    const adjustmentEffect: Effect = {
      id: "adjustment-contrast",
      type: "contrast",
      enabled: true,
      params: { value: 1.35 },
    };
    mocks.effectsApply.mockResolvedValue({
      image: adjustedBitmap,
      processingTime: 1,
      gpuAccelerated: false,
    });
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn()
        .mockResolvedValueOnce(compositeSnapshot)
        .mockResolvedValueOnce(finalBitmap),
    );

    const project: Project = {
      ...makeProject(makeClip([], {} as ClipColorGrading)),
      adjustmentLayers: [{
        id: "adjustment-1",
        trackId: "track-1",
        name: "Section grade",
        startTime: 0,
        duration: 4,
        effects: [adjustmentEffect],
        opacity: 0.4,
        blendMode: "difference",
        enabled: true,
        affectedTracks: "all",
        transform,
      }],
    };
    const { VideoEngine } = await import("./video-engine");
    const engine = new VideoEngine();
    Object.assign(engine as unknown as Record<string, unknown>, {
      initialized: true,
      mediabunny: {},
    });
    vi.spyOn(
      engine as unknown as { decodeFrameWithMediaBunny: () => Promise<ImageBitmap> },
      "decodeFrameWithMediaBunny",
    ).mockResolvedValue(sourceBitmap);

    const result = await engine.renderFrame(project, 1, 640, 360);

    expect(result.image).toBe(finalBitmap);
    expect(mocks.effectsApply).toHaveBeenCalledWith(compositeSnapshot, [adjustmentEffect]);
    expect(ctx.drawImage).toHaveBeenCalledWith(adjustedBitmap, 0, 0, 640, 360);
    expect(ctx.globalAlpha).toBe(0.4);
    expect(ctx.globalCompositeOperation).toBe("difference");
    expect(compositeSnapshot.close).toHaveBeenCalledTimes(1);
    expect(adjustedBitmap.close).toHaveBeenCalledTimes(1);
  });
});
