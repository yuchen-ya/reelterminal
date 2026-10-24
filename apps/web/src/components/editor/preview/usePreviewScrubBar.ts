import React, { useCallback, useRef } from "react";
import { getPlaybackBridge } from "../../../bridges/playback-bridge";

/**
 * Scrub bar interaction for the Preview player: pointer-drag seeking,
 * keyboard stepping (arrow keys / Home / End) and the ±5s skip buttons.
 *
 * Pointer capture keeps the gesture alive outside the thin bar; position
 * updates are coalesced to one per frame so pointermove never resets audio
 * or triggers heavy work. The final position commits through the unified
 * seek command (master clock + audio + store together) so the playback
 * clock cannot pull the playhead back.
 */
export function usePreviewScrubBar(params: {
  actualEndTime: number;
  playheadPosition: number;
}) {
  const { actualEndTime, playheadPosition } = params;

  const scrubBarRef = useRef<HTMLDivElement>(null);
  const scrubDragRef = useRef<{
    pointerId: number;
    rafId: number | null;
    latestTime: number;
  } | null>(null);

  const scrubTimeFromClientX = useCallback(
    (clientX: number): number => {
      const rect = scrubBarRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return playheadPosition;
      const percentage = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return percentage * (actualEndTime || 10);
    },
    [actualEndTime, playheadPosition],
  );

  const flushScrubTarget = useCallback(() => {
    const drag = scrubDragRef.current;
    if (!drag) return;
    drag.rafId = null;
    getPlaybackBridge().scrubTo(drag.latestTime);
  }, []);

  const handleScrubPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const time = scrubTimeFromClientX(e.clientX);
      e.currentTarget.setPointerCapture(e.pointerId);
      scrubDragRef.current = {
        pointerId: e.pointerId,
        rafId: null,
        latestTime: time,
      };
      getPlaybackBridge().startScrubbing();
      getPlaybackBridge().scrubTo(time);
    },
    [scrubTimeFromClientX],
  );

  const handleScrubPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = scrubDragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      drag.latestTime = scrubTimeFromClientX(e.clientX);
      if (drag.rafId === null) {
        drag.rafId = requestAnimationFrame(flushScrubTarget);
      }
    },
    [scrubTimeFromClientX, flushScrubTarget],
  );

  const handleScrubPointerEnd = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = scrubDragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      scrubDragRef.current = null;
      if (drag.rafId !== null) {
        cancelAnimationFrame(drag.rafId);
      }
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      // Commit the exact release position — endScrubbing moves the master
      // clock and audio there and Preview paints the final precise frame.
      getPlaybackBridge().scrubTo(drag.latestTime);
      getPlaybackBridge().endScrubbing();
    },
    [],
  );

  const handleScrubKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        e.stopPropagation();
        void getPlaybackBridge().stepFrame(e.key === "ArrowLeft" ? -1 : 1);
        return;
      }
      const step = 1;
      let target: number | null = null;
      switch (e.key) {
        case "ArrowLeft":
          target = playheadPosition - step;
          break;
        case "ArrowRight":
          target = playheadPosition + step;
          break;
        case "Home":
          target = 0;
          break;
        case "End":
          target = actualEndTime || 0;
          break;
        default:
          return;
      }
      e.preventDefault();
      e.stopPropagation();
      void getPlaybackBridge().requestSeek(
        Math.max(0, Math.min(target, actualEndTime || target)),
      );
    },
    [playheadPosition, actualEndTime],
  );

  const handleSkipBack = useCallback(() => {
    void getPlaybackBridge().requestSeekRelative(-5);
  }, []);

  const handleSkipForward = useCallback(() => {
    void getPlaybackBridge().requestSeekRelative(5);
  }, []);

  return {
    scrubBarRef,
    handleScrubPointerDown,
    handleScrubPointerMove,
    handleScrubPointerEnd,
    handleScrubKeyDown,
    handleSkipBack,
    handleSkipForward,
  };
}
