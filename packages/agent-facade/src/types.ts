import { PLUGIN_TOOLS } from "./plugins";
import { assertUniqueToolNames } from "./plugin-api";
import { MATERIAL_VERBS } from "./material-library";
import { FONT_VERBS } from "./font-library";
import { PRESET_VERBS } from "./preset-verbs";
import { HELP_VERBS } from "./gui-manual";
/**
 * Public contract of the in-process agent facade (Slice 1 + Slice 1b +
 * Slice 2a persistence, ADR 0003 Decision 10).
 *
 * The facade is a pure-Node, transport-agnostic library. The core `Project`
 * is the canonical state; every mutation is an atomic, serialized,
 * revision-checked, idempotency-aware operation over that state.
 *
 * Slice 1 verbs: session.describe · capabilities.get · project.create ·
 *   project.get_state · media.import · timeline.get · edit.apply
 * Slice 1b verbs (ADR 0002): preview.render_frame · export.start ·
 *   job.status · job.cancel · verify.artifact
 * Slice 2a verbs (ADR 0003 Decision 10): project.open · project.save —
 *   the openreel-project@2 checkpoint pair (cross-session persistence).
 * Slice 3 verbs (ADR 0004 Decision 4): editor.get_context — the live/
 *   headless-honest editor-context read plus the read-only visual.inspect
 *   slice. Slice 6 grows the compact contract to 24 verbs.
 * Slice 4 widens edit.apply's closed finishing vocabulary to include clip
 *   move/split/duplicate/ripple-delete, constant speed/reverse, visual
 *   transforms/crop, audio fades, and clip transitions without adding new
 *   verbs.
 *
 * The current registry exposes 49 tools (28 base verbs + 8 material verbs +
 *   2 font verbs + 6 preset verbs + 3 help verbs + 2 bundled plugin tools);
 *   FACADE_VERBS, MATERIAL_VERBS, FONT_VERBS, PRESET_VERBS, HELP_VERBS, and
 *   PLUGIN_TOOLS below are the mechanical source of truth for the live
 *   catalog.
 *
 * Pixel/export/verify backing arrives through the independent provider
 * interfaces in providers.ts (RenderProvider / ExportProvider /
 * ArtifactVerifier); the facade itself never imports Chromium or ffmpeg.
 * MCP/CLI transports remain out of scope.
 */
import type {
  Project,
  ProjectMarkerTarget,
  ProjectSettings,
} from "@reelterminal/core/types/project";
import {
  TRANSITION_TYPES as CORE_TRANSITION_TYPES,
  type TransitionType,
} from "@reelterminal/core/types/effects";
import type { LiveEditorReferences } from "./live-store";
import type {
  ArtifactRef,
  VerifyReport,
} from "./providers";

export const FACADE_VERSION = "0.7.0" as const;
export const FACADE_CONTRACT_VERSION = "facade-slice-8" as const;
export const FACADE_RUNTIME = "node-headless" as const;

/* ------------------------------------------------------------------ */
/* Verbs                                                               */
/* ------------------------------------------------------------------ */

export const FACADE_VERBS = [
  "session.describe",
  "capabilities.get",
  "project.create",
  "project.open",
  "project.save",
  "project.rename",
  "project.get_state",
  "project.changes",
  "media.import",
  "media.render_html",
  "media.analyze_start",
  "analysis.list",
  "analysis.get",
  "timeline.get",
  "timeline.query",
  "editor.get_context",
  "editor.control",
  "edit.validate",
  "edit.apply",
  "history.get",
  "history.control",
  "preview.render_frame",
  "preview.render_comparison",
  "visual.inspect",
  "export.start",
  "job.status",
  "job.cancel",
  "verify.artifact",
  ...MATERIAL_VERBS,
  ...FONT_VERBS,
  ...PRESET_VERBS,
  ...HELP_VERBS,
  ...PLUGIN_TOOLS.map((tool) => tool.name),
] as const;

assertUniqueToolNames(FACADE_VERBS);

export type FacadeVerb = (typeof FACADE_VERBS)[number];

type DotsToUnderscores<Value extends string> =
  Value extends `${infer Head}.${infer Tail}`
    ? `${Head}_${DotsToUnderscores<Tail>}`
    : Value;

/** Canonical MCP spelling for one facade verb. */
export type FacadeToolName = DotsToUnderscores<FacadeVerb>;

/**
 * The facade owns the verb-to-tool spelling as well as the schemas. Desktop
 * live, stdio live-mcp, and agent-transport consume this registry so a newly
 * added facade verb cannot be advertised by one transport and rejected by
 * another stale allowlist.
 */
export function facadeToolNameForVerb(verb: FacadeVerb): FacadeToolName {
  return verb.replace(/\./g, "_") as FacadeToolName;
}

export const FACADE_TOOL_NAMES = FACADE_VERBS.map(
  facadeToolNameForVerb,
) as readonly FacadeToolName[];

export const FACADE_TOOL_TO_VERB: Readonly<
  Record<FacadeToolName, FacadeVerb>
> = Object.fromEntries(
  FACADE_VERBS.map((verb) => [facadeToolNameForVerb(verb), verb]),
) as Readonly<Record<FacadeToolName, FacadeVerb>>;

export const FACADE_VERB_TO_TOOL: Readonly<
  Record<FacadeVerb, FacadeToolName>
> = Object.fromEntries(
  FACADE_VERBS.map((verb) => [verb, facadeToolNameForVerb(verb)]),
) as Readonly<Record<FacadeVerb, FacadeToolName>>;

/* ------------------------------------------------------------------ */
/* Access authorization + the read-only verb gate                                */
/* ------------------------------------------------------------------ */

export type {
  AgentAccessMode,
} from "./access";

import type {
  AgentAccessMode,
} from "./access";

/**
 * The read-only verb set every live access mode may call. A read-only session rejects writes FORBIDDEN;
 * a writer-less write session rejects them CONFLICT with holder information.
 */
export const READ_ONLY_VERBS = [
  "session.describe",
  "capabilities.get",
  "project.get_state",
  "project.changes",
  "media.analyze_start",
  "analysis.list",
  "analysis.get",
  "timeline.get",
  "timeline.query",
  "editor.get_context",
  "editor.control",
  "edit.validate",
  "history.get",
  "material.list",
  "material.get",
  "font.list",
  "preset.list",
  "preset.get",
  "help.list_screens",
  "help.describe",
  "help.search",
  "visual.inspect",
  "preview.render_comparison",
  "job.status",
  "verify.artifact",
  ...PLUGIN_TOOLS.filter((tool) => tool.effect === "read").map((tool) => tool.name),
] as const satisfies readonly FacadeVerb[];

export type ReadOnlyVerb = (typeof READ_ONLY_VERBS)[number];

export function isReadOnlyVerb(verb: FacadeVerb): verb is ReadOnlyVerb {
  return (READ_ONLY_VERBS as readonly string[]).includes(verb) || PLUGIN_TOOLS.some((tool) => tool.name === verb && tool.effect === "read");
}

/* ------------------------------------------------------------------ */
/* session.describe                                                    */
/* ------------------------------------------------------------------ */

/**
 * Runtime classification per E2E step (audit/e2e-contract.md letters:
 * P pure Node · A adapter · C Chromium · D desktop · X missing/unverified).
 * Pixel/export/verify letters are computed live from provider preflights:
 * they stay "X" until the capability is genuinely usable in THIS session.
 */
export interface StepLetters {
  readonly facadeToRuntime: "P";
  /** "X" in live sessions: project.create is unavailable (the GUI owns the project lifecycle). */
  readonly createProject: "P" | "X";
  /** "A" when live roots + bridge are available; "X" otherwise. */
  readonly importLocalMedia: "A" | "X";
  readonly trimClip: "P";
  readonly addTextOverlayModel: "P";
  readonly textOverlayPixels: "X" | "C";
  readonly exportVideo: "X" | "C";
  readonly verifyArtifact: "X" | "A";
}

export interface SessionDescription {
  readonly facadeVersion: string;
  readonly contractVersion: string;
  /** "node-headless" for AgentFacadeSession; "live" for createLiveFacade sessions. */
  readonly runtime: typeof FACADE_RUNTIME | "live";
  readonly verbs: readonly FacadeVerb[];
  readonly editOps: readonly EditOpType[];
  readonly errorCodes: readonly string[];
  readonly stepLetters: StepLetters;
  readonly notes: readonly string[];
  /** Current collaboration preference; present in live and headless sessions. */
  /** Live-only explicit authorization field. */
  readonly access?: AgentAccessMode;
  /** True when this session currently holds the writer lease. */
  readonly writer?: boolean;
  /** Current lease holder's sessionId (null when the lease is free). */
  readonly leaseHolder?: string | null;
  readonly sessionId?: string;
}

/* ------------------------------------------------------------------ */
/* capabilities.get                                                    */
/* ------------------------------------------------------------------ */

