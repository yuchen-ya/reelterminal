/**
 * Reference comparison panel (P1) — the GUI surface of the ONE shared
 * referenceComparison config on the canonical project. The Agent writes the
 * same config through edit.apply; both sides see identical state, and layout/
 * audio-side changes made here go through the same undoable core actions.
 *
 * Sync model (docs: reference comparison): referenceSec(timelineSec) =
 * refStartSec + (timelineSec - timelineStartSec) at rate 1. Transport
 * controls drive the CANONICAL playhead (timeline store), and the reference
 * <video> follows the mapping; beyond the reference range the video clamps
 * to the nearest frame and the readout says so. The reference is drawn with
 * object-contain (aspect preserved, letterboxed — never cropped), and only
 * ONE side's audio ever plays (config.audioSide).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mapTimelineToReference, type ReferenceComparisonConfig } from "@reelterminal/core/types/reference-comparison";
import type { Action } from "@reelterminal/core/types/actions";
import { useProjectStore } from "../../../stores/project-store";
import { useTimelineStore } from "../../../stores/timeline-store";
import { useTranslation } from "react-i18next";

interface MediaItemLike {
  readonly id: string;
  readonly name?: string;
  readonly blob?: Blob | null;
  readonly originalUrl?: string;
}

function setComparisonAction(config: ReferenceComparisonConfig): Action {
  return {
    type: "reference/setComparison",
    id: `reference-set-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    params: { config },
  };
}

export const ReferenceComparisonPanel: React.FC<{
  timelineCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  userMuted?: boolean;
}> = ({ timelineCanvasRef, userMuted = false }) => {
  const { t } = useTranslation();
  const project = useProjectStore((state) => state.project);
  const executeAction = useProjectStore((state) => state.executeAction);
  const playheadPosition = useTimelineStore((state) => state.playheadPosition);
  const playbackState = useTimelineStore((state) => state.playbackState);
  const togglePlayback = useTimelineStore((state) => state.togglePlayback);
  const seekRelative = useTimelineStore((state) => state.seekRelative);
  const seekToStart = useTimelineStore((state) => state.seekToStart);

  const [open, setOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mirrorRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRate = project?.settings.frameRate ?? 30;

  const config = project?.referenceComparison ?? null;
  const referenceItem: MediaItemLike | undefined = useMemo(
    () => config ? project?.mediaLibrary?.items?.find((item) => (item as MediaItemLike).id === config.referenceMediaId) : undefined,
    [config, project],
  );

  const referenceUrl = useMemo(() => {
    const blob = (referenceItem as { blob?: Blob | null } | undefined)?.blob;
    if (blob) return URL.createObjectURL(blob);
    return undefined;
  }, [referenceItem]);
  useEffect(() => {
    return () => {
      if (referenceUrl) URL.revokeObjectURL(referenceUrl);
    };
  }, [referenceUrl]);

  const mapping = config ? mapTimelineToReference(config, playheadPosition) : null;

  // Mirror the canonical rendered canvas; do not create another timeline renderer.
  useEffect(() => {
    if (!config || !open) return;
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
  }, [config, open, timelineCanvasRef]);

  // Resync on scrubs, config changes, metadata readiness and playback drift.
  // Outside the mapped interval HOLD the frame and silence reference audio.
  const syncReference = useCallback(() => {
    const video = videoRef.current;
    if (!video || !config || !Number.isFinite(video.duration)) return;
    const state = useTimelineStore.getState();
    const mapped = mapTimelineToReference(config, state.playheadPosition);
    const target = Math.max(0, Math.min(mapped.referenceSec, config.refEndSec - 1e-4, video.duration - 1e-4));
    const playing = state.playbackState === "playing" && mapped.clamped === "none" && mapped.referenceSec < config.refEndSec;
    const tolerance = playing ? 2 / frameRate : 0.001;
    if (Math.abs(video.currentTime - target) > tolerance) video.currentTime = target;
    video.muted = userMuted || config.audioSide !== "reference" || !playing;
    if (playing) {
      if (video.paused) void video.play().catch(() => setError("Reference playback could not start. Press Play to retry."));
    } else video.pause();
  }, [config, frameRate, userMuted]);

  useEffect(() => { syncReference(); }, [syncReference, playheadPosition, playbackState, referenceUrl]);
  useEffect(() => () => { videoRef.current?.pause(); }, []);

  const updateConfig = useCallback((patch: Partial<ReferenceComparisonConfig>) => {
    if (!config) return;
    void executeAction(setComparisonAction({ ...config, ...patch })).then((result) => {
      setError(result.success ? null : result.error?.message ?? "Could not update comparison");
    });
  }, [config, executeAction]);

  if (!config) {
    return (
      <div className="px-3 py-1.5 text-[11px] text-[var(--text-secondary)]">
        <label>{t("Reference comparison")}
          <select aria-label="Reference media" defaultValue="" className="ml-2 bg-bg-2" onChange={(event) => {
            const media = project.mediaLibrary.items.find((item) => item.id === event.target.value);
            if (!media) return;
            void executeAction(setComparisonAction({ referenceMediaId: media.id, refStartSec: 0,
              refEndSec: media.metadata.duration, timelineStartSec: 0, rate: 1,
              audioSide: "timeline", layout: "side-by-side" })).then((result) => {
                setError(result.success ? null : result.error?.message ?? "Could not configure comparison");
              });
          }}>
            <option value="" disabled>{t("Choose reference video")}</option>
            {project.mediaLibrary.items.filter((item) => item.type === "video" && item.metadata.duration > 0)
              .map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        {error && <p role="alert">{error}</p>}
      </div>
    );
  }

  return (
    <div className="border-t border-[var(--border-color)] bg-[var(--bg-secondary)] select-none">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
      >
        <span className={`transition-transform ${open ? "rotate-90" : ""}`}>▶</span>
        {t("Reference comparison")}
        <span className="ml-auto tabular-nums">
          TL {playheadPosition.toFixed(2)}s → REF {mapping ? mapping.referenceSec.toFixed(2) : "–"}s
          {mapping && mapping.clamped !== "none" ? ` (clamped ${mapping.clamped})` : ""}
        </span>
      </button>

      {config && (
        <div className="px-3 pb-3" hidden={!open}>
          {error && <p role="alert">{error}</p>}
          {!referenceUrl && <p role="status">Reference media is unavailable. Restore the file or choose another reference.</p>}
          <div className="flex items-stretch gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-[10px] text-[var(--text-secondary)] mb-1">
                {config.layout === "overlay" ? "Timeline + reference overlay" : "Left: reference · Right: timeline"}
                {" · "}{referenceItem?.name ?? config.referenceMediaId}
              </div>
              <div data-testid="comparison-surfaces" style={{ display: "grid", gridTemplateColumns: config.layout === "overlay" ? "1fr" : "1fr 1fr", background: "black" }}>
                <canvas ref={mirrorRef} aria-label="Comparison timeline frame" style={{ gridArea: config.layout === "overlay" ? "1 / 1" : "1 / 2", width: "100%", height: "100%", maxHeight: 224, objectFit: "contain" }} />
              {/* object-contain: aspect preserved, letterboxed, never cropped */}
              <video
                ref={videoRef}
                src={referenceUrl}
                muted={userMuted || config.audioSide !== "reference"}
                onLoadedMetadata={syncReference}
                onError={() => setError("Reference media could not be loaded.")}
                aria-label="Comparison reference video"
                style={{ gridArea: "1 / 1", width: "100%", height: "100%", maxHeight: 224, objectFit: "contain", opacity: config.layout === "overlay" ? (config.overlayOpacity ?? 0.5) : 1, zIndex: 1 }}
                playsInline
                preload="auto"
                className="w-full max-h-56 bg-black rounded-md object-contain"
              />
              </div>
              {(["refStartSec", "refEndSec", "timelineStartSec"] as const).map((field) => (
                <label key={field} className="inline-flex gap-1 mr-2 text-[10px]">
                  {{ refStartSec: "Reference in", refEndSec: "Reference out", timelineStartSec: "Timeline start" }[field]}
                  <input key={`${field}-${config[field]}`} aria-label={field} type="number" min={0} step={1 / frameRate}
                    defaultValue={config[field]} className="w-16 bg-bg-2" onBlur={(event) => {
                      const value = Number(event.target.value);
                      if (Number.isFinite(value) && value !== config[field]) updateConfig({ [field]: value });
                    }} />
                </label>
              ))}
            </div>
            <div className="w-44 shrink-0 flex flex-col gap-1.5 text-[11px]">
              <div className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">Sync transport</div>
              <div className="flex gap-1">
                <button type="button" className="px-2 py-1 rounded bg-[var(--bg-tertiary)] hover:brightness-110" onClick={() => seekToStart()}>⏮</button>
                <button type="button" className="px-2 py-1 rounded bg-[var(--bg-tertiary)] hover:brightness-110" onClick={() => seekRelative(-1 / frameRate)}>−1f</button>
                <button type="button" className="px-2 py-1 rounded bg-[var(--bg-tertiary)] hover:brightness-110" onClick={togglePlayback}>
                  {playbackState === "playing" ? "⏸ Pause" : "▶ Play"}
                </button>
                <button type="button" className="px-2 py-1 rounded bg-[var(--bg-tertiary)] hover:brightness-110" onClick={() => seekRelative(1 / frameRate)}>+1f</button>
              </div>
              <div className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)] pt-1">Layout</div>
              <div className="flex gap-1">
                {(["side-by-side", "overlay"] as const).map((layout) => (
                  <button
                    key={layout}
                    type="button"
                    disabled={config.layout === layout}
                    className="flex-1 px-2 py-1 rounded bg-[var(--bg-tertiary)] hover:brightness-110 disabled:opacity-50"
                    onClick={() => updateConfig({ layout })}
                  >
                    {layout === "side-by-side" ? "L | R" : "Overlay"}
                  </button>
                ))}
              </div>
              {config.layout === "overlay" && (
                <label className="flex items-center gap-2">
                  <span className="text-[var(--text-secondary)]">Opacity</span>
                  <input
                    type="range"
                    min={0.05}
                    max={1}
                    step={0.05}
                    value={config.overlayOpacity ?? 0.5}
                    onChange={(event) => updateConfig({ overlayOpacity: Number(event.target.value) })}
                    className="flex-1"
                  />
                </label>
              )}
              <div className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)] pt-1">Audio side</div>
              <div className="flex gap-1">
                {(["timeline", "reference", "none"] as const).map((side) => (
                  <button
                    key={side}
                    type="button"
                    disabled={config.audioSide === side}
                    className="flex-1 px-1.5 py-1 rounded bg-[var(--bg-tertiary)] hover:brightness-110 disabled:opacity-50"
                    onClick={() => updateConfig({ audioSide: side })}
                  >
                    {side === "timeline" ? "TL" : side === "reference" ? "REF" : "Mute"}
                  </button>
                ))}
              </div>
              <button type="button" onClick={() => void executeAction({ type: "reference/clearComparison", id: crypto.randomUUID(), timestamp: Date.now(), params: {} })}>Clear comparison</button>
              <div className="text-[10px] text-[var(--text-secondary)] pt-1 leading-snug">
                Mapping: rate {config.rate} · ref {config.refStartSec}s–{config.refEndSec}s ↔ timeline from {config.timelineStartSec}s.
                {mapping?.clamped === "after" ? " Beyond refEnd the reference holds its last frame." : ""}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
