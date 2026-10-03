/**
 * Capability provider interfaces.
 *
 * The facade stays pure Node and transport-agnostic: it defines the
 * contracts, a runtime package (e.g. @reelterminal/runtime-chromium) supplies the
 * implementations. The three interfaces are INDEPENDENT on purpose — a
 * runtime that can rasterize frames cannot necessarily encode H.264, and an
 * artifact verifier needs no browser at all. Capability availability is
 * derived from each provider's own preflight, never from the mere presence of
 * another provider (no capability lies by omission OR by inflation).
 *
 * Nothing here imports Chromium/Playwright/ffmpeg; implementations live in
 * the runtime package. All types are JSON-serializable.
 */
import type { Project } from "@reelterminal/core/types/project";

/* ------------------------------------------------------------------ */
/* Shared                                                              */
/* ------------------------------------------------------------------ */

/** Result of a real runtime preflight, not a static manifest claim. */
export interface ProviderPreflight {
  readonly available: boolean;
  /** Present when unavailable: why, in plain language. */
  readonly reason?: string;
  /** What would be required to make it available. */
  readonly requires?: string;
  /** Machine-readable detail from the runtime probe (route, codec facts…). */
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * Media files a provider may read, keyed by mediaId. Every path was
 * re-validated inside the session's mediaRoots by the facade; providers MUST
 * NOT open any path not present in this map.
 */
export type MediaFilesMap = Readonly<Record<string, string>>;

/**
 * Every artifact the facade hands back: a local file under the configured
 * artifactRoot, content-hashed, and pinned to the project revision whose
 * state produced it.
 */
export interface ArtifactRef {
  readonly kind: "image" | "video";
  /**
   * Image artifacts are PNG (lossless) or JPEG (budget-fitted re-encode —
   * see frame-budget.ts); video artifacts are MP4/H.264 in this slice.
   */
  readonly format: "png" | "jpeg" | "mp4";
  /**
   * Absolute local path inside the session's artifactRoot. This is the
   * VERIFIED REALPATH (what the facade hashed after the post-write
   * containment check) — on platforms where the configured root contains a
   * symlink (e.g. macOS /var → /private/var) it differs textually from the
   * configured root; compare realpath-to-realpath, never raw prefixes.
   */
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  /** Project revision whose snapshot produced this artifact. */
  readonly sourceRevision: number;
}

/* ------------------------------------------------------------------ */
/* RenderProvider — backs preview.render_frame                         */
/* ------------------------------------------------------------------ */

export interface RenderFrameRequest {
  readonly region?: { x: number; y: number; width: number; height: number };
  /** Canonical serialized project snapshot (deep clone; provider may mutate). */
  readonly project: Project;
  readonly sourceRevision: number;
  /** Timeline position in seconds; validated by the facade. */
  readonly timeSec: number;
  /** Output raster size (facade defaults to project settings). */
  readonly width: number;
  readonly height: number;
  /**
   * Absolute PNG destination inside artifactRoot, chosen by the facade.
   * The provider writes the file and returns the byte count; the facade
   * computes the hash and assembles the ArtifactRef.
   */
  readonly destPath: string;
  /**
   * Media files the provider may read, already re-validated inside the
   * session's mediaRoots. Keys are mediaIds from project.mediaLibrary.
   * Providers MUST NOT read any path not present here.
   */
  readonly mediaFiles: MediaFilesMap;
}

export interface RenderedFrameInfo {
  readonly bytesWritten: number;
}

/** Request for one real PNG contact sheet composed by the render runtime. */
export interface RenderContactSheetRequest {
  /** Canonical serialized project snapshot (deep clone). */
  readonly project: Project;
  readonly sourceRevision: number;
  /** Timeline positions, already validated and clamped by the facade. */
  readonly samples: readonly {
    readonly timeSec: number;
    readonly label: string;
  }[];
  /** Raster size of each cell in the sheet. */
  readonly width: number;
  readonly height: number;
  /** Absolute PNG destination inside artifactRoot. */
  readonly destPath: string;
  /** Re-validated media paths; providers must not read anything else. */
  readonly mediaFiles: MediaFilesMap;
}

export interface RenderedContactSheetInfo {
  readonly bytesWritten: number;
}

/* ------------------------------------------------------------------ */
/* RenderProvider — HTML→PNG extension (media.render_html)             */
/* ------------------------------------------------------------------ */

/**
 * The constrained HTML source for one render. `path` is a real file inside
 * the session's media roots (the facade has already verified containment);
 * `inline` is raw HTML markup the caller authored (byte-capped upstream).
 */
export type HtmlRenderSource =
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "inline"; readonly html: string };

