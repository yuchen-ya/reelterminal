import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ToolcraftDialog, ToolcraftDialogHeader } from "@reelterminal/ui";
import type { ReviewContext } from "@reelterminal/core/review/types";
import type { ReviewPurgePreview } from "../../../services/review-workspace/purge";
import { reviewService } from "../../../services/review-workspace/service";
import { wbButton } from "../wb-button";

export function ReviewPurgeDialog({ target, onClose, onPurged }: { target: ReviewContext["target"]; onClose: () => void; onPurged: () => void }) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<{ data: ReviewPurgePreview; workspaceRevision: number; requestId: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setPreview(null); setConfirmed(false); setError(null);
    void Promise.all([reviewService.purge.preview(target), reviewService.directory.get(target)]).then(([data, directory]) => {
      if (!cancelled) setPreview({ data, workspaceRevision: directory.revision, requestId: crypto.randomUUID() });
    }).catch(problem => { if (!cancelled) setError(problem instanceof Error ? problem.message : String(problem)); });
    return () => { cancelled = true; };
  }, [target, generation]);

  const clear = async () => {
    if (!preview || !confirmed) return;
    setBusy(true); setError(null);
    try {
      await reviewService.purge.clear({ target, expectedNodeRevision: preview.data.nodeRevision, expectedWorkspaceRevision: preview.workspaceRevision,
        requestId: preview.requestId, confirmDeleteHistory: true });
      onPurged();
    } catch (problem) { setError(problem instanceof Error ? problem.message : String(problem)); }
    finally { setBusy(false); }
  };

  return (
    <ToolcraftDialog isOpen width={640} purpose="review-purge" onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <ToolcraftDialogHeader title={t("review.purge.title")} onOpenChange={open => { if (!open && !busy) onClose(); }} />
      <div className="space-y-4 p-5 text-xs" data-testid="review-purge-dialog" data-workbench-modal="true" data-workbench-scope="true">
        <p className="leading-relaxed text-fg-2">{t("review.purge.description")}</p>
        {error && <p role="alert" className="text-status-error">{error}</p>}
        {preview ? (
          <div className="space-y-3 rounded-[6px] border border-border bg-bg-2 p-3 tabular-nums">
            <p className="font-semibold text-fg">{preview.data.name} · r{preview.data.nodeRevision}</p>
            <p className="text-fg-2">{t("review.purge.references", { versions: preview.data.retainedReferences.version ?? 0, steps: preview.data.retainedReferences.step ?? 0, handoffs: preview.data.retainedReferences.handoff ?? 0, journal: preview.data.retainedReferences.journal ?? 0 })}</p>
            <ul className="max-h-48 overflow-auto text-xs divide-y divide-border">
              {preview.data.resources.map(resource => (
                <li key={resource.id} className="flex gap-2 py-1.5 text-fg-2">
                  <span className="min-w-0 flex-1 break-all font-mono text-[11px]">{resource.name}</span>
                  <span className="text-fg-3">{t(resource.shared ? "review.purge.shared" : resource.external ? "review.purge.external" : "review.purge.release")}</span>
                </li>
              ))}
            </ul>
            <p className="text-fg-3">{t("review.purge.cleanup", { bytes: preview.data.reclaimableBytes.toLocaleString() })}</p>
            <label className="flex items-start gap-2 pt-1 text-status-error cursor-pointer select-none">
              <input
                type="checkbox"
                disabled={busy}
                checked={confirmed}
                onChange={event => setConfirmed(event.target.checked)}
                data-testid="review-purge-confirm"
                className="mt-0.5 accent-status-error"
              />
              <span className="text-fg">{t("review.purge.confirm")}</span>
            </label>
          </div>
        ) : (
          <p className="text-fg-3">{t("review.loading")}</p>
        )}
        <div className="flex items-center justify-between gap-2 pt-2 border-t border-border">
          <button type="button" className={wbButton.secondary} disabled={busy} onClick={onClose}>
            {t("review.cancel")}
          </button>
          <div className="flex items-center gap-2">
            <button type="button" className={wbButton.secondary} disabled={busy} onClick={() => setGeneration(value => value + 1)}>
              {t("review.purge.refresh")}
            </button>
            <button
              type="button"
              className={`${wbButton.danger} border border-status-error/40 hover:bg-status-error/15`}
              disabled={busy || !preview || !confirmed}
              onClick={() => void clear()}
              data-testid="review-purge-submit"
            >
              {t("review.purge.title")}
            </button>
          </div>
        </div>
      </div>
    </ToolcraftDialog>
  );
}
