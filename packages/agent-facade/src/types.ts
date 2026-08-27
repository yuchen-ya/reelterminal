/**
 * Public contract of the in-process agent facade (Slice 1 + Slice 1b).
 *
 * The facade is a pure-Node, transport-agnostic library. The core `Project`
 * is the canonical state; every mutation is an atomic, serialized,
 * revision-checked, idempotency-aware operation over that state.
 *
 * Slice 1 verbs: session.describe · capabilities.get · project.create ·
 *   project.get_state · media.import · timeline.get · edit.apply
 * Slice 1b verbs (ADR 0002): preview.render_frame · export.start ·
 *   job.status · job.cancel · verify.artifact
 *
 * Pixel/export/verify backing arrives through the independent provider
 * interfaces in providers.ts (RenderProvider / ExportProvider /
 * ArtifactVerifier); the facade itself never imports Chromium or ffmpeg.
 * MCP/CLI transports remain out of scope.
 */
import type { Project, ProjectSettings } from "@openreel/core/types/project";
import type {
  ArtifactRef,
  ExportProgressEvent,
  VerifyReport,
} from "./providers";

export const FACADE_VERSION = "0.2.0" as const;
export const FACADE_CONTRACT_VERSION = "facade-slice-1b" as const;
export const FACADE_RUNTIME = "node-headless" as const;

/* ------------------------------------------------------------------ */
/* Verbs                                                               */
/* ------------------------------------------------------------------ */

export const FACADE_VERBS = [
  "session.describe",
  "capabilities.get",
  "project.create",
  "project.get_state",
  "media.import",
  "timeline.get",
  "edit.apply",
  "preview.render_frame",
  "export.start",
  "job.status",
  "job.cancel",
  "verify.artifact",
] as const;

export type FacadeVerb = (typeof FACADE_VERBS)[number];

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
  readonly createProject: "P";
  readonly importLocalMedia: "A";
  readonly trimClip: "P";
  readonly addTextOverlayModel: "P";
  readonly textOverlayPixels: "X" | "C";
  readonly exportVideo: "X" | "C";
  readonly verifyArtifact: "X" | "A";
}

export interface SessionDescription {
  readonly facadeVersion: string;
  readonly contractVersion: string;
  readonly runtime: typeof FACADE_RUNTIME;
  readonly verbs: readonly FacadeVerb[];
  readonly editOps: readonly EditOpType[];
  readonly errorCodes: readonly string[];
  readonly stepLetters: StepLetters;
  readonly notes: readonly string[];
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
}

export interface Capabilities {
  readonly runtime: typeof FACADE_RUNTIME;
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
}

export interface TimelineTrackView {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly clips: readonly TimelineClipView[];
}

export interface TextOverlayView {
  readonly id: string;
  readonly trackId: string;
  readonly text: string;
  readonly startTime: number;
  readonly duration: number;
}

export interface TimelineState {
  readonly revision: number;
  readonly duration: number;
  readonly tracks: readonly TimelineTrackView[];
  readonly textOverlays: readonly TextOverlayView[];
}

/* ------------------------------------------------------------------ */
/* edit.apply — closed op set (Slice 1)                                */
/* ------------------------------------------------------------------ */

export const EDIT_OP_TYPES = [
  "track.add",
  "clip.add",
  "clip.trim",
  "text.create",
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

/** Closed style subset accepted by text.create in this slice. */
export interface TextStyleInput {
  readonly fontFamily?: string;
  readonly fontSize?: number;
  readonly fontWeight?: import("@openreel/core/text/types").FontWeight;
  readonly color?: string;
  readonly textAlign?: "left" | "center" | "right" | "justify";
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
}

export type EditOp = TrackAddOp | ClipAddOp | ClipTrimOp | TextCreateOp;

export interface EditApplyParams {
  readonly ops: readonly EditOp[];
  readonly expectedRevision?: number;
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
