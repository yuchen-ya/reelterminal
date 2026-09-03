import type {
  Project,
  ProjectMarker,
  ProjectMarkersState,
} from "@openreel/core";
import type { SelectionItem } from "../ui-store";

/**
 * Read helpers for persisted project review markers (`project.markers`).
 * All functions tolerate an absent markers field and return markers sorted
 * by their stable number.
 */

export interface ProjectMarkerEntityQuery {
  mediaId?: string;
  clipId?: string;
  textClipId?: string;
}

/** Point markers (start === end) stay visible this many frames each side. */
export const PROJECT_MARKER_POINT_TOLERANCE_FRAMES = 0.5;

const itemsOf = (
  markers: ProjectMarkersState | undefined | null,
): readonly ProjectMarker[] => markers?.items ?? [];

const byNumber = (a: ProjectMarker, b: ProjectMarker): number =>
  a.number - b.number;

/** Markers attached to one entity (asset / timeline clip / text overlay). */
export function findMarkersForEntity(
  markers: ProjectMarkersState | undefined | null,
  query: ProjectMarkerEntityQuery,
): ProjectMarker[] {
  return itemsOf(markers)
    .filter((marker) => {
      switch (marker.target.kind) {
        case "asset":
          return (
            query.mediaId !== undefined &&
            marker.target.mediaId === query.mediaId
          );
        case "clip":
          return (
            query.clipId !== undefined &&
            marker.target.clipId === query.clipId
          );
        case "text":
          return (
            query.textClipId !== undefined &&
            marker.target.textClipId === query.textClipId
          );
        default:
          return false;
      }
    })
    .sort(byNumber);
}

/**
 * Time-range markers containing `time`. Ranges (start < end) contain their
 * endpoints; point markers (start === end) match within half a frame.
 */
export function findTimeRangeMarkersAt(
  markers: ProjectMarkersState | undefined | null,
  time: number,
  frameRate: number,
): ProjectMarker[] {
  const tolerance =
    frameRate > 0 ? PROJECT_MARKER_POINT_TOLERANCE_FRAMES / frameRate : 0;
  // Absorbs float cancellation when `time` was derived as `start ± tolerance`.
  const epsilon = 1e-9;
  return itemsOf(markers)
    .filter((marker) => {
      if (marker.target.kind !== "timeRange") return false;
      const { start, end } = marker.target;
      if (start === end) {
        return Math.abs(time - start) <= tolerance + epsilon;
      }
      return time >= start && time <= end;
    })
    .sort(byNumber);
}

const isActiveAt = (
  clip: { startTime: number; duration: number } | undefined,
  time: number,
): boolean =>
  clip !== undefined &&
  time >= clip.startTime &&
  time < clip.startTime + clip.duration;

/**
 * Clip / text-overlay markers whose target element is on screen at `time`.
 * Clip targets are also resolved against overlay graphics (shape/SVG/sticker
 * clips) so a marker keeps projecting as long as its target id exists.
 */
export function findClipMarkersActiveAt(
  markers: ProjectMarkersState | undefined | null,
  project: Project,
  time: number,
): ProjectMarker[] {
  return itemsOf(markers)
    .filter((marker) => {
      if (marker.target.kind === "clip") {
        const clipId = marker.target.clipId;
        const timelineClip = project.timeline.tracks
          .flatMap((track) => track.clips)
          .find((clip) => clip.id === clipId);
        if (timelineClip) return isActiveAt(timelineClip, time);
        const graphicClip = [
          ...(project.shapeClips ?? []),
          ...(project.svgClips ?? []),
          ...(project.stickerClips ?? []),
        ].find((clip) => clip.id === clipId);
        return isActiveAt(graphicClip, time);
      }
      if (marker.target.kind === "text") {
        const textClipId = marker.target.textClipId;
        return isActiveAt(
          (project.textClips ?? []).find((clip) => clip.id === textClipId),
          time,
        );
      }
      return false;
    })
    .sort(byNumber);
}

const queryForSelection = (
  item: SelectionItem,
): ProjectMarkerEntityQuery | null => {
  switch (item.type) {
    case "media":
      return { mediaId: item.id };
    case "clip":
    case "shape-clip":
      return { clipId: item.id };
    case "text-clip":
      return { textClipId: item.id };
    default:
      return null;
  }
};

/**
 * Markers attached to any currently selected entity (media selections map to
 * asset markers, clip/shape selections to clip markers, text selections to
 * text markers). De-duplicated by marker id.
 */
export function markersForSelection(
  markers: ProjectMarkersState | undefined | null,
  selectedItems: readonly SelectionItem[],
): ProjectMarker[] {
  const result = new Map<string, ProjectMarker>();
  for (const item of selectedItems) {
    const query = queryForSelection(item);
    if (!query) continue;
    for (const marker of findMarkersForEntity(markers, query)) {
      result.set(marker.id, marker);
    }
  }
  return [...result.values()].sort(byNumber);
}
