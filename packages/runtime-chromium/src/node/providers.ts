/**
 * Facade provider implementations over the Chromium runtime.
 *
 * - ChromiumRenderProvider: preview.render_frame backing (hydrate → render →
 *   PNG under artifactRoot).
 * - ChromiumExportProvider: export.start backing. Route W reuses the existing
 *   ExportEngine/WebCodecsBackend inside Chromium with chunks streamed to
 *   disk; Route F (video-only, EXPLICIT OPT-IN ONLY via forceExportRoute —
 *   it drops audio, so the default export capability never selects it)
 *   streams the SAME rendered frames into system ffmpeg/libx264. Both yield
 *   a real H.264 MP4; a WebM is never passed off as success. Jobs are
 *   serialized: the second job stays "queued" until the page is free.
 *   Cancellation is cooperative and always settles the job.
 * - Availability comes from a live probe OF THE POOL'S OWN RUNTIME (the
 *   browser that would carry the job), keyed on the runtime generation — a
 *   crashed/recycled browser re-probes instead of serving a stale success,
 *   and a working renderer never implies a working exporter.
 */
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Project } from "@reelterminal/core/types/project";
import type {
  ExportCallbacks,
  ExportProgressEvent,
  ExportProvider,
  ExportVideoRequest,
  ProviderPreflight,
  RenderFrameRequest,
  RenderedFrameInfo,
  RenderContactSheetRequest,
  RenderedContactSheetInfo,
  RenderedHtmlPngInfo,
  RenderHtmlPngRequest,
  RenderProvider,
} from "@reelterminal/agent-facade";

import {
  resolveFfmpegBinaries,
  startFramesEncoder,
  type FfmpegConfig,
} from "./ffmpeg";
import {
  probeWithRuntime,
  type RuntimeProbeResult,
} from "./probe";
import { renderHtmlPng as renderHtmlPngOnRuntime } from "./html-render";
import { ChromiumRuntime, HydratedSessionCancelled, PartFileWriter } from "./runtime";
import {
  beginExportPerformanceSpan,
  endExportPerformanceSpan,
  markExportPerformance,
  withExportPerformanceSpan,
  type ExportPerformanceSink,
} from "./export-performance";

export interface ChromiumProvidersConfig {
  /** Explicit chromium executable; defaults to the Playwright-managed one. */
  readonly executablePath?: string;
  readonly headless?: boolean;
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
  /** Optional sample for the probe's real decode smoke. */
  readonly probeSampleMediaPath?: string;
  /**
   * Explicitly pin the export route instead of deriving it from the probe.
   * `chromium-frames-ffmpeg` is a VIDEO-ONLY experiment (no audio track) —
   * pinning it is the ONLY way to get it; the probe-derived default route is
   * always `chromium-webcodecs` or unavailable. A pinned route is still
   * validated against its prerequisites (frames route needs ffmpeg;
   * webcodecs route needs H.264 encode + ExportEngine init) — it can make a
   * capable machine exercise the experiment, never an incapable one lie.
   */
  readonly forceExportRoute?: "chromium-webcodecs" | "chromium-frames-ffmpeg";
  /**
   * No-progress ceiling for one export job: every progress event re-arms it,
   * so a job that keeps producing frames is never killed for being slow —
   * only a genuinely wedged page/encoder is. Default 600_000 (10 min).
   */
  readonly exportWatchdogMs?: number;
  /**
   * Total wall-clock ceiling for one export job regardless of progress;
   * 0 disables it. Default 3_600_000 (1 h).
   */
  readonly exportTotalBudgetMs?: number;
  /**
   * Hard ceiling for ONE probe/hydrate/render page evaluate (default
   * 120_000). Raise it for very large media sets whose hydrate legitimately
   * exceeds two minutes.
   */
  readonly pageOpTimeoutMs?: number;
  /** Optional explicit adapter for production export captures (for example the active main PerfSink). */
  readonly exportPerformanceSinkFactory?: (jobId: string) => ExportPerformanceSink | undefined;
}

/** Files an export job may write into its job dir (swept on non-done ends). */
const EXPORT_JOB_FILES = ["output.mp4", "output.mp4.part", "output.part"] as const;

const VISUAL_MAX_SAMPLES = 12;
const VISUAL_MAX_CELL_DIMENSION = 1024;
const VISUAL_MAX_FRAME_PIXELS = 1_048_576;
const VISUAL_MAX_CONTACT_SHEET_PIXELS = 24_000_000;
const VISUAL_MAX_PNG_BYTES = 8 * 1024 * 1024;

