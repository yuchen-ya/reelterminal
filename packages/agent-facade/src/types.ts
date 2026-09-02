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
 *   the openreel-project@1 checkpoint pair (cross-session persistence).
 * Slice 3 verbs (ADR 0004 Decision 4): editor.get_context — the live/
 *   headless-honest editor-context read plus the read-only visual.inspect
 *   slice (16 verbs).
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
import type { Project, ProjectSettings } from "@openreel/core/types/project";
import {
  TRANSITION_TYPES as CORE_TRANSITION_TYPES,
  type TransitionType,
} from "@openreel/core/types/effects";
import type { LiveEditorReferences } from "./live-store";
import type {
  ArtifactRef,
  ExportProgressEvent,
  VerifyReport,
} from "./providers";

export const FACADE_VERSION = "0.4.0" as const;
export const FACADE_CONTRACT_VERSION = "facade-slice-4" as const;
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
  "project.get_state",
  "media.import",
  "timeline.get",
  "editor.get_context",
  "edit.apply",
  "preview.render_frame",
  "visual.inspect",
  "export.start",
  "job.status",
  "job.cancel",
  "verify.artifact",
] as const;

export type FacadeVerb = (typeof FACADE_VERBS)[number];

/* ------------------------------------------------------------------ */
/* Session modes + the read-only verb gate (ADR 0004 Decision 7)       */
/* ------------------------------------------------------------------ */

/**
 * Live session modes (ADR 0004 Decision 7). Observe runs the read-only
 * verb set only; Assist (the default) and Autonomous share the full verb
 * surface and differ only in step budget, which is a host concern, not a
 * facade one. Headless sessions have no mode — the concept only exists
 * for live sessions (createLiveFacade).
 */
export type LiveSessionMode = "observe" | "assist" | "autonomous";

/**
 * The read-only verb set every session mode may call (Decision 7). Write
 * verbs are gated at the facade session boundary: Observe rejects them
 * FORBIDDEN; a writer-less Assist/Autonomous session rejects them
 * CONFLICT with holder information (Decision 6).
 */
export const READ_ONLY_VERBS = [
  "session.describe",
  "capabilities.get",
  "project.get_state",
  "timeline.get",
  "editor.get_context",
  "visual.inspect",
  "job.status",
  "verify.artifact",
] as const satisfies readonly FacadeVerb[];

export type ReadOnlyVerb = (typeof READ_ONLY_VERBS)[number];

export function isReadOnlyVerb(verb: FacadeVerb): verb is ReadOnlyVerb {
  return (READ_ONLY_VERBS as readonly string[]).includes(verb);
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
  /* Live-only fields (ADR 0004 Decisions 6/7) — absent in headless sessions. */
  readonly mode?: LiveSessionMode;
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
    /** False when no media roots are configured (imports would all fail). */
    readonly available: boolean;
    /** Present when unavailable: why, in plain language. */
    readonly reason?: string;
    readonly sources: readonly ["file"];
    /** Absolute roots the caller allowed; imports outside them fail. */
    readonly mediaRoots: readonly string[];
    readonly urlImport: false;
    readonly metadata: readonly ["duration", "width", "height", "mediaType"];
  };
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

export interface TimelineState {
  readonly revision: number;
  readonly duration: number;
  readonly tracks: readonly TimelineTrackView[];
  readonly textOverlays: readonly TextOverlayView[];
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
   * if none exists the op fails (create one explicitly via track.add).
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

export type EditOp =
  | TrackAddOp
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
  | TransitionRemoveOp;

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
  /** Ids of entities this op created (track/clip/text overlay). */
  readonly createdIds: readonly string[];
}

export interface EditApplyResult {
  readonly revision: number;
  readonly applied: readonly OpApplied[];
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
  readonly kind: "export";
  readonly state: "queued" | "running" | "done" | "error" | "cancelled";
  readonly progress: {
    readonly phase: ExportProgressEvent["phase"];
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
  readonly error: { readonly code: string; readonly message: string } | null;
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
  /** Artifact file to inspect. Must resolve inside artifactRoot. */
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
