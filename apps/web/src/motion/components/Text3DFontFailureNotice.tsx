import type { JSX } from "react";
import { useSyncExternalStore } from "react";
import { AlertCircle } from "@/icons/lucide-compat";
import { useTranslation } from "react-i18next";
import {
  getText3DFontFailure,
  subscribeText3DFontFailure,
} from "../text3d-font-status";

/**
 * Degradation notice shown inside the 3D stage preview when the remote
 * default Text3D font failed to load (the core renderer silently skips the
 * affected 3D text objects). Styling follows the existing stage overlay
 * pattern used by "Preview render failed" in StageCanvas.
 *
 * Renders nothing while the font is loading or loaded — the success path
 * gains no UI.
 */
export function Text3DFontFailureNotice({
  onRetry,
}: {
  onRetry?: () => void;
}): JSX.Element | null {
  const { t } = useTranslation();
  const failure = useSyncExternalStore(
    subscribeText3DFontFailure,
    getText3DFontFailure,
    getText3DFontFailure,
  );
  if (!failure) return null;

  return (
    <div
      data-testid="text3d-font-failure"
      className="max-w-[260px] rounded-md border border-status-warning/40 bg-bg-elev/95 px-2.5 py-2 text-[11px] font-medium leading-snug text-status-warning shadow-lg"
      role="status"
    >
      <div className="flex items-start gap-2">
        <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden />
        <div>
          <p>{t("motion.text3dFontFailedTitle")}</p>
          <p className="mt-0.5 font-normal opacity-80">
            {t("motion.text3dFontFailedDetail")}
          </p>
          {onRetry && (
            <button
              type="button"
              data-testid="text3d-font-retry"
              onClick={onRetry}
              className="mt-1 underline underline-offset-2 hover:opacity-80"
            >
              {t("motion.text3dFontRetry")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
