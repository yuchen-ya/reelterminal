import type { Project } from "@reelterminal/core/types/project";
import { FacadeError } from "./errors";
import { timelineDurationSec } from "./projection";
import type { VisualInspectParams, VisualInspectTimeRange } from "./types";

/** Resource ceilings for one read-only visual.inspect call. */
export const MAX_VISUAL_SAMPLES = 12;
export const MAX_VISUAL_FRAME_PIXELS = 1_048_576;
export const MAX_VISUAL_CONTACT_SHEET_PIXELS = 24_000_000;
export const MAX_VISUAL_PNG_BYTES = 8 * 1024 * 1024;

function evenAtMost(value: number, max = 1024): number {
  return Math.max(2, Math.min(max, Math.floor(value / 2) * 2));
}

export function visualRasterSize(
  project: Project,
  requestedWidth: number | undefined,
  requestedHeight: number | undefined,
): { width: number; height: number } {
  const projectWidth = Math.max(2, project.settings.width);
  const projectHeight = Math.max(2, project.settings.height);
  const aspect = projectHeight / projectWidth;
  if (requestedWidth === undefined && requestedHeight === undefined) {
    const width = evenAtMost(Math.min(projectWidth, 640));
    return { width, height: evenAtMost(width * aspect) };
  }
  if (requestedWidth !== undefined && requestedHeight === undefined) {
    const width = evenAtMost(requestedWidth);
    return { width, height: evenAtMost(width * aspect) };
  }
  if (requestedWidth === undefined && requestedHeight !== undefined) {
    const height = evenAtMost(requestedHeight);
    return { width: evenAtMost(height / aspect), height };
  }
  return {
    width: evenAtMost(requestedWidth as number),
    height: evenAtMost(requestedHeight as number),
  };
}

export interface VisualSample {
  readonly timeSec: number;
  readonly label: string;
}

export type VisualSelection =
  | { readonly kind: "clip"; readonly clipId: string; readonly startSec: number; readonly endSec: number }
  | { readonly kind: "timeRange"; readonly startSec: number; readonly endSec: number };

export interface VisualSamplePlan {
  readonly selection: VisualSelection;
  readonly samples: readonly VisualSample[];
}

/**
 * Build a deterministic, boundary-safe sample plan from the canonical
 * project. The facade validates the nested object before calling this helper;
 * this function owns the cross-field rules and clip lookup.
 */
export function buildVisualSamplePlan(
  project: Project,
  params: VisualInspectParams & { readonly timeRange?: VisualInspectTimeRange },
): VisualSamplePlan {
  const hasClip = params.clipId !== undefined;
  const hasRange = params.timeRange !== undefined;
  if (hasClip === hasRange) {
    throw new FacadeError(
      "INVALID_PARAMS",
      'visual.inspect: pass exactly one selector — clipId (a timeline clip id) or timeRange ({"startSec": <number ≥ 0>, "endSec": <number > startSec>})',
      { received: { clipId: hasClip, timeRange: hasRange } },
    );
  }
  const sampleCount = params.sampleCount ?? 6;
  if (!Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > MAX_VISUAL_SAMPLES) {
    throw new FacadeError(
      "INVALID_PARAMS",
      `visual.inspect: sampleCount must be an integer from 1 to ${MAX_VISUAL_SAMPLES}`,
      { sampleCount },
    );
  }
  const duration = timelineDurationSec(project);
  const frameEpsilon = 1 / (2 * project.settings.frameRate);
  let selection: VisualSelection;

  if (hasClip) {
    const clipId = params.clipId as string;
    let found: { startTime: number; duration: number } | undefined;
    for (const track of project.timeline.tracks) {
      const clip = track.clips.find((candidate) => candidate.id === clipId);
      if (clip) {
        found = { startTime: clip.startTime, duration: clip.duration };
        break;
      }
    }
    if (!found) {
      throw new FacadeError(
        "NOT_FOUND",
        `visual.inspect: unknown timeline clipId "${clipId}"`,
        { clipId },
      );
    }
    selection = {
      kind: "clip",
      clipId,
      startSec: found.startTime,
      endSec: found.startTime + found.duration,
    };
  } else {
    const range = params.timeRange as VisualInspectTimeRange;
    if (!(range.endSec > range.startSec)) {
      throw new FacadeError(
        "INVALID_PARAMS",
        "visual.inspect: timeRange.endSec must be greater than startSec",
        { timeRange: range },
      );
    }
    if (range.endSec > duration) {
      throw new FacadeError(
        "INVALID_PARAMS",
        `visual.inspect: timeRange.endSec ${range.endSec} is beyond the timeline duration ${duration}`,
        { endSec: range.endSec, durationSec: duration },
      );
    }
    selection = {
      kind: "timeRange",
      startSec: range.startSec,
      endSec: range.endSec,
    };
  }

  const start = selection.startSec;
  const end = selection.endSec;
  // Clip end points are exclusive, and a timeline-end range has no next
  // frame. Keep those samples inside the renderable content by half a frame;
  // an interior explicit time range may include its requested endpoint.
  const avoidBoundary = selection.kind === "clip" || end >= duration;
  const safeEnd = avoidBoundary
    ? Math.max(start, Math.min(end, duration) - frameEpsilon)
    : end;
  const samples = Array.from({ length: sampleCount }, (_, index) => {
    const fraction = sampleCount === 1 ? 0.5 : index / (sampleCount - 1);
    const rawTime = start + (end - start) * fraction;
    const timeSec = Math.min(Math.max(start, rawTime), safeEnd);
    const prefix = selection.kind === "clip"
      ? `clip:${selection.clipId}`
      : `range:${start.toFixed(3)}-${end.toFixed(3)}`;
    return {
      timeSec,
      label: `${prefix} ${index + 1}/${sampleCount}`,
    };
  });
  return { selection, samples };
}
