import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { previewSession } from "../../services/preview-session";

/**
 * Local, unambiguous state strip shown while a historical version is being
 * previewed read-only: "正在预览「初剪」 · 返回当前编辑 · 从这里继续编辑".
 * Rendered above the timeline only while the preview session is active.
 */
export function VersionPreviewBanner() {
  const { t } = useTranslation();
  const state = useSyncExternalStore(previewSession.subscribe, previewSession.getSnapshot);
  const [busy, setBusy] = useState(false);
  if (!state.active || !state.info) return null;
  const info = state.info;
  const missing = info.missingDependencies;
  const missingTitle = missing.length > 0
    ? `${t("versioning.previewMissing", { count: missing.length })}\n${t("versioning.previewMissingList")}: ${missing.join(", ")}`
    : undefined;

  const handleReturn = () => {
    if (busy || state.busy) return;
    setBusy(true);
    void previewSession.exit().finally(() => setBusy(false));
  };

  const handleAdopt = () => {
    if (busy || state.busy) return;
    setBusy(true);
    void previewSession.adopt().finally(() => setBusy(false));
  };

  return (
    <div
      data-testid="version-preview-banner"
      className="flex h-8 shrink-0 items-center gap-3 border-b border-border bg-bg-1 px-3 text-xs"
    >
      <span
        className="truncate font-medium text-accent"
        title={missingTitle}
      >
        {t("versioning.previewBanner", { name: info.nodeName })}
        {missing.length > 0 && (
          <span className="ml-2 font-normal text-fg-2">
            {t("versioning.previewMissing", { count: missing.length })}
          </span>
        )}
        {info.agentTrial && (
          <span className="ml-2 font-normal text-fg-2">{t("versioning.agentTrial")}</span>
        )}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          data-testid="version-preview-adopt"
          onClick={handleAdopt}
          disabled={busy || state.busy}
          className="rounded-md border border-accent/40 bg-accent-soft px-2 py-1 text-accent transition-colors duration-200 ease-out hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none"
        >
          {t("versioning.previewAdopt")}
        </button>
        <button
          type="button"
          data-testid="version-preview-return"
          onClick={handleReturn}
          disabled={busy || state.busy}
          className="rounded-md px-2 py-1 text-fg-2 transition-colors duration-200 ease-out hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none"
        >
          {t("versioning.previewReturn")}
        </button>
      </div>
    </div>
  );
}
