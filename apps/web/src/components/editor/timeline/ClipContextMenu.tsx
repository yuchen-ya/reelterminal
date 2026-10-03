import { openBoardForEntities } from "../../../services/requirement-board";
import React from "react";
import { useTranslation } from "react-i18next";
import type { ToolcraftContextMenuOption as ContextMenuOption } from "@reelterminal/ui";
import {
  Copy,
  Layers,
  Trash2,
  Scissors,
  Music,
  Sparkles,
  Volume2,
  Film,
  FolderPlus,
  Image,
  ArrowLeftToLine,
  ListChecks,
} from "@/icons/lucide-compat";
import type { Clip, Track } from "@reelterminal/core";
import {
  captureWorkAssetFromClip,
  captureWorkAssetFromClips,
} from "@reelterminal/core/work-assets/capture";
import { useProjectStore } from "../../../stores/project-store";
import { useTimelineStore } from "../../../stores/timeline-store";
import { useUIStore } from "../../../stores/ui-store";
import { toast } from "../../../stores/notification-store";
import { getTimelineTrackSelection } from "../../../utils/timeline-item-actions";
import {
  markAgentReferenceForSelection,
} from "../../../stores/editor-context-store";
import { agentReferenceKindForTrack, getAgentReferenceTargetForClip } from "../../../stores/agent-reference-targets";
import { useAgentReferenceMenuItem } from "../agent-reference-menu";
import { useProjectMarkerMenuItems } from "../project-marker-menu";

interface ClipContextMenuProps {
  clip: Clip;
  track: Track;
  onClose?: () => void;
}

/**
 * Local fast-path for the menu's disabled state only; the authoritative
 * prechecks run again inside `captureWorkAssetFromClip` at commit time.
 * Engine-generated overlay clips draw content the engine regenerates, so a
 * snapshot of them could never be replayed as a reusable asset.
 */
function isEngineGeneratedMediaId(mediaId: string): boolean {
  return (
    mediaId.startsWith("text-") ||
    mediaId.startsWith("shape-") ||
    mediaId.startsWith("svg-") ||
    mediaId.startsWith("sticker-") ||
    mediaId.startsWith("motion-")
  );
}

/**
 * Localized copy for the parameters capture deliberately leaves out. Unknown
 * fields fall back to the raw reason recorded by the capture function.
 */
const UNSUPPORTED_REASON_KEYS: Record<string, string> = {
  "stabilization.analyzed": "workAssets.unsupportedReasons.recomputed",
  "stabilization.analysisVersion": "workAssets.unsupportedReasons.recomputed",
  "stabilization.profile": "workAssets.unsupportedReasons.recomputed",
  metadata: "workAssets.unsupportedReasons.instanceLocal",
};

