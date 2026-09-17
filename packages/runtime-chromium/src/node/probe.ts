/**
 * Repeatable Chromium runtime probe (ADR 0002 #3).
 *
 * Records machine-readable facts about every primitive Slice 1b depends on —
 * OffscreenCanvas (+ PNG encode smoke), VideoDecoder per codec, VideoEncoder
 * per codec × hardware preference, AudioEncoder AAC, mediabunny loadability,
 * ExportEngine initialization, the exact `getFirstEncodableVideoCodec(["avc"])`
 * check the export path uses, and an optional real decode smoke against a
 * sample file — plus ffmpeg availability on the host.
 *
 * `probeWithRuntime` runs the probe ON a caller-supplied runtime, so provider
 * preflights measure the very browser that would carry the job — never a
 * throwaway probe browser whose success could be cached forever.
 * `runChromiumRuntimeProbe` remains the standalone evidence entry point: it
 * launches a temporary runtime, probes it, and closes it.
 *
 * The probe is the ONLY source of capability claims: providers derive
 * availability from its facts, never from static assumptions.
 */
import { resolveFfmpegBinaries, type FfmpegConfig } from "./ffmpeg";
import {
  ChromiumRuntime,
  type PageProbeFacts,
} from "./runtime";

export interface RuntimeProbeResult {
  readonly probeVersion: 1;
  readonly timestamp: string;
  readonly durationMs: number;
  readonly host: {
    readonly platform: string;
    readonly arch: string;
    readonly node: string;
  };
  readonly chromium: {
    readonly executablePath: string | null;
    readonly version: string;
    readonly userAgent: string;
    readonly headless: boolean;
  };
  readonly page: PageProbeFacts;
  readonly ffmpeg: {
    readonly available: boolean;
    readonly ffmpegPath?: string;
    readonly ffprobePath?: string;
    readonly version?: string;
  };
  readonly summary: {
    readonly renderAvailable: boolean;
    readonly h264DecodeAvailable: boolean;
    readonly h264EncodeAvailable: boolean;
    /**
     * The DEFAULT export route. `chromium-frames-ffmpeg` is deliberately NOT
     * derivable here: that route drops audio (video-only), so it exists only
     * as an explicit opt-in (`forceExportRoute`) for tests/experiments and is
     * never selected silently. Its prerequisites are reported separately via
     * `videoOnlyFramesRouteAvailable`.
     */
    readonly exportRoute: "chromium-webcodecs" | "unavailable";
    readonly exportUnavailableReason?: string;
    /**
     * Fact: the video-only frames→ffmpeg path COULD run here (render path
     * works and ffmpeg is present). Availability of the experiment, not a
     * capability claim — the default export capability never uses it.
     */
    readonly videoOnlyFramesRouteAvailable: boolean;
    /**
     * Real WebGPU adapter fact from the probed page (the same navigator.gpu
     * request the export upscaling pass needs). false = a real adapter
     * request returned null; null = undecidable (probe error or older entry
     * build) — treat null as "unknown", never as available.
     */
    readonly webgpuAdapter: boolean | null;
  };
  readonly launchError?: string;
}

export interface ProbeOptions {
  readonly executablePath?: string;
  readonly headless?: boolean;
  /** Sample video for the real in-page decode smoke (e.g. an h264 MP4). */
  readonly sampleMediaPath?: string;
  readonly ffmpeg?: FfmpegConfig;
  /**
   * Ceiling for WAITING on the runtime (e.g. behind an active export on the
   * shared page). On fire the probe returns a launchError result — a
   * transient, honestly-unavailable answer — instead of blocking the caller
   * for the length of someone else's export. Undefined = wait forever
   * (standalone evidence runs).
   */
  readonly waitTimeoutMs?: number;
}

const FALLBACK_FACTS: PageProbeFacts = {
  offscreenCanvas: false,
  offscreenPngEncode: false,
  videoDecoder: {},
  videoEncoder: {},
  audioEncoderAac: null,
  videoEngineInit: false,
  exportEngineInit: false,
  mediabunnyLoaded: false,
  webgpuAdapter: null,
  firstEncodableVideo: null,
  decodeSample: null,
  errors: [],
};

