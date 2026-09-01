/**
 * Pixel assertions without image libraries: decode the render-frame PNG to
 * raw RGBA with the same ffmpeg helper runtime-chromium uses, then compute
 * simple statistics in plain TypeScript.
 */
import {
  extractFrameRgba,
  resolveFfmpegBinaries,
} from "@openreel/runtime-chromium/node/ffmpeg";

export interface PixelStats {
  readonly width: number;
  readonly height: number;
  /** Corner-sampled background luma. */
  readonly backgroundLuma: number;
  /** Pixels differing from the background beyond the luma threshold. */
  readonly nonBackgroundCount: number;
  /** Centroid of non-background pixels, normalized 0..1 (null when none). */
  readonly centroid: { x: number; y: number } | null;
  readonly maxLuma: number;
}

async function decodePng(
  pngPath: string,
  width: number,
  height: number,
): Promise<Buffer> {
  const binaries = await resolveFfmpegBinaries();
  if (!binaries) {
    throw new Error("ffmpeg/ffprobe not found on PATH — required for pixel assertions");
  }
  return extractFrameRgba(binaries.ffmpeg, pngPath, 0, width, height);
}

function lumaAt(rgba: Buffer, index: number): number {
  const r = rgba[index]!;
  const g = rgba[index + 1]!;
  const b = rgba[index + 2]!;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Background = median of the four corners (an empty project's frame is a
 * uniform fill; the caption never touches the corners at our test points).
 * Non-background = luma distance from that background beyond `threshold`.
 */
export async function analyzePng(
  pngPath: string,
  width: number,
  height: number,
  threshold = 60,
): Promise<PixelStats> {
  const rgba = await decodePng(pngPath, width, height);
  const corners = [
    lumaAt(rgba, 0),
    lumaAt(rgba, (width - 1) * 4),
    lumaAt(rgba, (height - 1) * width * 4),
    lumaAt(rgba, ((height - 1) * width + width - 1) * 4),
  ].sort((a, b) => a - b);
  const backgroundLuma = (corners[1]! + corners[2]!) / 2;

  let count = 0;
  let sumX = 0;
  let sumY = 0;
  let maxLuma = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const alpha = rgba[i + 3]!;
      if (alpha === 0) continue;
      const luma = lumaAt(rgba, i);
      if (luma > maxLuma) maxLuma = luma;
      if (Math.abs(luma - backgroundLuma) > threshold) {
        count += 1;
        sumX += x;
        sumY += y;
      }
    }
  }

  return {
    width,
    height,
    backgroundLuma,
    nonBackgroundCount: count,
    centroid:
      count > 0
        ? { x: sumX / count / width, y: sumY / count / height }
        : null,
    maxLuma,
  };
}
