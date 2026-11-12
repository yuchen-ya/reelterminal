import { colorSafeVideoBitmap } from "@reelterminal/core/media/accurate-video-frame";

/** Capture the pixels and PTS from the same presented native video frame. */
export function captureNativeVideoFrame(
  video: HTMLVideoElement,
  timeoutMs = 100,
): Promise<{ image: ImageBitmap; mediaTime: number } | null> {
  if (typeof video.requestVideoFrameCallback !== "function") return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      video.cancelVideoFrameCallback(callbackId);
      resolve(null);
    }, timeoutMs);
    const callbackId = video.requestVideoFrameCallback((_now, metadata) => {
      clearTimeout(timeout);
      // Capture immediately inside rVFC; reading currentTime later cannot tell
      // which decoded frame supplied the pixels.
      colorSafeVideoBitmap(video, metadata.mediaTime).then(image => resolve({ image, mediaTime: metadata.mediaTime }), reject);
    });
  });
}
