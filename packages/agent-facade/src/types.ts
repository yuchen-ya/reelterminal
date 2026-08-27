/**
 * Public contract of the in-process agent facade (Slice 1).
 *
 * The facade is a pure-Node, transport-agnostic library. The core `Project`
 * is the canonical state; every mutation is an atomic, serialized,
 * revision-checked, idempotency-aware operation over that state.
 *
 * Scope of this slice (audit/facade-v0.md, reduced to the state-level E2E):
 *   session.describe · capabilities.get · project.create · project.get_state
 *   media.import · timeline.get · edit.apply
 *
 * Deliberately NOT in this slice: Chromium/pixel rendering, export, OCR,
 * MCP/CLI transports, cloud GPU. `RenderAdapter` (render/adapter.ts) is the
 * hydration seam reserved for the future Chromium runtime.
 */
import type { Project, ProjectSettings } from "@openreel/core/types/project";

export const FACADE_VERSION = "0.1.0" as const;
export const FACADE_CONTRACT_VERSION = "facade-slice-1" as const;
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
] as const;

export type FacadeVerb = (typeof FACADE_VERBS)[number];

/* ------------------------------------------------------------------ */
/* session.describe                                                    */
/* ------------------------------------------------------------------ */

/** Runtime classification per E2E step (audit/e2e-contract.md letters). */
export interface StepLetters {
  readonly facadeToRuntime: "P";
  readonly createProject: "P";
  readonly importLocalMedia: "A";
  readonly trimClip: "P";
  readonly addTextOverlayModel: "P";
  readonly textOverlayPixels: "X";
  readonly exportVideo: "X";
  readonly verifyArtifact: "X";
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
    /** Honest: this slice never claims pixel-verified text. */
    readonly pixelRendering: false;
  };
  readonly preview: CapabilityStatus;
  readonly export: CapabilityStatus;
}

/* ------------------------------------------------------------------ */
/* project.*                                                           */
/* ------------------------------------------------------------------ */

export interface ProjectCreateParams {
  readonly name?: string;
  readonly settings?: Partial<ProjectSettings>;
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
