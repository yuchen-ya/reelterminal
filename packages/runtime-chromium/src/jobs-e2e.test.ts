/**
 * Real-Chromium job lifecycle E2E:
 *  - Route F (frames→ffmpeg) produces a valid MP4 whose frames match preview
 *  - cooperative cancel mid-export on BOTH routes (no fake artifacts left)
 *  - job serialization: a second export stays queued behind the first
 *  - cancel of a queued job settles cancelled without ever running
 *  - infrastructure races (media deleted before a queued job runs) settle to
 *    error with NO artifact
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyFile, mkdtemp, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createAgentFacade,
  type AgentFacade,
  type JobStatusView,
} from "@openreel/agent-facade";

import {
  createChromiumProviders,
  type ChromiumProviders,
  type ChromiumProvidersConfig,
} from "./node/providers";
import { FfmpegArtifactVerifier } from "./node/verify";
import { writeTinyVp9Mp4 } from "./media/tiny-vp9-mp4";

async function waitForJob(
  facade: AgentFacade,
  jobId: string,
  timeoutMs = 480_000,
): Promise<JobStatusView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await facade["job.status"]({ jobId });
    if (!status.ok) throw new Error(`job.status failed: ${status.error.message}`);
    const { state } = status.value;
    if (state === "done" || state === "error" || state === "cancelled") {
      return status.value;
    }
    if (Date.now() > deadline) {
      throw new Error(`job ${jobId} did not settle within ${timeoutMs}ms (state=${state})`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
}

interface Session {
  facade: AgentFacade;
  inputPath: string;
  mediaId: string;
}

describe("chromium job lifecycle E2E", () => {
  let mediaRoot: string;
  let artifactRoot: string;
  const pools: ChromiumProviders[] = [];

  async function makeSession(
    providerConfig: ChromiumProvidersConfig = {},
  ): Promise<Session & { providers: ChromiumProviders }> {
    const providers = createChromiumProviders(providerConfig);
    pools.push(providers);
    const facade = createAgentFacade({
      mediaRoots: [mediaRoot],
      artifactRoot,
      renderProvider: providers.renderProvider,
      exportProvider: providers.exportProvider,
      artifactVerifier: new FfmpegArtifactVerifier(),
    });
    const fixture = writeTinyVp9Mp4(mediaRoot);
    const inputPath = path.join(mediaRoot, `input-${crypto.randomUUID()}.mp4`);
    await copyFile(fixture, inputPath);
    await facade["project.create"]({
      name: "jobs-e2e",
      settings: { width: 320, height: 180, frameRate: 30, sampleRate: 48000, channels: 2 },
    });
    const imported = await facade["media.import"]({ path: inputPath, expectedRevision: 0 });
    if (!imported.ok) throw new Error("import failed");
    const edited = await facade["edit.apply"]({
      ops: [
        { op: "track.add", trackType: "video", trackId: "v1" },
        { op: "clip.add", trackId: "v1", mediaId: imported.value.mediaId, startTime: 0, clipId: "c1" },
        { op: "clip.trim", clipId: "c1", inPoint: 0, outPoint: 5 },
        { op: "track.add", trackType: "text", trackId: "t1" },
        { op: "text.create", trackId: "t1", text: "Hello world", startTime: 0, duration: 5 },
      ],
      expectedRevision: 1,
    });
    if (!edited.ok) throw new Error("edit failed");
    return { facade, inputPath, mediaId: imported.value.mediaId, providers };
  }

  beforeAll(async () => {
    mediaRoot = await mkdtemp(path.join(tmpdir(), "jobs-media-"));
    artifactRoot = await mkdtemp(path.join(tmpdir(), "jobs-artifacts-"));
  }, 60_000);

  afterAll(async () => {
    for (const pool of pools) await pool.close().catch(() => undefined);
    await rm(mediaRoot, { recursive: true, force: true });
    if (process.env.E2E_KEEP_ARTIFACTS !== "1") {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("route F (frames→ffmpeg) exports a valid H.264 MP4 matching preview", async () => {
    const { facade } = await makeSession({ forceExportRoute: "chromium-frames-ffmpeg" });
    const caps = await facade["capabilities.get"]();
    if (!caps.ok) throw new Error("caps failed");
    expect(caps.value.export.available).toBe(true);

    const preview = await facade["preview.render_frame"]({ timeSec: 2.5 });
    if (!preview.ok) throw new Error("preview failed");

    const started = await facade["export.start"]({});
    if (!started.ok) throw new Error("export.start failed");
    const final = await waitForJob(facade, started.value.jobId);
    if (final.state !== "done") {
      console.log(`[jobs] route F job failed: ${JSON.stringify(final.error)}`);
    }
    expect(final.state).toBe("done");
    expect(final.route).toBe("chromium-frames-ffmpeg");
    const mp4 = final.artifact!;
    console.log(`[jobs] route F MP4: ${mp4.sizeBytes} bytes sha256=${mp4.sha256.slice(0, 16)}…`);

    const verified = await facade["verify.artifact"]({
      path: mp4.path,
      expect: { container: "mp4", videoCodec: "h264", width: 320, height: 180, durationSec: 5, durationToleranceSec: 0.12 },
    });
    if (!verified.ok) throw new Error("verify failed");
    console.log(
      `[jobs] route F ffprobe: vcodec=${verified.value.probe.videoCodec} ${verified.value.probe.width}x${verified.value.probe.height} dur=${verified.value.probe.durationSec.toFixed(3)}s frames=${verified.value.probe.frameCount} acodec=${verified.value.probe.audioCodec}`,
    );
    expect(verified.value.pass).toBe(true);
    expect(Math.abs((verified.value.probe.frameCount ?? 0) - 150)).toBeLessThanOrEqual(1);

    const similar = await facade["verify.artifact"]({
      path: mp4.path,
      compare: { referencePath: preview.value.artifact.path, timeSec: 2.5, mode: "similar", maxMeanAbsDiff: 10 },
    });
    if (!similar.ok) throw new Error("similar verify failed");
    console.log(`[jobs] route F preview-vs-export @2.5s: mean|Δ|=${similar.value.compare?.meanAbsDiff.toFixed(3)}`);
    expect(similar.value.compare?.pass).toBe(true);
  }, 600_000);

  it("cancels a running WebCodecs export and leaves no artifact", async () => {
    const { facade } = await makeSession({ forceExportRoute: "chromium-webcodecs" });
    const probe = await pools[pools.length - 1]!.probe();
    if (!probe.summary.h264EncodeAvailable) {
      console.log("[jobs] skipping Route-W cancel: no H.264 encode here");
      return;
    }
    // Bigger raster + fps = a comfortable cancellation window.
    const started = await facade["export.start"]({
      settings: { width: 640, height: 360, frameRate: 60 },
    });
    if (!started.ok) throw new Error("export.start failed");
    const jobId = started.value.jobId;

    const running = await waitFor(async () => {
      const status = await facade["job.status"]({ jobId });
      return status.ok && status.value.state === "running";
    }, 30_000);
    expect(running).toBe(true);

    const cancelled = await facade["job.cancel"]({ jobId });
    expect(cancelled.ok).toBe(true);
    const final = await waitForJob(facade, jobId);
    expect(final.state).toBe("cancelled");
    expect(final.artifact).toBeNull();

    const jobDir = path.join(artifactRoot, "exports", jobId);
    const leftovers = await readdir(jobDir).catch(() => [] as string[]);
    console.log(`[jobs] route W cancel leftovers: ${JSON.stringify(leftovers)}`);
    expect(leftovers.filter((f) => f.endsWith(".mp4") || f.endsWith(".part"))).toEqual([]);
  }, 600_000);

  it("cancels a running frames→ffmpeg export and leaves no artifact", async () => {
    const { facade } = await makeSession({ forceExportRoute: "chromium-frames-ffmpeg" });
    const started = await facade["export.start"]({
      settings: { width: 640, height: 360, frameRate: 60 },
    });
    if (!started.ok) throw new Error("export.start failed");
    const jobId = started.value.jobId;

    const progressed = await waitFor(async () => {
      const status = await facade["job.status"]({ jobId });
      return status.ok && status.value.state === "running" && (status.value.progress?.currentFrame ?? 0) > 2;
    }, 60_000);
    expect(progressed).toBe(true);

    await facade["job.cancel"]({ jobId });
    const final = await waitForJob(facade, jobId);
    expect(final.state).toBe("cancelled");
    expect(final.artifact).toBeNull();

    const jobDir = path.join(artifactRoot, "exports", jobId);
    const leftovers = await readdir(jobDir).catch(() => [] as string[]);
    console.log(`[jobs] route F cancel leftovers: ${JSON.stringify(leftovers)}`);
    expect(leftovers.filter((f) => f.endsWith(".mp4") || f.endsWith(".part"))).toEqual([]);
  }, 600_000);

  it("serializes exports: second job stays queued, then runs; queued cancel settles", async () => {
    const { facade } = await makeSession();
    const first = await facade["export.start"]({
      settings: { width: 640, height: 360, frameRate: 60 },
    });
    if (!first.ok) throw new Error("first export failed");
    const second = await facade["export.start"]({});
    if (!second.ok) throw new Error("second export failed");

    // While the first job holds the page, the second must report queued.
    const firstRunning = await waitFor(async () => {
      const status = await facade["job.status"]({ jobId: first.value.jobId });
      return status.ok && status.value.state === "running";
    }, 30_000);
    expect(firstRunning).toBe(true);
    const secondEarly = await facade["job.status"]({ jobId: second.value.jobId });
    if (!secondEarly.ok) throw new Error("second status failed");
    console.log(`[jobs] second job state while first runs: ${secondEarly.value.state}`);
    expect(secondEarly.value.state).toBe("queued");

    // Cancel the queued job: it must settle cancelled without producing work.
    await facade["job.cancel"]({ jobId: second.value.jobId });
    const secondFinal = await waitForJob(facade, second.value.jobId);
    expect(secondFinal.state).toBe("cancelled");
    expect(secondFinal.artifact).toBeNull();

    const firstFinal = await waitForJob(facade, first.value.jobId);
    expect(firstFinal.state).toBe("done");
    expect(firstFinal.artifact).not.toBeNull();
    const secondDir = path.join(artifactRoot, "exports", second.value.jobId);
    const leftovers = await readdir(secondDir).catch(() => [] as string[]);
    expect(leftovers.filter((f) => f.endsWith(".mp4") || f.endsWith(".part"))).toEqual([]);
  }, 600_000);

  it("a queued job whose media vanished settles to error with NO artifact", async () => {
    const { facade, inputPath } = await makeSession();
    const first = await facade["export.start"]({
      settings: { width: 640, height: 360, frameRate: 60 },
    });
    if (!first.ok) throw new Error("first export failed");
    const second = await facade["export.start"]({});
    if (!second.ok) throw new Error("second export failed");

    const firstRunning = await waitFor(async () => {
      const status = await facade["job.status"]({ jobId: first.value.jobId });
      return status.ok && status.value.state === "running";
    }, 30_000);
    expect(firstRunning).toBe(true);

    // Delete the media while job two is queued: when its turn comes the
    // runtime cannot attach it and the job must fail honestly.
    await unlink(inputPath);

    const [firstFinal, secondFinal] = await Promise.all([
      waitForJob(facade, first.value.jobId),
      waitForJob(facade, second.value.jobId),
    ]);
    // The first job already had the file attached (or fails too on a slow
    // machine) — either way the assertion that matters is on job two.
    console.log(`[jobs] media-vanished: first=${firstFinal.state} second=${secondFinal.state} err=${secondFinal.error?.message ?? "-"}`);
    expect(secondFinal.state).toBe("error");
    expect(secondFinal.artifact).toBeNull();
    expect(secondFinal.error?.message ?? "").not.toBe("");
    const secondDir = path.join(artifactRoot, "exports", second.value.jobId);
    const leftovers = await readdir(secondDir).catch(() => [] as string[]);
    expect(leftovers.filter((f) => f.endsWith(".mp4") || f.endsWith(".part"))).toEqual([]);
  }, 600_000);

  it("a forced route without its prerequisite reports unavailable honestly", async () => {
    const providers = createChromiumProviders({
      forceExportRoute: "chromium-frames-ffmpeg",
      ffmpegPath: path.join(mediaRoot, "no-such-ffmpeg.exe"),
      ffprobePath: path.join(mediaRoot, "no-such-ffprobe.exe"),
    });
    pools.push(providers);
    const facade = createAgentFacade({
      mediaRoots: [mediaRoot],
      artifactRoot,
      exportProvider: providers.exportProvider,
    });
    const caps = await facade["capabilities.get"]();
    if (!caps.ok) throw new Error("caps failed");
    expect(caps.value.export.available).toBe(false);
    expect(caps.value.export.reason).toBeTruthy();

    await facade["project.create"]({ name: "no-route" });
    const started = await facade["export.start"]({});
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error.code).toBe("UNSUPPORTED");
  }, 300_000);
});
