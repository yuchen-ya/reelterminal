import type { Clip, Track } from "../types/timeline";
import type { Project } from "../types/project";
import { mediaDisplayName } from "../types/project";
import type {
  WorkAsset,
  WorkAssetClipSnapshot,
  WorkAssetMember,
  WorkAssetMemberTransition,
  WorkAssetUnsupportedParam,
} from "../types/work-asset";
import { WORK_ASSET_MAX_MEMBERS } from "../types/work-asset";

/**
 * Work-asset capture. Shared by the GUI "save to work assets" entry and the
 * agent facade's workAsset.capture op so both surfaces apply the exact same
 * prechecks and snapshot the exact same fields.
 *
 * Capture never silently drops clip state: analysis artifacts that cannot be
 * meaningfully persisted are stripped from the snapshot AND listed in
 * `WorkAsset.unsupportedParams`, while clips whose parameters cannot produce
 * a reusable asset at all (virtual overlays, placeholder media) are rejected
 * with a specific code instead of producing a degraded entry.
 *
 * `captureWorkAssetFromClips` extends the same contract to a SET of clips
 * (kind "multi"): one precheck pass over every member (any failure rejects
 * the whole set — never a partial asset), a relative layout (relativeStart +
 * lane coordinates, no instance ids), and per-member snapshots.
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

interface ClipLocation {
  readonly clip: Clip;
  readonly track: Track;
  /** Index of the track in project.timeline.tracks (deterministic tie-break). */
  readonly trackIndex: number;
  /** Index of the clip within its track (deterministic tie-break). */
  readonly clipIndex: number;
}

function findClipLocation(
  project: Project,
  clipId: string,
): ClipLocation | undefined {
  for (let trackIndex = 0; trackIndex < project.timeline.tracks.length; trackIndex++) {
    const track = project.timeline.tracks[trackIndex];
    for (let clipIndex = 0; clipIndex < track.clips.length; clipIndex++) {
      if (track.clips[clipIndex].id === clipId) {
        return {
          clip: track.clips[clipIndex],
          track,
          trackIndex,
          clipIndex,
        };
      }
    }
  }
  return undefined;
}

type ClipPrecheckFailure = {
  readonly ok: false;
  readonly code: "MEDIA_NOT_FOUND" | "UNSUPPORTED" | "INVALID_PARAMS";
  readonly message: string;
  readonly details: Record<string, unknown>;
};

/**
 * The exact rejection contract of single-clip capture, reused per member by
 * multi capture so both surfaces reject the same clips for the same reasons.
 */
