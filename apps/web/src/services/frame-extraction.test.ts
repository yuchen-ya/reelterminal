/**
 * Frame extraction for local analysis: sample-time computation (cap, span
 * clamping, first/last inclusion) and the extraction loop over the injected
 * grabber seam (no real video decode in tests).
 */
import { describe, expect, it, vi } from "vitest";
import {
  MAX_ANALYSIS_FRAMES,
  closeFrames,
  computeFrameTimes,
  extractFramesForAnalysis,
  type FrameGrabber,
} from "./frame-extraction";

describe("computeFrameTimes", () => {
  it("samples evenly across the clip span including both ends", () => {
    const times = computeFrameTimes(30, { inPoint: 2, outPoint: 5, sampleFps: 10 });
    expect(times).toHaveLength(31); // ceil(3 s * 10 fps) intervals + 1
    expect(times[0]).toBe(2);
    expect(times[times.length - 1]).toBeCloseTo(5, 6);
    expect(times[1]! - times[0]!).toBeCloseTo(0.1, 6);
  });

  it("clamps the span to the media duration", () => {
    const times = computeFrameTimes(4, { inPoint: 2, outPoint: 5, sampleFps: 10 });
    expect(times[0]).toBe(2);
    expect(times[times.length - 1]).toBeCloseTo(4, 6);
  });

  it("never exceeds the hard frame cap", () => {
    const times = computeFrameTimes(3600, { inPoint: 0, outPoint: 3600 });
    expect(times).toHaveLength(MAX_ANALYSIS_FRAMES);
    expect(times.length).toBeLessThanOrEqual(300);
    expect(times[0]).toBe(0);
    expect(times[times.length - 1]).toBeCloseTo(3600, 5);
  });

  it("returns nothing for an empty or inverted span", () => {
    expect(computeFrameTimes(10, { inPoint: 5, outPoint: 5 })).toEqual([]);
    expect(computeFrameTimes(10, { inPoint: 6, outPoint: 5 })).toEqual([]);
    expect(computeFrameTimes(1, { inPoint: 5, outPoint: 8 })).toEqual([]);
  });
});

describe("extractFramesForAnalysis", () => {
  function fakeGrabber(duration: number) {
    const grabbedAt: number[] = [];
    const grabber: FrameGrabber = {
      duration: () => duration,
      grabAt: vi.fn(async (time: number) => {
        grabbedAt.push(time);
        return { width: 64, height: 32, close: vi.fn() } as unknown as ImageBitmap;
      }),
      dispose: vi.fn(),
    };
    return { grabber, grabbedAt };
  }

  it("decodes every sampled frame and reports the matching analysis rate", async () => {
    const { grabber, grabbedAt } = fakeGrabber(10);
    const result = await extractFramesForAnalysis(
      new Blob(),
      { inPoint: 1, outPoint: 3, sampleFps: 5 },
      async () => grabber,
    );

    expect(grabbedAt).toHaveLength(11); // 2 s * 5 fps + 1
    expect(grabbedAt[0]).toBe(1);
    expect(grabbedAt[grabbedAt.length - 1]).toBeCloseTo(3, 6);
    expect(result.frames).toHaveLength(grabbedAt.length);
    expect(result.frameRate).toBeCloseTo(5, 6);
    // frame i ≙ source offset i / frameRate from the in-point.
    const sourceOffsets = result.times.map((t) => t - result.times[0]!);
    sourceOffsets.forEach((offset, i) => {
      expect(offset).toBeCloseTo(i / result.frameRate, 6);
    });
    expect(grabber.dispose).toHaveBeenCalled();
  });

  it("closes the frames it decoded", async () => {
    const { grabber } = fakeGrabber(10);
    const result = await extractFramesForAnalysis(
      new Blob(),
      { inPoint: 0, outPoint: 1, sampleFps: 4 },
      async () => grabber,
    );
    closeFrames(result.frames);
    for (const frame of result.frames) {
      expect((frame as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalled();
    }
  });

  it("closes partial frames and rethrows when a grab fails mid-way", async () => {
    const failing: FrameGrabber = {
      duration: () => 10,
      grabAt: vi
        .fn()
        .mockResolvedValueOnce({ width: 1, height: 1, close: vi.fn() })
        .mockRejectedValueOnce(new Error("decode boom")),
      dispose: vi.fn(),
    };
    await expect(
      extractFramesForAnalysis(
        new Blob(),
        { inPoint: 0, outPoint: 2, sampleFps: 4 },
        async () => failing,
      ),
    ).rejects.toThrow("decode boom");
    expect(failing.dispose).toHaveBeenCalled();
  });

  it("short-circuits when the clip span is empty", async () => {
    const { grabber } = fakeGrabber(10);
    const result = await extractFramesForAnalysis(
      new Blob(),
      { inPoint: 7, outPoint: 7 },
      async () => grabber,
    );
    expect(result.frames).toEqual([]);
    expect(grabber.grabAt).not.toHaveBeenCalled();
  });
});
