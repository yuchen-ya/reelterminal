/**
 * Empirical tests for frame-exact algorithms against the real local
 * FFmpeg/FFprobe (skipped honestly when they are not installed — CI without
 * ffmpeg must not fail, and with them the exactness claims are actually
 * proven). The known-content sample is built at runtime in a temp dir:
 *
 *   frames 0-19   testsrc2 (hard cut at 20)
 *   frames 20-39  SMPTE bars (static content — freeze-detection candidate)
 *   frames 40-44  white flash
 *   frames 45-54  black segment
 *   frames 55-64  testsrc2
 *   frames 65-74  frozen clone of frame 64
 */
import { mkdtemp, mkdir, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runToolProcess, resolveToolFfmpeg, probeLabelFont } from "./ffmpeg-bin";
import {
  probeVideoFacts,
  extractFramesExact,
  resolveTargetFrames,
  buildSelectExpr,
  parseShowinfo,
  detectSceneCandidates,
  detectBlackCandidates,
  detectFreezeCandidates,
  composeContactSheet,
  composeCompareImage,
  compareFrameMetrics,
  applyMaskComposite,
  verifyOutsideMaskUnchanged,
} from "./frame-exact";

const binaries = await resolveToolFfmpeg();
const hasFfmpeg = binaries !== null;
const skip = () => (hasFfmpeg ? undefined : true);

let dir = "";
let samplePath = "";
let pathWithSpaces = "";

