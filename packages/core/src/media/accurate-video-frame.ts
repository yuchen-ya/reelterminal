import type { CanvasSink, CanvasSinkOptions, InputVideoTrack, VideoSample, WrappedCanvas } from "mediabunny";

let clamped709: boolean | undefined;

/** Probe actual execution, never capability/catalog discovery. No GPU is required. */
export function needsAccurate709Conversion(): boolean {
  if (clamped709 !== undefined) return clamped709;
  if (typeof VideoFrame === "undefined" || typeof OffscreenCanvas === "undefined") return false;
  const frame = new VideoFrame(new Uint8Array([31, 31, 31, 31, 239, 117]), {
    format: "I420", codedWidth: 2, codedHeight: 2, timestamp: 0,
    colorSpace: { matrix: "bt709", primaries: "bt709", transfer: "bt709", fullRange: false },
  });
  try {
    const context = new OffscreenCanvas(2, 2).getContext("2d")!;
    context.drawImage(frame, 0, 0);
    // Correct blue is 252. libyuv's bounded 709 coefficient produces 239.
    return clamped709 = context.getImageData(0, 0, 1, 1).data[2] < 248;
  } finally { frame.close(); }
}

/** Exact limited-range BT.709 matrix; retain head/footroom until RGB clipping. */
export function bt709PlaneRgba(data: Uint8Array, planes: PlaneLayout[], width: number, height: number, format: string): Uint8ClampedArray {
  const subX = format.startsWith("I444") ? 1 : 2;
  const subY = format.startsWith("I422") || format.startsWith("I444") ? 1 : 2;
  const nv12 = format === "NV12";
  const alpha = format.endsWith("A") ? planes[3] : undefined;
  const validate = (plane: PlaneLayout | undefined, w: number, h: number) => {
    if (!plane || !Number.isSafeInteger(plane.offset) || !Number.isSafeInteger(plane.stride) ||
        plane.offset < 0 || plane.stride < w || plane.offset + (h - 1) * plane.stride + w > data.length)
      throw new Error("Video plane layout exceeds its buffer");
  };
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw new Error("Invalid video dimensions");
  validate(planes[0], width, height);
  validate(planes[1], Math.ceil(width / subX) * (nv12 ? 2 : 1), Math.ceil(height / subY));
  if (!nv12) validate(planes[2], Math.ceil(width / subX), Math.ceil(height / subY));
  if (format.endsWith("A")) validate(alpha, width, height);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const yRow = planes[0].offset + y * planes[0].stride;
    const chromaY = subY === 1 ? y : y >> 1;
    const uRow = planes[1].offset + chromaY * planes[1].stride;
    const vRow = nv12 ? uRow : planes[2].offset + chromaY * planes[2].stride;
    const aRow = alpha ? alpha.offset + y * alpha.stride : 0;
    for (let x = 0; x < width; x++) {
      const chromaX = subX === 1 ? x : x >> 1;
      const ui = uRow + chromaX * (nv12 ? 2 : 1);
      const vi = nv12 ? ui + 1 : vRow + chromaX;
      const luma = 1.1643835616438356 * (data[yRow + x] - 16), cb = data[ui] - 128, cr = data[vi] - 128;
      const offset = (y * width + x) * 4;
      rgba[offset] = Math.round(luma + 1.7927410714285714 * cr);
      rgba[offset + 1] = Math.round(luma - 0.21324861427372965 * cb - 0.532909328559444 * cr);
      rgba[offset + 2] = Math.round(luma + 2.112401785714286 * cb);
      rgba[offset + 3] = alpha ? data[aRow + x] : 255;
    }
  }
  return rgba;
}

/** Caller owns both frames; null means the original draw path is unchanged. */
export async function accurate709Frame(frame: VideoFrame): Promise<VideoFrame | null> {
  const color = frame.colorSpace;
  if (!needsAccurate709Conversion() || color.matrix !== "bt709" || color.fullRange !== false ||
      color.primaries !== "bt709" || !["bt709", "iec61966-2-1"].includes(color.transfer ?? "") ||
      !["I420", "I420A", "I422", "I422A", "I444", "I444A", "NV12"].includes(frame.format ?? "")) return null;
  const rect = frame.visibleRect!;
  const bytes = new Uint8Array(frame.allocationSize());
  const planes = await frame.copyTo(bytes);
  const rgba = bt709PlaneRgba(bytes, planes, rect.width, rect.height, frame.format!);
  return new VideoFrame(rgba, {
    format: "RGBA", codedWidth: rect.width, codedHeight: rect.height,
    displayWidth: frame.displayWidth, displayHeight: frame.displayHeight,
    timestamp: frame.timestamp, ...(frame.duration === null ? {} : { duration: frame.duration }),
    colorSpace: { matrix: "rgb", primaries: color.primaries, transfer: color.transfer!, fullRange: true },
  });
}

