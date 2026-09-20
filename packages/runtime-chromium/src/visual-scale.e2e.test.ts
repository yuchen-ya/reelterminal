/**
 * Regression E2E for the 2026-09-03 contact-sheet compositing defect:
 * at a non-project raster size, visual.inspect frames (and therefore the
 * contact sheet built from them) drew the VIDEO layer ~50% shrunk and
 * centered while TEXT overlays rendered at their unscaled project pixel
 * size — the two layers lived in different coordinate systems. Single-frame
 * renders at the project size and exports were correct, which hid the bug.
 *
 * This test renders the SAME project at full (320x180) and half (160x90)
 * raster sizes and asserts, on real Chromium pixels:
 *
 *   1. The video layer fills the whole frame at half size (no letterbox).
 *   2. A centered text overlay scales with the raster (half-size text is
 *      half as wide/tall as full-size text, measured by diffing against a
 *      text-less render of the same frame).
 *   3. A contact-sheet cell is pixel-identical to the individually
 *      rendered frame of the same sample (same coordinate system contract).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";
import {
  createAgentFacade,
  type AgentFacade,
} from "@reelterminal/agent-facade";

import { createChromiumProviders, type ChromiumProviders } from "./node/providers";
import { writeTinyVp9Mp4 } from "./media/tiny-vp9-mp4";

/* ------------------------- minimal PNG decoder -------------------------- */

interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

/** Decode a non-interlaced 8-bit RGB/RGBA PNG (what canvas convertToBlob emits). */
function decodePng(bytes: Buffer): DecodedPng {
  const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i += 1) {
    if (bytes[i] !== SIGNATURE[i]) throw new Error("not a PNG file");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] as number;
      colorType = data[9] as number;
      interlace = data[12] as number;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0) {
    throw new Error(
      `unsupported PNG shape: bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}`,
    );
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(height * stride);
  const paeth = (a: number, b: number, c: number): number => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor] as number;
    cursor += 1;
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[cursor + x] as number;
      const a = x >= bpp ? (row[x - bpp] as number) : 0;
      const b = prev ? (prev[x] as number) : 0;
      const c = x >= bpp && prev ? (prev[x - bpp] as number) : 0;
      let reconstructed: number;
      switch (filter) {
        case 0: reconstructed = value; break;
        case 1: reconstructed = value + a; break;
        case 2: reconstructed = value + b; break;
        case 3: reconstructed = value + ((a + b) >> 1); break;
        case 4: reconstructed = value + paeth(a, b, c); break;
        default: throw new Error(`unknown PNG filter ${filter}`);
      }
      row[x] = reconstructed & 0xff;
    }
    cursor += stride;
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = pixels[i * bpp] as number;
    rgba[i * 4 + 1] = pixels[i * bpp + 1] as number;
    rgba[i * 4 + 2] = pixels[i * bpp + 2] as number;
    rgba[i * 4 + 3] = bpp === 4 ? (pixels[i * bpp + 3] as number) : 255;
  }
  return { width, height, rgba };
}

/* --------------------------- pixel statistics --------------------------- */

interface BBox {
  readonly count: number;
  readonly width: number;
  readonly height: number;
}

