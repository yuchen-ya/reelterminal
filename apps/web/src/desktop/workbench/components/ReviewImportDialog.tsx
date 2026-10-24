import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ToolcraftDialog, ToolcraftDialogHeader } from "@reelterminal/ui";
import type { ReviewContext } from "@reelterminal/core/review/types";
import { importReviewFiles, importReviewText, planReviewFiles, type ReviewFileImportPlan } from "../../../services/review-workspace/file-import";
import { useWorkbenchUiStore } from "../../../stores/workbench-ui-store";
import { wbButton } from "../wb-button";

const inputClass = "w-full rounded-[6px] border border-border bg-bg-2 px-2.5 py-1.5 text-xs text-fg focus:border-accent focus:outline-none disabled:opacity-40";

export function ReviewImportDialog({ target, expectedNodeRevision, isOpen, onOpenChange }: {
  target: ReviewContext["target"]; expectedNodeRevision: number; isOpen: boolean; onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"files" | "text">("files");
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [plan, setPlan] = useState<ReviewFileImportPlan | null>(null);
  const [phase, setPhase] = useState<"parsing" | "importing" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const readFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setPhase("parsing"); setError(null); setPlan(null);
    try {
      const next = await planReviewFiles([...files]);
      setPlan(next);
      if (!name.trim()) setName(files.length === 1 ? files[0].name : t("review.localFiles"));
    } catch (problem) { setError(problem instanceof Error ? problem.message : String(problem)); }
    finally { setPhase(null); }
  };

  const submit = async () => {
    setPhase("importing"); setError(null);
    try {
      if (mode === "files") {
        if (!plan) return;
        await importReviewFiles(target, expectedNodeRevision, name.trim(), plan);
        useWorkbenchUiStore.getState().setActiveBatchId(plan.batchId);
        useWorkbenchUiStore.getState().setCursor(plan.batchId, plan.entries[0].item.id);
      } else {
        const result = await importReviewText(target, expectedNodeRevision, name.trim(), text);
        useWorkbenchUiStore.getState().setActiveBatchId(result.batchId);
        useWorkbenchUiStore.getState().setCursor(result.batchId, result.itemId);
      }
      onOpenChange(false);
    } catch (problem) { setError(problem instanceof Error ? problem.message : String(problem)); }
    finally { setPhase(null); }
  };

  return (
    <ToolcraftDialog isOpen={isOpen} onOpenChange={open => { if (!phase) onOpenChange(open); }} width={680} purpose="review-import">
      <ToolcraftDialogHeader title={t("review.importTitle")} subtitle={t("review.importDescription")} onOpenChange={open => { if (!phase) onOpenChange(open); }} />
      <div className="max-h-[70vh] space-y-4 overflow-auto px-5 py-4 text-xs" data-workbench-modal="true" data-workbench-scope="true">
        <div className={wbButton.segmentedContainer}>
          {(["files", "text"] as const).map(value => (
            <button
              key={value}
              type="button"
              disabled={!!phase}
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
              className={wbButton.segmentedItem(mode === value)}
            >
              {t(value === "files" ? "review.files" : "review.pasteText")}
            </button>
          ))}
        </div>
        <label className="block space-y-1 text-xs text-fg-2">
          {t("review.batchName")}
          <input className={inputClass} value={name} maxLength={200} disabled={!!phase} onChange={event => setName(event.target.value)} />
        </label>
        {mode === "files" ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="rounded-[6px] border border-border bg-bg-2 p-3 text-xs text-fg-2">
                {t("review.chooseFiles")}
                <input
                  type="file"
                  multiple
                  disabled={!!phase}
                  className="mt-2 block w-full text-xs"
                  data-testid="review-files-input"
                  accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif,model/gltf-binary,.glb,video/*,.mkv,.avi,.txt,.md,.log,.csv,.json"
                  onChange={event => void readFiles(event.target.files)}
                />
              </label>
              <label className="rounded-[6px] border border-border bg-bg-2 p-3 text-xs text-fg-2">
                {t("review.chooseFolder")}
                <input
                  type="file"
                  multiple
                  {...{ webkitdirectory: "" }}
                  disabled={!!phase}
                  className="mt-2 block w-full text-xs"
                  data-testid="review-folder-input"
                  onChange={event => void readFiles(event.target.files)}
                />
              </label>
            </div>
            <p className="text-xs leading-relaxed text-fg-3">{t("review.fileLimits")}</p>
            {plan && (
              <ul className="max-h-48 space-y-1 overflow-auto rounded-[6px] border border-border bg-bg-2 p-2.5 text-xs text-fg-2 tabular-nums" data-testid="review-import-preview">
                {plan.entries.map(entry => (
                  <li key={entry.item.id} className="break-all">
                    {entry.item.title} · {t(`review.kind.${entry.item.type}`)}
                    {entry.item.content.type === "data" ? ` · ${entry.item.content.rows.length} × ${entry.item.content.columns.length}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <label className="block space-y-1 text-xs text-fg-2">
            {t("review.textBody")}
            <textarea
              value={text}
              maxLength={200_000}
              disabled={!!phase}
              onChange={event => setText(event.target.value)}
              rows={10}
              className={`${inputClass} resize-y font-mono`}
              data-testid="review-paste-text"
            />
          </label>
        )}
        {error && <p role="alert" className="text-xs text-status-error">{error}</p>}
        {phase && <p role="status" className="text-xs text-fg-2">{t(phase === "parsing" ? "review.readingFiles" : "review.importing")}</p>}
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
          <button type="button" disabled={!!phase} onClick={() => onOpenChange(false)} className={wbButton.secondary}>
            {t("review.cancel")}
          </button>
          <button
            type="button"
            disabled={!!phase || !name.trim() || (mode === "files" ? !plan : !text)}
            onClick={() => void submit()}
            className={wbButton.primary}
            data-testid="review-import-submit"
          >
            {t("review.import")}
          </button>
        </div>
      </div>
    </ToolcraftDialog>
  );
}
