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
    <div className="flex h-9 shrink-0 items-center gap-2 border-t border-border bg-bg-1 px-2.5 select-none">
      {/* 1. Playback & Step Controls + Timecode */}
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => onStep(-1)}
          disabled={!videoReady}
          className="inline-flex h-6 w-6 items-center justify-center rounded-[5px] border border-border bg-bg-2 text-fg-2 transition-colors hover:bg-bg-3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
          title={`后退 ${stepSec}s`}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          <span className="sr-only">-{stepSec}s</span>
        </button>
        <button
          type="button"
          onClick={onTogglePlay}
          disabled={!videoReady}
          className="inline-flex h-6 w-7 items-center justify-center rounded-[5px] bg-fg text-bg transition-colors hover:bg-fg/90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
          title={isPlaying ? "暂停" : "播放"}
        >
          {isPlaying ? (
            <Pause className="h-3 w-3 fill-current" />
          ) : (
            <Play className="h-3 w-3 fill-current" />
          )}
        </button>
        <button
          type="button"
          onClick={() => onStep(1)}
          disabled={!videoReady}
          className="inline-flex h-6 w-6 items-center justify-center rounded-[5px] border border-border bg-bg-2 text-fg-2 transition-colors hover:bg-bg-3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
          title={`前进 ${stepSec}s`}
        >
          <ChevronRight className="h-3.5 w-3.5" />
          <span className="sr-only">+{stepSec}s</span>
        </button>
        <label className="sr-only">
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
          />
        </label>
        <div className="ml-1 flex items-baseline gap-1 font-mono tabular-nums">
          <span className="text-xs font-semibold text-fg">{formatTimecode(videoTime)}</span>
          <span className="text-[11px] text-fg-3">/ {durationLabel}</span>
        </div>
      </div>

      {/* 2. Inline Timeline Scrubber */}
      <div
        onPointerDown={onScrubPointerDown}
        onPointerMove={onScrubPointerMove}
        onPointerUp={onScrubPointerUp}
        className={`relative h-5 min-w-[120px] flex-1 select-none overflow-hidden rounded-[5px] border border-border bg-bg ${
          scrubberDisabled ? "pointer-events-none opacity-50" : "cursor-pointer"
        }`}
        title={scrubberDisabled ? "媒体时长未知,暂不可拖动" : "点击/拖动跳转播放位置"}
      >
        {duration !== null && duration > 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-end justify-between px-2 pb-0.5 opacity-40">
            {Array.from({ length: 6 }).map((_, i) => {
              const t = (i / 5) * duration;
              return (
                <div key={i} className="flex flex-col items-center">
                  <span className="sr-only">{formatScrubLabel(t)}</span>
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
                className="absolute bottom-0.5 top-0.5 rounded-sm border-x-2 border-amber-500/80 bg-amber-500/20 hover:bg-amber-500/30"
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

      {/* 3. Compact Icon-Only Issue Marking Controls */}
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onMarkCurrentFrame}
          disabled={!videoReady}
          title={`标问题帧 @ ${videoTime.toFixed(2)}s`}
          className="inline-flex h-6 items-center gap-1 rounded-[5px] border border-border bg-bg-2 px-1.5 text-xs text-fg transition-colors hover:bg-bg-3 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-rose-500 shrink-0" />
          <Flag className="h-3 w-3 shrink-0 text-fg-2" />
          <span className="sr-only">标问题帧 @ {videoTime.toFixed(2)}s</span>
        </button>

        <div className="inline-flex h-6 items-center gap-0.5 rounded-[5px] border border-border bg-bg p-0.5 text-xs">
          <button
            type="button"
            onClick={onSetIn}
            disabled={!videoReady}
            className={`rounded-[3px] px-1.5 py-0.5 font-mono text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              inPts !== null ? "bg-amber-500/15 text-amber-300" : "bg-bg-2 text-fg-3 hover:text-fg"
            }`}
            title={`把当前播放位置设为区间入点 (${inPts !== null ? `${inPts.toFixed(3)}s` : "未设置"})`}
          >
            [
            <span className="sr-only">
              In: 入点: {inPts !== null ? `${inPts.toFixed(3)}s` : "—"}
            </span>
          </button>
          <button
            type="button"
            onClick={onSetOut}
            disabled={!videoReady}
            className={`rounded-[3px] px-1.5 py-0.5 font-mono text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              outPts !== null ? "bg-amber-500/15 text-amber-300" : "bg-bg-2 text-fg-3 hover:text-fg"
            }`}
            title={`把当前播放位置设为区间出点 (${outPts !== null ? `${outPts.toFixed(3)}s` : "未设置"})`}
          >
            ]
            <span className="sr-only">
              Out: 出点: {outPts !== null ? `${outPts.toFixed(3)}s` : "—"}
            </span>
          </button>
          <button
            type="button"
            onClick={onMarkInterval}
            disabled={!videoReady}
            title={`标问题区间 [${inPts !== null ? inPts.toFixed(2) : "—"}, ${outPts !== null ? outPts.toFixed(2) : "—"})`}
            className="inline-flex items-center gap-0.5 rounded-[3px] bg-bg-2 px-1.5 py-0.5 text-fg-2 hover:bg-bg-3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Scissors className="h-3 w-3 shrink-0 text-amber-400" />
            <span className="sr-only">
              标问题区间 [{inPts !== null ? inPts.toFixed(2) : "—"}, {outPts !== null ? outPts.toFixed(2) : "—"})
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
