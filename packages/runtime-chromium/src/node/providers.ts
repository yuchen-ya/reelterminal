/**
 * Facade provider implementations over the real Chromium runtime
 * (ADR 0002 #1/#4/#6).
 *
 * - ChromiumRenderProvider: preview.render_frame backing (hydrate → render →
 *   PNG under artifactRoot).
 * - ChromiumExportProvider: export.start backing. Route W reuses the existing
 *   ExportEngine/WebCodecsBackend inside Chromium with chunks streamed to
 *   disk; Route F (CI Chromium without H.264 encode) streams the SAME
 *   rendered frames into system ffmpeg/libx264. Both yield a real H.264 MP4;
 *   a WebM is never passed off as success. Jobs are serialized: the second
 *   job stays "queued" until the page is free. Cancellation is cooperative
 *   and always settles the job.
 * - Availability comes from the live runtime probe, independently per
 *   provider — a working renderer never implies a working exporter.
 */
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Project } from "@openreel/core/types/project";
import type {
  ExportCallbacks,
  ExportProvider,
  ExportVideoRequest,
  ProviderPreflight,
  RenderFrameRequest,
  RenderedFrameInfo,
  RenderProvider,
} from "@openreel/agent-facade";

import {
  resolveFfmpegBinaries,
  startFramesEncoder,
  type FfmpegConfig,
} from "./ffmpeg";
import {
  runChromiumRuntimeProbe,
  type RuntimeProbeResult,
} from "./probe";
import { ChromiumRuntime, PartFileWriter } from "./runtime";

export interface ChromiumProvidersConfig {
  /** Explicit chromium executable; defaults to the Playwright-managed one. */
  readonly executablePath?: string;
  readonly headless?: boolean;
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
  /** Optional sample for the probe's real decode smoke. */
  readonly probeSampleMediaPath?: string;
  /**
   * Test hook: pin the export route instead of deriving it from the probe.
   * The pinned route is still validated against its prerequisites (frames
   * route needs ffmpeg; webcodecs route needs H.264 encode) — it can make a
   * capable machine exercise the fallback, never an incapable one lie.
   */
  readonly forceExportRoute?: "chromium-webcodecs" | "chromium-frames-ffmpeg";
  /** Hard ceiling for one export job; default 600_000 (10 min). */
  readonly exportWatchdogMs?: number;
}

interface JobSlot {
  cancelRequested: boolean;
  state: "queued" | "active" | "settled";
}

function timelineDurationSec(project: Project): number {
  let maxEnd = 0;
  for (const track of project.timeline.tracks) {
    for (const clip of track.clips) {
      maxEnd = Math.max(maxEnd, clip.startTime + clip.duration);
    }
  }
  for (const clip of project.textClips ?? []) {
    maxEnd = Math.max(maxEnd, clip.startTime + clip.duration);
  }
  return maxEnd;
}

export class ChromiumRenderProvider implements RenderProvider {
  readonly id = "chromium-render";
  private readonly providers: ChromiumProviderPool;

  constructor(pool: ChromiumProviderPool) {
    this.providers = pool;
  }

  async preflight(): Promise<ProviderPreflight> {
    const probe = await this.providers.probe();
    if (probe.launchError) {
      return {
        available: false,
        reason: `Chromium failed to launch: ${probe.launchError}`,
        requires: "a working Chromium (playwright-core install chromium)",
      };
    }
    if (!probe.summary.renderAvailable) {
      return {
        available: false,
        reason:
          "render preflight failed in real Chromium (OffscreenCanvas/engine/mediabunny — see probe facts)",
        requires: "OffscreenCanvas 2D + PNG encode + VideoEngine + mediabunny in Chromium",
        details: { page: { errors: probe.page.errors } },
      };
    }
    return {
      available: true,
      details: {
        chromium: probe.chromium.version,
        h264Decode: probe.summary.h264DecodeAvailable,
      },
    };
  }

  async renderFramePng(request: RenderFrameRequest): Promise<RenderedFrameInfo> {
    const probe = await this.providers.probe();
    if (!probe.summary.renderAvailable) {
      throw new Error("render provider preflight failed — refusing to render");
    }
    const png = await this.providers.runtime.renderPng(
      request.project,
      request.mediaFiles,
      request.timeSec,
      request.width,
      request.height,
    );
    if (png.length === 0) {
      throw new Error("Chromium returned an empty PNG frame");
    }
    await writeFile(request.destPath, png);
    return { bytesWritten: png.length };
  }
}

