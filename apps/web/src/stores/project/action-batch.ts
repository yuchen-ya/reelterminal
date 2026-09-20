import type { Action, ActionResult, Project } from "@reelterminal/core";

/** Bounded below ActionHistory's retained entry count, including expansions. */
export const MAX_ACTIONS_PER_BATCH = 256;

export interface ActionBatchCreatedIds {
  readonly tracks: string[];
  readonly clips: string[];
  readonly textClips: string[];
  /** SVG overlays created by the batch (svg/create actions). */
  readonly svgClips: string[];
  readonly transitions: string[];
  readonly subtitles: string[];
}

export interface ActionBatchOptions {
  readonly groupLabel: string;
  readonly historyOwner: string;
}

export interface ActionBatchResult {
  readonly result: ActionResult;
  readonly applied: number;
  readonly createdIds: ActionBatchCreatedIds;
}

export type ExecuteActionBatch = (
  actions: readonly Action[],
  options: ActionBatchOptions,
) => ActionBatchResult;

export function emptyActionBatchCreatedIds(): ActionBatchCreatedIds {
  return {
    tracks: [],
    clips: [],
    textClips: [],
    svgClips: [],
    transitions: [],
    subtitles: [],
  };
}

export function projectEntityIds(project: Project): ActionBatchCreatedIds {
  return {
    tracks: project.timeline.tracks.map((track) => track.id),
    clips: project.timeline.tracks.flatMap((track) =>
      track.clips.map((clip) => clip.id),
    ),
    textClips: (project.textClips ?? []).map((clip) => clip.id),
    svgClips: (project.svgClips ?? []).map((clip) => clip.id),
    transitions: project.timeline.tracks.flatMap((track) =>
      (track.transitions ?? []).map((transition) => transition.id),
    ),
    subtitles: (project.timeline.subtitles ?? []).map((subtitle) => subtitle.id),
  };
}

export function appendCreatedIdDiff(
  target: ActionBatchCreatedIds,
  before: ActionBatchCreatedIds,
  after: ActionBatchCreatedIds,
): void {
  const beforeTracks = new Set(before.tracks);
  const beforeClips = new Set(before.clips);
  const beforeText = new Set(before.textClips);
  const beforeSvg = new Set(before.svgClips);
  const beforeTransitions = new Set(before.transitions);
  const beforeSubtitles = new Set(before.subtitles);
  target.tracks.push(...after.tracks.filter((id) => !beforeTracks.has(id)));
  target.clips.push(...after.clips.filter((id) => !beforeClips.has(id)));
  target.textClips.push(
    ...after.textClips.filter((id) => !beforeText.has(id)),
  );
  target.svgClips.push(...after.svgClips.filter((id) => !beforeSvg.has(id)));
  target.transitions.push(
    ...after.transitions.filter((id) => !beforeTransitions.has(id)),
  );
  target.subtitles.push(
    ...after.subtitles.filter((id) => !beforeSubtitles.has(id)),
  );
}
