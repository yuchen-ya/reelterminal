import type { JSX } from "react";
import type React from "react";
import {
  ChevronLeft,
  ChevronRight,
  Flag,
  Pause,
  Play,
  Scissors,
} from "lucide-react";
import type { WorkbenchVideoMarker } from "@reelterminal/core";
import {
  clamp01,
  formatScrubLabel,
  formatTimecode,
  MIN_INTERVAL_SEC,
} from "./video-helpers";

export interface VideoTransportBarProps {
  readonly videoTime: number;
  readonly duration: number | null;
  readonly durationLabel: string;
  readonly isPlaying: boolean;
  readonly videoReady: boolean;
  readonly stepSec: number;
  readonly onChangeStepSec: (step: number) => void;
  readonly onStep: (direction: 1 | -1) => void;
  readonly onTogglePlay: () => void;
  readonly onMarkCurrentFrame: () => void;
  readonly inPts: number | null;
  readonly outPts: number | null;
  readonly onSetIn: () => void;
  readonly onSetOut: () => void;
  readonly onMarkInterval: () => void;
  readonly markers: readonly WorkbenchVideoMarker[];
  readonly onSeekTo: (seconds: number) => void;
  readonly onScrubPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  readonly onScrubPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  readonly onScrubPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
}

export function VideoTransportBar({
  videoTime,
  duration,
  durationLabel,
  isPlaying,
  videoReady,
  stepSec,
  onChangeStepSec,
  onStep,
  onTogglePlay,
  onMarkCurrentFrame,
  inPts,
  outPts,
  onSetIn,
  onSetOut,
  onMarkInterval,
  markers,
  onSeekTo,
  onScrubPointerDown,
  onScrubPointerMove,
  onScrubPointerUp,
}: VideoTransportBarProps): JSX.Element {
  const scrubberDisabled = duration === null || duration <= 0;
  const playheadPct =
    duration !== null && duration > 0
      ? clamp01(videoTime / duration) * 100
      : 0;

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-border bg-bg-1 p-2.5 select-none">
      <div className="flex items-center justify-between gap-4">
        {/* Left: Timecode */}
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold tabular-nums text-fg">
            {formatTimecode(videoTime)}
          </span>
          <span className="font-mono text-xs tabular-nums text-fg-3">
            / {durationLabel}
          </span>
        </div>

        {/* Center: Playback & Step Controls */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onStep(-1)}
            disabled={!videoReady}
            className="inline-flex h-7 items-center gap-0.5 rounded-[6px] border border-border bg-bg-2 px-2 font-mono text-xs text-fg-2 transition-colors hover:bg-bg-3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
            title={`后退 ${stepSec}s`}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            -{stepSec}s
          </button>
          <button
            type="button"
            onClick={onTogglePlay}
            disabled={!videoReady}
            className="inline-flex h-7 w-8 items-center justify-center rounded-[6px] bg-fg text-bg transition-colors hover:bg-fg/90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
            title={isPlaying ? "暂停" : "播放"}
          >
            {isPlaying ? (
              <Pause className="h-3.5 w-3.5 fill-current" />
            ) : (
              <Play className="h-3.5 w-3.5 fill-current" />
            )}
          </button>
          <button
            type="button"
            onClick={() => onStep(1)}
            disabled={!videoReady}
            className="inline-flex h-7 items-center gap-0.5 rounded-[6px] border border-border bg-bg-2 px-2 font-mono text-xs text-fg-2 transition-colors hover:bg-bg-3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
            title={`前进 ${stepSec}s`}
          >
            +{stepSec}s
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
          <label className="flex items-center gap-1 text-xs text-fg-3">
            步长(s)
            <input
              type="number"
              min={0.01}
              max={1}
              step={0.01}
              value={stepSec}
              onChange={(e) => {
                const parsed = Number.parseFloat(e.target.value);
                if (Number.isFinite(parsed)) {
                  onChangeStepSec(Math.min(1, Math.max(0.01, parsed)));
                }
              }}
              className="h-6 w-14 rounded-[4px] border border-border bg-bg-2 px-1 text-right font-mono text-xs text-fg focus:border-accent focus:outline-none"
            />
          </label>
        </div>

        {/* Right: Issue Marking Controls */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onMarkCurrentFrame}
            disabled={!videoReady}
            className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-[6px] border border-border bg-bg-2 px-2.5 text-xs font-medium text-fg transition-colors hover:bg-bg-3 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span className="h-2 w-2 rounded-full bg-rose-500 shrink-0" />
            <Flag className="h-3 w-3 shrink-0 text-fg-3" />
            标问题帧 @ {videoTime.toFixed(2)}s
          </button>

          <div className="inline-flex items-center gap-1 rounded-[6px] border border-border bg-bg p-0.5 text-xs">
            <button
              type="button"
              onClick={onSetIn}
              disabled={!videoReady}
              className="whitespace-nowrap rounded-[4px] bg-bg-2 px-1.5 py-0.5 font-mono text-fg-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
              title="把当前播放位置设为区间入点"
            >
              ↳ In: {inPts !== null ? `${inPts.toFixed(3)}s` : "—"}
            </button>
            <button
              type="button"
              onClick={onSetOut}
              disabled={!videoReady}
              className="whitespace-nowrap rounded-[4px] bg-bg-2 px-1.5 py-0.5 font-mono text-fg-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
              title="把当前播放位置设为区间出点"
            >
              ↪ Out: {outPts !== null ? `${outPts.toFixed(3)}s` : "—"}
            </button>
            <button
              type="button"
              onClick={onMarkInterval}
              disabled={!videoReady}
              className="inline-flex items-center gap-1 whitespace-nowrap rounded-[4px] bg-bg-2 px-2 py-0.5 font-medium text-fg-2 hover:bg-bg-3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span className="h-2 w-2 rounded-full bg-amber-500 shrink-0" />
              <Scissors className="h-3 w-3 shrink-0 text-fg-3" />
              标问题区间 [{inPts !== null ? inPts.toFixed(2) : "—"}, {outPts !== null ? outPts.toFixed(2) : "—"})
            </button>
          </div>
        </div>
      </div>

      {/* Frame strip — ticks, markers and playhead all positioned by PTS seconds */}
      <div
        onPointerDown={onScrubPointerDown}
        onPointerMove={onScrubPointerMove}
        onPointerUp={onScrubPointerUp}
        className={`relative h-7 select-none overflow-hidden rounded-[6px] border border-border bg-bg ${
          scrubberDisabled ? "pointer-events-none opacity-50" : "cursor-pointer"
        }`}
        title={scrubberDisabled ? "媒体时长未知,暂不可拖动" : "点击/拖动跳转播放位置"}
      >
        {duration !== null && duration > 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-end justify-between px-2 pb-0.5 opacity-60">
            {Array.from({ length: 8 }).map((_, i) => {
              const t = (i / 7) * duration;
              return (
                <div key={i} className="flex flex-col items-center">
                  <span className="font-mono text-[9px] text-fg-3">{formatScrubLabel(t)}</span>
                  <div className="h-1.5 w-px bg-fg-3" />
                </div>
              );
            })}
          </div>
        )}

        {markers.map((m) => {
          if (duration === null || duration <= 0) return null;
          const leftPct = clamp01(m.startPtsSec / duration) * 100;
          if (m.type === "interval") {
            const end = m.endPtsSec ?? m.startPtsSec + MIN_INTERVAL_SEC;
            const widthPct = (Math.max(0, end - m.startPtsSec) / duration) * 100;
            return (
              <button
                key={m.id}
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onSeekTo(m.startPtsSec);
                }}
                style={{ left: `${leftPct}%`, width: `${Math.max(1.5, widthPct)}%` }}
                className="absolute bottom-1 top-1 rounded-sm border-x-2 border-amber-500/80 bg-amber-500/20 hover:bg-amber-500/30"
                title={`[${m.startPtsSec.toFixed(3)}s → ${end.toFixed(3)}s) ${m.note} — 点击跳转`}
              />
            );
          }
          return (
            <button
              key={m.id}
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onSeekTo(m.startPtsSec);
              }}
              style={{ left: `${leftPct}%` }}
              className="absolute bottom-0 top-0 w-1.5 -ml-0.5 bg-rose-500 hover:brightness-125"
              title={`${m.startPtsSec.toFixed(3)}s ${m.note} — 点击跳转`}
            />
          );
        })}

        <div
          style={{ left: `${playheadPct}%` }}
          className="pointer-events-none absolute bottom-0 top-0 w-0.5 bg-white"
        >
          <div className="-ml-1 -mt-0.5 h-2 w-2.5 rotate-45 rounded-sm bg-white shadow-sm" />
        </div>
      </div>
    </div>
  );
}
