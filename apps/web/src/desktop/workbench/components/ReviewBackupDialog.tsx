import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ToolcraftDialog, ToolcraftDialogHeader } from "@reelterminal/ui";
import type { ReviewContext } from "@reelterminal/core/review/types";
import type { ReviewBackupPlan } from "@reelterminal/core/review/export";
import { prepareReviewBackup, copyReviewBackup } from "../../../services/review-workspace/backup";

const control = "rounded-md border border-border bg-bg-2 px-3 py-2 text-sm text-fg disabled:opacity-40";
export function ReviewBackupDialog({ target, onClose }: { target: ReviewContext["target"]; onClose: () => void }) {
  const { t } = useTranslation();
  const [plan, setPlan] = useState<ReviewBackupPlan | null>(null);
  const [busy, setBusy] = useState<"prepare" | "copy" | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [destination, setDestination] = useState<string | null>(null);
  const cancellation = useRef<AbortController | null>(null);
  const prepare = async () => {
    setBusy("prepare"); setPlan(null); setError(null); setDestination(null);
    cancellation.current = new AbortController();
    try { setPlan(await prepareReviewBackup(target, cancellation.current.signal, (done, total) => setProgress({ done, total }))); }
    catch (problem) { setError(problem instanceof Error ? problem.message : String(problem)); }
    finally { cancellation.current = null; setBusy(null); }
  };
  const copy = async () => {
    if (!plan) return;
    setError(null);
    setBusy("copy");
    try {
      const directory = await window.reelterminal!.fs.showOpenDialog({ directory: true, filters: [] });
      if (directory) setDestination((await copyReviewBackup(plan, directory)).directory);
    }
    catch (problem) { setError(problem instanceof Error ? problem.message : String(problem)); }
    finally { setBusy(null); }
  };
  return <ToolcraftDialog isOpen width={620} purpose="review-backup" onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <ToolcraftDialogHeader title={t("review.backup.title")} onOpenChange={open => { if (!open && !busy) onClose(); }} />
    <div className="space-y-4 p-5 text-sm" data-testid="review-backup-dialog" data-workbench-modal="true">
      <p>{t("review.backup.description")}</p>
      <p className="text-xs text-fg-3">{t("review.backup.restore")}</p>
      {(busy || plan) && <p role="status" data-testid="review-backup-progress" data-ready={!!plan}>{t(busy === "copy" ? "review.backup.copying" : "review.backup.progress", progress)}</p>}
      {error && <p role="alert" className="text-status-error">{error}</p>}
      {destination && <p role="status" className="break-all text-accent">{destination}</p>}
      <div className="flex flex-wrap gap-2"><button className={control} disabled={!!busy} onClick={() => void prepare()} data-testid="review-backup-prepare">{t("review.backup.prepare")}</button>
        <button className={control} disabled={!!busy || !plan} onClick={() => void copy()} data-testid="review-backup-copy">{t("review.backup.copy")}</button>
        {busy === "prepare" && <button className={control} onClick={() => cancellation.current?.abort()}>{t("review.cancel")}</button>}
      </div>
    </div>
  </ToolcraftDialog>;
}
