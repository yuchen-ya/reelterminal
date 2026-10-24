import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ToolcraftDialog, ToolcraftDialogHeader } from "@reelterminal/ui";
import type { ReviewContext } from "@reelterminal/core/review/types";
import type { ReviewBackupPlan } from "@reelterminal/core/review/export";
import { prepareReviewBackup, copyReviewBackup } from "../../../services/review-workspace/backup";
import { wbButton } from "../wb-button";

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

  return (
    <ToolcraftDialog isOpen width={620} purpose="review-backup" onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <ToolcraftDialogHeader title={t("review.backup.title")} onOpenChange={open => { if (!open && !busy) onClose(); }} />
      <div className="space-y-4 p-5 text-xs" data-testid="review-backup-dialog" data-workbench-modal="true" data-workbench-scope="true">
        <p className="leading-relaxed text-fg-2">{t("review.backup.description")}</p>
        <p className="text-fg-3">{t("review.backup.restore")}</p>
        {(busy || plan) && (
          <p role="status" className="font-mono tabular-nums text-fg-2" data-testid="review-backup-progress" data-ready={!!plan}>
            {t(busy === "copy" ? "review.backup.copying" : "review.backup.progress", progress)}
          </p>
        )}
        {error && <p role="alert" className="text-status-error">{error}</p>}
        {destination && <p role="status" className="break-all font-mono text-accent">{destination}</p>}
        <div className="flex items-center justify-between gap-2 pt-2 border-t border-border">
          <button
            type="button"
            className={wbButton.secondary}
            disabled={!!busy && busy !== "prepare"}
            onClick={() => {
              if (busy === "prepare") cancellation.current?.abort();
              else onClose();
            }}
          >
            {t(busy === "prepare" ? "review.cancel" : "common.close")}
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={wbButton.secondary}
              disabled={!!busy}
              onClick={() => void prepare()}
              data-testid="review-backup-prepare"
            >
              {t("review.backup.prepare")}
            </button>
            <button
              type="button"
              className={wbButton.primary}
              disabled={!!busy || !plan}
              onClick={() => void copy()}
              data-testid="review-backup-copy"
            >
              {t("review.backup.copy")}
            </button>
          </div>
        </div>
      </div>
    </ToolcraftDialog>
  );
}