/** Bounding box of every pixel matching `match`. */
function bboxOf(
  image: DecodedPng,
  match: (r: number, g: number, b: number) => boolean,
): BBox {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const i = (y * image.width + x) * 4;
      if (
        match(
          image.rgba[i] as number,
          image.rgba[i + 1] as number,
          image.rgba[i + 2] as number,
        )
      ) {
        count += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { count, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Bounding box of pixels where two same-size renders differ (the text mask). */
function diffBBox(a: DecodedPng, b: DecodedPng, threshold = 30): BBox {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error("diffBBox needs same-size images");
  }
  let minX = a.width;
  let minY = a.height;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  for (let i = 0; i < a.width * a.height; i += 1) {
    const p = i * 4;
    const dr = Math.abs((a.rgba[p] as number) - (b.rgba[p] as number));
    const dg = Math.abs((a.rgba[p + 1] as number) - (b.rgba[p + 1] as number));
    const db = Math.abs((a.rgba[p + 2] as number) - (b.rgba[p + 2] as number));
    if (dr > threshold || dg > threshold || db > threshold) {
      const x = i % a.width;
      const y = Math.floor(i / a.width);
      count += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { count, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Mean per-channel absolute difference between a sheet region and a frame. */
function regionMeanAbsDiff(
  sheet: DecodedPng,
  cellX: number,
  cellY: number,
  frame: DecodedPng,
): number {
  let sum = 0;
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const si = ((cellY + y) * sheet.width + (cellX + x)) * 4;
      const fi = (y * frame.width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        sum += Math.abs(
          (sheet.rgba[si + channel] as number) - (frame.rgba[fi + channel] as number),
        );
      }
    }
  }
  return sum / (frame.width * frame.height * 3);
}

/* --------------------------------- test --------------------------------- */

describe("visual scaling E2E: video/text geometry at non-project raster sizes", () => {
  let mediaRoot: string;
  let artifactRoot: string;
  let providers: ChromiumProviders;
  let facade: AgentFacade;

  beforeAll(async () => {
    mediaRoot = await mkdtemp(path.join(tmpdir(), "visual-scale-media-"));
    artifactRoot = await mkdtemp(path.join(tmpdir(), "visual-scale-artifacts-"));
  }, 60_000);

  afterAll(async () => {
    if (providers) await providers.close();
    if (mediaRoot) await rm(mediaRoot, { recursive: true, force: true });
    if (artifactRoot && process.env.E2E_KEEP_ARTIFACTS !== "1") {
      await rm(artifactRoot, { recursive: true, force: true });
    } else if (artifactRoot) {
      console.log(`[visual-scale] artifacts kept at ${artifactRoot}`);
    }
  });

  it("keeps video full-frame and text scaled at half size; contact sheet cells match single frames", async () => {
    const inputPath = writeTinyVp9Mp4(mediaRoot);
    providers = createChromiumProviders();
    const probe = await providers.probe();
    expect(probe.launchError).toBeUndefined();
    expect(probe.summary.renderAvailable).toBe(true);

    facade = createAgentFacade({
      mediaRoots: [mediaRoot],
      artifactRoot,
      renderProvider: providers.renderProvider,
    });

    // 320x180 project: full-frame tiny VP9 clip + centered 40px white text.
    const created = await facade["project.create"]({
      name: "visual-scale-regression",
      settings: { width: 320, height: 180, frameRate: 30, sampleRate: 48000, channels: 2 },
    });
    expect(created.ok).toBe(true);
    const imported = await facade["media.import"]({ path: inputPath, name: "input.mp4" });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const mediaId = imported.value.mediaId;

    const edited = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "video", trackId: "v1" },
        { op: "clip.add", trackId: "v1", mediaId, startTime: 0, clipId: "c1" },
        { op: "clip.trim", clipId: "c1", inPoint: 0, outPoint: 5 },
        { op: "track.add", trackType: "text", trackId: "t1" },
        {
          op: "text.create",
          trackId: "t1",
          text: "SCALE",
          startTime: 0,
          duration: 5,
          style: { fontSize: 40, fontWeight: "bold", color: "#FFFFFF", textAlign: "center" },
          position: { x: 0.5, y: 0.5 },
          anchor: { x: 0.5, y: 0.5 },
        },
      ],
    });
    expect(edited.ok).toBe(true);

    // Same frame at project size and at half size, text present.
    const full = await facade["preview.render_frame"]({ timeSec: 2.5, width: 320, height: 180 });
    expect(full.ok).toBe(true);
    const half = await facade["preview.render_frame"]({ timeSec: 2.5, width: 160, height: 90 });
    expect(half.ok).toBe(true);
    if (!full.ok || !half.ok) return;

    // visual.inspect at half size: frames + contact sheet (text present).
    const visual = await facade["visual.inspect"]({
      clipId: "c1",
      sampleCount: 2,
      width: 160,
      height: 90,
    });
    expect(visual.ok).toBe(true);
    if (!visual.ok) return;
    expect(visual.value.frames).toHaveLength(2);
    expect(visual.value.contactSheet?.format).toBe("png");
    if (!visual.value.contactSheet) return;

    // Remove the overlay and re-render both sizes: the diff isolates text.
    const timeline = await facade["timeline.get"]();
    if (!timeline.ok) throw new Error("timeline.get failed");
    const overlayId = timeline.value.textOverlays[0]?.id;
    expect(typeof overlayId).toBe("string");
    const deleted = await facade["edit.apply"]({
      ops: [{ op: "text.delete", overlayId: overlayId as string }],
    });
    expect(deleted.ok).toBe(true);

    const fullClean = await facade["preview.render_frame"]({ timeSec: 2.5, width: 320, height: 180 });
    const halfClean = await facade["preview.render_frame"]({ timeSec: 2.5, width: 160, height: 90 });
    expect(fullClean.ok).toBe(true);
    expect(halfClean.ok).toBe(true);
    if (!fullClean.ok || !halfClean.ok) return;

    const dFullText = decodePng(await readFile(full.value.artifact.path));
    const dHalfText = decodePng(await readFile(half.value.artifact.path));
    const dFullClean = decodePng(await readFile(fullClean.value.artifact.path));
    const dHalfClean = decodePng(await readFile(halfClean.value.artifact.path));
    expect([dFullText.width, dFullText.height]).toEqual([320, 180]);
    expect([dHalfText.width, dHalfText.height]).toEqual([160, 90]);

    // 1) The video layer fills the half-size frame edge to edge. The bug
    //    drew it at ~50% centered: the non-black bbox spanned only half the
    //    raster. testsrc2 saturates every edge, so a >24 threshold is safe.
    const cover = bboxOf(dHalfClean, (r, g, b) => Math.max(r, g, b) > 24);
    console.log(
      `[visual-scale] half-size content bbox: ${cover.width}x${cover.height} of 160x90`,
    );
    expect(cover.width).toBeGreaterThanOrEqual(Math.floor(160 * 0.95));
    expect(cover.height).toBeGreaterThanOrEqual(Math.floor(90 * 0.95));

    // 2) The text overlay scales with the raster: the half-size text mask
    //    must be ~half the full-size one in both dimensions (the bug left
    //    text at its project pixel size, ratio ~1.0).
    const textFull = diffBBox(dFullText, dFullClean);
    const textHalf = diffBBox(dHalfText, dHalfClean);
    console.log(
      `[visual-scale] text mask bbox: full=${textFull.width}x${textFull.height} half=${textHalf.width}x${textHalf.height}`,
    );
    expect(textFull.count).toBeGreaterThan(0);
    expect(textHalf.count).toBeGreaterThan(0);
    const widthRatio = textHalf.width / textFull.width;
    const heightRatio = textHalf.height / textFull.height;
    expect(widthRatio).toBeGreaterThan(0.3);
    expect(widthRatio).toBeLessThan(0.7);
    expect(heightRatio).toBeGreaterThan(0.3);
    expect(heightRatio).toBeLessThan(0.7);

    // 3) Contact-sheet cells are pixel-identical to the single frames of the
    //    same samples (one coordinate system across both artifacts).
    const frame0 = decodePng(await readFile(visual.value.frames[0]!.artifact.path));
    const frame1 = decodePng(await readFile(visual.value.frames[1]!.artifact.path));
    const sheet = decodePng(await readFile(visual.value.contactSheet.path));
    // 2 samples => 2 columns x 1 row, padding 8, label height 28.
    expect([sheet.width, sheet.height]).toEqual([2 * (160 + 8) + 8, 90 + 28 + 8 + 8]);
    const cell0Diff = regionMeanAbsDiff(sheet, 8, 8 + 28, frame0);
    const cell1Diff = regionMeanAbsDiff(sheet, 8 + 160 + 8, 8 + 28, frame1);
    console.log(
      `[visual-scale] contact cell vs frame meanAbsDiff: cell0=${cell0Diff.toFixed(3)} cell1=${cell1Diff.toFixed(3)}`,
    );
    expect(cell0Diff).toBeLessThanOrEqual(1);
    expect(cell1Diff).toBeLessThanOrEqual(1);
  });
});
