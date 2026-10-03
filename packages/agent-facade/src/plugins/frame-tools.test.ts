/**
 * End-to-end tests for the frame-tools plugin verbs through the real
 * headless facade (createAgentFacade) and the local FFmpeg — skipped
 * honestly when ffmpeg/ffprobe are not installed. The sample is the same
 * known-content 75-frame clip as media/frame-exact.test.ts (cuts at frames
 * 20/40/45/55, black 45–54, frozen tail 65–74).
 */
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { createAgentFacade } from "../index";
import { resolveToolFfmpeg, runToolProcess } from "../media/ffmpeg-bin";
import { writeTinyMp4 } from "../media/fixtures/tiny-mp4";

const binaries = await resolveToolFfmpeg();
const hasFfmpeg = binaries !== null;
const skip = () => (hasFfmpeg ? undefined : true);

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

let root = "";
let facade: ReturnType<typeof createAgentFacade> | undefined;
let mediaId = "";
let samplePath = "";
let spacesPath = "";

async function makeSample(dir: string, name: string): Promise<string> {
  const target = path.join(dir, name);
  await runToolProcess(binaries!.ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10:duration=2",
    "-f", "lavfi", "-i", "smptebars=size=320x180:rate=10:duration=2",
    "-f", "lavfi", "-i", "color=white:size=320x180:rate=10:duration=0.5",
    "-f", "lavfi", "-i", "color=black:size=320x180:rate=10:duration=1",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10:duration=1",
    "-filter_complex",
    "[4:v]tpad=stop_mode=clone:stop_duration=1[frozen];[0:v][1:v][2:v][3:v][frozen]concat=n=5:v=1:a=0[v]",
    "-map", "[v]", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", target,
  ]);
  return target;
}

beforeAll(async () => {
  if (!hasFfmpeg) return;
  root = await mkdtemp(path.join(tmpdir(), "frame-tools-"));
  dirs.push(root);
  samplePath = await makeSample(root, "sample.mp4");
  spacesPath = await makeSample(root, "素材 帧 段.mp4");
  facade = createAgentFacade({ mediaRoots: [root], artifactRoot: path.join(root, "artifacts") });
  await facade!["project.create"]({ name: "frame-tools" });
  const imported = await facade!["media.import"]({ path: samplePath });
  if (!imported.ok) throw new Error(imported.error.message);
  mediaId = imported.value.mediaId;
});



