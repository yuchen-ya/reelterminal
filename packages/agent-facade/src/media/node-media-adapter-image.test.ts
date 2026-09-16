/**
 * Tests for the image branch of {@link ./node-media-adapter}: extension
 * classification, magic-byte sniffing, header dimension parsing, and the
 * ProbedMedia shape for image files — plus honest rejection of unsupported
 * image formats and of image content hiding behind non-image extensions.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { probeLocalMediaFile } from "./node-media-adapter";
import {
  parseImageDimensions,
  classifyImageExtension,
  sniffImageFormat,
} from "./image-probe";
import {
  TINY_IMAGE_EXPECTED,
  tinyGifBytes,
  tinyJpegBytes,
  tinyPngBytes,
  tinyWebpBytes,
  writeTinyImages,
} from "./fixtures/tiny-images";

describe("tiny image fixtures", () => {
  it("carries the real magic bytes of each format", () => {
    expect(sniffImageFormat(tinyPngBytes())).toBe("image/png");
    expect(sniffImageFormat(tinyJpegBytes())).toBe("image/jpeg");
    expect(sniffImageFormat(tinyGifBytes())).toBe("image/gif");
    expect(sniffImageFormat(tinyWebpBytes())).toBe("image/webp");
  });

  it("classifies extensions against the GUI-aligned whitelist", () => {
    expect(classifyImageExtension("C:/j/artifact.png")).toEqual({
      kind: "supported",
      extension: "png",
    });
    expect(classifyImageExtension("C:/j/a.JPEG")).toEqual({
      kind: "supported",
      extension: "jpeg",
    });
    expect(classifyImageExtension("C:/j/poster.bmp")).toEqual({
      kind: "recognized-unsupported",
      extension: "bmp",
    });
    expect(classifyImageExtension("C:/j/diagram.svg")).toEqual({
      kind: "recognized-unsupported",
      extension: "svg",
    });
    expect(classifyImageExtension("C:/j/clip.mp4")).toEqual({
      kind: "not-image",
    });
    expect(classifyImageExtension("C:/j/noext")).toEqual({ kind: "not-image" });
  });
});

describe("parseImageDimensions (synthetic WebP chunk variants)", () => {
  function webpContainer(chunkFourCc: string, payload: Uint8Array): Uint8Array {
    const bytes = new Uint8Array(20 + payload.length);
    bytes.set([0x52, 0x49, 0x46, 0x46]); // "RIFF"
    const riffSize = 4 + 8 + payload.length; // "WEBP" + chunk header + payload
    bytes[4] = riffSize & 0xff;
    bytes[5] = (riffSize >> 8) & 0xff;
    bytes[6] = (riffSize >> 16) & 0xff;
    bytes[7] = (riffSize >> 24) & 0xff;
    bytes.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
    bytes.set(Buffer.from(chunkFourCc, "latin1"), 12);
    bytes[16] = payload.length & 0xff;
    bytes[17] = (payload.length >> 8) & 0xff;
    bytes[18] = (payload.length >> 16) & 0xff;
    bytes[19] = (payload.length >> 24) & 0xff;
    bytes.set(payload, 20);
    return bytes;
  }

  it("parses simple lossy (VP8) 14-bit dimensions", () => {
    // frame tag(3) + sync code 9D 01 2A + width=320, height=240 (14-bit LE)
    const payload = new Uint8Array(10);
    payload.set([0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a], 0);
    payload[6] = 320 & 0xff;
    payload[7] = (320 >> 8) & 0x3f;
    payload[8] = 240 & 0xff;
    payload[9] = (240 >> 8) & 0x3f;
    expect(parseImageDimensions("image/webp", webpContainer("VP8 ", payload))).toEqual({
      width: 320,
      height: 240,
    });
  });

  it("parses extended (VP8X) canvas dimensions", () => {
    // flags(1) + reserved(3) + canvas width-1 (LE24) + canvas height-1 (LE24)
    const payload = new Uint8Array(10);
    payload[0] = 0x10; // alpha flag, irrelevant to the header parse
    payload.set([100, 0, 0], 4); // width 101
    payload.set([58, 0, 0], 7); // height 59
    expect(parseImageDimensions("image/webp", webpContainer("VP8X", payload))).toEqual({
      width: 101,
      height: 59,
    });
  });

  it("returns null for unknown WebP chunks and truncated headers", () => {
    expect(
      parseImageDimensions("image/webp", webpContainer("XXXX", new Uint8Array(10))),
    ).toBeNull();
    expect(parseImageDimensions("image/png", new Uint8Array(10))).toBeNull();
  });
});

describe("probeLocalMediaFile image branch", () => {
  let fixtureDir: string;
  let pngPath: string;
  let jpegPath: string;
  let gifPath: string;
  let webpPath: string;

  beforeAll(async () => {
    fixtureDir = await mkdtemp(path.join(tmpdir(), "node-media-adapter-image-"));
    const written = writeTinyImages(fixtureDir);
    pngPath = written.pngPath;
    jpegPath = written.jpegPath;
    gifPath = written.gifPath;
    webpPath = written.webpPath;
  });

  afterAll(async () => {
    await rm(fixtureDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
  });

  it("probes a PNG's real dimensions with the GUI image metadata shape", async () => {
    const probed = await probeLocalMediaFile(pngPath);

    expect(probed.type).toBe("image");
    expect(probed.width).toBe(TINY_IMAGE_EXPECTED.png.width);
    expect(probed.height).toBe(TINY_IMAGE_EXPECTED.png.height);
    expect(probed.mimeType).toBe("image/png");
    // Static images mirror the GUI's extractImageMetadata: no duration,
    // no frame rate, no codec, no tracks, no audio-derived fields.
    expect(probed.durationSec).toBe(0);
    expect(probed.frameRate).toBe(0);
    expect(probed.codec).toBe("");
    expect(probed.hasVideo).toBe(false);
    expect(probed.hasAudio).toBe(false);
    expect(probed.fileSize).toBe(tinyPngBytes().byteLength);
  }, 30000);

  it("probes a JPEG via the SOF scan past its APP segments", async () => {
    const probed = await probeLocalMediaFile(jpegPath);

    expect(probed.type).toBe("image");
    expect(probed.mimeType).toBe("image/jpeg");
    expect(probed.width).toBe(TINY_IMAGE_EXPECTED.jpeg.width);
    expect(probed.height).toBe(TINY_IMAGE_EXPECTED.jpeg.height);
  }, 30000);

  it("probes a GIF's logical screen size", async () => {
    const probed = await probeLocalMediaFile(gifPath);

    expect(probed.type).toBe("image");
    expect(probed.mimeType).toBe("image/gif");
    expect(probed.width).toBe(TINY_IMAGE_EXPECTED.gif.width);
    expect(probed.height).toBe(TINY_IMAGE_EXPECTED.gif.height);
  }, 30000);

  it("probes a lossless WebP's packed dimensions", async () => {
    const probed = await probeLocalMediaFile(webpPath);

    expect(probed.type).toBe("image");
    expect(probed.mimeType).toBe("image/webp");
    expect(probed.width).toBe(TINY_IMAGE_EXPECTED.webp.width);
    expect(probed.height).toBe(TINY_IMAGE_EXPECTED.webp.height);
  }, 30000);

  it("accepts image content even when the sibling extension differs (content wins)", async () => {
    const mismatched = path.join(fixtureDir, "actually-png.jpg");
    await writeFile(mismatched, tinyPngBytes());
    const probed = await probeLocalMediaFile(mismatched);

    expect(probed.type).toBe("image");
    expect(probed.mimeType).toBe("image/png");
  }, 30000);

  it("rejects text wearing an image extension with a path-bearing error", async () => {
    const fake = path.join(fixtureDir, "actually-text.png");
    await writeFile(fake, "this is definitely not a png", "utf8");
    await expect(probeLocalMediaFile(fake)).rejects.toThrowError(
      /not a recognizable PNG, JPEG, GIF, or WebP image/,
    );
  }, 30000);

  it("rejects an empty image file", async () => {
    const empty = path.join(fixtureDir, "empty.png");
    await writeFile(empty, new Uint8Array(0));
    await expect(probeLocalMediaFile(empty)).rejects.toThrowError(
      /not a recognizable PNG, JPEG, GIF, or WebP image/,
    );
  }, 30000);

  it("names unsupported image formats instead of the generic container verdict", async () => {
    const bmp = path.join(fixtureDir, "poster.bmp");
    // Real BMP magic: 'BM' followed by a plausible file size.
    await writeFile(bmp, new Uint8Array([0x42, 0x4d, 0x46, 0x00, 0x00, 0x00, 0, 0, 0, 0]));
    await expect(probeLocalMediaFile(bmp)).rejects.toThrowError(
      /image format "\.bmp" is not supported — use PNG, JPEG, GIF, or WebP/,
    );

    const svg = path.join(fixtureDir, "diagram.svg");
    await writeFile(svg, "<svg xmlns='http://www.w3.org/2000/svg'></svg>", "utf8");
    await expect(probeLocalMediaFile(svg)).rejects.toThrowError(
      /image format "\.svg" is not supported/,
    );
  }, 30000);

  it("keeps image content behind a non-image extension on the container path", async () => {
    const disguised = path.join(fixtureDir, "payload.dat");
    await writeFile(disguised, tinyPngBytes());
    // The extension gate deliberately follows the GUI's extension-driven
    // classification: without an image extension this is NOT claimed as an
    // image, and the container probe honestly refuses it (same error family
    // as any other non-media byte stream).
    await expect(probeLocalMediaFile(disguised)).rejects.toThrowError(
      /failed to probe|unsupported media/i,
    );
  }, 30000);

  it("reports missing image files like missing media files", async () => {
    await expect(
      probeLocalMediaFile(path.join(fixtureDir, "nope.png")),
    ).rejects.toThrowError(/cannot read media file/i);
  }, 30000);
});
