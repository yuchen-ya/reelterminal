/**
 * End-to-end color pipeline regression (P0, docs/COLOR.md).
 *
 * Route F (system ffmpeg, no Chromium needed):
 *   PNG frames → startFramesEncoder → MP4 must be tagged BT.709/limited, and
 *   matrix-aware decode of the export must match the source bars within the
 *   documented yuv420+CRF18 tolerance — while decoding through the WRONG
 *   matrix must measurably diverge (proves comparisons are matrix-sensitive,
 *   never matrix-blind).
 *
 * Route W (real Chromium WebCodecs):
 *   import a tagged BT.601 pattern → preview PNG → export → re-import path:
 *   the export must be honestly tagged smpte170m/limited (Chromium's fixed
 *   RGBA→YUV conversion), preview pixels and export-decoded pixels must agree
 *   with the source and with each other, and an UNTAGGED BT.601 file must
 *   show the documented import shift (which technicalQuality reports as
 *   unknown-metadata — asserted in agent-facade color-policy.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createAgentFacade,
  type AgentFacade,
  type JobStatusView,
} from "@reelterminal/agent-facade";
import {
  writeColorPatternPng,
  writeColorPatternVideo,
  COLOR_PATTERN_WIDTH,
  COLOR_PATTERN_HEIGHT,
  COLOR_PATTERN_FRAME_RATE,
} from "@reelterminal/agent-facade/media/fixtures/color-patterns";

import { createChromiumProviders, type ChromiumProviders } from "./node/providers";
import { FfmpegArtifactVerifier } from "./node/verify";
import { extractFrameRgba, resolveFfmpegBinaries, startFramesEncoder } from "./node/ffmpeg";

const execute = promisify(execFile);

/** Documented tolerance for one yuv420 (chroma-subsampled) + CRF18 hop. */
const MAX_HOP_MEAN_ABS_DIFF = 8;
/** A wrong YUV matrix must diverge by at least this much on saturated bars. */
const MIN_WRONG_MATRIX_MEAN_ABS_DIFF = 4;

function meanAbsDiff(a: Buffer, b: Buffer): number {
  if (a.length !== b.length) throw new Error(`buffer size mismatch: ${a.length} vs ${b.length}`);
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    sum += (Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!)) / 3;
  }
  return sum / (a.length / 4);
}

async function ffprobeColor(filePath: string): Promise<Record<string, string>> {
  const { stdout } = await execute(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries",
      "stream=color_space,color_primaries,color_transfer,color_range", "-of", "json", filePath],
    { timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout).streams[0] as Record<string, string>;
}

