/**
 * Reference comparison E2E (P1) — the field-report workflow made native:
 * pick a reference range, sync-compare it against the edit timeline, and
 * export an honest side-by-side, without external scripts.
 *
 * Determinism trick: both the reference and the timeline media encode their
 * FRAME NUMBER as the position of a white dot on a 10x10 grid (col = frame %
 * 10, row = floor(frame / 10)), so "which frame is shown" is mechanically
 * readable from pixels — the acceptance requirement for first/last/cut/
 * offset-mapped frames, without OCR.
 *
 * Covered:
 *  - reference.setComparison / clearComparison as canonical undoable ops,
 *  - preview.render_comparison: left = mapped reference frame, right =
 *    canonical timeline render; offset mapping verified at the first frame,
 *    the background-cut frame and the last frame; clamped beyond refEndSec,
 *  - the main timeline state is untouched (read-only verb, same revision),
 *  - export.start {comparison}: one canonical render + one compose pass,
 *    side-by-side geometry, audio from exactly ONE side, and correct mapped
 *    frames in the exported video.
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

import { createChromiumProviders, type ChromiumProviders } from "./node/providers";
import { FfmpegArtifactVerifier } from "./node/verify";
import { extractFrameRgba, resolveFfmpegBinaries } from "./node/ffmpeg";

const execute = promisify(execFile);

const W = 640;
const H = 360;
const FPS = 10;
const DURATION_SEC = 4;

/** Grid cell (col,row in 0..9) that encodes one frame number. */
function frameCell(frame: number): { col: number; row: number } {
  return { col: frame % 10, row: Math.floor(frame / 10) };
}

