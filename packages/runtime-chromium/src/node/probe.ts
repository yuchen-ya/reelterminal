/**
 * Repeatable Chromium runtime probe (ADR 0002 #3).
 *
 * Launches the real browser, records machine-readable facts about every
 * primitive Slice 1b depends on — OffscreenCanvas (+ PNG encode smoke),
 * VideoDecoder per codec, VideoEncoder per codec × hardware preference,
 * AudioEncoder AAC, mediabunny loadability, ExportEngine initialization, the
 * exact `getFirstEncodableVideoCodec(["avc"])` check the export path uses,
 * and an optional real decode smoke against a sample file — plus ffmpeg
 * availability on the host. The summary derives the honest export route.
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
    readonly exportRoute: "chromium-webcodecs" | "chromium-frames-ffmpeg" | "unavailable";
    readonly exportUnavailableReason?: string;
  };
  readonly launchError?: string;
}

export interface ProbeOptions {
  readonly executablePath?: string;
  readonly headless?: boolean;
  /** Sample video for the real in-page decode smoke (e.g. an h264 MP4). */
  readonly sampleMediaPath?: string;
  readonly ffmpeg?: FfmpegConfig;
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

  let exportRoute: RuntimeProbeResult["summary"]["exportRoute"] = "unavailable";
  let exportUnavailableReason: string | undefined;
  if (!renderAvailable) {
    exportUnavailableReason =
      "the render path is unavailable (OffscreenCanvas/engine/mediabunny preflight failed)";
  } else if (h264EncodeAvailable) {
    exportRoute = "chromium-webcodecs";
  } else if (ffmpegAvailable) {
    exportRoute = "chromium-frames-ffmpeg";
  } else {
    exportUnavailableReason =
      "Chromium cannot encode H.264 and no ffmpeg binary is available for the frames fallback route";
  }
  return {
    renderAvailable,
    h264DecodeAvailable,
    h264EncodeAvailable,
    exportRoute,
    ...(exportUnavailableReason ? { exportUnavailableReason } : {}),
  };
}

/**
 * Launch → probe → close. Always returns a machine-readable result; a
 * browser that fails to launch yields launchError plus all-false facts
 * (callers must treat every capability as unavailable).
 */
export async function runChromiumRuntimeProbe(
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

  const runtime = new ChromiumRuntime({
    ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    headless: options.headless ?? true,
  });

  let facts = FALLBACK_FACTS;
  let browserVersion = "unknown";
  let userAgent = "unknown";
  let launchError: string | undefined;
  try {
    const probed = await runtime.probeOnPage(options.sampleMediaPath);
    facts = probed.facts;
    browserVersion = probed.browserVersion;
    userAgent = probed.userAgent;
  } catch (error) {
    launchError = error instanceof Error ? error.message : String(error);
  } finally {
    await runtime.close();
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
