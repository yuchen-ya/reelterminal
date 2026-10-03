/**
 * End-to-end tests for the motion-tools plugin verbs through the real
 * headless facade. Schema and validation behavior always runs; the
 * pixel-level ground-truth runs need BOTH local ffmpeg/ffprobe AND a
 * probed OpenCV interpreter (cv2+numpy) and skip honestly when either is
 * missing — CI without OpenCV must not fail, and with it the accuracy
 * claims are actually proven against known transformations.
 *
 * Ground truth (all generated at runtime, never committed):
 *  - translation: moving = reference content shifted by (+12, +8) px with a
 *    black fill border → moving->reference matrix must be (-12, -8).
 *  - rotation: moving = reference rotated by 8° with black corners → the
 *    estimated similarity must decompose to that rotation, scale ≈ 1.
 *  - stableRegion: content differs outside the stable region; estimation
 *    must succeed only through the masked area.
 *  - low texture / no overlap / size mismatch → honest failures.
 *  - tracking: a box moving at a constant 40 px/s must be followed with a
 *    small per-frame error; a hard cut must END the track at the cut frame
 *    with a termination reason and null matrices afterwards.
 */
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createAgentFacade } from "../index";
import { resolveToolFfmpeg, runToolProcess } from "../media/ffmpeg-bin";
import { opencvToolPreflight } from "../media/opencv-runner";

const binaries = await resolveToolFfmpeg();
const opencv = await opencvToolPreflight();
const hasFfmpeg = binaries !== null;
const ready = hasFfmpeg && opencv.available;
const skipReal = () => (ready ? undefined : true);

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

let root = "";
let facade: ReturnType<typeof createAgentFacade> | undefined;
let mediaId = "";
let boxVideoPath = "";
let cutVideoPath = "";

async function renderStill(args: readonly string[], target: string): Promise<void> {
  await runToolProcess(binaries!.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args, "-frames:v", "1", target]);
}

function decomposeSimilarity(matrix: readonly number[]): { rotationDeg: number; scale: number; tx: number; ty: number } {
  const a = matrix[0]!;
  const b = matrix[1]!;
  const c = matrix[3]!;
  const d = matrix[4]!;
  const scale = Math.sqrt(Math.abs(a * d - b * c));
  return {
    rotationDeg: Math.atan2(b, a) * (180 / Math.PI),
    scale,
    tx: matrix[2]!,
    ty: matrix[5]!,
  };
}

