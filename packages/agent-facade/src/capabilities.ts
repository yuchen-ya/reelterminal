import { videoReviewPreflight } from "./video-review";
import { ffmpegToolPreflight, probeLabelFont } from "./media/ffmpeg-bin";
import { MAX_EXTRACT_FRAMES, MAX_SHEET_CELLS } from "./media/frame-exact";
import { MAX_TRACK_FRAMES } from "./plugins/motion-tools";
import { MAX_PATCH_PROPAGATE_FRAMES } from "./plugins/patch-propagation";
import { opencvToolPreflight } from "./media/opencv-runner";
import { audioAnalysisPreflight, AUDIO_LIMITS } from "./audio-analysis";
import { speechVadPreflight } from "./speech-vad";
import { AUDIO_MODEL_COMPONENTS, DEMUCS_MODEL, SENSEVOICE_MODEL, SPEAKER_DIARIZATION_MODEL, demucsModelPresence, probeAudioModelsRuntime, requiredAudioModelPackages, senseVoiceModelPresence, speakerDiarizationModelPresence } from "./media/audio-models-runner";
import {
  AUDIO_NORMALIZE_MAX_INTEGRATED_DEVIATION_LU,
  AUDIO_NORMALIZE_MAX_TRUE_PEAK_OVERSHOOT_DBTP,
  AUDIO_NORMALIZE_MAX_RANGE_SEC,
} from "./audio-normalize";
import { AUDIO_DENOISE_MAX_RANGE_SEC } from "./audio-denoise";
import { COLOR_POLICY as COLOR_POLICY_DISCLOSURE } from "./color-policy";
import { PLUGIN_TOOLS } from "./plugins";
import { MAX_TIMELINE_SOURCE_MAP_POINTS } from "./timeline-source-map";
import { AUDIO_SPEED_CAPABILITIES } from "@reelterminal/core/audio/audio-speed-renderer";
/**
 * Live capability reporting derives each claim from what this
 * session has actually been given and from each provider's own live
 * preflight, never from a static manifest.
 *
 * RenderProvider, ExportProvider, and ArtifactVerifier are independent
 * interfaces. Injecting one never changes another's capability — a runtime
 * that can rasterize frames may still be unable to encode H.264, and a
 * ProjectRenderAdapter does not affect availability. A capability reports
 * available only when (a) the facade
 * ships the verb that consumes it and (b) the provider's real preflight
 * passed. Preflight freshness is the provider's contract (the Chromium
 * providers probe their OWN job-carrying runtime and cache only for that
 * browser's generation — a crash/recycle re-probes); capabilities.get
 * always re-delegates rather than caching answers itself, and verbs
 * re-check the preflight before acting, so a runtime that never probed
 * successfully can never be claimed.
 */
import { FACADE_ERROR_CODES } from "./errors";
import type { ProjectRenderAdapter } from "./render/adapter";
import type {
  ArtifactVerifier,
  ExportProvider,
  ProviderPreflight,
  RenderProvider,
} from "./providers";
import {
  CLIP_VIDEO_EFFECT_TYPES,
  EDIT_OP_TYPES,
  FACADE_CONTRACT_VERSION,
  FACADE_RUNTIME,
  FACADE_VERBS,
  FACADE_VERSION,
  MEDIA_ANALYSIS_TYPES,
  type Capabilities,
  type CapabilitiesGetParams,
  type CapabilityDomain,
  type CapabilityStatus,
  type FacadeVerb,
  type SessionDescription,
} from "./types";
import { MATERIAL_LIBRARY_LIMITS } from "./material-library";
import { FONT_LIBRARY_LIMITS } from "./font-library";
import { PRESET_LIBRARY_LIMITS } from "./preset-verbs";
import {
  GUI_MANUAL_APP_VERSION,
  GUI_MANUAL_CONTENT_VERSION,
  GUI_MANUAL_LANGUAGES,
  GUI_MANUAL_SCREENS,
} from "./gui-manual";
import { MATERIAL_KINDS } from "@reelterminal/core/material/types";
import { PRESET_KINDS } from "@reelterminal/core/presets/types";
import {
  MAX_EFFECTS_PER_PRESET,
  MAX_GRAPHICS_SVG_BYTES,
  MAX_THUMBNAIL_BYTES,
} from "@reelterminal/core/presets/validate";
import { DEFAULT_CHROMA_KEY_SETTINGS } from "@reelterminal/core/video/chroma-key-engine";
import { DEFAULT_BACKGROUND_SETTINGS } from "@reelterminal/core/ai/background-removal-engine";
import {
  DEFAULT_NOISE_REDUCTION_SETTINGS,
  NOISE_REDUCTION_PRESETS,
} from "@reelterminal/core/audio/noise-reduction-presets";
import { SVG_MAX_CONTENT_BYTES } from "@reelterminal/core/graphics/svg-validation";
import {
  type AgentAccessMode,
} from "./access";

export interface CapabilityContext {
  readonly review?: { readonly available: boolean; readonly access: AgentAccessMode };
  readonly mediaRoots: readonly string[];
  /**
   * Roots under which export.start destinationPath may deliver a verified
   * artifact copy (`<deliveryRoot>/jobs/<slug>/output/`). Reported so agents
   * can discover the rule instead of guessing paths; empty means
   * destinationPath always fails fast with INVALID_PARAMS.
   */
  readonly deliveryRoots?: readonly string[];
  /**
   * No facade verb consumes this adapter or derives a capability from it.
   */
  readonly renderAdapter?: ProjectRenderAdapter;
  readonly renderProvider?: RenderProvider;
  readonly exportProvider?: ExportProvider;
  readonly artifactVerifier?: ArtifactVerifier;
  /**
   * Artifact-producing verbs hard-fail without it, so the capabilities must
   * say unavailable too (a capability may never promise what the verb then
   * refuses — RUNNER-06 in both directions).
   */
  readonly artifactRoot?: string;
  /**
   * Live-session marker. When present the
   * reported runtime is "live" and the live-unavailable verbs are listed
   * honestly — never implied by omission. Project creation and all data
   * operations route to explicit project/workspace IDs; project creation
   * does not change the foreground view.
   */
  readonly live?: {
    readonly access: AgentAccessMode;
    readonly writer: boolean;
    readonly leaseHolder: string | null;
    readonly sessionId: string;
    readonly mediaImportAvailable: boolean;
    readonly materialLibraryAvailable?: boolean;
    readonly fontLibraryAvailable?: boolean;
    readonly presetLibraryAvailable?: boolean;
    readonly workspaceLibraryAvailable?: boolean;
    readonly unavailableVerbs: readonly FacadeVerb[];
  };
}

const UNAVAILABLE_NO_RENDER_PROVIDER: CapabilityStatus = {
  available: false,
  reason:
    "No render provider is configured for this session; preview.render_frame cannot produce pixels.",
  requires: "a RenderProvider with a passing runtime preflight (e.g. @reelterminal/runtime-chromium)",
};

const UNAVAILABLE_NO_EXPORT_PROVIDER: CapabilityStatus = {
  available: false,
  reason:
    "No export provider is configured for this session; export.start cannot encode video.",
  requires: "an ExportProvider with a passing runtime preflight (Chromium WebCodecs H.264)",
};

const UNAVAILABLE_NO_VERIFIER: CapabilityStatus = {
  available: false,
  reason:
    "No artifact verifier is configured for this session; verify.artifact cannot probe files.",
  requires: "an ArtifactVerifier backed by ffprobe/ffmpeg (explicit paths or system PATH)",
};

async function preflightOf(
  provider: { preflight(): Promise<ProviderPreflight> } | undefined,
  unavailable: CapabilityStatus,
): Promise<CapabilityStatus> {
  if (!provider) return unavailable;
  try {
    const pre = await provider.preflight();
    if (pre.available) {
      // Surface the provider's details (route, video-only markers…): a
      // capability that hides its limitations would be a quieter lie.
      return {
        available: true,
        ...(pre.details ? { details: pre.details } : {}),
      };
    }
    return {
      available: false,
      reason: pre.reason ?? unavailable.reason ?? "provider preflight failed",
      ...(pre.requires ?? unavailable.requires
        ? { requires: (pre.requires ?? unavailable.requires) as string }
        : {}),
      ...(pre.details ? { details: pre.details } : {}),
    };
  } catch (error) {
    return {
      available: false,
      reason: `provider preflight threw: ${error instanceof Error ? error.message : String(error)}`,
      requires: unavailable.requires,
    };
  }
}

/**
 * Status for a probe that a domain-filtered capabilities.get request scoped
 * out. Never `available: true`; the reason says how to probe it for real.
 * `domains` lists every domain whose request runs this probe (the shared
 * ffmpeg tool preflight runs for video, frames and motion).
 */
function notProbed(...domains: readonly CapabilityDomain[]): CapabilityStatus {
  return {
    available: false,
    probed: false,
    reason:
      `Not probed: this capabilities.get request scoped probing to other domains. ` +
      `Re-run without the domain filter or with domain ${domains.map((domain) => `"${domain}"`).join(" or ")} to probe it for real.`,
  };
}

