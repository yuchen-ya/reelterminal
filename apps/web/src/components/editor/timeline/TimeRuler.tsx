import React, {
  useRef,
  useCallback,
  useEffect,
  useState,
  useMemo,
} from "react";
import { formatTimecode } from "./utils";
import {
  getBeatSyncBridge,
  type BeatSyncState,
} from "../../../bridges/beat-sync-bridge";
import { useTranslation } from "react-i18next";
import {
  ToolcraftContextMenu as ContextMenu,
  type ToolcraftContextMenuOption as ContextMenuOption,
} from "@openreel/ui";
import { Flag } from "@/icons/lucide-compat";
import type { ProjectMarker } from "@openreel/core";
import { useProjectStore } from "../../../stores/project-store";
import { useTimelineStore } from "../../../stores/timeline-store";
import { toast } from "../../../stores/notification-store";

interface TimeRulerProps {
  duration: number;
  pixelsPerSecond: number;
  scrollX: number;
  viewportWidth: number;
  onSeek: (time: number) => void;
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
  snapPoints?: number[];
}

export const TimeRuler: React.FC<TimeRulerProps> = ({
  pixelsPerSecond,
  scrollX,
  viewportWidth,
  onSeek,
  onScrubStart,
  onScrubEnd,
  snapPoints,
}) => {
  const { t: tr } = useTranslation();
  const rulerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [contextMenuTime, setContextMenuTime] = useState(0);
  const projectMarkers = useProjectStore((state) => state.project.markers);
  const addProjectMarker = useProjectStore((state) => state.addProjectMarker);
  const removeProjectMarker = useProjectStore(
    (state) => state.removeProjectMarker,
  );
  const playheadPosition = useTimelineStore((state) => state.playheadPosition);
  const [beatState, setBeatState] = useState<BeatSyncState>(() =>
    getBeatSyncBridge().getState(),
  );

  useEffect(() => {
    const bridge = getBeatSyncBridge();
    const unsubscribe = bridge.subscribe(setBeatState);
    return unsubscribe;
  }, []);

  const safePixelsPerSecond = pixelsPerSecond > 0 ? pixelsPerSecond : 100;
  const visibleStart = scrollX / safePixelsPerSecond;
  const visibleEnd = (scrollX + viewportWidth) / safePixelsPerSecond;

  const visibleBeatMarkers = useMemo(() => {
    if (beatState.beatMarkers.length === 0) return [];
    const buffer = 1;
    return beatState.beatMarkers.filter(
      (marker) =>
        marker.time >= visibleStart - buffer &&
        marker.time <= visibleEnd + buffer,
    );
  }, [beatState.beatMarkers, visibleStart, visibleEnd]);

  const getTickConfig = () => {
    if (safePixelsPerSecond > 500) {
      return { minor: 0.01, major: 0.1, labelEvery: 0.5 };
    }
    if (safePixelsPerSecond > 200) {
      return { minor: 0.05, major: 0.5, labelEvery: 1 };
    }
    if (safePixelsPerSecond > 100) {
      return { minor: 0.1, major: 1, labelEvery: 1 };
    }
    if (safePixelsPerSecond > 50) {
      return { minor: 0.5, major: 1, labelEvery: 5 };
    }
    if (safePixelsPerSecond > 20) {
      return { minor: 1, major: 5, labelEvery: 5 };
    }
    return { minor: 5, major: 10, labelEvery: 10 };
  };

  const tickConfig = getTickConfig();
  const rawStartTick = Math.floor(visibleStart / tickConfig.minor) * tickConfig.minor;
  const startTick = Math.max(0, rawStartTick);

  interface TickMark {
    time: number;
    isMajor: boolean;
    showLabel: boolean;
  }

  const ticks: TickMark[] = [];
  for (let t = startTick; t <= visibleEnd + tickConfig.minor; t += tickConfig.minor) {
    if (t < 0) continue;
    const roundedTime = Math.round(t * 10000) / 10000;
    if (!isFinite(roundedTime) || isNaN(roundedTime)) continue;
    const isMajor = roundedTime === 0 || Math.abs(roundedTime % tickConfig.major) < 0.0001;
    const showLabel = roundedTime === 0 || Math.abs(roundedTime % tickConfig.labelEvery) < 0.0001;
    ticks.push({ time: roundedTime, isMajor, showLabel });
  }

  const scrollXRef = useRef(scrollX);
  scrollXRef.current = scrollX;

  const getTimeFromEvent = useCallback(
    (e: MouseEvent | React.MouseEvent) => {
      const grandparent = rulerRef.current?.parentElement?.parentElement;
      if (!grandparent) return 0;
      const rect = grandparent.getBoundingClientRect();
      const x = e.clientX - rect.left + scrollXRef.current;
      return Math.max(0, x / safePixelsPerSecond);
    },
    [safePixelsPerSecond],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Left button only — right-click belongs to the review-marker menu and
      // must not scrub the playhead to the click point.
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(true);
      onScrubStart?.();
      const time = getTimeFromEvent(e);
      onSeek(time);
    },
    [getTimeFromEvent, onSeek, onScrubStart],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      setContextMenuTime(getTimeFromEvent(e));
    },
    [getTimeFromEvent],
  );

  const handleAddMarkerAt = useCallback(
    async (start: number, end: number) => {
      const result = await addProjectMarker({ kind: "timeRange", start, end });
      if (!result.success) {
        toast.error(tr("reviewMarkers.addFailed"), result.error?.message);
      }
    },
    [addProjectMarker, tr],
  );

  const handleRemoveMarker = useCallback(
    async (number: number) => {
      const result = await removeProjectMarker(number);
      if (!result.success) {
        toast.error(tr("reviewMarkers.removeFailed"), result.error?.message);
      }
    },
    [removeProjectMarker, tr],
  );

  const rangeDelta = Math.abs(contextMenuTime - playheadPosition);
  const rulerMenuItems: ContextMenuOption[] = [
    {
      label: tr("reviewMarkers.addAtPoint"),
      icon: <Flag size={14} aria-hidden />,
      onClick: () => {
        void handleAddMarkerAt(contextMenuTime, contextMenuTime);
      },
    },
    {
      label: tr("reviewMarkers.addRangeFromPlayhead"),
      icon: <Flag size={14} aria-hidden />,
      isDisabled: rangeDelta < 0.05,
      onClick: () => {
        void handleAddMarkerAt(
          Math.min(playheadPosition, contextMenuTime),
          Math.max(playheadPosition, contextMenuTime),
        );
      },
    },
  ];

  const timeRangeMarkers = useMemo(
    () =>
      (projectMarkers?.items ?? []).filter(
        (marker): marker is ProjectMarker & {
          target: { kind: "timeRange"; start: number; end: number };
        } => marker.target.kind === "timeRange",
      ),
    [projectMarkers],
  );

  const snapPointsRef = useRef(snapPoints);
  snapPointsRef.current = snapPoints;

  useEffect(() => {
    if (!isDragging) return;
    let rafId: number | null = null;
    let latestTime: number | null = null;
    let prevTime: number | null = null;
    let prevTimestamp = 0;
    let velocity = 0;

    const SNAP_THRESHOLD_PX = 8;
    const SLOW_VELOCITY_THRESHOLD = 150;

    const applySnap = (rawTime: number): number => {
      const points = snapPointsRef.current;
      if (!points || points.length === 0) return rawTime;

      if (velocity > SLOW_VELOCITY_THRESHOLD) return rawTime;

      const thresholdSec = SNAP_THRESHOLD_PX / safePixelsPerSecond;
      let bestDist = Infinity;
      let snapped = rawTime;

      for (const point of points) {
        const dist = Math.abs(rawTime - point);
        if (dist < thresholdSec && dist < bestDist) {
          bestDist = dist;
          snapped = point;
        }
      }

      return snapped;
    };

    const handleMouseMove = (e: MouseEvent) => {
      e.preventDefault();
      const rawTime = getTimeFromEvent(e);
      const now = performance.now();

      if (prevTime !== null && now - prevTimestamp > 0) {
        const dt = (now - prevTimestamp) / 1000;
        const pixelDelta = Math.abs(rawTime - prevTime) * safePixelsPerSecond;
        velocity = pixelDelta / dt;
      }
      prevTime = rawTime;
      prevTimestamp = now;

      latestTime = applySnap(rawTime);

      if (rafId === null) {
        rafId = requestAnimationFrame(() => {
          rafId = null;
          if (latestTime !== null) {
            onSeek(latestTime);
          }
        });
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      e.preventDefault();
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (latestTime !== null) onSeek(latestTime);
      setIsDragging(false);
      onScrubEnd?.();
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, getTimeFromEvent, onSeek, onScrubEnd, safePixelsPerSecond]);

  return (
    <ContextMenu items={rulerMenuItems} menuWidth={280} size="sm">
    <div
      ref={rulerRef}
      data-testid="timeline-time-ruler"
      className={`h-[34px] border-b border-border relative bg-bg-1 select-none ${
        isDragging ? "cursor-grabbing" : "cursor-pointer"
      }`}
      onMouseDown={handleMouseDown}
      onContextMenu={handleContextMenu}
      style={{ cursor: isDragging ? "grabbing" : "pointer" }}
    >
      {ticks.map((tick) =>
        tick.showLabel && tick.time >= 0 ? (
          <span
            key={`tick-${tick.time}`}
            className="absolute top-[9px] text-[11px] font-medium text-fg-muted whitespace-nowrap pointer-events-none"
            style={{ left: `${tick.time * safePixelsPerSecond + 6}px` }}
          >
            {formatTimecode(Math.max(0, tick.time)).slice(3, 8)}
          </span>
        ) : null,
      )}

      {visibleBeatMarkers.map((marker) => (
        <div
          key={`beat-ruler-${marker.index}`}
          className={`absolute bottom-0 pointer-events-none ${
            marker.isDownbeat
              ? "w-[2px] h-5 bg-orange-500"
              : "w-px h-3 bg-orange-400/50"
          }`}
          style={{ left: `${marker.time * safePixelsPerSecond}px` }}
        />
      ))}

      {/* Persisted review time-range markers: amber span from start→end (a
          point renders as a thin flag) with its stable #N. Right-clicking a
          span offers removal of exactly that marker. */}
      {timeRangeMarkers.map((marker) => {
        const { start, end } = marker.target;
        const isPoint = start === end;
        const left = start * safePixelsPerSecond;
        const width = Math.max(2, (end - start) * safePixelsPerSecond);
        const tooltip =
          marker.label && marker.label.trim().length > 0
            ? marker.label
            : tr("reviewMarkers.badgeLabel", { number: marker.number });
        return (
          <ContextMenu
            key={marker.id}
            menuWidth={220}
            size="sm"
            items={[
              {
                label: tr("reviewMarkers.remove", { number: marker.number }),
                icon: <Flag size={14} aria-hidden />,
                onClick: () => {
                  void handleRemoveMarker(marker.number);
                },
              },
            ]}
          >
            <div
              data-testid={`review-marker-span-${marker.number}`}
              className="absolute bottom-0 z-10 h-[34px]"
              style={{ left: `${left}px`, width: `${width}px` }}
              title={tooltip}
              onContextMenu={(e) => e.stopPropagation()}
            >
              <div
                className={`absolute bottom-0 ${
                  isPoint
                    ? "h-[16px] w-[2px] bg-[#f59e0b]"
                    : "inset-x-0 h-[7px] rounded-t-[3px] bg-[#f59e0b]/85"
                }`}
              />
              <span className="pointer-events-none absolute bottom-[7px] left-0 rounded-[3px] bg-[#f59e0b] px-1 py-px text-[8px] font-bold leading-none text-[#201300] shadow-[0_1px_4px_rgba(0,0,0,0.4)]">
                #{marker.number}
              </span>
            </div>
          </ContextMenu>
        );
      })}

      {beatState.beatAnalysis && (
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5 bg-orange-500/20 px-2 py-0.5 rounded text-[9px] text-orange-400 font-medium pointer-events-none">
          <span className="opacity-70">♪</span>
          <span>{beatState.beatAnalysis.bpm} {tr(" BPM")}</span>
        </div>
      )}
    </div>
    </ContextMenu>
  );
};