async function waitForJob(facade: AgentFacade, jobId: string, timeoutMs = 240_000): Promise<JobStatusView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await facade["job.status"]({ jobId });
    if (!status.ok) throw new Error(`job.status failed: ${status.error.message}`);
    const { state } = status.value;
    if (state === "done" || state === "error" || state === "cancelled") return status.value;
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not settle (state=${state})`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
}

describe("color pipeline regression (Route F, system ffmpeg)", () => {
  let workDir: string;
  let binaries: NonNullable<Awaited<ReturnType<typeof resolveFfmpegBinaries>>>;

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "color-routef-"));
    const resolved = await resolveFfmpegBinaries();
    if (!resolved) throw new Error("color regression needs ffmpeg+ffprobe on this host");
    binaries = resolved;
  });

  afterAll(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("exports BT.709/limited-tagged video whose matrix-aware decode matches the source", { timeout: 120_000 }, async () => {
    const patternPng = await writeColorPatternPng(workDir);
    const reference = await extractFrameRgba(
      binaries.ffmpeg, patternPng, 0, COLOR_PATTERN_WIDTH, COLOR_PATTERN_HEIGHT,
    );
    const { readFile } = await import("node:fs/promises");
    const patternPngBytes = await readFile(patternPng);

    const outPath = path.join(workDir, "routef.mp4");
    const encoder = startFramesEncoder(binaries.ffmpeg, {
      width: COLOR_PATTERN_WIDTH,
      height: COLOR_PATTERN_HEIGHT,
      frameRate: COLOR_PATTERN_FRAME_RATE,
      crf: 18,
      destPath: outPath,
    });
    for (let frame = 0; frame < COLOR_PATTERN_FRAME_RATE * 2; frame++) {
      await encoder.writeFrame(patternPngBytes);
    }
    const bytes = await encoder.finish();
    expect(bytes).toBeGreaterThan(0);

    const color = await ffprobeColor(outPath);
    expect(color.color_space).toBe("bt709");
    expect(color.color_primaries).toBe("bt709");
    expect(color.color_transfer).toBe("bt709");
    expect(color.color_range).toBe("tv");

    // Correct matrix: the round trip must stay inside the documented tolerance.
    const decodedCorrect = await extractFrameRgba(
      binaries.ffmpeg, outPath, 0.5, COLOR_PATTERN_WIDTH, COLOR_PATTERN_HEIGHT,
      { colorMatrix: "bt709" },
    );
    const correctDiff = meanAbsDiff(decodedCorrect, reference);
    expect(correctDiff).toBeLessThanOrEqual(MAX_HOP_MEAN_ABS_DIFF);

    // Wrong matrix: decoding BT.709 pixels through BT.601 must measurably
    // diverge on the saturated bars — the regression that matrix-blind
    // comparisons would hide.
    const decodedWrong = await extractFrameRgba(
      binaries.ffmpeg, outPath, 0.5, COLOR_PATTERN_WIDTH, COLOR_PATTERN_HEIGHT,
      { colorMatrix: "bt601" },
    );
    const wrongDiff = meanAbsDiff(decodedWrong, reference);
    expect(wrongDiff).toBeGreaterThanOrEqual(MIN_WRONG_MATRIX_MEAN_ABS_DIFF);
    expect(wrongDiff).toBeGreaterThan(correctDiff + 2);
  });
});

describe("color pipeline regression (Route W, real Chromium)", () => {
  let mediaRoot: string;
  let artifactRoot: string;
  let providers: ChromiumProviders;
  let binaries: NonNullable<Awaited<ReturnType<typeof resolveFfmpegBinaries>>>;

  beforeAll(async () => {
    mediaRoot = await mkdtemp(path.join(tmpdir(), "color-w-media-"));
    artifactRoot = await mkdtemp(path.join(tmpdir(), "color-w-artifacts-"));
    const resolved = await resolveFfmpegBinaries();
    if (!resolved) throw new Error("color regression needs ffmpeg+ffprobe on this host");
    binaries = resolved;
    providers = createChromiumProviders({
      probeSampleMediaPath: await writeColorPatternVideo(mediaRoot, "bt709"),
    });
    const probe = await providers.probe();
    expect(probe.launchError).toBeUndefined();
    expect(probe.summary.renderAvailable).toBe(true);
    expect(probe.summary.exportRoute).not.toBe("unavailable");
  }, 300_000);

  afterAll(async () => {
    if (providers) await providers.close();
    if (mediaRoot) await rm(mediaRoot, { recursive: true, force: true });
    if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true });
  });

  async function buildProjectAround(source: string): Promise<AgentFacade> {
    // One facade per scenario: a facade session owns exactly one project.
    const scenarioFacade = createAgentFacade({
      mediaRoots: [mediaRoot],
      artifactRoot,
      renderProvider: providers.renderProvider,
      exportProvider: providers.exportProvider,
      artifactVerifier: new FfmpegArtifactVerifier(),
    });
    const created = await scenarioFacade["project.create"]({
      name: "ColorRouteW",
      settings: { width: COLOR_PATTERN_WIDTH, height: COLOR_PATTERN_HEIGHT, frameRate: COLOR_PATTERN_FRAME_RATE, sampleRate: 48000, channels: 2 },
    });
    expect(created.ok).toBe(true);
    const imported = await scenarioFacade["media.import"]({ path: source });
    expect(imported.ok).toBe(true);
    if (!imported.ok) throw new Error("import failed");
    await scenarioFacade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "video", trackId: "v1" }],
    });
    const clip = await scenarioFacade["edit.apply"]({
      ops: [{
        op: "clip.add",
        trackId: "v1",
        mediaId: imported.value.mediaId,
        clipId: "clip-color",
        startTime: 0,
        duration: 2,
        inPoint: 0,
        outPoint: 2,
      }],
    });
    expect(clip.ok).toBe(true);
    return scenarioFacade;
  }

  it(
    "import→preview→export→re-import keeps tagged BT.601 content consistent and honestly tagged",
    { timeout: 480_000 },
    async () => {
      const patternPng = await writeColorPatternPng(mediaRoot);
      const reference = await extractFrameRgba(
        binaries.ffmpeg, patternPng, 0, COLOR_PATTERN_WIDTH, COLOR_PATTERN_HEIGHT,
      );
      const bt601Video = await writeColorPatternVideo(mediaRoot, "bt601");
      const facade = await buildProjectAround(bt601Video);

      // Preview still (import decode → sRGB canvas → PNG).
      const preview = await facade["preview.render_frame"]({ timeSec: 1, width: COLOR_PATTERN_WIDTH, height: COLOR_PATTERN_HEIGHT });
      expect(preview.ok).toBe(true);
      if (!preview.ok) throw new Error(preview.error.message);
      const previewRgba = await extractFrameRgba(
        binaries.ffmpeg, preview.value.artifact.path, 0, COLOR_PATTERN_WIDTH, COLOR_PATTERN_HEIGHT,
      );
      const previewDiff = meanAbsDiff(previewRgba, reference);
      expect(previewDiff).toBeLessThanOrEqual(MAX_HOP_MEAN_ABS_DIFF);

      // Export (Route W: Chromium WebCodecs + mediabunny).
      const started = await facade["export.start"]({});
      expect(started.ok).toBe(true);
      if (!started.ok) throw new Error(started.error.message);
      const job = await waitForJob(facade, started.value.jobId);
      expect(job.state).toBe("done");
      const outputPath = job.artifact!.path;

      // Honest tagging: Chromium's RGBA→YUV conversion is BT.601 and the
      // stream says so (docs/COLOR.md — verified, not assumed).
      const color = await ffprobeColor(outputPath);
      expect(color.color_space).toMatch(/smpte170m|bt601/);
      expect(color.color_range).toBe("tv");

      // Re-import path: decode the export through ITS OWN tag (matrix-aware)
      // and compare in the unified sRGB space.
      const matrix = color.color_space === "bt709" ? "bt709" : "bt601";
      const reimported = await extractFrameRgba(
        binaries.ffmpeg, outputPath, 1, COLOR_PATTERN_WIDTH, COLOR_PATTERN_HEIGHT,
        { colorMatrix: matrix },
      );
      const exportDiff = meanAbsDiff(reimported, reference);
      expect(exportDiff).toBeLessThanOrEqual(MAX_HOP_MEAN_ABS_DIFF + 2); // one extra encode hop

      // Preview and export must agree with each other in RGB space.
      const previewVsExport = meanAbsDiff(previewRgba, reimported);
      expect(previewVsExport).toBeLessThanOrEqual(MAX_HOP_MEAN_ABS_DIFF);
    },
  );

  it(
    "untagged BT.601 content shows the documented import shift (decode assumes BT.709)",
    { timeout: 240_000 },
    async () => {
      const patternPng = await writeColorPatternPng(mediaRoot);
      const reference = await extractFrameRgba(
        binaries.ffmpeg, patternPng, 0, COLOR_PATTERN_WIDTH, COLOR_PATTERN_HEIGHT,
      );
      const untaggedVideo = await writeColorPatternVideo(mediaRoot, "untagged");
      const facade = await buildProjectAround(untaggedVideo);

      const preview = await facade["preview.render_frame"]({ timeSec: 1, width: COLOR_PATTERN_WIDTH, height: COLOR_PATTERN_HEIGHT });
      expect(preview.ok).toBe(true);
      if (!preview.ok) throw new Error(preview.error.message);
      const previewRgba = await extractFrameRgba(
        binaries.ffmpeg, preview.value.artifact.path, 0, COLOR_PATTERN_WIDTH, COLOR_PATTERN_HEIGHT,
      );
      const untaggedDiff = meanAbsDiff(previewRgba, reference);
      // The shift is real and measurable: decode assumed BT.709 for
      // BT.601-encoded pixels. technicalQuality reports this file as
      // unknown-metadata (asserted in agent-facade color-policy.test.ts).
      expect(untaggedDiff).toBeGreaterThan(3);
    },
  );
});
