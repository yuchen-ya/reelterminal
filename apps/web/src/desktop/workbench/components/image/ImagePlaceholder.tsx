import { useTranslation } from "react-i18next";
import type { JSX } from "react";
import { ImageOff, LoaderCircle, TriangleAlert } from "lucide-react";
import type { ImagePayloadView, WorkbenchMediaRef } from "../../types";

export interface ImagePlaceholderProps {
  readonly payload?: ImagePayloadView;
  readonly originalMedia?: WorkbenchMediaRef;
  readonly imgError: boolean;
  readonly imageError?: string;
  readonly currentItemTitle: string;
}

export function ImagePlaceholder({
  payload,
  originalMedia,
  imgError,
  imageError,
  currentItemTitle,
}: ImagePlaceholderProps): JSX.Element {
  const { t } = useTranslation();
  if (!payload || !originalMedia) {
    return (
      <div className="flex max-w-md flex-col items-center gap-2 rounded-xl border border-border bg-bg-1 px-6 py-8 text-center">
        <ImageOff className="h-6 w-6 text-fg-3" />
        <div className="text-sm text-fg-2">{t("No image data was supplied")}</div>
        <div className="text-xs text-fg-3">{t("This item has no image payload to review")}</div>
      </div>
    );
  }
  if (originalMedia.status === "loading") {
    return (
      <div className="flex max-w-md flex-col items-center gap-2 rounded-xl border border-border bg-bg-1 px-6 py-8 text-center">
        <LoaderCircle className="h-6 w-6 animate-spin text-fg-3" />
        <div className="text-sm text-fg-2">{t("Loading media…")}</div>
        <div className="text-xs text-fg-3">{originalMedia.displayName}</div>
      </div>
    );
  }
  if (originalMedia.status === "error") {
    return (
      <div className="flex max-w-md flex-col items-center gap-2 rounded-xl border border-status-error/40 bg-bg-1 px-6 py-8 text-center">
        <TriangleAlert className="h-6 w-6 text-status-error" />
        <div className="text-sm text-fg-2">{t("Media failed to load")}</div>
        <div className="text-xs text-status-error">{originalMedia.error ?? t("Unknown error")}</div>
      </div>
    );
  }
  if (originalMedia.status === "unavailable") {
    return (
      <div className="flex max-w-md flex-col items-center gap-2 rounded-xl border border-border bg-bg-1 px-6 py-8 text-center">
        <ImageOff className="h-6 w-6 text-fg-3" />
        <div className="text-sm text-fg-2">{t("Media unavailable")}</div>
        <div className="text-xs text-fg-3">
          {originalMedia.error ?? t("The original media file is missing or was discarded")}
        </div>
      </div>
    );
  }
  if (imgError) {
    return (
      <div className="flex max-w-md flex-col items-center gap-2 rounded-xl border border-status-error/40 bg-bg-1 px-6 py-8 text-center">
        <TriangleAlert className="h-6 w-6 text-status-error" />
        <div className="text-sm text-fg-2">{imageError ?? t("Image failed to load")}</div>
        <div className="text-xs text-status-error">{originalMedia.displayName ?? currentItemTitle}</div>
      </div>
    );
  }
  return (
    <div className="flex max-w-md flex-col items-center gap-2 rounded-xl border border-border bg-bg-1 px-6 py-8 text-center">
      <LoaderCircle className="h-6 w-6 animate-spin text-fg-3" />
      <div className="text-sm text-fg-2">{t("Media not ready")}</div>
      <div className="text-xs text-fg-3">{t("The original media is available only for the current item")}</div>
    </div>
  );
}
