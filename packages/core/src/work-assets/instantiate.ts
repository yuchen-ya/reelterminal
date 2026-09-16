import type { Action } from "../types/actions";
import type { Clip } from "../types/timeline";
import type { Project } from "../types/project";
import type { WorkAsset } from "../types/work-asset";

/**
 * Work-asset instantiation as an action batch. The returned actions follow
 * the material-library attach pattern: an optional `track/add` for a freshly
 * pre-allocated lane, then one `clip/add` carrying a full `sourceClip` built
 * from the asset's snapshot — core clones it and injects the instance identity
 * (id/trackId/startTime), so editing the instance can never reach back into
 * the asset entry. No media import is needed: the clip references the same
 * `sourceMediaId` the asset already points at (bytes are never duplicated).
 *
 * The batch is submitted as ONE group (single undo unit, all-or-nothing) by
 * the caller; ids are pre-allocated here so dry-run and live commits pin the
 * same identities.
 */

export type WorkAssetInstantiateResult =
  | {
      readonly ok: true;
      readonly actions: readonly Action[];
      readonly trackId: string;
      readonly clipId: string;
      /** True when the batch starts with a track/add for a new lane. */
      readonly createdTrack: boolean;
    }
  | {
      readonly ok: false;
      readonly code:
        | "NOT_FOUND"
        | "MEDIA_NOT_FOUND"
        | "CONFLICT"
        | "INVALID_PARAMS";
      readonly message: string;
      readonly details?: Record<string, unknown>;
    };

export interface InstantiateWorkAssetOptions {
  /**
   * Existing target lane; its type must match the source media. Omitted, a
   * new matching lane is created (same convention as material attach).
   */
  readonly trackId?: string;
  /** Timeline seconds; defaults to the end of the timeline. */
  readonly startTime?: number;
  /** Deterministic clip id; a fresh one is minted when omitted. */
  readonly clipId?: string;
  /** Injectable identity/clock for deterministic tests. */
  readonly now?: number;
}

function trackTypeForMediaType(
  mediaType: "video" | "audio" | "image",
): "video" | "audio" | "image" {
  return mediaType;
}

function timelineEndSec(project: Project): number {
  let end = 0;
  for (const track of project.timeline.tracks) {
    for (const clip of track.clips) {
      end = Math.max(end, clip.startTime + clip.duration);
    }
  }
  return end;
}

/**
 * Envelope check mirroring the create-time snapshot validator: identity
 * numbers/arrays the instantiated clip relies on must be sane BEFORE any
 * action is built. Deep effect/transform parameter validation remains with
 * the engine that later renders the instance — a snapshot that passed this
 * guard but carries garbage effect params fails that render honestly, it is
 * never silently normalized here.
 */
function isSnapshotShapeValid(snapshot: WorkAsset["clipSnapshot"]): boolean {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return false;
  }
  const s = snapshot as unknown as Record<string, unknown>;
  const isFiniteNumber = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value);
  if (!isFiniteNumber(s.duration) || s.duration < 0) return false;
  if (!isFiniteNumber(s.inPoint) || s.inPoint < 0) return false;
  if (!isFiniteNumber(s.outPoint) || s.outPoint <= s.inPoint) return false;
  if (!Array.isArray(s.effects) || !Array.isArray(s.audioEffects)) return false;
  if (!Array.isArray(s.keyframes)) return false;
  if (!s.transform || typeof s.transform !== "object") return false;
  if (!isFiniteNumber(s.volume) || s.volume < 0) return false;
  if (s.speed !== undefined && (!isFiniteNumber(s.speed) || s.speed <= 0)) {
    return false;
  }
  if (s.stabilization !== undefined) {
    const st = s.stabilization as Record<string, unknown>;
    if (
      typeof st !== "object" ||
      st === null ||
      typeof st.enabled !== "boolean" ||
      !isFiniteNumber(st.strength) ||
      (st.cropMode !== "auto" && st.cropMode !== "none")
    ) {
      return false;
    }
  }
  return true;
}

