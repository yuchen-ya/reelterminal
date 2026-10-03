import { mkdtemp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bindTools, collectPluginTools, type ToolContext } from "../plugin-api";
import { validateObject } from "../validate";
import type { FacadeResult } from "../errors";
import { resolveToolFfmpeg, runToolProcess } from "../media/ffmpeg-bin";
import { opencvToolPreflight } from "../media/opencv-runner";
import { maskToolsPlugin, type MaskRefineInput, type MaskRefineResult } from "./mask-tools";

const binaries = await resolveToolFfmpeg();
const openCv = await opencvToolPreflight(["mask_refine.py"]);
const ready = binaries !== null && openCv.available;
const skipReal = () => (ready ? undefined : true);

let root = "";
let sourcePath = "";
let maskPath = "";
let emptyMaskPath = "";
let mismatchedMaskPath = "";
let rgbaMaskPath = "";
let rgbaSourcePath = "";
let sixteenBitMaskPath = "";
let tools: { "mask.refine": (input: MaskRefineInput) => Promise<FacadeResult<MaskRefineResult>> };

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function renderPng(input: string, filters: string, target: string): Promise<void> {
  await runToolProcess(binaries!.ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", input,
    "-vf", filters,
    "-frames:v", "1", "-threads", "1", target,
  ]);
}

async function decodeGray(pathname: string): Promise<Buffer> {
  const { stdout } = await runToolProcess(binaries!.ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-i", pathname,
    "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
  ]);
  return stdout;
}

async function decodeAlpha(pathname: string): Promise<Buffer> {
  const { stdout } = await runToolProcess(binaries!.ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-i", pathname,
    "-vf", "alphaextract", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
  ]);
  return stdout;
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mask-tools-"));
  const artifactRoot = path.join(root, "artifacts");
  await mkdir(artifactRoot, { recursive: true });
  const context = {
    mode: "headless",
    snapshot: async () => ({ project: {} as never, revision: 7 }),
    mediaRoots: [root],
    artifactRoot,
    resolveMediaPath: async () => { throw new Error("path-based test should not resolve media ids"); },
  } as unknown as ToolContext;
  tools = bindTools(collectPluginTools([maskToolsPlugin]), context) as unknown as typeof tools;

  if (!ready) return;
  sourcePath = path.join(root, "source.png");
  maskPath = path.join(root, "mask.png");
  emptyMaskPath = path.join(root, "empty-mask.png");
  mismatchedMaskPath = path.join(root, "mismatch.png");
  rgbaMaskPath = path.join(root, "rgba-mask.png");
  rgbaSourcePath = path.join(root, "rgba-source.png");
  sixteenBitMaskPath = path.join(root, "mask-16bit.png");
  await renderPng("color=c=black:s=64x64", "drawbox=x=20:y=20:w=24:h=24:color=white:t=fill", sourcePath);
  await renderPng("color=c=black:s=64x64", "drawbox=x=20:y=20:w=20:h=20:color=white:t=fill,format=gray", maskPath);
  await renderPng("color=c=black:s=64x64", "format=gray", emptyMaskPath);
  await renderPng("color=c=black:s=32x32", "drawbox=x=8:y=8:w=12:h=12:color=white:t=fill,format=gray", mismatchedMaskPath);
  if (!openCv.available) return;
  const pythonFixtures = [
    "import cv2, numpy as np, sys",
    "rgba_mask = np.full((64, 64, 4), 255, dtype=np.uint8)",
    "rgba_mask[:, :, 3] = 0; rgba_mask[20:40, 20:40, 3] = 255",
    "rgba_source = np.zeros((64, 64, 4), dtype=np.uint8)",
    "rgba_source[:, :, :3] = (60, 100, 180); rgba_source[8:56, 8:56, 3] = 128; rgba_source[20:40, 20:40, 3] = 255",
    "sixteen = np.full((64, 64), 65535, dtype=np.uint16)",
    "for image, path in ((rgba_mask, sys.argv[1]), (rgba_source, sys.argv[2]), (sixteen, sys.argv[3])):",
    "    ok, encoded = cv2.imencode('.png', image)",
    "    assert ok",
    "    encoded.tofile(path)",
  ].join("\n");
  await runToolProcess(openCv.details.python, ["-I", "-c", pythonFixtures, rgbaMaskPath, rgbaSourcePath, sixteenBitMaskPath]);
});

describe("mask.refine input contract", () => {
  it("accepts a standalone mask and both explicit source-based initialization modes", async () => {
    const inputSchema = maskToolsPlugin.tools[0]!.input;
    for (const input of [
      { initialization: { mask: { path: "C:/w/mask.png" } } },
      { initialization: { source: { mediaId: "m1" }, mask: { path: "C:/w/mask.png" } }, dilatePx: 2 },
      { initialization: { source: { path: "C:/w/source.png" }, rect: { x: 10, y: 12, width: 100, height: 80 }, iterations: 5 } },
    ]) {
      expect(validateObject(input, inputSchema, "mask.refine params")).toEqual(input);
    }
  });

  it("rejects missing, conflicting, or malformed initialization and bounded parameters", async () => {
    const invalidInputs = [
      {},
      { initialization: { rect: { x: 0, y: 0, width: 20, height: 20 } } },
      { initialization: { source: { path: "C:/w/source.png" }, mask: { path: "C:/w/mask.png" }, rect: { x: 0, y: 0, width: 20, height: 20 } } },
      { initialization: { mask: { path: "C:/w/mask.png" } }, dilatePx: -1 },
      { initialization: { mask: { path: "C:/w/mask.png" } }, featherPx: 33 },
      { initialization: { mask: { path: "C:/w/mask.png" }, ignored: true } },
    ];
    for (const input of invalidInputs) {
      expect(await tools["mask.refine"](input as never)).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
    }
  });

  it("reports UNSUPPORTED honestly if the selected OpenCV worker is unavailable", async () => {
    if (openCv.available) return;
    const result = await tools["mask.refine"]({ initialization: { mask: { path: "C:/w/mask.png" } } });
    expect(result).toMatchObject({ ok: false, error: { code: "UNSUPPORTED" } });
  });
});

