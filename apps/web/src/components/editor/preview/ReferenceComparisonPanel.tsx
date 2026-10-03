import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  mapTimelineToReference,
  type ReferenceComparisonConfig,
} from "@reelterminal/core/types/reference-comparison";
import type { Action } from "@reelterminal/core/types/actions";
import { useProjectStore } from "../../../stores/project-store";
import { useTimelineStore } from "../../../stores/timeline-store";
import { useTranslation } from "react-i18next";
import { Columns2 } from "@/icons/lucide-compat";
import { ToolcraftPopover } from "@reelterminal/ui";

interface MediaItemLike {
  readonly id: string;
  readonly name?: string;
  readonly type?: string;
  readonly blob?: Blob | null;
  readonly originalUrl?: string;
  readonly metadata: { readonly duration: number };
}

export function resolveReferenceMediaUrl(
  item: Pick<MediaItemLike, "blob" | "originalUrl"> | undefined,
  createObjectUrl: (blob: Blob) => string = (blob) => URL.createObjectURL(blob),
): { readonly url: string | null; readonly revoke: boolean } {
  if (item?.blob) return { url: createObjectUrl(item.blob), revoke: true };
  if (item?.originalUrl) return { url: item.originalUrl, revoke: false };
  return { url: null, revoke: false };
}

function setComparisonAction(config: ReferenceComparisonConfig): Action {
  return {
    type: "reference/setComparison",
    id: `reference-set-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    params: { config },
  };
}

function clearComparisonAction(): Action {
  return {
    type: "reference/clearComparison",
    id: `reference-clear-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    params: {},
  };
}

function selectComparisonAction(
  media: MediaItemLike,
  playheadPosition: number,
  layout: ReferenceComparisonConfig["layout"] = "side-by-side",
): Action {
  return setComparisonAction({
    referenceMediaId: media.id,
    refStartSec: 0,
    refEndSec: media.metadata.duration,
    timelineStartSec: playheadPosition,
    rate: 1,
    audioSide: "timeline",
    layout,
  });
}

/** Optional comparison entry in the player toolbar, away from the picture. */
export function ReferenceComparisonControl() {
  const { t } = useTranslation();
  const project = useProjectStore((state) => state.project);
  const executeAction = useProjectStore((state) => state.executeAction);
  const playheadPosition = useTimelineStore((state) => state.playheadPosition);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const config = project.referenceComparison;
  const videoItems = project.mediaLibrary.items.filter(
    (item) => item.type === "video" && item.metadata.duration > 0,
  );

  const apply = async (action: Action) => {
    const result = await executeAction(action);
    setError(result.success ? null : result.error?.message ?? t("Could not configure comparison."));
    if (result.success) setOpen(false);
  };

  return (
    <ToolcraftPopover
      placement="above"
      alignment="end"
      label={t("Reference comparison")}
      isOpen={open}
      onOpenChange={setOpen}
      content={
        <div className="w-64 space-y-3 bg-bg-elev p-3 text-xs text-fg">
          <label className="block space-y-2">
            <span className="font-medium">{t("Reference comparison")}</span>
            <select
              aria-label={t("Choose reference video")}
              value={config?.referenceMediaId ?? ""}
              disabled={videoItems.length === 0}
              className="h-8 w-full rounded-md border border-border bg-bg-2 px-2 text-fg outline-none focus:border-accent"
              onChange={(event) => {
                const media = videoItems.find((item) => item.id === event.target.value);
                if (media) {
                  void apply(selectComparisonAction(media, playheadPosition, config?.layout));
                }
              }}
            >
              <option value="" disabled>{t("Choose reference video")}</option>
              {videoItems.map((item) => (
                <option key={item.id} value={item.id}>{item.name ?? item.id}</option>
              ))}
            </select>
          </label>
          {videoItems.length === 0 && (
            <p className="text-fg-muted">{t("Add a video to the media library to compare it.")}</p>
          )}
          {config && (
            <button
              type="button"
              className="h-8 w-full rounded-md border border-border bg-bg-2 hover:bg-hover"
              onClick={() => void apply(clearComparisonAction())}
            >
              {t("Close reference comparison")}
            </button>
          )}
          {error && <p role="alert" className="text-red-400">{error}</p>}
        </div>
      }
    >
      <button
        type="button"
        title={t("Reference comparison")}
        aria-label={t("Reference comparison")}
        className={`flex h-[34px] shrink-0 items-center gap-1.5 rounded-[7px] px-2 text-[11px] font-medium transition-colors ${config ? "bg-accent-soft text-accent" : "bg-bg-2 text-fg-2 hover:bg-bg-3 hover:text-fg"}`}
      >
        <Columns2 size={16} aria-hidden />
        {t("desktop.editor.compare")}
      </button>
    </ToolcraftPopover>
  );
}

function timeLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00.00";
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${remaining.toFixed(2).padStart(5, "0")}`;
}

/**
 * In-player reference comparison. The timeline frame is mirrored from the
 * canonical preview renderer; only the main player owns transport controls.
 */
export const ReferenceComparisonPanel: React.FC<{
  timelineCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  userMuted?: boolean;
}> = ({ timelineCanvasRef, userMuted = false }) => {
  const { t } = useTranslation();
  const project = useProjectStore((state) => state.project);
  const executeAction = useProjectStore((state) => state.executeAction);
  const playheadPosition = useTimelineStore((state) => state.playheadPosition);
  const playbackState = useTimelineStore((state) => state.playbackState);
  const frameRate = project?.settings.frameRate ?? 30;
  const config = project?.referenceComparison ?? null;
  const mediaItems = useMemo(
    () => (project?.mediaLibrary?.items ?? []) as MediaItemLike[],
    [project?.mediaLibrary?.items],
  );
  const videoItems = useMemo(
    () => mediaItems.filter((item) => item.type === "video" && item.metadata.duration > 0),
    [mediaItems],
  );
  const referenceItem = useMemo(
    () => config ? mediaItems.find((item) => item.id === config.referenceMediaId) : undefined,
    [config, mediaItems],
  );

  const [referenceUrl, setReferenceUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [referenceTime, setReferenceTime] = useState(0);
  const mirrorRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const mapping = config ? mapTimelineToReference(config, playheadPosition) : null;

  useEffect(() => {
    const resolved = resolveReferenceMediaUrl(referenceItem);
    setReferenceUrl(resolved.url);
    setReferenceTime(referenceItem ? config?.refStartSec ?? 0 : 0);
    setError(null);
    return () => {
      if (resolved.revoke && resolved.url) URL.revokeObjectURL(resolved.url);
    };
  }, [config?.refStartSec, config?.referenceMediaId, referenceItem]);

  // Mirror the canonical renderer so comparison and the ordinary player show
  // exactly the same timeline frame without creating another timeline render.
  useEffect(() => {
    if (!config) return;
    let frame = 0;
    const draw = () => {
      const source = timelineCanvasRef.current;
      const mirror = mirrorRef.current;
      if (source && mirror && source.width && source.height) {
        if (mirror.width !== source.width) mirror.width = source.width;
        if (mirror.height !== source.height) mirror.height = source.height;
        const context = mirror.getContext("2d");
        context?.clearRect(0, 0, mirror.width, mirror.height);
        context?.drawImage(source, 0, 0);
      }
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [config, timelineCanvasRef]);

  const syncReference = useCallback(() => {
    const video = videoRef.current;
    if (!video || !config || !Number.isFinite(video.duration) || video.duration <= 0) return;
    const state = useTimelineStore.getState();
    const mapped = mapTimelineToReference(config, state.playheadPosition);
    const target = Math.max(0, Math.min(mapped.referenceSec, config.refEndSec - 1e-4, video.duration - 1e-4));
    const playing = state.playbackState === "playing" && mapped.clamped === "none" && mapped.referenceSec < config.refEndSec;
    const tolerance = playing ? 2 / frameRate : 0.001;
    if (Math.abs(video.currentTime - target) > tolerance) video.currentTime = target;
    setReferenceTime(video.currentTime);
    video.muted = userMuted || config.audioSide !== "reference" || !playing;
    if (playing) {
      if (video.paused) void video.play().catch(() => setError(t("Reference playback could not start.")));
    } else video.pause();
  }, [config, frameRate, userMuted, t]);

  useEffect(() => {
    syncReference();
  }, [syncReference, playheadPosition, playbackState, referenceUrl]);

  useEffect(() => () => videoRef.current?.pause(), []);

  const updateConfig = useCallback((patch: Partial<ReferenceComparisonConfig>) => {
    if (!config) return;
    void executeAction(setComparisonAction({ ...config, ...patch })).then((result) => {
      setError(result.success ? null : result.error?.message ?? t("Could not update comparison."));
    });
  }, [config, executeAction, t]);

  const selectReference = useCallback((mediaId: string) => {
    const media = videoItems.find((item) => item.id === mediaId);
    if (!media) return;
    void executeAction(selectComparisonAction(media, playheadPosition, config?.layout)).then((result) => {
      setError(result.success ? null : result.error?.message ?? t("Could not configure comparison."));
    });
  }, [config?.layout, executeAction, playheadPosition, t, videoItems]);

  const alignCurrentFrame = useCallback(() => {
    if (!config || !videoRef.current || !Number.isFinite(videoRef.current.currentTime)) return;
    const duration = Number.isFinite(videoRef.current.duration)
      ? videoRef.current.duration
      : referenceItem?.metadata.duration ?? config.refEndSec;
    const alignedReferenceTime = Math.max(0, Math.min(videoRef.current.currentTime, duration - 1 / frameRate));
    updateConfig({
      refStartSec: alignedReferenceTime,
      refEndSec: Math.max(config.refEndSec, alignedReferenceTime + 1 / frameRate),
      timelineStartSec: playheadPosition,
    });
  }, [config, frameRate, playheadPosition, referenceItem?.metadata.duration, updateConfig]);

  const clearComparison = useCallback(() => {
    void executeAction(clearComparisonAction()).then((result) => {
      setError(result.success ? null : result.error?.message ?? t("Could not clear comparison."));
      setAdvancedOpen(false);
    });
  }, [executeAction, t]);

  const handleReferenceError = useCallback(() => {
    if (referenceItem?.originalUrl && referenceUrl !== referenceItem.originalUrl) {
      setReferenceUrl(referenceItem.originalUrl);
      setError(null);
      return;
    }
    setError(t("Reference media could not be loaded."));
  }, [referenceItem?.originalUrl, referenceUrl, t]);

  const handleReferenceScrub = (value: number) => {
    const video = videoRef.current;
    if (!video || playbackState === "playing") return;
    video.currentTime = value;
    setReferenceTime(value);
  };

  if (!config) return null;

  const isOverlay = config.layout === "overlay";
  const canAlign = Boolean(referenceUrl && videoRef.current && Number.isFinite(videoRef.current.duration));

  return (
    <div
      data-testid="reference-comparison-viewport"
      data-reference-comparison="active"
      className="absolute inset-0 z-40 overflow-hidden rounded-[inherit] bg-black"
      onClick={(event) => event.stopPropagation()}
      onMouseMove={(event) => event.stopPropagation()}
    >
      {!referenceUrl ? (
        <div role="status" className="absolute inset-0 grid place-content-center gap-2 bg-[#39100d] text-center text-white">
          <strong>{t("Reference media is unavailable")}</strong>
          <span className="text-sm">{t("Restore the file or choose another reference video.")}</span>
        </div>
      ) : isOverlay ? (
        <div className="absolute inset-0" data-testid="comparison-surfaces">
          <canvas
            ref={mirrorRef}
            aria-label={t("Timeline video")}
            className="absolute inset-0 h-full w-full object-contain"
          />
          <video
            ref={videoRef}
            src={referenceUrl}
            muted={userMuted || config.audioSide !== "reference"}
            onLoadedMetadata={syncReference}
            onTimeUpdate={(event) => setReferenceTime(event.currentTarget.currentTime)}
            onError={handleReferenceError}
            aria-label={t("Reference video")}
            playsInline
            preload="auto"
            className="absolute inset-0 h-full w-full object-contain"
            style={{ opacity: config.overlayOpacity ?? 0.5, pointerEvents: "none" }}
          />
          <span className="absolute bottom-2 left-2 rounded bg-black/65 px-2 py-1 text-[10px] text-white">{t("Timeline")}</span>
        </div>
      ) : (
        <div className="absolute inset-0 flex" data-testid="comparison-surfaces">
          <div className="relative min-w-0 flex-1 bg-black">
            <video
              ref={videoRef}
              src={referenceUrl}
              muted={userMuted || config.audioSide !== "reference"}
              onLoadedMetadata={syncReference}
              onTimeUpdate={(event) => setReferenceTime(event.currentTarget.currentTime)}
              onError={handleReferenceError}
              aria-label={t("Reference video")}
              playsInline
              preload="auto"
              className="h-full w-full object-contain"
            />
            <span className="absolute bottom-2 left-2 rounded bg-black/65 px-2 py-1 text-[10px] text-white">{t("Reference")}</span>
          </div>
          <div className="relative min-w-0 flex-1 bg-black">
            <canvas
              ref={mirrorRef}
              aria-label={t("Timeline video")}
              className="h-full w-full object-contain"
            />
            <span className="absolute bottom-2 right-2 rounded bg-black/65 px-2 py-1 text-[10px] text-white">{t("Timeline")}</span>
          </div>
        </div>
      )}

      <div className="absolute left-2 right-2 top-2 z-10 flex flex-wrap items-center gap-1.5 rounded-md border border-white/15 bg-black/75 p-1.5 text-[11px] text-white shadow-lg backdrop-blur-sm">
        <label className="sr-only" htmlFor="reference-comparison-media">{t("Choose reference video")}</label>
        <select
          id="reference-comparison-media"
          aria-label={t("Choose reference video")}
          value={config.referenceMediaId}
          className="max-w-48 min-w-24 bg-transparent text-white outline-none"
          onChange={(event) => selectReference(event.target.value)}
        >
          {videoItems.map((item) => (
            <option key={item.id} value={item.id} className="text-black">{item.name ?? item.id}</option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            aria-pressed={config.layout === "side-by-side"}
            onClick={() => updateConfig({ layout: "side-by-side" })}
            className="rounded px-2 py-1 hover:bg-white/15 aria-pressed:bg-emerald-700"
          >{t("Side by side")}</button>
          <button
            type="button"
            aria-pressed={config.layout === "overlay"}
            onClick={() => updateConfig({ layout: "overlay" })}
            className="rounded px-2 py-1 hover:bg-white/15 aria-pressed:bg-emerald-700"
          >{t("Overlay comparison")}</button>
          <button
            type="button"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((open) => !open)}
            className="rounded px-2 py-1 hover:bg-white/15"
          >{t("Advanced")}</button>
          <button
            type="button"
            aria-label={t("Close reference comparison")}
            title={t("Close reference comparison")}
            onClick={clearComparison}
            className="rounded px-2 py-1 text-white/75 hover:bg-white/15 hover:text-white"
          >×</button>
        </div>
      </div>

      {advancedOpen && (
        <div className="absolute right-2 top-14 z-20 w-72 max-w-[calc(100%-1rem)] rounded-md border border-white/15 bg-black/90 p-3 text-[11px] text-white shadow-xl backdrop-blur-sm">
          <div className="mb-1 flex items-center justify-between gap-2">
            <label htmlFor="reference-position">{t("Reference position")}</label>
            <output>{timeLabel(referenceTime)}</output>
          </div>
          <input
            id="reference-position"
            aria-label={t("Reference position")}
            type="range"
            min={0}
            max={referenceItem?.metadata.duration ?? config.refEndSec}
            step={1 / frameRate}
            value={Math.min(referenceTime, referenceItem?.metadata.duration ?? config.refEndSec)}
            disabled={playbackState === "playing" || !referenceUrl}
            onChange={(event) => handleReferenceScrub(Number(event.target.value))}
            className="mb-2 w-full accent-emerald-500"
          />
          <button
            type="button"
            disabled={!canAlign || playbackState === "playing"}
            onClick={alignCurrentFrame}
            className="mb-2 w-full rounded bg-emerald-700 px-2 py-1.5 font-medium disabled:opacity-50"
          >{t("Align this reference frame to the timeline playhead")}</button>
          <label className="mb-2 flex items-center justify-between gap-2">
            <span>{t("Reference end")}</span>
            <input
              aria-label={t("Reference end")}
              type="number"
              min={config.refStartSec + 1 / frameRate}
              max={referenceItem?.metadata.duration}
              step={1 / frameRate}
              key={`reference-end-${config.refEndSec}`}
              defaultValue={config.refEndSec}
              onBlur={(event) => {
                const value = Number(event.currentTarget.value);
                if (Number.isFinite(value) && value !== config.refEndSec) updateConfig({ refEndSec: value });
              }}
              className="w-24 rounded bg-white/10 px-1.5 py-1 text-right text-white"
            />
          </label>
          <label className="mb-2 flex items-center justify-between gap-2">
            <span>{t("Timeline start")}</span>
            <input
              aria-label={t("Timeline start")}
              type="number"
              min={0}
              step={1 / frameRate}
              key={`timeline-start-${config.timelineStartSec}`}
              defaultValue={config.timelineStartSec}
              onBlur={(event) => {
                const value = Number(event.currentTarget.value);
                if (Number.isFinite(value) && value !== config.timelineStartSec) updateConfig({ timelineStartSec: Math.max(0, value) });
              }}
              className="w-24 rounded bg-white/10 px-1.5 py-1 text-right text-white"
            />
          </label>
          {isOverlay && (
            <label className="mb-2 flex items-center gap-2">
              <span className="shrink-0">{t("Overlay opacity")}</span>
              <input
                aria-label={t("Overlay opacity")}
                type="range"
                min={0.05}
                max={1}
                step={0.05}
                value={config.overlayOpacity ?? 0.5}
                onChange={(event) => updateConfig({ overlayOpacity: Number(event.target.value) })}
                className="flex-1 accent-emerald-500"
              />
            </label>
          )}
          <fieldset>
            <legend className="mb-1">{t("Audio source")}</legend>
            <div className="flex gap-1">
              {([
                ["timeline", t("Timeline audio")],
                ["reference", t("Reference audio")],
                ["none", t("Mute all")],
              ] as const).map(([side, label]) => (
                <button
                  key={side}
                  type="button"
                  aria-pressed={config.audioSide === side}
                  onClick={() => updateConfig({ audioSide: side })}
                  className="flex-1 rounded bg-white/10 px-1.5 py-1 hover:bg-white/20 aria-pressed:bg-emerald-700"
                >{label}</button>
              ))}
            </div>
          </fieldset>
          {mapping?.clamped !== "none" && (
            <p className="mt-2 text-amber-300">{t("Reference playback is outside the mapped range.")}</p>
          )}
        </div>
      )}
      {error && <p role="alert" className="absolute bottom-2 left-2 z-20 max-w-[80%] rounded bg-black/85 px-2 py-1 text-[11px] text-red-300">{error}</p>}
    </div>
  );
};