export interface RenderHtmlPngRequest {
  readonly source: HtmlRenderSource;
  /**
   * Absolute assets root: the only directory tree local file:// subresources
   * may resolve into (the renderer enforces this with a route allowlist).
   * Absent for inline sources means NO local subresource is allowed — only
   * inline data:image URIs can render.
   */
  readonly assetsRoot?: string;
  /** Output raster size (even, bounded — validated by the facade). */
  readonly width: number;
  readonly height: number;
  /** True (default) yields a transparent background (omitBackground). */
  readonly transparent: boolean;
  /** Hard deadline for the whole render; on fire the context is closed. */
  readonly timeoutMs: number;
  /**
   * Absolute PNG destination chosen by the facade (a temp path under the
   * published output dir). The provider writes the file and reports bytes;
   * the facade hashes/publishes per artifact discipline.
   */
  readonly destPath: string;
}

export interface RenderedHtmlPngInfo {
  readonly bytesWritten: number;
  /**
   * Subresources that were blocked (network schemes, file:// outside the
   * assets root) or failed to resolve. The render itself still succeeds —
   * missing assets degrade to blank pixels, exactly like the SVG ingest
   * behavior, and are disclosed here instead of failing the verb.
   */
  readonly missingAssets: readonly string[];
}

export interface RenderProvider {
  readonly supportsRegion?: boolean;
  readonly id: string;
  /**
   * Real runtime preflight (e.g. launch the browser, run the probe). May be
   * cached by the provider; the facade calls it on every capabilities.get so
   * a crashed runtime flips the capability back to unavailable.
   */
  preflight(): Promise<ProviderPreflight>;
  /** Render one PNG frame to destPath. Throws on failure (facade maps it). */
  renderFramePng(request: RenderFrameRequest): Promise<RenderedFrameInfo>;
  /**
   * Optional runtime-native composition. When absent, visual.inspect still
   * returns the individual real frame artifacts and records the honest
   * fallback reason; no fake contact sheet is ever synthesized in Node.
   */
  renderContactSheetPng?(
    request: RenderContactSheetRequest,
  ): Promise<RenderedContactSheetInfo>;
  /**
   * Optional constrained HTML→PNG raster (backs media.render_html). When
   * absent, the facade reports the capability honestly unavailable — the
   * HTML render path must never be faked over the project-frame renderer.
   * Availability is the SAME Chromium supply as preview (the pool's own
   * runtime), so a passing preflight() covers it.
   */
  renderHtmlPng?(request: RenderHtmlPngRequest): Promise<RenderedHtmlPngInfo>;
}

/* ------------------------------------------------------------------ */
/* ExportProvider — backs export.start / job.cancel                    */
/* ------------------------------------------------------------------ */

/** Closed export settings subset for this slice: MP4/H.264 only. */
export interface ExportVideoRequest {
  /** Canonical serialized project snapshot taken at export.start time. */
  readonly project: Project;
  readonly sourceRevision: number;
  readonly settings: {
    readonly format: "mp4";
    readonly codec: "h264";
    readonly width: number;
    readonly height: number;
    readonly frameRate: number;
    readonly videoBitrateKbps: number;
    /**
     * Upscale pass request (absent = not requested). Providers merge it into
     * the render settings they hand the export engine; when the runtime
     * cannot apply it (no WebGPU device) they must disclose that on the
     * completion instead of silently skipping the pass.
     */
    readonly upscaling?: {
      readonly enabled: boolean;
      readonly quality?: "fast" | "balanced" | "quality";
    };
  };
  /** Facade-assigned job id; providers key cancellation/progress by it. */
  readonly jobId: string;
  /**
   * Directory inside artifactRoot reserved for this job. The provider writes
   * the final MP4 to `${jobDir}/output.mp4` (atomically, e.g. via a
   * `.part` temp name it renames on success) and reports the final path in
   * the completion callback.
   */
  readonly jobDir: string;
  readonly mediaFiles: MediaFilesMap;
}

export interface ExportProgressEvent {
  readonly phase: "preparing" | "rendering" | "encoding" | "muxing" | "complete";
  /** 0..1 overall progress. */
  readonly percent: number;
  readonly currentFrame?: number;
  readonly totalFrames?: number;
  readonly bytesWritten?: number;
}

export interface ExportCompletion {
  /** Absolute path of the finished MP4 (inside the job dir). */
  readonly path: string;
  readonly sizeBytes: number;
  /** Which honest route produced the file. */
  readonly route: "chromium-webcodecs" | "chromium-frames-ffmpeg";
  readonly framesEncoded: number;
  /**
   * The request asked for the upscaling pass but this runtime could not
   * apply it (no WebGPU device, or the video-only frames route whose
   * pipeline has no upscale stage). The artifact is valid and NOT upscaled;
   * reporting this beats silently dropping the request. Only set when
   * upscaling was actually requested.
   */
  readonly upscalingRequestedButInactive?: boolean;
}

