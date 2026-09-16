import type { Clip } from "../types/timeline";
import type { Project } from "../types/project";
import { mediaDisplayName } from "../types/project";
import type {
  WorkAsset,
  WorkAssetClipSnapshot,
  WorkAssetUnsupportedParam,
} from "../types/work-asset";

/**
 * Single-clip work-asset capture. Shared by the GUI "save to work assets"
 * entry and the agent facade's workAsset.capture op so both surfaces apply
 * the exact same prechecks and snapshot the exact same fields.
 *
 * Capture never silently drops clip state: analysis artifacts that cannot be
 * meaningfully persisted are stripped from the snapshot AND listed in
 * `WorkAsset.unsupportedParams`, while clips whose parameters cannot produce
 * a reusable asset at all (virtual overlays, placeholder media) are rejected
 * with a specific code instead of producing a degraded entry.
 */

export type WorkAssetCaptureResult =
  | { readonly ok: true; readonly asset: WorkAsset }
  | {
      readonly ok: false;
      readonly code:
        | "NOT_FOUND"
        | "MEDIA_NOT_FOUND"
        | "UNSUPPORTED"
        | "INVALID_PARAMS";
      readonly message: string;
      readonly details?: Record<string, unknown>;
    };

export interface CaptureWorkAssetOptions {
  /** Display name; derived from the source media when omitted. */
  readonly name?: string;
  /** Stable operational id; a fresh one is minted when omitted. */
  readonly assetId?: string;
  /** Echoed onto the asset for traceability; never an identity. */
  readonly captureRequestId?: string;
  readonly createdBy?: "user" | "agent";
  /** Injectable clock for deterministic tests. */
  readonly now?: number;
}

/** mediaId prefixes of timeline clips that draw engine-generated content. */
const VIRTUAL_MEDIA_PREFIXES = [
  "text-",
  "shape-",
  "svg-",
  "sticker-",
  "motion-",
] as const;

function isVirtualMediaId(mediaId: string): boolean {
  return VIRTUAL_MEDIA_PREFIXES.some((prefix) => mediaId.startsWith(prefix));
}

function findClip(project: Project, clipId: string): Clip | undefined {
  for (const track of project.timeline.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip) return clip;
  }
  return undefined;
}

/**
 * Collect the parameters that are deliberately NOT carried into the snapshot.
 * Stabilization's analysis artifacts are runtime outputs recomputed for each
 * new instance; clip metadata is instance-local provenance. Everything else
 * on the clip is plain data and snapshots as-is.
 */
function buildClipSnapshot(clip: Clip): {
  snapshot: WorkAssetClipSnapshot;
  unsupportedParams: WorkAssetUnsupportedParam[];
} {
  const unsupportedParams: WorkAssetUnsupportedParam[] = [];
  const stabilization = clip.stabilization;
  if (stabilization !== undefined) {
    if (stabilization.analyzed !== undefined) {
      unsupportedParams.push({
        field: "stabilization.analyzed",
        reason: "analysis artifact; recomputed when an instance is created",
      });
    }
    if (stabilization.analysisVersion !== undefined) {
      unsupportedParams.push({
        field: "stabilization.analysisVersion",
        reason: "analysis artifact; recomputed when an instance is created",
      });
    }
    if (stabilization.profile !== undefined) {
      unsupportedParams.push({
        field: "stabilization.profile",
        reason: "analysis artifact; recomputed when an instance is created",
      });
    }
  }
  if (clip.metadata !== undefined) {
    unsupportedParams.push({
      field: "metadata",
      reason: "instance-local clip provenance is not part of the reusable snapshot",
    });
  }
  const snapshot: WorkAssetClipSnapshot = {
    duration: clip.duration,
    inPoint: clip.inPoint,
    outPoint: clip.outPoint,
    effects: structuredClone(clip.effects),
    audioEffects: structuredClone(clip.audioEffects),
    transform: structuredClone(clip.transform),
    volume: clip.volume,
    keyframes: structuredClone(clip.keyframes),
    ...(clip.blendMode !== undefined ? { blendMode: clip.blendMode } : {}),
    ...(clip.blendOpacity !== undefined
      ? { blendOpacity: clip.blendOpacity }
      : {}),
    ...(clip.colorGrading !== undefined
      ? { colorGrading: structuredClone(clip.colorGrading) }
      : {}),
    ...(clip.fade !== undefined ? { fade: structuredClone(clip.fade) } : {}),
    ...(clip.automation !== undefined
      ? { automation: structuredClone(clip.automation) }
      : {}),
    ...(clip.speed !== undefined ? { speed: clip.speed } : {}),
    ...(clip.reversed !== undefined ? { reversed: clip.reversed } : {}),
    ...(clip.smoothSlowMo !== undefined
      ? { smoothSlowMo: clip.smoothSlowMo }
      : {}),
    ...(clip.interpolationQuality !== undefined
      ? { interpolationQuality: clip.interpolationQuality }
      : {}),
    ...(stabilization !== undefined
      ? {
          stabilization: {
            enabled: stabilization.enabled,
            strength: stabilization.strength,
            cropMode: stabilization.cropMode,
          },
        }
      : {}),
    ...(clip.emphasisAnimation !== undefined
      ? { emphasisAnimation: structuredClone(clip.emphasisAnimation) }
      : {}),
    ...(clip.chromaKey !== undefined
      ? { chromaKey: structuredClone(clip.chromaKey) }
      : {}),
    ...(clip.speedKeyframes !== undefined
      ? { speedKeyframes: structuredClone(clip.speedKeyframes) }
      : {}),
    ...(clip.freezeFrames !== undefined
      ? { freezeFrames: structuredClone(clip.freezeFrames) }
      : {}),
    ...(clip.pitchCorrection !== undefined
      ? { pitchCorrection: clip.pitchCorrection }
      : {}),
    ...(clip.audioTrackIndex !== undefined
      ? { audioTrackIndex: clip.audioTrackIndex }
      : {}),
  };
  return { snapshot, unsupportedParams };
}