/**
 * Best-effort removal of everything an export could have left behind. Runs
 * before ANY error/cancelled terminalization so a non-done job never leaves
 * a success-looking (or partial) file in its job dir.
 */
async function sweepExportJobDir(jobDir: string, callbacks?: ExportCallbacks): Promise<void> {
  const trackedIds: Readonly<Record<string, string>> = {
    "output.mp4": "export-output",
    "output.mp4.part": "export-output-part",
  };
  await Promise.all(EXPORT_JOB_FILES.map(async (name) => {
    try {
      await rm(join(jobDir, name), { force: true });
      const fileId = trackedIds[name];
      if (fileId) callbacks?.onArtifactFileRemoved?.(fileId);
    } catch {
      // A failed removal stays registered for task review.
    }
  }));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/**
 * Exactly-once terminal wrapper for an export job's callbacks: the first of
 * onDone/onError/onCancelled wins, later terminal calls (and any
 * progress/running signals after terminal) are dropped. This is the
 * provider-side belt to the structural suspenders: routes in
 * ChromiumExportProvider RETURN their outcome and let runJob terminalize, so
 * a wedged job interrupted by the watchdog can never emit a second terminal
 * callback when its route finally unwinds.
 */
export function guardExportCallbacks(
  callbacks: ExportCallbacks,
): ExportCallbacks & { readonly terminal: "done" | "error" | "cancelled" | null } {
  let terminal: "done" | "error" | "cancelled" | null = null;
  return {
    get terminal() {
      return terminal;
    },
    onRunning: () => {
      if (terminal) return;
      callbacks.onRunning();
    },
    onProgress: (event: ExportProgressEvent) => {
      if (terminal) return;
      callbacks.onProgress(event);
    },
    onDone: (completion) => {
      if (terminal) return;
      terminal = "done";
      callbacks.onDone(completion);
    },
    onError: (error) => {
      if (terminal) return;
      terminal = "error";
      callbacks.onError(error);
    },
    onCancelled: () => {
      if (terminal) return;
      terminal = "cancelled";
      callbacks.onCancelled();
    },
    ...(callbacks.onArtifactFile ? { onArtifactFile: (file: Parameters<NonNullable<ExportCallbacks["onArtifactFile"]>>[0]) => callbacks.onArtifactFile!(file) } : {}),
    ...(callbacks.onArtifactFileRemoved ? { onArtifactFileRemoved: (fileId: string) => callbacks.onArtifactFileRemoved!(fileId) } : {}),
  };
}

interface JobSlot {
  cancelRequested: boolean;
  watchdogTimedOut: boolean;
  state: "queued" | "active" | "settled";
  readonly performanceSink?: ExportPerformanceSink;
  /**
   * Route-specific hard stop for the currently running work (in-page abort
   * for Route W, ffmpeg kill for Route F). Set by the route while it runs;
   * the watchdog and cancel() invoke it.
   */
  abortActive?: () => void | Promise<void>;
}

/** How a route ended; runJob turns this into THE terminal callback. */
type RouteOutcome =
  | { readonly kind: "done"; readonly completion: {
      readonly path: string;
      readonly sizeBytes: number;
      readonly route: "chromium-webcodecs" | "chromium-frames-ffmpeg";
      readonly framesEncoded: number;
      readonly upscalingRequestedButInactive?: boolean;
    } }
  | { readonly kind: "cancelled" };

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
      // A wait-timeout means the runtime is BUSY (or wedged), not broken —
      // say so instead of crying launch failure.
      const busy = probe.launchError.includes("could not start within");
      return {
        available: false,
        reason: busy
          ? `runtime busy or wedged (probe waited ${POOL_PROBE_WAIT_TIMEOUT_MS / 1000}s): ${probe.launchError}`
          : `Chromium failed to launch: ${probe.launchError}`,
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

  readonly supportsRegion = true;

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
      request.region,
    );
    if (png.length === 0) {
      throw new Error("Chromium returned an empty PNG frame");
    }
    await writeFile(request.destPath, png);
    return { bytesWritten: png.length };
  }

  async renderContactSheetPng(
    request: RenderContactSheetRequest,
  ): Promise<RenderedContactSheetInfo> {
    const probe = await this.providers.probe();
    if (!probe.summary.renderAvailable) {
      throw new Error("render provider preflight failed — refusing to render contact sheet");
    }
    if (request.samples.length < 1 || request.samples.length > VISUAL_MAX_SAMPLES) {
      throw new Error("contact sheet sample count must be in [1, 12]");
    }
    if (
      request.width < 2 ||
      request.height < 2 ||
      request.width > VISUAL_MAX_CELL_DIMENSION ||
      request.height > VISUAL_MAX_CELL_DIMENSION
    ) {
      throw new Error("contact sheet cell dimensions must be in [2, 1024]");
    }
    if (request.width * request.height > VISUAL_MAX_FRAME_PIXELS) {
      throw new Error("contact sheet frame dimensions exceed the 1-megapixel runtime budget");
    }
    if (request.samples.length * request.width * request.height > VISUAL_MAX_CONTACT_SHEET_PIXELS) {
      throw new Error("contact sheet frame pixels exceed the 24-megapixel runtime budget");
    }
    const columns = Math.min(4, request.samples.length);
    const rows = Math.ceil(request.samples.length / columns);
    const sheetPixels =
      (columns * (request.width + 8) + 8) * (rows * (request.height + 28) + 8);
    if (sheetPixels > VISUAL_MAX_CONTACT_SHEET_PIXELS) {
      throw new Error("contact sheet exceeds the 24-megapixel runtime budget");
    }
    const png = await this.providers.runtime.renderContactSheetPng(
      request.project,
      request.mediaFiles,
      request.samples,
      request.width,
      request.height,
    );
    if (png.length === 0) throw new Error("Chromium returned an empty contact sheet PNG");
    if (png.length > VISUAL_MAX_PNG_BYTES) {
      throw new Error("Chromium returned a contact sheet PNG over the 8 MiB artifact budget");
    }
    await writeFile(request.destPath, png);
    return { bytesWritten: png.length };
  }

  /**
   * Constrained HTML→PNG on a THROWAWAY incognito context of the pool's own
   * browser (javaScriptEnabled:false + route allowlist — see html-render.ts).
   * Availability is the same Chromium supply as preview.render_frame: the
   * pool probe gates it, and a crashed/recycled browser re-probes. The
   * hydrate page is never touched.
   */
  async renderHtmlPng(request: RenderHtmlPngRequest): Promise<RenderedHtmlPngInfo> {
    const probe = await this.providers.probe();
    if (!probe.summary.renderAvailable) {
      throw new Error("render provider preflight failed — refusing to render HTML");
    }
    return renderHtmlPngOnRuntime(this.providers.runtime, request);
  }
}