export async function buildCapabilities(
  ctx: CapabilityContext,
  request: CapabilitiesGetParams = {},
): Promise<Capabilities> {
  // AUD-04 domain filter: run only the requested domain's probes. The
  // filter scopes probing only — config-derived gates (media/artifact
  // roots, bridges) still apply, verbs keep their real pre-execution
  // checks, and an unprobed status is never reported available.
  const requestedDomain = request.domain;
  const wants = (domain: CapabilityDomain): boolean => request.kind !== "review" && (requestedDomain === undefined || requestedDomain === domain);
  const wantsFfmpegTools = wants("video") || wants("frames") || wants("motion");
  const audioReady: CapabilityStatus = wants("audio") ? await audioAnalysisPreflight() : notProbed("audio");
  const speechVadReady: CapabilityStatus = wants("audio") ? await speechVadPreflight() : notProbed("audio");
  const audioModelsReady = wants("audio")
    ? await probeAudioModelsRuntime().then(
        (result) => result.available
          ? { available: true as const, details: result.details }
          : { available: false as const, reason: result.reason },
      )
    : { available: false as const, probed: false as const, reason: "The optional audio-model runtime was not probed because the audio domain was not requested." };
  const senseVoicePresence = wants("audio") ? await senseVoiceModelPresence() : null;
  const diarizationModelsReady = wants("audio")
    ? await probeAudioModelsRuntime(requiredAudioModelPackages("diarize")).then(
        (result) => result.available
          ? { available: true as const, details: result.details }
          : { available: false as const, reason: result.reason },
      )
    : { available: false as const, probed: false as const, reason: "The optional audio-model runtime was not probed because the audio domain was not requested." };
  const camppPresence = wants("audio") ? await speakerDiarizationModelPresence() : null;
  const separationModelsReady = wants("audio")
    ? await probeAudioModelsRuntime(requiredAudioModelPackages("separate"), "separate").then(
        (result) => result.available
          ? { available: true as const, details: result.details }
          : { available: false as const, reason: result.reason },
      )
    : { available: false as const, probed: false as const, reason: "The optional audio-model runtime was not probed because the audio domain was not requested." };
  const demucsPresence = wants("audio") ? await demucsModelPresence() : null;
  const videoReady: CapabilityStatus = wants("video") ? await videoReviewPreflight() : notProbed("video");
  const ffmpegReady: CapabilityStatus = wantsFfmpegTools ? await ffmpegToolPreflight() : notProbed("video", "frames", "motion");
  const labelFont = wants("frames") ? await probeLabelFont() : null;
  const opencvReady: CapabilityStatus = wants("motion") ? await opencvToolPreflight() : notProbed("motion");
  const [maskReady, propagateReady]: [CapabilityStatus, CapabilityStatus] = wants("motion")
    ? await Promise.all([
        opencvToolPreflight(["mask_refine.py"]),
        opencvToolPreflight(["propagate.py"]),
      ])
    : [notProbed("motion"), notProbed("motion")];
  const mediaImportAvailable = ctx.live
    ? ctx.live.mediaImportAvailable && ctx.mediaRoots.length > 0
    : ctx.mediaRoots.length > 0;
  const materialLibraryAvailable = ctx.live
    ? ctx.live.materialLibraryAvailable === true
    : false;
  const fontLibraryAvailable = ctx.live
    ? ctx.live.fontLibraryAvailable === true
    : false;
  const presetLibraryAvailable = ctx.live
    ? ctx.live.presetLibraryAvailable === true
    : false;
  const noArtifactRoot = ctx.artifactRoot === undefined || ctx.artifactRoot.length === 0;
  const gateArtifactProducing = (
    status: CapabilityStatus,
    fallback: CapabilityStatus,
  ): CapabilityStatus =>
    noArtifactRoot
      ? {
          available: false,
          reason:
            "No artifactRoot is configured for this session; artifact-producing verbs would fail until one is provided.",
          requires: fallback.requires,
        }
      : status;
  const [previewRaw, exportRaw, verifyRaw] = await Promise.all([
    wants("render") ? preflightOf(ctx.renderProvider, UNAVAILABLE_NO_RENDER_PROVIDER) : Promise.resolve(notProbed("render")),
    // The export domain covers the whole delivery chain: export.start's
    // encoder and verify.artifact's probe.
    wants("export") ? preflightOf(ctx.exportProvider, UNAVAILABLE_NO_EXPORT_PROVIDER) : Promise.resolve(notProbed("export")),
    wants("export") ? preflightOf(ctx.artifactVerifier, UNAVAILABLE_NO_VERIFIER) : Promise.resolve(notProbed("export")),
  ]);
  const preview = gateArtifactProducing(previewRaw, UNAVAILABLE_NO_RENDER_PROVIDER);
  const visualRaw = gateArtifactProducing(
    previewRaw,
    UNAVAILABLE_NO_RENDER_PROVIDER,
  );
  // media.render_html shares the render provider's Chromium supply with
  // preview, but writes under the MEDIA ROOTS (not artifactRoot) — so it
  // needs roots, not the artifactRoot gate.
  const htmlRenderSupported =
    typeof ctx.renderProvider?.renderHtmlPng === "function";
  const mediaRenderHtml: CapabilityStatus = (() => {
    if (!htmlRenderSupported) {
      return {
        available: false,
        reason:
          "No render provider with HTML rendering (renderHtmlPng) is configured for this session; media.render_html cannot rasterize HTML.",
        requires:
          "a RenderProvider exposing renderHtmlPng (e.g. @reelterminal/runtime-chromium with the local playwright Chromium installed)",
      };
    }
    if (ctx.mediaRoots.length === 0) {
      return {
        available: false,
        reason:
          "No media roots are configured; media.render_html writes its PNG under a media root.",
        requires: "a configured media root for the output directory",
      };
    }
    if (previewRaw.probed === false) return previewRaw;
    if (!previewRaw.available) {
      return {
        available: false,
        reason: previewRaw.reason ?? "render provider preflight failed",
        ...(previewRaw.requires ? { requires: previewRaw.requires } : {}),
        ...(previewRaw.details ? { details: previewRaw.details } : {}),
      };
    }
    return {
      available: true,
      details: {
        renderer: "playwright Chromium (same supply as preview)",
        contentPolicy:
          "core html-policy: scripts, iframe/object/embed, base href, meta refresh, srcset, event handlers, javascript:/vbscript:/non-image data: and network references are rejected",
        maxInlineBytes: 512 * 1024,
        maxDimension: 4096,
        defaultTimeoutMs: 30000,
        maxTimeoutMs: 120000,
        defaultOutputDir: "jobs/html-render/<requestKey>/ under mediaRoots[0]",
        fontsNote:
          "system fonts only; no network font loading (external fonts are rejected)",
        missingAssetSemantics:
          "blocked/missing subresources are listed in missingAssets; the render itself succeeds",
      },
    };
  })();
  const visualInspection: CapabilityStatus = {
    ...visualRaw,
    details: {
      ...(visualRaw.details ?? {}),
      // Both modes render from file-backed media. Live mode cannot safely
      // turn renderer-owned Blob/GUI-only media into pixels in this process.
      fileBackedMediaRequired: true,
      contactSheet: typeof ctx.renderProvider?.renderContactSheetPng === "function",
      maxSamples: 12,
      explicitSourceTimes: true,
      sourceRegion: Boolean(ctx.renderProvider?.supportsRegion),
      regionDecodeMaxDimension: 4096,
      agentTransport: "PNG images and text only; no audio/video consumption claim",
      maxCellDimension: 1024,
    },
  };
  const exportVideoRaw = gateArtifactProducing(exportRaw, UNAVAILABLE_NO_EXPORT_PROVIDER);
  const deliveryRoots = ctx.deliveryRoots ?? [];
  const exportVideo: CapabilityStatus = {
    ...exportVideoRaw,
    details: {
      ...(exportVideoRaw.details ?? {}),
      deliveryRoots,
      destinationPathRule:
        deliveryRoots.length > 0
          ? 'export.start accepts destinationPath "<deliveryRoot>/jobs/<slug>/output/<name>.mp4"; the verified artifact is copied there after completion (no overwrite) and job.status reports deliveredTo/deliveryError. verify.artifact accepts the reported deliveredTo path verbatim.'
          : "No delivery roots are configured for this session; export.start destinationPath fails INVALID_PARAMS until one is provided.",
      upscaling: {
        algorithm:
          "WebGPU Lanczos + edge-directed interpolation on the export render — a deterministic local resampler, NOT a neural-network upscaler (same engine the GUI ExportDialog drives)",
        request: 'export.start settings.upscaling {enabled, quality: "fast"|"balanced"|"quality"}; engages only when the export size exceeds the project canvas size',
        inactiveDisclosure:
          "when the producing runtime has no WebGPU device (or a route without an upscale stage), job.status reports upscalingRequestedButInactive: true on the done job — the artifact is valid and NOT upscaled, never a silent downgrade",
        guiParity: "same core UpscalingEngine and quality tiers as the GUI ExportDialog toggle",
      },
    },
  };
  const verify = gateArtifactProducing(verifyRaw, UNAVAILABLE_NO_VERIFIER);
  const editorControl: CapabilityStatus = ctx.live
    ? {
        available: true,
        details: {
          actions: ["play", "pause", "seek", "select"],
          targetKinds: ["clip", "text", "media"],
          changesProject: false,
          changesRevision: false,
          changesHistory: false,
        },
      }
    : {
        available: false,
        reason:
          "No live editor is attached to this headless session; playback, selection and viewport controls are unavailable.",
        requires: "createLiveFacade with a connected desktop editor",
      };
  return {
    runtime: ctx.live ? "live" : FACADE_RUNTIME,
    ...(request.kind ? { kind: request.kind, verbs: verbsForWorkspace(request.kind), access: request.kind === "review" ? ctx.review?.access ?? "read-only" : ctx.live?.access ?? "write" } : {}),
    ...(ctx.live ? { unavailableVerbs: ctx.live.unavailableVerbs.filter(verb => !request.kind || verbsForWorkspace(request.kind).includes(verb)) } : {}),
    stateModel: {
      canonicalProject: true,
      atomicBatch: true,
      revisionPreconditions: true,
      idempotencyKeys: true,
      serializedExecution: true,
    },
    mediaImport: {
      available: request.kind === "review" ? ctx.review?.available === true && ctx.mediaRoots.length > 0 : mediaImportAvailable,
      ...(mediaImportAvailable
        ? {}
        : {
            reason: ctx.live
              ? ctx.mediaRoots.length === 0
                ? "Live mode: no media roots are configured; media.import cannot read a local file until roots are provided."
                : "Live mode: the host did not provide the live-store media import bridge; media.import is unavailable in this session."
              : "No media roots are configured for this session; every media.import would fail until roots are provided.",
          }),
      limits: request.kind === "review" ? { maxFileBytes: null, buffering: "Native 1 MiB streaming copy, managed original inspection, then atomic review.ingest/review.apply registration; no media bytes in CLI JSON", formatPolicy: "Registered FileResource UUIDs: image/text/data/video/model3d. model3d uses resourceId and model/gltf-binary GLB 2.0 originals; read-only preview, no video attach. GLB preflight: self-contained PNG/JPEG, basic PBR/unlit, skin/morph animation; no external URI, Draco/Meshopt/KTX2/CDN. Preview budget 48 MiB file, 96 MiB expanded geometry, 16M texture pixels, 4096 texture side, 500000 instanced triangles, 10000 nodes. Unsupported previews retain/export original bytes. Node package schema 2 required for model3d; schema 1 remains readable. No URL import." }
        : { maxFileBytes: ctx.live ? 256 * 1024 * 1024 : null, formatPolicy: "Container/track probing by mediabunny; GUI codec decode support must also succeed. No URL import.", buffering: ctx.live ? "GUI bridge currently reads the complete file into an ArrayBuffer/File" : "streamed metadata probing", overLimitAdvice: "Use explicit source segments under the byte limit while retaining originals and recording each segment source offset. No automatic proxy binding; do not silently change frame rate or treat a proxy as final-quality source." },
      sources: ["file"],
      mediaRoots: ctx.mediaRoots,
      recommendedRoot: ctx.mediaRoots[0] ?? null,
      workspaceLayout: {
        jobDirectoryPattern: "jobs/<YYYY-MM-DD>-<short-slug>",
        sharedDirectory: "shared",
        jobEntries: [
          "brief.md",
          "source",
          "generated",
          "work",
          "project",
          "output",
          "evidence",
        ],
        deliverablesDirectory: "output",
      },
      urlImport: false,
      metadata: ["duration", "width", "height", "mediaType"],
    },
    materialLibrary: {
      available: materialLibraryAvailable,
      ...(materialLibraryAvailable
        ? {}
        : {
            reason: ctx.live
              ? "Live mode: the host did not provide the material-library bridge; the material.* verbs report UNSUPPORTED in this session."
              : "Headless sessions have no GUI renderer, so the user-level material library (records, journal, IndexedDB persistence) is not reachable; material.* verbs report UNSUPPORTED.",
          }),
      kinds: MATERIAL_KINDS,
      statusValues: ["inbox", "organized"],
      searchableFields: [
        "title",
        "userNotes",
        "aiSummary",
        "tags",
        "url",
        "description",
        "skillName",
        "prompt",
        "steps",
        "inputs",
        "fileName",
      ],
      limits: {
        maxPageSize: MATERIAL_LIBRARY_LIMITS.maxPageSize,
        maxBatchItems: MATERIAL_LIBRARY_LIMITS.maxBatchItems,
        journalEntriesRetained: MATERIAL_LIBRARY_LIMITS.maxJournalEntries,
      },
      filePolicy: "reference-original",
      undo: {
        available: materialLibraryAvailable,
        scope: "user-library",
      },
      attach: {
        available: materialLibraryAvailable,
        supportsRange: true,
        ...(materialLibraryAvailable
          ? {}
          : { reason: "requires the live material-library bridge" }),
      },
    },
    fonts: {
      available: fontLibraryAvailable,
      ...(fontLibraryAvailable
        ? {}
        : {
            reason: ctx.live
              ? "Live mode: the host did not provide the font-library bridge; the font.* verbs report UNSUPPORTED in this session."
              : "Headless sessions have no GUI renderer, so the user-level custom fonts (renderer IndexedDB + FontFace activation) are not reachable; font.* verbs report UNSUPPORTED.",
          }),
      formats: [...FONT_LIBRARY_LIMITS.formats],
      maxFontBytes: FONT_LIBRARY_LIMITS.maxFontBytes,
      inputs: ["filePath", "dataBase64"],
      duplicatePolicy: "suffix",
      persistence: "renderer-indexeddb",
    },
    customPresets: {
      available: presetLibraryAvailable,
      ...(presetLibraryAvailable
        ? {}
        : {
            reason: ctx.live
              ? "Live mode: the host did not provide the preset-library bridge; the preset.* verbs report UNSUPPORTED in this session."
              : "Headless sessions have no GUI renderer, so the user-level custom presets (renderer IndexedDB, shared with the preset panels) are not reachable; preset.* verbs report UNSUPPORTED.",
          }),
      kinds: PRESET_KINDS,
      limits: {
        maxNameLength: PRESET_LIBRARY_LIMITS.maxNameLength,
        maxTags: PRESET_LIBRARY_LIMITS.maxTags,
        maxEffectsPerPreset: MAX_EFFECTS_PER_PRESET,
        maxThumbnailBytes: MAX_THUMBNAIL_BYTES,
        maxSvgBytes: MAX_GRAPHICS_SVG_BYTES,
      },
      persistence: "renderer-indexeddb",
      apply: {
        available: presetLibraryAvailable,
        targets: [
          "text:updateStyle",
          "effect:clipIds",
          "transition:clipAId",
          "graphics:trackId",
        ],
        ...(presetLibraryAvailable
          ? {}
          : { reason: "requires the live preset-library bridge" }),
      },
    },
    manual: {
      available: true,
      contentVersion: GUI_MANUAL_CONTENT_VERSION,
      appVersion: GUI_MANUAL_APP_VERSION,
      languages: [...GUI_MANUAL_LANGUAGES],
      screenCount: GUI_MANUAL_SCREENS.length,
      screenshots: GUI_MANUAL_SCREENS.some((screen) => screen.screenshot !== undefined)
        ? "delivered"
        : "reserved-not-delivered",
    },
    projectChanges: {
      available: true,
      details: {
        retainedRevisions: 256,
        maxPageSize: 200,
        coversHumanAndAgentEdits: Boolean(ctx.live),
        requiresFullRefreshOnGap: true,
      },
    },
    history: ctx.live
      ? {
          available: true,
          details: {
            canonicalGuiCorePath: true,
            revisionCas: true,
            idempotentControl: true,
            maxSummaryEntries: 100,
          },
        }
      : {
          available: false,
          reason:
            "Headless snapshot transactions do not retain the GUI/Core undo stack; history.get reports this state and history.control fails UNSUPPORTED.",
          requires: "a live desktop session with the canonical GUI/Core history",
        },
    pluginTools: Object.fromEntries(PLUGIN_TOOLS.map((tool) => {
      if (request.kind === "review") return [tool.name, { available: false, reason: "This legacy processor requires a video/project target; it is excluded from the review verb scope." }];
      const requires = tool.requires ?? [];
      const renderUnprobed = requires.includes("render") && previewRaw.probed === false;
      const missing = requires.filter((requirement) => requirement === "render" ? !previewRaw.available : requirement === "artifactRoot" ? noArtifactRoot : ctx.mediaRoots.length === 0);
      return [tool.name, { available: missing.length === 0, ...(missing.length ? { reason: renderUnprobed
        ? `Render preflight was not probed in this request (capabilities.get domain filter); include the "render" domain or drop the filter to probe it.`
        : `Missing plugin prerequisites: ${missing.join(", ")}`, requires: missing.join(", ") } : {}), ...(renderUnprobed ? { probed: false as const } : {}), details: { effect: tool.effect, presentation: tool.presentation ?? "text" } }];
    })),
    frameTools: {
      ffmpeg: ffmpegReady,
      contactSheetLabelFont: wants("frames")
        ? { path: labelFont }
        : { path: null, probed: false as const },
      limits: {
        maxFramesPerExtract: MAX_EXTRACT_FRAMES,
        maxSheetCells: MAX_SHEET_CELLS,
        maxComparePairs: 6,
        maxPatchRangeFrames: MAX_EXTRACT_FRAMES,
      },
    },
    motionTools: {
      opencv: opencvReady,
      maskRefine: maskReady.probed === false && !noArtifactRoot && ctx.mediaRoots.length > 0
        ? maskReady
        : !maskReady.available || noArtifactRoot || ctx.mediaRoots.length === 0
        ? { available: false, reason: !maskReady.available ? maskReady.reason : "Requires configured media and artifact roots" }
        : { available: true, details: {
            verb: "mask.refine",
            algorithm: "explicit PNG alpha mask or rectangle-initialized GrabCut, then bounded dilation/erosion and Gaussian feathering",
            outputs: "grayscale alpha PNG and optional source overlay; candidate only, no timeline edits",
            limitations: "rectangle initialization is a segmentation proposal, not guaranteed character matting; inspect before adoption",
          } },
      patchPropagate: propagateReady.probed === false && !noArtifactRoot && ctx.mediaRoots.length > 0
        ? propagateReady
        : !propagateReady.available || !ffmpegReady.available || noArtifactRoot || ctx.mediaRoots.length === 0
        ? { available: false, reason: !propagateReady.available ? propagateReady.reason : !ffmpegReady.available ? ffmpegReady.reason : "Requires configured media and artifact roots" }
        : { available: true, details: {
            verb: "patch.propagate",
            algorithm: "masked LK sparse optical flow, forward-backward checks and RANSAC similarity; suspected scene/appearance change gates",
            limits: { maxFrames: MAX_PATCH_PROPAGATE_FRAMES, maxDimension: 4096, maxFramePixels: 16000000, maxTotalFramePixels: 250000000 },
            outputs: "lossless candidate PNGs, frame/PTS manifest and inspection overlays; no implicit video encoding or timeline edits",
            failureSemantics: "first detected loss stops propagation; that and later frames remain original with needsRepair and null transforms",
            limitations: "similarity-only short rigid-region propagation; not nonrigid character animation, automatic occlusion completion or guaranteed detection of every cut",
          } },
      align: !opencvReady.available
        ? {
            available: false,
            reason: opencvReady.reason,
            requires: opencvReady.requires ?? "a Python interpreter with opencv-python and numpy (REELTERMINAL_OPENCV_PYTHON or PATH)",
            ...(opencvReady.probed === false ? { probed: false as const } : {}),
          }
        : {
            available: true,
            details: {
              verbs: ["image.align"],
              methods: ["translation", "similarity", "affine"],
              methodBackends: {
                translation: "ECC (findTransformECC, mask-supported; matrix inverted to the moving->reference direction)",
                similarity: "ORB features + RANSAC estimateAffinePartial2D (rotation+uniform scale+translation)",
                affine: "ORB features + RANSAC estimateAffine2D (6-DOF)",
              },
              scores: "method-specific (ECC correlation coefficient vs ORB inlier count/RMSE/ratio) — NOT a unified confidence, never comparable across methods",
              constraints: "both rasters must match exactly (max 4096px); optional stableRegion rectangle restricts estimation and residual scoring; estimation failures return status \"failed\" with a reasonCode, never an identity matrix",
              candidateOnly: "aligned image and matrix are candidates under the artifact root; the timeline is never touched",
            },
          },
      track: !opencvReady.available
        ? {
            available: false,
            reason: opencvReady.reason,
            requires: opencvReady.requires ?? "a Python interpreter with opencv-python and numpy (REELTERMINAL_OPENCV_PYTHON or PATH)",
            ...(opencvReady.probed === false ? { probed: false as const } : {}),
          }
        : {
            available: true,
            details: {
              verb: "motion.track",
              algorithm: "corner seeds (goodFeaturesToTrack inside the region) + LK sparse optical flow (pyrLK) + forward-backward check + RANSAC similarity (estimateAffinePartial2D)",
              frameSource: "frames extracted by the M1 frame-exact core — zero-based decode indices with real PTS per frame, exact for VFR sources; source-native playback only (timeline speed/reverse mapping is the caller's job)",
              failureSemantics: "the tracker never re-seeds across a loss: forward-backward collapse, too few RANSAC inliers or the region leaving the raster ends the run at that frame with a reason; later frames are not_tracked with null matrices — never a plausible-looking glide across cuts",
              outputs: "per-frame cumulative 3x3 region transforms, forward-backward/inlier error statistics, termination reason, overlay PNGs + a review contact sheet, manifest.json",
              limits: { maxFramesPerTrack: MAX_TRACK_FRAMES },
              candidateOnly: "tracking data and overlays are candidates; no timeline keyframes are written and the GUI motion engine state is untouched",
              claimsNotMade: "correspondence statistics only — nothing about physical plausibility or action naturalness",
            },
          },
    },
    mediaAnalysis: {
      asynchronous: true,
      types: Object.fromEntries(
        MEDIA_ANALYSIS_TYPES.map((type) => [
          type,
          type === "videoReview" ? (ctx.mediaRoots.length > 0 && !noArtifactRoot ? videoReady : { available: false, reason: "videoReview needs media roots, artifactRoot, local FFmpeg and a user-provided cloud provider credential" }) : type === "audioSummary"
            ? !ctx.mediaRoots.length
              ? { available: false, reason: "No media roots are configured, so the source file cannot be read for audio analysis.", requires: "a configured media root containing the source" }
              : noArtifactRoot
                ? { available: false, reason: "Audio analysis requires artifactRoot to persist the complete analysis record.", requires: "artifactRoot" }
                : !audioReady.available
                  ? (audioReady.probed === false ? audioReady : { available: false, reason: audioReady.reason })
                  : { ...audioReady, details: { ...audioReady.details, ...AUDIO_LIMITS, maxSourceFileBytes: 2 * 1024 * 1024 * 1024, coordinateSpace: "source", changesProject: false, agentAudioConsumption: false, eventAccess: "Use analysis.get view:'events' for paged onset and silence details, and view:'waveform' for bounded waveform samples." } }
            : type === "technicalQuality" && ctx.mediaRoots.length > 0
            ? {
                available: true,
                details: {
                  provider: "built-in-mediabunny-stat",
                  fields: ["containerMetadata", "duration", "geometry", "codec", "fileSize", "sourceFingerprint", "color"],
                  color: COLOR_POLICY_DISCLOSURE,
                  ...(ffmpegReady.probed === false
                    ? { frameFacts: "technicalQuality.frames detail was not probed in this request: the shared ffmpeg tool preflight was scoped out by the domain filter" }
                    : ffmpegReady.available
                    ? { frameFacts: "technicalQuality.frames adds decoded/header frame count, time base and a bounded whole-stream PTS CFR/VFR verdict via local ffprobe; incomplete scans report unknown" }
                    : { frameFacts: "technicalQuality.frames is null without local ffmpeg/ffprobe (install on PATH or set REELTERMINAL_FFMPEG_PATH/REELTERMINAL_FFPROBE_PATH)" }),
                },
              }
            : type === "speechActivity"
              ? !ctx.mediaRoots.length
                ? {
                    available: false,
                    reason: "No media roots are configured, so the source file cannot be read for speech-activity analysis.",
                    requires: "a configured media root containing the source",
                  }
                : noArtifactRoot
                  ? { available: false, reason: "Audio analysis requires artifactRoot to persist the complete analysis record.", requires: "artifactRoot" }
                : !audioReady.available
                  ? (audioReady.probed === false ? audioReady : { available: false, reason: audioReady.reason })
                : !speechVadReady.available
                  ? (speechVadReady.probed === false
                    ? speechVadReady
                    : { available: false, reason: speechVadReady.reason, ...(speechVadReady.requires ? { requires: speechVadReady.requires } : {}) })
                  : {
                      available: true,
                      details: {
                        ...AUDIO_LIMITS,
                        maxSourceFileBytes: 2 * 1024 * 1024 * 1024,
                        agentAudioConsumption: false,
                        provider: "local-silero-vad-onnx",
                        model: speechVadReady.details?.model,
                        kernel: "Silero VAD v5.1.2 ONNX via onnxruntime-node — per-chunk speech probabilities (32 ms windows, 16 kHz, carried state), hysteresis thresholds, minimum durations and padding",
                        fields: ["analysis.get events (speechRegions)", "regionCount", "totalSpeechDurationSec", "speechRatio", "parameters"],
                        defaults: { threshold: 0.5, minSpeechSec: 0.25, minSilenceSec: 0.1, padSec: 0.03 },
                        tuning: "media.analyze_start vadParams {threshold, minSpeechSec, minSilenceSec, padSec}",
                        workflow: "page speechRegions with analysis.get view:'events', then drive music ducking directly with edit.apply op clip.setDuckingFromAnalysis (record-driven, same gates); regions are review evidence — never automatic deletion of non-speech gaps",
                        granularitySec: 0.032,
                        coordinateSpace: "source",
                        changesProject: false,
                      },
                    }
            : type === "speakerDiarization"
              ? !ctx.mediaRoots.length
                ? {
                    available: false,
                    reason: "No media roots are configured, so the source file cannot be read for speaker diarization.",
                    requires: "a configured media root containing the source",
                  }
                : noArtifactRoot
                  ? { available: false, reason: "Audio analysis requires artifactRoot to persist the complete analysis record.", requires: "artifactRoot" }
                  : !audioReady.available
                    ? (audioReady.probed === false ? audioReady : { available: false, reason: audioReady.reason })
                    : !speechVadReady.available
                      ? (speechVadReady.probed === false ? speechVadReady : { available: false, reason: speechVadReady.reason })
                      : !diarizationModelsReady.available
                        ? {
                            available: false,
                            ...("probed" in diarizationModelsReady && diarizationModelsReady.probed === false ? { probed: false as const } : {}),
                            reason: diarizationModelsReady.reason,
                            requires: "an optional Python interpreter with modelscope + torch + soundfile + numpy (REELTERMINAL_AUDIO_MODELS_PYTHON); no model is bundled",
                          }
                        : {
                            available: true,
                            details: {
                              ...AUDIO_LIMITS,
                              maxSourceFileBytes: 2 * 1024 * 1024 * 1024,
                              agentAudioConsumption: false,
                              provider: "local-campplus-modelscope-python",
                              component: AUDIO_MODEL_COMPONENTS.speakerDiarization,
                              runtime: diarizationModelsReady.details,
                              model: {
                                ...SPEAKER_DIARIZATION_MODEL,
                                displayName: "CAM++ speaker verification",
                                path: camppPresence?.path ?? null,
                                present: camppPresence?.present === true,
                                sizeMatches: camppPresence === null ? null : camppPresence.bytes === SPEAKER_DIARIZATION_MODEL.bytes,
                                downloadBytes: SPEAKER_DIARIZATION_MODEL.bytes,
                                estimatedDiskBytes: AUDIO_MODEL_COMPONENTS.speakerDiarization.estimatedDiskBytes,
                                acquisition: "Explicit consent: diarizationParams.allowModelDownload:true downloads the pinned ~28 MB model from ModelScope into REELTERMINAL_MODELSCOPE_CACHE; or set REELTERMINAL_CAMPP_SV_MODEL_DIR to a local copy. The app never runs pip.",
                              },
                              anonymousClusters: true,
                              timestampSource: "external-vad-silero",
                              timestampGranularitySec: 0.032,
                              defaults: { threshold: 0.7, maxSpeakers: 8 },
                              fields: ["analysis.get events (segments)", "speakerCount", "anonymousClusters", "parameters", "model"],
                              tuning: "media.analyze_start diarizationParams {threshold, maxSpeakers, allowModelDownload}; vadParams also apply (shared Silero VAD segmentation)",
                              workflow: "page anonymous segments with analysis.get view:'events' series 'speakerDiarization.segments'; labels are review evidence and no automatic edit is applied",
                              limits: "overlapping speech is not separated; very short segments and >4-speaker material are not quantitatively validated; labels are clusters, never real identities",
                              isolation: "One Python child process per job; cancellation kills it; crash/nonzero/invalid JSON/oversized output fails the job without publishing anything.",
                              coordinateSpace: "source",
                              changesProject: false,
                            },
                          }
            : type === "speechTranscript"
              ? !ctx.mediaRoots.length
                ? {
                    available: false,
                    reason: "No media roots are configured, so the source file cannot be read for transcription.",
                    requires: "a configured media root containing the source",
                  }
                : noArtifactRoot
                  ? { available: false, reason: "Audio analysis requires artifactRoot to persist the complete analysis record.", requires: "artifactRoot" }
                  : !audioReady.available
                    ? (audioReady.probed === false ? audioReady : { available: false, reason: audioReady.reason })
                    : !speechVadReady.available
                      ? (speechVadReady.probed === false ? speechVadReady : { available: false, reason: speechVadReady.reason })
                      : !audioModelsReady.available
                        ? {
                            available: false,
                            ...("probed" in audioModelsReady && audioModelsReady.probed === false ? { probed: false as const } : {}),
                            reason: audioModelsReady.reason,
                            requires: "an optional Python interpreter with funasr 1.3.1 + modelscope + torch + soundfile (REELTERMINAL_AUDIO_MODELS_PYTHON); no model is bundled",
                          }
                        : {
                            available: true,
                            details: {
                              ...AUDIO_LIMITS,
                              maxSourceFileBytes: 2 * 1024 * 1024 * 1024,
                              agentAudioConsumption: false,
                              provider: "local-sensevoice-funasr-python",
                              component: AUDIO_MODEL_COMPONENTS.speechTranscript,
                              runtime: audioModelsReady.details,
                              model: {
                                ...SENSEVOICE_MODEL,
                                displayName: "SenseVoice-Small",
                                path: senseVoicePresence?.path ?? null,
                                present: senseVoicePresence?.present === true,
                                sizeMatches: senseVoicePresence === null ? null : senseVoicePresence.bytes === SENSEVOICE_MODEL.bytes,
                                downloadBytes: SENSEVOICE_MODEL.bytes,
                                estimatedDiskBytes: AUDIO_MODEL_COMPONENTS.speechTranscript.estimatedDiskBytes,
                                acquisition: "Explicit consent: transcriptParams.allowModelDownload:true downloads the pinned model from modelscope into REELTERMINAL_MODELSCOPE_CACHE (default ~/.reelterminal/models/modelscope); or point REELTERMINAL_SENSEVOICE_MODEL_DIR at a local copy. The app never runs pip.",
                              },
                              timestampSource: "external-vad-silero",
                              timestampGranularitySec: 0.032,
                              languages: ["auto", "zh", "en", "yue", "ja", "ko"],
                              tuning: "media.analyze_start transcriptParams {language, useItn, allowModelDownload}; vadParams also apply (shared Silero VAD segmentation)",
                              fields: ["analysis.get events (segments)", "segmentCount", "languageCounts", "emotionCounts", "eventCounts", "model", "timestampSource"],
                              workflow: "page segments with analysis.get view:'events' series 'speechTranscript.segments', then import them as subtitles with the record-driven subtitle.importTranscript edit op (one undo unit); text/emotion/event labels are data, not precise event intervals",
                              isolation: "One Python child process per job; cancellation kills it; crash/nonzero/invalid JSON/oversized output fails the job without publishing anything.",
                              coordinateSpace: "source",
                              changesProject: false,
                            },
                          }
            : type === "syncOffset"
              ? !ctx.mediaRoots.length
                ? {
                    available: false,
                    reason: "No media roots are configured, so the target and reference files cannot be read for sync-offset analysis.",
                    requires: "configured media roots containing both the target and the reference media",
                  }
                : noArtifactRoot
                  ? { available: false, reason: "Audio analysis requires artifactRoot to persist the complete analysis record.", requires: "artifactRoot" }
                  : !audioReady.available
                    ? (audioReady.probed === false ? audioReady : { available: false, reason: audioReady.reason })
                    : {
                        available: true,
                        details: {
                          ...AUDIO_LIMITS,
                          maxSourceFileBytes: 2 * 1024 * 1024 * 1024,
                          provider: "local-ffmpeg-pcm-gcc-phat",
                          fields: ["verdict", "offsetSec", "offsetMs", "fixedOffsetSupported", "peaks", "windows", "drift", "reference", "parameters"],
                          signConvention: "positive offsetSec means the target is later than the reference (target lags reference); negative means the target leads",
                          decisionRule: "GCC-PHAT peak must stand ≥6 dB over the median |correlation| and the best competing local peak outside a ±50 ms guard must be ≥3 dB below it; otherwise the verdict is ambiguous or no-match instead of a guess",
                          defaults: { referenceStartSec: 0, searchRangeSec: 2, windowSec: 30 },
                          tuning: "media.analyze_start syncOffsetParams {referenceMediaId, referenceStartSec, searchRangeSec, windowSec}; the reference media must be in the same project and media roots",
                          drift: ">=3 usable windows are linearly regressed and reported as clock-drift; v1 never silently corrects drift and does not claim one fixed offset is valid for a drifting pair",
                          workflow: "read verdict/offsetSec as evidence, then move the target clip manually with edit.apply if appropriate; no clip, gain, marker or project revision is changed by the analysis",
                          coordinateSpace: "source",
                          changesProject: false,
                        },
                      }
            : type === "silence" || type === "beatGrid"
              ? !ctx.mediaRoots.length
                ? {
                    available: false,
                    reason: "No media roots are configured, so the source file cannot be read for audio analysis.",
                    requires: "a configured media root containing the source",
                  }
                : noArtifactRoot
                  ? { available: false, reason: "Audio analysis requires artifactRoot to persist the complete analysis record.", requires: "artifactRoot" }
                : !audioReady.available
                  ? (audioReady.probed === false ? audioReady : { available: false, reason: audioReady.reason })
                  : {
                      available: true,
                      details: type === "silence"
                        ? {
                            ...AUDIO_LIMITS,
                            maxSourceFileBytes: 2 * 1024 * 1024 * 1024,
                            agentAudioConsumption: false,
                            provider: "local-ffmpeg-pcm-silence-kernel",
                            kernel: "core detectSilenceRangesInPcm — the same silence kernel and defaults as the GUI silence-cut panel",
                            fields: ["analysis.get events (silentRegions)", "totalSilenceDurationSec", "parameters"],
                            defaults: { thresholdDb: -40, minDurationSec: 0.5, paddingSec: 0.1 },
                            tuning: "media.analyze_start silenceParams {thresholdDb, minDurationSec, paddingSec}",
                            workflow: "page silentRegions with analysis.get view:'events', then cut them record-driven with the clip.cutSilenceFromAnalysis op (one edit.apply batch/undo unit: kept pauses below minSilenceSec, paddingSec edge keep, fadeSec click protection, aligned timing-identical A/V siblings cut together, per-track ripple; speed curves/freeze frames, non-zero audioTrackIndex and desyncing subtitles are rejected) — or drive clip.split + clip.rippleDelete manually for other placements",
                            coordinateSpace: "source",
                            changesProject: false,
                          }
                        : {
                            ...AUDIO_LIMITS,
                            maxSourceFileBytes: 2 * 1024 * 1024 * 1024,
                            agentAudioConsumption: false,
                            provider: "local-ffmpeg-pcm-beat-engine",
                            kernel: "core BeatDetectionEngine.analyzePcm — the same beat detector as the GUI beat-sync panel",
                            fields: ["analysis.get events (beats)", "bpm", "confidence"],
                            downbeats: "not available: no downbeat detector is installed — the core engine's internal every-4th-beat heuristic is a periodicity assumption, deliberately NOT reported as detection",
                            workflow: "page beats with analysis.get view:'events', snap cut points with the clip.splitAtBeat op (desired time + maxShiftSec moves to the nearest record beat; no beat inside the allowed movement is rejected, never an unsnapped cut), then beat sync via clip.move + clip.trim ops; beat auto-edit plans expand via the shared core expandCutPlanToActions into clip.move/trim/add/remove ops applied as one edit.apply batch (one undo unit)",
                            coordinateSpace: "source",
                            changesProject: false,
                          },
                    }
            : type === "sceneCuts" || type === "blackFrames" || type === "duplicateFrames"
              ? !ctx.mediaRoots.length
                ? {
                    available: false,
                    reason: "No media roots are configured, so the source file cannot be read for local candidate analysis.",
                    requires: "a configured media root containing the source",
                  }
                : !ffmpegReady.available
                  ? (ffmpegReady.probed === false ? ffmpegReady : { available: false, reason: ffmpegReady.reason })
                  : {
                      available: true,
                      details: {
                        provider: type === "sceneCuts" ? "local-ffmpeg-scene-score" : type === "blackFrames" ? "local-ffmpeg-blackdetect" : "local-ffmpeg-freezedetect",
                        ...(type === "sceneCuts"
                          ? { algorithm: "FFmpeg select scene score: inter-frame SAD over the luma plane only (libavfilter ff_scene_sad) — a plain pixel-difference detector, NOT PySceneDetect HSV-Content" }
                          : {}),
                        ...(type === "duplicateFrames"
                          ? {
                              semantics: "FROZEN/near-static INTERVAL candidates (freezedetect compares CONSECUTIVE frames) — this is NOT arbitrary duplicate-frame retrieval: identical or similar frames that are not consecutive are not found",
                            }
                          : {}),
                        fields: type === "sceneCuts" ? ["candidates[].frameIndex", "candidates[].ptsTimeSec", "candidates[].score", "parameters", "limitations"] : ["candidates[].startSec/endSec", "candidates[].startFrameIndex/endFrameIndexExclusive", "parameters", "limitations"],
                        ...(type === "duplicateFrames" ? { closedAtStreamEnd: "a freeze running into the analyzed stream end has no measured end; flagged honestly on the candidate" } : {}),
                        candidatesOnly: "detector output is review candidates with parameters and limitations — never verdicts, never automatic edits",
                        ffmpeg: ffmpegReady.available ? ffmpegReady.details : undefined,
                        workflow: "verify boundaries with frames.extract + frames.contact_sheet, then act through edit.apply (one undo unit)",
                        coordinateSpace: "source",
                        changesProject: false,
                      },
                    }
            : type === "motion"
              ? {
                  available: false,
                  reason:
                    "The \"motion\" analysis type (clip transform-keyframe analysis) has no installed provider here. File-based region tracking IS available as the motion.track plugin verb — see the motionTools capability for its real availability (it needs a local OpenCV interpreter). In the desktop GUI the motion-tracking engine lands its result as transform keyframes via clip.setKeyframes (undoable, persisted, consumed by render and export).",
                  requires:
                    "a MediaAnalysisProvider for the \"motion\" type, or use the motion.track verb for file-based candidate tracking",
                }
              : {
                available: false,
                reason:
                  type === "technicalQuality"
                    ? "No media roots are configured, so the source file cannot be revalidated for analysis."
                    : `${type} has no installed analysis provider in this runtime.`,
                requires:
                  type === "technicalQuality"
                    ? "a configured media root containing the source"
                    : `a MediaAnalysisProvider that genuinely implements ${type}`,
              },
        ]),
      ) as Capabilities["mediaAnalysis"]["types"],
      largeResultsAsArtifacts: true,
    },
    professionalEditing: {
      subtitles: {
        available: true,
        details: { ops: ["subtitle.importSrt", "subtitle.importTranscript"], maxSrtBytes: 262144, maxCues: 500 },
      },
      trackControls: {
        available: true,
        details: { op: "track.update", fields: ["name", "locked", "hidden", "muted", "solo"] },
      },
      mediaProduction: {
        available: true,
        details: { op: "media.setProduction", statuses: ["pending", "adopted", "rejected"], operations: ["original", "generation", "redraw", "composite", "resize", "modelEnhancement"], strictReplacement: "media.replace preserveFrames: true (requires FFprobe, verified CFR, equal decoded counts)", modelBackend: "external and explicit; metadata never runs a model", textRendering: "existing independent text layers render at export resolution" },
      },
      mediaRename: {
        available: true,
        details: { op: "media.rename", field: "displayName", maxNameLength: 120 },
      },
      transformKeyframes: {
        available: true,
        details: { op: "clip.setKeyframes", properties: ["opacity", "position.x", "position.y", "scale.x", "scale.y", "rotation"], maxKeyframes: 100 },
      },
      speedRamping: {
        available: true,
        details: {
          writeOp: "clip.setSpeedConfig",
          mappingQuery: "timeline.mapSourceTimes",
          speedRange: [0.1, 20],
          maxKeyframes: 128,
          maxFreezeFrames: 128,
          keyframeTime: "source seconds relative to clip.inPoint",
          freezeSourceTime: "source seconds relative to clip.inPoint",
          freezeStartTime: "clip-local playback seconds, including preceding freeze durations",
          curveSemantics: "when keyframes are present they replace base speed; the curve integrates in ascending source-relative time, then reverse reflects the resulting offset across the source span; freeze.sourceTime is used literally and is not reflected; easing overshoot is clamped to [0.1, 20]",
          splitTrimReviewRange: "clip.split and clip.trim reject speed-ramped or frozen clips; ReviewRange also rejects reversed clips and currently requires forward constant-speed clips",
          mappingQueryLimit: MAX_TIMELINE_SOURCE_MAP_POINTS,
            mappingQueryDirection: "timeline point to source point; no source-to-timeline inverse or endpoint-only nonlinear interval mapping",
            audioPlayback: AUDIO_SPEED_CAPABILITIES,
            audioLimitations: "Audible speed changes require pitchCorrection: false (varispeed changes pitch). Curves use the same prepared PCM and source-time kernel in preview/offline rendering. Pitch-preserving audio and audio during freeze holds fail explicitly; mute clip audio or change the speed configuration. Freeze sound still requires a product decision.",
        },
      },
      volumeKeyframes: {
        available: false,
        reason: "The current preview/export audio path does not evaluate per-clip volume keyframes; constant clip.setVolume remains available.",
        requires: "shared realtime/export automation evaluation for audio.volume",
      },
      basicColorGrade: {
        available: true,
        details: { op: "clip.setColorGrade", fields: ["temperature", "tint", "clear"] },
      },
      videoEffects: {
        available: true,
        details: {
          op: "clip.addVideoEffect",
          coreAction: "effect/add",
          effectTypes: [...CLIP_VIDEO_EFFECT_TYPES],
          autoColor:
            "the GUI 'Auto-Color' button is a FIXED PRESET expressible as three clip.addVideoEffect ops in one batch: saturation {value:1.15}, contrast {value:1.1}, brightness {value:5} — the exact parameters the GUI sends. It is named honestly: a constant preset, NOT image analysis, and nothing adapts the values to the footage",
          params:
            "per-effectType closed parameter contracts mirroring the GUI effect sliders; shader effects validate against the core shader library's own parameter definitions; out-of-range values are rejected, never clamped",
          guiParity:
            "same core effect/add action as the GUI inspector's effect panel: appends to clip.effects, undoable via the action's inverse, persisted with the clip, evaluated by the shared preview/export render chain",
        },
      },
      chromaKey: {
        available: true,
        details: {
          op: "clip.setChromaKey",
          coreAction: "clip/setChromaKey",
          algorithm:
            "fixed-key chroma keyer (ChromaKeyEngine color-distance matte) — a deterministic local algorithm, not AI matting",
          defaultKeyColor: DEFAULT_CHROMA_KEY_SETTINGS.keyColor,
          defaults: {
            tolerance: DEFAULT_CHROMA_KEY_SETTINGS.tolerance,
            edgeSoftness: DEFAULT_CHROMA_KEY_SETTINGS.edgeSoftness,
            spillSuppression: DEFAULT_CHROMA_KEY_SETTINGS.spillSuppression,
          },
          keyColorRange: "each channel in [0, 1]",
          guiParity:
            "same core action as the GUI green-screen panel; results are undoable via the action's inverse",
        },
      },
      noiseReduction: {
        available: true,
        details: {
          op: "clip.setNoiseReduction",
          coreActions: [
            "audio/addEffect",
            "audio/updateEffect",
            "audio/toggleEffect",
          ],
          algorithm:
            "local noise-reduction DSP (AudioEffectsEngine noiseReduction chain with per-focus profiles) — deterministic local signal processing, not AI or model inference",
          defaults: {
            threshold: DEFAULT_NOISE_REDUCTION_SETTINGS.threshold,
            reduction: DEFAULT_NOISE_REDUCTION_SETTINGS.reduction,
            attack: DEFAULT_NOISE_REDUCTION_SETTINGS.attack,
            release: DEFAULT_NOISE_REDUCTION_SETTINGS.release,
            focus: DEFAULT_NOISE_REDUCTION_SETTINGS.focus,
          },
          presets: NOISE_REDUCTION_PRESETS.map((preset) => preset.id),
          parameterRanges: {
            thresholdDb: [-80, 0],
            reduction: [0, 1],
            attackMs: [0, 100],
            releaseMs: [0, 500],
          },
          guiParity:
            "same core audio-effect actions as the GUI noise-reduction panel; an existing noiseReduction effect is updated in place (never stacked), a learned profile is preserved, and undo is the core actions' inverse",
        },
      },
      svgOverlays: {
        available: true,
        details: {
          ops: ["svg.create", "svg.update", "svg.remove"],
          coreActions: ["svg/create", "svg/update", "svg/remove"],
          ingestGate:
            "Agent-supplied markup crosses the same shared core SVG ingest gate as the GUI import: scripts, foreign objects, event handlers, unsafe URL schemes, external references and oversized documents are rejected with a coded error",
          maxContentBytes: SVG_MAX_CONTENT_BYTES,
          autoTrack:
            "svg.create uses the first existing graphics track, or creates one in the same atomic batch when the project has none",
          guiParity:
            "the created clip is the same project.svgClips content the GUI SVG import produces (editable in the Inspector, undoable via the core actions' inverses) and is projected by timeline.query as an svg entity",
        },
      },
      lut: {
        available: false,
        reason: "Core can persist LUT samples, but the facade has no bounded, path-contained LUT import contract yet.",
        requires: "a contained LUT artifact parser and preview/export parity tests",
      },
      audioNormalization: {
        available: false,
        reason: "No canonical persisted normalization model/provider is wired through edit.apply.",
        requires: "an analysis-backed gain plan plus shared preview/export semantics",
      },
      audioDucking: {
        available: true,
        details: {
          op: "clip.setDucking",
          coreAction: "audio/setDucking",
          algorithm:
            "envelope detection (core AudioDucker RMS presence windows) — deterministic local signal processing, not AI or model inference",
          keyframeSource:
            "the op takes pre-computed points (an AudioDucker.generateDuckingKeyframes product) or presenceRanges (speech-active windows on the trigger track, e.g. the complement of a silence analysis) and synthesizes keyframes with the same core kernel the GUI panel uses; an empty synthesis is rejected, never persisted silently",
          tuning: {
            thresholdDb: [-60, 0],
            reduction: [0, 1],
            attackSec: [0, 1],
            releaseSec: [0, 2],
            holdTimeSec: [0, 1],
          },
          evaluation:
            "persisted clip.automation.volume is evaluated by the shared core audio engine in both realtime preview and export render (resolveClipVolumeAutomation → applyVolumeAutomation) — one evaluation chain, no separate export path",
          guiParity:
            "same core action as the GUI ducking panel (AudioDuckingSection), which the store now also persists through; undo restores both the volume keyframes and the panel readback snapshot",
          recordDriven: {
            op: "clip.setDuckingFromAnalysis",
            input: "a speechActivity analysis record id (AUD-01) + the speech clip + the background clip + the same tuning fields",
            mapping: "record speechRegions (source seconds) → shared core SpeedEngine (placement/trim/speed curve/reverse/freeze holds) → timeline → background-clip-relative presenceRanges, all before the mutation starts; the applied op is reported as clip.setDucking",
            supportedSpeechClips: "any trimmed clip, including reverse playback, speed curves (speedKeyframes) and freeze frames; freeze holds whose source moment is speech are included",
            gates: "stale records (source changed/missing), records without speechActivity facts, records analyzing another media than the speech clip plays, clips selecting another audio stream than the analyzed 0:a:0, and no-overlap placements are rejected; an existing volume envelope on the target requires existingEnvelope:\"replace\" — never silently overwritten",
          },
        },
      },
      backgroundRemoval: {
        available: true,
        details: {
          op: "clip.setBackgroundRemoval",
          coreAction: "clip/setBackgroundRemoval",
          algorithm:
            "MediaPipe person segmentation (selfie_multiclass_256x256 tflite, local in-browser inference) in the GUI/desktop-Chromium runtime",
          renderRuntime:
            "preview and export render this effect inside the desktop GUI (Chromium), where the model downloads on first GUI use and is cached per profile; headless runtimes have no MediaPipe runtime, so the op persists the setting but headless-rendered frames keep the original background — verify this effect through the desktop GUI",
          offline:
            "first-use model download needs storage.googleapis.com and cdn.jsdelivr.net; offline first use fails with the effect staying disabled",
          degradedFallback:
            "when the segmentation model fails to load, the GUI engine falls back to a non-AI luminance mask (generateSimpleMask) and the effects panel discloses the degraded mask — never presented as AI matting",
          defaults: {
            mode: DEFAULT_BACKGROUND_SETTINGS.mode,
            blurAmount: DEFAULT_BACKGROUND_SETTINGS.blurAmount,
            backgroundColor: DEFAULT_BACKGROUND_SETTINGS.backgroundColor,
            edgeBlur: DEFAULT_BACKGROUND_SETTINGS.edgeBlur,
            threshold: DEFAULT_BACKGROUND_SETTINGS.threshold,
          },
          parameterRanges: {
            blurAmountPx: [0, 50],
            edgeBlurPx: [0, 10],
            threshold: [0, 1],
          },
          guiParity:
            "same core action as the GUI Background Removal panel; the clip.backgroundRemoval field is undoable via the action's inverse and saved with the project",
        },
      },
      vocalIsolation: {
        available: false,
        reason: "No installed provider produces a contained isolated-vocal media artifact.",
        requires: "an asynchronous provider and explicit imported result artifact",
      },
      stabilization: {
        available: false,
        reason: "Stabilization lacks a validated facade op and end-to-end preview/export test in this contract.",
        requires: "canonical Core action plus renderer parity evidence",
      },
      smartReframe: {
        available: true,
        details: {
          op: "clip.applyReframe",
          coreActions: ["project/updateSettings (only when the output size differs)", "keyframe/setAll"],
          algorithm:
            "local skin-region color heuristic (core auto-reframe-engine) — not ML/model inference; expect weak or off-subject tracks on non-person, low-light, or busy multi-subject footage",
          subjectDetectionRuntime:
            "browser GUI engine; headless agents supply their own crop plan (e.g. derived from visual.inspect frames)",
          timeSemantics:
            "op keyframe times are source-analysis seconds from the clip in-point; the shared core conversion folds them onto the clip-local keyframe clock (divided by clip speed)",
          changesProjectDimensions: true,
          maxKeyframes: 100,
          undo: "one atomic edit.apply batch = one GUI undo group",
        },
      },
      proxyMedia: {
        available: false,
        reason: "Proxy generation is not exposed through the canonical project/job facade.",
        requires: "a contained asynchronous proxy provider and persisted proxy binding",
      },
      relink: {
        available: false,
        reason: "Media relink remains unavailable; moved checkpoint media fails open honestly.",
        requires: "a root-contained relink mutation with fingerprint validation",
      },
      exportPresets: {
        available: false,
        reason: "The facade currently exposes one closed MP4/H.264 settings shape, not a preset catalog.",
        requires: "a versioned preset enum shared with GUI and runtime",
      },
      exportPreflight: {
        available: false,
        reason: "Provider readiness is reported by capabilities.get, but no project-specific export preflight verb exists.",
        requires: "a bounded project/media/codec preflight result shared with export.start",
      },
    },
    editOps: request.kind === "review" ? [] : EDIT_OP_TYPES,
    textOverlay: {
      modelState: true,
      pixelRendering: preview.available,
    },
    mediaRenderHtml,
    audioNormalize: {
      available: audioReady.available && mediaImportAvailable,
      ...(!audioReady.available
        ? {
            reason: audioReady.reason ?? "Local FFmpeg loudnorm/ffprobe unavailable",
            ...(audioReady.probed === false ? { probed: false as const } : {}),
          }
        : !mediaImportAvailable ? { reason: "A media root and an operational media import bridge are required" } : {}),
      details: {
        command: "audio.process.normalize",
        registrationCommand: "audio.process.register",
        route: "local FFmpeg two-pass loudnorm; output is independently remeasured",
        output: "48 kHz PCM 24-bit WAV; explicit mono or stereo",
        maximumRangeSec: AUDIO_NORMALIZE_MAX_RANGE_SEC,
        targetValidation: {
          maximumIntegratedDeviationLu: AUDIO_NORMALIZE_MAX_INTEGRATED_DEVIATION_LU,
          maximumTruePeakOvershootDbtp: AUDIO_NORMALIZE_MAX_TRUE_PEAK_OVERSHOOT_DBTP,
          failure: "Remeasured output outside these tolerances fails without publishing an asset",
        },
        storage: "mediaRoots[0]/generated-assets/audio-normalize/<jobId>/ (persistent, outside analysis cache)",
        registration: "Explicit revision-guarded media import into the source project/workspace; does not replace clips",
      },
    },
    audioDenoise: {
      available: audioReady.available && mediaImportAvailable,
      ...(!audioReady.available
        ? {
            reason: audioReady.reason ?? "Local FFmpeg/ffprobe unavailable",
            ...(audioReady.probed === false ? { probed: false as const } : {}),
          }
        : !mediaImportAvailable ? { reason: "A media root and an operational media import bridge are required" } : {}),
      details: {
        command: "audio.process.denoise",
        registrationCommand: "audio.process.register",
        profiles: {
          light: "afftdn=nr=12:nf=-25 (steady low-level broadband noise)",
          strong: "afftdn=nr=24:nf=-35 (heavier stationary noise)",
          declick: "optional adeclick=window=55:overlap=75 before afftdn",
        },
        delayCompensation: "the exact chain's fixed delay is measured with a deterministic white-noise probe, trimmed and tail-padded; the published output is cross-correlated against the source and the sample count is re-verified",
        route: "local FFmpeg afftdn tier; output is independently loudness-remeasured",
        output: "48 kHz PCM 24-bit WAV; explicit mono or stereo, sample-aligned to the requested source range",
        maximumRangeSec: AUDIO_DENOISE_MAX_RANGE_SEC,
        notIncluded: "dynamic processing (de-esser/compressor/EQ voice chain) is deliberately separate: the 2026-10-18 audit measured SI-SDR degradation across every case; loudness normalization remains audio.process.normalize",
        storage: "mediaRoots[0]/generated-assets/audio-denoise/<jobId>/ (persistent, outside analysis cache)",
        registration: "Explicit revision-guarded media import into the source project/workspace; does not replace clips",
        unverifiedAlignment: "if correlation prominence is too low to prove alignment, processing.alignmentCheck.verdict is \"unverified\" with the measured delay still compensated",
      },
    },
    audioSeparation: {
      available: separationModelsReady.available && mediaImportAvailable,
      ...(!separationModelsReady.available
        ? {
            reason: separationModelsReady.reason,
            ...("probed" in separationModelsReady && separationModelsReady.probed === false ? { probed: false as const } : {}),
          }
        : !mediaImportAvailable ? { reason: "A media root and an operational media import bridge are required" } : {}),
      details: {
        command: "audio.process.separate",
        registrationCommand: "audio.process.register",
        provider: "local-demucs-htdemucs-python",
        component: AUDIO_MODEL_COMPONENTS.separation,
        runtime: separationModelsReady.available ? separationModelsReady.details : null,
        model: {
          ...DEMUCS_MODEL,
          displayName: "Demucs htdemucs",
          path: demucsPresence?.path ?? null,
          present: demucsPresence?.present === true,
          sizeMatches: demucsPresence === null ? null : demucsPresence.bytes === DEMUCS_MODEL.bytes,
          downloadBytes: DEMUCS_MODEL.bytes,
          estimatedDiskBytes: AUDIO_MODEL_COMPONENTS.separation.estimatedDiskBytes,
          acquisition: "Explicit consent: allowModelDownload:true downloads the pinned 84 MB weights into REELTERMINAL_DEMUCS_CACHE; or point that variable at a populated Hugging Face cache. The app never runs pip.",
        },
        targets: { vocals: "vocals stem", instrumental: "drums + bass + other (amix normalize=0)" },
        output: "48 kHz PCM 24-bit WAV, exact source-range sample window",
        maximumRangeSec: 120,
        measured: "device, load/inference seconds, realtime factor and peak GPU memory are recorded in provenance",
        limits: "bleed/artifacts are possible; overlapping speakers are not separated; no drift correction; the vocal stem is not a speech-enhancement guarantee",
        storage: "mediaRoots[0]/generated-assets/audio-separate/<jobId>/ (persistent, outside analysis cache)",
        registration: "Explicit revision-guarded media import into the source project/workspace; does not replace clips",
      },
    },
    preview,
    visualInspection,
    editorControl,
    export: exportVideo,
    verify,
  };
}

