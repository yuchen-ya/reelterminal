import type { ToolcraftContextMenuOption } from "@reelterminal/ui";
import { getActiveProjectRuntimeStore } from "../../../stores/project-store";
import { useUIStore } from "../../../stores/ui-store";
import { previewSession } from "../../../services/preview-session";
import { toast } from "../../../stores/notification-store";
import i18n from "../../../i18n";

export function previewCopyMenu(clipId: string): ToolcraftContextMenuOption[] | null {
  const source = getActiveProjectRuntimeStore();
  if (!source.getState().readOnlyPreview) return null;
  const selectedIds = () => {
    const selected = useUIStore.getState().getSelectedClipIds();
    return selected.includes(clipId) ? selected : [clipId];
  };
  const checkSource = () => {
    if (getActiveProjectRuntimeStore() === source) return true;
    toast.error(i18n.t("previewClipboard.failed"), i18n.t("previewClipboard.targetChanged"));
    return false;
  };
  return [
    { label: i18n.t("Copy"), onClick: () => {
      if (checkSource()) source.getState().copyClips(selectedIds());
    } },
    { label: i18n.t("previewClipboard.copyToCurrent"), description: i18n.t("previewClipboard.destination"), onClick: () => {
      if (!checkSource()) return;
      void previewSession.copyToCurrent(selectedIds()).catch((error: unknown) => {
        toast.error(i18n.t("previewClipboard.failed"), error instanceof Error ? error.message : String(error));
      });
    } },
  ];
}
