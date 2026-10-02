import type {
  Clip,
  MediaItem,
  Project,
  ShapeClip,
  SVGClip,
  StickerClip,
  TextClip,
  Track,
} from "@reelterminal/core";
import type { SelectionItem } from "./ui-store";
import type { AgentReferenceTarget } from "./agent-references-store";
import type { LiveEditorReferenceKind } from "@reelterminal/agent-facade/live-store";
import { t } from "../i18n";

/** Convert editor track types to the intentionally small agent vocabulary. */
export function agentReferenceKindForTrack(
  trackType: Track["type"],
): LiveEditorReferenceKind | null {
  switch (trackType) {
    case "video":
      return "video";
    case "audio":
      return "audio";
    case "image":
      return "media";
    case "text":
      return "text";
    default:
      return null;
  }
}

const clipTiming = (clip: Pick<Clip, "startTime" | "duration">): AgentReferenceTarget["timing"] => ({
  startSeconds: clip.startTime,
  endSeconds: clip.startTime + clip.duration,
});

function mediaLabel(media: MediaItem | undefined, clip: Clip): string {
  return media?.name || clip.mediaId.slice(0, 8) || clip.id;
}

function timelineTarget(
  clip: Clip,
  track: Track,
  project: Project,
  trackOrder: number,
): AgentReferenceTarget | null {
  const kind = agentReferenceKindForTrack(track.type);
  if (!kind) return null;
  return {
    kind,
    entityId: clip.id,
    label: mediaLabel(
      project.mediaLibrary.items.find((item) => item.id === clip.mediaId),
      clip,
    ),
    timing: clipTiming(clip),
    trackOrder,
  };
}

function textTarget(
  clip: TextClip,
  trackOrder: number,
): AgentReferenceTarget {
  return {
    kind: "text",
    entityId: clip.id,
    label: clip.text || t("Text"),
    timing: clipTiming(clip),
    trackOrder,
  };
}

type GraphicClip = ShapeClip | SVGClip | StickerClip;

function graphicTarget(
  clip: GraphicClip,
  trackOrder: number,
): AgentReferenceTarget {
  const label =
    "name" in clip && typeof clip.name === "string" && clip.name.trim()
      ? clip.name
      : clip.type === "shape"
          ? t("Shape")
          : clip.type === "svg"
          ? t("SVG")
          : t("Sticker");
  return {
    kind: "media",
    entityId: clip.id,
    label,
    timing: clipTiming(clip),
    trackOrder,
  };
}

/** Build every referenceable entity in the current project. */
export function getAgentReferenceTargetsForProject(
  project: Project,
): AgentReferenceTarget[] {
  const targets: AgentReferenceTarget[] = [];
  const trackOrderById = new Map(
    project.timeline.tracks.map((track, index) => [track.id, index]),
  );

  for (const [trackOrder, track] of project.timeline.tracks.entries()) {
    for (const clip of track.clips) {
      const target = timelineTarget(clip, track, project, trackOrder);
      if (target) targets.push(target);
    }
  }

  for (const clip of project.textClips ?? []) {
    targets.push(textTarget(clip, trackOrderById.get(clip.trackId) ?? Number.MAX_SAFE_INTEGER));
  }
  for (const clip of project.shapeClips ?? []) {
    targets.push(graphicTarget(clip, trackOrderById.get(clip.trackId) ?? Number.MAX_SAFE_INTEGER));
  }
  for (const clip of project.svgClips ?? []) {
    targets.push(graphicTarget(clip, trackOrderById.get(clip.trackId) ?? Number.MAX_SAFE_INTEGER));
  }
  for (const clip of project.stickerClips ?? []) {
    targets.push(graphicTarget(clip, trackOrderById.get(clip.trackId) ?? Number.MAX_SAFE_INTEGER));
  }

  // Media-library items have no timeline position. Their stable order comes
  // after timeline entities, while preserving the library order for ties.
  const mediaBaseOrder = project.timeline.tracks.length + 1;
  for (const [index, item] of project.mediaLibrary.items.entries()) {
    targets.push({
      kind: "media",
      entityId: item.id,
      label: item.name,
      timing: { startSeconds: null, endSeconds: null },
      trackOrder: mediaBaseOrder + index,
    });
  }

  for (const asset of project.workAssets ?? []) {
    targets.push({ kind: "workAsset", entityId: asset.id, label: asset.name,
      timing: { startSeconds: null, endSeconds: null }, trackOrder: mediaBaseOrder + project.mediaLibrary.items.length });
  }
  return targets;
}