/** Snapshot synchronously before the asynchronous plane copy can advance video. */
export function colorSafeVideoBitmap(video: HTMLVideoElement, mediaTime = video.currentTime): Promise<ImageBitmap> {
  if (!needsAccurate709Conversion()) return createImageBitmap(video);
  const frame = new VideoFrame(video, { timestamp: Math.round(mediaTime * 1e6) });
  return (async () => {
    let accurate: VideoFrame | null = null;
    try { accurate = await accurate709Frame(frame); return await createImageBitmap(accurate ?? frame); }
    finally { accurate?.close(); frame.close(); }
  })();
}

export type VideoCanvasSink = Pick<CanvasSink, "getCanvas" | "canvases" | "canvasesAtTimestamps">;
type Options = Pick<CanvasSinkOptions, "width" | "height" | "fit" | "poolSize" | "alpha" | "decoderOptions">;

/** Keep the existing decoder, frame ordering and public sample geometry API. */
export function colorSafeCanvasSink(api: typeof import("mediabunny"), track: InputVideoTrack, options: Options = {}): VideoCanvasSink {
  const native = new api.CanvasSink(track, options);
  if (!needsAccurate709Conversion()) return native;
  const samples = new api.VideoSampleSink(track, options.decoderOptions);
  const pool: Array<HTMLCanvasElement | OffscreenCanvas> = [];
  let cursor = 0;
  let dimensions: Promise<{ width: number; height: number; rotation: 0 | 90 | 180 | 270 }> | undefined;
  const geometry = () => dimensions ??= Promise.all([track.getSquarePixelWidth(), track.getSquarePixelHeight(), track.getRotation()]).then(([w, h, rotation]) => {
    const [sourceWidth, sourceHeight] = rotation % 180 ? [h, w] : [w, h];
    const width = options.width ?? (options.height ? Math.round(options.height * sourceWidth / sourceHeight) : sourceWidth);
    const height = options.height ?? (options.width ? Math.round(options.width * sourceHeight / sourceWidth) : sourceHeight);
    return { width, height, rotation };
  });
  const render = async (sample: VideoSample): Promise<WrappedCanvas> => {
    let frame: VideoFrame | undefined, accurate: VideoFrame | null = null, drawing: VideoSample | undefined, resized: VideoSample | undefined;
    try {
      const { width, height, rotation } = await geometry();
      frame = sample.toVideoFrame(); accurate = await accurate709Frame(frame);
      drawing = accurate ? new api.VideoSample(accurate, { timestamp: sample.timestamp, duration: sample.duration, displayWidth: sample.squarePixelWidth, displayHeight: sample.squarePixelHeight }) : undefined;
      let canvas = pool[cursor];
      if (!canvas) {
        canvas = typeof document === "undefined" ? new OffscreenCanvas(width, height) : document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        if (options.poolSize) pool[cursor] = canvas;
      }
      if (options.poolSize) cursor = (cursor + 1) % options.poolSize;
      const context = canvas.getContext("2d", { alpha: options.alpha ?? false }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
      context.imageSmoothingQuality = "high";
      context.clearRect(0, 0, width, height);
      if (!options.alpha) { context.fillStyle = "black"; context.fillRect(0, 0, width, height); }
      const source = drawing ?? sample;
      const [sourceWidth, sourceHeight] = rotation % 180 ? [source.squarePixelHeight, source.squarePixelWidth] : [source.squarePixelWidth, source.squarePixelHeight];
      if (Math.max(sourceWidth / width, sourceHeight / height) > 2) {
        // Reuse the library's public transform for its mipmapped downsampling,
        // rather than replacing its resize quality with one canvas draw.
        resized = await source.transform({ width, height, fit: options.fit ?? "fill", rotate: ((rotation - source.rotation + 360) % 360) as 0 | 90 | 180 | 270, alpha: options.alpha ? "keep" : "discard" });
        resized.draw(context, 0, 0, width, height);
      } else source.drawWithFit(context, { fit: options.fit ?? "fill", rotation });
      return { canvas, timestamp: sample.timestamp, duration: sample.duration };
    } finally { resized?.close(); drawing?.close(); accurate?.close(); frame?.close(); sample.close(); }
  };
  return {
    async getCanvas(timestamp, retrieval) { const sample = await samples.getSample(timestamp, retrieval); return sample && render(sample); },
    async *canvases(start, end, retrieval) { for await (const sample of samples.samples(start, end, retrieval)) yield await render(sample); },
    async *canvasesAtTimestamps(timestamps, retrieval) { for await (const sample of samples.samplesAtTimestamps(timestamps, retrieval)) yield sample && await render(sample); },
  };
}
