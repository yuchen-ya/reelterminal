import { useTranslation } from "react-i18next";
import type { ToolcraftContextMenuOption as ContextMenuOption } from "@openreel/ui";
import { Flag } from "@/icons/lucide-compat";
import type { ProjectMarkerTarget } from "@openreel/core";
import { useProjectStore } from "../../stores/project-store";
import {
  findMarkersForEntity,
  type ProjectMarkerEntityQuery,
} from "../../stores/project/project-marker-selectors";
import { toast } from "../../stores/notification-store";

function queryForTarget(
  target: ProjectMarkerTarget,
): ProjectMarkerEntityQuery | null {
  switch (target.kind) {
    case "asset":
      return { mediaId: target.mediaId };
    case "clip":
      return { clipId: target.clipId };
    case "text":
      return { textClipId: target.textClipId };
    default:
      return null;
  }
}

/**
 * Context-menu items for persisted project review markers on one entity:
 * "Add review marker" while the entity is unmarked, otherwise one
 * "Remove review marker RN" entry per marker on it. Returns [] for targets
 * that cannot carry entity markers (time ranges).
 */
export function useProjectMarkerMenuItems(
  target: ProjectMarkerTarget | null,
): ContextMenuOption[] {
  const { t } = useTranslation();
  const markers = useProjectStore((state) => state.project.markers);
  const addProjectMarker = useProjectStore((state) => state.addProjectMarker);
  const removeProjectMarker = useProjectStore(
    (state) => state.removeProjectMarker,
  );

  if (!target) return [];
  const query = queryForTarget(target);
  if (!query) return [];

  const entityMarkers = findMarkersForEntity(markers, query);

  const handleAdd = async () => {
    const result = await addProjectMarker(target);
    if (!result.success) {
      toast.error(t("reviewMarkers.addFailed"), result.error?.message);
    }
  };

  if (entityMarkers.length === 0) {
    return [
      {
        label: t("reviewMarkers.add"),
        icon: <Flag size={14} aria-hidden />,
        onClick: () => {
          void handleAdd();
        },
      },
    ];
  }

  return entityMarkers.map((marker) => ({
    label: t("reviewMarkers.remove", { number: marker.number }),
    icon: <Flag size={14} aria-hidden />,
    onClick: () => {
      void removeProjectMarker(marker.number).then((result) => {
        if (!result.success) {
          toast.error(t("reviewMarkers.removeFailed"), result.error?.message);
        }
      });
    },
  }));
}
