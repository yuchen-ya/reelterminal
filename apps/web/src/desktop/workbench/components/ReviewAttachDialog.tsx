import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ToolcraftDialog, ToolcraftDialogHeader } from "@reelterminal/ui";
import type { ReviewContext } from "@reelterminal/core/review/types";
import { workspaceManager } from "../../../services/workspace-manager";
import { attachReviewMedia, type ReviewAttachRequest, type ReviewAttachResult } from "../../../services/review-workspace/attach";
import { wbButton } from "../wb-button";

const control = "h-7 rounded-[6px] border border-border bg-bg-2 px-2.5 text-xs text-fg disabled:opacity-40 focus:outline-none focus:border-accent";

export function ReviewAttachDialog({ target, revision, itemId, onClose }: {
  target: ReviewContext["target"]; revision: number; itemId: string; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [options, setOptions] = useState<Array<{ projectId: string; workspaceId: string; name: string }>>([]);
  const [attempt, setAttempt] = useState<ReviewAttachRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReviewAttachResult | null>(null);

  const fail = (problem: unknown) => setError(problem instanceof Error ? problem.message : String(problem));

  useEffect(() => {
    let active = true;
    void workspaceManager.initialize().then(() => {
      const snapshot = workspaceManager.getSnapshot();
      if (active) setOptions(snapshot.workspaces.flatMap(workspace => {
        const project = snapshot.projects.find(project => project.id === workspace.projectId && !project.recycledAt && !project.deletedAt);
        return project ? [{ projectId: project.id, workspaceId: workspace.id, name: `${project.name} / ${workspace.name}` }] : [];
      }));
    }).catch(fail);
    return () => { active = false; };
  }, []);

  const choose = async (workspaceId: string) => {
    setAttempt(null); setResult(null); setError(null);
    const choice = options.find(option => option.workspaceId === workspaceId);
    if (!choice) return;
    setBusy(true);
    try {
      const context = await workspaceManager.getWorkspaceContext(choice);
      setAttempt({ target, expectedNodeRevision: revision, itemId, requestId: crypto.randomUUID(),
        destination: { kind: "video", projectId: choice.projectId, workspaceId, instanceId: context.instanceId }, expectedProjectRevision: context.store.getState().workspaceRevision });
    } catch (problem) { fail(problem); }
    finally { setBusy(false); }
  };

  const attach = async () => {
    if (!attempt) return;
    setBusy(true); setError(null);
    try { setResult(await attachReviewMedia(attempt, "human")); }
    catch (problem) { fail(problem); }
    finally { setBusy(false); }
  };

  return (
    <ToolcraftDialog isOpen width={620} purpose="review-attach" onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <ToolcraftDialogHeader title={t("review.attach.title")} onOpenChange={open => { if (!open && !busy) onClose(); }} />
      <div className="space-y-4 p-5 text-xs" data-testid="review-attach-dialog" data-workbench-modal="true" data-workbench-scope="true">
        <p className="leading-relaxed text-fg-2">{t("review.attach.description")}</p>
        <label className="flex flex-col gap-1.5 text-xs text-fg-2">
          {t("review.attach.destination")}
          <select className={control} value={attempt?.destination.workspaceId ?? ""} disabled={busy} onChange={event => void choose(event.target.value)} data-testid="review-attach-destination">
            <option value="">{t("review.attach.choose")}</option>
            {options.map(option => <option key={option.workspaceId} value={option.workspaceId}>{option.name}</option>)}
          </select>
        </label>
        {!options.length && <p className="text-fg-3">{t("review.attach.noProjects")}</p>}
        {attempt && <p className="break-all font-mono text-[11px] text-fg-3">{attempt.destination.projectId} / {attempt.destination.workspaceId}</p>}
        {error && <p role="alert" className="text-status-error">{error}</p>}
        {result && <p role="status" className="font-medium text-accent" data-testid="review-attach-result" data-media-id={result.mediaId}>{t(result.present ? "review.attach.done" : "review.attach.removed", { version: result.version })}</p>}
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
          <button type="button" className={wbButton.secondary} onClick={onClose} disabled={busy}>
            {t("common.close")}
          </button>
          <button type="button" className={wbButton.primary} disabled={busy || !attempt} onClick={() => void attach()} data-testid="review-attach-submit">
            {t(busy ? "review.attach.importing" : result ? "review.attach.retry" : "review.attach.title")}
          </button>
        </div>
      </div>
    </ToolcraftDialog>
  );
}
