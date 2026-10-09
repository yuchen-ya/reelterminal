import { v4 as uuidv4 } from "uuid";
import type { StoreApi } from "zustand";
import type { Action, ActionResult } from "@reelterminal/core";
import type { ProjectState } from "../project-store";
import { toast } from "../notification-store";
import { t } from "../../i18n";
import { calculateTimelineDuration } from "./index";

type Get = StoreApi<ProjectState>["getState"];
type Set = StoreApi<ProjectState>["setState"];

export type ClipSlice = Pick<
  ProjectState,
  | "addClip"
  | "addClipToNewTrack"
  | "separateAudio"
  | "removeClip"
  | "moveClip"
  | "closeGapBeforeClip"
  | "moveClips"
  | "trimClip"
  | "splitClip"
  | "rippleDeleteClip"
  | "slipClip"
  | "slideClip"
  | "rollEdit"
  | "trimToPlayhead"
  | "getClip"
>;

export function createClipSlice(_set: Set, get: Get): ClipSlice {
  return {
    addClip: async (trackId: string, mediaId: string, startTime: number) => {
      const action: Action = {
        type: "clip/add",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { trackId, mediaId, startTime },
      };
      return (await get().submitActionBatch([action], {
        groupLabel: "Add clip",
        historyOwner: "human",
      })).result;
    },

    addClipToNewTrack: async (mediaId: string, startTime?: number) => {
      const { getMediaItem } = get();
      const mediaItem = getMediaItem(mediaId);
      if (!mediaItem) {
        return {
          success: false,
          error: {
            code: "MEDIA_NOT_FOUND" as const,
            message: "Media item not found",
          },
        };
      }

      let trackType: "video" | "audio" | "image" | "text" | "graphics";
      if (mediaItem.type === "video") trackType = "video";
      else if (mediaItem.type === "audio") trackType = "audio";
      else if (mediaItem.type === "image") trackType = "image";
      else trackType = "video";

      const addToTrack = (): ActionResult => {
        const trackId = uuidv4();
        const project = get().project;
        const trackAction: Action = {
          type: "track/add",
          id: uuidv4(),
          timestamp: Date.now(),
          params: { trackType, trackId },
        };
        const clipAction: Action = {
          type: "clip/add",
          id: uuidv4(),
          timestamp: Date.now(),
          params: {
            trackId,
            mediaId,
            startTime: startTime ?? calculateTimelineDuration(project),
          },
        };
        return get().executeActionBatch([trackAction, clipAction], {
          groupLabel: "Add clip to new track",
          historyOwner: "human",
        }).result;
      };
      const submit = get().submitWorkspaceMutation;
      return submit ? submit(addToTrack) : addToTrack();
    },

    separateAudio: async (clipId: string) => {
      const { project } = get();
      const videoClip = project.timeline.tracks
        .flatMap((t) => t.clips)
        .find((c) => c.id === clipId);
      if (!videoClip) {
        return {
          success: false,
          error: { code: "CLIP_NOT_FOUND" as const, message: "Clip not found" },
        };
      }

      const mediaItem = project.mediaLibrary.items.find(
        (m) => m.id === videoClip.mediaId,
      );
      if (
        !mediaItem ||
        mediaItem.type !== "video" ||
        !mediaItem.metadata?.channels ||
        mediaItem.metadata.channels === 0
      ) {
        return {
          success: false,
          error: {
            code: "MEDIA_NOT_FOUND" as const,
            message: "Media has no audio to separate",
          },
        };
      }

      let audioTrackCount = mediaItem.metadata.audioTrackCount ?? 1;
      if (audioTrackCount <= 1 && mediaItem.blob) {
        try {
          const { getFFmpegFallback } = await import("@reelterminal/core/media");
          const ffmpeg = getFFmpegFallback();
          const probeResult = await ffmpeg.probeAudioStreams(mediaItem.blob);
          if (probeResult.audioStreamCount > 1) {
            audioTrackCount = probeResult.audioStreamCount;
          }
        } catch (error) {
          // FFmpeg probe unavailable — proceed with count of 1. When the
          // FFmpeg.wasm core itself failed to load (remote CDN unreachable),
          // multi-channel audio would silently separate as a single track,
          // so surface a one-off warning with the existing retry entry
          // (re-running Separate Audio re-attempts the load; nothing
          // retries automatically).
          if (
            error instanceof Error &&
            error.message.includes("Failed to load FFmpeg.wasm")
          ) {
            console.warn("[clip] FFmpeg.wasm core load failed:", error);
            toast.warning(
              t("media.ffmpegLoadFailedTitle"),
              t("media.ffmpegLoadFailedDetail"),
            );
          }
        }
      }

      const audioCountAfterProbe = audioTrackCount;
      const applySeparation = (): ActionResult => {
      const liveProject = get().project;
      const liveClip = liveProject.timeline.tracks
        .flatMap((track) => track.clips)
        .find((clip) => clip.id === clipId);
      const liveMedia = liveProject.mediaLibrary.items.find(
        (item) => item.id === liveClip?.mediaId,
      );
      if (!liveClip || liveClip.mediaId !== videoClip.mediaId || !liveMedia) {
        return {
          success: false,
          error: {
            code: "INVALID_PARAMS",
            message: "The source clip changed while audio streams were being checked",
          },
        };
      }
      const existingAudioTracks = liveProject.timeline.tracks.filter(
        (t) => t.type === "audio",
      );

      const actions: Action[] = [];
      const newTrackIds: string[] = [];
      for (let i = existingAudioTracks.length; i < audioCountAfterProbe; i++) {
        const newTrackId = uuidv4();
        newTrackIds.push(newTrackId);
        actions.push({
          type: "track/add",
          id: uuidv4(),
          timestamp: Date.now(),
          params: { trackType: "audio", trackId: newTrackId },
        });
      }

      const audioTrackIds = [
        ...existingAudioTracks.map((track) => track.id),
        ...newTrackIds,
      ];
      if (audioTrackIds.length < audioCountAfterProbe) {
        return {
          success: false,
          error: {
            code: "TRACK_NOT_FOUND" as const,
            message: "Could not find or create audio track",
          },
        };
      }

      for (let trackIdx = 0; trackIdx < audioCountAfterProbe; trackIdx++) {
        const targetTrackId = audioTrackIds[trackIdx];
        if (!targetTrackId) break;
        actions.push({
          type: "clip/add",
          id: uuidv4(),
          timestamp: Date.now(),
          params: {
            trackId: targetTrackId,
            mediaId: liveClip.mediaId,
            startTime: liveClip.startTime,
            audioTrackIndex: trackIdx,
          },
        });
      }
      actions.push({
        type: "audio/setVolume",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { clipId, volume: 0 },
      });
      return get().executeActionBatch(actions, {
        groupLabel: "Separate audio",
        historyOwner: "human",
      }).result;
      };
      const submit = get().submitWorkspaceMutation;
      return submit ? submit(applySeparation) : applySeparation();
    },

    removeClip: async (clipId: string) => {
      const action: Action = {
        type: "clip/remove",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { clipId },
      };
      return get().executeAction(action);
    },

    moveClip: async (clipId: string, startTime: number, trackId?: string) => {
      const action: Action = {
        type: "clip/move",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { clipId, startTime, trackId },
      };
      return get().executeAction(action);
    },

    closeGapBeforeClip: async (clipId: string) => {
      const action: Action = {
        type: "clip/closeGapBefore",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { clipId },
      };
      return get().executeAction(action);
    },

    moveClips: async (moves) => {
      if (moves.length === 0) return { success: true };
      if (moves.length === 1) {
        return get().moveClip(
          moves[0].clipId,
          moves[0].startTime,
          moves[0].trackId,
        );
      }
      const actions = moves.map((move): Action => ({
            type: "clip/move",
            id: uuidv4(),
            timestamp: Date.now(),
            params: {
              clipId: move.clipId,
              startTime: move.startTime,
              trackId: move.trackId,
            },
          }));
      return (await get().submitActionBatch(actions, {
        groupLabel: "Move clips",
        historyOwner: "human",
      })).result;
    },

    trimClip: async (clipId: string, inPoint?: number, outPoint?: number) => {
      const action: Action = {
        type: "clip/trim",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { clipId, inPoint, outPoint },
      };
      return get().executeAction(action);
    },

    splitClip: async (clipId: string, time: number) => {
      const action: Action = {
        type: "clip/split",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { clipId, time },
      };
      return get().executeAction(action);
    },

    rippleDeleteClip: async (clipId: string) => {
      const action: Action = {
        type: "clip/rippleDelete",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { clipId },
      };
      return get().executeAction(action);
    },

    slipClip: async (clipId: string, delta: number) => {
      const action: Action = {
        type: "clip/slip",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { clipId, delta },
      };
      return get().executeAction(action);
    },

    slideClip: async (clipId: string, delta: number) => {
      const { project, getClip } = get();
      const clip = getClip(clipId);
      if (!clip) {
        return {
          success: false,
          error: { code: "INVALID_PARAMS" as const, message: "Clip not found" },
        };
      }
      const track = project.timeline.tracks.find((t) =>
        t.clips.some((c) => c.id === clipId),
      );
      if (!track) {
        return {
          success: false,
          error: { code: "INVALID_PARAMS" as const, message: "Track not found" },
        };
      }
      const sortedClips = [...track.clips].sort(
        (a, b) => a.startTime - b.startTime,
      );
      const clipIndex = sortedClips.findIndex((c) => c.id === clipId);
      const prevClip = clipIndex > 0 ? sortedClips[clipIndex - 1] : undefined;
      const nextClip =
        clipIndex < sortedClips.length - 1
          ? sortedClips[clipIndex + 1]
          : undefined;

      const action: Action = {
        type: "clip/slide",
        id: uuidv4(),
        timestamp: Date.now(),
        params: {
          clipId,
          delta,
          prevClipId: prevClip?.id,
          nextClipId: nextClip?.id,
        },
      };
      return get().executeAction(action);
    },

    rollEdit: async (leftClipId: string, rightClipId: string, delta: number) => {
      const action: Action = {
        type: "clip/roll",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { leftClipId, rightClipId, delta },
      };
      return get().executeAction(action);
    },

    trimToPlayhead: async (
      clipId: string,
      playheadTime: number,
      trimStart: boolean,
    ) => {
      const action: Action = {
        type: "clip/trimToPlayhead",
        id: uuidv4(),
        timestamp: Date.now(),
        params: { clipId, playheadTime, trimStart },
      };
      return get().executeAction(action);
    },

    getClip: (clipId: string) => {
      const { project } = get();
      for (const track of project.timeline.tracks) {
        const clip = track.clips.find((c) => c.id === clipId);
        if (clip) return clip;
      }
      return undefined;
    },
  };
}