export async function buildSessionDescription(
  ctx: CapabilityContext,
  request: { kind?: "video" | "review" } = {},
): Promise<SessionDescription> {
  const caps = await buildCapabilities(ctx, request);

  return {
    facadeVersion: FACADE_VERSION,
    contractVersion: FACADE_CONTRACT_VERSION,
    runtime: ctx.live ? "live" : FACADE_RUNTIME,
    ...(request.kind ? { kind: request.kind } : {}),
    verbs: request.kind ? verbsForWorkspace(request.kind) : FACADE_VERBS,
    editOps: request.kind === "review" ? [] : EDIT_OP_TYPES,
    errorCodes: FACADE_ERROR_CODES,

    stepLetters: {
      facadeToRuntime: "P",
      // Live mode owns no project lifecycle; media import is reported from
      // the host bridge/root preflight above.
      createProject: ctx.live
        ? ctx.live.workspaceLibraryAvailable === true ? "D" : "X"
        : "P",
      importLocalMedia: caps.mediaImport.available ? "A" : "X",
      trimClip: "P",
      addTextOverlayModel: "P",
      textOverlayPixels: caps.preview.available ? "C" : "X",
      exportVideo: caps.export.available ? "C" : "X",
      verifyArtifact: caps.verify.available ? "A" : "X",
    },
    ...(ctx.live
      ? {
          access: request.kind === "review" ? ctx.review?.access ?? "read-only" : ctx.live.access,
          writer: request.kind === "review" ? ctx.review?.access === "write" : ctx.live.writer,
          leaseHolder: ctx.live.leaseHolder,
          sessionId: ctx.live.sessionId,
        }
      : {}),
    notes: request.kind === "review" ? [
      "Independent user-level review storage. No video project is created or selected; legacy workbench.* remains project-scoped.",
      "Writes require an explicit review target, current runtime identity, expected node/directory revision and a durable UUID requestId. Media paths must be inside the returned allowed roots.",
      "Review write access is separately granted for this workspace/runtime. Video write access and writer leases do not authorize review writes. Publishing a human handoff is not an agent operation.",
        "review.media.inspect and review.frames.extract read an exact node-owned reference without a video project. Frame candidates stay under review/jobs and retain their source target/revision; adding content, feedback or processing records requires an explicit review write command.",
      "The remaining legacy capability status fields describe global providers; use this scoped verb list for review command discovery.",
    ] : ctx.live ? liveNotes(ctx, caps) : headlessNotes(ctx, caps),
  };
}