function buildClipFromSnapshot(
  asset: WorkAsset,
  overrides: { id: string; trackId: string; startTime: number },
): Clip {
  const snapshot = asset.clipSnapshot!;
  return {
    id: overrides.id,
    mediaId: asset.sourceMediaId,
    trackId: overrides.trackId,
    startTime: overrides.startTime,
    duration: snapshot.duration,
    inPoint: snapshot.inPoint,
    outPoint: snapshot.outPoint,
    effects: structuredClone(snapshot.effects),
    audioEffects: structuredClone(snapshot.audioEffects),
    transform: structuredClone(snapshot.transform),
    volume: snapshot.volume,
    keyframes: structuredClone(snapshot.keyframes),
    ...(snapshot.blendMode !== undefined
      ? { blendMode: snapshot.blendMode }
      : {}),
    ...(snapshot.blendOpacity !== undefined
      ? { blendOpacity: snapshot.blendOpacity }
      : {}),
    ...(snapshot.colorGrading !== undefined
      ? { colorGrading: structuredClone(snapshot.colorGrading) }
      : {}),
    ...(snapshot.fade !== undefined
      ? { fade: structuredClone(snapshot.fade) }
      : {}),
    ...(snapshot.automation !== undefined
      ? { automation: structuredClone(snapshot.automation) }
      : {}),
    ...(snapshot.speed !== undefined ? { speed: snapshot.speed } : {}),
    ...(snapshot.reversed !== undefined
      ? { reversed: snapshot.reversed }
      : {}),
    ...(snapshot.smoothSlowMo !== undefined
      ? { smoothSlowMo: snapshot.smoothSlowMo }
      : {}),
    ...(snapshot.interpolationQuality !== undefined
      ? { interpolationQuality: snapshot.interpolationQuality }
      : {}),
    ...(snapshot.stabilization !== undefined
      ? { stabilization: structuredClone(snapshot.stabilization) }
      : {}),
    ...(snapshot.emphasisAnimation !== undefined
      ? { emphasisAnimation: structuredClone(snapshot.emphasisAnimation) }
      : {}),
    ...(snapshot.chromaKey !== undefined
      ? { chromaKey: structuredClone(snapshot.chromaKey) }
      : {}),
    ...(snapshot.speedKeyframes !== undefined
      ? { speedKeyframes: structuredClone(snapshot.speedKeyframes) }
      : {}),
    ...(snapshot.freezeFrames !== undefined
      ? { freezeFrames: structuredClone(snapshot.freezeFrames) }
      : {}),
    ...(snapshot.pitchCorrection !== undefined
      ? { pitchCorrection: snapshot.pitchCorrection }
      : {}),
    ...(snapshot.audioTrackIndex !== undefined
      ? { audioTrackIndex: snapshot.audioTrackIndex }
      : {}),
  };
}

/**
 * Build the instantiation action batch for one single-clip work asset.
 * The asset entry itself is never modified: repeated instantiation keeps
 * producing fresh independent clips from the same snapshot.
 */
export function buildWorkAssetInstantiateActions(
  project: Project,
  workAssetId: string,
  options: InstantiateWorkAssetOptions = {},
): WorkAssetInstantiateResult {
  const asset = (project.workAssets ?? []).find(
    (candidate) => candidate.id === workAssetId,
  );
  if (!asset) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: `work asset "${workAssetId}" not found`,
      details: { workAssetId },
    };
  }
  if (asset.kind !== "single" || !asset.clipSnapshot) {
    return {
      ok: false,
      code: "INVALID_PARAMS",
      message: `work asset "${workAssetId}" has no single-clip snapshot to instantiate`,
      details: { workAssetId, kind: asset.kind },
    };
  }
  if (!isSnapshotShapeValid(asset.clipSnapshot)) {
    return {
      ok: false,
      code: "INVALID_PARAMS",
      message: `work asset "${asset.name}" (${workAssetId}) carries a malformed snapshot — the asset cannot be instantiated`,
      details: { workAssetId },
    };
  }
  const media = project.mediaLibrary.items.find(
    (item) => item.id === asset.sourceMediaId,
  );
  if (!media) {
    return {
      ok: false,
      code: "MEDIA_NOT_FOUND",
      message: `work asset "${asset.name}" (${workAssetId}) references media "${asset.sourceMediaId}" that is no longer in the project library — the source media was deleted`,
      details: { workAssetId, sourceMediaId: asset.sourceMediaId },
    };
  }

  const trackType = trackTypeForMediaType(media.type);
  let trackId = options.trackId;
  let createdTrack = false;
  if (trackId !== undefined) {
    const track = project.timeline.tracks.find(
      (candidate) => candidate.id === trackId,
    );
    if (!track) {
      return {
        ok: false,
        code: "NOT_FOUND",
        message: `track "${trackId}" not found`,
        details: { trackId },
      };
    }
    if (track.type !== trackType) {
      return {
        ok: false,
        code: "CONFLICT",
        message: `track "${trackId}" is a ${track.type} track, but the work asset's source media is ${trackType}`,
        details: { trackId, trackType: track.type, mediaType: trackType },
      };
    }
  } else {
    trackId = `track-${crypto.randomUUID()}`;
    createdTrack = true;
  }

  const clipId = options.clipId ?? `clip-${crypto.randomUUID()}`;
  if (
    project.timeline.tracks.some((track) =>
      track.clips.some((candidate) => candidate.id === clipId),
    )
  ) {
    return {
      ok: false,
      code: "CONFLICT",
      message: `a clip with id "${clipId}" already exists`,
      details: { clipId },
    };
  }

  const startTime = options.startTime ?? timelineEndSec(project);
  if (!Number.isFinite(startTime) || startTime < 0) {
    return {
      ok: false,
      code: "INVALID_PARAMS",
      message: `startTime must be a finite number >= 0 (got ${startTime})`,
      details: { startTime: options.startTime ?? null },
    };
  }

  const clip = buildClipFromSnapshot(asset, {
    id: clipId,
    trackId,
    startTime,
  });
  const actions: Action[] = [
    ...(createdTrack
      ? [
          {
            type: "track/add" as const,
            id: `action-${crypto.randomUUID()}`,
            timestamp: options.now ?? Date.now(),
            params: { trackType, trackId },
          },
        ]
      : []),
    {
      type: "clip/add" as const,
      id: `action-${crypto.randomUUID()}`,
      timestamp: options.now ?? Date.now(),
      params: {
        clipId,
        trackId,
        mediaId: asset.sourceMediaId,
        startTime,
        sourceClip: clip,
      },
    },
  ];
  return { ok: true, actions, trackId, clipId, createdTrack };
}