describe("mask.refine real OpenCV sample", () => {
  it.skipIf(skipReal())("writes a grayscale mask and optional overlay without modifying project state", async () => {
    const before = await tools["mask.refine"]({ initialization: { mask: { path: maskPath } } });
    expect(before.ok, before.ok ? "" : JSON.stringify(before.error)).toBe(true);
    if (!before.ok) throw new Error(before.error.message);
    expect(before.value.method).toBe("input-mask");
    expect(before.value.raster).toEqual({ width: 64, height: 64 });
    expect(before.value.maskStats.foregroundPixels).toBeGreaterThan(0);
    expect(before.value.overlayCandidate).toBeNull();
    expect((await stat(before.value.alphaMask.path)).isFile()).toBe(true);
    expect(await decodeGray(before.value.alphaMask.path)).toEqual(await decodeGray(maskPath));

    const onePixelDilated = await tools["mask.refine"]({
      initialization: { mask: { path: maskPath } },
      dilatePx: 1,
    });
    expect(onePixelDilated.ok, onePixelDilated.ok ? "" : JSON.stringify(onePixelDilated.error)).toBe(true);
    if (!onePixelDilated.ok) throw new Error(onePixelDilated.error.message);
    const dilated = await decodeGray(onePixelDilated.value.alphaMask.path);
    const pixelAt = (x: number, y: number) => dilated[y * 64 + x];
    expect(pixelAt(20, 20)).toBe(255);
    expect(pixelAt(19, 20)).toBe(255);
    expect(pixelAt(20, 19)).toBe(255);
    expect(pixelAt(40, 20)).toBe(255);
    expect(pixelAt(20, 40)).toBe(255);
    expect(pixelAt(19, 19)).toBe(0);
    expect(pixelAt(40, 40)).toBe(0);
    expect(pixelAt(18, 20)).toBe(0);

    const withOverlay = await tools["mask.refine"]({
      initialization: { source: { path: sourcePath }, mask: { path: maskPath } },
      dilatePx: 2,
      featherPx: 2,
    });
    expect(withOverlay.ok, withOverlay.ok ? "" : JSON.stringify(withOverlay.error)).toBe(true);
    if (!withOverlay.ok) throw new Error(withOverlay.error.message);
    expect(withOverlay.value.overlayCandidate).not.toBeNull();
    expect((await stat(withOverlay.value.overlayCandidate!.path)).isFile()).toBe(true);
    expect(withOverlay.value.maskStats.foregroundPixels).toBeGreaterThan(before.value.maskStats.foregroundPixels);
    expect(withOverlay.value.maskStats.softEdgePixels).toBeGreaterThan(0);

    const rgbaMask = await tools["mask.refine"]({ initialization: { mask: { path: rgbaMaskPath } } });
    expect(rgbaMask.ok, rgbaMask.ok ? "" : JSON.stringify(rgbaMask.error)).toBe(true);
    if (!rgbaMask.ok) throw new Error(rgbaMask.error.message);
    expect(await decodeGray(rgbaMask.value.alphaMask.path)).toEqual(await decodeAlpha(rgbaMaskPath));

    const rgbaOverlay = await tools["mask.refine"]({
      initialization: { source: { path: rgbaSourcePath }, mask: { path: maskPath } },
    });
    expect(rgbaOverlay.ok, rgbaOverlay.ok ? "" : JSON.stringify(rgbaOverlay.error)).toBe(true);
    if (!rgbaOverlay.ok) throw new Error(rgbaOverlay.error.message);
    expect(await decodeAlpha(rgbaOverlay.value.overlayCandidate!.path)).toEqual(await decodeAlpha(rgbaSourcePath));

    const grabCut = await tools["mask.refine"]({
      initialization: { source: { path: sourcePath }, rect: { x: 12, y: 12, width: 40, height: 40 }, iterations: 3 },
    });
    expect(grabCut.ok, grabCut.ok ? "" : JSON.stringify(grabCut.error)).toBe(true);
    if (!grabCut.ok) throw new Error(grabCut.error.message);
    expect(grabCut.value.method).toBe("grabcut-rectangle-initialization");
    expect(grabCut.value.overlayCandidate).not.toBeNull();
    expect(grabCut.value.maskStats.foregroundPixels).toBeGreaterThan(0);
  });

  it.skipIf(skipReal())("rejects empty, mismatched, and out-of-bounds inputs and cleans partial artifacts", async () => {
    const artifactRoot = path.join(root, "artifacts");
    const outputDir = path.join(artifactRoot, "mask-tools");
    const before = await readdir(outputDir);
    for (const input of [
      { initialization: { mask: { path: emptyMaskPath } } },
      { initialization: { source: { path: sourcePath }, mask: { path: mismatchedMaskPath } } },
      { initialization: { mask: { path: sixteenBitMaskPath } } },
      { initialization: { source: { path: sourcePath }, rect: { x: 50, y: 50, width: 20, height: 20 } } },
    ]) {
      const result = await tools["mask.refine"](input as never);
      expect(result).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
      if (!result.ok && result.error.message.includes("16-bit")) {
        expect(result.error.message).toContain("8-bit PNG only");
      }
    }
    expect(await readdir(outputDir)).toEqual(before);
  });
});