export class ChromiumExportProvider implements ExportProvider {
  readonly id = "chromium-export";
  private readonly providers: ChromiumProviderPool;
  private exportChain: Promise<unknown> = Promise.resolve();
  private readonly jobs = new Map<string, JobSlot>();

  constructor(pool: ChromiumProviderPool) {
    this.providers = pool;
  }

  async preflight(): Promise<ProviderPreflight> {
    const route = await this.providers.exportRoute();
    const probe = await this.providers.probe();
    if (route === "unavailable") {
      const forced = this.providers.forcedRoute;
      return {
        available: false,
        reason:
          forced === "chromium-frames-ffmpeg"
            ? "the explicitly forced video-only frames→ffmpeg route is unavailable: no usable ffmpeg binary was found"
            : forced === "chromium-webcodecs"
              ? "the explicitly forced WebCodecs route is unavailable: this Chromium lacks H.264 encode or the ExportEngine failed to initialize"
              : probe.summary.exportUnavailableReason ??
                "no honest H.264 export route exists in this runtime",
        requires:
          forced !== null
            ? "the forced route's prerequisites (see forceExportRoute config)"
            : "Chromium with H.264 encode + a working ExportEngine (WebCodecs route)",
        details: {
          ...(forced !== null ? { forcedRoute: forced } : {}),
          h264EncodeAvailable: probe.summary.h264EncodeAvailable,
          exportEngineInit: probe.page.exportEngineInit,
          ffmpegAvailable: probe.ffmpeg.available,
          videoOnlyFramesRouteAvailable:
            probe.summary.videoOnlyFramesRouteAvailable,
        },
      };
    }
    return {
      available: true,
      details: {
        route,
        chromium: probe.chromium.version,
        ffmpeg: probe.ffmpeg.available ? probe.ffmpeg.ffmpegPath : null,
        ...(route === "chromium-frames-ffmpeg"
          ? {
              // Honesty: the frames route produces NO audio track. It only
              // ever runs when explicitly forced, and says so every time.
              videoOnly: true,
              audio: "none",
              experimental: true,
              note: "explicitly forced video-only export (forceExportRoute): the output MP4 has no audio track",
            }
          : {}),
      },
    };
  }

