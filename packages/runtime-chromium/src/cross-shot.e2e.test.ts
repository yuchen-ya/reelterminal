/**
 * Cross-shot continuous compositing regression (P1).
 *
 * The deterministic scenario from the field report: a foreground element
 * (the "bat") must keep moving across a background cut (red shot → blue
 * shot) instead of restarting at the cut point. Layers are the canonical
 * track model — the foreground clip lives on a higher track (z-order via
 * track.add position) and spans both background clips with continuous
 * position/opacity keyframes on ONE absolute timeline clock.
 *
 * Verified end-to-end against real Chromium rendering and export:
 *  - background switches exactly at the cut,
 *  - the foreground centroid follows the SAME linear keyframe interpolation
 *    before/at/after the cut (no reset, no jump),
 *  - opacity blending stays continuous across the cut,
 *  - preview stills and export frames agree pixel-wise,
 *  - the canonical project state shows the foreground spanning both shots,
 *  - a foreground longer than its media is rejected with an explicit error
 *    (the documented insufficient-material behavior).
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
const CUT_SEC = 2;
const TOTAL_SEC = 4;

/**
 * Transform semantics of the canonical model: clip transforms position is a
 * PROJECT-PIXEL offset from the frame center (drawFrameToContext translates
 * to center + position), and track index 0 is the TOP z-order layer (the
 * render loop draws tracks in descending index order, painter-style).
 */
const FG_OFFSET_Y = 0;
const FG_X_FROM = -220;
const FG_X_TO = 220;
const FG_OPACITY = 0.9;
const FG_SCALE = 0.2; // 100x100 source contain-fits to 360x360 → 72x72 drawn

/** Center-x (pixels) the keyframes demand at timeline time t (linear). */
function predictedCenterX(t: number): number {
  return W / 2 + FG_X_FROM + (FG_X_TO - FG_X_FROM) * (t / TOTAL_SEC);
}

