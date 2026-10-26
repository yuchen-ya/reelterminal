import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Template } from "@reelterminal/core";
import { ToolcraftDialog, ToolcraftDialogHeader, ToolcraftLayout, ToolcraftLayoutContent, ToolcraftLayoutFooter } from "@reelterminal/ui";
import { getActiveProjectRuntimeStore } from "../../stores/project-store";
import { saveProjectTemplate, updateProjectTemplate } from "../../services/project-templates";

interface SaveTemplateDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved?: () => void;
  template?: Template;
}

export function SaveTemplateDialog({ isOpen, onClose, onSaved, template }: SaveTemplateDialogProps) {
  const { t } = useTranslation();
  const [sourceStore] = useState(getActiveProjectRuntimeStore);
  const [name, setName] = useState(template?.name ?? sourceStore.getState().project.name);
  const [description, setDescription] = useState(template?.description ?? "");
  const [tags, setTags] = useState(template?.tags.join(", ") ?? "");
  const [thumbnailUrl, setThumbnailUrl] = useState(template?.thumbnailUrl?.startsWith("data:image/") ? template.thumbnailUrl : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!isOpen) return null;

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const details = { name, description, tags: tags.split(/[,，]/), thumbnailUrl };
      if (template) await updateProjectTemplate(template.id, details);
      else await saveProjectTemplate(sourceStore.getState().getFullProject(), details);
      onSaved?.();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const close = () => { if (!busy) onClose(); };
  const chooseCover = (file: File | undefined) => {
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 2 * 1024 * 1024) {
      setError(t("personalTemplates.invalidCover"));
      return;
    }
    setBusy(true);
    const reader = new FileReader();
    reader.onload = () => { setThumbnailUrl(String(reader.result)); setError(null); setBusy(false); };
    reader.onerror = () => { setError(t("personalTemplates.invalidCover")); setBusy(false); };
    reader.readAsDataURL(file);
  };
  const inputClass = "w-full mt-1 rounded-lg border border-border bg-background-secondary px-3 py-2 text-sm text-text-primary";
  return <ToolcraftDialog isOpen onOpenChange={(open) => { if (!open) close(); }} width={512} purpose="form">
    <form onSubmit={(event) => void save(event)}>
      <ToolcraftLayout header={<ToolcraftDialogHeader title={t(template ? "personalTemplates.edit" : "personalTemplates.saveCurrent")}
        closeLabel={t("Close dialog")} onOpenChange={(open) => { if (!open) close(); }} />}
        content={<ToolcraftLayoutContent className="space-y-4">
          {!template && <p className="text-xs leading-5 text-text-muted">{t("personalTemplates.saveNotice", { name: sourceStore.getState().project.name })}</p>}
          {error && <p role="alert" className="text-sm text-status-error">{error}</p>}
          <label className="block text-xs">{t("personalTemplates.name")}<input autoFocus required maxLength={100} value={name}
            onChange={(event) => setName(event.target.value)} className={inputClass} /></label>
          <label className="block text-xs">{t("personalTemplates.description")}<textarea rows={3} value={description}
            onChange={(event) => setDescription(event.target.value)} className={inputClass} /></label>
          <label className="block text-xs">{t("personalTemplates.tags")}<input value={tags}
            onChange={(event) => setTags(event.target.value)} className={inputClass} /></label>
          <label className="block text-xs">{t("personalTemplates.cover")}<input type="file" accept="image/png,image/jpeg,image/webp"
            onChange={(event) => chooseCover(event.target.files?.[0])} className="block mt-2 w-full text-xs" /></label>
          {thumbnailUrl?.startsWith("data:image/") && <img src={thumbnailUrl} alt={t("personalTemplates.coverPreview")} className="max-h-36 object-contain rounded-lg" />}
          {thumbnailUrl && <button type="button" className="asset-browser-button" onClick={() => setThumbnailUrl(null)}>{t("personalTemplates.removeCover")}</button>}
        </ToolcraftLayoutContent>}
        footer={<ToolcraftLayoutFooter className="flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={close} className="asset-browser-button">{t("Cancel")}</button>
          <button type="submit" disabled={busy || !name.trim()} className="asset-browser-button bg-primary text-white">
            {t(busy ? "personalTemplates.saving" : "personalTemplates.save")}
          </button>
        </ToolcraftLayoutFooter>} />
    </form>
  </ToolcraftDialog>;
}
