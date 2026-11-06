import type { SegmentationFrame, SegmentationPrompts, SegmentationRequest } from "./types";

export const MAX_FRAME_PIXELS = 4096 * 4096;
export const MAX_FRAME_DIMENSION = 16384;
/** User-visible points and box corners, excluding the internal no-box padding token. */
export const MAX_PROMPT_TOKENS = 32;
export const MODEL_INPUT_SIZE = 1024;

export function displaySize(frame: Pick<SegmentationFrame, "width" | "height" | "rotation">) {
  return frame.rotation === 90 || frame.rotation === 270
    ? { width: frame.height, height: frame.width }
    : { width: frame.width, height: frame.height };
}

function normalized(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

export function resizedSize(width: number, height: number) {
  const scale = MODEL_INPUT_SIZE / Math.max(width, height);
  return { width: Math.floor(width * scale + 0.5), height: Math.floor(height * scale + 0.5) };
}

export function validateRequest({ frame, refinementId, prompts }: SegmentationRequest): void {
  if (!frame.id || !frame.revision || !Number.isInteger(frame.width) ||
      !Number.isInteger(frame.height) || frame.width <= 0 || frame.height <= 0 ||
      frame.width * frame.height > MAX_FRAME_PIXELS ||
      frame.width > MAX_FRAME_DIMENSION || frame.height > MAX_FRAME_DIMENSION ||
      ![0, 90, 180, 270].includes(frame.rotation) ||
      !(frame.rgba instanceof Uint8Array) || frame.rgba.length !== frame.width * frame.height * 4) {
    throw new Error("Invalid decoded segmentation frame (maximum 4096² pixels)");
  }
  if (typeof refinementId !== "string" || !refinementId || !resizedSize(frame.width, frame.height).width || !resizedSize(frame.width, frame.height).height) {
    throw new Error("A mask refinementId and nonzero resized image dimensions are required");
  }
  const { points, box } = prompts;
  if (!Array.isArray(points) || points.length + (box ? 2 : 0) === 0 ||
      points.length + (box ? 2 : 0) > MAX_PROMPT_TOKENS ||
      points.some(point => !normalized(point.x) || !normalized(point.y) || typeof point.foreground !== "boolean") ||
      (box && (![box.left, box.top, box.right, box.bottom].every(normalized) ||
        box.left >= box.right || box.top >= box.bottom))) {
    throw new Error("MobileSAM accepts 1–32 normalized prompt tokens; a box uses two");
  }
}

export function frameCacheKey(frame: SegmentationFrame): string {
  return JSON.stringify([frame.id, frame.revision, frame.width, frame.height, frame.rotation]);
}

/** Official longest-side transform, before bottom/right padding. */
export function promptTensors(prompts: SegmentationPrompts, width: number, height: number) {
  const coords: number[] = [];
  const labels: number[] = [];
  const resized = resizedSize(width, height);
  for (const point of prompts.points) {
    coords.push(point.x * resized.width, point.y * resized.height);
    labels.push(point.foreground ? 1 : 0);
  }
  if (prompts.box) {
    const { left, top, right, bottom } = prompts.box;
    coords.push(left * resized.width, top * resized.height, right * resized.width, bottom * resized.height);
    labels.push(2, 3);
  } else {
    coords.push(0, 0);
    labels.push(-1);
  }
  return { coords: Float32Array.from(coords), labels: Float32Array.from(labels) };
}

/** Runs only in the worker; alpha is deliberately ignored. */
export function orientedRgb(frame: SegmentationFrame): Uint8Array {
  const size = displaySize(frame);
  const plane = size.width * size.height;
  const output = new Uint8Array(plane * 3);
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      let targetX = x;
      let targetY = y;
      if (frame.rotation === 90) { targetX = frame.height - 1 - y; targetY = x; }
      if (frame.rotation === 180) { targetX = frame.width - 1 - x; targetY = frame.height - 1 - y; }
      if (frame.rotation === 270) { targetX = y; targetY = frame.width - 1 - x; }
      const source = (y * frame.width + x) * 4;
      const target = (targetY * size.width + targetX) * 3;
      output[target] = frame.rgba[source];
      output[target + 1] = frame.rgba[source + 1];
      output[target + 2] = frame.rgba[source + 2];
    }
  }
  return output;
}
