import type { Project } from "../types/project";

type TimedItem = { readonly startTime: number; readonly duration: number };

/** Number of output frame starts in the half-open interval [0, duration). */
export function timelineFrameCount(duration: number, frameRate: number): number {
  const frames = duration * frameRate;
  // Decimal edits such as 0.1 + 0.2 can put an integer frame count one ULP
  // above its boundary. A genuine partial final frame still counts.
  const nearest = Math.round(frames);
  return Math.abs(frames - nearest) <= Number.EPSILON * frames
    ? nearest
    : Math.ceil(frames);
}

/** Preserve continuous-time requests, except for the exclusive timeline end. */
export function timelineSampleTime(time: number, duration: number, frameRate: number): number {
  if (time < duration) return time;
  return Math.max(0, timelineFrameCount(duration, frameRate) - 1) / frameRate;
}

function timedEnd(item: TimedItem): number {
  const startTime = Number.isFinite(item.startTime) ? item.startTime : 0;
  const duration = Number.isFinite(item.duration) ? item.duration : 0;
  return Math.max(0, startTime) + Math.max(0, duration);
}

/** Returns the last authored frame across every editor timeline surface. */
export function calculateProjectDuration(project: Project): number {
  let maxEnd = 0;
  const include = (items: readonly TimedItem[] | undefined): void => {
    for (const item of items ?? []) maxEnd = Math.max(maxEnd, timedEnd(item));
  };

  for (const track of project.timeline.tracks) include(track.clips);
  include(project.textClips);
  include(project.shapeClips);
  include(project.svgClips);
  include(project.stickerClips);
  include(project.adjustmentLayers);
  include(project.nestedInstances);
  include(project.motionInstances);
  if (project.particleEffects?.length) {
    const owners = new Set(project.timeline.tracks.flatMap(track => track.clips.map(clip => clip.id)));
    include(project.particleEffects.filter(effect => owners.has(effect.clipId)));
  }

  for (const subtitle of project.timeline.subtitles ?? []) {
    const endTime = Number.isFinite(subtitle.endTime) ? subtitle.endTime : 0;
    maxEnd = Math.max(maxEnd, Math.max(0, endTime));
  }

  return maxEnd;
}