function verbsForWorkspace(kind: "video" | "review"): readonly FacadeVerb[] {
  return FACADE_VERBS.filter(verb => kind === "video" ? !verb.startsWith("review.") :
    verb.startsWith("review.") || verb.startsWith("help.") || verb === "session.describe" || verb === "capabilities.get");
}

function headlessNotes(
  ctx: CapabilityContext,
  caps: Capabilities,
): string[] {
  return [
    "Project is the canonical state; mutations are atomic serialized batches.",
    caps.preview.available
      ? "Text overlays render to real pixels via the configured render provider; pixel claims are E2E-verified only through preview.render_frame + verify.artifact."
      : "Text overlays are model-state only in this session: no render provider passed preflight, so pixel rendering is NOT claimed.",
    caps.visualInspection.available
      ? "visual.inspect samples 1–12 real provider-rendered PNG frames for an explicit clip or time range; the default runtime provider is Chromium, contact-sheet composition is runtime-dependent, and individual frame artifacts remain available."
      : "visual.inspect is unavailable in this session: it needs the same artifactRoot and passing RenderProvider preflight as preview.render_frame.",
    ctx.renderAdapter
      ? `A ProjectRenderAdapter ("${ctx.renderAdapter.id}") is configured, but no facade verb consumes it.`
      : "preview and visual inspection share the RenderProvider preflight; export and verify use their own ExportProvider / ArtifactVerifier preflights, and no capability is inferred from an unrelated provider.",
    "project.create is a single-initialization lifecycle verb outside the revision machinery: it takes no expectedRevision; an exact idempotent retry replays the creation result without resetting the project, and any other create while a project is open fails CONFLICT (no replace/reset).",
    `media.import accepts local files under the configured media roots only (${ctx.mediaRoots.length} root(s)); arbitrary URLs are not accepted.`,
    "export.start snapshots the project synchronously (sourceRevision) and returns a jobId immediately; the same idempotencyKey+payload replays the same jobId. job.cancel is cooperative and always settles to a terminal state; failed/cancelled jobs never carry an artifact.",
    "project.open / project.save checkpoint the project as openreel-project@2 files inside the configured project roots; save is a snapshot (never bumps the revision) and default is no-overwrite. The idempotency ledger is never saved — mint fresh keys after every open.",
    "Idempotency ledger is per session+project+verb and does not survive process restarts.",
  ];
}

