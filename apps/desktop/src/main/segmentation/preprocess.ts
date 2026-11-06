import { displaySize, MODEL_INPUT_SIZE, orientedRgb, resizedSize } from "./geometry";
import type { SegmentationFrame } from "./types";

const COEFFICIENT_SCALE = 2 ** 22;
const MEAN = [123.675, 116.28, 103.53].map(Math.fround);
const STD = [58.395, 57.12, 57.375].map(Math.fround);

interface AxisFilter { start: number; weights: number[] }

/** Antialiased triangle resampling with 8-bit rounding after each separable pass. */
function filters(inputSize: number, outputSize: number): AxisFilter[] {
  const scale = inputSize / outputSize;
  const support = Math.max(1, scale);
  return Array.from({ length: outputSize }, (_, index) => {
    const center = (index + 0.5) * scale;
    const start = Math.max(0, Math.trunc(center - support + 0.5));
    const end = Math.min(inputSize, Math.trunc(center + support + 0.5));
    const weights = Array.from({ length: end - start }, (_, offset) =>
      Math.max(0, 1 - Math.abs((start + offset + 0.5 - center) / support)));
    const sum = weights.reduce((total, weight) => total + weight, 0);
    return { start, weights: weights.map(weight => Math.floor(weight / sum * COEFFICIENT_SCALE + 0.5)) };
  });
}

function roundedByte(sum: number): number {
  return Math.max(0, Math.min(255, Math.floor(sum / COEFFICIENT_SCALE + 0.5)));
}

/** RGB uint8 bilinear resize, matching the author's torchvision/PIL image path. */
export function resizeRgb(rgb: Uint8Array, width: number, height: number, targetWidth: number, targetHeight: number): Uint8Array {
  let horizontal = rgb;
  if (width !== targetWidth) {
    horizontal = new Uint8Array(targetWidth * height * 3);
    const axis = filters(width, targetWidth);
    for (let y = 0; y < height; y++) for (let x = 0; x < targetWidth; x++) {
      const filter = axis[x];
      for (let channel = 0; channel < 3; channel++) {
        let sum = 0;
        for (let offset = 0; offset < filter.weights.length; offset++) {
          sum += rgb[(y * width + filter.start + offset) * 3 + channel] * filter.weights[offset];
        }
        horizontal[(y * targetWidth + x) * 3 + channel] = roundedByte(sum);
      }
    }
  }
  if (height === targetHeight) return horizontal;
  const output = new Uint8Array(targetWidth * targetHeight * 3);
  const axis = filters(height, targetHeight);
  for (let y = 0; y < targetHeight; y++) for (let x = 0; x < targetWidth; x++) {
    const filter = axis[y];
    for (let channel = 0; channel < 3; channel++) {
      let sum = 0;
      for (let offset = 0; offset < filter.weights.length; offset++) {
        sum += horizontal[((filter.start + offset) * targetWidth + x) * 3 + channel] * filter.weights[offset];
      }
      output[(y * targetWidth + x) * 3 + channel] = roundedByte(sum);
    }
  }
  return output;
}

export function preprocessFrame(frame: SegmentationFrame): Float32Array {
  const size = displaySize(frame);
  const target = resizedSize(size.width, size.height);
  const rgb = resizeRgb(orientedRgb(frame), size.width, size.height, target.width, target.height);
  const plane = MODEL_INPUT_SIZE * MODEL_INPUT_SIZE;
  // Padding is normalized zero, not RGB zero followed by normalization.
  const output = new Float32Array(plane * 3);
  for (let y = 0; y < target.height; y++) for (let x = 0; x < target.width; x++) {
    const source = (y * target.width + x) * 3;
    const targetIndex = y * MODEL_INPUT_SIZE + x;
    for (let channel = 0; channel < 3; channel++) {
      output[channel * plane + targetIndex] = Math.fround(rgb[source + channel] - MEAN[channel]) / STD[channel];
    }
  }
  return output;
}
