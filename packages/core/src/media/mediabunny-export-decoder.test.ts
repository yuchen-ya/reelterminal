import { afterEach, describe, expect, it, vi } from "vitest";
import { ExportFrameDecoder, MediaBunnyEngine } from "./mediabunny-engine";

// Engine-level tests drive MediaBunnyEngine.initialize()'s dynamic import.
// Existing ExportFrameDecoder tests inject mock namespaces directly and never
// load the module, so this file-wide mock leaves them untouched.
const engineMediabunny = vi.hoisted(() => ({
  getPrimaryVideoTrack: undefined as (() => Promise<unknown>) | undefined,
  inputDispose: undefined as (() => void) | undefined,
}));

vi.mock("mediabunny", () => {
  class Input {
    async getPrimaryVideoTrack(): Promise<unknown> {
      if (!engineMediabunny.getPrimaryVideoTrack) {
        throw new Error("mock mediabunny not configured");
      }
      return engineMediabunny.getPrimaryVideoTrack();
    }
    [Symbol.dispose](): void {
      engineMediabunny.inputDispose?.();
    }
  }
  return {
    Input,
    ALL_FORMATS: [],
    BlobSource: class {},
    CanvasSink: class {},
  };
});

function findFrameAtOrBefore(
  frames: Array<{ timestamp: number }>,
  timestamp: number,
): number {
  let result = 0;
  for (let index = 0; index < frames.length; index++) {
    if (frames[index]!.timestamp > timestamp) break;
    result = index;
  }
  return result;
}

describe("ExportFrameDecoder", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("decodes monotonic export requests through one sequential canvas iterator", async () => {
    const drawImage = vi.fn();
    class MockOffscreenCanvas {
      width: number;
      height: number;

      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }

      getContext() {
        return { clearRect: vi.fn(), drawImage };
      }
    }
    vi.stubGlobal("OffscreenCanvas", MockOffscreenCanvas);

    const frames = [0, 1 / 30, 2 / 30, 3 / 30].map((timestamp) => ({
      canvas: new MockOffscreenCanvas(640, 360),
      timestamp,
      duration: 1 / 30,
    }));
    const getCanvas = vi.fn();
    const canvases = vi.fn((startTimestamp: number) => {
      const startIndex = findFrameAtOrBefore(frames, startTimestamp);
      return (async function* () {
        for (const frame of frames.slice(startIndex)) yield frame;
      })();
    });
    class MockCanvasSink {
      getCanvas = getCanvas;
      canvases = canvases;
    }
    class MockInput {
      async getPrimaryVideoTrack() {
        return {
          displayWidth: 640,
          displayHeight: 360,
          canDecode: vi.fn().mockResolvedValue(true),
        };
      }
    }

    const mediabunny = {
      Input: MockInput,
      ALL_FORMATS: [],
      BlobSource: class {},
      CanvasSink: MockCanvasSink,
    } as unknown as typeof import("mediabunny");
    const decoder = new ExportFrameDecoder(mediabunny, new Blob(["video"]), 640);

    expect(await decoder.initialize()).toBe(true);
    await decoder.getFrame(0);
    await decoder.getFrame(1 / 60);
    await decoder.getFrame(2 / 60);
    await decoder.getFrame(3 / 60);

    expect(canvases).toHaveBeenCalledTimes(1);
    expect(getCanvas).not.toHaveBeenCalled();
    expect(drawImage).toHaveBeenCalledTimes(4);
    expect(drawImage).toHaveBeenNthCalledWith(1, frames[0]!.canvas, 0, 0);
    expect(drawImage).toHaveBeenNthCalledWith(2, frames[0]!.canvas, 0, 0);
    expect(drawImage).toHaveBeenNthCalledWith(3, frames[1]!.canvas, 0, 0);
    expect(drawImage).toHaveBeenNthCalledWith(4, frames[1]!.canvas, 0, 0);
  });

  it("starts a new iterator when a later request moves backwards", async () => {
    class MockOffscreenCanvas {
      width: number;
      height: number;

      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }

      getContext() {
        return { clearRect: vi.fn(), drawImage: vi.fn() };
      }
    }
    vi.stubGlobal("OffscreenCanvas", MockOffscreenCanvas);

    const frames = [0, 1, 2].map((timestamp) => ({
      canvas: new MockOffscreenCanvas(320, 180),
      timestamp,
      duration: 1,
    }));
    const canvases = vi.fn((startTimestamp: number) => {
      const startIndex = findFrameAtOrBefore(frames, startTimestamp);
      return (async function* () {
        for (const frame of frames.slice(startIndex)) yield frame;
      })();
    });
    class MockCanvasSink {
      canvases = canvases;
    }
    class MockInput {
      async getPrimaryVideoTrack() {
        return {
          displayWidth: 320,
          displayHeight: 180,
          canDecode: vi.fn().mockResolvedValue(true),
        };
      }
    }

    const decoder = new ExportFrameDecoder({
      Input: MockInput,
      ALL_FORMATS: [],
      BlobSource: class {},
      CanvasSink: MockCanvasSink,
    } as unknown as typeof import("mediabunny"), new Blob(["video"]));

    await decoder.initialize();
    await decoder.getFrame(1.5);
    await decoder.getFrame(0.25);

    expect(canvases).toHaveBeenNthCalledWith(1, 1.5);
    expect(canvases).toHaveBeenNthCalledWith(2, 0.25);
  });

  it("keeps independent cursors for overlapping clips that reuse one source", async () => {
    const drawImage = vi.fn();
    class Canvas {
      constructor(public width: number, public height: number) {}
      getContext() { return { clearRect: vi.fn(), drawImage }; }
    }
    vi.stubGlobal("OffscreenCanvas", Canvas);
    const frames = [0, 1, 6, 7].map(timestamp => ({
      canvas: new Canvas(320, 180), timestamp, duration: 1,
    }));
    const returned = vi.fn();
    const disposed = vi.fn();
    const canvases = vi.fn((start: number) => (async function* () {
      try {
        for (const frame of frames.slice(findFrameAtOrBefore(frames, start))) yield frame;
      } finally { returned(); }
    })());
    class Input {
      async getPrimaryVideoTrack() {
        return { displayWidth: 320, displayHeight: 180, canDecode: async () => true };
      }
      [Symbol.dispose]() { disposed(); }
    }
    const decoder = new ExportFrameDecoder({
      Input, ALL_FORMATS: [], BlobSource: class {}, CanvasSink: class { canvases = canvases; },
    } as unknown as typeof import("mediabunny"), new Blob(["same source"]));
    await decoder.initialize();
    decoder.beginFrame();
    await decoder.getFrame(6, "upper");
    await decoder.getFrame(0, "background");
    await decoder.getFrame(6.5, "upper");
    await decoder.getFrame(0.5, "background");
    expect(canvases.mock.calls).toEqual([[6], [0]]);
    expect(drawImage.mock.calls.map(call => call[0])).toEqual([
      frames[2].canvas, frames[0].canvas, frames[2].canvas, frames[0].canvas,
    ]);
    decoder.endFrame();
    expect(disposed).not.toHaveBeenCalled();
    decoder.beginFrame();
    await decoder.getFrame(6.75, "upper");
    decoder.endFrame();
    await Promise.resolve();
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(returned).toHaveBeenCalledTimes(1);
    decoder.dispose();
    await Promise.resolve();
    expect(disposed).toHaveBeenCalledTimes(2);
    expect(returned).toHaveBeenCalledTimes(2);
  });
});

