import {
  getBackgroundRemovalEngine,
  resolveBackgroundRemovalSettings,
  type BackgroundRemovalSettings,
} from "@reelterminal/core";
import { useProjectStore } from "../../../stores/project-store";

/**
 * Field-first background-removal read for the preview pipeline.
 *
 * The persisted clip.backgroundRemoval field (written by the undoable
 * clip/setBackgroundRemoval action, saved with the project) is the source of
 * truth; the engine's in-memory Map stays a session cache for legacy
 * in-session flows where the field is absent. Pure lookup — never mutates
 * project state.
 */
export const clipBackgroundRemovalSettings = (
  clipId: string,
): BackgroundRemovalSettings => {
  const project = useProjectStore.getState().project;
  const clip = project
    ? project.timeline.tracks
        .flatMap((track) => track.clips)
        .find((candidate) => candidate.id === clipId)
    : undefined;
  return resolveBackgroundRemovalSettings(clip, getBackgroundRemovalEngine());
};