  /** Returns promptly; the job settles exactly once via the callbacks. */
  async startExport(
    request: ExportVideoRequest,
    callbacks: ExportCallbacks,
    performanceSink?: ExportPerformanceSink,
  ): Promise<void> {
    let exportSink = performanceSink;
    if (!exportSink) {
      try {
        exportSink = this.providers.exportPerformanceSinkForJob(request.jobId);
      } catch {
        // A collector factory is observational and cannot veto an export.
      }
    }
    const slot: JobSlot = { cancelRequested: false, watchdogTimedOut: false, state: "queued", performanceSink: exportSink };
    const submitSpan = beginExportPerformanceSpan(exportSink, "submit");
    const queueSpan = beginExportPerformanceSpan(exportSink, "queue");
    this.jobs.set(request.jobId, slot);
    const run = this.exportChain.then(() => {
      endExportPerformanceSpan(exportSink, queueSpan, "ok");
      return this.runJob(request, callbacks, slot);
    });
    this.exportChain = run.then(
      () => undefined,
      () => undefined,
    );
    endExportPerformanceSpan(exportSink, submitSpan, "ok");
    // Deliberately NOT awaited: the contract is a prompt return; settlement
    // arrives exclusively through the callbacks.
    void run.catch(() => undefined);
  }

  async cancel(jobId: string): Promise<void> {
    const slot = this.jobs.get(jobId);
    if (!slot || slot.state === "settled") return;
    slot.cancelRequested = true;
    markExportPerformance(slot.performanceSink, "cancel");
    if (slot.state === "active") {
      // Route F checks the flag between frames; Route W needs the in-page
      // abort to leave the encode loop promptly.
      await slot.abortActive?.();
    }
  }

