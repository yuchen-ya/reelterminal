import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ToolcraftDialog, ToolcraftDialogHeader } from "@reelterminal/ui";
import type { ReviewContext, ReviewStepReference } from "@reelterminal/core/review/types";
import type { ReviewExportStatus } from "@reelterminal/core/review/export";
import { cancelReviewExport, copyReviewExport, prepareReviewExport, reviewExportStatus } from "../../../services/review-workspace/export";
import { wbButton } from "../wb-button";

const control = "h-7 rounded-[6px] border border-border bg-bg-2 px-2.5 text-xs text-fg disabled:opacity-40 focus:outline-none focus:border-accent";

export function ReviewExportDialog({ target, revision, selectedIds, filter, reference, onClose }: {
  target: ReviewContext["target"]; revision: number; selectedIds: readonly string[];
  reference?: ReviewStepReference;
  filter: { batchId?: string; type: "all" | "image" | "text" | "data" | "video" | "model3d"; query: string }; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"original" | "adopted" | "node-package" | "version">(reference ? "version" : "original");
  const [scope, setScope] = useState<"node" | "filtered" | "selected">(reference ? "selected" : "node");
  const [status, setStatus] = useState<ReviewExportStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [handed, setHanded] = useState(false);

  const fail = (problem: unknown) => setError(problem instanceof Error ? problem.message : String(problem));
  const terminal = status && ["ready", "failed", "cancelled"].includes(status.state);

  useEffect(() => {
    if (!status || terminal) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void reviewExportStatus(status.exportId, target.nodeId!).then(next => { if (!cancelled) setStatus(next); }).catch(problem => { if (!cancelled) fail(problem); });
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [status, target.nodeId, terminal]);

  const prepare = async () => {
    setBusy(true); setError(null); setCopied(null); setHanded(false);
    try {
      setStatus(await prepareReviewExport({ target, expectedNodeRevision: revision, exportId: crypto.randomUUID(), mode, scope,
        ...(reference ? { reference } : scope === "selected" ? { itemIds: selectedIds } : scope === "filtered" ? { filter } : {}) }));
    } catch (problem) { fail(problem); }
    finally { setBusy(false); }
  };

  const copy = async () => {
    if (!status || status.state !== "ready") return;
    const directory = await window.reelterminal!.fs.showOpenDialog({ directory: true, filters: [] });
    if (!directory) return;
    setBusy(true); setError(null);
    try { setCopied((await copyReviewExport(status.exportId, target.nodeId!, directory, "user")).directory); }
    catch (problem) { fail(problem); }
    finally { setBusy(false); }
  };

  return (
    <ToolcraftDialog isOpen width={640} purpose="review-export" onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <ToolcraftDialogHeader title={t("review.export.title")} onOpenChange={open => { if (!open && !busy) onClose(); }} />
      <div className="space-y-4 p-5 text-xs" data-testid="review-export-dialog" data-workbench-modal="true" data-workbench-scope="true">
        <p className="leading-relaxed text-fg-2">{t("review.export.description")}</p>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-xs">
            {t("review.export.mode")}
            <select
              className={control}
              disabled={busy || !!status || !!reference}
              value={mode}
              onChange={event => { const next = event.target.value as typeof mode; setMode(next); if (next === "node-package") setScope("node"); }}
              data-testid="review-export-mode"
            >
              {reference && <option value="version">{t("review.export.version")}</option>}
              <option value="original">{t("review.export.original")}</option>
              <option value="adopted">{t("review.export.adopted")}</option>
              <option value="node-package">{t("review.export.package")}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            {t("review.export.scope")}
            <select
              className={control}
              disabled={busy || !!status || mode === "node-package" || !!reference}
              value={scope}
              onChange={event => setScope(event.target.value as typeof scope)}
              data-testid="review-export-scope"
            >
              <option value="node">{t("review.export.node")}</option>
              <option value="filtered">{t("review.export.filtered")}</option>
              <option value="selected" disabled={!reference && !selectedIds.length}>
                {t("review.export.selected", { count: reference ? 1 : selectedIds.length })}
              </option>
            </select>
          </label>
        </div>
        {reference && (
          <p className="break-all font-mono text-xs text-fg-2">
            {t("review.export.exactReference")} · {"itemId" in reference ? `${reference.itemId} · v${reference.version}` : reference.resourceId}
          </p>
        )}
        <p className="text-xs text-fg-3">{t("review.export.serialization")}</p>
        {error && <p role="alert" className="text-xs text-status-error">{error}</p>}
        {status && (
          <div className="space-y-2 rounded-[6px] border border-border bg-bg-2 p-3 text-xs tabular-nums" data-testid="review-export-status" data-state={status.state} data-export-id={status.exportId}>
            <p className="font-medium text-fg">
              {t(`review.export.state.${status.state}`)} · {status.completedFiles} / {status.totalFiles} · r{status.nodeRevision}
            </p>
            {status.error && <p role="alert" className="text-status-error">{status.error.reason}: {status.error.message}</p>}
            {status.manifest && (
              <ul className="max-h-40 overflow-auto space-y-1 font-mono text-[11px] text-fg-2">
                {status.manifest.entries.map(entry => (
                  <li key={entry.itemId ?? entry.resourceId}>
                    {entry.relativePath}{entry.itemVersion !== undefined ? ` · v${entry.itemVersion}` : ""} · {entry.size.toLocaleString()} B
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {handed && <p role="status" className="text-xs text-fg-2">{t("review.export.handed")}</p>}
        {copied && <p role="status" className="break-all font-mono text-xs text-accent">{t("review.export.copied", { directory: copied })}</p>}
        <div className="flex items-center justify-between gap-2 pt-2 border-t border-border">
          <button type="button" className={wbButton.secondary} disabled={busy} onClick={onClose}>
            {t("common.close")}
          </button>
          <div className="flex flex-wrap items-center gap-2">
            {!status && (
              <button type="button" className={wbButton.primary} disabled={busy} onClick={() => void prepare()} data-testid="review-export-prepare">
                {t("review.export.prepare")}
              </button>
            )}
            {status && !terminal && (
              <button type="button" className={wbButton.secondary} onClick={() => void cancelReviewExport(status.exportId, target.nodeId!).then(setStatus).catch(fail)}>
                {t("review.cancel")}
              </button>
            )}
            {terminal && (
              <button type="button" className={wbButton.secondary} disabled={busy} onClick={() => { setStatus(null); setError(null); setCopied(null); setHanded(false); }}>
                {t("review.export.newPlan")}
              </button>
            )}
            {status?.state === "ready" && (
              <>
                <button type="button" className={wbButton.secondary} disabled={busy} onClick={() => void copy().catch(fail)} data-testid="review-export-copy">
                  {t("review.export.copy")}
                </button>
                {[true, false].map(folder => (
                  <button
                    key={String(folder)}
                    type="button"
                    className={`${wbButton.secondary} cursor-grab`}
                    draggable
                    onDragStart={event => {
                      event.preventDefault();
                      setError(null);
                      void window.reelterminal!.reviewExport!.startDrag(status.exportId, folder).then(() => setHanded(true)).catch(fail);
                    }}
                    data-testid={folder ? "review-export-drag-folder" : "review-export-drag-files"}
                  >
                    {t(folder ? "review.export.dragFolder" : "review.export.dragFiles")}
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    </ToolcraftDialog>
  );
}
