import type { LiveCreatedIds } from "./live-store";
import type { EditOp, OpApplied } from "./types";

/** Ops that create exactly one entity each, in action order. */
const CREATING_OPS: ReadonlySet<EditOp["op"]> = new Set([
  "track.add",
  "clip.add",
  "clip.split",
  "clip.duplicate",
  "text.create",
  "svg.create",
  "transition.add",
  "subtitle.importSrt",
  // Instantiation creates one clip plus its own implicit lane when the
  // translator prepends a track/add — or, for kind "multi" assets, the whole
  // member expansion (several lanes + several clips, all pinned to the op).
  "workAsset.instantiate",
  // workAsset.capture deliberately absent: it creates an ASSET, not timeline
  // entities, so createdIds is always [] and the agent recovers the asset id
  // via timeline.query (same convention as single capture).
]);

export interface EditApplyPayload {
  readonly applied: readonly OpApplied[];
}

/**
 * Partition store-diffed created ids onto ops. Each creating op consumes one
 * id from ITS OWN category bucket, in batch order within that category —
 * mirroring ops.ts diffCreatedIdsByCategory. A mixed batch (e.g.
 * [text.create, clip.add]) thus hands every op the id of the entity it
 * created; a flat project-ordered list would cross-assign the ids.
 *
 * workAsset.instantiate consumes per op: EVERY lane its translator created
 * (pinned via autoTrackIds — a single entry or the multi expansion's whole
 * list), then as many clip ids as the expansion minted (opClipCounts; single
 * assets mint exactly one, multi assets one per member).
 */
export function partitionCreatedIds(
  ops: readonly EditOp[],
  createdIds: LiveCreatedIds,
  autoTrackIds: readonly (string | readonly string[] | undefined)[] = [],
  opClipCounts: readonly (number | undefined)[] = [],
): OpApplied[] {
  const categories = {
    "track.add": "tracks",
    "clip.add": "clips",
    "clip.split": "clips",
    "clip.duplicate": "clips",
    "transition.add": "transitions",
  } as const;
  const usedTracks = new Set<string>();
  const cursors = {
    tracks: 0,
    clips: 0,
    textClips: 0,
    svgClips: 0,
    transitions: 0,
    subtitles: 0,
  };
  const autoTrackIdList = (index: number): readonly string[] => {
    const value = autoTrackIds[index];
    if (value === undefined) return [];
    return typeof value === "string" ? [value] : value;
  };
  return ops.map((op, index) => {
    if (!CREATING_OPS.has(op.op)) return { op: op.op, createdIds: [] };
    const ids: string[] = [];
    if (op.op === "track.add") {
      const id = createdIds.tracks.find((candidate) => !usedTracks.has(candidate));
      if (id !== undefined) {
        usedTracks.add(id);
        ids.push(id);
      }
    } else if (op.op === "text.create") {
      // An implicit text lane is part of this higher-level op. Use the exact
      // id emitted by the translator, so explicit track.add ops in the same
      // batch cannot steal or reorder it.
      for (const autoTrackId of autoTrackIdList(index)) {
        if (createdIds.tracks.includes(autoTrackId)) {
          usedTracks.add(autoTrackId);
          ids.push(autoTrackId);
        }
      }
      const id = createdIds.textClips[cursors.textClips];
      cursors.textClips += 1;
      if (id !== undefined) ids.push(id);
    } else if (op.op === "svg.create") {
      // Same implicit-lane convention as text.create, including the reported
      // order [autoTrackId, overlayId]. A seam store without the svgClips
      // bucket (optional on LiveCreatedIds) reports no clip id here — the
      // agent falls back to timeline.query's svg projection.
      for (const autoTrackId of autoTrackIdList(index)) {
        if (createdIds.tracks.includes(autoTrackId)) {
          usedTracks.add(autoTrackId);
          ids.push(autoTrackId);
        }
      }
      const svgClips = createdIds.svgClips ?? [];
      const id = svgClips[cursors.svgClips];
      cursors.svgClips += 1;
      if (id !== undefined) ids.push(id);
    } else if (op.op === "subtitle.importSrt") {
      ids.push(...createdIds.subtitles.slice(cursors.subtitles));
      cursors.subtitles = createdIds.subtitles.length;
    } else if (op.op === "workAsset.instantiate") {
      // Same implicit-lane convention as text.create/svg.create, generalized
      // to multi assets: every track/add the translator emitted is pinned for
      // THIS op, then one clip id per member is consumed from the clips
      // bucket in batch order (single assets mint exactly one).
      for (const autoTrackId of autoTrackIdList(index)) {
        if (createdIds.tracks.includes(autoTrackId)) {
          usedTracks.add(autoTrackId);
          ids.push(autoTrackId);
        }
      }
      const clipCount = opClipCounts[index] ?? 1;
      for (let consumed = 0; consumed < clipCount; consumed++) {
        const id = createdIds.clips[cursors.clips];
        cursors.clips += 1;
        if (id !== undefined) ids.push(id);
      }
    } else {
      const category = categories[op.op as keyof typeof categories];
      const id = createdIds[category][cursors[category]];
      cursors[category] += 1;
      if (id !== undefined) ids.push(id);
    }
    // A missing bucket entry means the store created nothing for this op
    // (e.g. an implicit dependency was diffed instead) — report honestly.
    return { op: op.op, createdIds: ids };
  });
}
