import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ToolcraftDialog, ToolcraftDialogHeader } from "@reelterminal/ui";
import type { ReviewContext } from "@reelterminal/core/review/types";
import type { ReviewPurgePreview } from "../../../services/review-workspace/purge";
import { reviewService } from "../../../services/review-workspace/service";

const control = "rounded-md border border-border bg-bg-2 px-3 py-2 text-sm text-fg disabled:opacity-40";
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
  return <ToolcraftDialog isOpen width={640} purpose="review-purge" onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <ToolcraftDialogHeader title={t("review.purge.title")} onOpenChange={open => { if (!open && !busy) onClose(); }} />
    <div className="space-y-4 p-5 text-sm" data-testid="review-purge-dialog" data-workbench-modal="true">
      <p>{t("review.purge.description")}</p>
      {error && <p role="alert" className="text-status-error">{error}</p>}
      {preview ? <>
        <p className="font-medium">{preview.data.name} · r{preview.data.nodeRevision}</p>
        <p className="text-xs text-fg-2">{t("review.purge.references", { versions: preview.data.retainedReferences.version ?? 0, steps: preview.data.retainedReferences.step ?? 0, handoffs: preview.data.retainedReferences.handoff ?? 0, journal: preview.data.retainedReferences.journal ?? 0 })}</p>
        <ul className="max-h-48 overflow-auto text-xs">{preview.data.resources.map(resource => <li key={resource.id} className="flex gap-2 border-b border-border py-2"><span className="min-w-0 flex-1 break-all">{resource.name}</span><span>{t(resource.shared ? "review.purge.shared" : resource.external ? "review.purge.external" : "review.purge.release")}</span></li>)}</ul>
        <p className="text-xs text-fg-3">{t("review.purge.cleanup", { bytes: preview.data.reclaimableBytes.toLocaleString() })}</p>
        <label className="flex items-start gap-2"><input type="checkbox" disabled={busy} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} data-testid="review-purge-confirm" />{t("review.purge.confirm")}</label>
      </> : <p>{t("review.loading")}</p>}
      <div className="flex flex-wrap justify-end gap-2"><button className={control} disabled={busy} onClick={() => setGeneration(value => value + 1)}>{t("review.purge.refresh")}</button>
        <button className={`${control} text-status-error`} disabled={busy || !preview || !confirmed} onClick={() => void clear()} data-testid="review-purge-submit">{t("review.purge.title")}</button></div>
    </div>
  </ToolcraftDialog>;
}
