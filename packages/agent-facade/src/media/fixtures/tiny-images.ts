/**
 * Deterministic tiny image test fixtures, embedded as base64 so that no
 * binary artifact ever lives in the repository.
 *
 * Generated ONCE with ffmpeg 8.1.1 (Gyan full build), outside the repo:
 *   ffmpeg -y -f lavfi -i color=red:size=4x2   -frames:v 1 tiny-4x2.png
 *   ffmpeg -y -f lavfi -i color=lime:size=1x1  -frames:v 1 tiny-1x1.jpg
 *   ffmpeg -y -f lavfi -i color=blue:size=3x2  -frames:v 1 tiny-3x2.gif
 *   ffmpeg -y -f lavfi -i color=yellow:size=5x7 -frames:v 1 -quality 90 tiny-5x7.webp
 *
 * Each is a single-frame static image whose header the adapter's image probe
 * must parse (PNG IHDR, JPEG SOF scan past APP segments, GIF logical screen
 * size, WebP lossy VP8 frame dimensions).
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

export const TINY_PNG_FILENAME = "tiny-4x2.png";
export const TINY_JPEG_FILENAME = "tiny-1x1.jpg";
export const TINY_GIF_FILENAME = "tiny-3x2.gif";
export const TINY_WEBP_FILENAME = "tiny-5x7.webp";

const TINY_PNG_BASE64 = [
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAACXBIWXMAAAABAAAAAQBPJcTWAAAA",
  "EElEQVR4nGP8y4AALEhsBgAZHQEDchTmkQAAAABJRU5ErkJggg==",
].join("");

const TINY_JPEG_BASE64 = [
  "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMQD/2wBDAAgEBAQEBAUFBQUFBQYG",
  "BgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABLAAEB",
  "AAAAAAAAAAAAAAAAAAAABQEBAAAAAAAAAAAAAAAAAAAABxABAAAAAAAAAAAAAAAAAAAAABEBAAAA",
  "AAAAAAAAAAAAAAAAAP/AABEIAAEAAQMBIgACEQADEQD/2gAMAwEAAhEDEQA/AKwAqCb/2Q==",
].join("");

const TINY_GIF_BASE64 = [
  "R0lGODlhAwACAPcfMQAAACQAAEgAAGwAAJAAALQAANgAAPwAAAAkACQkAEgkAGwkAJAkALQkANgkA",
  "PwkAABIACRIAEhIAGxIAJBIALRIANhIAPxIAABsACRsAEhsAGxsAJBsALRsANhsAPxsAACQACSQA",
  "EiQAGyQAJCQALSQANiQAPyQAAC0ACS0AEi0AGy0AJC0ALS0ANi0APy0AADYACTYAEjYAGzYAJDY",
  "ALTYANjYAPzYAAD8ACT8AEj8AGz8AJD8ALT8ANj8APz8AAAAVSQAVUgAVWwAVZAAVbQAVdgAVfwA",
  "VQAkVSQkVUgkVWwkVZAkVbQkVdgkVfwkVQBIVSRIVUhIVWxIVZBIVbRIVdhIVfxIVQBsVSRsVUhs",
  "VWxsVZBsVbRsVdhsVfxsVQCQVSSQVUiQVWyQVZCQVbSQVdiQVfyQVQC0VSS0VUi0VWy0VZC0VbS0",
  "Vdi0Vfy0VQDYVSTYVUjYVWzYVZDYVbTYVdjYVfzYVQD8VST8VUj8VWz8VZD8VbT8Vdj8Vfz8VQAA",
  "qiQAqkgAqmwAqpAAqrQAqtgAqvwAqgAkqiQkqkgkqmwkqpAkqrQkqtgkqvwkqgBIqiRIqkhIqmxI",
  "qpBIqrRIqthIqvxIqgBsqiRsqkhsqmxsqpBsqrRsqthsqvxsqgCQqiSQqkiQqmyQqpCQqrSQqtiQ",
  "qvyQqgC0qiS0qki0qmy0qpC0qrS0qti0qvy0qgDYqiTYqkjYqmzYqpDYqrTYqtjYqvzYqgD8qiT8",
  "qkj8qmz8qpD8qrT8qtj8qvz8qgAA/yQA/0gA/2wA/5AA/7QA/9gA//wA/wAk/yQk/0gk/2wk/5Ak",
  "/7Qk/9gk//wk/wBI/yRI/0hI/2xI/5BI/7RI/9hI//xI/wBs/yRs/0hs/2xs/5Bs/7Rs/9hs//xs",
  "/wCQ/ySQ/0iQ/2yQ/5CQ/7SQ/9iQ//yQ/wC0/yS0/0i0/2y0/5C0/7S0/9i0//y0/wDY/yTY/0jY",
  "/2zY/5DY/7TY/9jY//zY/wD8/yT8/0j8/2z8/5D8/7T8/9j8//z8/yH/C05FVFNDQVBFMi4wAwEA",
  "AAAh+QQEBAAfACwAAAAAAwACAAAIBgCBCRwYEAA7",
].join("");

const TINY_WEBP_BASE64 = [
  "UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoFAAcAAMASJaACdLoB+AADsAD+/i8Y//W636xg/WMH",
  "/rdb/5Kca4h06AA=",
].join("");

function base64Bytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

export function tinyPngBytes(): Uint8Array {
  return base64Bytes(TINY_PNG_BASE64);
}

export function tinyJpegBytes(): Uint8Array {
  return base64Bytes(TINY_JPEG_BASE64);
}

export function tinyGifBytes(): Uint8Array {
  return base64Bytes(TINY_GIF_BASE64);
}

export function tinyWebpBytes(): Uint8Array {
  return base64Bytes(TINY_WEBP_BASE64);
}

function writeBytes(dir: string, filename: string, bytes: Uint8Array): string {
  const filePath = path.join(dir, filename);
  writeFileSync(filePath, bytes);
  return filePath;
}

/** Writes every tiny image into `dir` (which must already exist). */
export function writeTinyImages(dir: string): {
  pngPath: string;
  jpegPath: string;
  gifPath: string;
  webpPath: string;
} {
  return {
    pngPath: writeBytes(dir, TINY_PNG_FILENAME, tinyPngBytes()),
    jpegPath: writeBytes(dir, TINY_JPEG_FILENAME, tinyJpegBytes()),
    gifPath: writeBytes(dir, TINY_GIF_FILENAME, tinyGifBytes()),
    webpPath: writeBytes(dir, TINY_WEBP_FILENAME, tinyWebpBytes()),
  };
}

/** Dimensions the probe must reproduce exactly (measured on the embedded bytes). */
export const TINY_IMAGE_EXPECTED = {
  png: { width: 4, height: 2 },
  jpeg: { width: 1, height: 1 },
  gif: { width: 3, height: 2 },
  webp: { width: 5, height: 7 },
} as const;
