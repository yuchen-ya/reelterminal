import type { Beat, BeatAnalysisResult } from "../audio/beat-detection-engine";
import type { Action } from "../types/actions";
import type { Clip } from "../types/timeline";

export type CutMode = "beats" | "downbeats" | "segments";

export interface AutoEditOptions {
  readonly cutMode: CutMode;
  readonly minClipDuration: number;
  readonly maxClipDuration: number;
  readonly sensitivity: number;
}

export const DEFAULT_AUTO_EDIT_OPTIONS: AutoEditOptions = {
  cutMode: "beats",
  minClipDuration: 0.3,
  maxClipDuration: 10,
  sensitivity: 0.5,
};

export interface AutoEditCut {
  readonly sourceClipId: string;
  readonly inPoint: number;
  readonly outPoint: number;
  readonly startTime: number;
  readonly duration: number;
}

export interface AutoEditResult {
  readonly cuts: AutoEditCut[];
  readonly totalDuration: number;
  readonly beatCount: number;
}

export class AutoEditService {
  generateCuts(
    beatAnalysis: BeatAnalysisResult,
    sourceClips: Clip[],
    options: AutoEditOptions = DEFAULT_AUTO_EDIT_OPTIONS,
  ): AutoEditResult {
    if (sourceClips.length === 0 || beatAnalysis.beats.length === 0) {
      return { cuts: [], totalDuration: 0, beatCount: 0 };
    }

    const cutPoints = this.getCutPoints(beatAnalysis, options);
    const filteredCutPoints = this.filterByMinDuration(
      cutPoints,
      options.minClipDuration,
    );

    const cuts: AutoEditCut[] = [];
    let currentTime = 0;
    let sourceIndex = 0;

    for (let i = 0; i < filteredCutPoints.length - 1; i++) {
      const segmentStart = filteredCutPoints[i];
      const segmentEnd = filteredCutPoints[i + 1];
      const segmentDuration = segmentEnd - segmentStart;

      if (segmentDuration > options.maxClipDuration) continue;

      const sourceClip = sourceClips[sourceIndex % sourceClips.length];
      const availableDuration = sourceClip.outPoint - sourceClip.inPoint;
      const inPoint =
        sourceClip.inPoint +
        ((i * segmentDuration) % Math.max(availableDuration - segmentDuration, segmentDuration));

      cuts.push({
        sourceClipId: sourceClip.id,
        inPoint: Math.min(inPoint, sourceClip.outPoint - segmentDuration),
        outPoint: Math.min(inPoint + segmentDuration, sourceClip.outPoint),
        startTime: currentTime,
        duration: segmentDuration,
      });

      currentTime += segmentDuration;
      sourceIndex++;
    }

    return {
      cuts,
      totalDuration: currentTime,
      beatCount: filteredCutPoints.length,
    };
  }

  private getCutPoints(
    beatAnalysis: BeatAnalysisResult,
    options: AutoEditOptions,
  ): number[] {
    switch (options.cutMode) {
      case "downbeats":
        return [0, ...beatAnalysis.downbeats].sort((a, b) => a - b);

      case "beats": {
        const strengthThreshold = 1 - options.sensitivity;
        const filteredBeats = beatAnalysis.beats.filter(
          (beat: Beat) => beat.strength >= strengthThreshold,
        );
        return [0, ...filteredBeats.map((b: Beat) => b.time)].sort(
          (a, b) => a - b,
        );
      }

      case "segments": {
        const beatsPerSegment = Math.max(
          2,
          Math.round(4 * (1 - options.sensitivity) + 1),
        );
        const points: number[] = [0];
        for (let i = 0; i < beatAnalysis.beats.length; i += beatsPerSegment) {
          points.push(beatAnalysis.beats[i].time);
        }
        return points;
      }

      default:
        return [0, beatAnalysis.duration];
    }
  }