export function summarizeProbe(
  facts: PageProbeFacts,
  ffmpegAvailable: boolean,
): RuntimeProbeResult["summary"] {
  const renderAvailable =
    facts.offscreenCanvas &&
    facts.offscreenPngEncode &&
    facts.videoEngineInit &&
    facts.mediabunnyLoaded;
  const h264DecodeAvailable =
    facts.videoDecoder["avc1.640028"] === true ||
    facts.videoDecoder["avc1.4d0028"] === true ||
    facts.videoDecoder["avc1.42001f"] === true;
  const h264EncodeAvailable = facts.firstEncodableVideo?.avc === "avc";
  const videoOnlyFramesRouteAvailable = renderAvailable && ffmpegAvailable;

  let exportRoute: RuntimeProbeResult["summary"]["exportRoute"] = "unavailable";
  let exportUnavailableReason: string | undefined;
  if (!renderAvailable) {
    exportUnavailableReason =
      "the render path is unavailable (OffscreenCanvas/engine/mediabunny preflight failed)";
  } else if (!facts.exportEngineInit) {
    // Route W drives the real ExportEngine in-page; a codec the browser can
    // encode is useless when the engine that feeds it failed to initialize.
    exportUnavailableReason =
      "the ExportEngine failed to initialize in this Chromium — the WebCodecs export route cannot run";
  } else if (h264EncodeAvailable) {
    exportRoute = "chromium-webcodecs";
  } else {
    exportUnavailableReason = videoOnlyFramesRouteAvailable
      ? "Chromium cannot encode H.264; the video-only frames→ffmpeg route exists but is an explicit opt-in experiment (no audio), never a default export path"
      : "Chromium cannot encode H.264 and no ffmpeg binary is available";
  }
  return {
    renderAvailable,
    h264DecodeAvailable,
    h264EncodeAvailable,
    exportRoute,
    videoOnlyFramesRouteAvailable,
    webgpuAdapter: facts.webgpuAdapter ?? null,
    ...(exportUnavailableReason ? { exportUnavailableReason } : {}),
  };
}

/**
 * Probe an EXISTING runtime (launching its browser on first use). This is
 * what provider preflights call: the facts describe the same Chromium
 * instance that would carry preview/export work, so a crashed or recycled
 * browser can never leave a stale "capable" answer behind — callers key the
 * cached result on the runtime's generation.
 *
 * Always returns a machine-readable result; a browser that fails to launch
 * yields launchError plus all-false facts (callers must treat every
 * capability as unavailable).
 */
export async function probeWithRuntime(
  runtime: ChromiumRuntime,
  options: ProbeOptions = {},
): Promise<RuntimeProbeResult> {
  const startedAt = Date.now();
  const timestamp = new Date().toISOString();
  const host = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
  };

  const ffmpeg = await resolveFfmpegBinaries(options.ffmpeg ?? {});

  let facts = FALLBACK_FACTS;
  let browserVersion = "unknown";
  let userAgent = "unknown";
  let launchError: string | undefined;
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const probed = await (options.waitTimeoutMs !== undefined
      ? Promise.race([
          runtime.probeOnPage(options.sampleMediaPath),
          new Promise<never>((_resolve, reject) => {
            waitTimer = setTimeout(() => {
              reject(
                new Error(
                  `probe could not start within ${options.waitTimeoutMs}ms (runtime busy or wedged)`,
                ),
              );
            }, options.waitTimeoutMs);
          }),
        ])
      : runtime.probeOnPage(options.sampleMediaPath));
    facts = probed.facts;
    browserVersion = probed.browserVersion;
    userAgent = probed.userAgent;
  } catch (error) {
    launchError = error instanceof Error ? error.message : String(error);
  } finally {
    if (waitTimer) clearTimeout(waitTimer);
  }

  const summary = summarizeProbe(facts, ffmpeg !== null);

  return {
    probeVersion: 1,
    timestamp,
    durationMs: Date.now() - startedAt,
    host,
    chromium: {
      executablePath: options.executablePath ?? null,
      version: browserVersion,
      userAgent,
      headless: options.headless ?? true,
    },
    page: facts,
    ffmpeg: ffmpeg
      ? {
          available: true,
          ffmpegPath: ffmpeg.ffmpeg,
          ffprobePath: ffmpeg.ffprobe,
          version: ffmpeg.ffmpegVersion,
        }
      : { available: false },
    summary,
    ...(launchError ? { launchError } : {}),
  };
}

/**
 * Standalone evidence entry point: launch a temporary runtime → probe →
 * close. Used by the probe evidence tests; provider preflights use
 * `probeWithRuntime` on their own pool runtime instead.
 */
export async function runChromiumRuntimeProbe(
  options: ProbeOptions = {},
): Promise<RuntimeProbeResult> {
  const runtime = new ChromiumRuntime({
    ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    headless: options.headless ?? true,
  });
  try {
    return await probeWithRuntime(runtime, options);
  } finally {
    await runtime.close();
  }
}