async function writeSolidVideo(
  dir: string,
  name: string,
  rgb: readonly [number, number, number],
  durationSec: number,
  size: string,
): Promise<string> {
  const outPath = path.join(dir, name);
  const hex = rgb.map((v) => v.toString(16).padStart(2, "0")).join("");
  await execute(
    "ffmpeg",
    [
      "-hide_banner", "-nostdin", "-v", "error",
      "-f", "lavfi", "-i", `color=c=0x${hex}:s=${size}:r=${FPS}:d=${durationSec}`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-vf", "scale=out_color_matrix=bt709:out_range=tv",
      "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709",
      "-color_range", "tv",
      "-y", outPath,
    ],
    { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return outPath;
}

interface Rgba {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
}

async function renderStill(agent: AgentFacade, t: number): Promise<Rgba> {
  const preview = await agent["preview.render_frame"]({ timeSec: t });
  expect(preview.ok).toBe(true);
  if (!preview.ok) throw new Error(preview.error.message);
  const binaries = await resolveFfmpegBinaries();
  expect(binaries).not.toBeNull();
  const data = await extractFrameRgba(binaries!.ffmpeg, preview.value.artifact.path, 0, W, H);
  return { width: W, height: H, data };
}

function pixel(image: Rgba, x: number, y: number): readonly [number, number, number] {
  const i = (y * image.width + x) * 4;
  return [image.data[i]!, image.data[i + 1]!, image.data[i + 2]!];
}

/** Centroid x of pixels that are green-dominant (the foreground square). */
function foregroundCentroidX(image: Rgba): { x: number; count: number } {
  let sumX = 0;
  let count = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const [r, g, b] = pixel(image, x, y);
      if (g > 150 && g > r + 40 && g > b + 40) {
        sumX += x;
        count += 1;
      }
    }
  }
  return count === 0 ? { x: -1, count } : { x: sumX / count, count };
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

describe("cross-shot continuous compositing (real Chromium)", () => {
  let mediaRoot: string;
  let artifactRoot: string;
  let providers: ChromiumProviders;
  let facade: AgentFacade;

  beforeAll(async () => {
    mediaRoot = await mkdtemp(path.join(tmpdir(), "crossshot-media-"));
    artifactRoot = await mkdtemp(path.join(tmpdir(), "crossshot-artifacts-"));
    const bgA = await writeSolidVideo(mediaRoot, "bg-red.mp4", [255, 0, 0], CUT_SEC, `${W}x${H}`);
    const bgB = await writeSolidVideo(mediaRoot, "bg-blue.mp4", [0, 0, 255], CUT_SEC, `${W}x${H}`);
    const fg = await writeSolidVideo(mediaRoot, "fg-green.mp4", [0, 255, 0], TOTAL_SEC, "100x100");

    providers = createChromiumProviders({ probeSampleMediaPath: bgA });
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

    const created = await facade["project.create"]({
      name: "CrossShot",
      settings: { width: W, height: H, frameRate: FPS, sampleRate: 48000, channels: 2 },
    });
    expect(created.ok).toBe(true);
    const imported: Record<string, string> = {};
    for (const [key, file] of Object.entries({ bgA, bgB, fg })) {
      const res = await facade["media.import"]({ path: file });
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error(res.error.message);
      imported[key] = res.value.mediaId;
    }

    // Background track first (appends at index 0) …
    await facade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "video", trackId: "bg" }],
    });
    await facade["edit.apply"]({
      ops: [
        { op: "clip.add", trackId: "bg", mediaId: imported.bgA!, clipId: "clip-bg-a", startTime: 0, duration: CUT_SEC, inPoint: 0, outPoint: CUT_SEC },
        { op: "clip.add", trackId: "bg", mediaId: imported.bgB!, clipId: "clip-bg-b", startTime: CUT_SEC, duration: CUT_SEC, inPoint: 0, outPoint: CUT_SEC },
      ],
    });

    // … then insert the FOREGROUND track at position 0 — the top z-order
    // layer, ABOVE the background track — carrying ONE clip that spans the
    // cut, animated on the absolute timeline clock.
    await facade["edit.apply"]({
      ops: [{ op: "track.add", trackType: "video", trackId: "fg", position: 0 }],
    });
    await facade["edit.apply"]({
      ops: [{
        op: "clip.add",
        trackId: "fg",
        mediaId: imported.fg!,
        clipId: "clip-fg",
        startTime: 0,
        duration: TOTAL_SEC,
        inPoint: 0,
        outPoint: TOTAL_SEC,
      }],
    });
    await facade["edit.apply"]({
      ops: [
        {
          op: "clip.setTransform",
          clipId: "clip-fg",
          transform: { scale: { x: FG_SCALE, y: FG_SCALE }, position: { x: FG_X_FROM, y: FG_OFFSET_Y }, opacity: FG_OPACITY },
        },
        {
          op: "clip.setKeyframes",
          clipId: "clip-fg",
          keyframes: [
            { property: "position.x", time: 0, value: FG_X_FROM, easing: "linear" },
            { property: "position.x", time: TOTAL_SEC, value: FG_X_TO, easing: "linear" },
            { property: "position.y", time: 0, value: FG_OFFSET_Y, easing: "linear" },
            { property: "position.y", time: TOTAL_SEC, value: FG_OFFSET_Y, easing: "linear" },
            { property: "opacity", time: 0, value: FG_OPACITY, easing: "linear" },
            { property: "opacity", time: TOTAL_SEC, value: FG_OPACITY, easing: "linear" },
          ],
        },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    if (providers) await providers.close();
    if (mediaRoot) await rm(mediaRoot, { recursive: true, force: true });
    if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true });
  });

  it("exposes the layered structure through the canonical project state", async () => {
    const state = await facade["project.get_state"]();
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    // track.add position 0 put the foreground at index 0 — the top layer.
    const tracks = state.value.project.timeline.tracks;
    expect(tracks.map((t) => t.id)).toEqual(["fg", "bg"]);
    const fgClips = tracks[0]!.clips.map((c) => c.id);
    expect(fgClips).toEqual(["clip-fg"]);
    const bgClips = tracks[1]!.clips.map((c) => c.id);
    expect(bgClips).toEqual(["clip-bg-a", "clip-bg-b"]);
    const fgClip = tracks[0]!.clips[0]!;
    expect(fgClip.startTime).toBe(0);
    expect(fgClip.duration).toBe(TOTAL_SEC);
    // The continuous-animation contract: keyframes on one absolute clock.
    const xKeyframes = fgClip.keyframes.filter((k) => k.property === "position.x");
    expect(xKeyframes.map((k) => k.time)).toEqual([0, TOTAL_SEC]);
  });

  it("keeps the foreground moving across the background cut (no restart)", { timeout: 240_000 }, async () => {
    const samples = [0.5, 1.9, 2.0, 2.1, 3.5];
    const measured: number[] = [];
    for (const t of samples) {
      const still = await renderStill(facade, t);
      // Background identity away from the foreground square.
      const corner = pixel(still, 16, 16);
      if (t < CUT_SEC) {
        expect(corner[0]).toBeGreaterThan(180);
        expect(corner[2]).toBeLessThan(90);
      } else {
        expect(corner[2]).toBeGreaterThan(180);
        expect(corner[0]).toBeLessThan(90);
      }
      const centroid = foregroundCentroidX(still);
      expect(centroid.count).toBeGreaterThan(500); // the square is really there
      const predictedPx = predictedCenterX(t);
      expect(Math.abs(centroid.x - predictedPx)).toBeLessThan(12);
      measured.push(centroid.x);

      // Opacity continuity: inside the square, green blends 0.9/0.1 over the
      // CURRENT background — same blend ratio on both sides of the cut.
      const inside = pixel(still, Math.round(centroid.x), Math.round(H / 2 + FG_OFFSET_Y));
      const expected = t < CUT_SEC
        ? [FG_OPACITY * 0 + (1 - FG_OPACITY) * 255, FG_OPACITY * 255, FG_OPACITY * 0]
        : [0, FG_OPACITY * 255, (1 - FG_OPACITY) * 255];
      for (const [got, want] of [
        [inside[0], expected[0]],
        [inside[1], expected[1]],
        [inside[2], expected[2]],
      ] as const) {
        expect(Math.abs(got - want)).toBeLessThan(14); // one yuv420 encode hop
      }
    }
    // Monotonic motion with no jump at the cut: consecutive deltas match the
    // linear keyframe slope times the sampling interval.
    for (let i = 1; i < samples.length; i++) {
      const dt = samples[i]! - samples[i - 1]!;
      const expectedDelta = ((FG_X_TO - FG_X_FROM) / TOTAL_SEC) * dt;
      const actualDelta = measured[i]! - measured[i - 1]!;
      expect(Math.abs(actualDelta - expectedDelta)).toBeLessThan(16);
    }
  });

  it("renders the export through the same compositor as the preview", { timeout: 300_000 }, async () => {
    const started = await facade["export.start"]({});
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error.message);
    const job = await waitForJob(facade, started.value.jobId);
    expect(job.state).toBe("done");
    const outputPath = job.artifact!.path;

    const binaries = await resolveFfmpegBinaries();
    expect(binaries).not.toBeNull();
    // Frame-boundary times only: an export frame k covers [k/fps, (k+1)/fps)
    // and decoders return the first frame with pts >= t, so mid-frame times
    // would compare the preview's continuous-time state against the NEXT
    // export frame — a convention mismatch, not a render difference.
    for (const t of [0.5, 1.9, 2.0, 3.5]) {
      const still = await renderStill(facade, t);
      // Decode the export through its own honest tag (see color-pipeline
      // tests; Chromium tags smpte170m) and compare in RGB space.
      const exported = await extractFrameRgba(
        binaries!.ffmpeg, outputPath, t, W, H, { colorMatrix: "bt601" },
      );
      let sum = 0;
      const count = W * H;
      for (let i = 0; i < exported.length; i += 4) {
        sum += (Math.abs(exported[i]! - still.data[i]!)
          + Math.abs(exported[i + 1]! - still.data[i + 1]!)
          + Math.abs(exported[i + 2]! - still.data[i + 2]!)) / 3;
      }
      expect(sum / count).toBeLessThan(6);
    }
  });

  it("rejects a foreground span longer than its media with an explicit error", async () => {
    const state = await facade["project.get_state"]();
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    const bad = await facade["edit.apply"]({
      ops: [{
        op: "clip.add",
        trackId: "fg",
        mediaId: state.value.project.mediaLibrary.items.find((item) =>
          item.originalUrl?.includes("bg-red"))!.id,
        clipId: "clip-too-long",
        startTime: 0,
        duration: CUT_SEC + 1, // bg-red only has 2 s of material
        inPoint: 0,
        outPoint: CUT_SEC + 1,
      }],
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.code).toBe("INVALID_PARAMS");
      expect(bad.error.message).toContain("exceeds media duration");
    }
  });
});
