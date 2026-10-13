import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { previewSession } from "../../services/preview-session";

const phaseKeys = {
  requesting: "previewStageRequesting",
  "reading-snapshot": "previewStageReadingSnapshot",
  "hydrating-media": "previewStageHydratingMedia",
  "restoring-store": "previewStageRestoringStore",
  "loading-fonts": "previewStageLoadingFonts",
  activating: "previewStageActivating",
  "awaiting-first-valid-frame": "previewStageFirstFrame",
  "restoring-context": "previewStageRestoringContext",
} as const;

export function VersionPreviewLoadingStatus({ className = "" }: { className?: string }) {
  const { t } = useTranslation();
  const state = useSyncExternalStore(previewSession.subscribe, previewSession.getSnapshot);
  const [now, setNow] = useState(() => performance.now());
  const loading = state.loading;

  useEffect(() => {
    if (!loading) return;
    setNow(performance.now());
    const timer = setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(timer);
  }, [loading?.generation]);

  if (!loading) return null;
  const elapsedSeconds = Math.max(0, Math.floor((now - loading.startedAt) / 1000));

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="preview-loading-status"
      className={`rounded-md border border-border bg-bg-1/95 p-3 text-xs text-fg shadow-lg ${className}`}
    >
      <p className="font-semibold">
        {t("versioning.previewLoading", { name: loading.label })}
      </p>
      <p data-testid="preview-loading-stage" className="mt-1 text-fg-2">
        {t(`versioning.${phaseKeys[loading.phase]}`)}
      </p>
      <p className="mt-1 text-fg-3">
        {t("versioning.previewElapsed", { seconds: elapsedSeconds })}
      </p>
      {loading.cancellable ? (
        <button
          type="button"
          data-testid="cancel-preview-loading"
          onClick={() => void previewSession.cancelPending()}
          className="mt-2 rounded border border-border px-2 py-1 text-fg-2 hover:bg-hover"
        >
          {t("versioning.previewCancel")}
        </button>
      ) : null}
    </div>
  );
}
