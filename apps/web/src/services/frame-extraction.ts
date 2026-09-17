/**
 * Frame extraction for local clip analysis (Auto Reframe).
 *
 * Decodes a bounded, evenly spaced sample of frames from a clip's source
 * media blob so the browser-side analysis engines never need the whole
 * timeline. The sample count is hard-capped (MAX_ANALYSIS_FRAMES) so a long
 * clip cannot exhaust memory; the extracted set always includes the clip's
 * first and last analysis moments.
 *
 * The seek/decode seam is injectable (FrameGrabberFactory): tests substitute
 * a fake grabber, and the default implementation uses an HTMLVideoElement
 * plus a canvas, mirroring media-bridge's thumbnail path.
 */

/** Hard cap on frames extracted for one analysis pass. */
export const MAX_ANALYSIS_FRAMES = 300;

/** Default sampling rate when the caller does not pass one (fps). */
const DEFAULT_SAMPLE_FPS = 30;

export interface FrameExtractionOptions {
  /** Clip in-point in SOURCE media seconds (extraction starts here). */
  readonly inPoint: number;
  /** Clip out-point in SOURCE media seconds (inclusive when reachable). */
  readonly outPoint: number;
  /** Desired samples per second; clamped so the frame cap is respected. */
  readonly sampleFps?: number;
  /** Hard cap override; must stay within MAX_ANALYSIS_FRAMES. */
  readonly maxFrames?: number;
}

export interface FrameExtractionResult {
  /** Decoded frames, in sampling order. Close them when done analyzing. */
  readonly frames: ImageBitmap[];
  /**
   * Samples per second the frames were taken at — feed this to analyzers
   * that derive time from frame index (frame i ≙ source offset i/frameRate).
   */
  readonly frameRate: number;
  /** Source-media seconds each frame was sampled at. */
  readonly times: readonly number[];
}

/**
 * One seekable decoder over a media blob. `duration` returns the media's
 * duration in seconds, `grabAt` decodes the frame at a source time, and
 * `dispose` releases the underlying player.
 */
export interface FrameGrabber {
  duration(): number;
  grabAt(time: number): Promise<ImageBitmap>;
  dispose(): void;
}

export type FrameGrabberFactory = (blob: Blob) => Promise<FrameGrabber>;

/**
 * Computes the source-media sample times for one clip span: evenly spaced
 * from inPoint to the reachable outPoint (clamped by the media duration),
 * first and last included, never more than the cap. Returns [] when the span
 * is empty.
 */
export function computeFrameTimes(
  mediaDuration: number,
  options: FrameExtractionOptions,
): number[] {
  const { inPoint, outPoint } = options;
  const spanEnd = Math.min(outPoint, mediaDuration);
  const span = spanEnd - inPoint;
  if (!(span > 0)) return [];

  const maxFrames = Math.min(
    MAX_ANALYSIS_FRAMES,
    Math.max(1, options.maxFrames ?? MAX_ANALYSIS_FRAMES),
  );
  const desiredFps = Math.max(
    1,
    options.sampleFps ?? DEFAULT_SAMPLE_FPS,
  );
  // ceil(span * fps) intervals + 1 keeps both ends at the requested rate.
  const count = Math.min(
    maxFrames,
    Math.max(2, Math.ceil(span * desiredFps) + 1),
  );
  const step = span / (count - 1);
  const times: number[] = [];
  for (let index = 0; index < count; index++) {
    times.push(inPoint + index * step);
  }
  return times;
}

/**
 * Extracts frames for a clip span from a media blob. The analysis frame rate
 * is derived from the actual sample spacing so analyzer times line up with
 * source offsets (frame i ≙ source offset i/frameRate from the in-point).
 */
export async function extractFramesForAnalysis(
  blob: Blob,
  options: FrameExtractionOptions,
  grabberFactory: FrameGrabberFactory = createVideoFrameGrabber,
): Promise<FrameExtractionResult> {
  const grabber = await grabberFactory(blob);
  try {
    const times = computeFrameTimes(grabber.duration(), options);
    if (times.length === 0) {
      return { frames: [], frameRate: 1, times: [] };
    }
    const frames: ImageBitmap[] = [];
    try {
      for (const time of times) {
        frames.push(await grabber.grabAt(time));
      }
    } catch (error) {
      closeFrames(frames);
      throw error;
    }
    const span = times[times.length - 1]! - times[0]!;
    const frameRate =
      times.length > 1 && span > 0 ? (times.length - 1) / span : 1;
    return { frames, frameRate, times };
  } finally {
    grabber.dispose();
  }
}

/** Closes decoded bitmaps best-effort (analysis done or aborted mid-way). */
export function closeFrames(frames: readonly ImageBitmap[]): void {
  for (const frame of frames) {
    try {
      frame.close();
    } catch {
      // Some environments hand out bitmaps without close(); nothing to free.
    }
  }
}

/**
 * Default grabber: HTMLVideoElement seek + canvas draw, mirroring the
 * media-bridge thumbnail decode path (muted, metadata preload, seeked
 * await, 2.5 s event timeouts).
 */
export const createVideoFrameGrabber: FrameGrabberFactory = async (blob) => {
  const url = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";

  const waitForEvent = (eventName: "loadedmetadata" | "seeked") =>
    new Promise<void>((resolve, reject) => {
      const timeoutId = window.setTimeout(
        () => finish(new Error("Frame extraction decode timed out")),
        2500,
      );
      const finish = (error?: Error) => {
        window.clearTimeout(timeoutId);
        video.removeEventListener(eventName, onEvent);
        video.removeEventListener("error", onError);
        if (error) reject(error);
        else resolve();
      };
      const onEvent = () => finish();
      const onError = () => finish(new Error("Frame extraction decode failed"));
      video.addEventListener(eventName, onEvent, { once: true });
      video.addEventListener("error", onError, { once: true });
    });

  await waitForEvent("loadedmetadata");

  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth || 2;
  canvas.height = video.videoHeight || 2;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
    throw new Error("Frame extraction canvas unavailable");
  }

  return {
    duration() {
      return Number.isFinite(video.duration) && video.duration > 0
        ? video.duration
        : 0;
    },
    async grabAt(time: number) {
      if (Math.abs(video.currentTime - time) > 0.001) {
        video.currentTime = time;
        await waitForEvent("seeked");
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      return createImageBitmap(canvas);
    },
    dispose() {
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    },
  };
};