/** Resolve a selected item to the current entity, preserving stale safety. */
function targetForSelectionItem(
  item: SelectionItem,
  allTargets: readonly AgentReferenceTarget[],
): AgentReferenceTarget | null {
  if (item.type === "media") {
    return allTargets.find((target) => target.kind === "media" && target.entityId === item.id) ?? null;
  }
  if (item.type === "text-clip") {
    return allTargets.find((target) => target.kind === "text" && target.entityId === item.id) ?? null;
  }
  if (item.type !== "clip" && item.type !== "shape-clip") return null;

  // Asset cards historically use SelectionType "clip" too, so check real
  // timeline/overlay entities before falling back to a media-library item.
  const timelineTargetMatch = allTargets.find(
    (target) => target.entityId === item.id && target.timing.startSeconds !== null,
  );
  if (timelineTargetMatch) return timelineTargetMatch;
  return allTargets.find(
    (target) => target.kind === "media" && target.entityId === item.id,
  ) ?? null;
}

/**
 * Resolve the clicked entity and, when it is selected, its whole selection.
 * The returned list is sorted by timeline start, then track order, so number
 * assignment does not depend on click or selection-array order.
 */
export function getAgentReferenceTargetsForSelection(
  project: Project,
  selectedItems: readonly SelectionItem[],
  clicked: AgentReferenceTarget,
): AgentReferenceTarget[] {
  const allTargets = getAgentReferenceTargetsForProject(project);
  const selectedTarget = targetForSelectionItem(
    { id: clicked.entityId, type: clicked.kind === "text" ? "text-clip" : "clip" },
    allTargets,
  );
  const clickedIsSelected = selectedTarget?.entityId === clicked.entityId &&
    selectedItems.some((item) => item.id === clicked.entityId);
  if (!clickedIsSelected) return [clicked];

  const targets = selectedItems
    .map((item) => targetForSelectionItem(item, allTargets))
    .filter((target): target is AgentReferenceTarget => target !== null);
  return targets.length > 0 ? targets : [clicked];
}

/** Resolve a timeline clip for use by a context-menu action. */
export function getAgentReferenceTargetForClip(
  project: Project,
  clip: Clip,
  track: Track,
): AgentReferenceTarget | null {
  const trackOrder = project.timeline.tracks.findIndex((item) => item.id === track.id);
  return timelineTarget(clip, track, project, trackOrder < 0 ? Number.MAX_SAFE_INTEGER : trackOrder);
}

export function getAgentReferenceTargetForText(
  project: Project,
  clip: TextClip,
): AgentReferenceTarget {
  const trackOrder = project.timeline.tracks.findIndex((track) => track.id === clip.trackId);
  return textTarget(clip, trackOrder < 0 ? Number.MAX_SAFE_INTEGER : trackOrder);
}

export function getAgentReferenceTargetForGraphic(
  project: Project,
  clip: GraphicClip,
): AgentReferenceTarget {
  const trackOrder = project.timeline.tracks.findIndex((track) => track.id === clip.trackId);
  return graphicTarget(clip, trackOrder < 0 ? Number.MAX_SAFE_INTEGER : trackOrder);
}

export function getAgentReferenceTargetForMedia(
  project: Project,
  item: MediaItem,
): AgentReferenceTarget {
  const mediaIndex = project.mediaLibrary.items.findIndex((candidate) => candidate.id === item.id);
  return {
    kind: "media",
    entityId: item.id,
    label: item.name,
    timing: { startSeconds: null, endSeconds: null },
    trackOrder: project.timeline.tracks.length + 1 + Math.max(0, mediaIndex),
  };
}