export class ChromiumExportProvider implements ExportProvider {
  readonly id = "chromium-export";
  private readonly providers: ChromiumProviderPool;
  private exportChain: Promise<unknown> = Promise.resolve();
  private readonly jobs = new Map<string, JobSlot>();
  private activeRoute: "chromium-webcodecs" | "chromium-frames-ffmpeg" | null = null;

  constructor(pool: ChromiumProviderPool) {
    this.providers = pool;
  }

  async preflight(): Promise<ProviderPreflight> {
    const route = await this.providers.exportRoute();
    if (route === "unavailable") {
      const probe = await this.providers.probe();
      return {
        available: false,
        reason:
          probe.summary.exportUnavailableReason ??
          "no honest H.264 export route exists in this runtime",
        requires:
          "Chromium with H.264 encode (WebCodecs) OR Chromium frames + an ffmpeg binary",
        details: {
          h264EncodeAvailable: probe.summary.h264EncodeAvailable,
          ffmpegAvailable: probe.ffmpeg.available,
        },
      };
    }
    const probe = await this.providers.probe();
    return {
      available: true,
      details: {
        route,
        chromium: probe.chromium.version,
        ffmpeg: probe.ffmpeg.available ? probe.ffmpeg.ffmpegPath : null,
      },
    };
  }

  /** Returns promptly; the job settles exactly once via the callbacks. */
  async startExport(
    request: ExportVideoRequest,
    callbacks: ExportCallbacks,
  ): Promise<void> {
    const slot: JobSlot = { cancelRequested: false, state: "queued" };
    this.jobs.set(request.jobId, slot);
    const run = this.exportChain.then(() => this.runJob(request, callbacks, slot));
    this.exportChain = run.then(
      () => undefined,
      () => undefined,
    );
    // Deliberately NOT awaited: the contract is a prompt return; settlement
    // arrives exclusively through the callbacks.
    void run.catch(() => undefined);
  }

  async cancel(jobId: string): Promise<void> {
    const slot = this.jobs.get(jobId);
    if (!slot || slot.state === "settled") return;
    slot.cancelRequested = true;
    if (slot.state === "active" && this.activeRoute === "chromium-webcodecs") {
      // Route F checks the flag between frames; Route W needs the in-page abort.
      await this.providers.runtime.abortInPageExport();
    }
  }

