import { videoReviewPreflight } from "./video-review";
import { audioAnalysisPreflight, AUDIO_LIMITS } from "./audio-analysis";
import { COLOR_POLICY as COLOR_POLICY_DISCLOSURE } from "./color-policy";
import { PLUGIN_TOOLS } from "./plugins";
/**
 * Live capability reporting (fixes RUNNER-06 "capability lies by omission" —
 * and its twin, capability inflation): every claim is derived from what THIS
 * session has actually been given and from each provider's own live
 * preflight, never from a static manifest.
 *
 * Slice-1b rule (ADR 0002 #1): RenderProvider, ExportProvider and
 * ArtifactVerifier are INDEPENDENT interfaces. Injecting one never flips
 * another's capability — a runtime that can rasterize frames may still be
 * unable to encode H.264, and the dormant Slice-1 renderAdapter seam flips
 * nothing at all. A capability reports available only when (a) the facade
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
  DEFAULT_AGENT_WORK_MODE,
  agentWorkModeSemantics,
  type AgentAccessMode,
  type AgentWorkMode,
} from "./work-mode";

export interface CapabilityContext {
  /** Collaboration preference; defaults to Collaborative in headless hosts. */
  readonly workMode?: AgentWorkMode;
  readonly mediaRoots: readonly string[];
  /**
   * Roots under which export.start destinationPath may deliver a verified
   * artifact copy (`<deliveryRoot>/jobs/<slug>/output/`). Reported so agents
   * can discover the rule instead of guessing paths; empty means
   * destinationPath always fails fast with INVALID_PARAMS.
   */
  readonly deliveryRoots?: readonly string[];
  /**
   * Dormant Slice-1 seam, recorded for diagnostics only. Has NO effect on
   * any capability — no facade verb consumes it (see render/adapter.ts).
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
   * Live-session marker (ADR 0004 Decisions 6/7/11). When present the
   * reported runtime is "live" and the live-unavailable verbs are listed
   * honestly — never implied by omission. Media import is available only
   * when the host supplies both configured roots and the explicit store
   * import bridge.
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

export async function buildCapabilities(
  ctx: CapabilityContext,
): Promise<Capabilities> {
  const audioReady = await audioAnalysisPreflight();
  const videoReady = await videoReviewPreflight();
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
    preflightOf(ctx.renderProvider, UNAVAILABLE_NO_RENDER_PROVIDER),
    preflightOf(ctx.exportProvider, UNAVAILABLE_NO_EXPORT_PROVIDER),
    preflightOf(ctx.artifactVerifier, UNAVAILABLE_NO_VERIFIER),
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
    ...(ctx.live ? { unavailableVerbs: ctx.live.unavailableVerbs } : {}),
    stateModel: {
      canonicalProject: true,
      atomicBatch: true,
      revisionPreconditions: true,
      idempotencyKeys: true,
      serializedExecution: true,
    },
    mediaImport: {
      available: mediaImportAvailable,
      ...(mediaImportAvailable
        ? {}
        : {
            reason: ctx.live
              ? ctx.mediaRoots.length === 0
                ? "Live mode: no media roots are configured; media.import cannot read a local file until roots are provided."
                : "Live mode: the host did not provide the live-store media import bridge; media.import is unavailable in this session."
              : "No media roots are configured for this session; every media.import would fail until roots are provided.",
          }),
      limits: { maxFileBytes: ctx.live ? 256 * 1024 * 1024 : null, formatPolicy: "Container/track probing by mediabunny; GUI codec decode support must also succeed. No URL import.", buffering: ctx.live ? "GUI bridge currently reads the complete file into an ArrayBuffer/File" : "streamed metadata probing", overLimitAdvice: "Use explicit source segments under the byte limit while retaining originals and recording each segment source offset. No automatic proxy binding; do not silently change frame rate or treat a proxy as final-quality source." },
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
      const missing = (tool.requires ?? []).filter((requirement) => requirement === "render" ? !previewRaw.available : requirement === "artifactRoot" ? noArtifactRoot : ctx.mediaRoots.length === 0);
      return [tool.name, { available: missing.length === 0, ...(missing.length ? { reason: `Missing plugin prerequisites: ${missing.join(", ")}`, requires: missing.join(", ") } : {}), details: { effect: tool.effect, presentation: tool.presentation ?? "text" } }];
    })),
    mediaAnalysis: {
      asynchronous: true,
      types: Object.fromEntries(
        MEDIA_ANALYSIS_TYPES.map((type) => [
          type,
          type === "videoReview" ? (ctx.mediaRoots.length > 0 && !noArtifactRoot ? videoReady : { available: false, reason: "videoReview needs media roots, artifactRoot, local FFmpeg and a user-provided cloud provider credential" }) : type === "audioSummary" && ctx.mediaRoots.length > 0 ? { ...audioReady, details: { ...audioReady.details, ...AUDIO_LIMITS, maxSourceFileBytes: 2 * 1024 * 1024 * 1024, coordinateSpace: "source", changesProject: false, agentAudioConsumption: false } } : type === "technicalQuality" && ctx.mediaRoots.length > 0
            ? {
                available: true,
                details: {
                  provider: "built-in-mediabunny-stat",
                  fields: ["containerMetadata", "duration", "geometry", "codec", "fileSize", "sourceFingerprint", "color"],
                  color: COLOR_POLICY_DISCLOSURE,
                },
              }
            : type === "silence" || type === "beatGrid"
              ? !ctx.mediaRoots.length
                ? {
                    available: false,
                    reason: "No media roots are configured, so the source file cannot be read for audio analysis.",
                    requires: "a configured media root containing the source",
                  }
                : !audioReady.available
                  ? { available: false, reason: audioReady.reason }
                  : {
                      available: true,
                      details: type === "silence"
                        ? {
                            provider: "local-ffmpeg-pcm-silence-kernel",
                            kernel: "core detectSilenceRangesInPcm — the same silence kernel and defaults as the GUI silence-cut panel",
                            fields: ["silentRegions", "totalSilenceDurationSec", "parameters"],
                            defaults: { thresholdDb: -40, minDurationSec: 0.5, paddingSec: 0.1 },
                            tuning: "media.analyze_start silenceParams {thresholdDb, minDurationSec, paddingSec}",
                            workflow: "cut the reported silentRegions with clip.split + clip.rippleDelete ops in one edit.apply batch (one undo unit)",
                            coordinateSpace: "source",
                            changesProject: false,
                          }
                        : {
                            provider: "local-ffmpeg-pcm-beat-engine",
                            kernel: "core BeatDetectionEngine.analyzePcm — the same beat detector as the GUI beat-sync panel",
                            fields: ["beats", "bpm", "confidence"],
                            downbeats: "not available: no downbeat detector is installed",
                            workflow: "beat sync via clip.move + clip.trim ops; beat auto-edit plans expand via the shared core expandCutPlanToActions into clip.move/trim/add/remove ops applied as one edit.apply batch (one undo unit)",
                            coordinateSpace: "source",
                            changesProject: false,
                          },
                    }
            : type === "motion"
              ? {
                  available: false,
                  reason:
                    "Headless motion analysis is not available yet: tracking needs rendered frames. In the desktop GUI the motion-tracking engine already lands its result as transform keyframes via clip.setKeyframes (undoable, persisted, consumed by render and export).",
                  requires:
                    "a RenderProvider that supplies frames for the tracked range",
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
        details: { ops: ["subtitle.importSrt"], maxSrtBytes: 262144, maxCues: 500 },
      },
      trackControls: {
        available: true,
        details: { op: "track.update", fields: ["name", "locked", "hidden", "muted", "solo"] },
      },
      mediaRename: {
        available: true,
        details: { op: "media.rename", field: "displayName", maxNameLength: 120 },
      },
      transformKeyframes: {
        available: true,
        details: { op: "clip.setKeyframes", properties: ["opacity", "position.x", "position.y", "scale.x", "scale.y", "rotation"], maxKeyframes: 100 },
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
    editOps: EDIT_OP_TYPES,
    textOverlay: {
      modelState: true,
      pixelRendering: preview.available,
    },
    mediaRenderHtml,
    preview,
    visualInspection,
    editorControl,
    export: exportVideo,
    verify,
  };
}

export async function buildSessionDescription(
  ctx: CapabilityContext,
): Promise<SessionDescription> {
  const caps = await buildCapabilities(ctx);
  const workMode = ctx.workMode ?? DEFAULT_AGENT_WORK_MODE;
  return {
    facadeVersion: FACADE_VERSION,
    contractVersion: FACADE_CONTRACT_VERSION,
    runtime: ctx.live ? "live" : FACADE_RUNTIME,
    verbs: FACADE_VERBS,
    editOps: EDIT_OP_TYPES,
    errorCodes: FACADE_ERROR_CODES,
    workMode,
    workModeSemantics: agentWorkModeSemantics(workMode),
    stepLetters: {
      facadeToRuntime: "P",
      // Live mode owns no project lifecycle; media import is reported from
      // the host bridge/root preflight above.
      createProject: ctx.live ? "X" : "P",
      importLocalMedia: caps.mediaImport.available ? "A" : "X",
      trimClip: "P",
      addTextOverlayModel: "P",
      textOverlayPixels: caps.preview.available ? "C" : "X",
      exportVideo: caps.export.available ? "C" : "X",
      verifyArtifact: caps.verify.available ? "A" : "X",
    },
    ...(ctx.live
      ? {
          access: ctx.live.access,
          writer: ctx.live.writer,
          leaseHolder: ctx.live.leaseHolder,
          sessionId: ctx.live.sessionId,
        }
      : {}),
    notes: ctx.live ? liveNotes(ctx, caps) : headlessNotes(ctx, caps),
  };
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
      ? `a Slice-1 ProjectRenderAdapter ("${ctx.renderAdapter.id}") is injected but permanently dormant: no facade verb consumes it and it flips no capability.`
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
    `Work mode "${ctx.workMode ?? DEFAULT_AGENT_WORK_MODE}" changes default initiative and alignment density only. Session access "${live.access}" is enforced independently at this boundary: read-only access rejects write verbs with FORBIDDEN; at most one AI session holds the writer lease (write verbs without it fail CONFLICT with the holder). The human never takes the lease and can always edit.`,
    caps.preview.available
      ? "Text overlays render to real pixels via the configured render provider; pixel claims are E2E-verified only through preview.render_frame + verify.artifact."
      : "Text overlays are model-state only in this session: no render provider passed preflight, so pixel rendering is NOT claimed.",
    caps.visualInspection.available
      ? "visual.inspect samples 1–12 real provider-rendered PNG frames from the canonical project snapshot; the default runtime provider is Chromium, contact-sheet composition is runtime-dependent, and individual frame artifacts remain available."
      : "visual.inspect is unavailable in this session: it needs the same artifactRoot and passing RenderProvider preflight as preview.render_frame.",
    `project.create / project.open are unavailable in live mode (the GUI owns the project lifecycle); ${caps.mediaImport.available ? "media.import validates and imports an absolute local file through the live store bridge" : "media.import is unavailable until the live host provides media roots and its store bridge"}; project.save routes to the GUI's own save path. preview/visual inspection/export/verify run on a fresh snapshot of the canonical project and require its media to be file-backed and readable from this process.`,
    `editor.get_context reports the real ephemeral editor context (selection, playhead, time range, canvas point) with a monotonic contextRevision; edit.apply's expectedContextRevision CAS-guards ops derived from it. ${caps.editorControl.available ? "editor.control can play, pause, seek and select/reveal without changing project revision or undo history." : "editor.control is unavailable because this is a headless session."}`,
    "export.start snapshots the project synchronously (sourceRevision) and returns a jobId immediately; the same idempotencyKey+payload replays the same jobId. job.cancel is cooperative and always settles to a terminal state; failed/cancelled jobs never carry an artifact.",
    "Idempotency ledger is per session and does not survive process restarts.",
  ];
}
