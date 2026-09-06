import { PLUGIN_TOOLS } from "./plugins";
import { assertUniqueToolNames } from "./plugin-api";
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
 * Pixel/export/verify backing arrives through the independent provider
 * interfaces in providers.ts (RenderProvider / ExportProvider /
 * ArtifactVerifier); the facade itself never imports Chromium or ffmpeg.
 * MCP/CLI transports remain out of scope.
 */
import type {
  Project,
  ProjectMarkerTarget,
  ProjectSettings,
} from "@openreel/core/types/project";
import {
  TRANSITION_TYPES as CORE_TRANSITION_TYPES,
  type TransitionType,
} from "@openreel/core/types/effects";
import type { LiveEditorReferences } from "./live-store";
import type {
  ArtifactRef,
  VerifyReport,
} from "./providers";

export const FACADE_VERSION = "0.6.0" as const;
export const FACADE_CONTRACT_VERSION = "facade-slice-6" as const;
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
  "media.analyze_start",
  "timeline.get",
  "timeline.query",
  "editor.get_context",
  "editor.control",
  "edit.validate",
  "edit.apply",
  "history.get",
  "history.control",
  "preview.render_frame",
  "visual.inspect",
  "export.start",
  "job.status",
  "job.cancel",
  "verify.artifact",
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
/* Work mode + the read-only verb gate                                */
/* ------------------------------------------------------------------ */

export type {
  AgentAccessMode,
  AgentModePreference,
  AgentWorkMode,
  AgentWorkModeSemantics,
  LegacyAgentMode,
} from "./work-mode";

import type {
  AgentAccessMode,
  AgentWorkMode,
  AgentWorkModeSemantics,
} from "./work-mode";

/**
 * The read-only verb set every live access mode may call. Work mode never
 * participates in this gate. A read-only session rejects writes FORBIDDEN;
 * a writer-less write session rejects them CONFLICT with holder information.
 */
export const READ_ONLY_VERBS = [
  "session.describe",
  "capabilities.get",
  "project.get_state",
  "project.changes",
  "media.analyze_start",
  "timeline.get",
  "timeline.query",
  "editor.get_context",
  "editor.control",
  "edit.validate",
  "history.get",
  "visual.inspect",
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
  readonly workMode: AgentWorkMode;
  readonly workModeSemantics: AgentWorkModeSemantics;
  /** Live-only authorization field. Work mode never changes it. */
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
  readonly mediaAnalysis: {
    readonly asynchronous: true;
    readonly types: Readonly<Record<MediaAnalysisType, CapabilityStatus>>;
    readonly largeResultsAsArtifacts: true;
  };
  readonly professionalEditing: Readonly<{
    subtitles: CapabilityStatus;
    trackControls: CapabilityStatus;
    transformKeyframes: CapabilityStatus;
    volumeKeyframes: CapabilityStatus;
    basicColorGrade: CapabilityStatus;
    lut: CapabilityStatus;
    audioNormalization: CapabilityStatus;
    audioDucking: CapabilityStatus;
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
  /** The Slice-1 adapter probes containers with video or audio tracks only. */
  readonly type: "video" | "audio";
  readonly metadata: ImportedMediaMetadata;
  readonly replayed: boolean;
}

export const MEDIA_ANALYSIS_TYPES = [
  "technicalQuality",
  "audioSummary",
  "videoReview",
  "sceneCuts",
  "silence",
  "speechTranscript",
  "loudness",
  "blackFrames",
  "duplicateFrames",
  "motion",
  "faces",
] as const;

export type MediaAnalysisType = (typeof MEDIA_ANALYSIS_TYPES)[number];

export interface MediaAnalyzeStartParams {
  /** Explicit consent to send this range to the configured Alibaba cloud service. */
  readonly cloudUpload?: boolean;
  readonly reviewQuestion?: string;
  /** Original media seconds; audioSummary maximum 120s, videoReview explicit range maximum 20s. */
  readonly startSec?: number;
  readonly endSec?: number;
  readonly mediaId: string;
  readonly analysisTypes: readonly MediaAnalysisType[];
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
  | "media"
  | "transition"
  | "marker"
  | "subtitle";

export type TimelineQueryField =
  | "name"
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
  | "colorGrading";

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
  readonly workMode: AgentWorkMode;
  readonly workModeSemantics: AgentWorkModeSemantics;
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
  readonly identity: {
    readonly projectId: string | null;
    readonly projectName: string | null;
    /** Null in headless sessions (no window exists). */
    readonly windowId: string | null;
  };
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
  "track.update",
  "subtitle.importSrt",
  "clip.setColorGrade",
  "clip.setKeyframes",
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
  readonly fontWeight?: import("@openreel/core/text/types").FontWeight;
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
  | SubtitleImportSrtOp
  | ClipSetColorGradeOp
  | ClipSetKeyframesOp;

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
  /** Real PNG frame artifact. Always present, including when a contact sheet is available. */
  readonly artifact: ArtifactRef;
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
}

export interface ExportStartParams {
  readonly settings?: ExportStartSettings;
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
  };
}

export type VerifyArtifactResult = VerifyReport;
