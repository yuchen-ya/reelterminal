/**
 * @openreel/runtime-chromium — the Slice-1b Chromium render/export runtime.
 *
 * Implements the facade's independent provider interfaces
 * (@openreel/agent-facade providers.ts) over real Chromium (playwright-core):
 * the canonical Project is hydrated into the existing core engines bundled
 * into the page, frames come back as real PNGs, and exports produce real
 * H.264 MP4s (WebCodecs route, or frames→ffmpeg fallback). Verification uses
 * ffprobe/ffmpeg only (explicit paths or system PATH; no shell; no committed
 * binaries).
 */
export {
  probeWithRuntime,
  runChromiumRuntimeProbe,
  summarizeProbe,
  type ProbeOptions,
  type RuntimeProbeResult,
} from "./node/probe";
export {
  ChromiumRuntime,
  PartFileWriter,
  type ChromiumRuntimeOptions,
  type ExportProgressJson,
  type PageProbeFacts,
  type WebcodecsExportOutcome,
} from "./node/runtime";
export {
  ChromiumExportProvider,
  ChromiumProviderPool,
  ChromiumRenderProvider,
  createChromiumProviders,
  type ChromiumProviders,
  type ChromiumProvidersConfig,
} from "./node/providers";
export { FfmpegArtifactVerifier } from "./node/verify";
export {
  resolveFfmpegBinaries,
  ffprobeJson,
  extractFrameRgba,
  type FfmpegBinaries,
  type FfmpegConfig,
} from "./node/ffmpeg";
export { buildBrowserEntry } from "./node/bundle";
export {
  HTML_RENDER_DEFAULT_TIMEOUT_MS,
  HTML_RENDER_MAX_DIMENSION,
  HTML_RENDER_MAX_TIMEOUT_MS,
  HTML_RENDER_MIN_TIMEOUT_MS,
  HtmlRenderError,
  HtmlRenderTimeoutError,
  renderHtmlPng,
  type RenderHtmlPngOptions,
} from "./node/html-render";
