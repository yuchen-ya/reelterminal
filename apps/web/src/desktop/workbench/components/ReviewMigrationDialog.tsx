import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ToolcraftDialog, ToolcraftDialogHeader } from "@reelterminal/ui";
import type { ReviewContext } from "@reelterminal/core/review/types";
import { workspaceManager } from "../../../services/workspace-manager";
import { previewReviewMigration, migrateReviewProject, ReviewMigrationSavePending, type ReviewMigrationPreview } from "../../../services/review-workspace/migration";
import { wbButton } from "../wb-button";

const control = "h-7 rounded-[6px] border border-border bg-bg-2 px-2.5 text-xs text-fg disabled:opacity-40 focus:outline-none focus:border-accent";

export function ReviewMigrationDialog({ target, onClose, onOpenNode }: { target: ReviewContext["target"]; onClose: () => void; onOpenNode: (nodeId: string) => void }) {
  const { t } = useTranslation();
  const [options, setOptions] = useState<Array<{ projectId: string; workspaceId: string; name: string }>>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [preview, setPreview] = useState<ReviewMigrationPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [resultNodeId, setResultNodeId] = useState<string | null>(null);

  const fail = (problem: unknown) => setError(problem instanceof Error ? problem.message : String(problem));

  useEffect(() => {
    let cancelled = false;
    void workspaceManager.initialize().then(() => {
      const snapshot = workspaceManager.getSnapshot();
      if (!cancelled) setOptions(snapshot.workspaces.flatMap(workspace => {
        const project = snapshot.projects.find(project => project.id === workspace.projectId && !project.recycledAt && !project.deletedAt);
        return project ? [{ projectId: project.id, workspaceId: workspace.id, name: `${project.name} / ${workspace.name}` }] : [];
      }));
    }).catch(fail);
    return () => { cancelled = true; };
  }, []);

  const inspect = async () => {
    const source = options.find(option => option.workspaceId === workspaceId);
    if (!source) return;
    setBusy(true); setError(null); setPreview(null); setConfirmed(false); setResultNodeId(null);
    try { setPreview(await previewReviewMigration(target, source)); }
    catch (problem) { fail(problem); }
    finally { setBusy(false); }
  };

  const migrate = async () => {
    if (!preview || !confirmed) return;
    setBusy(true); setError(null);
    try {
      const record = await migrateReviewProject(preview, (done, total) => setProgress({ done, total }));
      setResultNodeId(record.nodeId);
    } catch (problem) {
      if (problem instanceof ReviewMigrationSavePending) setResultNodeId(problem.record.nodeId);
      fail(problem);
    } finally { setBusy(false); }
  };

  return (
    <ToolcraftDialog isOpen width={680} purpose="review-migration" onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <ToolcraftDialogHeader title={t("review.migration.title")} onOpenChange={open => { if (!open && !busy) onClose(); }} />
      <div className="max-h-[70vh] space-y-4 overflow-auto p-5 text-xs" data-testid="review-migration-dialog" data-workbench-modal="true" data-workbench-scope="true">
        <p className="leading-relaxed text-fg-2">{t("review.migration.description")}</p>
        <div className="flex items-end gap-2">
          <label className="flex-1 flex flex-col gap-1 text-xs text-fg-2">
            {t("review.migration.source")}
            <select
              className={control}
              value={workspaceId}
              disabled={busy}
              onChange={event => { setWorkspaceId(event.target.value); setPreview(null); setConfirmed(false); setResultNodeId(null); }}
              data-testid="review-migration-source"
            >
              <option value="">{t("review.migration.choose")}</option>
              {options.map(option => <option key={option.workspaceId} value={option.workspaceId}>{option.name}</option>)}
            </select>
          </label>
          <button
            type="button"
            className={wbButton.secondary}
            disabled={busy || !workspaceId}
            onClick={() => void inspect()}
            data-testid="review-migration-inspect"
          >
            {t("review.migration.inspect")}
          </button>
        </div>
        {error && <p role="alert" className="break-all text-xs text-status-error">{error}</p>}
        {preview && (
          <section className="space-y-3 rounded-[6px] border border-border bg-bg-2 p-3 tabular-nums" data-testid="review-migration-preview">
            <h3 className="font-semibold text-fg">{preview.name}</h3>
            <p className="text-fg-2">{t("review.migration.counts", { batches: preview.state.batches.length, items: preview.state.items.length, handoffs: preview.state.handoffs.length, files: preview.media.length })}</p>
            <p className="break-all font-mono text-[11px] text-fg-3">{preview.source.projectId} / {preview.source.workspaceId} · r{preview.sourceRevision} · {preview.sourceDigest.slice(0, 12)}</p>
            {preview.media.some(file => file.unavailableReason) && (
              <ul className="max-h-32 overflow-auto space-y-1 text-[11px] text-status-warning">
                {preview.media.filter(file => file.unavailableReason).map(file => <li key={file.oldId}>{file.name} · {file.unavailableReason}</li>)}
              </ul>
            )}
            {preview.missingVersionCount > 0 && <p className="text-[11px] text-status-warning">{t("review.migration.missingBodies", { count: preview.missingVersionCount })}</p>}
            {preview.prior ? <p className="text-accent">{t("review.migration.already")}</p> : preview.latest ? <p className="text-status-warning">{t("review.migration.changed")}</p> : null}
            <p className="text-[11px] text-fg-3">{t("review.migration.boundary")}</p>
            <label className="flex items-start gap-2 pt-1 text-fg cursor-pointer select-none">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={busy}
                onChange={event => setConfirmed(event.target.checked)}
                data-testid="review-migration-confirm"
                className="mt-0.5 accent-accent"
              />
              {t("review.migration.confirm")}
            </label>
          </section>
        )}
        {busy && <p role="status" className="font-mono tabular-nums text-fg-2">{t("review.migration.progress", progress)}</p>}
        {resultNodeId && (
          <div className="space-y-2 rounded-[6px] border border-border bg-bg-2 p-3" data-testid="review-migration-result" data-node-id={resultNodeId}>
            <p className="text-fg font-medium">{t(error ? "review.migration.reviewCommitted" : "review.migration.done")}</p>
            <button type="button" className={wbButton.primary} disabled={busy} onClick={() => onOpenNode(resultNodeId)}>
              {t("review.migration.openNode")}
            </button>
          </div>
        )}
        <div className="flex items-center justify-between gap-2 pt-2 border-t border-border">
          <button type="button" className={wbButton.secondary} disabled={busy} onClick={onClose}>
            {t("common.close")}
          </button>
          {preview && (
            <button
              type="button"
              className={wbButton.primary}
              disabled={busy || !confirmed}
              onClick={() => void migrate()}
              data-testid="review-migration-submit"
            >
              {t(preview.prior ? "review.migration.finish" : preview.latest ? "review.migration.append" : "review.migration.migrate")}
            </button>
          )}
        </div>
      </div>
    </ToolcraftDialog>
  );
}