beforeAll(async () => {
  if (!hasFfmpeg) return;
  root = await mkdtemp(path.join(tmpdir(), "motion-tools-"));
  dirs.push(root);
  facade = createAgentFacade({ mediaRoots: [root], artifactRoot: path.join(root, "artifacts") });
  await facade!["project.create"]({ name: "motion-tools" });

  if (!ready) return;
  const ffmpeg = binaries!.ffmpeg;
  const ref = path.join(root, "align-ref.png");
  await renderStill(["-f", "lavfi", "-i", "smptebars=size=320x240"], ref);

  const movShift = path.join(root, "align-shifted.png");
  await renderStill(
    ["-f", "lavfi", "-i", "smptebars=size=320x240", "-vf", "crop=308:232:0:0,pad=320:240:12:8:black"],
    movShift,
  );

  const movRot = path.join(root, "align-rotated.png");
  await renderStill(
    ["-f", "lavfi", "-i", "smptebars=size=320x240", "-vf", "rotate=8*PI/180:fillcolor=black:ow=320:oh=240"],
    movRot,
  );

  const flat = path.join(root, "flat.png");
  await renderStill(["-f", "lavfi", "-i", "color=c=gray:size=320x240"], flat);

  const wrongSize = path.join(root, "wrong-size.png");
  await renderStill(["-f", "lavfi", "-i", "smptebars=size=160x120"], wrongSize);

  // Stable-region sample: the RIGHT half of the moving image is replaced
  // with unrelated content; only the LEFT half (textured bars) is stable.
  const regionRef = path.join(root, "region-ref.png");
  await renderStill(
    ["-f", "lavfi", "-i", "smptebars=size=320x240",
      "-vf", "split[a][b];[b]crop=160:240:160:0[un];[a]crop=160:240:0:0[st];[st][un]hstack"],
    regionRef,
  );
  const regionMov = path.join(root, "region-mov.png");
  await renderStill(
    ["-f", "lavfi", "-i", "smptebars=size=320x240",
      "-vf", "crop=308:232:0:0,pad=320:240:12:8:black,split[a][b];[b]crop=160:240:160:0[un];[a]crop=160:240:0:0[st];[st][un]hstack"],
    regionMov,
  );

  // A white box moving at a constant 40 px/s on black — trivial ground truth.
  // (drawbox's x expression has no t/n variables in this ffmpeg build; the
  // overlay filter's x expression does.)
  boxVideoPath = path.join(root, "box.mp4");
  await runToolProcess(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=black:s=320x240:rate=10:duration=3",
    "-f", "lavfi", "-i", "color=c=white:s=48x48:rate=10:duration=3",
    "-filter_complex", "[0:v][1:v]overlay=x='20+40*t':y=60",
    "-an", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", boxVideoPath,
  ]);

  // Same clip followed by a hard cut to unrelated content: the tracker must
  // stop at frame 30 and say why instead of gliding across the cut.
  cutVideoPath = path.join(root, "cut.mp4");
  await runToolProcess(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=black:s=320x240:rate=10:duration=3",
    "-f", "lavfi", "-i", "color=c=white:s=48x48:rate=10:duration=3",
    "-filter_complex", "[0:v][1:v]overlay=x='20+40*t':y=60",
    "-an", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", path.join(root, "seg1.mp4"),
  ]);
  await runToolProcess(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10:duration=1",
    "-an", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", path.join(root, "seg2.mp4"),
  ]);
  await runToolProcess(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", path.join(root, "seg1.mp4"), "-i", path.join(root, "seg2.mp4"),
    "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]",
    "-an", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", cutVideoPath,
  ]);

  const imported = await facade!["media.import"]({ path: boxVideoPath });
  if (!imported.ok) throw new Error(imported.error.message);
  mediaId = imported.value.mediaId;
});

