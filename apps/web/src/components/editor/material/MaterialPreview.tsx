/**
 * Inline preview for one material record: media players (video/audio/image),
 * segment range playback clamped to the stored in/out, link opening, and
 * copyable method text. Bytes load only when this component mounts — never
 * during list/paging.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, ExternalLink, Film, ImageIcon, Link2, Music } from "lucide-react";
import type { MaterialRecord } from "@reelterminal/core";
import { loadMaterialPreview, type PreviewSource } from "../../../services/material-library/preview";
import { toast } from "../../../stores/notification-store";

interface MaterialPreviewProps {
  readonly record: MaterialRecord;
  readonly compact?: boolean;
}

export function MaterialPreview({ record, compact }: MaterialPreviewProps) {
  const { t } = useTranslation();
  const [source, setSource] = useState<PreviewSource | null>(null);
  const [copied, setCopied] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    setSource(null);
    void loadMaterialPreview(record).then((resolved) => {
      if (cancelled) {
        if (resolved.kind === "url") resolved.cleanup();
        return;
      }
      if (resolved.kind === "url") cleanup = resolved.cleanup;
      setSource(resolved);
    });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [record]);

  const segment = record.kind === "segment" ? record : null;

  const clampSegmentPlayback = () => {
    if (!segment || !videoRef.current) return;
    const element = videoRef.current;
    if (element.currentTime < segment.startSec - 0.05) {
      element.currentTime = segment.startSec;
    }
    if (element.currentTime > segment.endSec) {
      element.currentTime = segment.startSec;
    }
  };

  if (!source) {
    return (
      <div className="flex h-32 items-center justify-center text-[12px] text-fg-3">
        {t("material.loadingPreview")}
      </div>
    );
  }

  if (source.kind === "unavailable") {
    return (
      <div className="flex h-32 flex-col items-center justify-center gap-2 px-4 text-center text-[12px] text-status-warning">
        <Film size={22} aria-hidden />
        <span>{source.reason}</span>
      </div>
    );
  }

  if (source.kind === "link") {
    return (
      <div className="flex h-32 flex-col items-center justify-center gap-2 text-[12px] text-fg-2">
        <Link2 size={22} aria-hidden />
        <span className="max-w-full truncate text-fg-3">{source.url}</span>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-[9px] border border-border bg-bg px-3 py-1.5 text-[12px] font-medium text-fg-2 hover:border-border-strong"
          onClick={() => window.open(source.url, "_blank", "noopener,noreferrer")}
        >
          <ExternalLink size={13} aria-hidden />
          {t("material.openLink")}
        </button>
      </div>
    );
  }

  if (source.kind === "text") {
    return (
      <div className="flex flex-col gap-2">
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-[9px] border border-border bg-bg p-3 text-[12px] leading-relaxed text-fg-2">
          {source.value}
        </pre>
        <button
          type="button"
          className="flex w-fit items-center gap-1.5 rounded-[9px] border border-border bg-bg px-3 py-1.5 text-[12px] font-medium text-fg-2 hover:border-border-strong"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(source.value);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            } catch {
              toast.error(t("material.copyFailed"), t("material.copyFailedDetail"));
            }
          }}
        >
          {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
          {copied ? t("material.copied") : t("material.copyMethod")}
        </button>
      </div>
    );
  }

  const mediaType =
    record.kind === "media"
      ? record.mediaType
      : record.kind === "segment"
        ? null
        : null;

  if (mediaType === "image") {
    return (
      <img
        src={source.url}
        alt={record.title}
        className={`w-full rounded-[9px] border border-border object-contain ${compact ? "max-h-32" : "max-h-64"}`}
      />
    );
  }

  if (mediaType === "audio") {
    return <audio src={source.url} controls className="w-full" />;
  }

  // Video (direct or segment parent).
  return (
    <div className="flex flex-col gap-1.5">
      <video
        ref={videoRef}
        src={source.url}
        controls
        className={`w-full rounded-[9px] border border-border bg-black ${compact ? "max-h-40" : "max-h-72"}`}
        onLoadedMetadata={() => {
          if (segment && videoRef.current) {
            videoRef.current.currentTime = segment.startSec;
          }
        }}
        onTimeUpdate={clampSegmentPlayback}
      />
      {segment ? (
        <div className="flex items-center gap-2 text-[11px] text-fg-3">
          <Film size={12} aria-hidden />
          {t("material.segmentRange", {
            start: segment.startSec.toFixed(2),
            end: segment.endSec.toFixed(2),
          })}
        </div>
      ) : null}
      {!segment && record.kind === "media" && record.mediaType === "audio" ? (
        <Music size={14} aria-hidden className="text-fg-3" />
      ) : null}
      {record.kind === "media" && record.mediaType === "image" ? (
        <ImageIcon size={14} aria-hidden className="text-fg-3" />
      ) : null}
    </div>
  );
}