beforeAll(async () => {
  if (!hasFfmpeg) return;
  dir = await mkdtemp(join(tmpdir(), "frame-exact-"));
  samplePath = join(dir, "sample.mp4");
  await runToolProcess(binaries!.ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10:duration=2",
    "-f", "lavfi", "-i", "smptebars=size=320x180:rate=10:duration=2",
    "-f", "lavfi", "-i", "color=white:size=320x180:rate=10:duration=0.5",
    "-f", "lavfi", "-i", "color=black:size=320x180:rate=10:duration=1",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10:duration=1",
    "-filter_complex",
    "[4:v]tpad=stop_mode=clone:stop_duration=1[frozen];[0:v][1:v][2:v][3:v][frozen]concat=n=5:v=1:a=0[v]",
    "-map", "[v]", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", samplePath,
  ]);
  // A copy under a path with spaces and Chinese characters — the CLI
  // contract must survive both without shell quoting.
  pathWithSpaces = join(dir, "素材 帧段 sample.mp4");
  await writeFile(pathWithSpaces, await (await import("node:fs/promises")).readFile(samplePath));
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("probeVideoFacts", () => {
  it.skipIf(skip())("verifies CFR timing and reports exact facts", async () => {
    const facts = await probeVideoFacts(binaries!.ffprobe, samplePath, { decodedFrameCount: true });
    expect(facts.width).toBe(320);
    expect(facts.height).toBe(180);
    expect(facts.timing.timing).toBe("cfr");
    expect(facts.timing.fps).toBeCloseTo(10, 5);
    expect(facts.decodedFrameCount).toBe(75);
    expect(facts.timeBase).toBe("1/10240");
  });

  it.skipIf(skip())("survives paths with spaces and Chinese characters", async () => {
    const facts = await probeVideoFacts(binaries!.ffprobe, pathWithSpaces);
    expect(facts.timing.timing).toBe("cfr");
  });

  it.skipIf(skip())("rejects files without a video stream", async () => {
    const textPath = join(dir, "note.txt");
    await writeFile(textPath, "not a video");
    await expect(probeVideoFacts(binaries!.ffprobe, textPath)).rejects.toThrow(/cannot probe/);
  });
});

describe("resolveTargetFrames + buildSelectExpr", () => {
  it("normalizes a half-open range", () => {
    expect(resolveTargetFrames({ startFrame: 5, endFrame: 8, totalFrames: 75 })).toEqual([5, 6, 7]);
  });

  it("sorts and deduplicates explicit lists", () => {
    expect(resolveTargetFrames({ frames: [7, 3, 7], totalFrames: 75 })).toEqual([3, 7]);
  });

  it("rejects out-of-bounds indices and empty selections", () => {
    expect(() => resolveTargetFrames({ frames: [75], totalFrames: 75 })).toThrow(/beyond the last frame/);
    expect(() => resolveTargetFrames({ startFrame: 5, endFrame: 5, totalFrames: 75 })).toThrow();
    expect(() => resolveTargetFrames({ frames: [1], startFrame: 1, endFrame: 2, totalFrames: 75 })).toThrow(/exactly one/);
  });

  it("builds run-compressed select expressions", () => {
    expect(buildSelectExpr([3])).toBe("select='eq(n,3)'");
    expect(buildSelectExpr([40, 41, 42])).toBe("select='between(n,40,42)'");
    expect(buildSelectExpr([1, 3, 4])).toBe("select='eq(n,1)+between(n,3,4)'");
  });
});

describe("extractFramesExact", () => {
  it.skipIf(skip())("extracts exactly the requested frames with verified PTS mapping", async () => {
    const outDir = join(dir, "ex1");
    const { frames, limitations } = await extractFramesExact(binaries!.ffmpeg, samplePath, [3, 40, 41, 42], outDir);
    expect(frames.map((frame) => frame.frame)).toEqual([3, 40, 41, 42]);
    // 10 fps CFR: frame n lives at n/10 seconds.
    expect(frames[0]!.ptsTimeSec).toBeCloseTo(0.3, 3);
    expect(frames[1]!.ptsTimeSec).toBeCloseTo(4.0, 3);
    expect(frames[3]!.ptsTimeSec).toBeCloseTo(4.2, 3);
    expect(limitations).toEqual([]);
    for (const frame of frames) {
      const info = await stat(frame.path);
      expect(info.isFile()).toBe(true);
      expect(frame.path).toMatch(/f\d{6}\.png$/);
    }
  });

  it.skipIf(skip())("extracts a one-frame segment and first/last frames", async () => {
    const outDir = join(dir, "ex2");
    const { frames } = await extractFramesExact(binaries!.ffmpeg, samplePath, [0], join(outDir, "a"));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.ptsTimeSec).toBeCloseTo(0, 3);
    const last = await extractFramesExact(binaries!.ffmpeg, samplePath, [74], join(outDir, "b"));
    expect(last.frames[0]!.frame).toBe(74);
    expect(last.frames[0]!.ptsTimeSec).toBeCloseTo(7.4, 3);
  });

  it.skipIf(skip())("works under paths with spaces and Chinese characters", async () => {
    const outDir = join(dir, "帧 输出");
    await mkdir(outDir, { recursive: true });
    const { frames } = await extractFramesExact(binaries!.ffmpeg, pathWithSpaces, [10, 11], outDir);
    expect(frames).toHaveLength(2);
    expect(frames[1]!.path).toContain("帧 输出");
  });

  it.skipIf(skip())("fails loudly when requesting frames beyond the source", async () => {
    const outDir = join(dir, "ex3");
    await expect(extractFramesExact(binaries!.ffmpeg, samplePath, [70, 80], outDir)).rejects.toThrow(/mismatch|beyond the last frame/);
    const leftover = await stat(outDir).catch(() => null);
    expect(leftover).toBeNull();
  });

  it.skipIf(skip())("falls back to ordered decoding when the select counter resets mid-stream", async () => {
    // A concat-demuxer VFR file (10fps + 25fps + 15fps segments) makes the
    // select filter's n counter reset partway through; trusting it returned
    // WRONG frames silently. The extractor must detect the discontinuity,
    // fall back to ordered decoding, and still return exact frames whose PTS
    // match ffprobe's ground truth.
    const concatDir = join(dir, "vfr-concat");
    await mkdir(concatDir, { recursive: true });
    const enc = (input: string, output: string) => ["-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", input, "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", output];
    await runToolProcess(binaries!.ffmpeg,
      enc("testsrc2=size=160x120:rate=10:duration=1", join(concatDir, "a.mp4")));
    await runToolProcess(binaries!.ffmpeg,
      enc("smptebars=size=160x120:rate=25:duration=1", join(concatDir, "b.mp4")));
    await runToolProcess(binaries!.ffmpeg,
      enc("color=c=black:size=160x120:rate=15:duration=1", join(concatDir, "c.mp4")));
    const list = join(concatDir, "list.txt");
    await writeFile(list, `file 'a.mp4'\nfile 'b.mp4'\nfile 'c.mp4'\n`, "utf8");
    const vfrPath = join(concatDir, "vfr.mp4");
    await runToolProcess(binaries!.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y",
      "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", vfrPath]);

    // Ground truth: ffprobe's per-frame PTS list, in presentation order.
    const { stdout } = await runToolProcess(binaries!.ffprobe,
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "csv=p=0", vfrPath]);
    const truthPts = stdout.toString("utf8").split(/\r?\n/).filter((line) => line.trim())
      .map((line) => Number(line.trim().replace(/,$/, "")));
    expect(truthPts.length).toBe(50);

    const outDir = join(concatDir, "out");
    const { frames, limitations } = await extractFramesExact(
      binaries!.ffmpeg, vfrPath, [0, 9, 10, 34, 35, 49], outDir);
    expect(frames.map((frame) => frame.frame)).toEqual([0, 9, 10, 34, 35, 49]);
    for (const frame of frames) {
      expect(frame.ptsTimeSec).toBeCloseTo(truthPts[frame.frame]!, 4);
    }
    expect(limitations.join(" ")).toContain("counter was not continuous");
  });

  it("parses showinfo lines", () => {
    const parsed = parseShowinfo("x\n[Parsed_showinfo @ 0x1] n:   0 pts:   3072 pts_time:0.3\n[Parsed_showinfo @ 0x1] n:   1 pts:  40960 pts_time:4\n");
    expect(parsed).toEqual([
      { counter: 0, ptsTimeSec: 0.3 },
      { counter: 1, ptsTimeSec: 4 },
    ]);
  });
});

