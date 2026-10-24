import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ToolcraftDialog, ToolcraftDialogHeader } from "@reelterminal/ui";
import type { ReviewContext, ReviewNode } from "@reelterminal/core/review/types";
import type { ReviewPackagePreview } from "@reelterminal/core/review/archive";
import { inspectReviewPackage, restoreReviewPackage } from "../../../services/review-workspace/package";
import { reviewService } from "../../../services/review-workspace/service";
import { UUID } from "../../../services/review-workspace/guards";
import { wbButton } from "../wb-button";

interface Attempt { requestId: string; revision: number }

export function ReviewRestoreDialog({ target, onClose, onRestored }: { target: ReviewContext["target"]; onClose: () => void; onRestored: (node: ReviewNode) => void }) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<ReviewPackagePreview | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const key = (digest: string) => `reelterminal.review.restore:${target.reviewWorkspaceId}:${digest}`;
  const fail = (problem: unknown) => setError(problem instanceof Error ? problem.message : String(problem));

  const choose = async (files: FileList | null) => {
    if (!files?.length) return;
    const manifest = [...files].find(file => file.name.toLowerCase() === "manifest.json" && file.webkitRelativePath.split("/").length === 2);
    if (!manifest) throw new Error(t("review.restorePackage.missingManifest"));
    const manifestPath = window.reelterminal!.fs.getPathForFile(manifest);
    const separator = Math.max(manifestPath.lastIndexOf("/"), manifestPath.lastIndexOf("\\"));
    if (separator < 1) throw new Error(t("review.restorePackage.missingManifest"));
    const directory = manifestPath.slice(0, separator);
    setBusy(true); setError(null); setPreview(null); setAttempt(null);
    try {
      if (preview) await window.reelterminal!.reviewPackage!.release(preview.packageId);
      const next = await inspectReviewPackage(target, directory, "user");
      const metadata = await reviewService.directory.get(target);
      let pending: unknown;
      const saved = localStorage.getItem(key(next.digest));
      if (saved) {
        try { pending = JSON.parse(saved); }
        catch (problem) { if (!(problem instanceof SyntaxError)) throw problem; }
      }
      const previous = pending as Attempt | undefined;
      setAttempt(previous && UUID.test(previous.requestId) && Number.isSafeInteger(previous.revision) && previous.revision >= 0 ? previous : { requestId: crypto.randomUUID(), revision: metadata.revision });
      setPreview(next);
    } catch (problem) { fail(problem); }
    finally { setBusy(false); }
  };

  const restore = async () => {
    if (!preview || !attempt) return;
    setBusy(true); setError(null);
    localStorage.setItem(key(preview.digest), JSON.stringify(attempt));
    try {
      const result = await restoreReviewPackage({ target, expectedWorkspaceRevision: attempt.revision, requestId: attempt.requestId, packageId: preview.packageId, digest: preview.digest }, "user");
      onRestored(result.node);
    } catch (problem) { fail(problem); }
    finally { setBusy(false); }
  };

  const close = async () => {
    if (busy) return;
    if (preview) await window.reelterminal!.reviewPackage!.release(preview.packageId);
    onClose();
  };

  return (
    <ToolcraftDialog isOpen width={600} purpose="review-restore" onOpenChange={open => { if (!open) void close().catch(fail); }}>
      <ToolcraftDialogHeader title={t("review.restorePackage.title")} onOpenChange={open => { if (!open) void close().catch(fail); }} />
      <div className="space-y-4 p-5 text-xs" data-testid="review-restore-dialog" data-workbench-modal="true" data-workbench-scope="true">
        <p className="leading-relaxed text-fg-2">{t("review.restorePackage.description")}</p>
        <label className="block space-y-2 text-xs text-fg-2">
          {t("review.restorePackage.choose")}
          <input
            type="file"
            multiple
            {...{ webkitdirectory: "" }}
            disabled={busy}
            className="block w-full text-xs"
            data-testid="review-restore-folder-input"
            onChange={event => void choose(event.target.files).catch(fail)}
          />
        </label>
        {busy && <p role="status" className="text-xs text-fg-2">{t("review.restorePackage.busy")}</p>}
        {error && <p role="alert" className="break-all text-xs text-status-error">{error}</p>}
        {preview && (
          <section className="space-y-2 rounded-[6px] border border-border bg-bg-2 p-3 text-xs tabular-nums" data-testid="review-restore-preview">
            <h3 className="font-semibold text-fg">{preview.name}</h3>
            <p className="text-fg-2">{t("review.restorePackage.counts", { items: preview.itemCount, versions: preview.versionCount, steps: preview.stepCount, files: preview.resourceCount })}</p>
            <p className="text-fg-3">{preview.bytes.toLocaleString()} B · {t("review.restorePackage.handoffs", { count: preview.handoffCount })}</p>
            {preview.missingResourceCount > 0 && <p className="text-status-warning">{t("review.restorePackage.missing", { count: preview.missingResourceCount })}</p>}
            {preview.missingVersionCount > 0 && <p className="text-status-warning">{t("review.migration.missingBodies", { count: preview.missingVersionCount })}</p>}
            <p className="text-fg-3">{t("review.restorePackage.history")}</p>
          </section>
        )}
        <div className="flex items-center justify-between gap-2 pt-2 border-t border-border">
          <button type="button" className={wbButton.secondary} disabled={busy} onClick={() => void close().catch(fail)}>
            {t("common.close")}
          </button>
          {preview && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                className={wbButton.secondary}
                disabled={busy}
                onClick={() => void reviewService.directory.get(target).then(metadata => { setAttempt({ requestId: crypto.randomUUID(), revision: metadata.revision }); setError(null); }).catch(fail)}
              >
                {t("review.restorePackage.newAttempt")}
              </button>
              <button
                type="button"
                className={wbButton.primary}
                disabled={busy}
                onClick={() => void restore()}
                data-testid="review-restore-submit"
              >
                {t("review.restorePackage.restore")}
              </button>
            </div>
          )}
        </div>
      </div>
    </ToolcraftDialog>
  );
}
