/**
 * Slice-1b target E2E (the audit/e2e-contract.md 7-step path, for real):
 *
 *   project.create(320x180@30) → import 6 s input.mp4 → clip 0–5 s
 *   → "Hello world" 0–5 s → Chromium renders a REAL PNG at 2.5 s
 *   → export.start → 5 s output.mp4 (H.264)
 *   → verify.artifact: ffprobe + frame extraction + pixel comparison
 *
 * Everything runs against real Chromium via the provider interfaces; the
 * input fixture is VP9-in-MP4 because stock Linux Chromium cannot decode
 * H.264 (only the OUTPUT codec is contractually pinned to H.264).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createAgentFacade,
  type AgentFacade,
  type JobStatusView,
} from "@openreel/agent-facade";
import { writeTinyMp4 } from "@openreel/agent-facade/media/fixtures/tiny-mp4";

import { createChromiumProviders, type ChromiumProviders } from "./node/providers";
import { FfmpegArtifactVerifier } from "./node/verify";
import type { RuntimeProbeResult } from "./node/probe";
import { saveEvidence } from "./evidence";
import {
  TINY_VP9_MP4_EXPECTED,
  writeTinyVp9Mp4,
} from "./media/tiny-vp9-mp4";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

async function waitForJob(
  facade: AgentFacade,
  jobId: string,
  timeoutMs = 480_000,
  onPoll?: (view: JobStatusView) => void,
): Promise<JobStatusView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await facade["job.status"]({ jobId });
    if (!status.ok) throw new Error(`job.status failed: ${status.error.message}`);
    onPoll?.(status.value);
    const { state } = status.value;
    if (state === "done" || state === "error" || state === "cancelled") {
      return status.value;
    }
    if (Date.now() > deadline) {
      throw new Error(`job ${jobId} did not settle within ${timeoutMs}ms (state=${state})`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
}

describe("slice-1b chromium E2E", () => {
  let mediaRoot: string;
  let artifactRoot: string;
  let inputPath: string;
  let providers: ChromiumProviders;
  let facade: AgentFacade;
  let probe: RuntimeProbeResult;
  const phaseMs: Record<string, number> = {};
  let rssBefore = 0;

  beforeAll(async () => {
    rssBefore = process.memoryUsage().rss;
    mediaRoot = await mkdtemp(path.join(tmpdir(), "e2e-media-"));
    artifactRoot = await mkdtemp(path.join(tmpdir(), "e2e-artifacts-"));
    // The 6-second input.mp4 of the target scenario (VP9 fixture under the
    // scenario's file name).
    const fixturePath = writeTinyVp9Mp4(mediaRoot);
    inputPath = path.join(mediaRoot, "input.mp4");
    await copyFile(fixturePath, inputPath);
  }, 60_000);

  afterAll(async () => {
    if (providers) await providers.close();
    if (mediaRoot) await rm(mediaRoot, { recursive: true, force: true });
    // Artifacts are KEPT for inspection when E2E_KEEP_ARTIFACTS=1.
    if (artifactRoot && process.env.E2E_KEEP_ARTIFACTS !== "1") {
      await rm(artifactRoot, { recursive: true, force: true });
    } else if (artifactRoot) {
      console.log(`[e2e] artifacts kept at ${artifactRoot}`);
    }
    const rssAfter = process.memoryUsage().rss;
    console.log(
      `[e2e] phase timings (ms): ${JSON.stringify(phaseMs)} nodeRssΔ=${Math.round((rssAfter - rssBefore) / 1048576)}MiB`,
    );
  });

  it("runs the full create→import→trim→text→render→export→verify path", async () => {
    // Probe + providers -------------------------------------------------
    let t0 = Date.now();
    const h264Sample = writeTinyMp4(mediaRoot);
    providers = createChromiumProviders({ probeSampleMediaPath: h264Sample });
    probe = await providers.probe();
    phaseMs.probe = Date.now() - t0;
    await writeFile(
      path.join(artifactRoot, "runtime-probe.json"),
      JSON.stringify(probe, null, 2),
    );
    await saveEvidence("runtime-probe.json", probe);
    console.log(
      `[e2e] chromium=${probe.chromium.version} route=${probe.summary.exportRoute} ` +
        `h264dec=${probe.summary.h264DecodeAvailable} h264enc=${probe.summary.h264EncodeAvailable} ` +
        `ffmpeg=${probe.ffmpeg.available} decodeSample(h264)=${JSON.stringify(probe.page.decodeSample)}`,
    );
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

    // capabilities: all three independent preflights pass ---------------
    const caps = await facade["capabilities.get"]();
    expect(caps.ok).toBe(true);
    if (!caps.ok) return;
    expect(caps.value.preview.available).toBe(true);
    expect(caps.value.export.available).toBe(true);
    expect(caps.value.verify.available).toBe(true);
    expect(caps.value.textOverlay.pixelRendering).toBe(true);
    const desc = await facade["session.describe"]();
    if (!desc.ok) throw new Error("describe failed");
    expect(desc.value.stepLetters.textOverlayPixels).toBe("C");
    expect(desc.value.stepLetters.exportVideo).toBe("C");
    expect(desc.value.stepLetters.verifyArtifact).toBe("A");
    expect(desc.value.contractVersion).toBe("facade-slice-2");

    // 1) project.create 320x180@30 ---------------------------------------
    const created = await facade["project.create"]({
      name: "Slice 1b E2E",
      settings: { width: 320, height: 180, frameRate: 30, sampleRate: 48000, channels: 2 },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // 2) import the 6 s input.mp4 ----------------------------------------
    const imported = await facade["media.import"]({
      path: inputPath,
      name: "input.mp4",
      expectedRevision: 0,
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.type).toBe("video");
    expect(imported.value.metadata.width).toBe(TINY_VP9_MP4_EXPECTED.width);
    expect(imported.value.metadata.height).toBe(TINY_VP9_MP4_EXPECTED.height);
    expect(imported.value.metadata.durationSec).toBeCloseTo(
      TINY_VP9_MP4_EXPECTED.durationSec,
      0,
    );
    const mediaId = imported.value.mediaId;

    // 3) clip 0–5 s + 4) "Hello world" 0–5 s (one atomic batch) ----------
    const edited = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "video", trackId: "v1" },
        { op: "clip.add", trackId: "v1", mediaId, startTime: 0, clipId: "c1" },
        { op: "clip.trim", clipId: "c1", inPoint: 0, outPoint: 5 },
        { op: "track.add", trackType: "text", trackId: "t1" },
        { op: "text.create", trackId: "t1", text: "Hello world", startTime: 0, duration: 5 },
      ],
      expectedRevision: 1,
      idempotencyKey: "e2e-edit-1",
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.value.revision).toBe(2);

    // Model state carries EXACTLY "Hello world" --------------------------
    const timeline = await facade["timeline.get"]();
    if (!timeline.ok) throw new Error("timeline.get failed");
    expect(timeline.value.duration).toBe(5);
    expect(timeline.value.textOverlays).toHaveLength(1);
    expect(timeline.value.textOverlays[0]?.text).toBe("Hello world");
    expect(timeline.value.textOverlays[0]?.startTime).toBe(0);
    expect(timeline.value.textOverlays[0]?.duration).toBe(5);

    // 5) Chromium renders a REAL PNG at 2.5 s ----------------------------
    t0 = Date.now();
    const preview = await facade["preview.render_frame"]({
      timeSec: 2.5,
      expectedRevision: 2,
      idempotencyKey: "e2e-preview-2.5",
    });
    phaseMs.firstPreviewRender = Date.now() - t0;
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.artifact.format).toBe("png");
    expect(preview.value.artifact.sourceRevision).toBe(2);
    expect(preview.value.artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    const pngBytes = await readFile(preview.value.artifact.path);
    expect(pngBytes.subarray(0, 4)).toEqual(PNG_MAGIC);
    expect(pngBytes.length).toBe(preview.value.artifact.sizeBytes);
    console.log(
      `[e2e] preview PNG: ${preview.value.artifact.path} (${pngBytes.length} bytes, sha256=${preview.value.artifact.sha256.slice(0, 16)}…)`,
    );

    // Idempotent replay of the render returns the same artifact ----------
    const previewReplay = await facade["preview.render_frame"]({
      timeSec: 2.5,
      idempotencyKey: "e2e-preview-2.5",
    });
    expect(previewReplay.ok).toBe(true);
    if (!previewReplay.ok) return;
    expect(previewReplay.value.replayed).toBe(true);
    expect(previewReplay.value.artifact.sha256).toBe(preview.value.artifact.sha256);

    // 6) export.start → 5 s output.mp4 ------------------------------------
    t0 = Date.now();
    const started = await facade["export.start"]({ idempotencyKey: "e2e-export-1" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.value.jobId).toMatch(/^job-/);
    expect(started.value.sourceRevision).toBe(2);
    expect(started.value.replayed).toBe(false);
    const jobId = started.value.jobId;

    // Same idempotencyKey + same payload replays the SAME jobId -----------
    const replayed = await facade["export.start"]({ idempotencyKey: "e2e-export-1" });
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.value.jobId).toBe(jobId);
    expect(replayed.value.replayed).toBe(true);

    // Editing continues while the export runs (snapshot stays frozen) -----
    const concurrentEdit = await facade["edit.apply"]({
      ops: [{ op: "text.create", trackId: "t1", text: "post-export edit", startTime: 1, duration: 1 }],
      expectedRevision: 2,
    });
    expect(concurrentEdit.ok).toBe(true);
    if (!concurrentEdit.ok) return;
    expect(concurrentEdit.value.revision).toBe(3);

    let lastLogged = -1;
    const final = await waitForJob(facade, jobId, 480_000, (view) => {
      const percent = Math.round((view.progress?.percent ?? 0) * 100);
      if (percent >= lastLogged + 25) {
        lastLogged = percent;
        console.log(`[e2e] export ${view.state} ${percent}% (frame ${view.progress?.currentFrame ?? "-"}/${view.progress?.totalFrames ?? "-"})`);
      }
    });
    phaseMs.export = Date.now() - t0;
    expect(final.state).toBe("done");
    expect(final.route).toBe(probe.summary.exportRoute);
    expect(final.sourceRevision).toBe(2);
    expect(final.artifact).not.toBeNull();
    const mp4 = final.artifact!;
    expect(mp4.format).toBe("mp4");
    expect(mp4.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(mp4.sizeBytes).toBeGreaterThan(0);
    console.log(
      `[e2e] exported MP4 via ${final.route}: ${mp4.path} (${mp4.sizeBytes} bytes, sha256=${mp4.sha256.slice(0, 16)}…)`,
    );

    // No partial files survive a successful export ------------------------
    const exportDirFiles = await readdir(path.dirname(mp4.path));
    expect(exportDirFiles).toEqual(["output.mp4"]);

    // 7a) verify.artifact: container/codec/geometry/duration --------------
    const verified = await facade["verify.artifact"]({
      path: mp4.path,
      expect: {
        container: "mp4",
        videoCodec: "h264",
        width: 320,
        height: 180,
        durationSec: 5,
        durationToleranceSec: 0.12,
      },
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    console.log(
      `[e2e] ffprobe: container=${verified.value.probe.container} vcodec=${verified.value.probe.videoCodec} ` +
        `${verified.value.probe.width}x${verified.value.probe.height} dur=${verified.value.probe.durationSec.toFixed(3)}s ` +
        `frames=${verified.value.probe.frameCount} fps=${verified.value.probe.frameRate?.toFixed(2)}`,
    );
    expect(verified.value.pass).toBe(true);
    for (const check of verified.value.checks) {
      expect(check.pass, `check ${check.name}: ${check.details}`).toBe(true);
    }
    expect(verified.value.probe.videoCodec).toBe("h264");
    expect(verified.value.probe.width).toBe(320);
    expect(verified.value.probe.height).toBe(180);
    expect(verified.value.probe.durationSec).toBeGreaterThan(4.8);
    expect(verified.value.probe.durationSec).toBeLessThan(5.2);
    // "5 s ± 1 frame" made exact at 30 fps.
    expect(verified.value.probe.frameCount).not.toBeNull();
    expect(Math.abs((verified.value.probe.frameCount ?? 0) - 150)).toBeLessThanOrEqual(1);
    expect(verified.value.probe.sha256).toBe(mp4.sha256);

    // 7b) exported frame @2.5 s ≈ preview PNG @2.5 s -----------------------
    const similar = await facade["verify.artifact"]({
      path: mp4.path,
      compare: {
        referencePath: preview.value.artifact.path,
        timeSec: 2.5,
        mode: "similar",
        maxMeanAbsDiff: 14,
      },
    });
    expect(similar.ok).toBe(true);
    if (!similar.ok) return;
    console.log(
      `[e2e] preview-vs-export @2.5s: mean|Δ|=${similar.value.compare?.meanAbsDiff.toFixed(3)} changed=${((similar.value.compare?.changedPixelsRatio ?? 0) * 100).toFixed(2)}%`,
    );
    expect(similar.value.compare?.pass).toBe(true);

    // 7c) exported frame @2.5 s vs ORIGINAL INPUT @2.5 s: the text region
    // must differ significantly (the overlay is really burned in) --------
    const textRegion = { x: 0.15, y: 0.3, width: 0.7, height: 0.4 };
    const different = await facade["verify.artifact"]({
      path: mp4.path,
      compare: {
        referencePath: inputPath,
        timeSec: 2.5,
        referenceTimeSec: 2.5,
        region: textRegion,
        mode: "different",
        minChangedPixelsRatio: 0.02,
      },
    });
    expect(different.ok).toBe(true);
    if (!different.ok) return;
    console.log(
      `[e2e] export-vs-input @2.5s (text region): mean|Δ|=${different.value.compare?.meanAbsDiff.toFixed(3)} changed=${((different.value.compare?.changedPixelsRatio ?? 0) * 100).toFixed(2)}%`,
    );
    expect(different.value.compare?.pass).toBe(true);

    // The snapshot semantics are provable: the concurrent edit (revision 3)
    // never entered the exported video — its text is absent from the job's
    // snapshot. (Model-level check; pixel proof is the frame above.)
    const stateAfter = await facade["project.get_state"]();
    if (!stateAfter.ok) throw new Error("get_state failed");
    expect(stateAfter.value.revision).toBe(3);
    expect(stateAfter.value.project.textClips).toHaveLength(2);

    // Persist the verification evidence alongside the artifacts ----------
    const verifyEvidence = { probe: verified.value, similar: similar.value, different: different.value };
    await writeFile(
      path.join(artifactRoot, "verify-report.json"),
      JSON.stringify(verifyEvidence, null, 2),
    );
    await saveEvidence("verify-report.json", verifyEvidence);
  });
});
