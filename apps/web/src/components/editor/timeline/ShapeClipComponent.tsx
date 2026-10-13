import React, { useRef, useState, useEffect } from "react";
import { ToolcraftContextMenu as ContextMenu } from "@reelterminal/ui";
import { Shapes, FileCode, Smile } from "@/icons/lucide-compat";
import type { ShapeClip, SVGClip, StickerClip } from "@reelterminal/core";
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

type GraphicClipUnion = ShapeClip | SVGClip | StickerClip;

interface ShapeClipComponentProps {
  shapeClip: GraphicClipUnion;
  pixelsPerSecond: number;
  isSelected: boolean;
  onSelect: (clipId: string, addToSelection: boolean) => void;
  onTrim: (clipId: string, edge: "left" | "right", newTime: number) => Promise<boolean> | boolean;
  onMoveClip: (clipId: string, newStartTime: number) => Promise<boolean> | boolean;
}

export const ShapeClipComponent: React.FC<ShapeClipComponentProps> = ({
  shapeClip,
  pixelsPerSecond,
  isSelected,
  onSelect,
  onTrim,
  onMoveClip,
}) => {
  const clipRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const [isTrimming, setIsTrimming] = useState<"left" | "right" | null>(null);
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
    clipId: shapeClip.id,
  });
  const trimStartRef = useRef<{
    mouseX: number;
    startTime: number;
    duration: number;
  }>({
    mouseX: 0,
    startTime: shapeClip.startTime,
    duration: shapeClip.duration,
  });

  const left = shapeClip.startTime * pixelsPerSecond;
  const width = shapeClip.duration * pixelsPerSecond;

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (useProjectStore.getState().readOnlyPreview) {
      e.stopPropagation();
      onSelect(shapeClip.id, e.shiftKey || e.metaKey || e.ctrlKey);
      return;
    }
    if (isTrimming || gestureActiveRef.current) return;
    e.stopPropagation();

    const rect = clipRef.current?.getBoundingClientRect();
    if (!rect) return;

    const offsetX = e.clientX - rect.left;
    setDragOffset(offsetX);
    previewStartTimeRef.current = shapeClip.startTime;
    gestureActiveRef.current = true;
    gestureReleasedRef.current = false;
    setIsDragging(true);
    beginTimelineGesture("input.graphics-drag");
    onSelect(shapeClip.id, e.shiftKey || e.metaKey || e.ctrlKey);
  };

  const handleClick = (e: React.MouseEvent) => {
    // Selection is committed on mouse-down so drag gestures feel immediate.
    // Keep the resulting click from reaching the lane and clearing it.
    e.stopPropagation();
  };

  const handleTrimStart = (e: React.MouseEvent, edge: "left" | "right") => {
    if (e.button !== 0 || gestureActiveRef.current) return;
    if (useProjectStore.getState().readOnlyPreview) return;
    e.stopPropagation();
    e.preventDefault();
    setIsTrimming(edge);
    gestureActiveRef.current = true;
    gestureReleasedRef.current = false;
    trimPreviewRef.current = null;
    beginTimelineGesture("input.graphics-trim");
    trimStartRef.current = {
      mouseX: e.clientX,
      startTime: shapeClip.startTime,
      duration: shapeClip.duration,
    };
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
  };

  useEffect(() => {
    if (!isDragging || gestureReleasedRef.current) return;
    let released = false;

    const restorePreview = (): void => {
      previewStartTimeRef.current = null;
      if (clipRef.current) {
        const originalStartTime = shapeClip.startTime;
        clipRef.current.style.transform = `translateX(${originalStartTime * pixelsPerSecond}px)`;
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (released) return;
      recordTimelineInput();
      const timelineElement = clipRef.current?.parentElement;
      if (!timelineElement) return;

      const rect = timelineElement.getBoundingClientRect();
      const x = e.clientX - rect.left - dragOffset;
      const rawTime = Math.max(0, x / pixelsPerSecond);
      const allTracks = useProjectStore.getState().project.timeline.tracks;
      const dragSnapSettings = { ...snapSettings, snapToPlayhead: false };
      const snapResult = calculateSnap(
        rawTime,
        shapeClip.id,
        allTracks,
        playheadPosition,
        dragSnapSettings,
        pixelsPerSecond,
        shapeClip.duration,
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
      if (newStartTime === null || newStartTime === shapeClip.startTime) {
        cancelTimelineGesture(gestureOperation);
        gestureActiveRef.current = false;
        restorePreview();
        setIsDragging(false);
        return;
      }
      void Promise.resolve().then(() => onMoveClip(shapeClip.id, newStartTime)).then(
        (committed) => {
          if (committed) finishTimelineGesture(useProjectStore.getState().projectRevision, gestureOperation);
          else {
            cancelTimelineGesture(gestureOperation);
            restorePreview();
            toast.error("Could not move graphic clip", "The change could not be saved.");
          }
        },
        (error: unknown) => {
          cancelTimelineGesture(gestureOperation);
          restorePreview();
          toast.error("Could not move graphic clip", error instanceof Error ? error.message : "The change could not be saved.");
        },
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
      restorePreview();
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
  }, [isDragging, dragOffset, pixelsPerSecond, shapeClip.id, shapeClip.startTime, shapeClip.duration, onMoveClip, snapSettings, playheadPosition]);

  useEffect(() => {
    if (!isTrimming || gestureReleasedRef.current) return;
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
      if (released) return;
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
      const originalTime = isTrimming === "left"
        ? trimStartRef.current.startTime
        : trimStartRef.current.startTime + trimStartRef.current.duration;
      if (!preview || preview.newTime === originalTime) {
        cancelTimelineGesture(gestureOperation);
        gestureActiveRef.current = false;
        restorePreview();
        return;
      }
      void Promise.resolve().then(() => onTrim(shapeClip.id, isTrimming, preview.newTime)).then(
        (committed) => {
          if (committed) finishTimelineGesture(useProjectStore.getState().projectRevision, gestureOperation);
          else {
            cancelTimelineGesture(gestureOperation);
            restorePreview();
            toast.error("Could not trim graphic clip", "The change could not be saved.");
          }
        },
        (error: unknown) => {
          cancelTimelineGesture(gestureOperation);
          restorePreview();
          toast.error("Could not trim graphic clip", error instanceof Error ? error.message : "The change could not be saved.");
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
  }, [isTrimming, shapeClip.id, pixelsPerSecond, onTrim]);

  const isShape = shapeClip.type === "shape";
  const isSticker = shapeClip.type === "sticker" || shapeClip.type === "emoji";
  const shapeLabel =
    isShape && "shapeType" in shapeClip
      ? shapeClip.shapeType.charAt(0).toUpperCase() +
        shapeClip.shapeType.slice(1)
      : isSticker
        ? shapeClip.type === "emoji"
          ? "Emoji"
          : "Sticker"
        : "SVG";
  const IconComponent = isShape ? Shapes : isSticker ? Smile : FileCode;
  const colorClass = isShape ? "green" : isSticker ? "pink" : "green";

  const isInteracting = isDragging || isTrimming;
  const clipType = isShape ? "shape" : isSticker ? (shapeClip.type === "emoji" ? "emoji" : "sticker") : "svg";
  const contextMenuItems = useGraphicsClipContextMenuItems({
    clip: shapeClip,
    clipType,
  });

  return (
    <ContextMenu items={contextMenuItems} menuWidth={200} size="sm">
        <div
          ref={clipRef}
          data-live-editor-target-kind="clip"
          data-live-editor-target-id={shapeClip.id}
          role="button"
          tabIndex={0}
          aria-label={`Select ${shapeLabel} clip`}
          aria-pressed={isSelected}
          onClick={handleClick}
          onMouseDown={handleMouseDown}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            onSelect(shapeClip.id, event.shiftKey || event.metaKey || event.ctrlKey);
          }}
          className={`absolute top-1 bottom-1 rounded-lg overflow-hidden cursor-grab group ${
            isDragging ? "cursor-grabbing opacity-75" : ""
          } ${
            isSelected
              ? `ring-2 ring-${colorClass}-400 border-${colorClass}-400 z-10`
              : `border-${colorClass}-500/30 hover:border-${colorClass}-500/60 hover:brightness-110`
          } bg-${colorClass}-500/20 border`}
          style={{
            transform: `translateX(${left}px)`,
            width: `${Math.max(width, 40)}px`,
            willChange: isInteracting ? 'transform, width' : 'auto',
            transition: isInteracting ? 'none' : 'opacity 150ms, box-shadow 150ms',
          }}
        >
          <AgentReferenceBadge kind="media" entityId={shapeClip.id} />
          <ProjectMarkerBadgeStack markers={reviewMarkers} selected={isSelected} />
          <div
            className={`absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize z-20 flex items-center justify-center transition-opacity ${
              isSelected ? "opacity-100 bg-green-400" : `opacity-0 group-hover:opacity-100 hover:bg-${colorClass}-400/50`
            }`}
            style={{ borderRadius: "6px 0 0 6px" }}
            onMouseDown={(e) => handleTrimStart(e, "left")}
          >
            {isSelected && <div className="w-0.5 h-3 bg-green-900/60 rounded-full" />}
          </div>
          <div
            className={`absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize z-20 flex items-center justify-center transition-opacity ${
              isSelected ? "opacity-100 bg-green-400" : `opacity-0 group-hover:opacity-100 hover:bg-${colorClass}-400/50`
            }`}
            style={{ borderRadius: "0 6px 6px 0" }}
            onMouseDown={(e) => handleTrimStart(e, "right")}
          >
            {isSelected && <div className="w-0.5 h-3 bg-green-900/60 rounded-full" />}
          </div>
          <div className="w-full h-full flex items-center gap-1 px-3">
            <IconComponent
              size={12}
              className={`text-${colorClass}-400 flex-shrink-0`}
            />
            <span
              className={`text-[10px] font-medium text-${colorClass}-200 truncate`}
            >
              {shapeLabel}
            </span>
          </div>
          {isSelected && (
            <div className="absolute inset-0 border-2 border-green-400 rounded-lg pointer-events-none" />
          )}
        </div>
    </ContextMenu>
  );
};