function deriveDefaultName(project: Project, clip: Clip): string {
  const media = project.mediaLibrary.items.find(
    (item) => item.id === clip.mediaId,
  );
  const base = media ? mediaDisplayName(media) : clip.mediaId;
  return `${base} (${clip.inPoint}s-${clip.outPoint}s)`;
}

/**
 * Build a work asset from one timeline clip. Rejects (without producing an
 * entry) clips that cannot yield a reusable asset; otherwise returns the
 * complete asset ready for `workAsset/create`.
 */
export function captureWorkAssetFromClip(
  project: Project,
  clipId: string,
  options: CaptureWorkAssetOptions = {},
): WorkAssetCaptureResult {
  const clip = findClip(project, clipId);
  if (!clip) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: `clip "${clipId}" not found`,
      details: { clipId },
    };
  }
  if (isVirtualMediaId(clip.mediaId)) {
    return {
      ok: false,
      code: "UNSUPPORTED",
      message: `clip "${clipId}" is an engine-generated overlay (media ${clip.mediaId}) — only clips backed by project media can be captured`,
      details: { clipId, mediaId: clip.mediaId },
    };
  }
  const media = project.mediaLibrary.items.find(
    (item) => item.id === clip.mediaId,
  );
  if (!media) {
    return {
      ok: false,
      code: "MEDIA_NOT_FOUND",
      message: `clip "${clipId}" references media "${clip.mediaId}" which is no longer in the project library`,
      details: { clipId, mediaId: clip.mediaId },
    };
  }
  if (media.isPlaceholder === true) {
    return {
      ok: false,
      code: "UNSUPPORTED",
      message: `clip "${clipId}" references media "${clip.mediaId}" whose bytes are missing (placeholder) — restore the media before capturing`,
      details: { clipId, mediaId: clip.mediaId },
    };
  }
  if (!(clip.outPoint > clip.inPoint) || clip.inPoint < 0) {
    return {
      ok: false,
      code: "INVALID_PARAMS",
      message: `clip "${clipId}" has a degenerate source range (in ${clip.inPoint}, out ${clip.outPoint})`,
      details: { clipId, inPoint: clip.inPoint, outPoint: clip.outPoint },
    };
  }

  let name = options.name ?? deriveDefaultName(project, clip);
  name = name.trim();
  if (name.length === 0) {
    return {
      ok: false,
      code: "INVALID_PARAMS",
      message: "work asset name cannot be empty",
    };
  }
  if (name.length > 200) {
    name = name.slice(0, 200);
  }

  const { snapshot, unsupportedParams } = buildClipSnapshot(clip);
  const now = options.now ?? Date.now();
  const asset: WorkAsset = {
    schemaVersion: 1,
    kind: "single",
    id: options.assetId ?? `wa-${crypto.randomUUID()}`,
    name,
    sourceMediaId: clip.mediaId,
    sourceRange: { inSec: clip.inPoint, outSec: clip.outPoint },
    clipSnapshot: snapshot,
    unsupportedParams,
    ...(options.captureRequestId !== undefined
      ? { captureRequestId: options.captureRequestId }
      : {}),
    ...(options.createdBy !== undefined
      ? { createdBy: options.createdBy }
      : {}),
    createdAt: now,
    updatedAt: now,
  };
  return { ok: true, asset };
}
