import React, { useState, useRef, useEffect } from "react";
import { Eye, EyeOff, Volume2, VolumeX, Lock, Trash2, Pencil, AlignLeft, Link2, Unlink } from "@/icons/lucide-compat";
import {
  ToolcraftContextMenu as ContextMenu,
  type ToolcraftContextMenuOption as ContextMenuOption,
} from "@reelterminal/ui";
import { ToolcraftTextInputControl } from "@reelterminal/ui";
import type { Track } from "@reelterminal/core";
import { useProjectStore } from "../../../stores/project-store";
import { useTimelineStore } from "../../../stores/timeline-store";
import { getTrackInfo } from "./utils";
import { useTranslation } from "react-i18next";

interface TrackHeaderProps {
  track: Track;
  index: number;
  onDragStart: (e: React.DragEvent, trackId: string) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent, targetTrackId: string) => void;
  onDragEnd: () => void;
  keyframeCount?: number;
}

export const TrackHeader: React.FC<TrackHeaderProps> = ({
  track,
  index,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}) => {
  const { t } = useTranslation();
  const {
    lockTrack,
    hideTrack,
    muteTrack,
    soloTrack,
    removeTrack,
    renameTrack,
    consolidateTrack,
    groupTracks,
    project,
  } = useProjectStore();
  const { getTrackHeight } = useTimelineStore();

  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(track.name);
  const inputRef = useRef<HTMLInputElement>(null);

  const trackInfo = getTrackInfo(track, index);
  const isVisual =
    track.type === "video" ||
    track.type === "image" ||
    track.type === "text" ||
    track.type === "graphics";
  const isAudio = track.type === "audio";
  // Video tracks can carry embedded audio, so they get the same mute/solo
  // controls as audio tracks (image/text/graphics never carry audio).
  const canCarryAudio = isAudio || track.type === "video";
  // Solo suppression in both the preview graph and the export mix is computed
  // across audio and video tracks only, so the UI must use the same set.
  const hasSoloedAudibleTrack = project.timeline.tracks.some(
    (candidate) =>
      (candidate.type === "audio" || candidate.type === "video") &&
      candidate.solo,
  );
  const mutedBySolo = hasSoloedAudibleTrack && !track.solo;
  // Grey the mute/solo controls out only when every clip on a video track
  // provably has no audio stream; when it cannot be judged (no clips yet,
  // missing media or metadata) the controls stay available. MediaItem.metadata
  // is persisted as MediaMetadata but carries the import-time MediaTrackInfo at
  // runtime, so hasAudio is probed defensively instead of via the static type.
  const hasNoAudioContent = React.useMemo(() => {
    if (track.type !== "video" || track.clips.length === 0) return false;
    const mediaItems = project.mediaLibrary?.items ?? [];
    const clipHasAudio = (clip: { mediaId: string }): boolean | null => {
      const item = mediaItems.find((media) => media.id === clip.mediaId);
      const meta: unknown = item?.metadata;
      if (typeof meta !== "object" || meta === null) return null;
      const hasAudio: unknown = (meta as { hasAudio?: unknown }).hasAudio;
      return typeof hasAudio === "boolean" ? hasAudio : null;
    };
    return track.clips.every(
      (clip) => clipHasAudio(clip) === false,
    );
  }, [track.type, track.clips, project.mediaLibrary]);
  const groupCandidates = project.timeline.tracks.filter(
    (candidate) =>
      candidate.id !== track.id &&
      candidate.groupId !== track.groupId &&
      (track.type === "text"
        ? candidate.type !== "text" && candidate.type !== "graphics"
        : candidate.type === "text"),
  );

  const handleRemoveTrack = async () => {
    await removeTrack(track.id);
  };

  const handleRemoveGaps = async () => {
    await consolidateTrack(track.id);
  };

  // Only enable "Remove Gaps" if there's actually a gap on this track.
  const hasGaps = React.useMemo(() => {
    if (track.clips.length === 0) return false;
    const sorted = [...track.clips].sort((a, b) => a.startTime - b.startTime);
    if (sorted[0].startTime > 0.0001) return true;
    for (let i = 1; i < sorted.length; i++) {
      const prevEnd = sorted[i - 1].startTime + sorted[i - 1].duration;
      if (sorted[i].startTime - prevEnd > 0.0001) return true;
    }
    return false;
  }, [track.clips]);

  const startRename = () => {
    setRenameValue(track.name);
    setIsRenaming(true);
  };

  const commitRename = () => {
    renameTrack(track.id, renameValue || track.name);
    setIsRenaming(false);
  };

  const cancelRename = () => {
    setRenameValue(track.name);
    setIsRenaming(false);
  };

  useEffect(() => {
    if (isRenaming) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isRenaming]);

  const menuItems: ContextMenuOption[] = [
    {
      label: t("Rename Track"),
      icon: <Pencil size={14} aria-hidden />,
      onClick: startRename,
    },
    {
      label: t("Remove Gaps"),
      icon: <AlignLeft size={14} aria-hidden />,
      isDisabled: !hasGaps,
      onClick: handleRemoveGaps,
    },
    ...(track.groupId
      ? [
          {
            label: t("Ungroup Track"),
            icon: <Unlink size={14} aria-hidden />,
            onClick: () => groupTracks(track.id),
          } satisfies ContextMenuOption,
        ]
      : []),
    ...(groupCandidates.length > 0
      ? [
          {
            type: "section" as const,
            title: t("Move & trim together"),
            items: groupCandidates.map((candidate) => ({
              label: `Group with ${candidate.name}`,
              icon: <Link2 size={14} aria-hidden />,
              onClick: () => groupTracks(track.id, candidate.id),
            })),
          } satisfies ContextMenuOption,
        ]
      : []),
    { type: "divider" },
    {
      label: t("Delete Track"),
      icon: <Trash2 size={14} aria-hidden />,
      onClick: handleRemoveTrack,
    },
  ];

  return (
    <ContextMenu items={menuItems} menuWidth={180} size="sm">
      <div
        draggable={!isRenaming}
        onDragStart={(e) => onDragStart(e, track.id)}
        onDragOver={onDragOver}
        onDrop={(e) => onDrop(e, track.id)}
        onDragEnd={onDragEnd}
        style={{ height: getTrackHeight(track.id, track.type) }}
        className={`border-b border-border flex items-center gap-2.5 px-4 relative group transition-colors cursor-grab active:cursor-grabbing ${
          // Dimming is reserved for "picture hidden" (eye) so it never reads as
          // "sound muted"; mute feedback lives on the speaker control below.
          track.hidden ? "opacity-60" : ""
        } ${
          track.locked ? "bg-bg-2/50" : "bg-bg-1"
        }`}
      >
          <div className="min-w-0 flex-1">
            {isRenaming ? (
              <ToolcraftTextInputControl
                ref={inputRef}
                label={t("Track name")}
                isLabelHidden
                size="sm"
                width="100%"
                value={renameValue}
                onChange={setRenameValue}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") cancelRename();
                  e.stopPropagation();
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span
                className="block truncate text-[13px] font-semibold text-fg-2 cursor-grab active:cursor-grabbing"
                onDoubleClick={startRename}
              >
                {track.name || trackInfo.label}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            {track.groupId && (
              <Link2
                size={13}
                className="text-accent"
                aria-label={t("Track is grouped")}
              />
            )}
            {isVisual && (
              <button
                type="button"
                aria-label={track.hidden ? t("Show track") : t("Hide track")}
                className="text-fg-muted hover:text-fg-2 transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  hideTrack(track.id, !track.hidden);
                }}
              >
                {track.hidden ? (
                  <EyeOff size={15} strokeWidth={1.7} aria-hidden />
                ) : (
                  <Eye size={15} strokeWidth={1.7} aria-hidden />
                )}
              </button>
            )}
            {canCarryAudio && (
              <>
                <button
                  type="button"
                  disabled={hasNoAudioContent}
                  aria-label={
                    track.muted
                      ? t("Unmute {{name}}", { name: track.name })
                      : t("Mute {{name}}", { name: track.name })
                  }
                  aria-pressed={track.muted}
                  title={
                    hasNoAudioContent
                      ? t("Track has no audio")
                      : track.muted
                        ? t("Unmute track")
                        : mutedBySolo
                          ? t("Silenced by solo")
                          : t("Mute track")
                  }
                  className={`transition-colors ${
                    hasNoAudioContent
                      ? "text-fg-muted opacity-40 cursor-not-allowed"
                      : track.muted
                        ? "text-destructive"
                        : mutedBySolo
                          ? "text-fg-muted opacity-50 hover:text-fg-2"
                          : "text-fg-muted hover:text-fg-2"
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    muteTrack(track.id, !track.muted);
                  }}
                >
                  {track.muted ? (
                    <VolumeX size={15} strokeWidth={1.7} aria-hidden />
                  ) : (
                    <Volume2 size={15} strokeWidth={1.7} aria-hidden />
                  )}
                </button>
                <button
                  type="button"
                  disabled={hasNoAudioContent}
                  aria-label={
                    track.solo
                      ? t("Clear solo {{name}}", { name: track.name })
                      : t("Solo {{name}}", { name: track.name })
                  }
                  aria-pressed={track.solo}
                  title={
                    hasNoAudioContent
                      ? t("Track has no audio")
                      : track.solo
                        ? t("Clear solo")
                        : t("Solo track")
                  }
                  className={`flex h-[18px] min-w-[18px] items-center justify-center rounded px-1 text-[9px] font-black transition-colors ${
                    hasNoAudioContent
                      ? "text-fg-muted opacity-40 cursor-not-allowed"
                      : track.solo
                        ? "bg-status-warning text-black"
                        : "text-fg-muted hover:bg-hover hover:text-fg-2"
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    soloTrack(track.id, !track.solo);
                  }}
                >
                  S
                </button>
              </>
            )}
            <button
              type="button"
              aria-label={track.locked ? t("Unlock") : t("Lock")}
              className={`transition-colors ${
                track.locked ? "text-fg-2" : "text-fg-muted hover:text-fg-2"
              }`}
              onClick={(e) => {
                e.stopPropagation();
                lockTrack(track.id, !track.locked);
              }}
            >
              <Lock size={13} strokeWidth={1.8} aria-hidden />
            </button>
          </div>
      </div>
    </ContextMenu>
  );
};
