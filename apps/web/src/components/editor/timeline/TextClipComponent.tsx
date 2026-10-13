import React, { useRef, useState, useEffect } from "react";
import { ToolcraftContextMenu as ContextMenu } from "@reelterminal/ui";
import { Type } from "@/icons/lucide-compat";
import type { TextClip } from "@reelterminal/core";
import { useGraphicsClipContextMenuItems } from "./GraphicsClipContextMenu";
import { calculateSnap } from "./utils";
import { useProjectStore } from "../../../stores/project-store";
import { useTimelineStore } from "../../../stores/timeline-store";
import { useUIStore } from "../../../stores/ui-store";
import { AgentReferenceBadge } from "./AgentReferenceBadge";
import { ProjectMarkerBadgeStack } from "../ProjectMarkerBadge";
import { findMarkersForEntity } from "../../../stores/project/project-marker-selectors";
import { beginTimelineGesture, recordTimelineInput, recordTimelineGestureRelease, finishTimelineGesture, cancelTimelineGesture } from "../../../performance/product-flow";
import { toast } from "../../../stores/notification-store";

interface TextClipComponentProps {
  textClip: TextClip;
  pixelsPerSecond: number;
  isSelected: boolean;
  onSelect: (clipId: string, addToSelection: boolean) => void;
  onTrim: (clipId: string, edge: "left" | "right", newTime: number) => Promise<boolean> | boolean;
  onMoveClip?: (clipId: string, newStartTime: number) => Promise<boolean> | boolean;
}

