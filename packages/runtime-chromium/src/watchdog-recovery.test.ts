/**
 * Watchdog / crash recovery E2E (real Chromium):
 *
 *  - A tiny watchdog on EITHER route must (a) really stop the underlying
 *    work (in-page abort / ffmpeg kill + browser recycle), (b) let cleanup
 *    finish, (c) settle the job exactly once as ERROR (never "cancelled"),
 *    leaving zero .mp4/.part behind — and (d) NOT brick the pool: the same
 *    pool must preview and export again afterwards.
 *  - A hard browser CRASH (SIGKILL) must invalidate the cached probe: the
 *    next capabilities.get re-probes the fresh browser, and the capability
 *    report agrees with what the verbs can actually do.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
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
  predicate: () => Promise<boolean> | boolean,
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

async function leftoversIn(jobDir: string): Promise<string[]> {
  const entries = await readdir(jobDir).catch(() => [] as string[]);
  return entries.filter((f) => f.endsWith(".mp4") || f.endsWith(".part"));
}

describe("export watchdog + runtime recovery E2E", () => {
  let mediaRoot: string;
  let artifactRoot: string;
  const pools: ChromiumProviders[] = [];

  async function makeSession(providerConfig: ChromiumProvidersConfig = {}) {
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
      name: "watchdog-e2e",
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
    return { facade, providers };
  }

  beforeAll(async () => {
    mediaRoot = await mkdtemp(path.join(tmpdir(), "wd-media-"));
    artifactRoot = await mkdtemp(path.join(tmpdir(), "wd-artifacts-"));
  }, 60_000);

  afterAll(async () => {
    for (const pool of pools) await pool.close().catch(() => undefined);
    await rm(mediaRoot, { recursive: true, force: true });
    await rm(artifactRoot, { recursive: true, force: true });
  });

  it("route W watchdog: stops work, cleans up, settles once as error, pool recovers", async () => {
    const { facade, providers } = await makeSession({ exportWatchdogMs: 250 });
    const probe = await providers.probe();
    if (probe.summary.exportRoute !== "chromium-webcodecs") {
      console.log("[watchdog] skipping Route-W watchdog: no WebCodecs route here");
      return;
    }

    const started = await facade["export.start"]({});
    if (!started.ok) throw new Error("export.start failed");
    const jobId = started.value.jobId;
    const final = await waitForJob(facade, jobId);

    // Settles as ERROR with the watchdog message — never "cancelled".
    expect(final.state).toBe("error");
    expect(final.error?.message ?? "").toContain("watchdog");
    expect(final.artifact).toBeNull();

    // Zero leftovers in the job dir.
    const jobDir = path.join(artifactRoot, "exports", jobId);
    expect(await leftoversIn(jobDir)).toEqual([]);

    // Exactly-once: the terminal state must not flip afterwards.
    await new Promise((r) => setTimeout(r, 1_000));
    const again = await facade["job.status"]({ jobId });
    expect(again.ok && again.value.state).toBe("error");

    // The pool is NOT bricked: preview works on the same pool…
    const preview = await facade["preview.render_frame"]({ timeSec: 1 });
    expect(preview.ok).toBe(true);

    // …and a fresh export (watchdog restored) completes on the same pool.
    providers.pool.exportWatchdogMs = 600_000;
    const second = await facade["export.start"]({});
    if (!second.ok) throw new Error("second export.start failed");
    const secondFinal = await waitForJob(facade, second.value.jobId);
    expect(secondFinal.state).toBe("done");
    expect(secondFinal.artifact).not.toBeNull();
    console.log(
      `[watchdog] route W recovered: second export ${secondFinal.artifact?.sizeBytes} bytes`,
    );
  }, 600_000);

  it("route F watchdog: stops ffmpeg+page, cleans up, settles as error, pool recovers", async () => {
    const { facade, providers } = await makeSession({
      forceExportRoute: "chromium-frames-ffmpeg",
      exportWatchdogMs: 250,
    });
    const probe = await providers.probe();
    if (!probe.ffmpeg.available) {
      console.log("[watchdog] skipping Route-F watchdog: no ffmpeg here");
      return;
    }

    const started = await facade["export.start"]({});
    if (!started.ok) throw new Error("export.start failed");
    const jobId = started.value.jobId;
    const final = await waitForJob(facade, jobId);
    expect(final.state).toBe("error");
    expect(final.error?.message ?? "").toContain("watchdog");
    expect(final.artifact).toBeNull();
    expect(await leftoversIn(path.join(artifactRoot, "exports", jobId))).toEqual([]);

    // Pool recovers: preview + a fresh (watchdog-restored) export succeed.
    const preview = await facade["preview.render_frame"]({ timeSec: 1 });
    expect(preview.ok).toBe(true);
    providers.pool.exportWatchdogMs = 600_000;
    const second = await facade["export.start"]({});
    if (!second.ok) throw new Error("second export.start failed");
    const secondFinal = await waitForJob(facade, second.value.jobId);
    expect(secondFinal.state).toBe("done");
    expect(secondFinal.route).toBe("chromium-frames-ffmpeg");
  }, 600_000);

  it("renderer crash (page dies, browser alive): stale capability is invalidated and the pool recovers", async () => {
    const { facade, providers } = await makeSession();
    const caps1 = await facade["capabilities.get"]();
    if (!caps1.ok) throw new Error("caps failed");
    if (!caps1.value.preview.available || !caps1.value.export.available) {
      console.log("[watchdog] skipping renderer-crash test: runtime not capable here");
      return;
    }
    const generationBefore = providers.pool.runtime.generation;
    const before = await facade["preview.render_frame"]({ timeSec: 1 });
    expect(before.ok).toBe(true);

    // Kill ONLY the renderer (chrome://crash): the browser process stays
    // connected, so this is the scenario 'disconnected' cannot cover.
    await providers.pool.runtime.simulateRendererCrashForTesting();
    const bumped = await waitFor(
      () => providers.pool.runtime.generation !== generationBefore,
      30_000,
    );
    expect(bumped).toBe(true);

    // The stale probe is dead with the page: capabilities re-probe the fresh
    // runtime, and the verbs agree with the report.
    const caps2 = await facade["capabilities.get"]();
    if (!caps2.ok) throw new Error("caps after renderer crash failed");
    expect(caps2.value.preview.available).toBe(true);
    expect(caps2.value.export.available).toBe(true);
    const preview = await facade["preview.render_frame"]({ timeSec: 1 });
    expect(preview.ok).toBe(true);
    const started = await facade["export.start"]({});
    if (!started.ok) throw new Error("export.start after renderer crash failed");
    const final = await waitForJob(facade, started.value.jobId);
    expect(final.state).toBe("done");
    console.log(
      `[watchdog] renderer-crash recovery: gen ${generationBefore} → ${providers.pool.runtime.generation}, export = ${final.state}`,
    );
  }, 600_000);

  it("hard browser crash: capability re-probes the fresh runtime and agrees with the verbs", async () => {
    const { facade, providers } = await makeSession();
    const caps1 = await facade["capabilities.get"]();
    if (!caps1.ok) throw new Error("caps failed");
    if (!caps1.value.preview.available || !caps1.value.export.available) {
      console.log("[watchdog] skipping crash test: runtime not export-capable here");
      return;
    }
    const generationBefore = providers.pool.runtime.generation;

    // Prove the verbs work before the crash.
    const before = await facade["preview.render_frame"]({ timeSec: 1 });
    expect(before.ok).toBe(true);

    // Crash the browser out from under the runtime (no orderly teardown) —
    // the 'disconnected' event must drive the same invalidation a real
    // crash would.
    await providers.pool.runtime.simulateBrowserCrashForTesting();
    const disconnected = await waitFor(
      () => !providers.pool.runtime.isBrowserConnected,
      30_000,
    );
    expect(disconnected).toBe(true);
    // The crash invalidated the cached probe generation.
    expect(providers.pool.runtime.generation).not.toBe(generationBefore);

    // capabilities.get re-probes the FRESH runtime (no stale success)…
    const caps2 = await facade["capabilities.get"]();
    if (!caps2.ok) throw new Error("caps after crash failed");
    expect(caps2.value.preview.available).toBe(true);
    expect(caps2.value.export.available).toBe(true);

    // …and the verbs agree with the capability report: preview + export
    // both really work on the recovered runtime.
    const preview = await facade["preview.render_frame"]({ timeSec: 1 });
    expect(preview.ok).toBe(true);
    const started = await facade["export.start"]({});
    if (!started.ok) throw new Error("export.start after crash failed");
    const final = await waitForJob(facade, started.value.jobId);
    expect(final.state).toBe("done");
    expect(final.artifact).not.toBeNull();
    console.log(
      `[watchdog] crash recovery: gen ${generationBefore} → ${providers.pool.runtime.generation}, export after crash = ${final.state}`,
    );
  }, 600_000);
});
