import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginPerfOperation,
  endPerfOperation,
  getPerfSink,
  setPerfSink,
  type PerfContext,
  type PerfOperation,
  type PerfSink,
} from "../performance";
import type { Project } from "../types/project";
import type { MotionComposition, MotionScene3DLayer } from "../motion/types";

const defaultMotionTransform = {
  position: { x: 960, y: 540, z: 0 },
  scale: { x: 1, y: 1 },
  rotation: 0,
  rotation3d: { x: 0, y: 0 },
  anchor: { x: 0.5, y: 0.5 },
  opacity: 1,
  perspective: 1000,
  transformStyle: "flat" as const,
};

describe("VideoEngine motion asset resolver", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Object.defineProperty(globalThis, "reelterminal", {
      configurable: true,
      value: undefined,
    });
  });

  it("renders bound creation scene3d layers through the Aurora bridge", async () => {
    vi.stubGlobal("self", {
      onmessage: null,
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const { VideoEngine } = await import("./video-engine");
    const engine = new VideoEngine();
    const image = {
      close: vi.fn(),
    } as unknown as ImageBitmap;
    const pngBlob = new Blob(["png"], { type: "image/png" });
    const createImageBitmapMock = vi.fn().mockResolvedValue(image);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => pngBlob,
    });
    const renderPreview = vi.fn().mockResolvedValue({
      backend: "native",
      pngBase64: "cG5n",
      dataUri: "data:image/png;base64,cG5n",
      width: 800,
      height: 450,
      coveredPixels: 12,
      shadowedPixels: 4,
      renderMs: 8,
    });
    const creation = {
      version: "1.0.0",
      assets: [
        {
          id: "asset-phone",
          name: "Phone",
          kind: "product",
          seed: "phone-seed",
          parameters: {},
          nodes: [],
          materials: [],
          dependencies: [],
          caches: [],
          createdAt: 1,
          modifiedAt: 1,
        },
      ],
      scenes: [
        {
          id: "scene-hero",
          name: "Hero Scene",
          duration: 4,
          frameRate: 30,
          objects: [],
          cameras: [],
          lights: [],
          animations: [],
          environment: { kind: "studio" },
          renderBindings: [
            {
              id: "binding-hero",
              kind: "motion-scene3d",
              compositionId: "composition-hero",
              layerId: "layer-hero",
              objectBindings: [],
              createdAt: 2,
              modifiedAt: 2,
            },
          ],
          createdAt: 2,
          modifiedAt: 2,
        },
      ],
      operationHistory: [],
    };
    const project = {
      mediaLibrary: { items: [] },
      creation,
    } as unknown as Project;
    const composition: MotionComposition = {
      id: "composition-hero",
      name: "Hero",
      width: 1280,
      height: 720,
      frameRate: 30,
      duration: 4,
      backgroundColor: "#0f172a",
      layers: [],
      assets: [],
      variables: [],
      markers: [],
      createdAt: 1,
      modifiedAt: 1,
    };
    const layer: MotionScene3DLayer = {
      id: "layer-hero",
      type: "scene3d",
      name: "3D Hero",
      startTime: 0,
      duration: 4,
      visible: true,
      locked: false,
      transform: defaultMotionTransform,
      keyframes: [],
      object: {
        kind: "phone",
      },
      width: 800,
      height: 450,
    };
    const quality = {
      shadows: true,
      shadowMapSize: 1024,
      environment: true,
    };

    vi.stubGlobal("createImageBitmap", createImageBitmapMock);
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(globalThis, "reelterminal", {
      configurable: true,
      value: {
        platform: "desktop",
        aurora: { renderPreview },
      },
    });

    const resolver = (
      engine as unknown as {
        createMotionAssetResolver(project: Project): {
          renderScene3D?: (input: {
            composition: MotionComposition;
            layer: MotionScene3DLayer;
            localTime: number;
            width: number;
            height: number;
            backgroundColor?: string;
            quality?: typeof quality;
          }) => Promise<{ image: ImageBitmap; release?: () => void } | null>;
        };
      }
    ).createMotionAssetResolver(project);

    const result = await resolver.renderScene3D?.({
      composition,
      layer,
      localTime: 2,
      width: 800,
      height: 450,
      backgroundColor: "#0f172a",
      quality,
    });

    expect(renderPreview).toHaveBeenCalledWith({
      scene: creation.scenes[0],
      assets: creation.assets,
      width: 800,
      height: 450,
      background: "#0f172a",
      timeSeconds: 2,
      quality: "preview",
    });
    expect(fetchMock).toHaveBeenCalledWith("data:image/png;base64,cG5n");
    expect(createImageBitmapMock).toHaveBeenCalledWith(pngBlob);
    expect(result?.image).toBe(image);

    result?.release?.();
    expect(image.close).toHaveBeenCalledTimes(1);
  });

  it("keeps initialization usable when parallel decoder startup fails", async () => {
    vi.stubGlobal("navigator", { hardwareConcurrency: 1 });
    vi.stubGlobal("self", {
      onmessage: null,
      postMessage: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const decoderModule = await import("./parallel-frame-decoder");
    decoderModule.disposeParallelDecoder();
    const decoder = decoderModule.getParallelFrameDecoder();
    const events: Array<{ phase: string; spanId: number; parentSpanId?: number }> = [];
    let nextSpanId = 0;
    const previousSink = getPerfSink();
    const sink: PerfSink = {
      enabled: true,
      mode: "trace",
      runId: "video-engine-initialize-test",
      begin: (phase, context: PerfContext) => {
        const spanId = ++nextSpanId;
        events.push({ phase, spanId, parentSpanId: context.parentSpanId });
        return { id: spanId, startedUs: spanId };
      },
      end: () => undefined,
      mark: () => undefined,
      count: () => undefined,
    };
    setPerfSink(sink);
    const bootstrapOperation = beginPerfOperation("test.bootstrap");
    let decoderParent: PerfOperation | undefined;
    vi.spyOn(decoder, "initialize").mockImplementation(async (parent) => {
      decoderParent = parent;
      throw new Error("worker startup failed");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { VideoEngine } = await import("./video-engine");

    try {
      const engine = new VideoEngine();
      await engine.initialize(bootstrapOperation);
      expect(decoder.initialize).not.toHaveBeenCalled();
      await engine.initializeParallelDecoding();

      expect(engine.isInitialized()).toBe(true);
      expect(engine.getParallelDecoder()).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        "[VideoEngine] Parallel decoder initialization failed:",
        expect.any(Error),
      );
      const videoEngineSpan = events.find((event) => event.phase === "video_engine.initialize");
      const parallelDecoderSpan = events.find((event) => event.phase === "video_engine.parallel_decoder_initialize");
      expect(videoEngineSpan?.parentSpanId).toBe(bootstrapOperation?.span.id);
      expect(parallelDecoderSpan).toBeDefined();
      expect(decoderParent?.span.id).toBe(parallelDecoderSpan?.spanId);
    } finally {
      endPerfOperation(bootstrapOperation, "ok");
      setPerfSink(previousSink);
      decoderModule.disposeParallelDecoder();
    }
  });
});