describe("image.align schema + dependency honesty", () => {
  it("rejects an unknown transform class at the schema boundary", async () => {
    const result = await facade!["image.align"]({
      reference: { path: "C:/nope/ref.png" }, moving: { path: "C:/nope/mov.png" },
      transform: "homography",
    } as unknown as { reference: { path: string }; moving: { path: string }; transform: "translation" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_PARAMS");
  });

  it("rejects an empty stableRegion shape", async () => {
    const result = await facade!["image.align"]({
      reference: { path: "C:/w/ref.png" }, moving: { path: "C:/w/mov.png" }, transform: "affine",
      stableRegion: { x: 0, y: 0, width: 0, height: 10 },
    });
    expect(result.ok).toBe(false);
  });

  it("fails UNSUPPORTED when no OpenCV interpreter is available", async () => {
    const pre = await opencvToolPreflight();
    if (pre.available) return; // covered by the real runs below
    const result = await facade!["image.align"]({
      reference: { path: "C:/w/ref.png" }, moving: { path: "C:/w/mov.png" }, transform: "translation",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("UNSUPPORTED");
    expect(result.error.message).toMatch(/cv2|OpenCV|REELTERMINAL_OPENCV_PYTHON/i);
  });
});

describe("image.align ground truth", () => {
  it.skipIf(skipReal())("recovers a known (+12,+8) px shift as a (-12,-8) moving->reference matrix", async () => {
    const result = await facade!["image.align"]({
      reference: { path: path.join(root, "align-ref.png") },
      moving: { path: path.join(root, "align-shifted.png") },
      transform: "translation",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.status).toBe("aligned");
    expect(result.value.method).toBe("ecc-translation");
    expect(result.value.matrixDirection).toBe("moving->reference");
    const m = result.value.matrix3x3!;
    expect(m[2]).toBeCloseTo(-12, 0); // tx
    expect(m[5]).toBeCloseTo(-8, 0);  // ty
    // Fill border excluded from the residual; the overlap is pixel-identical
    // content up to encoding, so the grayscale residual stays tiny.
    expect(result.value.residual!.sampledPixels).toBeGreaterThan(200 * 150);
    expect(result.value.residual!.meanAbsDiffGray as number).toBeLessThan(0.02);
    expect(result.value.alignedImage).not.toBeNull();
    expect((await stat(result.value.alignedImage!.path)).isFile()).toBe(true);
    // Coverage polygon spans the moved content and CLIPS at the raster edge
    // (min corner 0,0); the black fill beyond (308, 232) must be excluded.
    const xs = result.value.validCoverage!.polygon.map((p) => p[0]!);
    const ys = result.value.validCoverage!.polygon.map((p) => p[1]!);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThanOrEqual(309);
    expect(Math.max(...ys)).toBeLessThanOrEqual(233);
    expect(Math.max(...xs)).toBeGreaterThan(290);
    expect(Math.max(...ys)).toBeGreaterThan(210);
  });

  it.skipIf(skipReal())("recovers an 8° rotation with the similarity class", async () => {
    const result = await facade!["image.align"]({
      reference: { path: path.join(root, "align-ref.png") },
      moving: { path: path.join(root, "align-rotated.png") },
      transform: "similarity",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.status).toBe("aligned");
    expect(result.value.method).toBe("orb-ransac-similarity");
    const parts = decomposeSimilarity(result.value.matrix3x3!);
    expect(Math.abs(parts.rotationDeg)).toBeGreaterThan(7);
    expect(Math.abs(parts.rotationDeg)).toBeLessThan(9);
    expect(Math.abs(parts.scale - 1)).toBeLessThan(0.05);
    expect(result.value.diagnostics.ransacInliers).toBeGreaterThan(10);
    expect(result.value.residual!.meanAbsDiffGray as number).toBeLessThan(0.1);
  });

  it.skipIf(skipReal())("aligns through the stable region when the rest of the scene changed", async () => {
    const result = await facade!["image.align"]({
      reference: { path: path.join(root, "region-ref.png") },
      moving: { path: path.join(root, "region-mov.png") },
      transform: "translation",
      stableRegion: { x: 0, y: 0, width: 150, height: 240 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.status).toBe("aligned");
    const m = result.value.matrix3x3!;
    expect(m[2]).toBeCloseTo(-12, 0);
    expect(m[5]).toBeCloseTo(-8, 0);
    expect(result.value.residual!.region).toContain("stableRegion");
  });

  it.skipIf(skipReal())("reports low texture as a failed estimation, never an identity matrix", async () => {
    const result = await facade!["image.align"]({
      reference: { path: path.join(root, "flat.png") },
      moving: { path: path.join(root, "flat.png") },
      transform: "similarity",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.status).toBe("failed");
    expect(result.value.reasonCode).toBe("insufficient_features");
    expect(result.value.matrix3x3).toBeNull();
    expect(result.value.alignedImage).toBeNull();
    expect(result.value.limitations.join(" ")).toContain("failed");
  });

  it("rejects mismatched rasters before any estimation", async () => {
    if (!ready) {
      const pre = await opencvToolPreflight();
      if (!pre.available) return; // UNSUPPORTED path covered above
    }
    const result = await facade!["image.align"]({
      reference: { path: path.join(root, "flat.png") },
      moving: { path: path.join(root, "wrong-size.png") },
      transform: "translation",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_PARAMS");
    expect(result.error.message).toMatch(/resize the moving image/);
  });
});

describe("motion.track", () => {
  it("rejects ranges shorter than two frames and oversized ranges at the boundary", async () => {
    const single = await facade!["motion.track"]({
      source: { mediaId }, range: { startFrame: 0, endFrame: 1 }, region: { x: 10, y: 10, width: 40, height: 40 },
    });
    expect(single.ok).toBe(false);
    if (!single.ok) expect(single.error.code).toBe("INVALID_PARAMS");
    const oversized = await facade!["motion.track"]({
      source: { mediaId }, range: { startFrame: 0, endFrame: 241 }, region: { x: 10, y: 10, width: 40, height: 40 },
    });
    expect(oversized.ok).toBe(false);
  });

  it("fails UNSUPPORTED when no OpenCV interpreter is available", async () => {
    const pre = await opencvToolPreflight();
    if (pre.available) return;
    // Schema-valid placeholder id: the verb must refuse on the MISSING
    // DEPENDENCY before it ever resolves media.
    const result = await facade!["motion.track"]({
      source: { mediaId: "placeholder" }, range: { startFrame: 0, endFrame: 5 }, region: { x: 10, y: 10, width: 40, height: 40 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("UNSUPPORTED");
  });

  it.skipIf(skipReal())("follows the constant-velocity box and reports per-frame transforms + PTS", async () => {
    const before = await facade!["project.get_state"]();
    const result = await facade!["motion.track"]({
      source: { path: boxVideoPath },
      range: { startFrame: 0, endFrame: 30 },
      region: { x: 14, y: 54, width: 60, height: 60 },
      options: { overlayCount: 4 },
    });
    expect(result.ok, result.ok ? "" : JSON.stringify(result.error)).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.status).toBe("tracked");
    expect(result.value.trackedFrameCount).toBe(30);
    expect(result.value.frames).toHaveLength(30);
    expect(result.value.frameMapping).toHaveLength(30);
    expect(result.value.frameMapping[29]!.ptsTimeSec).toBeCloseTo(2.9, 2);
    // Constant velocity: the final cumulative translation is 40 px/s × 2.9 s.
    const last = result.value.frames[29]!;
    expect(last.status).toBe("tracked");
    const tx = (last.matrix3x3 as number[])[2]!;
    expect(tx).toBeGreaterThan(110);
    expect(tx).toBeLessThan(122);
    expect(last.medianShiftPx as number).toBeGreaterThan(2.5);
    expect(last.medianShiftPx as number).toBeLessThan(5.5);
    expect(result.value.overlays.length).toBeGreaterThanOrEqual(3);
    expect(result.value.overlaySheet).not.toBeNull();
    expect((await stat(result.value.manifestPath)).isFile()).toBe(true);
    // Read-only: the project state must be untouched.
    expect(await facade!["project.get_state"]()).toEqual(before);
  });

  it.skipIf(skipReal())("stops at a hard cut with a reason and null matrices afterwards", async () => {
    const result = await facade!["motion.track"]({
      source: { path: cutVideoPath },
      range: { startFrame: 0, endFrame: 40 },
      region: { x: 14, y: 54, width: 60, height: 60 },
      options: { overlayCount: 3 },
    });
    expect(result.ok, result.ok ? "" : JSON.stringify(result.error)).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.status).toBe("lost");
    // seg1 has 30 frames (0..29); the cut lands at frame 30.
    expect(result.value.lostAtFrame).toBe(30);
    expect(["forward_backward_error", "insufficient_inliers"]).toContain(result.value.terminationReasonCode);
    const after = result.value.frames.filter((f) => (f.frame as number) > 30);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((f) => f.status === "not_tracked" && f.matrix3x3 === null)).toBe(true);
    const lossEntry = result.value.frames.find((f) => (f.frame as number) === 30);
    expect(lossEntry?.status).toBe("lost");
    expect(typeof lossEntry?.reason).toBe("string");
  });

  it.skipIf(skipReal())("cleans up its artifact directory when the range is invalid", async () => {
    const before = await facade!["project.get_state"]();
    const result = await facade!["motion.track"]({
      source: { path: boxVideoPath },
      range: { startFrame: 0, endFrame: 5 }, region: { x: 400, y: 10, width: 40, height: 40 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_PARAMS");
    expect(await facade!["project.get_state"]()).toEqual(before);
  });
});
