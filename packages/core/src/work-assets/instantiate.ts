import type { Action } from "../types/actions";
import type { Clip } from "../types/timeline";
import type { Project } from "../types/project";
import type {
  WorkAsset,
  WorkAssetClipSnapshot,
  WorkAssetMember,
  WorkAssetMemberLane,
} from "../types/work-asset";
import {
  WORK_ASSET_MAX_LANES,
  WORK_ASSET_MAX_MEMBERS,
} from "../types/work-asset";

/**
 * Work-asset instantiation as an action batch. The returned actions follow
 * the material-library attach pattern: `track/add` for freshly pre-allocated
 * lanes, then `clip/add` entries carrying full `sourceClip`s built from the
 * snapshot(s) — core clones them and injects the instance identity
 * (id/trackId/startTime), so editing an instance can never reach back into
 * the asset entry. No media import is needed: clips reference the same media
 * ids the asset already points at (bytes are never duplicated).
 *
 * kind "single" builds one clip (legacy result fields kept); kind "multi"
 * expands the relative member layout onto one lane per (trackType, laneOffset)
 * — the anchor lane may reuse `options.trackId`, every other lane is a fresh
 * track. The batch is submitted as ONE group (single undo unit,
 * all-or-nothing) by the caller; ids are pre-allocated here so dry-run and
 * live commits pin the same identities.
 */

