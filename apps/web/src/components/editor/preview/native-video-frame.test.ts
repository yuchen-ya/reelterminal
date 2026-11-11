import { afterEach, describe, expect, it, vi } from "vitest";
import { captureNativeVideoFrame } from "./native-video-frame";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("native video frame capture", () => {
  it("pairs the captured pixels with the presented PTS rather than the media clock", async () => {
    let present: VideoFrameRequestCallback | undefined;
    const video = {
      currentTime: 2,
      requestVideoFrameCallback: vi.fn((callback: VideoFrameRequestCallback) => {
        present = callback;
        return 7;
      }),
      cancelVideoFrameCallback: vi.fn(),
    } as unknown as HTMLVideoElement;
    const image = { width: 320, height: 180 } as ImageBitmap;
    const capture = vi.fn().mockResolvedValue(image);
    vi.stubGlobal("createImageBitmap", capture);

    const result = captureNativeVideoFrame(video);
    present!(0, { mediaTime: 1.933333 } as VideoFrameCallbackMetadata);

    await expect(result).resolves.toEqual({ image, mediaTime: 1.933333 });
    expect(capture).toHaveBeenCalledWith(video);
  });

  it("cancels a stalled callback and lets the caller use exact composition", async () => {
    vi.useFakeTimers();
    const cancelVideoFrameCallback = vi.fn();
    const video = {
      requestVideoFrameCallback: vi.fn(() => 7),
      cancelVideoFrameCallback,
    } as unknown as HTMLVideoElement;

    const result = captureNativeVideoFrame(video, 100);
    await vi.advanceTimersByTimeAsync(100);

    await expect(result).resolves.toBeNull();
    expect(cancelVideoFrameCallback).toHaveBeenCalledWith(7);
  });
});