export interface CapabilityStatus {
  readonly available: boolean;
  /** Present when unavailable: why, in plain language. */
  readonly reason?: string;
  /** What would be required to make it available (audit letter/seam). */
  readonly requires?: string;
  /**
   * Machine-readable detail surfaced from the provider's live preflight
   * (e.g. export route, and for the explicitly forced video-only frames
   * route the `videoOnly`/`audio:"none"` markers — limitations are part of
   * the capability, never a footnote).
   */
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface Capabilities {
  readonly pluginTools: Readonly<Record<string, CapabilityStatus>>;
  /** "node-headless" for AgentFacadeSession; "live" for createLiveFacade sessions. */
  readonly runtime: typeof FACADE_RUNTIME | "live";
  /**
   * Verbs that exist in the contract but are honestly unavailable in THIS
   * session's mode (ADR 0004 Decision 11: live sessions report their
   * GUI-owned/unavailable verbs here). Absent in headless
   * sessions, where availability is reported per-capability below. In live
   * sessions only project.create/open are always GUI-owned; media.import is
   * available through the host bridge when configured.
   */
  readonly unavailableVerbs?: readonly FacadeVerb[];
  readonly stateModel: {
    readonly canonicalProject: true;
    readonly atomicBatch: true;
    readonly revisionPreconditions: true;
    readonly idempotencyKeys: true;
    readonly serializedExecution: true;
  };
  readonly mediaImport: {
    readonly limits: Readonly<Record<string, unknown>>;
    /** False when no media roots are configured (imports would all fail). */
    readonly available: boolean;
    /** Present when unavailable: why, in plain language. */
    readonly reason?: string;
    readonly sources: readonly ["file"];
    /** Absolute roots the caller allowed; imports outside them fail. */
    readonly mediaRoots: readonly string[];
    /**
     * Preferred absolute root for a new Agent-owned job workspace. This is
     * the first configured media root, or null when imports are unavailable.
     * Callers should still treat mediaRoots as the containment authority.
     */
    readonly recommendedRoot: string | null;
    /** Machine-readable default layout for one self-contained creation job. */
    readonly workspaceLayout: {
      readonly jobDirectoryPattern: "jobs/<YYYY-MM-DD>-<short-slug>";
      readonly sharedDirectory: "shared";
      readonly jobEntries: readonly [
        "brief.md",
        "source",
        "generated",
        "work",
        "project",
        "output",
        "evidence",
      ];
      readonly deliverablesDirectory: "output";
    };
    readonly urlImport: false;
    readonly metadata: readonly ["duration", "width", "height", "mediaType"];
  };
  readonly projectChanges: CapabilityStatus;
  readonly history: CapabilityStatus;
  /** User-level material library (material.* verbs); headless reports unavailable. */
  readonly materialLibrary: import("./material-library").MaterialLibraryCapability;
  /** User-level custom fonts (font.* verbs); headless reports unavailable. */
  readonly fonts: import("./font-library").FontLibraryCapability;
  /** User-level custom presets (preset.* verbs); headless reports unavailable. */
  readonly customPresets: import("./preset-verbs").CustomPresetCapability;
  /** Shipped GUI manual (help.* verbs); static content, available in every mode. */
  readonly manual: import("./gui-manual").ManualCapability;
  readonly mediaAnalysis: {
    readonly asynchronous: true;
    readonly types: Readonly<Record<MediaAnalysisType, CapabilityStatus>>;
    readonly largeResultsAsArtifacts: true;
  };
  readonly professionalEditing: Readonly<{
    subtitles: CapabilityStatus;
    trackControls: CapabilityStatus;
    mediaRename: CapabilityStatus;
    transformKeyframes: CapabilityStatus;
    volumeKeyframes: CapabilityStatus;
    basicColorGrade: CapabilityStatus;
    /** Additive clip video-effect stack op (Auto-Color preset documented as a fixed three-effect combo). */
    videoEffects: CapabilityStatus;
    chromaKey: CapabilityStatus;
    noiseReduction: CapabilityStatus;
    svgOverlays: CapabilityStatus;
    lut: CapabilityStatus;
    audioNormalization: CapabilityStatus;
    audioDucking: CapabilityStatus;
    backgroundRemoval: CapabilityStatus;
    vocalIsolation: CapabilityStatus;
    stabilization: CapabilityStatus;
    smartReframe: CapabilityStatus;
    proxyMedia: CapabilityStatus;
    relink: CapabilityStatus;
    exportPresets: CapabilityStatus;
    exportPreflight: CapabilityStatus;
  }>;
  readonly editOps: readonly EditOpType[];
  readonly textOverlay: {
    readonly modelState: true;
    /**
     * True only when a render provider passed its live preflight in THIS
     * session (text pixels can actually be produced and inspected).
     */
    readonly pixelRendering: boolean;
  };
  readonly preview: CapabilityStatus;
  /**
   * media.render_html backing: constrained HTML/CSS → PNG into a media
   * root. Availability is the render provider's Chromium supply (the SAME
   * pool preview uses) plus a configured media root for the output — it
   * needs a local playwright Chromium and says so honestly.
   */
  readonly mediaRenderHtml: CapabilityStatus;
  /** visual.inspect backing; mirrors the real frame renderer and artifact root gate. */
  readonly visualInspection: CapabilityStatus;
  /** Ephemeral live-editor playback/selection/reveal controls. */
  readonly editorControl: CapabilityStatus;
  readonly export: CapabilityStatus;
  /** verify.artifact backing (ffprobe/ffmpeg + pixel comparison). */
  readonly verify: CapabilityStatus;
}

/* ------------------------------------------------------------------ */
/* project.*                                                           */
/* ------------------------------------------------------------------ */

/**
 * project.create is a SINGLE-INITIALIZATION lifecycle verb: it opens the
 * session's one and only project. It lives OUTSIDE the project revision
 * machinery — the project does not exist yet, so there is no revision to
 * precondition on, and this verb accepts no `expectedRevision`. At-most-once
 * semantics across transport retries come from `idempotencyKey` alone:
 * a retry carrying the same key and the same payload replays the committed
 * creation result WITHOUT resetting the project; the same key with a
 * different payload — like any other create attempted while a project is
 * open — fails CONFLICT. Slice 1 ships no replace/reset verb.
 */
export interface ProjectCreateParams {
  readonly name?: string;
  /**
   * Hardened subset: width/height/sampleRate/channels must be positive
   * integers, frameRate a positive finite number. Only the sanitized,
   * schema-validated copy reaches the project.
   */
  readonly settings?: Partial<ProjectSettings>;
  readonly idempotencyKey?: string;
}

export interface ProjectCounts {
  readonly tracks: number;
  readonly clips: number;
  readonly mediaItems: number;
  readonly textOverlays: number;
}

export interface ProjectState {
  readonly revision: number;
  /**
   * Deep-cloned, JSON-serializable canonical project. Callers may not mutate
   * facade state through this reference (it is a fresh clone).
   */
  readonly project: Project;
  readonly counts: ProjectCounts;
}

/**
 * project.create result: the freshly created project state plus the replay
 * marker. `replayed: true` means the call was an exact idempotent retry
 * (same idempotencyKey + same payload) and the returned state is the
 * committed creation snapshot — the live project was NOT reset or touched.
 */
export interface ProjectCreateResult extends ProjectState {
  readonly replayed: boolean;
}

/* ------------------------------------------------------------------ */
/* project.open / project.save (Slice 2a, ADR 0003 Decision 10)        */
/* ------------------------------------------------------------------ */

/**
 * project.open is a SINGLE-INITIALIZATION lifecycle verb like
 * project.create: legal only in a session with no active project (with one
 * active it fails CONFLICT — it can never silently replace or reset a live
 * project). It lives outside the revision machinery (no expectedRevision);
 * the optional idempotencyKey carries create-style replay semantics: an
 * exact retry returns the committed open snapshot without re-reading the
 * file; the same key with a different payload ⇒ CONFLICT.
 */
export interface ProjectOpenParams {
  /** Absolute checkpoint path; must resolve inside a configured projectRoot. */
  readonly path: string;
  readonly idempotencyKey?: string;
}

/**
 * project.open result: the adopted project state (at the SAVED revision —
 * the next committed mutation bumps revision + 1) plus the replay marker.
 */
export interface ProjectOpenResult extends ProjectState {
  readonly replayed: boolean;
}

/**
 * project.save is a SNAPSHOT, not a mutation: no revision bump, no ledger
 * entry, no idempotencyKey. The optional expectedRevision is a pure guard
 * (CONFLICT if the session has moved on). Default is no-overwrite: an
 * existing target (file or dangling symlink) fails CONFLICT — pick a fresh
 * versioned checkpoint path per milestone; overwrite:true is the explicit
 * opt-in for replacing one's own checkpoint and still refuses symlinks.
 */
export interface ProjectSaveParams {
  /** Absolute checkpoint path; must resolve inside a configured projectRoot. */
  readonly path: string;
  readonly expectedRevision?: number;
  readonly overwrite?: boolean;
}

export interface ProjectSaveResult {
  /** The path exactly as the caller passed it. */
  readonly path: string;
  /** The pre-save revision (saving never bumps it). */
  readonly revision: number;
  readonly bytesWritten: number;
  readonly stateSha256: string;
  /** ms epoch of the save. */
  readonly savedAt: number;
}

/**
 * Live-mode project.save result (ADR 0004 Decision 11): the save is routed
 * to the GUI's own save path via LiveProjectStore.requestSave(), so the
 * facade honestly has no checkpoint path/bytes/hash to report — the GUI
 * owns where and how the project file is written. Only the revision at
 * save time is known. Live project.save takes no params (no path, no
 * overwrite): the GUI owns both.
 */
export interface LiveProjectSaveResult {
  readonly revision: number;
}

/** Rename the open project without changing its backing checkpoint path. */
export interface ProjectRenameParams {
  readonly name: string;
  readonly expectedRevision?: number;
  readonly idempotencyKey?: string;
}

export interface ProjectRenameResult {
  readonly revision: number;
  readonly projectId: string;
  readonly previousName: string;
  readonly name: string;
  readonly replayed: boolean;
}

/* ------------------------------------------------------------------ */
/* project.changes — bounded structural deltas                         */
/* ------------------------------------------------------------------ */

export type ProjectChangeEntityType =
  | "project"
  | "track"
  | "clip"
  | "text"
  | "svg"
  | "media"
  | "transition"
  | "marker"
  | "subtitle";

export interface ProjectChange {
  readonly revision: number;
  readonly change: "added" | "updated" | "removed";
  readonly entityType: ProjectChangeEntityType;
  readonly entityId: string;
  /** Changed top-level fields; ["*"] denotes creation or removal. */
  readonly fields: readonly string[];
}

export interface ProjectChangesParams {
  readonly sinceRevision: number;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ProjectChangesResult {
  readonly fromRevision: number;
  readonly toRevision: number;
  readonly changes: readonly ProjectChange[];
  readonly nextCursor: string | null;
  /** True when the requested base predates the retained in-memory journal. */
  readonly requiresFullRefresh: boolean;
}

/* ------------------------------------------------------------------ */
/* media.import                                                        */
/* ------------------------------------------------------------------ */

export interface MediaImportParams {
  /** Local file path. Must resolve inside one of the configured media roots. */
  readonly path: string;
  readonly name?: string;
  readonly expectedRevision?: number;
  readonly idempotencyKey?: string;
}

export interface ImportedMediaMetadata {
  readonly durationSec: number;
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly codec: string;
  readonly fileSize: number;
}

export interface MediaImportResult {
  readonly revision: number;
  readonly mediaId: string;
  readonly name: string;
  /** The adapter probes audio/video containers via mediabunny and images via header parsing. */
  readonly type: "video" | "audio" | "image";
  readonly metadata: ImportedMediaMetadata;
  readonly replayed: boolean;
}

/* ------------------------------------------------------------------ */
/* media.render_html                                                   */
/* ------------------------------------------------------------------ */

/**
 * Constrained HTML/CSS → PNG rendering under the session's media roots.
 * The verb writes a FILE (a mutation for the read-only/writer gates and the
 * idempotency ledger) but never touches project state — the returned path is
 * meant to flow straight into media.import. Content is gated by the core
 * HTML policy (scripts, frames, external references… are rejected); local
 * subresources resolve only inside assetsRoot; the output PNG is
 * temp-then-published, sha256-hashed and re-inspected (PNG magic + IHDR).
 */
export interface MediaRenderHtmlParams {
  /**
   * {"kind":"path","path":...} — an .html file inside a configured media
   * root (relative subresources default to its directory), or
   * {"kind":"inline","html":...} — raw markup up to 512 KiB (relative
   * subresources then require assetsRoot).
   */
  readonly source: MediaRenderHtmlSource;
  /**
   * Absolute root for local subresources; must sit inside a media root.
   * Every reference outside it is blocked and reported in missingAssets.
   */
  readonly assetsRoot?: string;
  /** Output raster size: even integers in [2, 4096]. */
  readonly width: number;
  readonly height: number;
  /** Transparent page background (omitBackground). Default true. */
  readonly transparent?: boolean;
  /** Hard deadline for the whole render. Default 30000, max 120000. */
  readonly timeoutMs?: number;
  /**
   * Absolute output directory inside a media root. Default:
   * `<mediaRoots[0]>/jobs/html-render/<requestKey>/`.
   */
  readonly outputDir?: string;
  readonly expectedRevision?: number;
  readonly idempotencyKey?: string;
}

export type MediaRenderHtmlSource =
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "inline"; readonly html: string };

export interface MediaRenderHtmlResult {
  /** Published artifact path (inside a media root) — pass it to media.import. */
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
  readonly bytes: number;
  /** Subresources that were blocked or missing (render still succeeded). */
  readonly missingAssets: readonly string[];
  readonly replayed: boolean;
}

export const MEDIA_ANALYSIS_TYPES = [  "technicalQuality",
  "audioSummary",
  "videoReview",
  "sceneCuts",
  "silence",
  "beatGrid",
  "speechTranscript",
  "loudness",
  "blackFrames",
  "duplicateFrames",
  "motion",
  "faces",
] as const;

export type MediaAnalysisType = (typeof MEDIA_ANALYSIS_TYPES)[number];

/**
 * Tuning for the "silence" analysis type. Defaults match the GUI silence-cut
 * panel (−40 dB threshold, 0.5 s minimum silence, 0.1 s padding) and run the
 * same core detectSilenceRangesInPcm kernel the GUI bridge uses.
 */
export interface MediaSilenceAnalysisParams {
  /** Threshold in dBFS; a window is silent when max amplitude stays below it. Default −40 (GUI default). */
  readonly thresholdDb?: number;
  /** Minimum padded-region duration in seconds to report. Default 0.5 (GUI default). */
  readonly minDurationSec?: number;
  /** Seconds each detected range is pulled in on both sides. Default 0.1 (GUI default). */
  readonly paddingSec?: number;
}

export interface MediaAnalyzeStartParams {
  /** Explicit consent to send this range to the configured Alibaba cloud service. */
  readonly cloudUpload?: boolean;
  readonly reviewQuestion?: string;
  /** Original media seconds; audioSummary/silence/beatGrid maximum 120s, videoReview explicit range maximum 20s. */
  readonly startSec?: number;
  readonly endSec?: number;
  readonly mediaId: string;
  readonly analysisTypes: readonly MediaAnalysisType[];
  /** Silence analysis tuning; valid only when analysisTypes includes "silence". Omitted fields keep the GUI-aligned defaults. */
  readonly silenceParams?: MediaSilenceAnalysisParams;
  /**
   * Re-check linkage: the id of a previous analysis record. The new run uses
   * the same configuration discipline and its record links back via
   * recheckOf, giving before/after evidence in one analysis.list query.
   */
  readonly recheckOfRecordId?: string;
  readonly expectedRevision?: number;
  readonly idempotencyKey?: string;
}

export interface MediaAnalyzeStartResult {
  readonly jobId: string;
  readonly kind: "analysis";
  readonly state: "queued" | "running" | "done" | "error" | "cancelled";
  readonly sourceRevision: number;
  readonly analysisTypes: readonly MediaAnalysisType[];
  readonly replayed: boolean;
}

export interface AnalysisJobResult {
  readonly analysisTypes: readonly MediaAnalysisType[];
  /** Bounded result summary. Large providers must return ArtifactRefs instead. */
  readonly summary: Readonly<Record<string, unknown>>;
  readonly artifacts: readonly ArtifactRef[];
}

/* ------------------------------------------------------------------ */
/* timeline.get                                                        */
/* ------------------------------------------------------------------ */

export interface TimelineClipView {
  readonly id: string;
  readonly trackId: string;
  readonly mediaId: string;
  readonly startTime: number;
  readonly duration: number;
  readonly inPoint: number;
  readonly outPoint: number;
  /** Effective linear audio gain; 0 = mute, 1 = unity. */
  readonly volume: number;
  /** Effective constant playback speed; defaults to 1. */
  readonly speed: number;
  readonly reversed: boolean;
  /** Effective audio fades in seconds; missing model values normalize to 0. */
  readonly fade: { readonly fadeIn: number; readonly fadeOut: number };
  /** Persisted basic/LUT grade; null when none is applied. */
  readonly colorGrading: Readonly<Record<string, unknown>> | null;
  readonly keyframes: readonly {
    readonly id: string;
    readonly property: string;
    readonly time: number;
    readonly value: unknown;
    readonly easing: string;
  }[];
  readonly transform: {
    /** Pixel offset from the project-frame center. */
    readonly position: { readonly x: number; readonly y: number };
    readonly scale: { readonly x: number; readonly y: number };
    /** Clockwise degrees. */
    readonly rotation: number;
    readonly anchor: NormalizedPoint;
    readonly opacity: number;
    readonly fitMode: "contain" | "cover" | "stretch" | "none";
    /** Normalized source rectangle, or null when the full source is used. */
    readonly crop: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    } | null;
  };
}