export type WorkAssetInstantiateResult =
  | {
      readonly ok: true;
      readonly actions: readonly Action[];
      /**
       * kind "single": the single target lane. kind "multi": the anchor lane
       * (the lane with the anchor member's trackType and laneOffset 0) — the
       * lane `options.trackId` binds to. Not necessarily `trackIds[0]`, which
       * follows track/add emission order.
       */
      readonly trackId: string;
      /** kind "single": the one instance clip. kind "multi": the anchor clip. */
      readonly clipId: string;
      /** True when the batch contains at least one track/add. */
      readonly createdTrack: boolean;
      /** Every instantiated clip id, in member order for "multi". */
      readonly clipIds: readonly string[];
      /** Every lane the batch touches, in track/add emission order for "multi". */
      readonly trackIds: readonly string[];
      readonly createdTrackCount: number;
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

/**
 * Shared snapshot→Clip builder for both kinds. The parameter shape is the
 * generalized form of the original single-asset helper: the single path calls
 * it with (asset.clipSnapshot, asset.sourceMediaId) and its output is
 * preserved verbatim; multi passes each member's snapshot and mediaId.
 * Everything cloneable is deep-cloned so no instance aliases asset data.
 */
function buildClipFromSnapshot(
  snapshot: WorkAssetClipSnapshot,
  mediaId: string,
  overrides: { id: string; trackId: string; startTime: number },
): Clip {
  return {
    id: overrides.id,
    mediaId,
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
 * Build the instantiation action batch for a work asset. kind "single" keeps
 * the legacy single-clip path; kind "multi" expands the relative member
 * layout. The asset entry itself is never modified: repeated instantiation
 * keeps producing fresh independent clips from the same snapshot(s).
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
  if (asset.kind === "multi") {
    return buildMultiInstantiateActions(project, asset, options);
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

  const clip = buildClipFromSnapshot(asset.clipSnapshot, asset.sourceMediaId, {
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
  return {
    ok: true,
    actions,
    trackId,
    clipId,
    createdTrack,
    clipIds: [clipId],
    trackIds: [trackId],
    createdTrackCount: createdTrack ? 1 : 0,
  };
}

/** Emission order of lanes in the multi batch: video, then audio, then image. */
const LANE_TYPE_ORDER: Array<WorkAssetMemberLane["trackType"]> = [
  "video",
  "audio",
  "image",
];

interface LanePlanEntry {
  readonly trackType: WorkAssetMemberLane["trackType"];
  readonly laneOffset: number;
  readonly trackId: string;
  readonly created: boolean;
}

/**
 * Multi-asset expansion: relative → absolute. Everything below happens BEFORE
 * any action is built — any failure produces NO actions (all-or-nothing).
 *
 * 1. Envelope: members complete (count cap, unique memberIds, sane lanes and
 *    relativeStarts, per-member snapshot shape).
 * 2. missingSource is all-or-nothing: one missing member media rejects the
 *    whole expansion with the full missing list (a partial layout would
 *    silently misrepresent the asset).
 * 3. Lane mapping: one lane per distinct (trackType, laneOffset). The anchor
 *    lane — the anchor member's trackType at offset 0 — may reuse
 *    `options.trackId`; every other lane is always a fresh track (same
 *    convention as single attach: never occupy the user's existing tracks
 *    implicitly). track/add is emitted video lanes asc → audio asc → image asc.
 * 4. Time expansion: anchorTime = `options.startTime` ?? timeline end; each
 *    member lands at anchorTime + relativeStart (relative timing preserved
 *    verbatim — no cross-fade synthesis, no re-alignment).
 */
function buildMultiInstantiateActions(
  project: Project,
  asset: WorkAsset,
  options: InstantiateWorkAssetOptions,
): WorkAssetInstantiateResult {
  const members = asset.members;
  if (asset.clipSnapshot !== undefined) {
    return {
      ok: false,
      code: "INVALID_PARAMS",
      message: `work asset "${asset.name}" (${asset.id}) is kind "multi" but carries a single-clip snapshot — the entry is malformed`,
      details: { workAssetId: asset.id },
    };
  }
  if (!Array.isArray(members) || members.length === 0) {
    return {
      ok: false,
      code: "INVALID_PARAMS",
      message: `work asset "${asset.name}" (${asset.id}) is kind "multi" but carries no members — the entry is malformed`,
      details: { workAssetId: asset.id },
    };
  }
  // Array.isArray narrows readonly arrays to any[]; re-anchor the type.
  const memberList = members as readonly WorkAssetMember[];
  if (memberList.length > WORK_ASSET_MAX_MEMBERS) {
    return {
      ok: false,
      code: "INVALID_PARAMS",
      message: `work asset "${asset.name}" (${asset.id}) carries ${memberList.length} members; at most ${WORK_ASSET_MAX_MEMBERS} are supported`,
      details: { workAssetId: asset.id },
    };
  }

  // Envelope checks mirroring the create-time member validator.
  const issues: string[] = [];
  const seenMemberIds = new Set<string>();
  for (let index = 0; index < memberList.length; index++) {
    const member = memberList[index];
    const label = `members[${index}]`;
    if (!member || typeof member !== "object") {
      issues.push(`${label} must be an object`);
      continue;
    }
    if (typeof member.memberId !== "string" || member.memberId.length === 0) {
      issues.push(`${label}.memberId must be a non-empty string`);
    } else if (seenMemberIds.has(member.memberId)) {
      issues.push(`${label}.memberId "${member.memberId}" is not unique`);
    } else {
      seenMemberIds.add(member.memberId);
    }
    if (typeof member.mediaId !== "string" || member.mediaId.length === 0) {
      issues.push(`${label}.mediaId must be a non-empty string`);
    }
    if (
      typeof member.relativeStart !== "number" ||
      !Number.isFinite(member.relativeStart) ||
      member.relativeStart < 0
    ) {
      issues.push(`${label}.relativeStart must be a finite number >= 0`);
    }
    const lane = member.lane as WorkAssetMemberLane | undefined;
    if (
      !lane ||
      typeof lane !== "object" ||
      (lane.trackType !== "video" &&
        lane.trackType !== "audio" &&
        lane.trackType !== "image") ||
      typeof lane.laneOffset !== "number" ||
      !Number.isInteger(lane.laneOffset) ||
      lane.laneOffset < 0 ||
      lane.laneOffset > 31
    ) {
      issues.push(
        `${label}.lane must be { trackType: "video"|"audio"|"image", laneOffset: integer 0..31 }`,
      );
    }
    if (!isSnapshotShapeValid(member.snapshot)) {
      issues.push(`${label}.snapshot is malformed`);
    }
  }
  if (issues.length > 0) {
    return {
      ok: false,
      code: "INVALID_PARAMS",
      message: `work asset "${asset.name}" (${asset.id}) carries malformed members — the asset cannot be instantiated`,
      details: { workAssetId: asset.id, issues },
    };
  }

  // All-or-nothing media check with a per-member missing list.
  const missingMembers: Array<{ memberIndex: number; mediaId: string }> = [];
  memberList.forEach((member, memberIndex) => {
    if (
      !project.mediaLibrary.items.some((item) => item.id === member.mediaId)
    ) {
      missingMembers.push({ memberIndex, mediaId: member.mediaId });
    }
  });
  if (missingMembers.length > 0) {
    return {
      ok: false,
      code: "MEDIA_NOT_FOUND",
      message: `work asset "${asset.name}" (${asset.id}) cannot be instantiated: ${missingMembers.length} of ${members.length} members reference media that is no longer in the project library`,
      details: { workAssetId: asset.id, missingMembers },
    };
  }

  // Deterministic member order (same tie-break family as capture): relativeStart, then lane, then memberId.
  const typeRank: Record<WorkAssetMemberLane["trackType"], number> = {
    video: 0,
    audio: 1,
    image: 2,
  };
  const sortedMembers = [...memberList].sort(
    (a, b) =>
      a.relativeStart - b.relativeStart ||
      typeRank[a.lane.trackType] - typeRank[b.lane.trackType] ||
      a.lane.laneOffset - b.lane.laneOffset ||
      (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0),
  );

  // Anchor = the member at relativeStart 0 (the T0 time anchor); its track
  // type is the anchor lane's type. Capture always produces one, but a
  // hand-written layout may have no member at exactly 0 — fall back to the
  // earliest member instead of rejecting the asset.
  const anchorMember =
    members.find((member) => member.relativeStart === 0) ?? sortedMembers[0];
  const anchorLaneType = anchorMember.lane.trackType;

  // Distinct lanes; count cap guards the batch size (lanes + members).
  const lanePlan = new Map<string, LanePlanEntry>();
  for (const member of memberList) {
    const key = `${member.lane.trackType}:${member.lane.laneOffset}`;
    if (!lanePlan.has(key)) {
      lanePlan.set(key, {
        trackType: member.lane.trackType,
        laneOffset: member.lane.laneOffset,
        trackId: `track-${crypto.randomUUID()}`,
        created: true,
      });
    }
  }
  if (lanePlan.size > WORK_ASSET_MAX_LANES) {
    return {
      ok: false,
      code: "INVALID_PARAMS",
      message: `work asset "${asset.name}" (${asset.id}) spans ${lanePlan.size} lanes; at most ${WORK_ASSET_MAX_LANES} are supported`,
      details: { workAssetId: asset.id },
    };
  }

  // options.trackId binds the ANCHOR lane only; every other lane stays fresh.
  const anchorKey = `${anchorLaneType}:0`;
  if (options.trackId !== undefined) {
    const track = project.timeline.tracks.find(
      (candidate) => candidate.id === options.trackId,
    );
    if (!track) {
      return {
        ok: false,
        code: "NOT_FOUND",
        message: `track "${options.trackId}" not found`,
        details: { trackId: options.trackId },
      };
    }
    if (track.type !== anchorLaneType) {
      return {
        ok: false,
        code: "CONFLICT",
        message: `track "${options.trackId}" is a ${track.type} track, but the work asset's anchor lane is ${anchorLaneType}`,
        details: {
          trackId: options.trackId,
          trackType: track.type,
          anchorLaneType,
        },
      };
    }
    const anchorEntry = lanePlan.get(anchorKey);
    if (anchorEntry) {
      lanePlan.set(anchorKey, { ...anchorEntry, trackId: options.trackId, created: false });
    } else {
      // No member occupies the anchor lane slot (hand-written layout); still
      // honour the explicit binding without emitting a dangling track/add.
      lanePlan.set(anchorKey, {
        trackType: anchorLaneType,
        laneOffset: 0,
        trackId: options.trackId,
        created: false,
      });
    }
  }

  const anchorTime = options.startTime ?? timelineEndSec(project);
  if (!Number.isFinite(anchorTime) || anchorTime < 0) {
    return {
      ok: false,
      code: "INVALID_PARAMS",
      message: `startTime must be a finite number >= 0 (got ${anchorTime})`,
      details: { startTime: options.startTime ?? null },
    };
  }

  // Pre-mint clip ids (options.clipId pins the anchor clip) and precheck ALL
  // of them — the whole batch must be conflict-free before anything is built.
  const clipIds = sortedMembers.map((_member, index) =>
    index === 0 && options.clipId !== undefined ? options.clipId : `clip-${crypto.randomUUID()}`,
  );
  const mintedIds = new Set<string>();
  for (const clipId of clipIds) {
    if (
      project.timeline.tracks.some((track) =>
        track.clips.some((candidate) => candidate.id === clipId),
      ) ||
      mintedIds.has(clipId)
    ) {
      return {
        ok: false,
        code: "CONFLICT",
        message: `a clip with id "${clipId}" already exists`,
        details: { clipId },
      };
    }
    mintedIds.add(clipId);
  }

  const timestamp = options.now ?? Date.now();
  const laneOrder: LanePlanEntry[] = LANE_TYPE_ORDER.flatMap((trackType) =>
    [...lanePlan.values()]
      .filter((lane) => lane.trackType === trackType)
      .sort((a, b) => a.laneOffset - b.laneOffset),
  );
  const actions: Action[] = [];
  for (const lane of laneOrder) {
    if (!lane.created) continue;
    actions.push({
      type: "track/add",
      id: `action-${crypto.randomUUID()}`,
      timestamp,
      params: { trackType: lane.trackType, trackId: lane.trackId },
    });
  }
  sortedMembers.forEach((member, index) => {
    const lane = lanePlan.get(`${member.lane.trackType}:${member.lane.laneOffset}`)!;
    const startTime = anchorTime + member.relativeStart;
    const clip = buildClipFromSnapshot(
      member.snapshot,
      member.mediaId,
      { id: clipIds[index], trackId: lane.trackId, startTime },
    );
    actions.push({
      type: "clip/add",
      id: `action-${crypto.randomUUID()}`,
      timestamp,
      params: {
        clipId: clipIds[index],
        trackId: lane.trackId,
        mediaId: member.mediaId,
        startTime,
        sourceClip: clip,
      },
    });
  });

  const anchorLane = lanePlan.get(anchorKey);
  return {
    ok: true,
    actions,
    trackId: anchorLane ? anchorLane.trackId : laneOrder[0].trackId,
    clipId: clipIds[0],
    createdTrack: laneOrder.some((lane) => lane.created),
    clipIds,
    trackIds: laneOrder.map((lane) => lane.trackId),
    createdTrackCount: laneOrder.filter((lane) => lane.created).length,
  };
}
