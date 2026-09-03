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
  EDIT_OP_TYPES,
  FACADE_CONTRACT_VERSION,
  FACADE_RUNTIME,
  FACADE_VERBS,
  FACADE_VERSION,
  type Capabilities,
  type CapabilityStatus,
  type FacadeVerb,
  type LiveSessionMode,
  type SessionDescription,
} from "./types";

export interface CapabilityContext {
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
    readonly mode: LiveSessionMode;
    readonly writer: boolean;
    readonly leaseHolder: string | null;
    readonly sessionId: string;
    readonly mediaImportAvailable: boolean;
    readonly unavailableVerbs: readonly FacadeVerb[];
  };
}

const UNAVAILABLE_NO_RENDER_PROVIDER: CapabilityStatus = {
  available: false,
  reason:
    "No render provider is configured for this session; preview.render_frame cannot produce pixels.",
  requires: "a RenderProvider with a passing runtime preflight (e.g. @openreel/runtime-chromium)",
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
  const mediaImportAvailable = ctx.live
    ? ctx.live.mediaImportAvailable && ctx.mediaRoots.length > 0
    : ctx.mediaRoots.length > 0;
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
  const visualInspection: CapabilityStatus = {
    ...visualRaw,
    details: {
      ...(visualRaw.details ?? {}),
      // Both modes render from file-backed media. Live mode cannot safely
      // turn renderer-owned Blob/GUI-only media into pixels in this process.
      fileBackedMediaRequired: true,
      contactSheet: typeof ctx.renderProvider?.renderContactSheetPng === "function",
      maxSamples: 12,
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
    editOps: EDIT_OP_TYPES,
    textOverlay: {
      modelState: true,
      pixelRendering: preview.available,
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
): Promise<SessionDescription> {
  const caps = await buildCapabilities(ctx);
  return {
    facadeVersion: FACADE_VERSION,
    contractVersion: FACADE_CONTRACT_VERSION,
    runtime: ctx.live ? "live" : FACADE_RUNTIME,
    verbs: FACADE_VERBS,
    editOps: EDIT_OP_TYPES,
    errorCodes: FACADE_ERROR_CODES,
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
          mode: ctx.live.mode,
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
    `Session mode "${live.mode}" is enforced at this boundary: observe runs the read-only verb set only (write verbs fail FORBIDDEN); at most one AI session holds the writer lease (write verbs without it fail CONFLICT with the holder). The human never takes the lease and can always edit.`,
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
