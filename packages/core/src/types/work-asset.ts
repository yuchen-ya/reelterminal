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

export interface WorkAsset {
  readonly schemaVersion: 1;
  /** Stable operational identity; never reused after deletion. */
  readonly id: string;
  /** "single" today; "multi" (relative multi-clip layout) is reserved. */
  readonly kind: "single" | "multi";
  /** Search key only — names are not unique and are never an identity. */
  readonly name: string;
  /** Referenced project media; bytes are never duplicated. */
  readonly sourceMediaId: string;
  readonly sourceRange: WorkAssetSourceRange;
  /** Present for kind "single"; absent for the reserved "multi" layout. */
  readonly clipSnapshot?: WorkAssetClipSnapshot;
  /** Parameters explicitly not captured (never silently dropped). */
  readonly unsupportedParams: readonly WorkAssetUnsupportedParam[];
  /** Echo of the facade idempotency key that produced this asset, if any. */
  readonly captureRequestId?: string;
  readonly createdBy?: "user" | "agent";
  readonly createdAt: number;
  readonly updatedAt: number;
}