  private async runJob(
    request: ExportVideoRequest,
    callbacks: ExportCallbacks,
    slot: JobSlot,
  ): Promise<void> {
    if (slot.cancelRequested) {
      slot.state = "settled";
      callbacks.onCancelled();
      return;
    }
    slot.state = "active";
    callbacks.onRunning();
    try {
      const route = await this.providers.exportRoute();
      if (route === "unavailable") {
        throw new Error("no export route available in this runtime");
      }
      this.activeRoute = route;
      // Watchdog: a wedged page/encoder must never freeze the job (or, via
      // the shared page, the whole session) forever. On fire we abort the
      // in-page export, recycle the browser, and settle as an error.
      const watchdogMs = this.providers.watchdogMs;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const watchdogFired = new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(() => {
          reject(new ExportWatchdogError(`export exceeded the ${watchdogMs}ms watchdog`));
        }, watchdogMs);
      });
      try {
        const work =
          route === "chromium-webcodecs"
            ? this.runWebcodecsRoute(request, callbacks, slot)
            : this.runFramesFfmpegRoute(request, callbacks, slot);
        await Promise.race([work, watchdogFired]);
      } finally {
        if (watchdog) clearTimeout(watchdog);
      }
    } catch (error) {
      slot.state = "settled";
      this.activeRoute = null;
      if (error instanceof ExportWatchdogError) {
        await this.providers.runtime.abortInPageExport().catch(() => undefined);
        await this.providers.runtime.close().catch(() => undefined);
        callbacks.onError({ code: "JOB_FAILED", message: error.message });
      } else if (slot.cancelRequested) {
        callbacks.onCancelled();
      } else {
        callbacks.onError({
          code: "JOB_FAILED",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    slot.state = "settled";
    this.activeRoute = null;
  }

  /* --------------------------- Route W --------------------------- */

  private async runWebcodecsRoute(
    request: ExportVideoRequest,
    callbacks: ExportCallbacks,
    slot: JobSlot,
  ): Promise<void> {
    const finalPath = join(request.jobDir, "output.mp4");
    const writer = await PartFileWriter.open(finalPath);
    let outcome;
    try {
      outcome = await this.providers.runtime.exportWebcodecsStreaming(
        request.project,
        request.mediaFiles,
        request.settings,
        writer,
        (event) => {
          if (slot.cancelRequested) return;
          callbacks.onProgress({
            phase: event.phase,
            percent: event.progress,
            currentFrame: event.currentFrame,
            totalFrames: event.totalFrames,
            bytesWritten: event.bytesWritten,
          });
        },
      );
    } catch (error) {
      await writer.discard().catch(() => undefined);
      throw error;
    }
    if (!outcome.success) {
      await writer.discard().catch(() => undefined);
      if (slot.cancelRequested || outcome.errorCode === "CANCELLED") {
        slot.state = "settled";
        this.activeRoute = null;
        callbacks.onCancelled();
        return;
      }
      throw new Error(
        `in-page export failed (${outcome.errorCode ?? "unknown"}): ${outcome.errorMessage ?? "no message"}`,
      );
    }
    if (slot.cancelRequested) {
      // Finished encoding but a cancel landed first: the result is discarded,
      // never published — the job is cancelled, not done.
      await writer.discard().catch(() => undefined);
      slot.state = "settled";
      this.activeRoute = null;
      callbacks.onCancelled();
      return;
    }
    const sizeBytes = writer.bytes;
    callbacks.onDone({
      path: finalPath,
      sizeBytes,
      route: "chromium-webcodecs",
      framesEncoded: outcome.framesRendered ?? 0,
    });
  }

  /* --------------------------- Route F --------------------------- */

  private async runFramesFfmpegRoute(
    request: ExportVideoRequest,
    callbacks: ExportCallbacks,
    slot: JobSlot,
  ): Promise<void> {
    const binaries = await resolveFfmpegBinaries(this.providers.ffmpegConfig);
    if (!binaries) {
      throw new Error(
        "frames→ffmpeg route selected but no ffmpeg binary is available",
      );
    }
    const { width, height, frameRate } = request.settings;
    const durationSec = timelineDurationSec(request.project);
    const totalFrames = Math.ceil(durationSec * frameRate);
    if (totalFrames <= 0) {
      throw new Error("timeline duration is zero — nothing to export");
    }

    const partPath = join(request.jobDir, "output.mp4.part");
    const finalPath = join(request.jobDir, "output.mp4");
    await rm(partPath, { force: true });

    const encoder = startFramesEncoder(binaries.ffmpeg, {
      width,
      height,
      frameRate,
      destPath: partPath,
    });

    let framesFed = 0;
    try {
      await this.providers.runtime.withHydratedSession(
        request.project,
        request.mediaFiles,
        async (session) => {
          callbacks.onProgress({
            phase: "rendering",
            percent: 0,
            currentFrame: 0,
            totalFrames,
          });
          for (let frame = 0; frame < totalFrames; frame++) {
            if (slot.cancelRequested) {
              throw new FramesJobCancelled();
            }
            const png = await session.renderPng(
              frame / frameRate,
              width,
              height,
            );
            if (png.length === 0) {
              throw new Error(`frame ${frame} rendered to an empty PNG`);
            }
            await encoder.writeFrame(png);
            framesFed += 1;
            callbacks.onProgress({
              phase: "rendering",
              percent: (frame + 1) / totalFrames,
              currentFrame: frame + 1,
              totalFrames,
              bytesWritten: undefined,
            });
          }
        },
      );
      if (slot.cancelRequested) throw new FramesJobCancelled();
      callbacks.onProgress({
        phase: "muxing",
        percent: 0.98,
        currentFrame: totalFrames,
        totalFrames,
      });
      const sizeBytes = await encoder.finish();
      if (sizeBytes === 0) {
        throw new Error("ffmpeg produced an empty MP4");
      }
      // A cancel landing during finish()/faststart must not publish the file:
      // mirror the Route-W post-completion check (see runWebcodecsRoute).
      if (slot.cancelRequested) throw new FramesJobCancelled();
      await rename(partPath, finalPath);
      callbacks.onDone({
        path: finalPath,
        sizeBytes,
        route: "chromium-frames-ffmpeg",
        framesEncoded: framesFed,
      });
    } catch (error) {
      encoder.abort();
      await rm(partPath, { force: true }).catch(() => undefined);
      await rm(finalPath, { force: true }).catch(() => undefined);
      if (error instanceof FramesJobCancelled) {
        slot.state = "settled";
        this.activeRoute = null;
        callbacks.onCancelled();
        return;
      }
      throw error;
    }
  }
}

class FramesJobCancelled extends Error {
  constructor() {
    super("job cancelled");
    this.name = "FramesJobCancelled";
  }
}

class ExportWatchdogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportWatchdogError";
  }
}

