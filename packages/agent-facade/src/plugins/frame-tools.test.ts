/**
 * End-to-end tests for the frame-tools plugin verbs through the real
 * headless facade (createAgentFacade) and the local FFmpeg — skipped
 * honestly when ffmpeg/ffprobe are not installed. The sample is the same
 * known-content 75-frame clip as media/frame-exact.test.ts (cuts at frames
 * 20/40/45/55, black 45–54, frozen tail 65–74).
 */
import { copyFile, mkdtemp, rm, stat, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { createAgentFacade, createLiveFacade, LiveWriterLease, type AgentFacade } from "../index";
import type { LiveProjectStore } from "../live-store";
import { resolveToolFfmpeg, runToolProcess } from "../media/ffmpeg-bin";
import { writeTinyMp4 } from "../media/fixtures/tiny-mp4";

const binaries = await resolveToolFfmpeg();
const hasFfmpeg = binaries !== null;
const skip = () => (hasFfmpeg ? undefined : true);

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(liveSessions.splice(0).map((live) => live.dispose()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

let root = "";
let facade: ReturnType<typeof createAgentFacade> | undefined;
let mediaId = "";
let samplePath = "";
let spacesPath = "";
const liveSessions: ReturnType<typeof createLiveFacade>[] = [];

async function withControlledCopy(base: AgentFacade, mediaRoot: string, contentUrl: string) {
  const state = await base["project.get_state"]();
  if (!state.ok) throw new Error("No project");
  state.value.project.mediaLibrary.items[0] = { ...state.value.project.mediaLibrary.items[0]!, contentUrl };
  const store = { getState: async () => structuredClone(state.value) } as unknown as LiveProjectStore;
  const live = createLiveFacade({
    store,
    lease: new LiveWriterLease(),
    sessionId: `controlled-frames-${liveSessions.length}`,
    access: "read-only",
    mediaRoots: [mediaRoot],
    artifactRoot: path.join(mediaRoot, "artifacts"),
  });
  liveSessions.push(live);
  return live;
}

async function makeSolidSample(dir: string, name: string, color: string, durationSec: number): Promise<string> {
  const target = path.join(dir, name);
  await runToolProcess(binaries!.ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `color=${color}:size=64x64:rate=10:duration=${durationSec}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", target,
  ]);
  return target;
}

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

  it.skipIf(skip())("M01 extracts from the controlled copy after the original disappears", async () => {
    const versionRoot = await mkdtemp(path.join(root, "m01-"));
    const originalPath = writeTinyMp4(versionRoot);
    const controlledPath = path.join(versionRoot, "controlled.mp4");
    await copyFile(originalPath, controlledPath);
    const base = createAgentFacade({ mediaRoots: [versionRoot], artifactRoot: path.join(versionRoot, "artifacts") });
    await base["project.create"]({ name: "M01" });
    const imported = await base["media.import"]({ path: originalPath });
    if (!imported.ok) throw new Error(imported.error.message);
    const live = await withControlledCopy(base, versionRoot, controlledPath);
    await rm(originalPath);
    const before = await live["project.get_state"]();
    const result = await live["frames.extract"]({ source: { mediaId: imported.value.mediaId }, selection: { frames: [0] } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.sourcePath).toBe(await realpath(controlledPath));
    const controlledStat = await stat(controlledPath);
    expect(result.value.sourceFingerprint).toEqual({ size: controlledStat.size, lastModified: Math.round(controlledStat.mtimeMs) });
    expect(await live["project.get_state"]()).toEqual(before);
  });

  it.skipIf(skip())("M02 decodes controlled A pixels and duration after original B changes", async () => {
    const versionRoot = await mkdtemp(path.join(root, "m02-"));
    const originalB = await makeSolidSample(versionRoot, "original-B.mp4", "blue", 2);
    const controlledA = await makeSolidSample(versionRoot, "controlled-A.mp4", "red", 1);
    const base = createAgentFacade({ mediaRoots: [versionRoot], artifactRoot: path.join(versionRoot, "artifacts") });
    await base["project.create"]({ name: "M02" });
    const imported = await base["media.import"]({ path: originalB });
    if (!imported.ok) throw new Error(imported.error.message);
    const live = await withControlledCopy(base, versionRoot, controlledA);
    const before = await live["project.get_state"]();
    const result = await live["frames.extract"]({ source: { mediaId: imported.value.mediaId }, selection: { frames: [0] } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.sourcePath).toBe(await realpath(controlledA));
    expect(result.value.facts.durationSec).toBeCloseTo(1, 2);
    expect(result.value.facts.durationSec).not.toBeCloseTo(2, 2);
    const controlledStat = await stat(controlledA);
    expect(result.value.sourceFingerprint).toEqual({ size: controlledStat.size, lastModified: Math.round(controlledStat.mtimeMs) });

    const decoded = await runToolProcess(binaries!.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-i", result.value.frames[0]!.artifact.path,
      "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ]);
    let red = 0;
    let green = 0;
    let blue = 0;
    for (let index = 0; index < decoded.stdout.length; index += 3) {
      red += decoded.stdout[index]!;
      green += decoded.stdout[index + 1]!;
      blue += decoded.stdout[index + 2]!;
    }
    const pixels = decoded.stdout.length / 3;
    expect(red / pixels).toBeGreaterThan(200);
    expect(green / pixels).toBeLessThan(60);
    expect(blue / pixels).toBeLessThan(60);

    const sheet = await live["frames.contact_sheet"]({
      frames: result.value.frames.map((frame) => ({ path: frame.artifact.path, frame: frame.frame })),
      columns: 1,
      cellWidth: 64,
    });
    expect(sheet.ok).toBe(true);
    if (!sheet.ok) throw new Error(sheet.error.message);
    expect(sheet.value.cells).toMatchObject([{ frame: 0, sourcePath: result.value.frames[0]!.artifact.path }]);
    expect(await live["project.get_state"]()).toEqual(before);
  });

  it.skipIf(skip())("M03 fails a missing controlled copy instead of decoding the original", async () => {
    const versionRoot = await mkdtemp(path.join(root, "m03-"));
    const originalPath = writeTinyMp4(versionRoot);
    const base = createAgentFacade({ mediaRoots: [versionRoot], artifactRoot: path.join(versionRoot, "artifacts") });
    await base["project.create"]({ name: "M03" });
    const imported = await base["media.import"]({ path: originalPath });
    if (!imported.ok) throw new Error(imported.error.message);
    const live = await withControlledCopy(base, versionRoot, path.join(versionRoot, "missing-controlled.mp4"));
    const result = await live["frames.extract"]({ source: { mediaId: imported.value.mediaId }, selection: { frames: [0] } });
    expect(result).toMatchObject({ ok: false, error: {
      code: "NOT_FOUND",
      details: { reason: "source_missing", mediaId: imported.value.mediaId, sourceKind: "controlled" },
    } });
  });

  it.skipIf(skip())("M04 rejects an outside controlled copy instead of decoding the contained original", async () => {
    const versionRoot = await mkdtemp(path.join(root, "m04-"));
    const originalPath = writeTinyMp4(versionRoot);
    const controlledPath = path.join(root, "outside-controlled.mp4");
    await copyFile(originalPath, controlledPath);
    const base = createAgentFacade({ mediaRoots: [versionRoot], artifactRoot: path.join(versionRoot, "artifacts") });
    await base["project.create"]({ name: "M04" });
    const imported = await base["media.import"]({ path: originalPath });
    if (!imported.ok) throw new Error(imported.error.message);
    const live = await withControlledCopy(base, versionRoot, controlledPath);
    const result = await live["frames.extract"]({ source: { mediaId: imported.value.mediaId }, selection: { frames: [0] } });
    expect(result).toMatchObject({ ok: false, error: {
      code: "INVALID_PARAMS",
      details: { reason: "outside_roots", mediaId: imported.value.mediaId, sourceKind: "controlled" },
    } });
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

    const outsideRoot = await mkdtemp(path.join(tmpdir(), "frame-tools-outside-"));
    dirs.push(outsideRoot);
    const outsidePath = writeTinyMp4(outsideRoot);
    const outside = await facade!["frames.extract"]({ source: { path: outsidePath }, selection: { startFrame: 0, endFrame: 1 } });
    expect(outside).toMatchObject({ ok: false, error: {
      code: "INVALID_PARAMS", details: { reason: "outside_roots", path: outsidePath },
    } });

    const missingPath = path.join(root, "missing-explicit.mp4");
    const missing = await facade!["frames.extract"]({ source: { path: missingPath }, selection: { startFrame: 0, endFrame: 1 } });
    expect(missing).toMatchObject({ ok: false, error: {
      code: "NOT_FOUND", details: { reason: "source_missing", path: missingPath },
    } });

    const both = await facade!["frames.extract"]({ source: { mediaId }, selection: { frames: [1], startFrame: 0, endFrame: 2 } } as never);
    expect(both.ok).toBe(false);

    const junkSelectionKey = await facade!["frames.extract"]({ source: { mediaId }, selection: { startFrame: 0, endFrame: 2, junk: true } } as never);
    expect(junkSelectionKey.ok).toBe(false);
    if (junkSelectionKey.ok) return;
    expect(junkSelectionKey.error.code).toBe("INVALID_PARAMS");
  });

  it("reports missing ffmpeg honestly (fresh module, bogus binary path)", async () => {
    vi.resetModules();
    const previousFfmpeg = process.env.REELTERMINAL_FFMPEG_PATH;
    const previousConfig = process.env.REELTERMINAL_AUDIO_CONFIG;
    // A user's saved audio configuration takes priority over the environment.
    // Keep this missing-dependency case independent of the host's settings.
    process.env.REELTERMINAL_AUDIO_CONFIG = path.join(root, "absent-audio-environment.json");
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
      if (previousFfmpeg === undefined) delete process.env.REELTERMINAL_FFMPEG_PATH;
      else process.env.REELTERMINAL_FFMPEG_PATH = previousFfmpeg;
      if (previousConfig === undefined) delete process.env.REELTERMINAL_AUDIO_CONFIG;
      else process.env.REELTERMINAL_AUDIO_CONFIG = previousConfig;
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

    // A full-frame layer, so the ONLY possible failure below is the
    // out-of-range subset validation (not the raster check).
    const fullPatch = path.join(root, "full-patch.png");
    await runToolProcess(binaries!.ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=blue:size=320x180:duration=0.04",
      "-frames:v", "1", fullPatch,
    ]);
    const outside = await facade!["patch.apply"]({
      source: { mediaId },
      range: { startFrame: 0, endFrame: 2, frames: [5] },
      patch: { path: fullPatch, x: 0, y: 0, width: 8, height: 8 },
    });
    expect(outside.ok).toBe(false);
    if (outside.ok) return;
    expect(outside.error.code).toBe("INVALID_PARAMS");
    expect(outside.error.message).toMatch(/in-range subset/);

    const junkRangeKey = await facade!["patch.apply"]({
      source: { mediaId },
      range: { startFrame: 0, endFrame: 2, junk: true },
      patch: { path: fullPatch, x: 0, y: 0, width: 8, height: 8 },
    } as never);
    expect(junkRangeKey.ok).toBe(false);
    if (junkRangeKey.ok) return;
    expect(junkRangeKey.error.code).toBe("INVALID_PARAMS");
  });
});