describe("frames.extract (plugin)", () => {
  it.skipIf(skip())("extracts exact frames for project media without touching the project", async () => {
    const before = await facade!["project.get_state"]();
    const result = await facade!["frames.extract"]({ source: { mediaId }, selection: { frames: [3, 40, 41, 42] } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.coordinateSpace).toBe("source-frame-index");
    expect(result.value.frames.map((frame) => frame.frame)).toEqual([3, 40, 41, 42]);
    expect(result.value.frames[0]!.ptsTimeSec).toBeCloseTo(0.3, 3);
    expect(result.value.frames[0]!.artifact.format).toBe("png");
    expect((await stat(result.value.frames[0]!.artifact.path)).isFile()).toBe(true);
    expect(result.value.facts.frameTiming.timing).toBe("cfr");
    // MP4s with an nb_frames header satisfy the count without decoding;
    // either source of the number is exact.
    expect(result.value.facts.decodedFrameCount ?? result.value.facts.headerFrameCount).toBe(75);
    expect(await facade!["project.get_state"]()).toEqual(before);
  });

  it.skipIf(skip())("extracts a range including the first and last frame via a path with spaces/Chinese", async () => {
    const result = await facade!["frames.extract"]({
      source: { path: spacesPath },
      selection: { startFrame: 73, endFrame: 75 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.frames.map((frame) => frame.frame)).toEqual([73, 74]);
    expect(result.value.frames[1]!.ptsTimeSec).toBeCloseTo(7.4, 3);
  });

  it.skipIf(skip())("rejects out-of-range frames and boundary violations", async () => {
    const beyond = await facade!["frames.extract"]({ source: { mediaId }, selection: { frames: [75] } });
    expect(beyond.ok).toBe(false);
    if (beyond.ok) return;
    expect(beyond.error.code).toBe("INVALID_PARAMS");

    const outside = await facade!["frames.extract"]({ source: { path: "C:/definitely/not/inside.mp4" }, selection: { startFrame: 0, endFrame: 1 } });
    expect(outside.ok).toBe(false);
    if (outside.ok) return;
    expect(outside.error.code).toBe("INVALID_PARAMS");

    const both = await facade!["frames.extract"]({ source: { mediaId }, selection: { frames: [1], startFrame: 0, endFrame: 2 } } as never);
    expect(both.ok).toBe(false);
  });

  it("reports missing ffmpeg honestly (fresh module, bogus binary path)", async () => {
    vi.resetModules();
    process.env.REELTERMINAL_FFMPEG_PATH = "C:/definitely/no/ffmpeg.exe";
    try {
      const freshFacade = (await import("../index")).createAgentFacade({ mediaRoots: [root], artifactRoot: path.join(root, "artifacts") });
      await freshFacade["project.create"]({ name: "no-ffmpeg" });
      const tiny = writeTinyMp4(root);
      const imported = await freshFacade["media.import"]({ path: tiny });
      if (!imported.ok) throw new Error(imported.error.message);
      const result = await freshFacade["frames.extract"]({ source: { mediaId: imported.value.mediaId }, selection: { startFrame: 0, endFrame: 1 } });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("UNSUPPORTED");
      expect(result.error.message).toMatch(/REELTERMINAL_FFMPEG_PATH|ffmpeg/);
    } finally {
      delete process.env.REELTERMINAL_FFMPEG_PATH;
      vi.resetModules();
    }
  });
});

describe("frames.contact_sheet (plugin)", () => {
  it.skipIf(skip())("sheets extracted frames with labels, ROI and a position mapping", async () => {
    const extract = await facade!["frames.extract"]({ source: { mediaId }, selection: { frames: [3, 20, 40, 60] } });
    if (!extract.ok) throw new Error(extract.error.message);
    const frames = extract.value.frames.map((frame) => ({ path: frame.artifact.path, frame: frame.frame }));
    const result = await facade!["frames.contact_sheet"]({ frames, columns: 2, cellWidth: 160 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.cells.map((cell) => cell.label)).toEqual(["frame 3", "frame 20", "frame 40", "frame 60"]);
    expect(result.value.cells.map((cell) => [cell.row, cell.column])).toEqual([[0, 0], [0, 1], [1, 0], [1, 1]]);
    expect((await stat(result.value.artifact.path)).isFile()).toBe(true);
    const withRoi = await facade!["frames.contact_sheet"]({
      frames, columns: 4, cellWidth: 96, roi: { x: 10, y: 10, width: 100, height: 60 },
    });
    expect(withRoi.ok).toBe(true);
  });

  it.skipIf(skip())("rejects non-PNG and out-of-roots inputs", async () => {
    const videoInput = await facade!["frames.contact_sheet"]({ frames: [{ path: samplePath, frame: 0 }] });
    expect(videoInput.ok).toBe(false);
    const outside = await facade!["frames.contact_sheet"]({ frames: [{ path: "C:/elsewhere/f000001.png" }] });
    expect(outside.ok).toBe(false);
  });
});

describe("video.compare (plugin)", () => {
  it.skipIf(skip())("compares aligned frames at zero diff and offset frames above zero with ROI metrics", async () => {
    const same = await facade!["video.compare"]({
      reference: { mediaId },
      candidate: { mediaId },
      positions: [{ referenceFrame: 10, candidateFrame: 10 }],
    });
    expect(same.ok).toBe(true);
    if (!same.ok) throw new Error(same.error.message);
    expect(same.value.pairs[0]!.metrics.meanAbsDiff).toBe(0);
    expect(same.value.pairs[0]!.referencePtsSec).toBeCloseTo(1.0, 3);

    const offset = await facade!["video.compare"]({
      reference: { mediaId },
      candidate: { mediaId },
      positions: [{ referenceFrame: 10, candidateFrame: 11 }],
      layout: "difference",
      roi: { x: 0, y: 0, width: 160, height: 90 },
    });
    expect(offset.ok).toBe(true);
    if (!offset.ok) throw new Error(offset.error.message);
    expect(offset.value.pairs[0]!.metrics.meanAbsDiff).toBeGreaterThan(0);
    expect(offset.value.pairs[0]!.metrics.sampledPixels).toBe(160 * 90);
  });

  it.skipIf(skip())("rejects frame indices beyond either source", async () => {
    const result = await facade!["video.compare"]({
      reference: { mediaId },
      candidate: { mediaId },
      positions: [{ referenceFrame: 75, candidateFrame: 0 }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/referenceFrame 75/);
  });
});

describe("patch.apply (plugin)", () => {
  it.skipIf(skip())("patches masked frames, byte-copies untouched frames, verifies outside-mask pixels", async () => {
    // A full-frame red patch layer, same raster as the source.
    const patchPath = path.join(root, "patch-layer.png");
    await runToolProcess(binaries!.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=red:size=320x180:duration=0.04",
      "-frames:v", "1", patchPath,
    ]);
    // Reference extraction (same lossless path) to prove untouched frames are byte-identical.
    const reference = await facade!["frames.extract"]({ source: { mediaId }, selection: { startFrame: 50, endFrame: 53 } });
    if (!reference.ok) throw new Error(reference.error.message);

    const result = await facade!["patch.apply"]({
      source: { mediaId },
      range: { startFrame: 50, endFrame: 53, frames: [51] },
      patch: { path: patchPath, x: 40, y: 30, width: 100, height: 80 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.frameCount).toBe(3);
    expect(result.value.patchedCount).toBe(1);
    expect(result.value.untouchedCount).toBe(2);
    expect(result.value.verification.outsideMaskPixelExact).toBe(true);

    const manifest = JSON.parse(await readFile(result.value.manifestPath, "utf8"));
    expect(manifest.frames.map((frame: { frame: number; status: string }) => [frame.frame, frame.status])).toEqual([
      [50, "untouched"],
      [51, "patched"],
      [52, "untouched"],
    ]);
    const untouchedOriginal = await readFile(reference.value.frames.find((frame) => frame.frame === 50)!.artifact.path);
    const untouchedPatched = await readFile(manifest.frames[0].path);
    expect(untouchedPatched.equals(untouchedOriginal)).toBe(true);
  });

  it.skipIf(skip())("rejects a wrong-size patch layer and out-of-range subsets", async () => {
    const smallPatch = path.join(root, "small-patch.png");
    await runToolProcess(binaries!.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=blue:size=64x64:duration=0.04",
      "-frames:v", "1", smallPatch,
    ]);
    const wrongSize = await facade!["patch.apply"]({
      source: { mediaId },
      range: { startFrame: 0, endFrame: 2 },
      patch: { path: smallPatch, x: 0, y: 0, width: 32, height: 32 },
    });
    expect(wrongSize.ok).toBe(false);
    if (wrongSize.ok) return;
    expect(wrongSize.error.message).toMatch(/full-frame patch/);

    const outside = await facade!["patch.apply"]({
      source: { mediaId },
      range: { startFrame: 0, endFrame: 2, frames: [5] },
      patch: { path: smallPatch, x: 0, y: 0, width: 8, height: 8 },
    });
    expect(outside.ok).toBe(false);
  });
});