describe("MediaBunnyEngine.createExportDecoder", () => {
  afterEach(() => {
    engineMediabunny.getPrimaryVideoTrack = undefined;
    engineMediabunny.inputDispose = undefined;
  });

  it("releases the input source when decoder initialization throws", async () => {
    engineMediabunny.getPrimaryVideoTrack = () =>
      Promise.reject(new Error("corrupt container"));
    const inputDispose = vi.fn();
    engineMediabunny.inputDispose = inputDispose;

    const engine = new MediaBunnyEngine();
    await engine.initialize();
    await expect(
      engine.createExportDecoder("m1", new Blob(["corrupt"])),
    ).rejects.toThrow("corrupt container");
    expect(inputDispose).toHaveBeenCalledTimes(1);
    expect(engine.getExportDecoder("m1")).toBeNull();
  });

  it("keeps and disposes a decoder on the success path", async () => {
    engineMediabunny.getPrimaryVideoTrack = () =>
      Promise.resolve({
        displayWidth: 640,
        displayHeight: 360,
        canDecode: async () => true,
      });
    const inputDispose = vi.fn();
    engineMediabunny.inputDispose = inputDispose;

    const engine = new MediaBunnyEngine();
    await engine.initialize();
    const decoder = await engine.createExportDecoder("m2", new Blob(["ok"]));
    expect(decoder).not.toBeNull();
    expect(engine.getExportDecoder("m2")).toBe(decoder);
    expect(inputDispose).not.toHaveBeenCalled();
    engine.disposeExportDecoder("m2");
    expect(inputDispose).toHaveBeenCalledTimes(1);
  });
});
