import type { Project } from "@openreel/core/types/project";
import type { LiveEditorReferences } from "./live-store";
import { stableStringify } from "./idempotency";
import { FacadeError } from "./errors";
import type {
  TimelineQueryEntity,
  TimelineQueryEntityType,
  TimelineQueryField,
  TimelineQueryParams,
  TimelineQueryResult,
} from "./types";

export const DEFAULT_TIMELINE_QUERY_LIMIT = 50;
export const MAX_TIMELINE_QUERY_LIMIT = 200;
export const MAX_TIMELINE_QUERY_NEIGHBORS = 2;

interface Candidate extends TimelineQueryEntity {
  readonly trackType?: string;
}

const DEFAULT_FIELDS: readonly TimelineQueryField[] = [
  "name",
  "type",
  "trackId",
  "mediaId",
  "startTime",
  "duration",
  "text",
  "locked",
  "muted",
  "hidden",
  "solo",
];

function allCandidates(project: Project): Candidate[] {
  const candidates: Candidate[] = [];
  for (const track of project.timeline.tracks) {
    const clipEnds = track.clips.map((clip) => clip.startTime + clip.duration);
    candidates.push({
      entityType: "track",
      id: track.id,
      ref: null,
      trackId: track.id,
      startTime: track.clips.length > 0 ? Math.min(...track.clips.map((c) => c.startTime)) : null,
      endTime: clipEnds.length > 0 ? Math.max(...clipEnds) : null,
      data: {
        name: track.name,
        type: track.type,
        locked: track.locked,
        muted: track.muted,
        hidden: track.hidden,
        solo: track.solo,
      },
      trackType: track.type,
    });
    for (const clip of track.clips) {
      candidates.push({
        entityType: "clip",
        id: clip.id,
        ref: null,
        trackId: track.id,
        startTime: clip.startTime,
        endTime: clip.startTime + clip.duration,
        data: {
          type: track.type,
          trackId: track.id,
          mediaId: clip.mediaId,
          startTime: clip.startTime,
          duration: clip.duration,
          inPoint: clip.inPoint,
          outPoint: clip.outPoint,
          volume: clip.volume,
          speed: clip.speed ?? 1,
          reversed: clip.reversed ?? false,
          transform: clip.transform,
          keyframes: clip.keyframes ?? [],
          automation: clip.automation ?? {},
          colorGrading: clip.colorGrading ?? null,
          chromaKey: clip.chromaKey ?? null,
        },
        trackType: track.type,
      });
    }
    for (const transition of track.transitions ?? []) {
      const clipA = track.clips.find((clip) => clip.id === transition.clipAId);
      const cut = clipA ? clipA.startTime + clipA.duration : null;
      candidates.push({
        entityType: "transition",
        id: transition.id,
        ref: null,
        trackId: track.id,
        startTime: cut === null ? null : Math.max(0, cut - transition.duration / 2),
        endTime: cut === null ? null : cut + transition.duration / 2,
        data: {
          type: transition.type,
          trackId: track.id,
          duration: transition.duration,
          clipAId: transition.clipAId,
          clipBId: transition.clipBId ?? null,
          edge: transition.edge ?? null,
        },
        trackType: track.type,
      });
    }
  }
  for (const text of project.textClips ?? []) {
    candidates.push({
      entityType: "text",
      id: text.id,
      ref: null,
      trackId: text.trackId,
      startTime: text.startTime,
      endTime: text.startTime + text.duration,
      data: {
        trackId: text.trackId,
        text: text.text,
        startTime: text.startTime,
        duration: text.duration,
        style: text.style,
        transform: text.transform,
        keyframes: text.keyframes ?? [],
      },
      trackType: "text",
    });
  }
  for (const media of project.mediaLibrary.items) {
    candidates.push({
      entityType: "media",
      id: media.id,
      ref: null,
      trackId: null,
      startTime: null,
      endTime: null,
      data: {
        name: media.name,
        ...(media.displayName ? { displayName: media.displayName } : {}),
        type: media.type,
        duration: media.metadata.duration,
      },
    });
  }
  for (const marker of project.markers?.items ?? []) {
    const target = marker.target;
    const range = target.kind === "timeRange" ? target : null;
    candidates.push({
      entityType: "marker",
      id: marker.id,
      ref: `R${marker.number}`,
      trackId: null,
      startTime: range?.start ?? null,
      endTime: range?.end ?? null,
      data: {
        name: marker.label ?? `Review marker ${marker.number}`,
        target: marker.target,
        color: marker.color,
      },
    });
  }
  for (const subtitle of project.timeline.subtitles ?? []) {
    candidates.push({
      entityType: "subtitle",
      id: subtitle.id,
      ref: null,
      trackId: null,
      startTime: subtitle.startTime,
      endTime: subtitle.endTime,
      data: {
        text: subtitle.text,
        startTime: subtitle.startTime,
        duration: subtitle.endTime - subtitle.startTime,
      },
    });
  }
  return candidates.sort((a, b) =>
    (a.startTime ?? Number.POSITIVE_INFINITY) -
      (b.startTime ?? Number.POSITIVE_INFINITY) ||
    a.entityType.localeCompare(b.entityType) ||
    a.id.localeCompare(b.id),
  );
}