function liveNotes(
  ctx: CapabilityContext,
  caps: Capabilities,
): string[] {
  const live = ctx.live!;
  return [
    "The renderer's project store is the canonical state; this session holds NO project copy and reaches it only through the CAS-guarded LiveProjectStore seam — every read is an on-demand snapshot, every mutation one action batch applied as one undo unit.",
    `Session access "${live.access}" is enforced independently at this boundary: read-only access rejects write verbs with FORBIDDEN. CLI clients share the desktop host's external writer identity; workspace revisions and per-target queues serialize their commits. The human never takes the lease and can always edit.`,
    caps.preview.available
      ? "Text overlays render to real pixels via the configured render provider; pixel claims are E2E-verified only through preview.render_frame + verify.artifact."
      : "Text overlays are model-state only in this session: no render provider passed preflight, so pixel rendering is NOT claimed.",
    caps.visualInspection.available
      ? "visual.inspect samples 1–12 real provider-rendered PNG frames from the canonical project snapshot; the default runtime provider is Chromium, contact-sheet composition is runtime-dependent, and individual frame artifacts remain available."
      : "visual.inspect is unavailable in this session: it needs the same artifactRoot and passing RenderProvider preflight as preview.render_frame.",
    `${live.workspaceLibraryAvailable ? "project.create creates a durable project and default workspace without switching the GUI; project.save creates an immutable node in the requested workspace." : "Project, workspace, and node commands are unavailable because no workspace manager bridge was supplied."} project.open remains unavailable because the GUI owns project-file opening. Workspace-scoped commands require explicit projectId/workspaceId, and writes require expectedRevision. ${caps.mediaImport.available ? "media.import validates and imports an absolute local file through the live store bridge" : "media.import is unavailable until the live host provides media roots and its store bridge"}. Preview, visual inspection, analysis, and export use fixed snapshots of the requested project/workspace.`,
    `editor.get_context reports the real ephemeral editor context (selection, playhead, time range, canvas point) with a monotonic contextRevision; edit.apply's expectedContextRevision CAS-guards ops derived from it. ${caps.editorControl.available ? "editor.control can play, pause, seek and select/reveal without changing project revision or undo history." : "editor.control is unavailable because this is a headless session."}`,
    "export.start snapshots the project synchronously (sourceRevision) and returns a jobId immediately; the same idempotencyKey+payload replays the same jobId. job.cancel is cooperative and always settles to a terminal state; failed/cancelled jobs never carry an artifact.",
    "CLI clients share the desktop host's external writer identity; workspace queues, revisions, and idempotency ledgers isolate commits by explicit project/workspace target.",
  ];
}