  /**
   * THE single place a job terminalizes. Routes return a RouteOutcome (or
   * throw); this method — and only this method — converts that into the one
   * terminal callback the contract allows, behind a settle-once guard.
   */
  private async runJob(
    request: ExportVideoRequest,
    callbacks: ExportCallbacks,
    slot: JobSlot,
  ): Promise<void> {
    const performanceSink = slot.performanceSink;
    // Watchdog: a WEDGED page/encoder must never freeze the job (or, via
    // the shared page, the whole session) forever — but a job that keeps
    // producing frames is slow, not wedged. Two ceilings: the no-progress
    // watchdog re-arms on every progress/running event; the total budget
    // bounds the whole job regardless of progress (0 disables it).
    const watchdogMs = this.providers.exportWatchdogMs;
    const totalBudgetMs = this.providers.exportTotalBudgetMs;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let budget: ReturnType<typeof setTimeout> | undefined;
    let fireWatchdog!: (error: ExportWatchdogError) => void;
    const watchdogFired = new Promise<never>((_resolve, reject) => {
      fireWatchdog = reject;
    });
    // The onRunning wrapper can arm (and fire) the ceiling before the race
    // below attaches its handler; this no-op keeps an early rejection from
    // surfacing as an unhandled rejection. The race still sees it.
    void watchdogFired.catch(() => undefined);
    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        fireWatchdog(
          new ExportWatchdogError(
            `export exceeded the ${watchdogMs}ms no-progress watchdog`,
          ),
        );
      }, watchdogMs);
    };
    // Progress re-arms the no-progress ceiling; the budget clock is
    // unaffected. Wrapped BEFORE the terminal guard so renewal cannot be
    // suppressed by it.
    const measuredCallbacks: ExportCallbacks = {
      onRunning: callbacks.onRunning,
      onProgress: (event) => {
        armWatchdog();
        callbacks.onProgress(event);
      },
      onDone: callbacks.onDone,
      onError: callbacks.onError,
      onCancelled: callbacks.onCancelled,
      ...(callbacks.onArtifactFile ? { onArtifactFile: callbacks.onArtifactFile } : {}),
      ...(callbacks.onArtifactFileRemoved ? { onArtifactFileRemoved: callbacks.onArtifactFileRemoved } : {}),
    };
    const progressAwareCallbacks: ExportCallbacks = {
      ...measuredCallbacks,
      onRunning: () => {
        armWatchdog();
        measuredCallbacks.onRunning();
      },
    };
    const guarded = guardExportCallbacks(progressAwareCallbacks);
    try {
      if (slot.cancelRequested) {
        await sweepExportJobDir(request.jobDir, guarded);
        guarded.onCancelled();
        return;
      }
      slot.state = "active";
      guarded.onRunning();

      const route = await withExportPerformanceSpan(performanceSink, "prepare", () => this.providers.exportRoute());
      if (route === "unavailable") {
        throw new Error("no export route available in this runtime");
      }

      armWatchdog();
      if (totalBudgetMs > 0) {
        budget = setTimeout(() => {
          fireWatchdog(
            new ExportWatchdogError(
              `export exceeded the ${totalBudgetMs}ms total budget`,
            ),
          );
        }, totalBudgetMs);
      }
      const work: Promise<RouteOutcome> =
        route === "chromium-webcodecs"
          ? this.runWebcodecsRoute(request, guarded, slot)
          : this.runFramesFfmpegRoute(request, guarded, slot);
      // A route that settles LATE — after a grace-expired watchdog already
      // terminalized the job — must never leave files behind either. Only
      // sweep when terminalization ALREADY happened (terminal !== null):
      // when this handler beats runJob's own continuation, the job is not
      // terminal yet and runJob's normal paths do the sweeping.
      void work.catch(() => undefined).then(() => {
        if (guarded.terminal !== null && guarded.terminal !== "done") {
          void sweepExportJobDir(request.jobDir, guarded);
        }
      });
      let outcome: RouteOutcome;
      try {
        outcome = await Promise.race([work, watchdogFired]);
      } catch (error) {
        if (!(error instanceof ExportWatchdogError)) throw error;
        // Watchdog fired. Order matters: REALLY stop the underlying work,
        // let its own cleanup run, sweep whatever is left, and only then
        // terminalize (as error — a timeout is never "cancelled").
        slot.watchdogTimedOut = true;
        slot.cancelRequested = true; // route loops bail at the next check
        const stopAndUnwind = (async () => {
          // The in-page abort can itself sit on a wedged evaluate; bound it
          // so the browser kill below — the thing that actually breaks a
          // wedged page — always gets to run.
          try {
            await Promise.race([
              slot.abortActive?.() ?? Promise.resolve(),
              delay(ABORT_STOP_GRACE_MS),
            ]);
          } catch {
            /* best effort */
          }
          slot.abortActive = undefined;
          // Killing the browser breaks any wedged page evaluate; the pool
          // stays usable — the next operation launches a fresh browser.
          await this.providers.runtime.recycle().catch(() => undefined);
          // Give the route's own cleanup (writer.discard / encoder.abort +
          // rm) the chance to finish before we terminalize.
          await work.catch(() => undefined);
        })();
        await Promise.race([
          stopAndUnwind,
          delay(WATCHDOG_CLEANUP_GRACE_MS),
        ]);
        slot.state = "settled";
        if (guarded.terminal !== "done") {
          await sweepExportJobDir(request.jobDir, guarded);
        }
        guarded.onError({ code: "JOB_FAILED", message: error.message });
        return;
      }

      slot.state = "settled";
      if (outcome.kind === "done") {
        guarded.onDone(outcome.completion);
      } else {
        await sweepExportJobDir(request.jobDir, guarded);
        guarded.onCancelled();
      }
      return;
    } catch (error) {
      slot.state = "settled";
      // Error or cancel: nothing success-looking may survive. (Never sweep
      // after a done terminal — the artifact has been published already.)
      if (guarded.terminal !== "done") {
        await sweepExportJobDir(request.jobDir, guarded);
      }
      if (slot.cancelRequested) {
        guarded.onCancelled();
      } else {
        guarded.onError({
          code: "JOB_FAILED",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    } finally {
      if (watchdog) clearTimeout(watchdog);
      if (budget) clearTimeout(budget);
      slot.state = "settled";
      // The job is terminal (done, cancelled, error, or watchdog) via every
      // path above: drop its slot so the jobs map cannot grow unboundedly
      // across exports. cancel() on a missing/settled slot is already a no-op.
      this.jobs.delete(request.jobId);
    }
  }

  /* --------------------------- Route W --------------------------- */

  /**
   * The upscaling pass is honest, never silent: the in-page engine skips it
   * when there is no WebGPU device (or the export is not an enlargement),
   * so a REQUESTED pass that cannot run is disclosed on the completion and
   * surfaces on job.status — the artifact is valid, just not upscaled.
   */
  private async resolveUpscalingInactive(
    request: ExportVideoRequest,
  ): Promise<boolean> {
    const requested = request.settings.upscaling?.enabled === true;
    if (!requested) return false;
    const enlarging =
      request.settings.width > request.project.settings.width ||
      request.settings.height > request.project.settings.height;
    if (!enlarging) return true;
    const probe = await this.providers.probe();
    return probe.summary.webgpuAdapter !== true;
  }

  private async runWebcodecsRoute(
    request: ExportVideoRequest,
    callbacks: ExportCallbacks,
    slot: JobSlot,
  ): Promise<RouteOutcome> {
    const finalPath = join(request.jobDir, "output.mp4");
    callbacks.onArtifactFile?.({ fileId: "export-output", path: finalPath, kind: "work", purpose: "Encoded video export", rebuildable: true, deliveryStatus: "pending" });
    callbacks.onArtifactFile?.({ fileId: "export-output-part", path: `${finalPath}.part`, kind: "work", purpose: "Partial video export", rebuildable: true, deliveryStatus: "pending" });
    const writer = await withExportPerformanceSpan(slot.performanceSink, "prepare", () => PartFileWriter.open(finalPath, slot.performanceSink));
    if (slot.cancelRequested) {
      // Cancelled (or watchdog-stopped) before any page work began — no
      // zombie export behind an already-terminal job.
      await writer.discard().catch(() => undefined);
      return { kind: "cancelled" };
    }
    slot.abortActive = () => this.providers.runtime.abortInPageExport();
    let outcome;
    try {
      outcome = await this.providers.runtime.exportWebcodecsStreaming(
        request.project,
        request.mediaFiles,
        request.settings.upscaling !== undefined
          ? { ...request.settings, upscaling: request.settings.upscaling }
          : request.settings,
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
        {
          cancelCheck: () => slot.cancelRequested,
          timeoutCheck: () => slot.watchdogTimedOut,
          performanceSink: slot.performanceSink,
        },
      );
    } catch (error) {
      await writer.discard().catch(() => undefined);
      if (error instanceof HydratedSessionCancelled) {
        return { kind: "cancelled" };
      }
      throw error;
    } finally {
      slot.abortActive = undefined;
    }
    if (!outcome.success) {
      await writer.discard().catch(() => undefined);
      if (slot.cancelRequested || outcome.errorCode === "CANCELLED") {
        return { kind: "cancelled" };
      }
      throw new Error(
        `in-page export failed (${outcome.errorCode ?? "unknown"}): ${outcome.errorMessage ?? "no message"}`,
      );
    }
    callbacks.onArtifactFileRemoved?.("export-output-part");
    if (slot.cancelRequested) {
      // Finished encoding but a cancel landed first: the result is discarded,
      // never published — the job is cancelled, not done.
      await writer.discard().catch(() => undefined);
      return { kind: "cancelled" };
    }
    const upscalingRequestedButInactive =
      await this.resolveUpscalingInactive(request);
    return {
      kind: "done",
      completion: {
        path: finalPath,
        sizeBytes: writer.bytes,
        route: "chromium-webcodecs",
        framesEncoded: outcome.framesRendered ?? 0,
        ...(upscalingRequestedButInactive ? { upscalingRequestedButInactive } : {}),
      },
    };
  }

  /* --------------------------- Route F --------------------------- */

  private async runFramesFfmpegRoute(
    request: ExportVideoRequest,
    callbacks: ExportCallbacks,
    slot: JobSlot,
  ): Promise<RouteOutcome> {
    const binaries = await withExportPerformanceSpan(slot.performanceSink, "prepare", () => resolveFfmpegBinaries(this.providers.ffmpegConfig));
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
    callbacks.onArtifactFile?.({ fileId: "export-output", path: finalPath, kind: "work", purpose: "Encoded video export", rebuildable: true, deliveryStatus: "pending" });
    callbacks.onArtifactFile?.({ fileId: "export-output-part", path: partPath, kind: "work", purpose: "Partial video export", rebuildable: true, deliveryStatus: "pending" });
    await rm(partPath, { force: true });

    const encoder = startFramesEncoder(binaries.ffmpeg, {
      width,
      height,
      frameRate,
      destPath: partPath,
    });
    const encodeSpan = beginExportPerformanceSpan(slot.performanceSink, "encode");
    slot.abortActive = () => encoder.abort();

    let framesFed = 0;
    try {
      if (slot.cancelRequested) throw new FramesJobCancelled();
      await this.providers.runtime.withHydratedSession(
        request.project,
        request.mediaFiles,
        async (session) => {
          const emitProgress = (event: ExportProgressEvent): void => {
            markExportPerformance(slot.performanceSink, "progress", {
              progress: event.percent,
              ...(event.currentFrame !== undefined ? { currentFrame: event.currentFrame } : {}),
              ...(event.totalFrames !== undefined ? { totalFrames: event.totalFrames } : {}),
              bytesWritten: event.bytesWritten ?? 0,
            });
            callbacks.onProgress(event);
          };
          emitProgress({
            phase: "rendering",
            percent: 0,
            currentFrame: 0,
            totalFrames,
          });
          for (let frame = 0; frame < totalFrames; frame++) {
            if (slot.cancelRequested) {
              throw new FramesJobCancelled();
            }
            const png = await withExportPerformanceSpan(slot.performanceSink, "render", () => session.renderPng(
              frame / frameRate,
              width,
              height,
            ));
            if (png.length === 0) {
              throw new Error(`frame ${frame} rendered to an empty PNG`);
            }
            await withExportPerformanceSpan(slot.performanceSink, "write", () => encoder.writeFrame(png));
            framesFed += 1;
            emitProgress({
              phase: "rendering",
              percent: (frame + 1) / totalFrames,
              currentFrame: frame + 1,
              totalFrames,
              bytesWritten: undefined,
            });
          }
        },
        { cancelCheck: () => slot.cancelRequested },
      );
      if (slot.cancelRequested) throw new FramesJobCancelled();
      markExportPerformance(slot.performanceSink, "progress", {
        progress: 0.98,
        currentFrame: totalFrames,
        totalFrames,
      });
      callbacks.onProgress({
        phase: "muxing",
        percent: 0.98,
        currentFrame: totalFrames,
        totalFrames,
      });
      const sizeBytes = await withExportPerformanceSpan(slot.performanceSink, "finalize", () => encoder.finish());
      if (sizeBytes === 0) {
        throw new Error("ffmpeg produced an empty MP4");
      }
      // A cancel landing during finish()/faststart must not publish the file:
      // mirror the Route-W post-completion check (see runWebcodecsRoute).
      if (slot.cancelRequested) throw new FramesJobCancelled();
      await rename(partPath, finalPath);
      callbacks.onArtifactFileRemoved?.("export-output-part");
      endExportPerformanceSpan(slot.performanceSink, encodeSpan, "ok");
      // The frames route renders directly at the target size — its pipeline
      // has no upscale stage at all, so a REQUESTED pass is disclosed as
      // inactive instead of silently vanishing.
      const upscalingRequestedButInactive =
        await this.resolveUpscalingInactive(request);
      return {
        kind: "done",
        completion: {
          path: finalPath,
          sizeBytes,
          route: "chromium-frames-ffmpeg",
          framesEncoded: framesFed,
          ...(upscalingRequestedButInactive ? { upscalingRequestedButInactive } : {}),
        },
      };
    } catch (error) {
      encoder.abort();
      endExportPerformanceSpan(
        slot.performanceSink,
        encodeSpan,
        error instanceof FramesJobCancelled || error instanceof HydratedSessionCancelled ? "cancelled" : "error",
      );
      await rm(partPath, { force: true }).catch(() => undefined);
      await rm(finalPath, { force: true }).catch(() => undefined);
      if (
        error instanceof FramesJobCancelled ||
        error instanceof HydratedSessionCancelled
      ) {
        return { kind: "cancelled" };
      }
      throw error;
    } finally {
      slot.abortActive = undefined;
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

/**
 * Bounded wait for a route's own cleanup after the watchdog killed its work
 * (browser recycled / encoder aborted). Cleanup is local rm/discard — 30 s is
 * generous; past it we terminalize anyway rather than hang the job forever.
 */
const WATCHDOG_CLEANUP_GRACE_MS = 30_000;

/**
 * Bound on the route's own in-page abort during watchdog cleanup. The abort
 * can sit on the very evaluate that wedged the export; the browser recycle
 * that follows is what actually breaks it, so the abort must never be able
 * to starve the recycle.
 */
const ABORT_STOP_GRACE_MS = 5_000;

/**
 * Ceiling for a pool preflight probe WAITING on the shared page (e.g. behind
 * an active export). Preflights must answer in bounded time — a busy runtime
 * yields a transient unavailable-with-reason, never a 10-minute stall of the
 * caller (which, through the facade, is the serialized session lane).
 */
const POOL_PROBE_WAIT_TIMEOUT_MS = 30_000;

/* ------------------------------------------------------------------ */
/* Pool: one browser + generation-keyed probe, shared by all providers */
/* ------------------------------------------------------------------ */

export class ChromiumProviderPool {
  readonly runtime: ChromiumRuntime;
  readonly ffmpegConfig: FfmpegConfig;
  /**
   * Export watchdog: NO-PROGRESS ceiling for one export (default 10 min).
   * Re-armed by every progress event — steady frame production keeps a slow
   * job alive; only a wedged page/encoder trips it. Public and mutable so
   * tests can shrink it for one job and restore it after — the watchdog
   * must never be a way to brick the pool.
   */
  exportWatchdogMs: number;
  /**
   * Total wall-clock ceiling for one export regardless of progress
   * (default 1 h; 0 disables). Mutable for the same test reasons.
   */
  exportTotalBudgetMs: number;
  private readonly config: ChromiumProvidersConfig;
  private probeCache: { readonly generation: number; readonly result: RuntimeProbeResult } | null = null;
  private probeInFlight: Promise<RuntimeProbeResult> | null = null;

  constructor(config: ChromiumProvidersConfig = {}) {
    this.config = config;
    this.exportWatchdogMs = config.exportWatchdogMs ?? 600_000;
    this.exportTotalBudgetMs = config.exportTotalBudgetMs ?? 3_600_000;
    this.ffmpegConfig = {
      ...(config.ffmpegPath ? { ffmpegPath: config.ffmpegPath } : {}),
      ...(config.ffprobePath ? { ffprobePath: config.ffprobePath } : {}),
    };
    this.runtime = new ChromiumRuntime({
      ffmpegPath: config.ffmpegPath,
      ffprobePath: config.ffprobePath,
      ...(config.executablePath ? { executablePath: config.executablePath } : {}),
      headless: config.headless ?? true,
      ...(config.pageOpTimeoutMs !== undefined
        ? { pageOpTimeoutMs: config.pageOpTimeoutMs }
        : {}),
    });
  }

  exportPerformanceSinkForJob(jobId: string): ExportPerformanceSink | undefined {
    return this.config.exportPerformanceSinkFactory?.(jobId);
  }

  /** The explicitly pinned route, if any (null = probe-derived default). */
  get forcedRoute(): "chromium-webcodecs" | "chromium-frames-ffmpeg" | null {
    return this.config.forceExportRoute ?? null;
  }

  /**
   * Probe THE POOL'S OWN RUNTIME — the same Chromium that would carry
   * preview/export work — and cache the result only for that browser's
   * generation. A crash, recycle or failed launch invalidates the cache, so
   * a preflight can never serve a stale success produced by a long-dead
   * browser (or by a throwaway probe browser that no job would ever use).
   * Failed probes are not cached: the next call retries honestly.
   */
  probe(): Promise<RuntimeProbeResult> {
    const cached = this.probeCache;
    if (
      cached !== null &&
      cached.generation === this.runtime.generation &&
      this.runtime.isBrowserConnected
    ) {
      return Promise.resolve(cached.result);
    }
    this.probeInFlight ??= (async () => {
      const generationBefore = this.runtime.generation;
      try {
        const result = await probeWithRuntime(this.runtime, {
          ...(this.config.executablePath
            ? { executablePath: this.config.executablePath }
            : {}),
          headless: this.config.headless ?? true,
          ...(this.config.probeSampleMediaPath
            ? { sampleMediaPath: this.config.probeSampleMediaPath }
            : {}),
          ffmpeg: this.ffmpegConfig,
          waitTimeoutMs: POOL_PROBE_WAIT_TIMEOUT_MS,
        });
        // Cache only a successful probe whose browser is still the one we
        // measured (a recycle/crash mid-probe means these facts are stale).
        if (
          result.launchError === undefined &&
          generationBefore === this.runtime.generation
        ) {
          this.probeCache = { generation: generationBefore, result };
        } else {
          this.probeCache = null;
        }
        return result;
      } finally {
        this.probeInFlight = null;
      }
    })();
    return this.probeInFlight;
  }

  /**
   * The effective export route: probe-derived by default — and the probe
   * NEVER derives the video-only frames route (that would silently drop
   * audio). `chromium-frames-ffmpeg` exists only when explicitly forced via
   * config, and even then ONLY when its own prerequisite (a real ffmpeg
   * binary) holds; a forced webcodecs route likewise still requires H.264
   * encode + ExportEngine init. Otherwise "unavailable".
   */
  async exportRoute(): Promise<"chromium-webcodecs" | "chromium-frames-ffmpeg" | "unavailable"> {
    const probe = await this.probe();
    const forced = this.config.forceExportRoute;
    if (!forced) return probe.summary.exportRoute;
    if (!probe.summary.renderAvailable) return "unavailable";
    if (forced === "chromium-webcodecs") {
      return probe.summary.exportRoute === "chromium-webcodecs"
        ? forced
        : "unavailable";
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
