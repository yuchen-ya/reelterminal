import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  workspaceManager,
  type RecoveryDraftRecord,
  type WorkspaceTarget,
} from "../../services/workspace-manager";
import { toast } from "../../stores/notification-store";

/**
 * "找回之前的编辑" dialog: lists the protected recovery drafts of the active
 * workspace and restores one back into it on click (docs/VERSION-NODES-UX.md,
 * 从旧版继续编辑 — the durable fallback behind the adopt toast).
 */
export function RecoveryDraftsDialog({ target, onClose }: { target: WorkspaceTarget; onClose: () => void }) {
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState<RecoveryDraftRecord[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    workspaceManager
      .listRecoveryDrafts(target)
      .then((records) => {
        if (active) setDrafts(records);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setDrafts([]);
        toast.error(t("versioning.failed"), error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
    };
  }, [target, t]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const recover = async (draftId: string) => {
    setBusyId(draftId);
    try {
      await workspaceManager.recoverDraft(target, draftId);
      toast.success(t("versioning.restored"));
      onClose();
    } catch (error) {
      toast.error(t("versioning.failed"), error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId(null);
    }
  };

  return createPortal(
    <div className="reelterminal-desktop fixed inset-0 z-[var(--z-modal)] grid place-items-center bg-black/50">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("versioning.recoveryMenu")}
        data-testid="recovery-drafts-dialog"
        className="w-[min(480px,90vw)] rounded-lg border border-border bg-bg-1 p-4 text-sm text-fg shadow-xl"
      >
        <h2 className="mb-3 font-medium">{t("versioning.recoveryMenu")}</h2>
        <div className="max-h-80 overflow-auto">
          {drafts === null ? (
            <p className="py-2 text-xs text-fg-2">{t("common.loading")}</p>
          ) : drafts.length === 0 ? (
            <p className="py-2 text-xs text-fg-2">{t("versioning.noDrafts")}</p>
          ) : (
            drafts.map((draft) => (
              <button
                key={draft.id}
                type="button"
                data-testid="recovery-draft-row"
                disabled={busyId !== null}
                className="mb-2 block w-full rounded border border-border p-2 text-left hover:bg-hover disabled:opacity-50"
                onClick={() => void recover(draft.id)}
              >
                {new Date(draft.createdAt).toLocaleString()} · {t(draft.source === "restore-protection" ? "versioning.protectedEdit" : "versioning.manualDraft")}
              </button>
            ))
          )}
        </div>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            data-testid="recovery-drafts-cancel"
            onClick={onClose}
            className="rounded border border-border px-3 py-1.5 hover:bg-hover"
          >
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