export function useClipContextMenuItems({
  clip,
  track,
  onClose,
}: ClipContextMenuProps): ContextMenuOption[] {
  const { t } = useTranslation();
  const {
    copyClips,
    duplicateClip,
    removeClip,
    rippleDeleteClip,
    splitClip,
    separateAudio,
    getMediaItem,
    copyEffects,
    pasteEffects,
    copiedEffects,
    closeGapBeforeClip,
  } = useProjectStore();
  const { playheadPosition } = useTimelineStore();
  const selectMultiple = useUIStore((state) => state.selectMultiple);
  const project = useProjectStore((state) => state.project);
  const selectedItems = useUIStore((state) => state.selectedItems);

  /**
   * Multi-clip capture branch: with ≥2 clips selected (and the right-clicked
   * clip inside that selection) the save entry switches to the multi form.
   * The same core prechecks run HERE — before capture — so unsupported
   * selections are disabled with a reason instead of being silently dropped
   * at commit time.
   */
  const selectedClipIds = React.useMemo(
    () =>
      selectedItems
        .filter(
          (item) =>
            item.type === "clip" ||
            item.type === "text-clip" ||
            item.type === "shape-clip",
        )
        .map((item) => item.id),
    [selectedItems],
  );
  const isMultiCapture =
    selectedClipIds.length >= 2 && selectedClipIds.includes(clip.id);
  const multiCapturePreview = React.useMemo(() => {
    if (!isMultiCapture) return null;
    return captureWorkAssetFromClips(project, selectedClipIds);
  }, [isMultiCapture, project, selectedClipIds]);
  const canCaptureMulti = multiCapturePreview?.ok === true;

  const isPlayheadOnClip =
    playheadPosition >= clip.startTime &&
    playheadPosition <= clip.startTime + clip.duration;

  const hasGapBeforeClip = React.useMemo(() => {
    const sorted = [...track.clips].sort((a, b) => a.startTime - b.startTime);
    const idx = sorted.findIndex((c) => c.id === clip.id);
    if (idx < 0) return false;
    const prev = idx > 0 ? sorted[idx - 1] : null;
    const target = prev ? prev.startTime + prev.duration : 0;
    return clip.startTime - target > 0.0001;
  }, [track.clips, clip.id, clip.startTime]);

  const mediaItem = getMediaItem(clip.mediaId);
  const reviewMarkerMenuItems = useProjectMarkerMenuItems({
    kind: "clip",
    clipId: clip.id,
  });
  const isVideo = track.type === "video";
  const isAudio = track.type === "audio";
  const isImage = track.type === "image";
  const isVideoWithAudio =
    isVideo &&
    mediaItem?.type === "video" &&
    mediaItem?.metadata?.channels &&
    mediaItem.metadata.channels > 0;

  const hasEffects = clip.effects && clip.effects.length > 0;
  const hasCopiedEffects = copiedEffects && copiedEffects.length > 0;

  const handleCopy = () => {
    copyClips([clip.id]);
    onClose?.();
  };

  const handleDuplicate = async () => {
    await duplicateClip(clip.id);
    onClose?.();
  };

  const handleSelectTrackClips = () => {
    const project = useProjectStore.getState().project;
    selectMultiple(getTimelineTrackSelection(project, track.id));
    onClose?.();
  };

  const handleDelete = async () => {
    await removeClip(clip.id);
    onClose?.();
  };

  const handleRippleDelete = async () => {
    await rippleDeleteClip(clip.id);
    onClose?.();
  };

  const handleSplit = async () => {
    if (isPlayheadOnClip) {
      await splitClip(clip.id, playheadPosition);
    }
    onClose?.();
  };

  const handleCloseGap = async () => {
    await closeGapBeforeClip(clip.id);
    onClose?.();
  };

  const handleSeparateAudio = async () => {
    await separateAudio(clip.id);
    onClose?.();
  };

  const handleAddAgentReference = () => {
    const target = getAgentReferenceTargetForClip(project, clip, track);
    if (!target) return;
    markAgentReferenceForSelection(target);
    onClose?.();
  };

  const agentReferenceMenuItem = useAgentReferenceMenuItem(
    agentReferenceKindForTrack(track.type), clip.id, handleAddAgentReference, onClose,
  );

  const handleCopyEffects = () => {
    copyEffects(clip.id);
    onClose?.();
  };

  const handlePasteEffects = async () => {
    await pasteEffects(clip.id);
    onClose?.();
  };

  const canCaptureWorkAsset =
    mediaItem !== undefined &&
    mediaItem.isPlaceholder !== true &&
    !isEngineGeneratedMediaId(clip.mediaId);

  const workAssetDisabledReason = !canCaptureWorkAsset
    ? t("workAssets.captureDisabled")
    : undefined;

  const handleSaveToWorkAsset = async () => {
    onClose?.();
    // Read the LIVE selection at click time — never the render-time snapshot.
    // The menu can stay open across selection changes (e.g. a right-click
    // driven reselect reported from GUI testing), so the capture form is
    // decided by the selection AS IT STANDS when the item is clicked:
    // ≥2 clips (incl. this one) → ONE kind "multi" asset, otherwise the
    // single-clip form. The item's label follows the same subscribed state,
    // so label and action can never disagree.
    const liveClipIds = useUIStore.getState().getSelectedClipIds();
    const multiClipIds =
      liveClipIds.length >= 2 && liveClipIds.includes(clip.id)
        ? liveClipIds
        : null;
    const { project: currentProject, saveClipAsWorkAsset, saveClipsAsWorkAsset } =
      useProjectStore.getState();

    if (multiClipIds) {
      // Preview the capture purely so unsupported parameters can be listed
      // for confirmation BEFORE anything is saved; the save flow re-runs the
      // same core capture at commit time, so the decision is made against the
      // same prechecks that produce the entry.
      const preview = captureWorkAssetFromClips(currentProject, multiClipIds);
      if (!preview.ok) {
        toast.error(t("workAssets.captureFailed"), preview.message);
        return;
      }
      if (preview.asset.unsupportedParams.length > 0) {
        const lines = preview.asset.unsupportedParams.map((param) => {
          const reasonKey = UNSUPPORTED_REASON_KEYS[param.field];
          const reason = reasonKey ? t(reasonKey) : param.reason;
          return `• ${param.field} — ${reason}`;
        });
        const confirmed = window.confirm(
          `${t("workAssets.unsupportedConfirmTitle")}\n\n${t(
            "workAssets.unsupportedConfirmBody",
            { fields: lines.join("\n") },
          )}`,
        );
        if (!confirmed) return;
      }
      const saved = await saveClipsAsWorkAsset(multiClipIds);
      if (saved.ok) {
        toast.success(t("workAssets.saved"), saved.asset.name);
      } else {
        toast.error(t("workAssets.captureFailed"), saved.message);
      }
      return;
    }

    const preview = captureWorkAssetFromClip(currentProject, clip.id);
    if (!preview.ok) {
      toast.error(t("workAssets.captureFailed"), preview.message);
      return;
    }
    if (preview.asset.unsupportedParams.length > 0) {
      const lines = preview.asset.unsupportedParams.map((param) => {
        const reasonKey = UNSUPPORTED_REASON_KEYS[param.field];
        const reason = reasonKey ? t(reasonKey) : param.reason;
        return `• ${param.field} — ${reason}`;
      });
      const confirmed = window.confirm(
        `${t("workAssets.unsupportedConfirmTitle")}\n\n${t(
          "workAssets.unsupportedConfirmBody",
          { fields: lines.join("\n") },
        )}`,
      );
      if (!confirmed) return;
    }
    const saved = await saveClipAsWorkAsset(clip.id);
    if (saved.ok) {
      toast.success(t("workAssets.saved"), saved.asset.name);
    } else {
      toast.error(t("workAssets.captureFailed"), saved.message);
    }
  };

  const getClipTypeLabel = () => {
    if (isVideo) return t("clipContextMenu.videoClip");
    if (isAudio) return t("clipContextMenu.audioClip");
    if (isImage) return t("clipContextMenu.imageClip");
    return t("clipContextMenu.clip");
  };

  const getClipTypeIcon = () => {
    if (isVideo) return <Film size={14} className="text-primary" aria-hidden />;
    if (isAudio) return <Volume2 size={14} className="text-blue-400" aria-hidden />;
    if (isImage) return <Image size={14} className="text-primary" aria-hidden />;
    return null;
  };

  const items: ContextMenuOption[] = [
    {
      type: "section",
      title: getClipTypeLabel(),
      items: [
        {
          label: getClipTypeLabel(),
          icon: getClipTypeIcon() ?? undefined,
          isDisabled: true,
        },
      ],
    },
    { type: "divider" },
    {
      label: t("Copy Clip"),
      icon: <Copy size={14} aria-hidden />,
      onClick: handleCopy,
    },
    {
      label: t("Duplicate"),
      icon: <Layers size={14} aria-hidden />,
      onClick: handleDuplicate,
    },
    {
      label: t("Select All Clips on Track"),
      icon: <ListChecks size={14} aria-hidden />,
      onClick: handleSelectTrackClips,
    },
    agentReferenceMenuItem,
    { label: t("requirementBoard.addFromSelection"), onClick: () => { openBoardForEntities(selectedClipIds.includes(clip.id) ? selectedClipIds : [clip.id]); onClose?.(); } },
    ...reviewMarkerMenuItems,
    {
      label: isMultiCapture
        ? t("workAssets.saveSelectionToWork", {
            count: selectedClipIds.length,
          })
        : t("workAssets.saveToWork"),
      icon: <FolderPlus size={14} aria-hidden />,
      description: isMultiCapture
        ? canCaptureMulti
          ? undefined
          : t("workAssets.captureDisabledMulti")
        : workAssetDisabledReason,
      isDisabled: isMultiCapture ? !canCaptureMulti : !canCaptureWorkAsset,
      onClick: handleSaveToWorkAsset,
    },
    { type: "divider" },
    {
      label: t("Split at Playhead"),
      icon: <Scissors size={14} aria-hidden />,
      isDisabled: !isPlayheadOnClip,
      onClick: handleSplit,
    },
    {
      label: t("Close Gap to Previous"),
      icon: <ArrowLeftToLine size={14} aria-hidden />,
      isDisabled: !hasGapBeforeClip,
      onClick: handleCloseGap,
    },
  ];

  if (isVideo || isImage) {
    items.push({
      type: "section",
      title: t("Effects"),
      items: [
        {
          label: t("Copy Effects"),
          icon: <Sparkles size={14} aria-hidden />,
          isDisabled: !hasEffects,
          onClick: handleCopyEffects,
        },
        {
          label: t("Paste Effects"),
          icon: <Sparkles size={14} aria-hidden />,
          isDisabled: !hasCopiedEffects,
          onClick: handlePasteEffects,
        },
      ],
    });
  }

  if (isVideoWithAudio) {
    items.push({
      label: t("Separate Audio"),
      icon: <Music size={14} aria-hidden />,
      onClick: handleSeparateAudio,
    });
  }

  if (isAudio) {
    items.push({
      type: "section",
      title: t("Audio"),
      items: [
        {
          label: t("Copy Audio Effects"),
          icon: <Volume2 size={14} aria-hidden />,
          isDisabled: !hasEffects,
          onClick: handleCopyEffects,
        },
        {
          label: t("Paste Audio Effects"),
          icon: <Volume2 size={14} aria-hidden />,
          isDisabled: !hasCopiedEffects,
          onClick: handlePasteEffects,
        },
      ],
    });
  }

  items.push(
    { type: "divider" },
    {
      label: t("Ripple Delete"),
      icon: <Trash2 size={14} aria-hidden />,
      onClick: handleRippleDelete,
    },
    {
      label: t("Delete"),
      icon: <Trash2 size={14} aria-hidden />,
      onClick: handleDelete,
    },
  );

  return items;
}

export const ClipContextMenu: React.FC<ClipContextMenuProps> = (props) => {
  useClipContextMenuItems(props);
  return null;
};
