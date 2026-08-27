/**
 * FfmpegArtifactVerifier unit tests over real fixtures: ffprobe facts,
 * expectation checks, pixel comparison in both modes, and honest failure on
 * broken/empty media. No Chromium needed here.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeTinyMp4 } from "@openreel/agent-facade/media/fixtures/tiny-mp4";
import { FfmpegArtifactVerifier } from "./node/verify";
import { extractFrameRgba, resolveFfmpegBinaries } from "./node/ffmpeg";
import { writeTinyVp9Mp4 } from "./media/tiny-vp9-mp4";

describe("FfmpegArtifactVerifier", () => {
  let workDir: string;
  let verifier: FfmpegArtifactVerifier;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "verify-test-"));
    verifier = new FfmpegArtifactVerifier();
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("preflight finds system ffmpeg and reports details", async () => {
    const pre = await verifier.preflight();
    expect(pre.available).toBe(true);
    expect(pre.details?.version).toContain("ffmpeg");
  });

  it("preflight reports unavailable with explicit bad paths", async () => {
    const bad = new FfmpegArtifactVerifier({
      ffmpegPath: path.join(workDir, "nope-ffmpeg.exe"),
      ffprobePath: path.join(workDir, "nope-ffprobe.exe"),
    });
    const pre = await bad.preflight();
    expect(pre.available).toBe(false);
    expect(pre.reason).toBeTruthy();
  });

  it("probes the h264 fixture exactly (container/codec/geometry/duration/frames)", async () => {
    const mp4 = writeTinyMp4(workDir);
    const report = await verifier.verify({
      path: mp4,
      expect: {
        container: "mp4",
        videoCodec: "h264",
        width: 320,
        height: 180,
        durationSec: 6,
        durationToleranceSec: 0.12,
      },
    });
    expect(report.probe.videoCodec).toBe("h264");
    expect(report.probe.width).toBe(320);
    expect(report.probe.height).toBe(180);
    expect(report.probe.durationSec).toBeCloseTo(6, 1);
    expect(report.probe.frameCount).toBe(60);
    expect(report.probe.frameRate).toBeCloseTo(10, 1);
    expect(report.probe.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.pass).toBe(true);
    for (const check of report.checks) {
      expect(check.pass, `${check.name}: ${check.details}`).toBe(true);
    }
  });

  it("fails wrong expectations as data, not as throws", async () => {
    const mp4 = writeTinyMp4(workDir);
    const report = await verifier.verify({
      path: mp4,
      expect: { videoCodec: "h264", width: 640, durationSec: 3, durationToleranceSec: 0.05 },
    });
    expect(report.pass).toBe(false);
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
    expect(byName.videoCodec?.pass).toBe(true);
    expect(byName.width?.pass).toBe(false);
    expect(byName.duration?.pass).toBe(false);
    expect(byName.width?.details).toContain("640");
  });

  it("pixel compare: identical frames are similar; different videos differ", async () => {
    const a = writeTinyMp4(workDir);
    const b = writeTinyVp9Mp4(workDir);

    const same = await verifier.verify({
      path: a,
      compare: { referencePath: a, timeSec: 1, referenceTimeSec: 1, mode: "similar" },
    });
    expect(same.compare?.pass).toBe(true);
    expect(same.compare?.meanAbsDiff).toBe(0);
    expect(same.compare?.changedPixelsRatio).toBe(0);

    const different = await verifier.verify({
      path: a,
      compare: { referencePath: b, timeSec: 1, referenceTimeSec: 1, mode: "different" },
    });
    expect(different.compare?.pass).toBe(true);
    expect(different.compare?.changedPixelsRatio).toBeGreaterThan(0.2);

    // And the "different" verdict correctly REFUSES to fire on identical frames.
    const notDifferent = await verifier.verify({
      path: a,
      compare: { referencePath: a, timeSec: 1, referenceTimeSec: 1, mode: "different" },
    });
    expect(notDifferent.compare?.pass).toBe(false);
    expect(notDifferent.pass).toBe(false);
  });

  it("region-restricted compare: SMPTE bars differ in one band, match in another", async () => {
    const a = writeTinyMp4(workDir);
    // Same file: a center region compare must be perfectly similar.
    const centered = await verifier.verify({
      path: a,
      compare: {
        referencePath: a,
        timeSec: 2,
        referenceTimeSec: 2,
        mode: "similar",
        region: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      },
    });
    expect(centered.compare?.pass).toBe(true);
    expect(centered.compare?.region).toEqual({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
  });

  it("broken/empty media throws honestly instead of passing", async () => {
    const broken = path.join(workDir, "broken.mp4");
    await writeFile(broken, Buffer.from("this is not an mp4 at all"));
    await expect(verifier.verify({ path: broken })).rejects.toThrow();

    const empty = path.join(workDir, "empty.mp4");
    await writeFile(empty, Buffer.alloc(0));
    await expect(verifier.verify({ path: empty })).rejects.toThrow();
  });

  it("extractFrameRgba returns exact RGBA buffers and rejects missing frames", async () => {
    const binaries = await resolveFfmpegBinaries();
    if (!binaries) throw new Error("ffmpeg required for this test");
    const mp4 = writeTinyMp4(workDir);
    const frame = await extractFrameRgba(binaries.ffmpeg, mp4, 1, 320, 180);
    expect(frame.length).toBe(320 * 180 * 4);
    // SMPTE bars: the top-left pixel is a known gray (192-ish), definitely
    // not black/transparent — proves a real decode happened.
    expect(frame[0]!).toBeGreaterThan(100);
    await expect(
      extractFrameRgba(binaries.ffmpeg, mp4, 999, 320, 180),
    ).rejects.toThrow();
  });

  it("png reference frames load for comparison (preview artifact shape)", async () => {
    const binaries = await resolveFfmpegBinaries();
    if (!binaries) throw new Error("ffmpeg required for this test");
    const mp4 = writeTinyMp4(workDir);
    const frame = await extractFrameRgba(binaries.ffmpeg, mp4, 1, 320, 180);
    // Wrap the raw RGBA as a real PNG via ffmpeg, then compare image↔video.
    const pngPath = path.join(workDir, "frame.png");
    const rawPath = path.join(workDir, "frame.rgba");
    await writeFile(rawPath, frame);
    const { runProcess } = await import("./node/ffmpeg");
    await runProcess(binaries.ffmpeg, [
      "-y", "-v", "error",
      "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "320x180",
      "-i", rawPath,
      "-frames:v", "1", pngPath,
    ]);
    const pngBytes = await readFile(pngPath);
    expect(pngBytes[0]).toBe(0x89);
    const report = await verifier.verify({
      path: mp4,
      compare: { referencePath: pngPath, timeSec: 1, mode: "similar" },
    });
    expect(report.compare?.pass).toBe(true);
    expect(report.compare?.meanAbsDiff).toBeLessThan(2);
  });
});
