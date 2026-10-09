import { v4 as uuidv4 } from "uuid";
import type { StoreApi } from "zustand";
import type { Action } from "@reelterminal/core";
import type { ProjectState } from "../project-store";

type Get = StoreApi<ProjectState>["getState"];
type Set = StoreApi<ProjectState>["setState"];

export type TrackSlice = Pick<
  ProjectState,
  | "addTrack"
  | "duplicateTrack"
  | "removeTrack"
  | "renameTrack"
  | "reorderTrack"
  | "lockTrack"
  | "hideTrack"
  | "muteTrack"
  | "soloTrack"
  | "groupTracks"
  | "getTrack"
  | "consolidateTrack"
>;

export function createTrackSlice(set: Set, get: Get): TrackSlice {
  return {
    addTrack: async (trackType, position) => {
      const action: Action = {
        type: "track/add",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { trackType, position, trackId: uuidv4() },
      };
      return (await get().submitActionBatch([action], {
        groupLabel: "Add track",
        historyOwner: "human",
      })).result;
    },

    duplicateTrack: async (trackId) => {
      const { project } = get();
      const sourceIndex = project.timeline.tracks.findIndex(
        (track) => track.id === trackId,
      );
      if (sourceIndex < 0) {
        return {
          success: false,
          error: { code: "TRACK_NOT_FOUND", message: "Track not found" },
        };
      }
      const action: Action = {
        type: "track/duplicate",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { sourceTrackId: trackId, position: sourceIndex + 1, trackId: uuidv4() },
      };
      return (await get().submitActionBatch([action], {
        groupLabel: "Duplicate track",
        historyOwner: "human",
      })).result;
    },

    removeTrack: async (trackId) => {
      const action: Action = {
        type: "track/remove",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { trackId },
      };
      return (await get().submitActionBatch([action], {
        groupLabel: "Remove track",
        historyOwner: "human",
      })).result;
    },

    renameTrack: async (trackId, name) => {
      const trimmed = name.trim();
      if (!trimmed) {
        return {
          success: false,
          error: {
            code: "INVALID_PARAMS",
            message: "Track name cannot be empty",
          },
        };
      }
      const action: Action = {
        type: "track/rename",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { trackId, name: trimmed },
      };
      return (await get().submitActionBatch([action], {
        groupLabel: "Rename track",
        historyOwner: "human",
      })).result;
    },

    reorderTrack: async (trackId, newPosition) => {
      const action: Action = {
        type: "track/reorder",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { trackId, newPosition },
      };
      return (await get().submitActionBatch([action], {
        groupLabel: "Reorder track",
        historyOwner: "human",
      })).result;
    },

    lockTrack: async (trackId, locked) => {
      const action: Action = {
        type: "track/lock",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { trackId, locked },
      };
      return (await get().submitActionBatch([action], {
        groupLabel: "Lock track",
        historyOwner: "human",
      })).result;
    },

    hideTrack: async (trackId, hidden) => {
      const action: Action = {
        type: "track/hide",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { trackId, hidden },
      };
      return (await get().submitActionBatch([action], {
        groupLabel: "Hide track",
        historyOwner: "human",
      })).result;
    },

    muteTrack: async (trackId, muted) => {
      const action: Action = {
        type: "track/mute",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { trackId, muted },
      };
      return (await get().submitActionBatch([action], {
        groupLabel: "Mute track",
        historyOwner: "human",
      })).result;
    },

    soloTrack: async (trackId, solo) => {
      const action: Action = {
        type: "track/solo",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { trackId, solo },
      };
      return (await get().submitActionBatch([action], {
        groupLabel: "Solo track",
        historyOwner: "human",
      })).result;
    },

    groupTracks: async (trackId, partnerTrackId) => {
      const mutate = (): boolean => {
      const { project } = get();
      const source = project.timeline.tracks.find((track) => track.id === trackId);
      if (!source) return false;

      if (!partnerTrackId) {
        if (!source.groupId) return true;
        const groupMembers = project.timeline.tracks.filter(
          (track) => track.groupId === source.groupId,
        );
        set({
          project: {
            ...project,
            timeline: {
              ...project.timeline,
              tracks: project.timeline.tracks.map((track) =>
                track.id === trackId ||
                (groupMembers.length === 2 && track.groupId === source.groupId)
                  ? { ...track, groupId: undefined }
                  : track,
              ),
            },
            modifiedAt: Date.now(),
          },
        });
        return true;
      }

      const partner = project.timeline.tracks.find(
        (track) => track.id === partnerTrackId,
      );
      if (!partner || partner.id === source.id) return false;
      const groupId = source.groupId ?? partner.groupId ?? `track-group-${uuidv4()}`;
      const mergedGroupIds = new Set(
        [source.groupId, partner.groupId].filter(Boolean) as string[],
      );
      set({
        project: {
          ...project,
          timeline: {
            ...project.timeline,
            tracks: project.timeline.tracks.map((track) =>
              track.id === source.id ||
              track.id === partner.id ||
              (track.groupId ? mergedGroupIds.has(track.groupId) : false)
                ? { ...track, groupId }
                : track,
            ),
          },
          modifiedAt: Date.now(),
        },
      });
      return true;
      };
      const submit = get().submitWorkspaceMutation;
      return submit ? submit(mutate) : mutate();
    },

    getTrack: (trackId) =>
      get().project.timeline.tracks.find((track) => track.id === trackId),

    consolidateTrack: async (trackId) => {
      const action: Action = {
        type: "track/consolidate",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { trackId },
      };
      return (await get().submitActionBatch([action], {
        groupLabel: "Consolidate track",
        historyOwner: "human",
      })).result;
    },
  };
}