export interface ExportCallbacks {
  /** The job actually started producing work (leaves the queued state). */
  readonly onRunning: () => void;
  readonly onProgress: (event: ExportProgressEvent) => void;
  readonly onDone: (completion: ExportCompletion) => void;
  readonly onError: (error: { readonly code: string; readonly message: string }) => void;
  readonly onCancelled: () => void;
}

export interface ExportProvider {
  readonly id: string;
  preflight(): Promise<ProviderPreflight>;
  /**
   * Begin the export asynchronously. MUST return promptly (the facade has
   * already answered export.start with the jobId); every invocation MUST
   * later settle exactly one of onDone/onError/onCancelled. Providers may
   * serialize jobs internally (a second job simply stays queued).
   */
  startExport(request: ExportVideoRequest, callbacks: ExportCallbacks): Promise<void>;
  /**
   * Cooperative cancellation. After cancel() the provider still owes exactly
   * one terminal callback (onCancelled, or onError if it was already
   * failing). Cancelling an unknown/finished job is a no-op.
   */
  cancel(jobId: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* ArtifactVerifier — backs verify.artifact                            */
/* ------------------------------------------------------------------ */

export interface ArtifactProbeExpectation {
  readonly container?: "mp4";
  readonly videoCodec?: "h264";
  readonly width?: number;
  readonly height?: number;
  readonly durationSec?: number;
  /** Tolerance for the duration check; defaults to ±1 frame + mux epsilon. */
  readonly durationToleranceSec?: number;
}

export interface PixelCompareRequest {
  /**
   * Reference media: a PNG image (e.g. a preview frame) or a video file.
   * Already validated inside mediaRoots or artifactRoot by the facade.
   */
  readonly referencePath: string;
  /** Time (sec) to extract from the verified artifact. */
  readonly timeSec: number;
  /** Time (sec) to extract from the reference when it is a video. */
  readonly referenceTimeSec?: number;
  /**
   * Optional normalized region (0..1) restricting the comparison
   * (e.g. the text band in the frame center).
   */
  readonly region?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  /** "similar": frames must match; "different": frames must differ. */
  readonly mode: "similar" | "different";
  /** Mean absolute channel difference (0..255) thresholds. */
  readonly maxMeanAbsDiff?: number;
  readonly minMeanAbsDiff?: number;
  /** Ratio of pixels whose max channel diff exceeds ~24, for "different". */
  readonly minChangedPixelsRatio?: number;
  /** Explicit YUV→RGB decode matrix pinned for BOTH sides (docs/COLOR.md). */
  readonly colorMatrix?: "bt601" | "bt709";
  /** Per-side overrides for mixed-matrix comparisons (win over colorMatrix). */
  readonly targetColorMatrix?: "bt601" | "bt709";
  readonly referenceColorMatrix?: "bt601" | "bt709";
}

export interface VerifyArtifactRequest {
  /**
   * Absolute artifact path, already validated inside artifactRoot or at a
   * delivered copy's location inside a delivery root's jobs/<slug>/output dir.
   */
  readonly path: string;
  readonly expect?: ArtifactProbeExpectation;
  readonly compare?: PixelCompareRequest;
}

export interface ArtifactProbeReport {
  readonly container: string;
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationSec: number;
  readonly frameCount: number | null;
  readonly frameRate: number | null;
  readonly sizeBytes: number;
  readonly sha256: string;
  /** Container color tags of the video stream (nulls when absent) — docs/COLOR.md. */
  readonly color?: {
    readonly matrix: string | null;
    readonly primaries: string | null;
    readonly transfer: string | null;
    readonly range: "tv" | "pc" | null;
    readonly pixFmt: string | null;
  };
}

export interface VerifyCheck {
  readonly name: string;
  readonly pass: boolean;
  readonly details: string;
}

export interface VerifyReport {
  readonly pass: boolean;
  readonly probe: ArtifactProbeReport;
  readonly checks: readonly VerifyCheck[];
  readonly compare?: {
    readonly mode: "similar" | "different";
    readonly meanAbsDiff: number;
    readonly changedPixelsRatio: number;
    readonly region: { x: number; y: number; width: number; height: number };
    readonly pass: boolean;
  };
}

export interface ArtifactVerifier {
  readonly id: string;
  preflight(): Promise<ProviderPreflight>;
  /** Throws on infrastructure failure; assertion failures are checks[]. */
  verify(request: VerifyArtifactRequest): Promise<VerifyReport>;
}
