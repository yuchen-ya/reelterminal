import type { Project } from "@reelterminal/core/types/project";
import { SpeedEngine } from "@reelterminal/core/video/speed-engine";
import { FacadeError } from "./errors";
import type {
  TimelineMapSourceTimesParams,
  TimelineMapSourceTimesResult,
} from "./types";

export const MAX_TIMELINE_SOURCE_MAP_POINTS = 64;

/** Map explicit timeline points through the same Core speed/freeze evaluator used by rendering. */
export function mapTimelineSourceTimes(
  project: Project,
  revision: number,
  params: TimelineMapSourceTimesParams,
): TimelineMapSourceTimesResult {
  if (params.timelineTimes.length < 1 || params.timelineTimes.length > MAX_TIMELINE_SOURCE_MAP_POINTS) {
    throw new FacadeError(
      "INVALID_PARAMS",
      `timeline.mapSourceTimes: timelineTimes must contain 1 to ${MAX_TIMELINE_SOURCE_MAP_POINTS} points`,
      { maxPoints: MAX_TIMELINE_SOURCE_MAP_POINTS },
    );
  }

  const clip = project.timeline.tracks
    .flatMap((track) => track.clips)
    .find((candidate) => candidate.id === params.clipId);
  if (!clip) {
    throw new FacadeError(
      "NOT_FOUND",
      `timeline.mapSourceTimes: clip "${params.clipId}" not found`,
      { clipId: params.clipId },
    );
  }

  const engine = new SpeedEngine();
  engine.loadClips([clip]);
  const clipEnd = clip.startTime + clip.duration;
  const mappings = params.timelineTimes.map((timelineTime, index) => {
    if (timelineTime < clip.startTime || timelineTime > clipEnd) {
      throw new FacadeError(
        "INVALID_PARAMS",
        `timeline.mapSourceTimes: timelineTimes[${index}] must fall within clip ${clip.id}`,
        { clipId: clip.id, startTime: clip.startTime, endTime: clipEnd, timelineTime },
      );
    }
    const clipLocalTime = timelineTime - clip.startTime;
    const freezeFrame = engine.getFreezeFrameAtTime(clip.id, clipLocalTime);
    const sourceTimeFromInPoint = engine.getSourceTimeAtPlaybackTime(clip.id, clipLocalTime);
    return {
      clipId: clip.id,
      mediaId: clip.mediaId,
      timelineTime,
      clipLocalTime,
      sourceTime: clip.inPoint + sourceTimeFromInPoint,
      sourceTimeFromInPoint,
      frozen: freezeFrame !== null,
      freezeFrameId: freezeFrame?.id ?? null,
    };
  });

  return { revision, mappings };
}