export interface TimelineTrackView {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly locked: boolean;
  readonly hidden: boolean;
  readonly muted: boolean;
  readonly solo: boolean;
  readonly clips: readonly TimelineClipView[];
  readonly transitions: readonly TimelineTransitionView[];
}

export interface TimelineTransitionView {
  readonly id: string;
  readonly clipAId: string;
  readonly clipBId: string | null;
  readonly edge: "in" | "out" | null;
  readonly type: TransitionType;
  readonly duration: number;
}

export interface TextOverlayView {
  readonly id: string;
  readonly trackId: string;
  readonly text: string;
  readonly startTime: number;
  readonly duration: number;
  /** Normalized box position, read from the clip's transform. */
  readonly position: NormalizedPoint;
  /** Normalized anchor within the text box, read from the clip's transform. */
  readonly anchor: NormalizedPoint;
}

/** One persisted project marker as timeline.get reports it. */
export interface ProjectMarkerView {
  /** Namespaced persisted review-marker id (R1, R2, ...). */
  readonly ref: string;
  readonly number: number;
  readonly id: string;
  readonly target: ProjectMarkerTarget;
  readonly label?: string;
  readonly color?: string;
  readonly createdAt: number;
}

export interface TimelineSubtitleView {
  readonly id: string;
  readonly text: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly style: Readonly<Record<string, unknown>> | null;
}

export interface TimelineState {
  readonly revision: number;
  readonly duration: number;
  readonly tracks: readonly TimelineTrackView[];
  readonly textOverlays: readonly TextOverlayView[];
  readonly subtitles: readonly TimelineSubtitleView[];
  /** Project markers sorted by their stable number. */
  readonly markers: readonly ProjectMarkerView[];
}

/* ------------------------------------------------------------------ */
/* timeline.query — bounded local timeline reads                       */
/* ------------------------------------------------------------------ */

export type TimelineQueryEntityType =
  | "track"
  | "clip"
  | "text"
  | "svg"
  | "media"
  | "transition"
  | "marker"
  | "subtitle"
  | "workAsset";

export type TimelineQueryField =
  | "name"
  | "displayName"
  | "type"
  | "trackId"
  | "mediaId"
  | "startTime"
  | "duration"
  | "inPoint"
  | "outPoint"
  | "text"
  | "volume"
  | "speed"
  | "reversed"
  | "transform"
  | "keyframes"
  | "automation"
  | "locked"
  | "muted"
  | "hidden"
  | "solo"
  | "target"
  | "style"
  | "color"
  | "colorGrading"
  | "chromaKey"
  | "noiseReduction"
  | "viewBox"
  | "colorStyle"
  | "sourceMediaId"
  | "sourceRange"
  | "unsupportedParams"
  | "missingSource"
  | "effectCount"
  | "audioEffectCount"
  | "keyframeCount"
  | "memberCount"
  | "laneSummary"
  | "spanSec"
  | "missingMemberCount"
  | "transitionsCaptured"
  | "captureRequestId"
  | "createdAt";

