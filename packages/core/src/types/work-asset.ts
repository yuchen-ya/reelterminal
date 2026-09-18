import type {
  ChromaKeySettings,
  Clip,
  Effect,
  FreezeFrame,
  Keyframe,
  SpeedKeyframe,
  Transform,
} from "./timeline";
import type { ClipColorGrading } from "../video/color-grading-engine";
import type { BlendMode } from "../video/types";
import type { EmphasisAnimation } from "../graphics/types";

/**
 * Project-scoped work asset ("saved work"): a named, stable-id reference to a
 * reusable span of project media plus a snapshot of the serializable clip
 * parameters captured with it. The asset lives in the project JSON and never
 * copies media bytes; instantiating it later builds fresh timeline clips from
 * `clipSnapshot`. Distinct from the user-level material library, which spans
 * projects.
 */

export interface WorkAssetSourceRange {
  /** Inclusive source-media start in seconds. */
  readonly inSec: number;
  /** Exclusive source-media end in seconds (must be > inSec). */
  readonly outSec: number;
}

/**
 * A captured parameter that is deliberately NOT part of the snapshot, recorded
 * so capture can state what was dropped instead of discarding it silently.
 */
export interface WorkAssetUnsupportedParam {
  /** Dotted path into the clip, e.g. "stabilization.profile". */
  readonly field: string;
  /** Why the parameter is not captured, e.g. recomputed at instantiate time. */
  readonly reason: string;
}

/**
 * Pure-data subset of `Clip` safe to persist and to replay onto a new clip
 * instance. Instance-identity fields (id/mediaId/trackId/startTime) are
 * injected at instantiate time; stabilization's analysis artifacts
 * (`analyzed`/`analysisVersion`/`profile`) are stripped — they are recomputed
 * for the new instance and their absence is declared in
 * `WorkAsset.unsupportedParams`.
 */
export interface WorkAssetClipSnapshot {
  readonly duration: number;
  readonly inPoint: number;
  readonly outPoint: number;
  readonly effects: Effect[];
  readonly audioEffects: Effect[];
  readonly transform: Transform;
  readonly blendMode?: BlendMode;
  readonly blendOpacity?: number;
  readonly colorGrading?: ClipColorGrading;
  readonly volume: number;
  readonly fade?: { fadeIn: number; fadeOut: number };
  readonly automation?: Clip["automation"];
  readonly keyframes: Keyframe[];
  readonly speed?: number;
  readonly reversed?: boolean;
  readonly smoothSlowMo?: boolean;
  readonly interpolationQuality?: Clip["interpolationQuality"];
  readonly stabilization?: {
    enabled: boolean;
    strength: number;
    cropMode: "auto" | "none";
  };
  readonly emphasisAnimation?: EmphasisAnimation;
  readonly chromaKey?: ChromaKeySettings;
  readonly speedKeyframes?: SpeedKeyframe[];
  readonly freezeFrames?: FreezeFrame[];
  readonly pitchCorrection?: boolean;
  readonly audioTrackIndex?: number;
}

/** Upper bound on members of one multi work asset (also the capture-set cap). */
export const WORK_ASSET_MAX_MEMBERS = 64;
/** Upper bound on distinct lanes a multi work asset expands onto. */
export const WORK_ASSET_MAX_LANES = 32;

/** Relative lane coordinate: track type plus the index within same-type lanes. */
export interface WorkAssetMemberLane {
  readonly trackType: "video" | "audio" | "image";
  /** Integer 0..31; the anchor member's lane is always offset 0. */
  readonly laneOffset: number;
}

/**
 * One member of a multi work asset: a single-clip snapshot plus its position
 * in the shared relative layout. Instance identity (clip id/trackId/absolute
 * startTime) is minted at instantiate time and never persisted here.
 */
export interface WorkAssetMember {
  /** Unique identity inside the capture set (minted as `m-<uuid>`). */
  readonly memberId: string;
  /** The member's own project media reference; bytes are never duplicated. */
  readonly mediaId: string;
  /** The member's own trim range within its source media (0 ≤ inSec < outSec). */
  readonly sourceRange: WorkAssetSourceRange;
  /**
   * member.startTime − T0 (T0 = the earliest startTime in the capture set), in
   * timeline seconds (speed-adjusted, same coordinate system as
   * snapshot.duration). Finite and ≥ 0.
   */
  readonly relativeStart: number;
  /** Relative lane: track type + index among same-type lanes; never a trackId. */
  readonly lane: WorkAssetMemberLane;
  /** Same snapshot structure as kind "single" (including strip accounting). */
  readonly snapshot: WorkAssetClipSnapshot;
}

/**
 * A transition between two members captured by reference: both endpoint clips
 * were inside the capture set, so the intent is archived against the stable
 * memberIds (never instance clip ids). Instantiate does not replay archived
 * transitions yet — this archive is the record that they exist; only
 * transitions that could NOT be archived (single-sided edge, endpoints
 * outside the set) are declared in `unsupportedParams`.
 */
export interface WorkAssetMemberTransition {
  readonly fromMemberId: string;
  readonly toMemberId: string;
  readonly type: string;
  readonly duration: number;
  readonly params: Record<string, unknown>;
}

export interface WorkAsset {
  readonly schemaVersion: 1;
  /** Stable operational identity; never reused after deletion. */
  readonly id: string;
  /** "single" = one clip snapshot; "multi" = relative multi-clip layout. */
  readonly kind: "single" | "multi";
  /** Search key only — names are not unique and are never an identity. */
  readonly name: string;
  /**
   * Anchor media of the asset; bytes are never duplicated. For "single" this
   * is the captured clip's media; for "multi" it is the ANCHOR member's media
   * (the member with relativeStart 0, i.e. the T0 time anchor). The full
   * cross-track layout lives in `members`. Both this and `sourceRange` stay
   * required for both kinds — a compatibility anchor so storage, retention,
   * and query paths never branch on kind.
   */
  readonly sourceMediaId: string;
  readonly sourceRange: WorkAssetSourceRange;
  /** Required for kind "single"; must be absent for kind "multi". */
  readonly clipSnapshot?: WorkAssetClipSnapshot;
  /**
   * Required (non-empty) for kind "multi"; must be absent for kind "single".
   * The first condition of the multi layout is that both shape variants stay
   * mutually exclusive so dirty data can never hybridize.
   */
  readonly members?: readonly WorkAssetMember[];
  /**
   * Member-to-member transitions captured by reference (both endpoints inside
   * the capture set). Absent = none captured. Transitions touching clips
   * OUTSIDE the set are stripped and declared in `unsupportedParams` instead.
   */
  readonly transitions?: readonly WorkAssetMemberTransition[];
  /** Parameters explicitly not captured (never silently dropped). */
  readonly unsupportedParams: readonly WorkAssetUnsupportedParam[];
  /** Echo of the facade idempotency key that produced this asset, if any. */
  readonly captureRequestId?: string;
  readonly createdBy?: "user" | "agent";
  readonly createdAt: number;
  readonly updatedAt: number;
}