  private filterByMinDuration(
    cutPoints: number[],
    minDuration: number,
  ): number[] {
    if (cutPoints.length <= 1) return cutPoints;

    const filtered: number[] = [cutPoints[0]];
    for (let i = 1; i < cutPoints.length; i++) {
      const lastPoint = filtered[filtered.length - 1];
      if (cutPoints[i] - lastPoint >= minDuration) {
        filtered.push(cutPoints[i]);
      }
    }
    return filtered;
  }
}

let instance: AutoEditService | null = null;

export function getAutoEditService(): AutoEditService {
  if (!instance) {
    instance = new AutoEditService();
  }
  return instance;
}

/** The track the cut plan rewrites, plus the pool of clips cuts may source from. */
export interface AutoEditTrackRef {
  readonly id: string;
  readonly clips: readonly Clip[];
}

/**
 * Expands a generated cut plan into existing reversible core actions so the
 * whole plan lands as one undoable batch with the same timeline layout the
 * plan previews (GUI AutoEditPanel and agent edit.apply batches share this):
 * - target-track clips that no cut references are removed;
 * - the first cut of a constant-speed source clip on the target track trims
 *   and moves that clip, keeping its identity for undo;
 * - every other cut is placed as a copy of its source clip with the cut's
 *   exact source range and timeline slot. Clips whose speed differs from 1
 *   always go through copies, because clip/trim derives timeline duration
 *   as (outPoint - inPoint) / speed, which would skew the plan's durations;
 *   the original speed-adjusted clip is then removed as in the plan.
 * Cuts whose source clip no longer exists are skipped, as before.
 */
export function expandCutPlanToActions(
  cuts: readonly AutoEditCut[],
  targetTrack: AutoEditTrackRef,
  sourceClips: readonly Clip[] = targetTrack.clips,
): Action[] {
  const makeAction = (type: string, params: Record<string, unknown>): Action => ({
    type,
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    params,
  });

  const targetClipIds = new Set(targetTrack.clips.map((clip) => clip.id));
  const sourceClipById = new Map(sourceClips.map((clip) => [clip.id, clip]));
  const firstCutIndexBySource = new Map<string, number>();
  cuts.forEach((cut, index) => {
    if (
      sourceClipById.has(cut.sourceClipId) &&
      !firstCutIndexBySource.has(cut.sourceClipId)
    ) {
      firstCutIndexBySource.set(cut.sourceClipId, index);
    }
  });

  const actions: Action[] = [];

  for (const clip of targetTrack.clips) {
    if (!firstCutIndexBySource.has(clip.id)) {
      actions.push(makeAction("clip/remove", { clipId: clip.id }));
    }
  }

  cuts.forEach((cut, index) => {
    const sourceClip = sourceClipById.get(cut.sourceClipId);
    if (!sourceClip) return;

    const isFirstCutOfSource =
      firstCutIndexBySource.get(cut.sourceClipId) === index;
    const constantSpeed =
      sourceClip.speed === undefined || sourceClip.speed === 1;
    const newClipId = `auto-edit-${Date.now()}-${index}`;

    if (isFirstCutOfSource && constantSpeed && targetClipIds.has(sourceClip.id)) {
      actions.push(
        makeAction("clip/trim", {
          clipId: sourceClip.id,
          inPoint: cut.inPoint,
          outPoint: cut.outPoint,
        }),
      );
      actions.push(
        makeAction("clip/move", {
          clipId: sourceClip.id,
          startTime: cut.startTime,
          trackId: targetTrack.id,
        }),
      );
      return;
    }

    actions.push(
      makeAction("clip/add", {
        trackId: targetTrack.id,
        mediaId: sourceClip.mediaId,
        clipId: newClipId,
        startTime: cut.startTime,
        sourceClip: {
          ...sourceClip,
          duration: cut.duration,
          inPoint: cut.inPoint,
          outPoint: cut.outPoint,
        },
      }),
    );
    if (isFirstCutOfSource && targetClipIds.has(sourceClip.id)) {
      actions.push(makeAction("clip/remove", { clipId: sourceClip.id }));
    }
  });

  return actions;
}
