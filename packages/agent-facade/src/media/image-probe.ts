/**
 * Minimal image header probing for media.import's image branch.
 *
 * The GUI classifies imported images by extension-derived MIME and decodes
 * dimensions through the DOM `Image` element (`mediabunny-engine.ts`
 * extractImageMetadata). Pure Node has no DOM, so this module is the
 * Node-side equivalent gate: it classifies by the same extension whitelist,
 * verifies the content via magic bytes, and parses width/height straight
 * from the file header. It is deliberately NOT a full image decoder — it
 * proves the file is a recognizable image and reports its dimensions; pixel
 * decoding stays with the GUI/Chromium render path.
 *
 * Memory contract: at most one bounded header read (256 KiB) through a file
 * handle; the file is never read into memory in full.
 */
import { open } from "node:fs/promises";
import path from "node:path";

/** Image extensions media.import accepts — mirrors the GUI's
 * SUPPORTED_IMAGE_FORMATS (JPEG/PNG/WebP/GIF) plus the .jpeg spelling the
 * GUI's extension→MIME map already handles. */
export const SUPPORTED_IMAGE_EXTENSIONS: readonly string[] = [
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
];

/** Image extensions that get a targeted "not supported" error instead of the
 * generic container verdict, so .bmp/.heic/etc. fail with an actionable
 * message (and .svg is steered to the SVG import path). */
const RECOGNIZED_IMAGE_EXTENSIONS: readonly string[] = [
  "bmp",
  "tif",
  "tiff",
  "avif",
  "heic",
  "heif",
  "ico",
  "svg",
];

export type SniffedImageFormat =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp";

export type ImageExtensionVerdict =
  | { readonly kind: "supported"; readonly extension: string }
  | { readonly kind: "recognized-unsupported"; readonly extension: string }
  | { readonly kind: "not-image" };

export interface ImageHeaderFacts {
  readonly mimeType: SniffedImageFormat;
  readonly width: number;
  readonly height: number;
}

/** Bounded header read: covers EXIF-padded JPEGs whose SOF sits past the
 * first kilobytes; every other format needs ≤ 30 bytes. */
const HEADER_READ_LIMIT = 256 * 1024;

/** Classifies a file's extension against the supported image whitelist. */
export function classifyImageExtension(absPath: string): ImageExtensionVerdict {
  const extension = path.extname(absPath).replace(/^\./, "").toLowerCase();
  if (extension.length === 0) return { kind: "not-image" };
  if (SUPPORTED_IMAGE_EXTENSIONS.includes(extension)) {
    return { kind: "supported", extension };
  }
  if (RECOGNIZED_IMAGE_EXTENSIONS.includes(extension)) {
    return { kind: "recognized-unsupported", extension };
  }
  return { kind: "not-image" };
}

/** Magic-byte content sniff for the four supported image formats. */
export function sniffImageFormat(bytes: Uint8Array): SniffedImageFormat | null {
  if (bytes.length >= 8) {
    if (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    ) {
      return "image/png";
    }
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6) {
    const head = String.fromCharCode(
      bytes[0],
      bytes[1],
      bytes[2],
      bytes[3],
      bytes[4],
      bytes[5],
    );
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function readU16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readU24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 +
    ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])
  );
}

/** Parses pixel dimensions from the sniffed header bytes; null when the
 * header is truncated or the format's dimension fields are absent/zero. */