function referenceEntityIds(
  project: Project,
  refs: readonly string[] | undefined,
  liveReferences: LiveEditorReferences,
): { ids: Set<string>; ranges: Array<{ start: number; end: number }>; refById: Map<string, string> } {
  const ids = new Set<string>();
  const ranges: Array<{ start: number; end: number }> = [];
  const refById = new Map<string, string>();
  for (const ref of refs ?? []) {
    if (ref.startsWith("@A")) {
      const number = Number(ref.slice(2));
      const live = Object.values(liveReferences).find(
        (candidate) => candidate.number === number && !candidate.stale,
      );
      if (live) {
        ids.add(live.entityId);
        refById.set(live.entityId, ref);
      }
      continue;
    }
    const number = Number(ref.slice(1));
    const marker = project.markers?.items.find((candidate) => candidate.number === number);
    if (!marker) continue;
    const target = marker.target;
    if (target.kind === "asset") ids.add(target.mediaId);
    else if (target.kind === "clip") ids.add(target.clipId);
    else if (target.kind === "text") ids.add(target.textClipId);
    else ranges.push({ start: target.start, end: target.end });
    for (const id of ids) if (!refById.has(id)) refById.set(id, ref);
  }
  return { ids, ranges, refById };
}

function overlaps(
  item: Candidate,
  range: { startSec: number; endSec: number },
): boolean {
  return item.startTime !== null && item.endTime !== null &&
    item.startTime < range.endSec && item.endTime > range.startSec;
}

function selectFields(
  item: Candidate,
  fields: readonly TimelineQueryField[],
): TimelineQueryEntity {
  const data: Record<string, unknown> = {};
  for (const field of fields) {
    const value = item.data[field];
    if (value !== undefined) data[field] = structuredClone(value);
  }
  return { ...item, data };
}

function querySignature(params: TimelineQueryParams): string {
  const value = stableStringify({ ...params, cursor: undefined });
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function parseCursor(
  cursor: string | undefined,
  revision: number,
  signature: string,
): number {
  if (cursor === undefined) return 0;
  const match = /^tq1:(\d+):(\d+):([a-z0-9]+)$/.exec(cursor);
  if (!match || Number(match[1]) !== revision || match[3] !== signature) {
    throw new FacadeError("INVALID_PARAMS", "timeline.query: cursor does not match this query or project revision");
  }
  return Number(match[2]);
}

export function queryTimeline(
  project: Project,
  revision: number,
  params: TimelineQueryParams,
  liveReferences: LiveEditorReferences = {},
): TimelineQueryResult {
  const candidates = allCandidates(project);
  const refSelection = referenceEntityIds(project, params.refs, liveReferences);
  let matched = candidates.filter((item) => {
    if (params.entityIds?.length && !params.entityIds.includes(item.id)) return false;
    if (params.trackIds?.length && (item.trackId === null || !params.trackIds.includes(item.trackId))) return false;
    if (
      params.trackTypes?.length &&
      (!item.trackType ||
        !(params.trackTypes as readonly string[]).includes(item.trackType))
    ) return false;
    if (params.entityTypes?.length && !params.entityTypes.includes(item.entityType)) return false;
    if (params.timeRange && !overlaps(item, params.timeRange)) return false;
    if (params.refs?.length) {
      const inRange = refSelection.ranges.some(
        (range) => item.startTime !== null && item.endTime !== null && item.startTime < range.end && item.endTime > range.start,
      );
      if (!refSelection.ids.has(item.id) && !inRange && !params.refs.includes(item.ref ?? "")) return false;
    }
    return true;
  });

  if ((params.includeNeighbors ?? 0) > 0 && matched.length > 0) {
    const neighborIds = new Set(matched.map((item) => `${item.entityType}:${item.id}`));
    for (const item of matched) {
      const index = candidates.findIndex(
        (candidate) => candidate.entityType === item.entityType && candidate.id === item.id,
      );
      for (let delta = 1; delta <= (params.includeNeighbors ?? 0); delta += 1) {
        for (const neighbor of [candidates[index - delta], candidates[index + delta]]) {
          if (neighbor && ["clip", "text", "transition", "subtitle"].includes(neighbor.entityType)) {
            neighborIds.add(`${neighbor.entityType}:${neighbor.id}`);
          }
        }
      }
    }
    matched = candidates.filter((item) => neighborIds.has(`${item.entityType}:${item.id}`));
  }

  matched = matched.map((item) => ({
    ...item,
    ref: refSelection.refById.get(item.id) ?? item.ref,
  }));
  const signature = querySignature(params);
  const offset = parseCursor(params.cursor, revision, signature);
  const limit = params.limit ?? DEFAULT_TIMELINE_QUERY_LIMIT;
  const page = matched.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const fields = params.fields ?? DEFAULT_FIELDS;
  return {
    revision,
    items: page.map((item) => selectFields(item, fields)),
    nextCursor:
      nextOffset < matched.length
        ? `tq1:${revision}:${nextOffset}:${signature}`
        : null,
  };
}

export const TIMELINE_QUERY_ENTITY_TYPES: readonly TimelineQueryEntityType[] = [
  "track",
  "clip",
  "text",
  "media",
  "transition",
  "marker",
  "subtitle",
];

export const TIMELINE_QUERY_FIELDS: readonly TimelineQueryField[] = [
  "name",
  "displayName",
  "type",
  "trackId",
  "mediaId",
  "startTime",
  "duration",
  "inPoint",
  "outPoint",
  "text",
  "volume",
  "speed",
  "reversed",
  "transform",
  "keyframes",
  "automation",
  "locked",
  "muted",
  "hidden",
  "solo",
  "target",
  "style",
  "color",
  "colorGrading",
  "chromaKey",
];