describe("candidate detection", () => {
  it.skipIf(skip())("finds the hard cuts, flash and black/freeze segments as candidates", async () => {
    const facts = await probeVideoFacts(binaries!.ffprobe, samplePath);
    const scene = await detectSceneCandidates(binaries!.ffmpeg, samplePath, { startSec: 0, endSec: 7.5 }, { threshold: 0.2 }, facts);
    const sceneFrames = scene.candidates.map((candidate) => candidate.frameIndex);
    // Cuts at frames 20, 40, 45, 55 (the flash start and the transitions).
    for (const expected of [20, 40, 45, 55]) expect(sceneFrames).toContain(expected);
    expect(scene.candidates.every((candidate) => candidate.score > 0.2)).toBe(true);

    const black = await detectBlackCandidates(binaries!.ffmpeg, samplePath, { startSec: 0, endSec: 7.5 }, { minDurationSec: 0.08, pixelThreshold: 0.1 }, facts);
    expect(black.candidates).toHaveLength(1);
    expect(black.candidates[0]!.startFrameIndex).toBe(45);
    expect(black.candidates[0]!.endFrameIndexExclusive).toBe(55);

    const freeze = await detectFreezeCandidates(binaries!.ffmpeg, samplePath, { startSec: 0, endSec: 7.5 }, { minDurationSec: 0.3, noiseThreshold: 0.001 }, facts);
    // The intentionally frozen tail (frames 65-74) must be flagged...
    expect(freeze.candidates.some((candidate) => candidate.startFrameIndex !== null && candidate.startFrameIndex >= 60)).toBe(true);
    // ...and static-but-legitimate content (SMPTE bars) is ALSO flagged —
    // candidates, never verdicts.
    expect(freeze.limitations.join(" ")).toMatch(/never failures|intentional/i);
  });

  it.skipIf(skip())("honors an abort signal", async () => {
    const facts = await probeVideoFacts(binaries!.ffprobe, samplePath);
    const controller = new AbortController();
    controller.abort();
    await expect(
      detectSceneCandidates(binaries!.ffmpeg, samplePath, { startSec: 0, endSec: 7.5 }, { threshold: 0.2 }, facts, { signal: controller.signal }),
    ).rejects.toThrow(/Cancel/);
  });
});