export const TextClipComponent: React.FC<TextClipComponentProps> = ({
  textClip,
  pixelsPerSecond,
  isSelected,
  onSelect,
  onTrim,
  onMoveClip,
}) => {
  const clipRef = useRef<HTMLDivElement>(null);
  const [isTrimming, setIsTrimming] = useState<"left" | "right" | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const gestureActiveRef = useRef(false);
  const gestureReleasedRef = useRef(false);
  const previewStartTimeRef = useRef<number | null>(null);
  const trimPreviewRef = useRef<{
    newTime: number;
    startTime: number;
    duration: number;
  } | null>(null);
  const { snapSettings } = useUIStore();
  const { playheadPosition } = useTimelineStore();
  const projectMarkers = useProjectStore((state) => state.project.markers);
  const reviewMarkers = findMarkersForEntity(projectMarkers, {
    textClipId: textClip.id,
  });
  const trimStartRef = useRef<{
    mouseX: number;
    startTime: number;
    duration: number;
  }>({
    mouseX: 0,
    startTime: textClip.startTime,
    duration: textClip.duration,
  });

  const left = textClip.startTime * pixelsPerSecond;
  const width = textClip.duration * pixelsPerSecond;

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (useProjectStore.getState().readOnlyPreview) {
      e.stopPropagation();
      onSelect(textClip.id, e.shiftKey || e.metaKey || e.ctrlKey);
      return;
    }
    if (isTrimming || gestureActiveRef.current || !onMoveClip) return;
    e.stopPropagation();

    const rect = clipRef.current?.parentElement?.getBoundingClientRect();
    if (!rect) return;

    const clickX = e.clientX - rect.left;
    const clipStartX = textClip.startTime * pixelsPerSecond;
    setDragOffset(clickX - clipStartX);
    previewStartTimeRef.current = textClip.startTime;
    gestureActiveRef.current = true;
    setIsDragging(true);
    gestureReleasedRef.current = false;
    beginTimelineGesture("input.text-drag");

    onSelect(textClip.id, e.shiftKey || e.metaKey || e.ctrlKey);
  };

  const handleClick = (e: React.MouseEvent) => {
    // Selection is committed on mouse-down so drag gestures feel immediate.
    // Keep the resulting click from reaching the lane and clearing it.
    e.stopPropagation();
  };

  useEffect(() => {
    if (!isDragging || !onMoveClip || gestureReleasedRef.current) return;
    let released = false;

    const resetPreview = (): void => {
      previewStartTimeRef.current = null;
      if (clipRef.current) clipRef.current.style.transform = `translateX(${left}px)`;
    };

    const finishFailure = (
      expected?: ReturnType<typeof recordTimelineGestureRelease>,
      error?: unknown,
    ): void => {
      cancelTimelineGesture(expected);
      resetPreview();
      if (error !== undefined) {
        toast.error("Could not move text clip", error instanceof Error ? error.message : "The change could not be saved.");
      } else {
        toast.error("Could not move text clip", "The change could not be saved.");
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (released) return;
      recordTimelineInput();
      const rect = clipRef.current?.parentElement?.getBoundingClientRect();
      if (!rect) return;

      const x = e.clientX - rect.left - dragOffset;
      const rawTime = Math.max(0, x / pixelsPerSecond);
      const allTracks = useProjectStore.getState().project.timeline.tracks;
      const dragSnapSettings = { ...snapSettings, snapToPlayhead: false };
      const snapResult = calculateSnap(
        rawTime,
        textClip.id,
        allTracks,
        playheadPosition,
        dragSnapSettings,
        pixelsPerSecond,
        textClip.duration,
      );
      previewStartTimeRef.current = snapResult.time;
      if (clipRef.current) {
        clipRef.current.style.transform = `translateX(${snapResult.time * pixelsPerSecond}px)`;
      }
    };

    const handleMouseUp = () => {
      if (released) return;
      released = true;
      gestureReleasedRef.current = true;
      const gestureOperation = recordTimelineGestureRelease();
      const newStartTime = previewStartTimeRef.current;
      if (newStartTime === null || newStartTime === textClip.startTime) {
        cancelTimelineGesture(gestureOperation);
        gestureActiveRef.current = false;
        resetPreview();
        setIsDragging(false);
        return;
      }

      void Promise.resolve().then(() => onMoveClip(textClip.id, newStartTime)).then(
          (committed) => {
          if (committed) finishTimelineGesture(useProjectStore.getState().projectRevision, gestureOperation);
          else finishFailure(gestureOperation);
        },
        (error: unknown) => finishFailure(gestureOperation, error),
      ).finally(() => {
        gestureActiveRef.current = false;
        setIsDragging(false);
      });
    };

    const handleCancel = (event?: KeyboardEvent): void => {
      if (released || (event && event.key !== "Escape")) return;
      released = true;
      gestureReleasedRef.current = true;
      cancelTimelineGesture();
      gestureActiveRef.current = false;
      resetPreview();
      setIsDragging(false);
    };
    const handleWindowBlur = (): void => handleCancel();
    const handleKeyDown = (event: KeyboardEvent): void => handleCancel(event);

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("blur", handleWindowBlur);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      if (!released) handleCancel();
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("blur", handleWindowBlur);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isDragging, textClip.id, textClip.startTime, textClip.duration, pixelsPerSecond, dragOffset, onMoveClip, snapSettings, playheadPosition, left]);

  const handleTrimStart = (e: React.MouseEvent, edge: "left" | "right") => {
    if (e.button !== 0 || gestureActiveRef.current) return;
    if (useProjectStore.getState().readOnlyPreview) return;
    e.stopPropagation();
    e.preventDefault();
    setIsTrimming(edge);
    gestureActiveRef.current = true;
    gestureReleasedRef.current = false;
    beginTimelineGesture("input.text-trim");
    trimStartRef.current = {
      mouseX: e.clientX,
      startTime: textClip.startTime,
      duration: textClip.duration,
    };
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
  };

  useEffect(() => {
    if (!isTrimming) return;
    let released = false;

    const restorePreview = (): void => {
      trimPreviewRef.current = null;
      if (clipRef.current) {
        clipRef.current.style.transform = `translateX(${trimStartRef.current.startTime * pixelsPerSecond}px)`;
        clipRef.current.style.width = `${Math.max(trimStartRef.current.duration * pixelsPerSecond, 40)}px`;
      }
    };

    const restoreBodyStyles = (): void => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    const handleMouseMove = (e: MouseEvent) => {
      recordTimelineInput();
      const deltaX = e.clientX - trimStartRef.current.mouseX;
      const deltaTime = deltaX / pixelsPerSecond;

      let newTime: number;
      let startTime = trimStartRef.current.startTime;
      let duration: number;
      if (isTrimming === "left") {
        newTime = Math.max(
          0,
          trimStartRef.current.startTime + deltaTime,
        );
        const maxStartTime =
          trimStartRef.current.startTime + trimStartRef.current.duration - 0.1;
        newTime = Math.min(newTime, maxStartTime);
        startTime = newTime;
        duration = trimStartRef.current.startTime + trimStartRef.current.duration - newTime;
      } else {
        newTime =
          trimStartRef.current.startTime +
          trimStartRef.current.duration +
          deltaTime;
        const minEndTime = trimStartRef.current.startTime + 0.1;
        newTime = Math.max(newTime, minEndTime);
        duration = newTime - trimStartRef.current.startTime;
      }
      trimPreviewRef.current = { newTime, startTime, duration };
      if (clipRef.current) {
        clipRef.current.style.transform = `translateX(${startTime * pixelsPerSecond}px)`;
        clipRef.current.style.width = `${Math.max(duration * pixelsPerSecond, 40)}px`;
      }
    };

    const handleMouseUp = () => {
      if (released) return;
      released = true;
      gestureReleasedRef.current = true;
      const gestureOperation = recordTimelineGestureRelease();
      restoreBodyStyles();
      const preview = trimPreviewRef.current;
      if (!preview || preview.newTime === (isTrimming === "left"
        ? trimStartRef.current.startTime
        : trimStartRef.current.startTime + trimStartRef.current.duration)) {
        cancelTimelineGesture(gestureOperation);
        gestureActiveRef.current = false;
        restorePreview();
        return;
      }
      void Promise.resolve().then(() => onTrim(textClip.id, isTrimming, preview.newTime)).then(
        (committed) => {
          if (committed) finishTimelineGesture(useProjectStore.getState().projectRevision, gestureOperation);
          else {
            cancelTimelineGesture(gestureOperation);
            restorePreview();
            toast.error("Could not trim text clip", "The change could not be saved.");
          }
        },
        (error: unknown) => {
          cancelTimelineGesture(gestureOperation);
          restorePreview();
          toast.error("Could not trim text clip", error instanceof Error ? error.message : "The change could not be saved.");
        },
      ).finally(() => {
        gestureActiveRef.current = false;
        setIsTrimming(null);
      });
    };

    const handleCancel = (event?: KeyboardEvent): void => {
      if (released || (event && event.key !== "Escape")) return;
      released = true;
      gestureReleasedRef.current = true;
      cancelTimelineGesture();
      gestureActiveRef.current = false;
      restorePreview();
      restoreBodyStyles();
      setIsTrimming(null);
    };
    const handleWindowBlur = (): void => handleCancel();
    const handleKeyDown = (event: KeyboardEvent): void => handleCancel(event);

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("blur", handleWindowBlur);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      if (!released) handleCancel();
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("blur", handleWindowBlur);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isTrimming, textClip.id, pixelsPerSecond, onTrim]);

  const isInteracting = isDragging || isTrimming;
  const contextMenuItems = useGraphicsClipContextMenuItems({
    clip: textClip,
    clipType: "text",
  });

  return (
    <ContextMenu items={contextMenuItems} menuWidth={200} size="sm">
        <div
          ref={clipRef}
          data-live-editor-target-kind="text"
          data-live-editor-target-id={textClip.id}
          role="button"
          tabIndex={0}
          aria-label={`Select text clip ${textClip.text || "Text"}`}
          aria-pressed={isSelected}
          onClick={handleClick}
          onMouseDown={handleMouseDown}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            onSelect(textClip.id, event.shiftKey || event.metaKey || event.ctrlKey);
          }}
          className={`absolute top-1 bottom-1 rounded-lg overflow-hidden cursor-grab group ${
            isDragging ? "cursor-grabbing opacity-75" : ""
          } ${
            isSelected
              ? "ring-2 ring-amber-400 border-amber-400 z-10"
              : "border-amber-500/30 hover:border-amber-500/60 hover:brightness-110"
          } bg-amber-500/20 border`}
          style={{
            transform: `translateX(${left}px)`,
            width: `${Math.max(width, 40)}px`,
            willChange: isInteracting ? 'transform, width' : 'auto',
            transition: isInteracting ? 'none' : 'opacity 150ms, box-shadow 150ms',
          }}
        >
          <AgentReferenceBadge kind="text" entityId={textClip.id} />
          <ProjectMarkerBadgeStack markers={reviewMarkers} selected={isSelected} />
          <div
            className={`absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize z-20 flex items-center justify-center transition-opacity ${
              isSelected ? "opacity-100 bg-amber-400" : "opacity-0 group-hover:opacity-100 hover:bg-amber-400/50"
            }`}
            style={{ borderRadius: "6px 0 0 6px" }}
            onMouseDown={(e) => handleTrimStart(e, "left")}
          >
            {isSelected && <div className="w-0.5 h-3 bg-amber-900/60 rounded-full" />}
          </div>
          <div
            className={`absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize z-20 flex items-center justify-center transition-opacity ${
              isSelected ? "opacity-100 bg-amber-400" : "opacity-0 group-hover:opacity-100 hover:bg-amber-400/50"
            }`}
            style={{ borderRadius: "0 6px 6px 0" }}
            onMouseDown={(e) => handleTrimStart(e, "right")}
          >
            {isSelected && <div className="w-0.5 h-3 bg-amber-900/60 rounded-full" />}
          </div>
          <div className="w-full h-full flex items-center gap-1 px-3">
            <Type size={12} className="text-fg-2 flex-shrink-0" />
            <span className="text-[10px] font-semibold text-fg truncate">
              {textClip.text || "Text"}
            </span>
          </div>
          {isSelected && (
            <div className="absolute inset-0 border-2 border-amber-400 rounded-lg pointer-events-none" />
          )}
        </div>
    </ContextMenu>
  );
};