export interface TimelineQueryParams {
  /** Only ephemeral @A<n> refs and persisted R<n> review refs are accepted. */
  readonly refs?: readonly string[];
  readonly entityIds?: readonly string[];
  readonly timeRange?: { readonly startSec: number; readonly endSec: number };
  readonly trackIds?: readonly string[];
  readonly trackTypes?: readonly TrackType[];
  readonly entityTypes?: readonly TimelineQueryEntityType[];
  readonly fields?: readonly TimelineQueryField[];
  readonly limit?: number;
  readonly cursor?: string;
  readonly includeNeighbors?: number;
}

export interface TimelineQueryEntity {
  readonly entityType: TimelineQueryEntityType;
  readonly id: string;
  readonly ref: string | null;
  readonly trackId: string | null;
  readonly startTime: number | null;
  readonly endTime: number | null;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface TimelineQueryResult {
  readonly revision: number;
  readonly items: readonly TimelineQueryEntity[];
  readonly nextCursor: string | null;
}

/* ------------------------------------------------------------------ */
/* editor.get_context (ADR 0004 Decision 4)                             */
/* ------------------------------------------------------------------ */

/**
 * editor.get_context — the Mutual Legibility read. Live sessions report the
 * real ephemeral editor context (selection, playhead, time range, canvas
 * point, and stable-numbered agent references) with a monotonic
 * contextRevision the agent can CAS against via edit.apply's
 * expectedContextRevision. Headless sessions have no editor: they answer
 * honestly with contextAvailable:false and every context field null/empty —
 * never fabricated values.
 */
export interface EditorGetContextResult {
  readonly mode: "live" | "headless";
  /** The project revision at the moment of the read. */
  readonly projectRevision: number;
  /**
   * False in headless sessions (no editor exists): every context field is
   * then null/empty and contextRevision is null. True in live sessions.
   */
  readonly contextAvailable: boolean;
  readonly contextRevision: number | null;
  readonly playheadSeconds: number | null;
  readonly selectedClipIds: readonly string[];
  readonly selectedTextIds: readonly string[];
  readonly selectedMediaIds: readonly string[];
  readonly timeRange: {
    readonly startSeconds: number;
    readonly endSeconds: number;
  } | null;
  /** Normalized 0..1 point on the project frame (the "agent target point"). */
  readonly canvasPoint: { readonly x: number; readonly y: number } | null;
  /** Ephemeral editor-session references keyed by their stable number. */
  readonly references: LiveEditorReferences;
  /** Compact project requirement signal; fetch details with reelctl requirements. */
  readonly requirements: {
    readonly ready: number;
    readonly inProgress: number;
    readonly ids: readonly string[];
  };
  readonly identity: {
    readonly projectId: string | null;
    readonly projectName: string | null;
    readonly projectEpoch?: string;
    /** Null in headless sessions (no window exists). */
    readonly windowId: string | null;
  };
}

export interface ReferenceSetComparisonOp {
  readonly op: "reference.setComparison";
  readonly config: {
    readonly referenceMediaId: string;
    readonly refStartSec: number;
    readonly refEndSec: number;
    readonly timelineStartSec: number;
    readonly rate: 1;
    readonly audioSide: "timeline" | "reference" | "none";
    readonly layout: "side-by-side" | "overlay";
    readonly overlayOpacity?: number;
  };
}

export interface ReferenceClearComparisonOp {
  readonly op: "reference.clearComparison";
}

/**
 * Replace the SOURCE of timeline references with a new production version:
 * the new file imports as its own media item (the old file is never
 * overwritten or removed), clips are repointed with their edits preserved,
 * and timing is clamped to the new source's duration — the timeline never
 * extends. One edit.apply batch = one atomic undo unit.
 */
export interface MediaReplaceOp {
  readonly op: "media.replace";
  /** Media item whose source the references switch away from. */
  readonly mediaId: string;
  /** Absolute path of the new version, inside a configured media root. */
  readonly filePath: string;
  /** "project" repoints every clip referencing mediaId; "clip" only clipId. */
  readonly scope: "project" | "clip";
  /** Required when scope is "clip". */
  readonly clipId?: string;
  /** Internal: probed media item injected by the session's async pre-pass. */
  readonly probedMediaItem?: unknown;
}

/**
 * Relink a missing/moved source FILE for one media item — same content, new
 * location. Deliberately NOT a version replacement (use media.replace).
 */
export interface MediaRelinkOp {
  readonly op: "media.relink";
  readonly mediaId: string;
  /** Absolute path of the same content's new location, inside a media root. */
  readonly filePath: string;
  /** Internal: file facts injected by the session's async pre-pass. */
  readonly probedFileFacts?: { name: string; size: number; lastModified: number };
}

/* ------------------------------------------------------------------ */
/* edit.apply — closed op set (Slice 1 + widened op vocabulary)        */
/* ------------------------------------------------------------------ */

export const EDIT_OP_TYPES = [
  "track.add",
  "clip.add",
  "clip.move",
  "clip.trim",
  "clip.split",
  "clip.duplicate",
  "clip.rippleDelete",
  "text.create",
  "text.update",
  "text.delete",
  "clip.setSpeed",
  "clip.setReverse",
  "clip.setTransform",
  "clip.setVolume",
  "clip.setFade",
  "clip.remove",
  "transition.add",
  "transition.update",
  "transition.remove",
  "track.remove",
  "media.remove",
  "marker.add",
  "marker.remove",
  "requirement.update",
  "track.update",
  "subtitle.importSrt",
  "clip.setColorGrade",
  "clip.setKeyframes",
  "clip.applyReframe",
  "reference.setComparison",
  "reference.clearComparison",
  "media.replace",
  "media.relink",
  "media.rename",
  "clip.setChromaKey",
  "clip.setNoiseReduction",
  "clip.setDucking",
  "clip.setBackgroundRemoval",
  "svg.create",
  "svg.update",
  "svg.remove",
  "clip.addVideoEffect",
  "workAsset.capture",
  "workAsset.rename",
  "workAsset.delete",
  "workAsset.instantiate",
] as const;

export type EditOpType = (typeof EDIT_OP_TYPES)[number];

export const TRACK_TYPES = [
  "video",
  "audio",
  "image",
  "text",
  "graphics",
] as const;

export type TrackType = (typeof TRACK_TYPES)[number];

export interface TrackAddOp {
  readonly op: "track.add";
  readonly trackType: TrackType;
  /** Optional deterministic id; a fresh one is minted when omitted. */
  readonly trackId?: string;
  /**
   * Zero-based insertion index in project.timeline.tracks — the z-order
   * (later tracks composite ON TOP of earlier ones). Omitted appends on top.
   * Needed to layer a foreground track above background tracks that cut
   * underneath it (cross-shot continuity).
   */
  readonly position?: number;
}

/** Rename or change canonical track state through the same actions as the GUI. */
export interface TrackUpdateOp {
  readonly op: "track.update";
  readonly trackId: string;
  readonly name?: string;
  readonly locked?: boolean;
  readonly hidden?: boolean;
  readonly muted?: boolean;
  readonly solo?: boolean;
}

/** Remove one existing, empty timeline track. Content must be removed first. */
export interface TrackRemoveOp {
  readonly op: "track.remove";
  readonly trackId: string;
}

/** Remove one imported media item that is not referenced by any timeline clip. */
export interface MediaRemoveOp {
  readonly op: "media.remove";
  readonly mediaId: string;
}

/**
 * Rename ONE media item's user-facing display name. The source filename
 * (`MediaItem.name`) and the file on disk are never touched; display sites
 * resolve displayName ?? name, so old projects without a displayName keep
 * showing the source filename.
 */
export interface MediaRenameOp {
  readonly op: "media.rename";
  readonly mediaId: string;
  /** New display name: 1..120 characters after trim. */
  readonly displayName: string;
}

export interface ClipAddOp {
  readonly op: "clip.add";
  readonly trackId: string;
  readonly mediaId: string;
  readonly startTime: number;
  readonly duration?: number;
  readonly inPoint?: number;
  readonly outPoint?: number;
  /**
   * Optional deterministic id, so later ops in the SAME batch (e.g.
   * clip.trim) can reference the clip. A fresh id is minted when omitted;
   * created ids are always reported in the result.
   */
  readonly clipId?: string;
}

export interface ClipTrimOp {
  readonly op: "clip.trim";
  readonly clipId: string;
  /** At least one of inPoint/outPoint is required. */
  readonly inPoint?: number;
  readonly outPoint?: number;
}

export interface ClipMoveOp {
  readonly op: "clip.move";
  readonly clipId: string;
  /** Absolute timeline position in seconds. */
  readonly startTime: number;
  /** Optional destination track; omitted keeps the current track. */
  readonly trackId?: string;
}

export interface ClipSplitOp {
  readonly op: "clip.split";
  readonly clipId: string;
  /** Absolute timeline time strictly inside the clip bounds. */
  readonly time: number;
}

export interface ClipDuplicateOp {
  readonly op: "clip.duplicate";
  readonly clipId: string;
  /** Optional destination track; omitted keeps the source track. */
  readonly trackId?: string;
  /**
   * Optional absolute timeline position. When omitted, ReelTerminal uses the
   * same next-free-gap placement as the editor's Duplicate command.
   */
  readonly startTime?: number;
}

export interface ClipRippleDeleteOp {
  readonly op: "clip.rippleDelete";
  readonly clipId: string;
}

/** Closed style subset accepted by text.create/text.update in this slice. */
export interface TextStyleInput {
  readonly fontFamily?: string;
  readonly fontSize?: number;
  readonly fontWeight?: import("@reelterminal/core/text/types").FontWeight;
  readonly color?: string;
  readonly textAlign?: "left" | "center" | "right" | "justify";
}

/**
 * Normalized 0..1 point. Resolution-independent: multiplied by the frame
 * width/height at render time, so preview and export place it identically.
 */
export interface NormalizedPoint {
  readonly x: number;
  readonly y: number;
}

export interface TextCreateOp {
  readonly op: "text.create";
  readonly text: string;
  readonly startTime: number;
  readonly duration: number;
  /**
   * Target text track. When omitted, the first existing text track is used;
   * if none exists, edit.apply creates a text track in the same atomic batch
   * and undo unit before creating the overlay.
   */
  readonly trackId?: string;
  readonly style?: TextStyleInput;
  /** Normalized box position (0.5/0.5 = frame center). */
  readonly position?: NormalizedPoint;
  /** Normalized anchor within the text box (0.5/0.5 = box center). */
  readonly anchor?: NormalizedPoint;
}

/**
 * Shallow-looking update over ONE existing text overlay (id from
 * timeline.get/project.get_state textOverlays[].id). At least one optional
 * field is required. style MERGES with the existing style and position/anchor
 * merge with the existing transform — omitted fields keep their values.
 */
export interface TextUpdateOp {
  readonly op: "text.update";
  readonly overlayId: string;
  readonly text?: string;
  readonly startTime?: number;
  readonly duration?: number;
  readonly style?: TextStyleInput;
  readonly position?: NormalizedPoint;
  readonly anchor?: NormalizedPoint;
}

export interface TextDeleteOp {
  readonly op: "text.delete";
  readonly overlayId: string;
}

/**
 * Create ONE SVG overlay from Agent-generated inline markup — the same
 * project content the GUI SVG import produces. The raw markup crosses the
 * shared core ingest gate (scripts, foreign objects, event handlers, unsafe
 * URL schemes, external references and oversized documents are rejected).
 * When the project has no graphics track yet, edit.apply creates one in the
 * same atomic batch and undo unit before creating the overlay.
 */
export interface SvgCreateOp {
  readonly op: "svg.create";
  /** Raw inline SVG markup (`<svg>…</svg>`), checked by the core ingest gate. */
  readonly svgContent: string;
  readonly startTime: number;
  readonly duration: number;
  /**
   * Target graphics track. When omitted, the first existing graphics track is
   * used; if none exists, a graphics track is created in the same batch.
   */
  readonly trackId?: string;
  /** Normalized box position (0.5/0.5 = frame center). */
  readonly position?: NormalizedPoint;
  /** Normalized anchor within the artwork box (0.5/0.5 = box center). */
  readonly anchor?: NormalizedPoint;
}

/**
 * Shallow-looking update over ONE existing SVG overlay (id from
 * timeline.query's svg entities). At least one optional field is required.
 * position/anchor merge with the existing transform — omitted fields keep
 * their values; svgContent replaces the whole markup and re-crosses the
 * core ingest gate.
 */
export interface SvgUpdateOp {
  readonly op: "svg.update";
  readonly overlayId: string;
  readonly svgContent?: string;
  readonly startTime?: number;
  readonly duration?: number;
  readonly position?: NormalizedPoint;
  readonly anchor?: NormalizedPoint;
}

export interface SvgRemoveOp {
  readonly op: "svg.remove";
  readonly overlayId: string;
}

export interface ClipSetVolumeOp {
  readonly op: "clip.setVolume";
  /** Any existing timeline clip (audio or video track alike). */
  readonly clipId: string;
  /** Linear gain in [0, 4]: 0 = mute, 1 = unity. */
  readonly volume: number;
}

export interface ClipSetSpeedOp {
  readonly op: "clip.setSpeed";
  readonly clipId: string;
  /** Constant playback speed in [0.1, 20]. */
  readonly speed: number;
}

export interface ClipSetReverseOp {
  readonly op: "clip.setReverse";
  readonly clipId: string;
  readonly reversed: boolean;
}

export interface ClipTransformInput {
  /** Pixel offset from the project-frame center; both axes are required. */
  readonly position?: { readonly x: number; readonly y: number };
  /** Multipliers in [0.01, 20]; both axes are required. */
  readonly scale?: { readonly x: number; readonly y: number };
  /** Clockwise degrees in [-360, 360]. */
  readonly rotation?: number;
  readonly anchor?: NormalizedPoint;
  readonly opacity?: number;
  readonly fitMode?: "contain" | "cover" | "stretch" | "none";
  /** Normalized source rectangle contained within 0..1. */
  readonly crop?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  /** Remove an existing crop. Cannot be combined with crop. */
  readonly clearCrop?: true;
}

export interface ClipSetTransformOp {
  readonly op: "clip.setTransform";
  readonly clipId: string;
  /** Partial transform patch; at least one field is required. */
  readonly transform: ClipTransformInput;
}

export interface ClipSetFadeOp {
  readonly op: "clip.setFade";
  readonly clipId: string;
  /** Audio fade durations in seconds; at least one is required. */
  readonly fadeIn?: number;
  readonly fadeOut?: number;
}

export interface ClipRemoveOp {
  readonly op: "clip.remove";
  /**
   * One existing timeline clip (video/audio/image track — NOT a text
   * overlay; remove those with text.delete).
   */
  readonly clipId: string;
}

/** Every transition type exposed by the editor's transition engine. */
export const EDIT_TRANSITION_TYPES = CORE_TRANSITION_TYPES;

export interface TransitionAddOp {
  readonly op: "transition.add";
  /** Outgoing clip. It must end where clipBId starts, on the same visual track. */
  readonly clipAId: string;
  /** Incoming clip. */
  readonly clipBId: string;
  readonly type: TransitionType;
  /** Total center-on-cut transition duration, in seconds. */
  readonly duration: number;
}

export interface TransitionUpdateOp {
  readonly op: "transition.update";
  readonly transitionId: string;
  /** At least one of type/duration is required. */
  readonly type?: TransitionType;
  readonly duration?: number;
}

export interface TransitionRemoveOp {
  readonly op: "transition.remove";
  readonly transitionId: string;
}

/**
 * marker.add — attach one PROJECT marker (persisted metadata, never
 * rendered or exported) to exactly one target: a media-library asset, a
 * timeline clip, a text overlay, or an absolute timeline time range. The
 * facade mints the marker id and its STABLE number (1,2,3,… — kept for the
 * marker's lifetime, never reused after removal); timeline.get reports the
 * markers sorted by number.
 */
export interface MarkerAddOp {
  readonly op: "marker.add";
  readonly target: ProjectMarkerTarget;
  /** Optional free text (at most 200 characters). */
  readonly label?: string;
  /** Optional CSS color; "#f59e0b" when omitted. */
  readonly color?: string;
}

/** marker.remove — remove one project marker by its stable number. */
export interface MarkerRemoveOp {
  readonly op: "marker.remove";
  readonly number: number;
}

/** Update Agent-owned progress/result fields on a persisted project requirement. */
export interface RequirementUpdateOp {
  readonly op: "requirement.update";
  /** Stable display ref (Q3) or internal requirement id. */
  readonly requirementId: string;
  readonly status?: "draft" | "ready" | "in_progress" | "blocked" | "review" | "done";
  readonly agentNote?: string;
  readonly resultMediaIds?: readonly string[];
}

export interface SubtitleImportSrtOp {
  readonly op: "subtitle.importSrt";
  /** Inline SRT text, capped at 256 KiB and 500 cues. */
  readonly srtContent: string;
}

export interface ClipSetColorGradeOp {
  readonly op: "clip.setColorGrade";
  readonly clipId: string;
  readonly temperature?: number;
  readonly tint?: number;
  /** Remove all persisted color grading. Cannot be combined with values. */
  readonly clear?: true;
}

export type FacadeKeyframeProperty =
  | "opacity"
  | "position.x"
  | "position.y"
  | "scale.x"
  | "scale.y"
  | "rotation";

export interface FacadeKeyframeInput {
  readonly property: FacadeKeyframeProperty;
  /** Clip-local seconds. */
  readonly time: number;
  readonly value: number;
  readonly easing?: "linear" | "ease" | "ease-in" | "ease-out" | "ease-in-out" | "hold" | "smoothstep" | "smootherstep";
}

export interface ClipSetKeyframesOp {
  readonly op: "clip.setKeyframes";
  readonly clipId: string;
  /** Replaces this clip's complete keyframe set; empty clears it. */
  readonly keyframes: readonly FacadeKeyframeInput[];
}

/**
 * Apply an Auto Reframe plan to ONE clip as a single atomic transaction: the
 * crop rectangles an analysis produced (source-media seconds measured from
 * the clip's in-point) are converted by the SAME core conversion the GUI
 * reframe panel uses into scale/position transform keyframes, and the
 * project canvas is resized to the plan's output size in the same batch —
 * one core action set, one revision, one GUI undo unit. Time folding onto
 * the clip-local keyframe clock (analysis seconds / clip speed) is done by
 * the shared conversion, never by the agent. Detection itself is NOT part
 * of the op: the heuristic subject analysis runs in the GUI's browser
 * engine, and headless agents compose crop plans from their own frame
 * inspection. This is a local color-region heuristic — not ML matting.
 */
export interface ClipApplyReframeOp {
  readonly op: "clip.applyReframe";
  readonly clipId: string;
  /**
   * 1–100 keyframed source-space crop rectangles (pixels). Times are on the
   * source-analysis clock (seconds from the clip's in-point) and must stay
   * within the clip's source span; each crop must keep the output aspect
   * ratio for an exact fill (sub-pixel drift is tolerated).
   */
  readonly keyframes: readonly {
    readonly time: number;
    readonly cropX: number;
    readonly cropY: number;
    readonly cropWidth: number;
    readonly cropHeight: number;
  }[];
  /** Project canvas width the plan targets (pixels). */
  readonly outputWidth: number;
  /** Project canvas height the plan targets (pixels). */
  readonly outputHeight: number;
}

/**
 * Enable/disable the fixed-key chroma keyer on ONE clip (green-screen
 * keying). Omitted tuning fields keep the clip's prior value, falling back
 * to the engine defaults (green {r:0,g:1,b:0}, tolerance 0.3, edgeSoftness
 * 0.1, spillSuppression 0.5) — the same settings object the GUI green-screen
 * panel dispatches via the core clip/setChromaKey action. This is a fixed
 * color-distance matte, not AI matting.
 */
export interface ClipSetChromaKeyOp {
  readonly op: "clip.setChromaKey";
  readonly clipId: string;
  readonly enabled: boolean;
  /** Key color channels, each in [0, 1]; omitted keeps the prior color. */
  readonly keyColor?: { readonly r: number; readonly g: number; readonly b: number };
  /** Similarity radius in [0, 1]; omitted keeps the prior value. */
  readonly tolerance?: number;
  /** Edge softness in [0, 1]; omitted keeps the prior value. */
  readonly edgeSoftness?: number;
  /** Spill suppression in [0, 1]; omitted keeps the prior value. */
  readonly spillSuppression?: number;
}

/**
 * Set the noise-reduction state on ONE clip — the same local DSP effect the
 * GUI noise-reduction panel applies through the core audio effect actions.
 * Omitted tuning fields keep the clip's prior values, falling back to the
 * shared preset/defaults module (core noise-reduction-presets.ts); `preset`
 * selects one of the panel's presets by id and explicit fields override its
 * values. An existing noiseReduction effect is updated in place (never
 * stacked) and a learned `profile` is preserved across preset switches, both
 * matching GUI behavior. Deterministic local signal processing — not AI.
 */
export interface ClipSetNoiseReductionOp {
  readonly op: "clip.setNoiseReduction";
  readonly clipId: string;
  /** Required: true applies/enables cleanup, false disables (tuning kept). */
  readonly enabled: boolean;
  /** Preset id — the same ids the GUI panel renders. */
  readonly preset?:
    | "balanced"
    | "speech"
    | "whiteNoise"
    | "music"
    | "heavy"
    | "wind"
    | "hum";
  /** Gate threshold in dB, [-80, 0]; omitted keeps prior/preset/default. */
  readonly threshold?: number;
  /** Reduction amount in [0, 1]; omitted keeps prior/preset/default. */
  readonly reduction?: number;
  /** Attack in ms, [0, 100]; omitted keeps prior/preset/default. */
  readonly attack?: number;
  /** Release in ms, [0, 500]; omitted keeps prior/preset/default. */
  readonly release?: number;
  /**
   * Optional learned spectral noise profile (same shape the render chain
   * persists). Omitted keeps the clip's prior profile.
   */
  readonly profile?: {
    readonly frequencyBins: number[];
    readonly magnitudes: number[];
    readonly standardDeviations?: number[];
    readonly sampleRate: number;
    readonly fftSize?: number;
  };
}

/**
 * clip.setDucking — persist audio ducking on ONE clip: the volume-automation
 * points the audible chain evaluates (realtime preview and export both run
 * clip.automation.volume through the shared core audio engine) plus the same
 * panel-readback settings snapshot the GUI ducking panel persists, via the
 * same core audio/setDucking action. Tuning fields mirror the GUI
 * AudioDuckingSection sliders exactly.
 *
 * Keyframes come from envelope detection (core AudioDucker RMS presence) —
 * deterministic local signal processing, not AI. Either supply `points`
 * (an AudioDucker.generateDuckingKeyframes product, e.g. produced in a live
 * GUI session) or `presenceRanges` (speech-active windows on the trigger
 * track, e.g. the complement of a silence analysis) and the op synthesizes
 * the keyframes with the same core kernel the GUI panel uses. An empty
 * synthesis result is rejected, never persisted silently.
 */
export interface ClipSetDuckingOp {
  readonly op: "clip.setDucking";
  readonly clipId: string;
  /** Voice level that triggers ducking, dB in [-60, 0]. */
  readonly threshold: number;
  /** How much the background is lowered, in [0, 1]. */
  readonly reduction: number;
  /** Attack time in seconds, [0, 1]. */
  readonly attack: number;
  /** Release time in seconds, [0, 2]. */
  readonly release: number;
  /** Minimum duck hold time in seconds, [0, 1]. */
  readonly holdTime: number;
  /**
   * Pre-computed ducking keyframes (time in clip-relative seconds, value in
   * [0, 4]). Supply points OR presenceRanges, never both.
   */
  readonly points?: readonly {
    readonly time: number;
    readonly value: number;
  }[];
  /**
   * Speech-active windows (seconds, clip-relative) on the trigger track;
   * keyframes are synthesized from them via the shared AudioDucker kernel.
   */
  readonly presenceRanges?: readonly {
    readonly start: number;
    readonly end: number;
  }[];
}

/**
 * clip.setBackgroundRemoval — persist the person-segmentation matte settings
 * on ONE clip via the same core clip/setBackgroundRemoval action the GUI
 * Background Removal panel writes: undoable and saved with the project.
 * Omitted tuning fields keep the clip's prior values, falling back to the
 * shared engine defaults (blur mode, blur 15px, edge 3px, threshold 0.7).
 *
 * Rendering honesty: the MediaPipe person-segmentation model
 * (selfie_multiclass_256x256, local inference) runs only in a GUI/desktop
 * Chromium runtime and downloads on first GUI use. Agents persist the setting
 * anywhere, but frames rendered headless keep the original background —
 * preview/verify this effect through the desktop GUI. When the model fails to
 * load, the GUI engine falls back to a non-AI luminance mask and discloses
 * the degraded mask in the panel.
 */
export interface ClipSetBackgroundRemovalOp {
  readonly op: "clip.setBackgroundRemoval";
  readonly clipId: string;
  /** Required: true enables the matte, false disables (tuning kept). */
  readonly enabled: boolean;
  /** Background treatment behind the segmented subject. */
  readonly mode?: "blur" | "color" | "image" | "video" | "transparent";
  /** Blur radius in px, [0, 50] (mode "blur"); omitted keeps prior. */
  readonly blurAmount?: number;
  /** Replacement fill color as #RGB/#RGBA/#RRGGBB/#RRGGBBAA hex (mode "color"). */
  readonly backgroundColor?: string;
  /** Image URL/data URL for mode "image"; loaded by the GUI runtime. */
  readonly backgroundImageUrl?: string;
  /** Video URL/data URL for mode "video"; loaded by the GUI runtime. */
  readonly backgroundVideoUrl?: string;
  /** Edge feather in px, [0, 10]; omitted keeps prior. */
  readonly edgeBlur?: number;
  /** Subject-mask threshold in [0, 1]; omitted keeps prior. */
  readonly threshold?: number;
}

/**
 * The clip video effect stack's addable effect types — the SAME closed set
 * the GUI inspector's effect panel offers (web effects-bridge VideoEffectType)
 * and the core video effects engine consumes. Declared here (facade-side)
 * because the GUI type lives behind the web app boundary.
 */
export const CLIP_VIDEO_EFFECT_TYPES = [
  "brightness",
  "contrast",
  "saturation",
  "grayscale",
  "sepia",
  "invert",
  "hue",
  "blur",
  "sharpen",
  "vignette",
  "grain",
  "temperature",
  "tint",
  "tonal",
  "chromaKey",
  "shadow",
  "glow",
  "motion-blur",
  "radial-blur",
  "chromatic-aberration",
  "shader",
] as const;

export type ClipVideoEffectType = (typeof CLIP_VIDEO_EFFECT_TYPES)[number];

/**
 * clip.addVideoEffect — append ONE effect to a timeline clip's video effect
 * stack through the same core `effect/add` action the GUI inspector's effect
 * panel dispatches (undoable, persisted, evaluated by the shared render and
 * export chain). `effectType` is closed to the GUI effect-stack vocabulary
 * and `params` are validated per type against the same parameter bounds the
 * GUI effect sliders enforce (shader effects against the core shader
 * library's own parameter definitions).
 *
 * Named honestly: this op ADDS AN EFFECT with exactly the parameters given —
 * it performs no image analysis. The GUI's "Auto-Color" button is a FIXED
 * PRESET expressible as three of these ops in one batch: saturation value
 * 1.15, contrast value 1.1, brightness value 5 (the same numbers the GUI
 * Auto-Color handler sends). Nothing analyzes the frame to choose them.
 */
export interface ClipAddVideoEffectOp {
  readonly op: "clip.addVideoEffect";
  readonly clipId: string;
  /** Effect type from the GUI effect stack (closed enum). */
  readonly effectType: ClipVideoEffectType;
  /**
   * Initial effect parameters. Flat scalar bundle; the allowed keys and
   * value ranges depend on effectType and mirror the GUI effect sliders
   * (shader: the core shader library's parameter definitions). Omitted
   * leaves every parameter at the engine's default.
   */
  readonly params?: Readonly<Record<string, unknown>>;
  /**
   * Optional deterministic effect id, so later ops in the SAME batch (e.g.
   * a second clip.addVideoEffect or a workAsset.capture) can reference the
   * effect deterministically. A fresh id is minted when omitted.
   */
  readonly effectId?: string;
}

/**
 * workAsset.capture — save timeline clip(s) into the project's work assets
 * ("saved work"): a named, stable-id reusable reference plus a parameter
 * snapshot (trim, speed, effects, transform, …). The asset references the
 * clip's media by id and never copies media bytes. Engine-generated overlay
 * clips (virtual media ids) and placeholder media are rejected; analysis
 * artifacts (e.g. stabilization profiles) are stripped and declared on the
 * asset's unsupportedParams instead of being dropped silently. Names are
 * search keys, never identities.
 *
 * Exactly one of clipId (kind "single") / clipIds (kind "multi") is required:
 * clipIds captures a SET of ≥2 clips as ONE multi asset whose members keep
 * their relative times and track relationships. Any failing member rejects
 * the whole set (all-or-nothing) with per-member details — never a partial
 * asset.
 */
export interface WorkAssetCaptureOp {
  readonly op: "workAsset.capture";
  /** Single-clip form: the one clip to capture (kind "single"). */
  readonly clipId?: string;
  /**
   * Multi-clip form: the capture set, order-independent (core sorts it),
   * 2..64 unique clip ids (kind "multi"). The earliest startTime is the
   * time anchor T0; the first sorted member is the anchor.
   */
  readonly clipIds?: readonly string[];
  /** Optional display name; derived from the source media when omitted. */
  readonly name?: string;
  /**
   * Optional echo recorded on the asset for traceability. Retry safety comes
   * from edit.apply's idempotencyKey ledger — this field never dedupes.
   */
  readonly captureRequestId?: string;
}

/** workAsset.rename — rename one work asset by its stable id. */
export interface WorkAssetRenameOp {
  readonly op: "workAsset.rename";
  readonly workAssetId: string;
  /** Non-empty, at most 200 characters; need not be unique. */
  readonly name: string;
}

/** workAsset.delete — remove one work asset by its stable id. */
export interface WorkAssetDeleteOp {
  readonly op: "workAsset.delete";
  readonly workAssetId: string;
}

/**
 * workAsset.instantiate — place a work asset back on the timeline as NEW
 * clip(s) built from its snapshot(s). The asset entry is never modified, so
 * repeated instantiation keeps producing independent instances. Without
 * trackId a matching new lane is created (material-attach convention);
 * startTime defaults to the end of the timeline.
 *
 * kind "single" places one clip. kind "multi" expands the member layout:
 * startTime anchors the asset's T0 (the anchor member lands exactly there,
 * others at startTime + relativeStart), trackId binds the ANCHOR lane (its
 * type must match; every other lane is created fresh — existing user tracks
 * are never occupied implicitly), and relative times/track relationships are
 * preserved verbatim. Ids are allocated by the translator and reported via
 * createdIds (multi: every new lane id first, then every clip id).
 */
export interface WorkAssetInstantiateOp {
  readonly op: "workAsset.instantiate";
  readonly workAssetId: string;
  /**
   * Existing target lane; must match the source media's type (multi: the
   * anchor lane's type — other lanes are always freshly created).
   */
  readonly trackId?: string;
  /** Timeline seconds; defaults to the end of the timeline. */
  readonly startTime?: number;
}

export type EditOp =
  | TrackAddOp
  | TrackUpdateOp
  | TrackRemoveOp
  | MediaRemoveOp
  | ClipAddOp
  | ClipMoveOp
  | ClipTrimOp
  | ClipSplitOp
  | ClipDuplicateOp
  | ClipRippleDeleteOp
  | TextCreateOp
  | TextUpdateOp
  | TextDeleteOp
  | SvgCreateOp
  | SvgUpdateOp
  | SvgRemoveOp
  | ClipSetSpeedOp
  | ClipSetReverseOp
  | ClipSetTransformOp
  | ClipSetVolumeOp
  | ClipSetFadeOp
  | ClipRemoveOp
  | TransitionAddOp
  | TransitionUpdateOp
  | TransitionRemoveOp
  | MarkerAddOp
  | MarkerRemoveOp
  | RequirementUpdateOp
  | SubtitleImportSrtOp
  | ClipSetColorGradeOp
  | ClipSetKeyframesOp
  | ClipApplyReframeOp
  | ReferenceSetComparisonOp
  | ReferenceClearComparisonOp
  | MediaReplaceOp
  | MediaRelinkOp
  | MediaRenameOp
  | ClipSetChromaKeyOp
  | ClipSetNoiseReductionOp
  | ClipSetDuckingOp
  | ClipSetBackgroundRemovalOp
  | ClipAddVideoEffectOp
  | WorkAssetCaptureOp
  | WorkAssetRenameOp
  | WorkAssetDeleteOp
  | WorkAssetInstantiateOp;

export interface EditApplyParams {
  readonly ops: readonly EditOp[];
  readonly expectedRevision?: number;
  /**
   * CAS guard on the editor context (ADR 0004 Decision 4): an agent that
   * derived its ops from selection/playhead/canvas point MUST carry the
   * contextRevision those reads returned; a stale value fails CONFLICT and
   * nothing is applied. Live sessions CAS it at the store; headless
   * sessions have no editor context and reject it INVALID_PARAMS.
   */
  readonly expectedContextRevision?: number;
  readonly idempotencyKey?: string;
}

export interface OpApplied {
  readonly op: EditOpType;
  /**
   * Ids of entities this op created. For the usual creating ops this is one
   * id (`track.add` → track, `clip.add`/split/duplicate → clip,
   * `text.create` → text overlay, `transition.add` → transition). When
   * `text.create` had no existing text track, it creates both entities and
   * reports `[textTrackId, overlayId]` in that order. Empty for non-creating
   * ops. Never guess a `clipId` field or a `results[]` collection: consume
   * this per-op array from `applied`.
   */
  readonly createdIds: readonly string[];
}

export interface EditApplyResult {
  readonly revision: number;
  readonly applied: readonly OpApplied[];
  readonly replayed: boolean;
}

/* ------------------------------------------------------------------ */
/* edit.validate — exact dry-run of the edit.apply vocabulary          */
/* ------------------------------------------------------------------ */

export interface EditValidateParams {
  readonly ops: readonly EditOp[];
  readonly expectedRevision?: number;
  readonly expectedContextRevision?: number;
}

export interface EditValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly opIndex?: number;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface EditAffectedEntity {
  readonly entityType: ProjectChangeEntityType;
  readonly entityId: string;
  readonly fields: readonly string[];
}

export interface EditValidateResult {
  readonly valid: boolean;
  readonly normalizedOps: readonly EditOp[];
  readonly conflicts: readonly EditValidationIssue[];
  readonly warnings: readonly EditValidationIssue[];
  readonly affected: readonly EditAffectedEntity[];
  readonly created: readonly Pick<EditAffectedEntity, "entityType" | "entityId">[];
  readonly deleted: readonly Pick<EditAffectedEntity, "entityType" | "entityId">[];
  readonly estimatedDuration: number;
  readonly estimatedRevision: number;
}

/* ------------------------------------------------------------------ */
/* history.get / history.control                                      */
/* ------------------------------------------------------------------ */

export interface HistoryGetParams {
  readonly limit?: number;
}

export interface HistoryEntrySummary {
  readonly direction: "undo" | "redo";
  readonly description: string;
  readonly actionType: string;
  readonly owner: "agent" | "human";
  readonly timestamp: number;
  readonly groupId: string | null;
}

export interface HistoryGetResult {
  readonly revision: number;
  readonly available: boolean;
  readonly reason?: string;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoCount: number;
  readonly redoCount: number;
  readonly entries: readonly HistoryEntrySummary[];
}

export interface HistoryControlParams {
  readonly action: "undo" | "redo";
  readonly expectedRevision?: number;
  readonly idempotencyKey?: string;
}

export interface HistoryControlResult {
  readonly action: "undo" | "redo";
  readonly revision: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly replayed: boolean;
}

/* ------------------------------------------------------------------ */
/* preview.render_frame (Slice 1b)                                     */
/* ------------------------------------------------------------------ */

export interface PreviewRenderFrameParams {
  /**
   * Timeline position in seconds. Must be a finite number in [0, timeline
   * duration]; the exact end of the timeline is clamped to the last frame.
   */
  readonly timeSec: number;
  /** Raster size; defaults to the project settings. Even numbers only. */
  readonly width?: number;
  readonly height?: number;
  readonly expectedRevision?: number;
  readonly idempotencyKey?: string;
}

export interface PreviewRenderFrameResult {
  readonly revision: number;
  readonly timeSec: number;
  readonly width: number;
  readonly height: number;
  /** PNG artifact under artifactRoot: {path, sizeBytes, sha256, sourceRevision}. */
  readonly artifact: ArtifactRef;
  readonly replayed: boolean;
}

/* ------------------------------------------------------------------ */
/* visual.inspect (read-only visual context slice)                    */
/* ------------------------------------------------------------------ */

/** Explicit time interval for visual.inspect sampling. */
export interface VisualInspectTimeRange {
  readonly startSec: number;
  readonly endSec: number;
}

export interface VisualInspectParams {
  /** Timeline clip id to inspect. Mutually exclusive with timeRange. */
  readonly clipId?: string;
  /** Explicit timeline interval. Mutually exclusive with clipId. */
  readonly timeRange?: VisualInspectTimeRange;
  /** Number of evenly spaced samples. Defaults to 6; hard maximum is 12. */
  readonly sampleCount?: number;
  /** Optional even thumbnail raster size. Defaults to a bounded project-scaled size. */
  readonly width?: number;
  readonly height?: number;
  /**
   * Per-frame byte budget for the delivered artifacts. Frames whose lossless
   * PNG exceeds it are re-encoded through a deterministic JPEG ladder
   * (frame-budget.ts). Defaults to 1.5 MiB; bounded [32 KiB, 8 MiB].
   */
  readonly maxFrameBytes?: number;
  readonly expectedRevision?: number;
  readonly idempotencyKey?: string;
}

export interface VisualInspectFrame {
  readonly index: number;
  /** Timeline position used for this rendered frame. */
  readonly timeSec: number;
  /** Stable human/machine-readable label printed in the contact sheet when available. */
  readonly label: string;
  /** Revision of the canonical snapshot that produced this frame. */
  readonly sourceRevision: number;
  /** Real frame artifact (PNG, or JPEG when the byte-budget ladder ran). */
  readonly artifact: ArtifactRef;
  /** Per-artifact fidelity disclosure: delivered raster/format vs source, budget outcome. */
  readonly fidelity: import("./frame-budget").FrameFidelity;
}

export interface VisualInspectResult {
  /** Current project revision at the end of the read. */
  readonly revision: number;
  /** Revision whose canonical snapshot produced every frame/artifact. */
  readonly sourceRevision: number;
  readonly selection:
    | { readonly kind: "clip"; readonly clipId: string; readonly startSec: number; readonly endSec: number }
    | { readonly kind: "timeRange"; readonly startSec: number; readonly endSec: number };
  readonly sampleCount: number;
  readonly width: number;
  readonly height: number;
  /** Per-frame byte budget applied to every delivered frame artifact. */
  readonly frameBudgetBytes: number;
  readonly frames: readonly VisualInspectFrame[];
  /** Real PNG contact sheet when the runtime can safely compose one; null on honest fallback. */
  readonly contactSheet: ArtifactRef | null;
  /** Explicit limitations/reasons, never a fabricated visual artifact. */
  readonly limitations: readonly string[];
  readonly replayed: boolean;
}

/* ------------------------------------------------------------------ */
/* export.start (Slice 1b)                                             */
/* ------------------------------------------------------------------ */

/** Closed settings subset for this slice: MP4/H.264 only. */
export interface ExportStartSettings {
  readonly format?: "mp4";
  readonly codec?: "h264";
  /** Defaults to the project settings; even numbers only. */
  readonly width?: number;
  readonly height?: number;
  /** Defaults to project settings.frameRate. */
  readonly frameRate?: number;
  /** Defaults to a size-appropriate bitrate. */
  readonly videoBitrateKbps?: number;
  /**
   * Optional upscale pass on the export render (the same setting the GUI
   * ExportDialog exposes). `quality` uses the dialog's tiers; omitted keeps
   * the engine default ("balanced"). Upscaling only engages when the export
   * size EXCEEDS the project canvas size, and it needs WebGPU: when the
   * runtime has no WebGPU device the pass is skipped and job.status
   * discloses `upscalingRequestedButInactive: true` instead of failing or
   * silently producing an un-upscaled file. Algorithm: WebGPU Lanczos +
   * edge-directed interpolation — a deterministic local resampler, NOT a
   * neural-network upscaler.
   */
  readonly upscaling?: {
    readonly enabled: boolean;
    readonly quality?: "fast" | "balanced" | "quality";
  };
}

export interface ExportStartParams {
  readonly settings?: ExportStartSettings;
  /**
   * Reference-comparison export (P1): produce a left(reference)/right(timeline)
   * or overlay comparison MP4 for an EXPLICIT timeline range, from the shared
   * project referenceComparison config. The timeline is rendered exactly
   * once by the canonical export pipeline; one ffmpeg pass composes and
   * re-tags. Audio comes from exactly one side (config.audioSide).
   */
  readonly comparison?: {
    readonly startSec: number;
    readonly endSec: number;
  };
  /**
   * Optional deliverable copy target: an absolute .mp4 path inside
   * `<deliveryRoot>/jobs/<slug>/output/` (docs/AGENT-WORKSPACE.md). The
   * artifact is still produced and verified inside artifactRoot first; the
   * finished file is then copied to this destination with no-overwrite
   * semantics. Fails INVALID_PARAMS fast when no delivery root is
   * configured or the path escapes the jobs output layout.
   */
  readonly destinationPath?: string;
  readonly expectedRevision?: number;
  readonly idempotencyKey?: string;
}

export interface AnalysisListParams {
  readonly mediaId?: string;
  readonly limit?: number;
}

export interface AnalysisGetParams {
  readonly recordId: string;
}

export type AnalysisListResult = readonly {
  readonly id: string;
  readonly finishedAt: string;
  readonly subject: { readonly mediaId: string; readonly name: string };
  readonly analysisTypes: readonly string[];
  readonly stale: { readonly kind: string };
  readonly recheckOf: string | null;
}[];

export interface PreviewRenderComparisonParams {
  /** Timeline time to compare at. */
  readonly timeSec: number;
  /** Even raster; defaults to the project settings. */
  readonly width?: number;
  readonly height?: number;
  /** Render-time layout override (defaults to the canonical config layout). */
  readonly layout?: "side-by-side" | "overlay";
  readonly maxFrameBytes?: number;
  readonly expectedRevision?: number;
  readonly idempotencyKey?: string;
}

export interface PreviewRenderComparisonResult {
  readonly revision: number;
  readonly sourceRevision: number;
  readonly timeSec: number;
  /** Reference time the timeline time mapped to. */
  readonly referenceSec: number;
  /** Clamp disclosure when the mapping fell outside the reference range. */
  readonly clamped: "none" | "before" | "after";
  readonly layout: "side-by-side" | "overlay";
  readonly width: number;
  readonly height: number;
  readonly frameBudgetBytes: number;
  readonly artifact: ArtifactRef;
  readonly limitations: readonly string[];
  readonly replayed: boolean;
}

export interface ExportStartResult {
  readonly jobId: string;
  /**
   * "queued" on a fresh start (the job runs in the background). On an
   * idempotent replay this is the job's CURRENT state, which may already be
   * running/done/error/cancelled.
   */
  readonly state: "queued" | "running" | "done" | "error" | "cancelled";
  /**
   * Revision of the project snapshot this job exports. The snapshot is taken
   * synchronously inside export.start; later edits never affect the job.
   */
  readonly sourceRevision: number;
  readonly replayed: boolean;
}

/* ------------------------------------------------------------------ */
/* job.status / job.cancel (Slice 1b)                                  */
/* ------------------------------------------------------------------ */

export interface JobParams {
  readonly jobId: string;
}

export interface JobStatusView {
  readonly jobId: string;
  readonly kind: "export" | "analysis";
  readonly state: "queued" | "running" | "done" | "error" | "cancelled";
  readonly progress: {
    readonly phase: string;
    readonly percent: number;
    readonly currentFrame?: number;
    readonly totalFrames?: number;
    readonly bytesWritten?: number;
  } | null;
  /**
   * Present only in state "done". Failed/cancelled jobs never carry an
   * artifact (no partial file is ever presented as a result).
   */
  readonly artifact: ArtifactRef | null;
  /** Present for completed analysis jobs; null for export/non-done jobs. */
  readonly result: AnalysisJobResult | null;
  readonly error: { readonly code: string; readonly message: string } | null;
  /**
   * export.start destinationPath outcome (both null when no destination was
   * requested). On success `deliveredTo` is the absolute path the verified
   * artifact was copied to; a delivery failure never hides the artifact —
   * the job stays "done" and `deliveryError` carries the reason.
   */
  readonly deliveredTo: string | null;
  readonly deliveryError: string | null;
  readonly sourceRevision: number;
  /** Export route that produced the artifact (null until done). */
  readonly route: string | null;
  /**
   * Upscale honesty disclosure: true when the export request asked for the
   * upscaling pass but the producing runtime could not apply it (no WebGPU
   * device, or a route whose pipeline has no upscale stage). The artifact is
   * still valid — it is simply NOT upscaled, and the result says so rather
   * than letting the request silently vanish. Always false when no upscaling
   * was requested.
   */
  readonly upscalingRequestedButInactive: boolean;
  readonly cancelRequested: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* verify.artifact (Slice 1b)                                          */
/* ------------------------------------------------------------------ */

export interface VerifyArtifactParams {
  /**
   * Artifact file to inspect. Must resolve inside artifactRoot, or name a
   * delivered copy at its exact deliveredTo location inside a configured
   * delivery root's job output directory (`<deliveryRoot>/jobs/<slug>/output/`).
   */
  readonly path: string;
  readonly expect?: {
    readonly container?: "mp4";
    readonly videoCodec?: "h264";
    readonly width?: number;
    readonly height?: number;
    readonly durationSec?: number;
    readonly durationToleranceSec?: number;
  };
  readonly compare?: {
    /** PNG image or video file, inside mediaRoots or artifactRoot. */
    readonly referencePath: string;
    readonly timeSec: number;
    readonly referenceTimeSec?: number;
    readonly region?: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };
    readonly mode: "similar" | "different";
    readonly maxMeanAbsDiff?: number;
    readonly minMeanAbsDiff?: number;
    readonly minChangedPixelsRatio?: number;
    /**
     * Explicit YUV→RGB decode matrix for BOTH sides, so a similarity verdict
     * is never computed across a guessed matrix (docs/COLOR.md). Tagged files
     * decode correctly without this; untagged or externally-precomposed
     * mixed sources should pin it.
     */
    readonly colorMatrix?: "bt601" | "bt709";
    /** Per-side overrides for mixed-matrix comparisons (win over colorMatrix). */
    readonly targetColorMatrix?: "bt601" | "bt709";
    readonly referenceColorMatrix?: "bt601" | "bt709";
  };
}

export type VerifyArtifactResult = VerifyReport;

/* ------------------------------------------------------------------ */
/* material.* (user-level material library)                            */
/* ------------------------------------------------------------------ */

export type {
  MaterialVerb,
  MaterialListParams,
  MaterialGetParams,
  MaterialCreateParams,
  MaterialUpdateParams,
  MaterialBatchUpdateParams,
  MaterialBatchUpdateItem,
  MaterialRemoveParams,
  MaterialAttachParams,
  MaterialUndoParams,
  MaterialGetResult,
  MaterialCreateResult,
  MaterialUpdateResult,
  MaterialBatchUpdateResult,
  MaterialRemoveResult,
  MaterialAttachResult,
  MaterialUndoResult,
  MaterialJournalResult,
  MaterialLibraryBridge,
  MaterialLibraryBridgeRequest,
  MaterialLibraryBridgeReply,
  MaterialLibraryBridgeVerb,
  MaterialLibraryCapability,
  MaterialSortOrder,
} from "./material-library";
export { MATERIAL_VERBS, MATERIAL_LIBRARY_LIMITS } from "./material-library";
export type {
  FontVerb,
  FontUploadParams,
  FontListParams,
  FontUploadResult,
  CustomFontListItem,
  FontListResult,
  FontLibraryBridge,
  FontLibraryBridgeRequest,
  FontLibraryBridgeReply,
  FontLibraryBridgeVerb,
  FontLibraryCapability,
  FontFormat,
} from "./font-library";
export { FONT_VERBS, FONT_LIBRARY_LIMITS } from "./font-library";
export type {
  PresetVerb,
  PresetListParams,
  PresetGetParams,
  PresetCreateParams,
  PresetUpdateParams,
  PresetRemoveParams,
  PresetApplyParams,
  PresetApplyTarget,
  PresetListItem,
  PresetListResult,
  PresetGetResult,
  PresetCreateResult,
  PresetUpdateResult,
  PresetRemoveResult,
  PresetApplyResult,
  PresetLibraryBridge,
  PresetLibraryBridgeRequest,
  PresetLibraryBridgeReply,
  PresetLibraryBridgeVerb,
  CustomPresetCapability,
} from "./preset-verbs";
export { PRESET_VERBS, PRESET_LIBRARY_LIMITS } from "./preset-verbs";
