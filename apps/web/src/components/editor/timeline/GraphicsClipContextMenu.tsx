import React from "react";
import { useTranslation } from "react-i18next";
import type { ToolcraftContextMenuOption as ContextMenuOption } from "@reelterminal/ui";
import {
  Layers,
  Trash2,
  Shapes,
  Type,
  ListChecks,
} from "@/icons/lucide-compat";
import type { ShapeClip, SVGClip, StickerClip, TextClip } from "@reelterminal/core";
import { useProjectStore } from "../../../stores/project-store";
import { useUIStore } from "../../../stores/ui-store";
import { getTimelineTrackSelection } from "../../../utils/timeline-item-actions";
import { markAgentReferenceForSelection } from "../../../stores/editor-context-store";
import { getAgentReferenceTargetForGraphic, getAgentReferenceTargetForText } from "../../../stores/agent-reference-targets";
import { useProjectMarkerMenuItems } from "../project-marker-menu";
import { useAgentReferenceMenuItem } from "../agent-reference-menu";

type GraphicsClipType = ShapeClip | SVGClip | StickerClip | TextClip;

interface GraphicsClipContextMenuProps {
  clip: GraphicsClipType;
  clipType: "shape" | "svg" | "sticker" | "emoji" | "text";
  onClose?: () => void;
  onDelete?: () => void;
  onDuplicate?: () => void;
}

export function useGraphicsClipContextMenuItems({
  clip,
  clipType,
  onClose,
  onDelete,
  onDuplicate,
}: GraphicsClipContextMenuProps): ContextMenuOption[] {
  const { t } = useTranslation();
  const {
    deleteShapeClip,
    deleteSVGClip,
    deleteStickerClip,
    deleteTextClip,
  } = useProjectStore();
  const selectMultiple = useUIStore((state) => state.selectMultiple);
  const project = useProjectStore((state) => state.project);
  const isCaption =
    clipType === "text" &&
    (project.timeline.tracks.some(
      (track) =>
        track.id === clip.trackId &&
        track.type === "text" &&
        track.name.trim().toLowerCase() === "captions",
    ) ||
      ("metadata" in clip &&
        typeof clip.metadata?.captionSource === "string"));

  const handleDelete = () => {
    if (onDelete) {
      onDelete();
    } else {
      switch (clipType) {
        case "shape":
          deleteShapeClip(clip.id);
          break;
        case "svg":
          deleteSVGClip(clip.id);
          break;
        case "sticker":
        case "emoji":
          deleteStickerClip(clip.id);
          break;
        case "text":
          deleteTextClip(clip.id);
          break;
      }
    }
    onClose?.();
  };

  const handleDuplicate = () => {
    onDuplicate?.();
    onClose?.();
  };

  const handleSelectTrackClips = () => {
    const project = useProjectStore.getState().project;
    selectMultiple(getTimelineTrackSelection(project, clip.trackId));
    onClose?.();
  };

  const handleAddAgentReference = () => {
    const target =
      clipType === "text"
        ? getAgentReferenceTargetForText(project, clip as TextClip)
        : getAgentReferenceTargetForGraphic(project, clip as ShapeClip | SVGClip | StickerClip);
    markAgentReferenceForSelection(target);
    onClose?.();
  };

  const agentReferenceMenuItem = useAgentReferenceMenuItem(
    clipType === "text" ? "text" : "media", clip.id, handleAddAgentReference, onClose,
  );

  // Review markers: the backend target union can only reference text overlays
  // here (shape/SVG/sticker clips live outside timeline tracks, so a "clip"
  // target for them fails core validation). Their badges still render from the
  // shared selectors if a matching marker ever exists.
  const reviewMarkerMenuItems = useProjectMarkerMenuItems(
    clipType === "text" ? { kind: "text", textClipId: clip.id } : null,
  );

  const getClipTypeLabel = () => {
    switch (clipType) {
      case "shape":
        return "Shape";
      case "svg":
        return "SVG";
      case "sticker":
        return "Sticker";
      case "emoji":
        return "Emoji";
      case "text":
        return "Text";
      default:
        return "Graphics";
    }
  };

  const getClipTypeIcon = () => {
    switch (clipType) {
      case "text":
        return <Type size={14} className="text-amber-400" aria-hidden />;
      default:
        return <Shapes size={14} className="text-green-400" aria-hidden />;
    }
  };

  const items: ContextMenuOption[] = [
    {
      type: "section",
      title: `${getClipTypeLabel()} Clip`,
      items: [
        {
          label: `${getClipTypeLabel()} Clip`,
          icon: getClipTypeIcon(),
          isDisabled: true,
        },
      ],
    },
    { type: "divider" },
  ];

  if (onDuplicate) {
    items.push(
      {
        label: t("Duplicate"),
        icon: <Layers size={14} aria-hidden />,
        onClick: handleDuplicate,
      },
      { type: "divider" },
    );
  }

  items.push(
    {
      label: isCaption ? "Select All Captions" : "Select All Clips on Track",
      icon: <ListChecks size={14} aria-hidden />,
      onClick: handleSelectTrackClips,
    },
    agentReferenceMenuItem,
    ...reviewMarkerMenuItems,
    { type: "divider" },
  );

  items.push({
    label: t("Delete"),
    icon: <Trash2 size={14} aria-hidden />,
    onClick: handleDelete,
  });

  return items;
}

export const GraphicsClipContextMenu: React.FC<GraphicsClipContextMenuProps> = (props) => {
  useGraphicsClipContextMenuItems(props);
  return null;
};