async function writeFrameEncodedVideo(
  dir: string,
  name: string,
  withAudio: boolean,
): Promise<string> {
  const outPath = path.join(dir, name);
  // Every frame: dark gray field + one white dot at the cell encoding N.
  const geq = (channel: "r" | "g" | "b") => {
    const value = channel === "r" ? "40" : channel === "g" ? "40" : "48";
    return `if(between(abs(X-(mod(N,10)*64+32)),0,9)*between(abs(Y-(floor(N/10)*36+18)),0,9),255,${value})`;
  };
  const args = [
    "-hide_banner", "-nostdin", "-v", "error",
    "-f", "lavfi", "-i",
    `nullsrc=s=${W}x${H}:r=${FPS}:d=${DURATION_SEC},geq=r='${geq("r")}':g='${geq("g")}':b='${geq("b")}'`,
  ];
  if (withAudio) {
    args.push("-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${DURATION_SEC}`);
  }
  args.push(
    "-t", String(DURATION_SEC),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
    "-vf", "scale=out_color_matrix=bt709:out_range=tv",
    "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709",
    "-color_range", "tv",
    "-pix_fmt", "yuv420p",
  );
  if (withAudio) args.push("-c:a", "aac", "-b:a", "96k", "-shortest");
  args.push("-y", outPath);
  await execute("ffmpeg", args, { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  return outPath;
}

interface Rgba { readonly width: number; readonly height: number; readonly data: Buffer }

async function decodePng(pngPath: string): Promise<Rgba> {
  const binaries = await resolveFfmpegBinaries();
  expect(binaries).not.toBeNull();
  const data = await extractFrameRgba(binaries!.ffmpeg, pngPath, 0, W, H);
  return { width: W, height: H, data };
}

function pixelAt(image: Rgba, x: number, y: number): readonly [number, number, number] {
  const i = (y * image.width + x) * 4;
  return [image.data[i]!, image.data[i + 1]!, image.data[i + 2]!];
}

async function waitForJob(facade: AgentFacade, jobId: string, timeoutMs = 300_000): Promise<JobStatusView> {
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

describe("reference comparison (real Chromium)", () => {
  let mediaRoot: string;
  let artifactRoot: string;
  let providers: ChromiumProviders;
  let facade: AgentFacade;

  // Mapping under test: timeline time T ↔ reference frame 5 + 10T
  // (refStartSec 0.5 at timelineStartSec 0, rate 1). The timeline clip uses
  // inPoint 2s, so the RIGHT side at T shows source frame 20 + 10T.
  const REF_START = 0.5;
  const TL_INPOINT = 2;

  beforeAll(async () => {
    mediaRoot = await mkdtemp(path.join(tmpdir(), "refcmp-media-"));
    artifactRoot = await mkdtemp(path.join(tmpdir(), "refcmp-artifacts-"));
    const reference = await writeFrameEncodedVideo(mediaRoot, "reference.mp4", true);
    const timelineMedia = await writeFrameEncodedVideo(mediaRoot, "timeline-media.mp4", true);

    providers = createChromiumProviders({ probeSampleMediaPath: reference });
    const probe = await providers.probe();
    expect(probe.launchError).toBeUndefined();
    expect(probe.summary.renderAvailable).toBe(true);
    expect(probe.summary.exportRoute).not.toBe("unavailable");

    facade = createAgentFacade({
      mediaRoots: [mediaRoot],
      artifactRoot,
      renderProvider: providers.renderProvider,
      exportProvider: providers.exportProvider,
      artifactVerifier: new FfmpegArtifactVerifier(),
    });
    await facade["project.create"]({
      name: "RefCompare",
      settings: { width: W, height: H, frameRate: FPS, sampleRate: 48000, channels: 2 },
    });
    const refImport = await facade["media.import"]({ path: reference });
    const tlImport = await facade["media.import"]({ path: timelineMedia });
    expect(refImport.ok).toBe(true);
    expect(tlImport.ok).toBe(true);
    if (!refImport.ok || !tlImport.ok) throw new Error("imports failed");

    // The source has 4s of material; inPoint 2s leaves a 2s comparable span
    // (the comparison covers timeline 0..2s in every case below).
    await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "video", trackId: "v1" },
        {
          op: "clip.add",
          trackId: "v1",
          mediaId: tlImport.value.mediaId,
          clipId: "clip-tl",
          startTime: 0,
          duration: 2,
          inPoint: TL_INPOINT,
          outPoint: TL_INPOINT + 2,
        },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (providers) await providers.close();
    if (mediaRoot) await rm(mediaRoot, { recursive: true, force: true });
    if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true });
  });

  it("configures, maps and clears the shared comparison config canonically", async () => {
    const state0 = await facade["project.get_state"]();
    expect(state0.ok).toBe(true);
    if (!state0.ok) return;
    const refMediaId = state0.value.project.mediaLibrary.items.find((item) =>
      item.originalUrl?.includes("reference.mp4"))!.id;

    const badRate = await facade["edit.apply"]({
      ops: [{
        op: "reference.setComparison",
        config: {
          referenceMediaId: refMediaId, refStartSec: REF_START, refEndSec: 3,
          timelineStartSec: 0, rate: 0.5 as unknown as 1, audioSide: "none", layout: "side-by-side",
        },
      }],
    });
    expect(badRate.ok).toBe(false);
    if (!badRate.ok) expect(badRate.error.message).toContain("rate");

    const missing = await facade["edit.apply"]({
      ops: [{
        op: "reference.setComparison",
        config: {
          referenceMediaId: "media-does-not-exist", refStartSec: 0, refEndSec: 1,
          timelineStartSec: 0, rate: 1, audioSide: "none", layout: "side-by-side",
        },
      }],
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("NOT_FOUND");

    const set = await facade["edit.apply"]({
      ops: [{
        op: "reference.setComparison",
        config: {
          referenceMediaId: refMediaId, refStartSec: REF_START, refEndSec: 3,
          timelineStartSec: 0, rate: 1, audioSide: "timeline", layout: "side-by-side",
        },
      }],
    });
    if (!set.ok) console.log("SET FAIL:", JSON.stringify(set.error));
    expect(set.ok).toBe(true);
    const state1 = await facade["project.get_state"]();
    expect(state1.ok).toBe(true);
    if (!state1.ok) return;
    expect(state1.value.project.referenceComparison).toMatchObject({
      refStartSec: REF_START,
      timelineStartSec: 0,
      rate: 1,
      audioSide: "timeline",
      layout: "side-by-side",
    });

    const cleared = await facade["edit.apply"]({
      ops: [{ op: "reference.clearComparison" }],
    });
    expect(cleared.ok).toBe(true);
    const state2 = await facade["project.get_state"]();
    expect(state2.ok).toBe(true);
    if (state2.ok) expect(state2.value.project.referenceComparison).toBeUndefined();

    // Restore for the rest of the suite.
    const restore = await facade["edit.apply"]({
      ops: [{
        op: "reference.setComparison",
        config: {
          referenceMediaId: refMediaId, refStartSec: REF_START, refEndSec: 3,
          timelineStartSec: 0, rate: 1, audioSide: "timeline", layout: "side-by-side",
        },
      }],
    });
    expect(restore.ok).toBe(true);
  });

  it("renders comparison stills with exact mapped frames and no timeline pollution", { timeout: 240_000 }, async () => {

    const before = await facade["project.get_state"]();
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const revisionBefore = before.value.revision;
    // First frame, a mid frame, the timeline cut frame and the last frame of
    // the 2s comparison span.
    for (const t of [0, 0.8, 1.0, 1.9]) {
      const res = await facade["preview.render_comparison"]({ timeSec: t, width: 640, height: 360 });
      if (!res.ok) console.log("CMP FAIL:", JSON.stringify(res.error));
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error(res.error.message);
      expect(res.value.referenceSec).toBeCloseTo(REF_START + t, 5);
      expect(res.value.clamped).toBe("none");
      expect(res.value.layout).toBe("side-by-side");

      const image = await decodePng(res.value.artifact.path);
      // Each half cell (W/2 x H) letterboxes the 16:9 source to a centered
      // fit box — the aspect-preserving no-crop contract. Read the dot grid
      // inside that box.
      const fitBox = (cw: number): { x: number; y: number; w: number; h: number } => {
        const scale = Math.min(cw / W, H / H);
        return { x: 0, y: (H - H * scale) / 2, w: W * scale, h: H * scale };
      };
      const dotAtHalf = (x0: number, cw: number): { col: number; row: number } | null => {
        const box = fitBox(cw);
        for (let row = 0; row < 10; row++) {
          for (let col = 0; col < 10; col++) {
            const cx = Math.round(x0 + box.x + (col + 0.5) * (box.w / 10));
            const cy = Math.round(box.y + (row + 0.5) * (box.h / 10));
            const [r, g, b] = pixelAt(image, cx, cy);
            if (r > 180 && g > 180 && b > 180) return { col, row };
          }
        }
        return null;
      };
      const leftCell = dotAtHalf(0, W / 2);
      const rightCell = dotAtHalf(W / 2, W / 2);
      expect(leftCell).not.toBeNull();
      expect(rightCell).not.toBeNull();
      // Mapped reference frame: refStart 0.5s → frame 5 + t*10.
      const wantLeft = frameCell(Math.round((REF_START + t) * FPS));
      // Timeline side: clip inPoint 2s → source frame 20 + t*10.
      const wantRight = frameCell(Math.round((TL_INPOINT + t) * FPS));
      expect(leftCell).toEqual(wantLeft);
      expect(rightCell).toEqual(wantRight);
    }
    // Read-only verb: the canonical project is untouched.
    const afterState = await facade["project.get_state"]();
    expect(afterState.ok).toBe(true);
    if (afterState.ok) expect(afterState.value.revision).toBe(revisionBefore);
  });

  it("clamps and discloses beyond refEndSec", { timeout: 120_000 }, async () => {
    const state = await facade["project.get_state"]();
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    const refMediaId = state.value.project.referenceComparison!.referenceMediaId;
    // Tighten refEnd so the 2s timeline can outrun it, then restore.
    const tighten = await facade["edit.apply"]({
      ops: [{
        op: "reference.setComparison",
        config: { referenceMediaId: refMediaId, refStartSec: REF_START, refEndSec: 1.5, timelineStartSec: 0, rate: 1, audioSide: "timeline", layout: "side-by-side" },
      }],
    });
    expect(tighten.ok).toBe(true);
    const res = await facade["preview.render_comparison"]({ timeSec: 1.9, width: 640, height: 360 });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error.message);
    expect(res.value.clamped).toBe("after");
    expect(res.value.referenceSec).toBe(1.5); // the tightened refEndSec
    expect(res.value.limitations.join(" ")).toContain("holds the last reference frame");
    const restore = await facade["edit.apply"]({
      ops: [{
        op: "reference.setComparison",
        config: { referenceMediaId: refMediaId, refStartSec: REF_START, refEndSec: 3, timelineStartSec: 0, rate: 1, audioSide: "timeline", layout: "side-by-side" },
      }],
    });
    expect(restore.ok).toBe(true);
  });

  it("exports the comparison video from one canonical render", { timeout: 480_000 }, async () => {
    const started = await facade["export.start"]({
      comparison: { startSec: 0, endSec: 2 },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error.message);
    const job = await waitForJob(facade, started.value.jobId);
    if (job.state !== "done") console.log("EXPORT FAIL:", JSON.stringify(job.error));
    expect(job.state).toBe("done");
    expect(job.route).toBe("comparison-compose");
    const outputPath = job.artifact!.path;

    const { stdout } = await execute(
      "ffprobe",
      ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", outputPath],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    const probe = JSON.parse(stdout) as {
      streams: Array<{ codec_type: string; width?: number; height?: number }>;
      format: { duration: string };
    };
    const video = probe.streams.find((s) => s.codec_type === "video")!;
    expect(video.width).toBe(W * 2); // side-by-side: two full-export-raster cells
    expect(video.height).toBe(H);
    // Audio from exactly ONE side (config: timeline) — present, single track.
    expect(probe.streams.filter((s) => s.codec_type === "audio")).toHaveLength(1);
    expect(Number(probe.format.duration)).toBeGreaterThan(1.8);

    // Frame-accurate mapping in the exported video at t=0.5 (frame 5):
    const binaries = await resolveFfmpegBinaries();
    expect(binaries).not.toBeNull();
    const frame = await extractFrameRgba(binaries!.ffmpeg, outputPath, 0.5, W * 2, H);
    const image: Rgba = { width: W * 2, height: H, data: frame };
    const halfCell = { w: W / 10, h: H / 10 };
    const dotAt = (x0: number): { col: number; row: number } | null => {
      for (let row = 0; row < 10; row++) {
        for (let col = 0; col < 10; col++) {
          const cx = Math.round(x0 + (col + 0.5) * halfCell.w);
          const cy = Math.round((row + 0.5) * halfCell.h);
          const [r, g, b] = pixelAt(image, cx, cy);
          if (r > 180 && g > 180 && b > 180) return { col, row };
        }
      }
      return null;
    };
    const t = 0.5;
    expect(dotAt(0)).toEqual(frameCell(Math.round((REF_START + t) * FPS)));
    expect(dotAt(W)).toEqual(frameCell(Math.round((TL_INPOINT + t) * FPS)));

    // The main timeline was NOT polluted: state still shows one clip and the
    // comparison config (both untouched by the export).
    const state = await facade["project.get_state"]();
    expect(state.ok).toBe(true);
    if (state.ok) {
      expect(state.value.project.timeline.tracks.flatMap((tr) => tr.clips).map((c) => c.id)).toEqual(["clip-tl"]);
      expect(state.value.project.referenceComparison?.refStartSec).toBe(REF_START);
    }
  });
});