describe("contact sheet", () => {
  it.skipIf(skip())("composes a grid without stretching and labels below content", async () => {
    const framesDir = join(dir, "sheet-in");
    const { frames } = await extractFramesExact(binaries!.ffmpeg, samplePath, [3, 20, 40, 60], framesDir);
    const font = await probeLabelFont();
    const dest = join(dir, "sheet.png");
    await composeContactSheet(
      binaries!.ffmpeg,
      frames.map((frame) => ({ path: frame.path, width: 320, height: 180, label: `frame ${frame.frame}` })),
      dest,
      { cellWidth: 160, cellInnerHeight: 90, labelStripHeight: 18, columns: 2, rows: 2 },
      { fontFile: font },
    );
    const info = await stat(dest);
    expect(info.size).toBeGreaterThan(1000);
    const facts = await probeVideoFacts(binaries!.ffprobe, dest);
    expect(facts.width).toBe(2 * 160 + 2 * 4 + 6); // margin*2 + padding between columns
    expect(facts.height).toBe(2 * (90 + 18) + 2 * 4 + 6);
  });
});

describe("compare", () => {
  it.skipIf(skip())("composes difference and side-by-side images with ROI metrics", async () => {
    const framesDir = join(dir, "cmp-in");
    const { frames } = await extractFramesExact(binaries!.ffmpeg, samplePath, [10, 11], framesDir);
    const ref = frames[0]!.path;
    const cand = frames[1]!.path;
    const diffPath = join(dir, "diff.png");
    await composeCompareImage(binaries!.ffmpeg, ref, cand, diffPath, {
      layout: "difference",
      referenceSize: { width: 320, height: 180 },
    });
    expect((await stat(diffPath)).size).toBeGreaterThan(0);

    const sbsPath = join(dir, "sbs.png");
    await composeCompareImage(binaries!.ffmpeg, ref, cand, sbsPath, {
      layout: "side-by-side",
      referenceSize: { width: 320, height: 180 },
      maxHeight: 180,
    });
    const sbsFacts = await probeVideoFacts(binaries!.ffprobe, sbsPath);
    expect(sbsFacts.width).toBe(640);
    expect(sbsFacts.height).toBe(180);

    const identical = await compareFrameMetrics(binaries!.ffmpeg, ref, ref, { width: 320, height: 180 });
    expect(identical.meanAbsDiff).toBe(0);
    const neighbors = await compareFrameMetrics(binaries!.ffmpeg, ref, cand, { width: 320, height: 180 });
    expect(neighbors.meanAbsDiff).toBeGreaterThan(0);
    const roiMetrics = await compareFrameMetrics(binaries!.ffmpeg, ref, cand, { width: 320, height: 180 }, {
      roi: { x: 0, y: 0, width: 100, height: 100 },
    });
    expect(roiMetrics.sampledPixels).toBe(100 * 100);
  });
});

describe("static mask patch", () => {
  it.skipIf(skip())("changes only pixels inside the mask and keeps untouched frames byte-identical", async () => {
    const framesDir = join(dir, "patch-src");
    const indices = [50, 51, 52];
    const { frames } = await extractFramesExact(binaries!.ffmpeg, samplePath, indices, framesDir);
    // Build a patch image: a solid red full-frame PNG.
    const patchPath = join(dir, "patch.png");
    await runToolProcess(binaries!.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=red:size=320x180:duration=0.04",
      "-frames:v", "1", patchPath,
    ]);
    const mask = { x: 40, y: 30, width: 100, height: 80 };
    const patchedDir = join(dir, "patch-out");
    await mkdir(patchedDir, { recursive: true });
    const patchedPath = join(patchedDir, "f000051.png");
    await applyMaskComposite(binaries!.ffmpeg, frames[1]!.path, patchPath, patchedPath, mask);
    const verification = await verifyOutsideMaskUnchanged(
      binaries!.ffmpeg, frames[1]!.path, patchedPath, { width: 320, height: 180 }, mask,
    );
    expect(verification.unchanged).toBe(true);
    expect(verification.differingPixels).toBe(0);
    // The mask interior must actually differ from the original.
    const inside = await compareFrameMetrics(
      binaries!.ffmpeg, frames[1]!.path, patchedPath, { width: 320, height: 180 },
      { roi: mask },
    );
    expect(inside.changedPixelsRatio).toBeGreaterThan(0.9);
    const untouched = await compareFrameMetrics(
      binaries!.ffmpeg, frames[0]!.path, frames[0]!.path, { width: 320, height: 180 },
    );
    expect(untouched.meanAbsDiff).toBe(0);
  });
});