/* ------------------------------------------------------------------ */
/* Pool: one browser + one probe, shared by all providers              */
/* ------------------------------------------------------------------ */

export class ChromiumProviderPool {
  readonly runtime: ChromiumRuntime;
  readonly ffmpegConfig: FfmpegConfig;
  /** Export watchdog: hard ceiling for one export (default 10 min). */
  readonly watchdogMs: number;
  private readonly config: ChromiumProvidersConfig;
  private probePromise: Promise<RuntimeProbeResult> | null = null;

  constructor(config: ChromiumProvidersConfig = {}) {
    this.config = config;
    this.watchdogMs = config.exportWatchdogMs ?? 600_000;
    this.ffmpegConfig = {
      ...(config.ffmpegPath ? { ffmpegPath: config.ffmpegPath } : {}),
      ...(config.ffprobePath ? { ffprobePath: config.ffprobePath } : {}),
    };
    this.runtime = new ChromiumRuntime({
      ...(config.executablePath ? { executablePath: config.executablePath } : {}),
      headless: config.headless ?? true,
    });
  }

  /** The probe runs once per pool and is shared by every preflight. */
  probe(): Promise<RuntimeProbeResult> {
    this.probePromise ??= runChromiumRuntimeProbe({
      ...(this.config.executablePath
        ? { executablePath: this.config.executablePath }
        : {}),
      headless: this.config.headless ?? true,
      ...(this.config.probeSampleMediaPath
        ? { sampleMediaPath: this.config.probeSampleMediaPath }
        : {}),
      ffmpeg: this.ffmpegConfig,
    });
    return this.probePromise;
  }

  /**
   * The effective export route: probe-derived, unless the config pins one —
   * a pinned route is honored ONLY when its own prerequisites really hold
   * (a forced frames route still needs ffmpeg; a forced webcodecs route
   * still needs H.264 encode). Otherwise "unavailable".
   */
  async exportRoute(): Promise<"chromium-webcodecs" | "chromium-frames-ffmpeg" | "unavailable"> {
    const probe = await this.probe();
    const forced = this.config.forceExportRoute;
    if (!forced) return probe.summary.exportRoute;
    if (!probe.summary.renderAvailable) return "unavailable";
    if (forced === "chromium-webcodecs") {
      return probe.summary.h264EncodeAvailable ? forced : "unavailable";
    }
    const ffmpeg = await resolveFfmpegBinaries(this.ffmpegConfig);
    return ffmpeg ? forced : "unavailable";
  }

  async close(): Promise<void> {
    await this.runtime.close();
  }
}

export interface ChromiumProviders {
  readonly renderProvider: ChromiumRenderProvider;
  readonly exportProvider: ChromiumExportProvider;
  readonly pool: ChromiumProviderPool;
  /** Convenience: the shared probe result. */
  probe(): Promise<RuntimeProbeResult>;
  close(): Promise<void>;
}

/**
 * Wire the Chromium runtime into facade provider interfaces. The returned
 * providers are independent: injecting only the render provider into a
 * facade session flips ONLY the preview capability.
 */
export function createChromiumProviders(
  config: ChromiumProvidersConfig = {},
): ChromiumProviders {
  const pool = new ChromiumProviderPool(config);
  return {
    renderProvider: new ChromiumRenderProvider(pool),
    exportProvider: new ChromiumExportProvider(pool),
    pool,
    probe: () => pool.probe(),
    close: () => pool.close(),
  };
}
