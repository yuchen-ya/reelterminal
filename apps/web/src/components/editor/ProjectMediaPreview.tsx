import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { mediaDisplayName, type MediaItem } from "@reelterminal/core";
import { ToolcraftDialog, ToolcraftDialogHeader, ToolcraftLayout, ToolcraftLayoutContent } from "@reelterminal/ui";
import { loadMediaBlob } from "../../services/media-storage";

export function ProjectMediaPreview({ item, projectId, onClose, onAdd }: {
  item: MediaItem;
  projectId: string;
  onClose: () => void;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let url: string | undefined;
    const load = async () => {
      const blob = item.blob ?? await loadMediaBlob(item.id, projectId);
      if (!active) return;
      if (!blob) {
        setError(t("material.fileMissing"));
        return;
      }
      url = URL.createObjectURL(blob);
      setSource(url);
    };
    void load().catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [item, projectId, t]);
  return (
    <ToolcraftDialog isOpen onOpenChange={(open) => { if (!open) onClose(); }} width={640}>
      <ToolcraftLayout
        header={
          <ToolcraftDialogHeader
            title={mediaDisplayName(item)}
            subtitle={t("projectAssets.previewSource")}
            closeLabel={t("common.close")}
            onOpenChange={onClose}
          />
        }
      >
        <ToolcraftLayoutContent>
          {error ? <p role="alert" className="text-xs text-status-warning">{error}</p> : !source ?
            <p className="text-xs text-fg-muted">{t("material.loadingPreview")}</p> : item.type === "image" ?
            <img src={source} alt={mediaDisplayName(item)} className="max-h-80 w-full object-contain" /> : item.type === "audio" ?
            <audio src={source} controls className="w-full" /> :
            <video src={source} controls className="max-h-80 w-full bg-black" />}
          <button type="button" disabled={!source} onClick={onAdd}
            className="asset-browser-button asset-browser-button-primary mt-3">{t("Add to timeline")}</button>
        </ToolcraftLayoutContent>
      </ToolcraftLayout>
    </ToolcraftDialog>
  );
}