function precheckClipForCapture(
  project: Project,
  clip: Clip,
  track: Track,
): ClipPrecheckFailure | undefined {
  if (track.type !== "video" && track.type !== "audio" && track.type !== "image") {
    return {
      ok: false,
      code: "UNSUPPORTED",
      message: `clip "${clip.id}" lives on a ${track.type} track — only video/audio/image clips can be captured`,
      details: { clipId: clip.id, trackType: track.type },
    };
  }
  if (isVirtualMediaId(clip.mediaId)) {
    return {
      ok: false,
      code: "UNSUPPORTED",
      message: `clip "${clip.id}" is an engine-generated overlay (media ${clip.mediaId}) — only clips backed by project media can be captured`,
      details: { clipId: clip.id, mediaId: clip.mediaId },
    };
  }
  const media = project.mediaLibrary.items.find(
    (item) => item.id === clip.mediaId,
  );
  if (!media) {
    return {
      ok: false,
      code: "MEDIA_NOT_FOUND",
      message: `clip "${clip.id}" references media "${clip.mediaId}" which is no longer in the project library`,
      details: { clipId: clip.id, mediaId: clip.mediaId },
    };
  }
  if (media.isPlaceholder === true) {
    return {
      ok: false,
      code: "UNSUPPORTED",
      message: `clip "${clip.id}" references media "${clip.mediaId}" whose bytes are missing (placeholder) — restore the media before capturing`,
      details: { clipId: clip.id, mediaId: clip.mediaId },
    };
  }
  if (!(clip.outPoint > clip.inPoint) || clip.inPoint < 0) {
    return {
      ok: false,
      code: "INVALID_PARAMS",
      message: `clip "${clip.id}" has a degenerate source range (in ${clip.inPoint}, out ${clip.outPoint})`,
      details: { clipId: clip.id, inPoint: clip.inPoint, outPoint: clip.outPoint },
    };
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

function formatRangeName(base: string, inSec: number, outSec: number): string {
  return `${base} (${inSec}s-${outSec}s)`;
}

function deriveDefaultName(project: Project, clip: Clip): string {
  const media = project.mediaLibrary.items.find(
    (item) => item.id === clip.mediaId,
  );
  const base = media ? mediaDisplayName(media) : clip.mediaId;
  return formatRangeName(base, clip.inPoint, clip.outPoint);
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
  const location = findClipLocation(project, clipId);
  if (!location) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: `clip "${clipId}" not found`,
      details: { clipId },
    };
  }
  const precheck = precheckClipForCapture(project, location.clip, location.track);
  if (precheck) {
    return {
      ok: false,
      code: precheck.code,
      message: precheck.message,
      details: precheck.details,
    };
  }
  const clip = location.clip;

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

function normalizeAssetName(
  requested: string | undefined,
  defaultName: string,
): { ok: true; name: string } | { ok: false; code: "INVALID_PARAMS"; message: string } {
  let name = (requested ?? defaultName).trim();
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
  return { ok: true, name };
}

export interface CaptureWorkAssetFromMediaOptions
  extends CaptureWorkAssetOptions {
  /** Source-media start in seconds; defaults to 0. */
  readonly inSec?: number;
  /**
   * Source-media end in seconds; defaults to the media's measured duration,
   * falling back to the conventional 5s still-image span (the same rule
   * `clip/add` applies when no explicit duration is passed).
   */
  readonly outSec?: number;
}

/**
 * Build a work asset straight from a project media item — no timeline
 * detour. The snapshot is the engine's DEFAULT clip parameter set for the
 * chosen source range (identity transform, no effects/keyframes, unit
 * volume), so instantiating the asset behaves exactly like dropping that
 * media span onto the timeline. Parameter-bearing captures still come from
 * `captureWorkAssetFromClip(s)`; this entry exists so raw imports and
 * generated files can be staged for reuse without occupying the timeline
 * first.
 */
export function captureWorkAssetFromMedia(
  project: Project,
  mediaId: string,
  options: CaptureWorkAssetFromMediaOptions = {},
): WorkAssetCaptureResult {
  const media = project.mediaLibrary.items.find((item) => item.id === mediaId);
  if (!media) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: `media "${mediaId}" is not in the project library`,
      details: { mediaId },
    };
  }
  if (media.isPlaceholder === true) {
    return {
      ok: false,
      code: "UNSUPPORTED",
      message: `media "${mediaId}" is a placeholder whose bytes are missing — restore the media before capturing`,
      details: { mediaId },
    };
  }

  const inSec = options.inSec ?? 0;
  const mediaDuration = media.metadata.duration;
  const defaultOutSec = mediaDuration > 0 ? mediaDuration : 5;
  const outSec = options.outSec ?? defaultOutSec;
  if (
    !Number.isFinite(inSec) ||
    !Number.isFinite(outSec) ||
    inSec < 0 ||
    outSec <= inSec
  ) {
    return {
      ok: false,
      code: "INVALID_PARAMS",
      message: `degenerate source range (in ${inSec}, out ${outSec})`,
      details: { mediaId, inSec, outSec },
    };
  }
  if (mediaDuration > 0 && outSec > mediaDuration) {
    return {
      ok: false,
      code: "INVALID_PARAMS",
      message: `source range ends at ${outSec}s but media "${mediaId}" is only ${mediaDuration}s long`,
      details: { mediaId, inSec, outSec, mediaDuration },
    };
  }

  const nameResult = normalizeAssetName(
    options.name,
    formatRangeName(mediaDisplayName(media), inSec, outSec),
  );
  if (!nameResult.ok) return nameResult;

  const now = options.now ?? Date.now();
  const asset: WorkAsset = {
    schemaVersion: 1,
    kind: "single",
    id: options.assetId ?? `wa-${crypto.randomUUID()}`,
    name: nameResult.name,
    sourceMediaId: mediaId,
    sourceRange: { inSec, outSec },
    clipSnapshot: {
      duration: outSec - inSec,
      inPoint: inSec,
      outPoint: outSec,
      effects: [],
      audioEffects: [],
      transform: {
        position: { x: 0, y: 0 },
        scale: { x: 1, y: 1 },
        rotation: 0,
        anchor: { x: 0.5, y: 0.5 },
        opacity: 1,
      },
      volume: 1,
      keyframes: [],
    },
    unsupportedParams: [],
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

/**
 * Build ONE multi work asset from a SET of timeline clips (kind "multi").
 * The set is rejected as a whole when any member fails the single-clip
 * prechecks (never a partial asset); otherwise the members are stored as a
 * relative layout — `relativeStart` against the earliest startTime (T0) and
 * per-type lane offsets relative to the anchor member's lane — with the
 * anchor member mirrored into the top-level `sourceMediaId`/`sourceRange`.
 *
 * Transitions with both endpoints inside the set are archived by reference
 * (`WorkAsset.transitions`, memberIds, never instance ids). Single-sided edge
 * transitions and transitions touching clips outside the set are stripped and
 * declared in `unsupportedParams`; the same goes for track linkage
 * (`Track.groupId`), which is instance-local. Nothing is dropped silently.
 */
export function captureWorkAssetFromClips(
  project: Project,
  clipIds: readonly string[],
  options: CaptureWorkAssetOptions = {},
): WorkAssetCaptureResult {
  if (clipIds.length < 2) {
    return {
      ok: false,
      code: "INVALID_PARAMS",
      message: `multi-clip capture requires at least 2 clips (got ${clipIds.length})`,
      details: { clipIds: [...clipIds] },
    };
  }
  if (clipIds.length > WORK_ASSET_MAX_MEMBERS) {
    return {
      ok: false,
      code: "INVALID_PARAMS",
      message: `multi-clip capture supports at most ${WORK_ASSET_MAX_MEMBERS} clips (got ${clipIds.length})`,
      details: { clipIds: [...clipIds] },
    };
  }
  const seenIds = new Set<string>();
  for (const clipId of clipIds) {
    if (seenIds.has(clipId)) {
      return {
        ok: false,
        code: "INVALID_PARAMS",
        message: `clip "${clipId}" appears twice in the capture set — clips must be unique`,
        details: { clipIds: [...clipIds] },
      };
    }
    seenIds.add(clipId);
  }
  const missing = clipIds.filter((clipId) => !findClipLocation(project, clipId));
  if (missing.length > 0) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: `clips not found: ${missing.map((id) => `"${id}"`).join(", ")}`,
      details: { clipIds: missing },
    };
  }

  // Deterministic member order: startTime, then track array order, then
  // in-track order. The first member is the ANCHOR (relativeStart 0).
  const locations = clipIds.map((clipId) => findClipLocation(project, clipId)!);
  locations.sort(
    (a, b) =>
      a.clip.startTime - b.clip.startTime ||
      a.trackIndex - b.trackIndex ||
      a.clipIndex - b.clipIndex,
  );
  const t0 = locations[0].clip.startTime;

  // Per-member prechecks — identical rules to single capture; any failure
  // rejects the WHOLE set and reports every failing member.
  const perMember: Array<{
    clipId: string;
    code: "MEDIA_NOT_FOUND" | "UNSUPPORTED" | "INVALID_PARAMS";
    message: string;
  }> = [];
  for (const location of locations) {
    const failure = precheckClipForCapture(project, location.clip, location.track);
    if (failure) {
      perMember.push({
        clipId: location.clip.id,
        code: failure.code,
        message: failure.message,
      });
    }
  }
  if (perMember.length > 0) {
    return {
      ok: false,
      code: perMember[0].code,
      message: `multi-clip capture rejected: ${perMember.length} of ${locations.length} clips failed the prechecks — ${perMember[0].message}`,
      details: { perMember },
    };
  }

  // Relative lanes: for each track type, the distinct member tracks in
  // timeline array order get offsets; the anchor's own track is normalized to
  // offset 0 (offsets below it wrap behind, keeping every lane distinct).
  const anchorLocation = locations[0];
  const memberTracksByType = new Map<"video" | "audio" | "image", Track[]>();
  for (const track of project.timeline.tracks) {
    if (track.type !== "video" && track.type !== "audio" && track.type !== "image") {
      continue;
    }
    if (!locations.some((location) => location.track.id === track.id)) continue;
    const list = memberTracksByType.get(track.type) ?? [];
    if (!list.some((candidate) => candidate.id === track.id)) list.push(track);
    memberTracksByType.set(track.type, list);
  }
  const laneByTrackId = new Map<string, WorkAssetMember["lane"]>();
  for (const [trackType, tracks] of memberTracksByType) {
    const anchorIdx = tracks.findIndex(
      (track) => track.id === anchorLocation.track.id,
    );
    tracks.forEach((track, index) => {
      const offset =
        anchorIdx >= 0 ? (index - anchorIdx + tracks.length) % tracks.length : index;
      laneByTrackId.set(track.id, { trackType, laneOffset: offset });
    });
  }

  // Per-member snapshots; stripped parameters are re-namespaced into the
  // member's dotted path so the asset-level list stays self-describing.
  const members: WorkAssetMember[] = [];
  const unsupportedParams: WorkAssetUnsupportedParam[] = [];
  locations.forEach((location, index) => {
    const { snapshot, unsupportedParams: memberStripped } = buildClipSnapshot(
      location.clip,
    );
    for (const entry of memberStripped) {
      unsupportedParams.push({
        field: `members[${index}].${entry.field}`,
        reason: entry.reason,
      });
    }
    members.push({
      memberId: `m-${crypto.randomUUID()}`,
      mediaId: location.clip.mediaId,
      sourceRange: { inSec: location.clip.inPoint, outSec: location.clip.outPoint },
      relativeStart: location.clip.startTime - t0,
      lane: laneByTrackId.get(location.track.id)!,
      snapshot,
    });
  });

  // Transitions: both endpoints inside the set → archive by reference.
  // Single-sided (clipBId undefined) or touching clips outside the set →
  // strip and account. Transitions involving no member at all are left alone.
  const memberIdByClipId = new Map<string, string>();
  locations.forEach((location, index) => {
    memberIdByClipId.set(location.clip.id, members[index].memberId);
  });
  const transitions: WorkAssetMemberTransition[] = [];
  const scannedTrackIds = new Set<string>();
  for (const location of locations) {
    if (scannedTrackIds.has(location.track.id)) continue;
    scannedTrackIds.add(location.track.id);
    for (const transition of location.track.transitions) {
      const fromInSet = memberIdByClipId.has(transition.clipAId);
      const toInSet =
        transition.clipBId !== undefined &&
        memberIdByClipId.has(transition.clipBId);
      if (fromInSet && toInSet) {
        transitions.push({
          fromMemberId: memberIdByClipId.get(transition.clipAId)!,
          toMemberId: memberIdByClipId.get(transition.clipBId)!,
          type: transition.type,
          duration: transition.duration,
          params: structuredClone(transition.params),
        });
        continue;
      }
      if (!fromInSet && !toInSet) continue;
      unsupportedParams.push({
        field: `transitions[${transition.clipAId}→${transition.clipBId ?? `edge:${transition.edge ?? "out"}`}]`,
        reason:
          transition.clipBId === undefined
            ? "single-sided edge transition; not a between-member transition"
            : "references clips outside the capture set",
      });
    }
  }

  // Track linkage (groupId) is instance-local; account once when present.
  if (locations.some((location) => location.track.groupId !== undefined)) {
    unsupportedParams.push({
      field: "trackGroups",
      reason: "track linkage is instance-local and not part of the reusable layout",
    });
  }

  const anchorClip = anchorLocation.clip;
  const anchorMedia = project.mediaLibrary.items.find(
    (item) => item.id === anchorClip.mediaId,
  );
  const base = anchorMedia ? mediaDisplayName(anchorMedia) : anchorClip.mediaId;
  const nameResult = normalizeAssetName(
    options.name,
    `${base} composite ×${members.length}`,
  );
  if (!nameResult.ok) return nameResult;

  const now = options.now ?? Date.now();
  const asset: WorkAsset = {
    schemaVersion: 1,
    kind: "multi",
    id: options.assetId ?? `wa-${crypto.randomUUID()}`,
    name: nameResult.name,
    sourceMediaId: anchorClip.mediaId,
    sourceRange: { inSec: anchorClip.inPoint, outSec: anchorClip.outPoint },
    members,
    ...(transitions.length > 0 ? { transitions } : {}),
    unsupportedParams,
    ...(options.captureRequestId !== undefined
      ? { captureRequestId: options.captureRequestId }
      : {}),
    ...(options.createdBy !== undefined ? { createdBy: options.createdBy } : {}),
    createdAt: now,
    updatedAt: now,
  };
  return { ok: true, asset };
}
