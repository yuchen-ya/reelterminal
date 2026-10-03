/** Real OpenCV/FFmpeg truth fixtures for the candidate patch propagation verb. */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolContext } from "../plugin-api";
import { resolveToolFfmpeg, runToolProcess } from "../media/ffmpeg-bin";
import { opencvToolPreflight } from "../media/opencv-runner";
import { patchPropagationPlugin, type PatchPropagationInput, type PatchPropagationResult } from "./patch-propagation";

const binaries = await resolveToolFfmpeg();
const opencv = await opencvToolPreflight(["propagate.py"]);
const ready = binaries !== null && opencv.available;
const pythonPath = opencv.available ? opencv.details.python : "";
const dirs: string[] = [];
let root = "";
let normalVideo = "";
let cutVideo = "";
let occlusionVideo = "";
let patchPath = "";
let maskPath = "";

afterAll(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function ffmpeg(args: readonly string[]): Promise<void> {
  if (!binaries) throw new Error("ffmpeg is unavailable");
  await runToolProcess(binaries.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
}

async function renderStill(input: string, output: string): Promise<void> {
  await ffmpeg(["-f", "lavfi", "-i", input, "-frames:v", "1", output]);
}

async function makeOverlayVideo(output: string, drawFilter = "") {
  const inputArgs = [
    "-loop", "1", "-framerate", "10", "-i", path.join(root, "bars.png"),
    "-loop", "1", "-framerate", "10", "-i", path.join(root, "texture.png"),
  ];
  const vf = `[0:v][1:v]overlay=x='40+20*t':y='50+20*t':shortest=1${drawFilter},format=yuv444p`;
  await ffmpeg([...inputArgs, "-filter_complex", vf, "-t", "1.2", "-an", "-c:v", "ffv1", "-pix_fmt", "yuv444p", output]);
}

beforeAll(async () => {
  if (!binaries || !opencv.available) return;
  root = await mkdtemp(path.join(tmpdir(), "patch-propagation-"));
  dirs.push(root);
  const artifacts = path.join(root, "artifacts");
  await mkdir(artifacts, { recursive: true });
  await renderStill("smptebars=size=320x240", path.join(root, "bars.png"));
  await renderStill("testsrc2=size=80x60", path.join(root, "texture.png"));
  patchPath = path.join(root, "patch.png");
  const createRgbaPatch = [
    "import cv2,numpy as np,sys",
    "a=np.zeros((240,320,4),np.uint8); a[:,:,:3]=(0,255,0)",
    "a[50:110,40:120,:3]=(0,255,255); a[50:110,40:120,3]=255",
    "ok,data=cv2.imencode('.png',a)",
    "assert ok; data.tofile(sys.argv[1])",
  ].join("; ");
  await runToolProcess(pythonPath, ["-I", "-c", createRgbaPatch, patchPath]);
  await ffmpeg([
    "-f", "lavfi", "-i", "color=black:size=320x240",
    "-vf", "drawbox=x=40:y=50:w=80:h=60:color=white:t=fill",
    "-frames:v", "1", "-pix_fmt", "gray", path.join(root, "mask.png"),
  ]);
  maskPath = path.join(root, "mask.png");
  normalVideo = path.join(root, "moving.mkv");
  await makeOverlayVideo(normalVideo);

  // At the hard cut, the entire 80x60 tracked texture remains pixel-identical
  // in place, but the surrounding scene changes from bars to solid red. This
  // is deliberately adversarial: local LK correspondences alone can survive.
  cutVideo = path.join(root, "hard-cut.mkv");
  await ffmpeg([
    "-f", "lavfi", "-i", "smptebars=size=320x240:rate=10:duration=0.6",
    "-f", "lavfi", "-i", "color=red:size=320x240:rate=10:duration=0.6",
    "-loop", "1", "-framerate", "10", "-i", path.join(root, "texture.png"),
    "-filter_complex",
    "[2:v]split[ta][tb];[0:v][ta]overlay=40:50:shortest=1[a];[1:v][tb]overlay=40:50:shortest=1[b];[a][b]concat=n=2:v=1:a=0,format=yuv444p",
    "-t", "1.2", "-an", "-c:v", "ffv1", "-pix_fmt", "yuv444p", cutVideo,
  ]);

  occlusionVideo = path.join(root, "occlusion.mkv");
  await makeOverlayVideo(occlusionVideo, ",drawbox=x=42:y=52:w=32:h=60:color=black:t=fill:enable='gte(t,0.4)' ");
});

function makeContext(): ToolContext {
  return {
    mode: "headless",
    snapshot: async () => ({ project: {} as never, revision: 7 }),
    artifactRoot: path.join(root, "artifacts"),
    mediaRoots: [root],
    resolveMediaPath: async () => { throw new Error("these fixtures use contained file paths"); },
  };
}

async function propagate(
  sourcePath: string,
  endFrame = 8,
  options: NonNullable<PatchPropagationInput["options"]> = {},
): Promise<PatchPropagationResult> {
  const tool = patchPropagationPlugin.tools[0]!;
  const execute = tool.execute as unknown as (input: PatchPropagationInput, context: ToolContext) => Promise<PatchPropagationResult>;
  return execute({
    source: { path: sourcePath },
    range: { startFrame: 0, endFrame },
    patch: { path: patchPath },
    mask: { path: maskPath },
    options,
    expectedRevision: 7,
  }, makeContext());
}

describe("patch.propagate", () => {
  it.skipIf(!ready)("tracks known translation, preserves pixels outside the moving mask and reports exact PTS", async () => {
    const result = await propagate(normalVideo, 8);
    expect(result.status).toBe("propagated");
    expect(result.patchedCount).toBe(8);
    expect(result.needsRepairCount).toBe(0);
    expect(result.frames[5]!.ptsTimeSec).toBeCloseTo(0.5, 4);
    expect(result.frames[5]!.matrix3x3![2]).toBeCloseTo(10, 0);
    expect(result.frames[5]!.matrix3x3![5]).toBeCloseTo(10, 0);
    expect(result.frames.every((frame) => frame.outsideMaskDifferingPixels === 0)).toBe(true);
    expect(result.overlays.length).toBeGreaterThan(1);
    expect(result.overlaySheet?.format).toBe("png");
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as { frameMapping: { frame: number; ptsTimeSec: number }[] };
    expect(manifest.frameMapping.map((entry) => entry.frame)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(manifest.frameMapping[5]!.ptsTimeSec).toBeCloseTo(0.5, 4);

    const sourceFrame = path.join(path.dirname(result.manifestPath), "extracted", "f000005.png");
    const candidateFrame = result.frames[5]!.artifact.path;
    const alphaCheck = [
      "import cv2,json,numpy as np,sys",
      "src=cv2.imread(sys.argv[1],cv2.IMREAD_COLOR).astype(np.float32)/255.0",
      "out=cv2.imread(sys.argv[2],cv2.IMREAD_COLOR).astype(np.float32)/255.0",
      "patch=cv2.imdecode(np.fromfile(sys.argv[3],dtype=np.uint8),cv2.IMREAD_UNCHANGED).astype(np.float32)/255.0",
      "mask=cv2.imread(sys.argv[4],cv2.IMREAD_GRAYSCALE).astype(np.float32)/255.0",
      "m=np.asarray(json.loads(sys.argv[5]),dtype=np.float64).reshape(3,3)",
      "alpha=mask*patch[:,:,3]",
      "premul=patch[:,:,:3]*alpha[:,:,None]",
      "wa=cv2.warpAffine(alpha,m[:2],(src.shape[1],src.shape[0]),flags=cv2.INTER_LINEAR,borderMode=cv2.BORDER_CONSTANT,borderValue=0)",
      "wp=cv2.warpAffine(premul,m[:2],(src.shape[1],src.shape[0]),flags=cv2.INTER_LINEAR,borderMode=cv2.BORDER_CONSTANT,borderValue=(0,0,0))",
      "expected=np.clip(np.rint((wp+src*(1-wa[:,:,None]))*255),0,255).astype(np.uint8)",
      "edge=(wa>0.01)&(wa<0.99)",
      "warped_rgb=cv2.warpAffine(patch[:,:,:3],m[:2],(src.shape[1],src.shape[0]),flags=cv2.INTER_LINEAR,borderMode=cv2.BORDER_CONSTANT,borderValue=(0,0,0))",
      "naive=np.clip(np.rint((warped_rgb*wa[:,:,None]+src*(1-wa[:,:,None]))*255),0,255).astype(np.uint8)",
      "actual=np.rint(out*255).astype(np.uint8)",
      "print(json.dumps({'correctReferenceMaxError':int(np.abs(expected.astype(np.int16)-actual.astype(np.int16)).max()),'fractionalAlphaPixels':int(edge.sum()),'naiveEdgeMaxError':int(np.abs(naive.astype(np.int16)-actual.astype(np.int16))[edge].max()) if edge.any() else 0}))",
    ].join("; ");
    const alphaResult = await runToolProcess(pythonPath, [
      "-I", "-c", alphaCheck, sourceFrame, candidateFrame, patchPath, maskPath,
      JSON.stringify(result.frames[5]!.matrix3x3),
    ]);
    const alphaMetrics = JSON.parse(alphaResult.stdout.toString("utf8")) as {
      correctReferenceMaxError: number;
      fractionalAlphaPixels: number;
      naiveEdgeMaxError: number;
    };
    expect(alphaMetrics.correctReferenceMaxError).toBeLessThanOrEqual(1);
    expect(alphaMetrics.fractionalAlphaPixels).toBeGreaterThan(0);
    expect(alphaMetrics.naiveEdgeMaxError).toBeGreaterThan(10);
  });

  it.skipIf(!ready)("stops on an obvious hard cut even when the masked texture is retained", async () => {
    const result = await propagate(cutVideo, 12, { overlayCount: 4 });
    expect(result.status).toBe("needsRepair");
    expect(result.termination?.atFrame).toBe(6);
    expect(result.termination?.reasonCode).toBe("scene_change_suspected");
    expect(result.frames.slice(0, 6).every((frame) => frame.status === "patched")).toBe(true);
    expect(result.frames.slice(6).every((frame) => frame.status === "needsRepair")).toBe(true);
    expect(result.overlays.map((overlay) => overlay.frame)).toEqual([0, 3, 6, 11]);
    expect(result.overlays).toHaveLength(4);
    const originalAtCut = await readFile(path.join(path.dirname(result.manifestPath), "extracted", "f000006.png"));
    const outputAtCut = await readFile(result.frames[6]!.artifact.path);
    expect(outputAtCut.equals(originalAtCut)).toBe(true);
    const cutDiagnostics = JSON.parse(await readFile(result.manifestPath, "utf8")) as { frames: { frame: number; sceneChange?: { suspectedSceneChange: boolean } }[] };
    expect(cutDiagnostics.frames.find((frame) => frame.frame === 6)?.sceneChange?.suspectedSceneChange).toBe(true);
  });

  it.skipIf(!ready)("stops when a partial occlusion breaks the similarity fit and byte-copies later source frames", async () => {
    const result = await propagate(occlusionVideo, 10);
    expect(result.status).toBe("needsRepair");
    expect(result.termination?.atFrame).toBeGreaterThanOrEqual(3);
    expect(result.termination?.atFrame).toBeLessThan(7);
    expect(result.termination?.reasonCode).toBe("inconsistent_similarity");
    expect(result.frames.slice(result.termination!.atFrame).every((frame) => frame.status === "needsRepair")).toBe(true);
    const extracted = path.join(path.dirname(result.manifestPath), "extracted", `f${String(result.termination!.atFrame).padStart(6, "0")}.png`);
    const preserved = await readFile(result.frames[result.termination!.atFrame]!.artifact.path);
    expect(preserved.equals(await readFile(extracted))).toBe(true);
  });
});