export function parseImageDimensions(
  format: SniffedImageFormat,
  bytes: Uint8Array,
): { width: number; height: number } | null {
  switch (format) {
    case "image/png": {
      // Signature(8) + IHDR length(4) + "IHDR"(4) + width(4, BE) + height(4, BE)
      if (bytes.length < 24) return null;
      const width = readU32BE(bytes, 16);
      const height = readU32BE(bytes, 20);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    case "image/gif": {
      // Header(6) + logical screen width(2, LE) + height(2, LE)
      if (bytes.length < 10) return null;
      const width = readU16LE(bytes, 6);
      const height = readU16LE(bytes, 8);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    case "image/jpeg": {
      // Walk segment markers until a start-of-frame (SOF) carries the dims.
      let offset = 2;
      while (offset + 4 <= bytes.length) {
        if (bytes[offset] !== 0xff) return null;
        const marker = bytes[offset + 1];
        if (marker === 0xff) {
          // Fill byte before a marker — skip one byte and re-read.
          offset += 1;
          continue;
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          // Standalone markers carry no length field.
          offset += 2;
          continue;
        }
        const segmentLength = readU16BE(bytes, offset + 2);
        if (segmentLength < 2) return null;
        if (
          marker >= 0xc0 &&
          marker <= 0xcf &&
          marker !== 0xc4 && // DHT
          marker !== 0xc8 && // JPG (reserved)
          marker !== 0xcc // DAC
        ) {
          if (offset + 9 > bytes.length) return null;
          const height = readU16BE(bytes, offset + 5);
          const width = readU16BE(bytes, offset + 7);
          return width > 0 && height > 0 ? { width, height } : null;
        }
        if (marker === 0xda) {
          // Start of scan reached without a frame header.
          return null;
        }
        offset += 2 + segmentLength;
      }
      return null;
    }
    case "image/webp": {
      const chunk =
        bytes.length >= 16
          ? String.fromCharCode(
              bytes[12],
              bytes[13],
              bytes[14],
              bytes[15],
            )
          : "";
      if (chunk === "VP8 ") {
        // Simple lossy: frame tag(3) + sync code(3) + width(2, 14-bit) + height(2, 14-bit)
        if (bytes.length < 30) return null;
        const width = readU16LE(bytes, 26) & 0x3fff;
        const height = readU16LE(bytes, 28) & 0x3fff;
        return width > 0 && height > 0 ? { width, height } : null;
      }
      if (chunk === "VP8L") {
        // Simple lossless: signature byte then packed (width-1 | height-1 << 14)
        if (bytes.length < 25) return null;
        const bits =
          bytes[21] |
          (bytes[22] << 8) |
          (bytes[23] << 16) |
          (bytes[24] << 24);
        const width = (bits & 0x3fff) + 1;
        const height = ((bits >>> 14) & 0x3fff) + 1;
        return width > 0 && height > 0 ? { width, height } : null;
      }
      if (chunk === "VP8X") {
        // Extended: flags(1) + reserved(3) + canvas width-1(3, LE) + height-1(3, LE)
        if (bytes.length < 30) return null;
        const width = readU24LE(bytes, 24) + 1;
        const height = readU24LE(bytes, 27) + 1;
        return width > 0 && height > 0 ? { width, height } : null;
      }
      return null;
    }
  }
}

/**
 * Reads a bounded header window from disk and extracts format + dimensions.
 *
 * Throws an `Error` with a path-bearing message when the content is not a
 * recognizable supported image or its dimensions cannot be determined.
 */
export async function readImageHeaderFacts(
  absPath: string,
  fileSize: number,
): Promise<ImageHeaderFacts> {
  const handle = await open(absPath, "r");
  try {
    const headerBytes = new Uint8Array(Math.min(fileSize, HEADER_READ_LIMIT));
    const read = await handle.read(
      headerBytes,
      0,
      headerBytes.byteLength,
      0,
    ).then((result) => result.bytesRead);
    const format = sniffImageFormat(headerBytes.subarray(0, read));
    if (!format) {
      throw new Error(
        `Failed to probe image file "${absPath}": content is not a recognizable PNG, JPEG, GIF, or WebP image`,
      );
    }
    const dimensions = parseImageDimensions(format, headerBytes.subarray(0, read));
    if (!dimensions) {
      throw new Error(
        `Failed to probe image file "${absPath}": could not determine image dimensions`,
      );
    }
    return { mimeType: format, ...dimensions };
  } finally {
    await handle.close();
  }
}
