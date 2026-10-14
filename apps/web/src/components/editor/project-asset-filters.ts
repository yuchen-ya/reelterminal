import { mediaDisplayName, type MediaItem, type Project, type WorkAsset } from "@reelterminal/core";

export type ProjectMediaType = "all" | "video" | "audio" | "image" | "subtitle";
export type ProjectAssetKind = "all" | "media" | "single" | "multi";
export const PROJECT_ASSET_SORTS = ["newest", "oldest", "nameAsc", "nameDesc", "shortest", "longest"] as const;
export type ProjectAssetSort = typeof PROJECT_ASSET_SORTS[number];

/** Inputs are in import/capture order; missing durations always sort last. */
function sortEntries<T>(entries: { value: T; name: string; duration?: number; order: number }[], sort: ProjectAssetSort): T[] {
  return entries.sort((a, b) => {
    if (sort === "nameAsc" || sort === "nameDesc") {
      return a.name.localeCompare(b.name, undefined, { numeric: true }) * (sort === "nameAsc" ? 1 : -1);
    }
    if (sort === "shortest" || sort === "longest") {
      if (a.duration === undefined) return b.duration === undefined ? 0 : 1;
      if (b.duration === undefined) return -1;
      return (a.duration - b.duration) * (sort === "shortest" ? 1 : -1);
    }
    return (a.order - b.order) * (sort === "oldest" ? 1 : -1);
  }).map(entry => entry.value);
}

export function sortProjectMedia(items: readonly MediaItem[], sort: ProjectAssetSort): MediaItem[] {
  return sortEntries(items.map((value, order) => ({ value, order, name: mediaDisplayName(value),
    duration: value.type !== "image" && Number.isFinite(value.metadata.duration) && value.metadata.duration > 0 ? value.metadata.duration : undefined,
  })), sort);
}

export function workAssetDuration(asset: WorkAsset): number {
  return asset.kind === "multi"
    ? Math.max(...asset.members!.map(member => member.relativeStart + member.snapshot.duration))
    : asset.clipSnapshot!.duration;
}

export function filterProjectWorkAssets(project: Project, type: ProjectMediaType, kind: ProjectAssetKind, search: string, sort: ProjectAssetSort): WorkAsset[] {
  if (type === "subtitle" || kind === "media") return [];
  const types = new Map(project.mediaLibrary.items.map(item => [item.id, item.type]));
  const query = search.trim().toLowerCase();
  const items = (project.workAssets ?? []).filter(asset =>
    (kind === "all" || asset.kind === kind) && asset.name.toLowerCase().includes(query) &&
    (type === "all" || (asset.members ? asset.members.some(member => member.lane.trackType === type) : types.get(asset.sourceMediaId) === type)),
  );
  return sortEntries(items.map(value => ({ value, name: value.name, order: value.createdAt, duration: workAssetDuration(value) })), sort);
}

export function filterProjectCaptions(project: Project, search: string, sort: ProjectAssetSort) {
  const tracks = new Set(project.timeline.tracks.filter(track => track.type === "text" && track.name === "Captions").map(track => track.id));
  const query = search.trim().toLowerCase();
  const captions = (project.textClips ?? []).filter(clip =>
    (tracks.has(clip.trackId) || typeof clip.metadata?.captionSource === "string") && clip.text.toLowerCase().includes(query),
  );
  return sortEntries(captions.map((value, order) => ({ value, order, name: value.text, duration: value.duration })), sort);
}
