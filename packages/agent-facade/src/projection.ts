/**
 * Pure read projections of a canonical `Project` (extracted from
 * AgentFacadeSession so the live session — ADR 0004 Decision 1, which
 * holds NO project copy and works from LiveProjectStore snapshots —
 * projects state byte-identically to headless). One projection logic, two
 * session runtimes: a live `project.get_state`/`timeline.get` is the same
 * view over a snapshot as headless is over its private project.
 */
import type { Project } from "@openreel/core/types/project";
import type {
  ProjectCounts,
  ProjectState,
  TimelineState,
} from "./types";

export function projectCounts(project: Project): ProjectCounts {
  return {
    tracks: project.timeline.tracks.length,
    clips: project.timeline.tracks.reduce((n, t) => n + t.clips.length, 0),
    mediaItems: project.mediaLibrary.items.length,
    textOverlays: (project.textClips ?? []).length,
  };
}

/**
 * project.get_state view: the revision, a FRESH deep clone of the project
 * (callers may never mutate facade/store state through the reference) and
 * the entity counts.
 */
export function projectStateView(project: Project, revision: number): ProjectState {
  return {
    revision,
    project: structuredClone(project),
    counts: projectCounts(project),
  };
}

/** timeline.get view: the compact tracks/clips/text-overlays projection. */
export function timelineStateView(project: Project, revision: number): TimelineState {
  return {
    revision,
    duration: project.timeline.duration,
    tracks: project.timeline.tracks.map((track) => ({
      id: track.id,
      type: track.type,
      name: track.name,
      locked: track.locked,
      hidden: track.hidden,
      muted: track.muted,
      solo: track.solo,
      clips: track.clips.map((clip) => ({
        id: clip.id,
        trackId: clip.trackId,
        mediaId: clip.mediaId,
        startTime: clip.startTime,
        duration: clip.duration,
        inPoint: clip.inPoint,
        outPoint: clip.outPoint,
        volume: clip.volume,
        speed: clip.speed ?? 1,
        reversed: clip.reversed ?? false,
        fade: {
          fadeIn: clip.fade?.fadeIn ?? 0,
          fadeOut: clip.fade?.fadeOut ?? 0,
        },
        colorGrading: clip.colorGrading
          ? structuredClone(clip.colorGrading) as unknown as Record<string, unknown>
          : null,
        keyframes: structuredClone(clip.keyframes ?? []),
        transform: {
          position: { ...clip.transform.position },
          scale: { ...clip.transform.scale },
          rotation: clip.transform.rotation,
          anchor: { ...clip.transform.anchor },
          opacity: clip.transform.opacity,
          fitMode: clip.transform.fitMode ?? "contain",
          crop: clip.transform.crop ? { ...clip.transform.crop } : null,
        },
      })),
      transitions: (track.transitions ?? []).map((transition) => ({
        id: transition.id,
        clipAId: transition.clipAId,
        clipBId: transition.clipBId ?? null,
        edge: transition.edge ?? null,
        type: transition.type,
        duration: transition.duration,
      })),
    })),
    textOverlays: (project.textClips ?? []).map((clip) => ({
      id: clip.id,
      trackId: clip.trackId,
      text: clip.text,
      startTime: clip.startTime,
      duration: clip.duration,
      position: { ...clip.transform.position },
      anchor: { ...clip.transform.anchor },
    })),
    subtitles: (project.timeline.subtitles ?? []).map((subtitle) => ({
      id: subtitle.id,
      text: subtitle.text,
      startTime: subtitle.startTime,
      endTime: subtitle.endTime,
      style: subtitle.style ? { ...subtitle.style } : null,
    })),
    markers: [...(project.markers?.items ?? [])]
      .sort((a, b) => a.number - b.number)
      .map((marker) => ({
        ref: `R${marker.number}`,
        number: marker.number,
        id: marker.id,
        target: { ...marker.target },
        ...(marker.label !== undefined ? { label: marker.label } : {}),
        ...(marker.color !== undefined ? { color: marker.color } : {}),
        createdAt: marker.createdAt,
      })),
  };
}

/** Max clip end across timeline tracks and text overlays, in seconds. */
export function timelineDurationSec(project: Project): number {
  let maxEnd = 0;
  for (const track of project.timeline.tracks) {
    for (const clip of track.clips) {
      maxEnd = Math.max(maxEnd, clip.startTime + clip.duration);
    }
  }
  for (const clip of project.textClips ?? []) {
    maxEnd = Math.max(maxEnd, clip.startTime + clip.duration);
  }
  for (const subtitle of project.timeline.subtitles ?? []) {
    maxEnd = Math.max(maxEnd, subtitle.endTime);
  }
  return maxEnd;
}
