import React, { useRef, useState, useEffect, useCallback } from "react";
import { ToolcraftContextMenu as ContextMenu } from "@reelterminal/ui";
import { Box, Image, Layers } from "@/icons/lucide-compat";
import type { Clip, Track, TransitionType } from "@reelterminal/core";
import { useProjectStore } from "../../../stores/project-store";
import { useUIStore } from "../../../stores/ui-store";
import { useTimelineStore } from "../../../stores/timeline-store";
import { calculateSnap, getClipStyle } from "./utils";
import { useClipContextMenuItems } from "./ClipContextMenu";
import { toast } from "../../../stores/notification-store";
import { getTransitionBridge } from "../../../bridges/transition-bridge";
import {
  EFFECT_DRAG_MIME,
  TRANSITION_DRAG_MIME,
} from "../panels/EffectsTransitionsPanel";
import { parseEditorEffectDropPayload } from "./effect-drop";
import { AgentReferenceBadge } from "./AgentReferenceBadge";
import { ProjectMarkerBadgeStack } from "../ProjectMarkerBadge";
import { findMarkersForEntity } from "../../../stores/project/project-marker-selectors";
import { agentReferenceKindForTrack } from "../../../stores/agent-reference-targets";
import { beginTimelineGesture, recordTimelineInput, recordTimelineGestureRelease, finishTimelineGesture, cancelTimelineGesture } from "../../../performance/product-flow";

interface ClipComponentProps {
  clip: Clip;
  track: Track;
  allTracks: Track[];
  pixelsPerSecond: number;
  isSelected: boolean;
  trackHeights: Map<string, number>;
  timelineRef: React.RefObject<HTMLDivElement | null>;
  onSelect: (clipId: string, addToSelection: boolean) => void;
  onCommitMoveClips: (
    moves: Array<{ clipId: string; startTime: number; trackId?: string }>,
  ) => Promise<boolean> | boolean;
  onSnapIndicator: (time: number | null) => void;
  onTrimClip?: (
    clipId: string,
    edge: "left" | "right",
    newTime: number,
  ) => Promise<boolean> | boolean;
}

const AUTO_SCROLL_THRESHOLD = 80;
const AUTO_SCROLL_SPEED = 10;
const DRAG_THRESHOLD = 5;

export const ClipComponent: React.FC<ClipComponentProps> = ({
  clip,
  track,
  allTracks,
  pixelsPerSecond,
  isSelected,
  trackHeights,
  timelineRef,
  onSelect,
  onCommitMoveClips,
  onSnapIndicator,
  onTrimClip,
}) => {
  const { getMediaItem } = useProjectStore();
  const projectMarkers = useProjectStore((state) => state.project.markers);
  const reviewMarkers = findMarkersForEntity(projectMarkers, {
    clipId: clip.id,
  });
  const { snapSettings } = useUIStore();
  const effectApplicationClipId = useUIStore(
    (state) => state.effectApplicationClipId,
  );
  const effectApplicationLabel = useUIStore(
    (state) => state.effectApplicationLabel,
  );
  const mediaItem = getMediaItem(clip.mediaId);
  const motionCompositionId =
    typeof clip.metadata?.motionCompositionId === "string"
      ? clip.metadata.motionCompositionId
      : undefined;
  const motionComposition = useProjectStore((state) =>
    motionCompositionId
      ? (state.project.motionCompositions ?? []).find(
          (composition) => composition.id === motionCompositionId,
        )
      : undefined,
  );
  const compoundClipId =
    typeof clip.metadata?.compoundClipId === "string"
      ? clip.metadata.compoundClipId
      : undefined;
  const isCompoundClip = Boolean(compoundClipId);
  const [isDragging, setIsDragging] = useState(false);
  const [isPendingDrag, setIsPendingDrag] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const [isInvalidDrop, setIsInvalidDrop] = useState(false);
  const [isTrimming, setIsTrimming] = useState(false);
  const [trimEdge, setTrimEdge] = useState<"left" | "right" | null>(null);
  // Snapshot of every additional selected clip at drag start. Multi-clip
  // drag applies the same time delta to each entry so they stay locked
  // together as the dragged clip moves.
  const multiDragSnapshotRef = useRef<
    Array<{ clipId: string; startTime: number; trackId: string }>
  >([]);
  const trimStartRef = useRef<{
    mouseX: number;
    startTime: number;
    duration: number;
  }>({
    mouseX: 0,
    startTime: clip.startTime,
    duration: clip.duration,
  });
  const dragStartRef = useRef<{ mouseY: number; clipY: number; scrollTop: number }>({
    mouseY: 0,
    clipY: 0,
    scrollTop: 0,
  });
  const mousePositionRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const pendingDropRef = useRef<{ time: number; targetTrackId?: string }>({ time: 0 });
  const dragPendingRef = useRef<{ active: boolean; startX: number; startY: number }>({
    active: false,
    startX: 0,
    startY: 0,
  });
  const clipRef = useRef<HTMLDivElement>(null);
  const contextMenuItems = useClipContextMenuItems({ clip, track });
  const dragPreviewElementsRef = useRef(new Map<string, {
    element: HTMLElement;
    startTime: number;
  }>());
  const trimPreviewRef = useRef<{
    newTime: number;
    startTime: number;
    duration: number;
  } | null>(null);
  const gestureActiveRef = useRef(false);
  const gestureReleasedRef = useRef(false);

  // Drag-drop highlight state: "effect" when an effect is hovered over
  // the clip body, "transition-left" / "transition-right" when a
  // transition is hovered over one of the clip's edges.
  const [dragHover, setDragHover] = useState<
    "effect" | "transition-left" | "transition-right" | null
  >(null);

  const left = clip.startTime * pixelsPerSecond;
  const width = clip.duration * pixelsPerSecond;

  const isVideo = track.type === "video";
  const isAudio = track.type === "audio";
  const isImage = track.type === "image";
  const isMotionClip = Boolean(clip.metadata?.motionClip);
  const clipStyle = getClipStyle(track.type);

  const handleClick = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (useProjectStore.getState().readOnlyPreview) {
      e.stopPropagation();
      onSelect(clip.id, e.shiftKey || e.metaKey || e.ctrlKey);
      return;
    }
    if (isDragging || isPendingDrag) return;
    e.stopPropagation();
    onSelect(clip.id, e.shiftKey || e.metaKey);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (useProjectStore.getState().readOnlyPreview) {
      e.stopPropagation();
      return;
    }
    if (track.locked || isTrimming) return;
    e.stopPropagation();

    const rect = clipRef.current?.parentElement?.getBoundingClientRect();
    const clipRect = clipRef.current?.getBoundingClientRect();
    if (!rect || !clipRect) return;

    const clickX = e.clientX - rect.left;
    const clipStartX = clip.startTime * pixelsPerSecond;
    setDragOffset(clickX - clipStartX);

    dragStartRef.current = {
      mouseY: e.clientY,
      clipY: clipRect.top - rect.top,
      scrollTop: timelineRef.current?.scrollTop || 0,
    };
    mousePositionRef.current = { x: e.clientX, y: e.clientY };
    dragPendingRef.current = { active: true, startX: e.clientX, startY: e.clientY };
    pendingDropRef.current = { time: clip.startTime };
    setIsInvalidDrop(false);
    setIsPendingDrag(true);
    gestureActiveRef.current = true;
    gestureReleasedRef.current = false;
    beginTimelineGesture("input.media-drag");

    // If this clip is part of a multi-selection, snapshot the other
    // selected clips' start positions so we can drag them as a group.
    const selectedIds = useUIStore.getState().getSelectedClipIds();
    if (selectedIds.length > 1 && selectedIds.includes(clip.id)) {
      const snapshot: Array<{ clipId: string; startTime: number; trackId: string }> = [];
      for (const t of allTracks) {
        for (const c of t.clips) {
          if (c.id === clip.id) continue;
          if (!selectedIds.includes(c.id)) continue;
          if (t.locked) continue;
          snapshot.push({ clipId: c.id, startTime: c.startTime, trackId: t.id });
        }
      }
      multiDragSnapshotRef.current = snapshot;
    } else {
      multiDragSnapshotRef.current = [];
    }
  };

  // ── Drag-drop: effects & transitions from the assets panel ────
  // The asset cards set custom MIME types so we know which mode to use.
  // For effects the drop hits anywhere on the clip body. For transitions
  // we treat the outer ~25% of the clip's width as an "edge zone" — the
  // closer edge wins, and we map left edge → incoming, right edge →
  // outgoing transition.
  const readDragKind = (e: React.DragEvent): "effect" | "transition" | null => {
    const types = e.dataTransfer.types;
    if (types.includes(EFFECT_DRAG_MIME)) return "effect";
    if (types.includes(TRANSITION_DRAG_MIME)) return "transition";
    // text/plain fallback (some browsers don't preserve custom types)
    if (types.includes("text/plain")) {
      // Can't read data during dragover; trust the parsed kind by
      // payload sniffing on drop. We optimistically allow both here.
      return null;
    }
    return null;
  };

  const computeTransitionEdge = useCallback(
    (e: React.DragEvent): "transition-left" | "transition-right" => {
      const rect = clipRef.current?.getBoundingClientRect();
      if (!rect) return "transition-right";
      const ratio = (e.clientX - rect.left) / rect.width;
      return ratio < 0.5 ? "transition-left" : "transition-right";
    },
    [],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      const kind = readDragKind(e);
      if (kind === null) {
        // Don't preventDefault — let other handlers (e.g. timeline file
        // drop) take over.
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
      if (kind === "effect") {
        setDragHover("effect");
      } else {
        setDragHover(computeTransitionEdge(e));
      }
    },
    [computeTransitionEdge],
  );

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // Only clear when the pointer actually exits the clip — dragleave
    // fires on every child too.
    const related = e.relatedTarget as Node | null;
    if (!related || !clipRef.current?.contains(related)) {
      setDragHover(null);
    }
  }, []);

  const applyTransitionAt = useCallback(
    (
      transitionType: TransitionType,
      edge: "left" | "right",
      transitionParams?: Record<string, unknown>,
    ) => {
      const projectState = useProjectStore.getState();
      const tracks = projectState.project.timeline.tracks;
      const owningTrack = tracks.find((t) =>
        t.clips.some((c) => c.id === clip.id),
      );
      if (!owningTrack) return;
      const sortedClips = [...owningTrack.clips].sort((a, b) => {
        if (a.startTime !== b.startTime) return a.startTime - b.startTime;
        return a.id.localeCompare(b.id);
      });
      const idx = sortedClips.findIndex((c) => c.id === clip.id);
      const previousClip = idx > 0 ? sortedClips[idx - 1] : undefined;
      const nextClip =
        idx < sortedClips.length - 1 ? sortedClips[idx + 1] : undefined;
      const clipA = edge === "left" ? previousClip : sortedClips[idx];
      const clipB = edge === "left" ? sortedClips[idx] : nextClip;

      const bridge = getTransitionBridge();
      if (!bridge.isInitialized()) {
        toast.error("Transition engine not ready", "Try again in a moment.");
        return;
      }
      const defaultParams = {
        ...bridge.getDefaultParams(transitionType),
        ...transitionParams,
      };
      const result =
        clipA && clipB
          ? bridge.createTransition(
              clipA,
              clipB,
              transitionType,
              1.0,
              defaultParams,
            )
          : bridge.createClipEdgeTransition(
              sortedClips[idx],
              edge === "left" ? "in" : "out",
              transitionType,
              1.0,
              defaultParams,
            );
      if (result.success && result.transitionId) {
        const transition = bridge.getTransition(result.transitionId);
        if (transition) {
          projectState.addClipTransition(transition);
          toast.success(
            transition.edge === "in"
              ? "Intro transition applied"
              : transition.edge === "out"
                ? "Outro transition applied"
                : "Transition applied",
            `${transitionType} • ${transition.duration.toFixed(1)}s`,
          );
          return;
        }
      }
      toast.error(
        "Transition failed",
        result.error || "Could not create transition",
      );
    },
    [clip.id],
  );

  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      setDragHover(null);

      const tryParse = <T,>(s: string | null): T | null => {
        if (!s) return null;
        try {
          return JSON.parse(s) as T;
        } catch {
          return null;
        }
      };

      const text = e.dataTransfer.getData("text/plain");
      const effectPayload = parseEditorEffectDropPayload(
        e.dataTransfer.getData(EFFECT_DRAG_MIME) || null,
        text,
      );
      const transitionPayload = tryParse<{
        transitionType: TransitionType;
        transitionParams?: Record<string, unknown>;
      }>(
        e.dataTransfer.getData(TRANSITION_DRAG_MIME) || null,
      );
      const isTransitionByText = text.startsWith("transition:");

      const effectType = effectPayload?.effectType ?? null;
      const transitionType =
        transitionPayload?.transitionType ??
        (isTransitionByText ? (text.slice(11) as TransitionType) : null);

      if (!effectType && !transitionType) {
        // Not for us — let the timeline's outer drop handler take it.
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      if (effectType) {
        const result = await useProjectStore
          .getState()
          .addVideoEffect(clip.id, effectType, effectPayload?.effectParams);
        if (result) {
          toast.success("Effect applied", `${effectType} added`);
          // Auto-select the clip so the user sees the new effect in
          // the inspector.
          useUIStore.getState().select({ id: clip.id, type: "clip" });
        } else {
          toast.error("Effect failed", "Could not apply effect");
        }
        return;
      }

      if (transitionType) {
        const edge = computeTransitionEdge(e).endsWith("left") ? "left" : "right";
        applyTransitionAt(
          transitionType,
          edge,
          transitionPayload?.transitionParams,
        );
      }
    },
    [clip.id, applyTransitionAt, computeTransitionEdge],
  );

  const handleTrimMouseDown =
      (edge: "left" | "right") => (e: React.MouseEvent) => {
        if (e.button !== 0) return;
        if (useProjectStore.getState().readOnlyPreview) return;
        if (track.locked || !onTrimClip) return;
      e.stopPropagation();
      setIsTrimming(true);
      beginTimelineGesture("input.media-trim");
      setTrimEdge(edge);
      gestureActiveRef.current = true;
      gestureReleasedRef.current = false;
      trimStartRef.current = {
        mouseX: e.clientX,
        startTime: clip.startTime,
        duration: clip.duration,
      };
      document.body.style.cursor = "ew-resize";
    };

  useEffect(() => {
    if (!isPendingDrag) return;

    const handlePendingMouseMove = (e: MouseEvent) => {
      recordTimelineInput();
      const dx = e.clientX - dragPendingRef.current.startX;
      const dy = e.clientY - dragPendingRef.current.startY;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance >= DRAG_THRESHOLD) {
        dragPendingRef.current.active = false;
        setIsPendingDrag(false);
        setIsDragging(true);
      }
    };

    const handlePendingMouseUp = (e: MouseEvent) => {
      gestureActiveRef.current = false;
      gestureReleasedRef.current = true;
      cancelTimelineGesture();
      dragPendingRef.current.active = false;
      setIsPendingDrag(false);
      onSelect(clip.id, e.shiftKey || e.metaKey);
    };

    const handleCancel = (event?: KeyboardEvent) => {
      if (event && event.key !== "Escape") return;
      if (!gestureActiveRef.current) return;
      gestureActiveRef.current = false;
      gestureReleasedRef.current = true;
      dragPendingRef.current.active = false;
      setIsPendingDrag(false);
      cancelTimelineGesture();
    };

    const handleWindowBlur = () => handleCancel();
    const handleKeyDown = (event: KeyboardEvent) => handleCancel(event);

    window.addEventListener("mousemove", handlePendingMouseMove);
    window.addEventListener("mouseup", handlePendingMouseUp);
    window.addEventListener("blur", handleWindowBlur);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("mousemove", handlePendingMouseMove);
      window.removeEventListener("mouseup", handlePendingMouseUp);
      window.removeEventListener("blur", handleWindowBlur);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isPendingDrag, clip.id, onSelect]);

  useEffect(() => () => {
    if (gestureActiveRef.current) {
      gestureActiveRef.current = false;
      cancelTimelineGesture();
    }
    document.body.style.cursor = "";
  }, []);

  useEffect(() => {
    if (!isDragging || gestureReleasedRef.current) return;
    let animationFrameId: number | null = null;
    let released = false;
    const companions = multiDragSnapshotRef.current;
    const companionElements = new Map<string, HTMLElement>();
    for (const element of timelineRef.current?.querySelectorAll<HTMLElement>(
      '[data-live-editor-target-kind="clip"][data-live-editor-target-id]',
    ) ?? []) {
      const id = element.dataset.liveEditorTargetId;
      if (id && companions.some((companion) => companion.clipId === id)) {
        companionElements.set(id, element);
      }
    }
    dragPreviewElementsRef.current = new Map(
      companions.flatMap((companion) => {
        const element = companionElements.get(companion.clipId);
        return element ? [[companion.clipId, { element, startTime: companion.startTime }] as const] : [];
      }),
    );

    const applyDragPreview = (startTime: number, yOffset: number): void => {
      if (clipRef.current) {
        clipRef.current.style.transform = `translate(${startTime * pixelsPerSecond}px, ${yOffset}px)`;
      }
      const delta = startTime - clip.startTime;
      for (const { element, startTime: companionStart } of dragPreviewElementsRef.current.values()) {
        element.style.transform = `translateX(${Math.max(0, companionStart + delta) * pixelsPerSecond}px)`;
      }
    };

    const resetDragPreview = (): void => {
      if (clipRef.current) {
        clipRef.current.style.transform = `translateX(${left}px)`;
        clipRef.current.style.width = `${width}px`;
      }
      for (const { element, startTime } of dragPreviewElementsRef.current.values()) {
        element.style.transform = `translateX(${startTime * pixelsPerSecond}px)`;
      }
      dragPreviewElementsRef.current.clear();
    };

    const scrollLoop = () => {
      if (released) return;
      if (!timelineRef.current) {
        animationFrameId = requestAnimationFrame(scrollLoop);
        return;
      }

      const timeline = timelineRef.current;
      const timelineRect = timeline.getBoundingClientRect();
      const mouseY = mousePositionRef.current.y;
      const timelineTop = timelineRect.top;
      const timelineBottom = timelineRect.bottom;
      const canScrollUp = timeline.scrollTop > 0;
      const canScrollDown = timeline.scrollTop < timeline.scrollHeight - timeline.clientHeight;

      const distanceFromTop = mouseY - timelineTop;
      const distanceFromBottom = timelineBottom - mouseY;

      if (distanceFromTop < AUTO_SCROLL_THRESHOLD && canScrollUp) {
        timeline.scrollTop -= AUTO_SCROLL_SPEED;
      } else if (distanceFromBottom < AUTO_SCROLL_THRESHOLD && canScrollDown) {
        timeline.scrollTop += AUTO_SCROLL_SPEED;
      }

      animationFrameId = requestAnimationFrame(scrollLoop);
    };

    animationFrameId = requestAnimationFrame(scrollLoop);

    const handleMouseMove = (e: MouseEvent) => {
      if (released) return;
      recordTimelineInput();
      mousePositionRef.current.x = e.clientX;
      mousePositionRef.current.y = e.clientY;

      const rect = clipRef.current?.parentElement?.getBoundingClientRect();
      const timelineRect = timelineRef.current?.getBoundingClientRect();
      if (!rect || !timelineRect) return;

      const x = e.clientX - rect.left - dragOffset;
      const rawTime = Math.max(0, x / pixelsPerSecond);

      const dragSnapSettings = { ...snapSettings, snapToPlayhead: false };
      const snapResult = calculateSnap(
        rawTime,
        clip.id,
        allTracks,
        useTimelineStore.getState().playheadPosition,
        dragSnapSettings,
        pixelsPerSecond,
        clip.duration,
      );
      const currentScrollTop = timelineRef.current?.scrollTop || 0;
      const scrollDelta = currentScrollTop - dragStartRef.current.scrollTop;
      const yDelta = (e.clientY - dragStartRef.current.mouseY) + scrollDelta;

      const scrollTop = timelineRef.current?.scrollTop || 0;
      const mouseY = e.clientY - timelineRect.top + scrollTop;
      let targetTrackId: string | undefined;
      let hoveredTrackType: string | undefined;
      let cumulativeY = 0;

      for (const t of allTracks) {
        const height = trackHeights.get(t.id) || 48;
        if (mouseY >= cumulativeY && mouseY < cumulativeY + height) {
          hoveredTrackType = t.type;
          if (t.type === track.type && t.id !== track.id) {
            targetTrackId = t.id;
          }
          break;
        }
        cumulativeY += height;
      }

      const isOverDifferentTrackType = hoveredTrackType !== undefined && hoveredTrackType !== track.type;
      setIsInvalidDrop((previous) => previous === isOverDifferentTrackType ? previous : isOverDifferentTrackType);

      pendingDropRef.current = { time: snapResult.time, targetTrackId };
      applyDragPreview(snapResult.time, yDelta);

      onSnapIndicator(snapResult.snapped && snapResult.snapPoint ? snapResult.snapPoint.time : null);
    };

    const handleMouseUp = () => {
      if (released) return;
      released = true;
      gestureReleasedRef.current = true;
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }

      const { time, targetTrackId } = pendingDropRef.current;
      const candidateMoves: Array<{ clipId: string; startTime: number; trackId?: string }> = [
        { clipId: clip.id, startTime: time, ...(targetTrackId ? { trackId: targetTrackId } : {}) },
        ...companions.map((snap) => ({
          clipId: snap.clipId,
          startTime: Math.max(0, snap.startTime + time - clip.startTime),
        })),
      ];
      const moves = candidateMoves.filter((move) => {
        const current = move.clipId === clip.id
          ? { startTime: clip.startTime, trackId: clip.trackId }
          : companions.find((companion) => companion.clipId === move.clipId);
        return current !== undefined && (
          move.startTime !== current.startTime ||
          (move.trackId !== undefined && move.trackId !== current.trackId)
        );
      });

      setIsInvalidDrop(false);
      onSnapIndicator(null);
      multiDragSnapshotRef.current = [];
      gestureActiveRef.current = false;

      if (moves.length === 0) {
        cancelTimelineGesture();
        resetDragPreview();
        setIsDragging(false);
        return;
      }

      const gestureOperation = recordTimelineGestureRelease();
      void Promise.resolve(onCommitMoveClips(moves)).then(
        (committed) => {
          if (committed) {
            finishTimelineGesture(useProjectStore.getState().projectRevision, gestureOperation);
          } else {
            cancelTimelineGesture(gestureOperation);
            resetDragPreview();
          }
        },
        (error: unknown) => {
          cancelTimelineGesture(gestureOperation);
          resetDragPreview();
          toast.error("Could not move clip", error instanceof Error ? error.message : "The change could not be saved.");
        },
      ).finally(() => {
        setIsDragging(false);
        setIsInvalidDrop(false);
      });
    };

    const handleCancel = (event?: KeyboardEvent): void => {
      if (released || (event && event.key !== "Escape")) return;
      released = true;
      gestureReleasedRef.current = true;
      if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
      gestureActiveRef.current = false;
      cancelTimelineGesture();
      resetDragPreview();
      multiDragSnapshotRef.current = [];
      setIsDragging(false);
      setIsInvalidDrop(false);
      onSnapIndicator(null);
    };
    const handleWindowBlur = (): void => handleCancel();
    const handleKeyDown = (event: KeyboardEvent): void => handleCancel(event);

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("blur", handleWindowBlur);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
      }
      if (!released) handleCancel();
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("blur", handleWindowBlur);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    isDragging,
    dragOffset,
    pixelsPerSecond,
    clip.id,
    clip.startTime,
    clip.duration,
    track.id,
    track.type,
    left,
    width,
    allTracks,
    trackHeights,
    timelineRef,
    snapSettings,
    onCommitMoveClips,
    onSnapIndicator,
  ]);

  useEffect(() => {
    if (!isTrimming || !trimEdge || !onTrimClip || gestureReleasedRef.current) return;
    let released = false;

    const resetTrimPreview = (): void => {
      trimPreviewRef.current = null;
      if (clipRef.current) {
        clipRef.current.style.transform = `translateX(${left}px)`;
        clipRef.current.style.width = `${width}px`;
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (released) return;
      recordTimelineInput();
      const deltaX = e.clientX - trimStartRef.current.mouseX;
      const deltaTime = deltaX / pixelsPerSecond;

      let newTime: number;
      let startTime = trimStartRef.current.startTime;
      let duration: number;
      if (trimEdge === "left") {
        const newStartTime = Math.max(
          0,
          trimStartRef.current.startTime + deltaTime,
        );
        const maxStartTime =
          trimStartRef.current.startTime + trimStartRef.current.duration - 0.1;
        const clampedStartTime = Math.min(newStartTime, maxStartTime);
        newTime = clampedStartTime;
        startTime = clampedStartTime;
        duration = trimStartRef.current.startTime + trimStartRef.current.duration - clampedStartTime;
      } else {
        const newEndTime =
          trimStartRef.current.startTime +
          trimStartRef.current.duration +
          deltaTime;
        const minEndTime = trimStartRef.current.startTime + 0.1;
        const clampedEndTime = Math.max(newEndTime, minEndTime);
        newTime = clampedEndTime;
        duration = clampedEndTime - trimStartRef.current.startTime;
      }
      trimPreviewRef.current = { newTime, startTime, duration };
      if (clipRef.current) {
        clipRef.current.style.transform = `translateX(${startTime * pixelsPerSecond}px)`;
        clipRef.current.style.width = `${duration * pixelsPerSecond}px`;
      }
    };

    const handleMouseUp = () => {
      if (released) return;
      released = true;
      gestureReleasedRef.current = true;
      const preview = trimPreviewRef.current;
      const originalTime = trimEdge === "left"
        ? trimStartRef.current.startTime
        : trimStartRef.current.startTime + trimStartRef.current.duration;
      const changed = preview !== null && preview.newTime !== originalTime;
      gestureActiveRef.current = false;
      if (!changed || !preview) {
        cancelTimelineGesture();
        resetTrimPreview();
        setIsTrimming(false);
        setTrimEdge(null);
        document.body.style.cursor = "";
        return;
      }

      const gestureOperation = recordTimelineGestureRelease();
      void Promise.resolve(onTrimClip(clip.id, trimEdge, preview.newTime)).then(
        (committed) => {
          if (committed) {
            finishTimelineGesture(useProjectStore.getState().projectRevision, gestureOperation);
          } else {
            cancelTimelineGesture(gestureOperation);
            resetTrimPreview();
          }
        },
        (error: unknown) => {
          cancelTimelineGesture(gestureOperation);
          resetTrimPreview();
          toast.error("Could not trim clip", error instanceof Error ? error.message : "The change could not be saved.");
        },
      ).finally(() => {
        setIsTrimming(false);
        setTrimEdge(null);
        document.body.style.cursor = "";
      });
    };

    const handleCancel = (event?: KeyboardEvent): void => {
      if (released || (event && event.key !== "Escape")) return;
      released = true;
      gestureReleasedRef.current = true;
      gestureActiveRef.current = false;
      cancelTimelineGesture();
      resetTrimPreview();
      setIsTrimming(false);
      setTrimEdge(null);
      document.body.style.cursor = "";
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
  }, [isTrimming, trimEdge, clip.id, pixelsPerSecond, onTrimClip, left, width]);

  const thumbnailCount = Math.max(1, Math.floor(width / 60));
  // Renamed media must show its displayName here too (parity with the
  // assets panel); without it the timeline label keeps the source filename.
  const clipName =
    motionComposition?.name ||
    (typeof clip.metadata?.compoundClipName === "string"
      ? clip.metadata.compoundClipName
      : undefined) ||
    mediaItem?.displayName ||
    mediaItem?.name ||
    clip.mediaId.slice(0, 8);

  const hasLeadingTransitionBadge = React.useMemo(() => {
    if (isAudio) return false;
    if (
      track.transitions.some(
        (transition) =>
          transition.clipAId === clip.id &&
          !transition.clipBId &&
          (transition.edge ?? "out") === "in",
      )
    ) {
      return true;
    }
    const sorted = [...track.clips].sort(
      (a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id),
    );
    const idx = sorted.findIndex((c) => c.id === clip.id);
    if (idx <= 0) return false;
    const prev = sorted[idx - 1];
    return (
      Math.abs(clip.startTime - (prev.startTime + prev.duration)) < 0.05 ||
      track.transitions.some(
        (transition) =>
          transition.clipBId === clip.id &&
          transition.clipAId === prev.id,
      )
    );
  }, [track.clips, track.transitions, clip.id, clip.startTime, isAudio]);

  const hasTrailingTransitionBadge = React.useMemo(() => {
    if (isAudio) return false;
    return track.transitions.some(
      (transition) =>
        transition.clipAId === clip.id &&
        !transition.clipBId &&
        (transition.edge ?? "out") === "out",
    );
  }, [track.transitions, clip.id, isAudio]);

  const isInteracting = isDragging || isTrimming;
  const isApplyingEffect = effectApplicationClipId === clip.id;

  return (
    <ContextMenu items={contextMenuItems} menuWidth={220} size="sm">
        <div
          ref={clipRef}
          data-live-editor-target-kind="clip"
          data-live-editor-target-id={clip.id}
          role="button"
          tabIndex={track.locked ? -1 : 0}
          aria-label={`Select clip ${clipName}`}
          aria-pressed={isSelected}
          onClick={handleClick}
          onMouseDown={handleMouseDown}
          onKeyDown={(event) => {
            if (track.locked || (event.key !== "Enter" && event.key !== " ")) return;
            event.preventDefault();
            event.stopPropagation();
            onSelect(clip.id, event.shiftKey || event.metaKey || event.ctrlKey);
          }}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`group absolute top-[7px] h-12 rounded-lg overflow-hidden ${
            isDragging
              ? `cursor-grabbing z-50 ${isInvalidDrop ? "opacity-50 ring-2 ring-red-500" : "opacity-90 shadow-lg"}`
              : "cursor-grab"
          } ${
            isSelected && !isDragging
              ? isApplyingEffect
                ? "ring-2 ring-amber-400 z-10"
                : "ring-2 ring-accent z-10"
              : !isDragging ? "hover:brightness-[1.04]" : ""
          } ${clipStyle.bg} border ${clipStyle.border} ${
            track.locked ? "cursor-not-allowed opacity-60" : ""
          }`}
          style={{
            transform: isDragging
              ? `translate(${left}px, 0px)`
              : `translateX(${left}px)`,
            width: `${width}px`,
            willChange: isInteracting ? 'transform, width' : 'auto',
            transition: isInteracting ? 'none' : 'opacity 150ms, box-shadow 150ms',
            pointerEvents: isDragging ? 'none' : 'auto',
          }}
        >
      {isApplyingEffect && (
        <>
          <div className="absolute -inset-px rounded-lg border border-amber-300/80 shadow-[0_0_18px_rgba(251,191,36,0.55)] pointer-events-none animate-pulse" />
          <div className="absolute inset-0 bg-[linear-gradient(110deg,transparent_0%,rgba(255,255,255,0.08)_28%,rgba(251,191,36,0.28)_50%,rgba(255,255,255,0.08)_72%,transparent_100%)] pointer-events-none animate-pulse" />
          <div className="absolute top-1 right-1 rounded-full bg-black/70 px-2 py-0.5 text-[9px] font-medium uppercase tracking-[0.12em] text-amber-200 pointer-events-none">
            {effectApplicationLabel ?? "Applying effect"}
          </div>
        </>
      )}

      <AgentReferenceBadge
        kind={agentReferenceKindForTrack(track.type) ?? "media"}
        entityId={clip.id}
      />
      <ProjectMarkerBadgeStack markers={reviewMarkers} selected={isSelected} />

      {/* Drag-drop hover indicators for effects/transitions */}
      {dragHover === "effect" && (
        <div className="absolute inset-0 ring-2 ring-accent ring-inset rounded-lg bg-accent/15 pointer-events-none z-20" />
      )}
      {dragHover === "transition-left" && (
        <div className="absolute inset-y-0 left-0 w-1/3 pointer-events-none z-20 bg-gradient-to-r from-accent/60 to-transparent">
          <div className="absolute left-0 top-0 bottom-0 w-1 bg-accent" />
        </div>
      )}
      {dragHover === "transition-right" && (
        <div className="absolute inset-y-0 right-0 w-1/3 pointer-events-none z-20 bg-gradient-to-l from-accent/60 to-transparent">
          <div className="absolute right-0 top-0 bottom-0 w-1 bg-accent" />
        </div>
      )}

      {isVideo &&
        (mediaItem?.filmstripThumbnails?.length || mediaItem?.thumbnailUrl) && (
          <div className="absolute inset-0 flex pointer-events-none">
            {mediaItem?.filmstripThumbnails &&
            mediaItem.filmstripThumbnails.length > 0
              ? Array.from({ length: thumbnailCount }).map((_, i) => {
                  const clipProgress = i / Math.max(1, thumbnailCount - 1);
                  const thumbIndex = Math.min(
                    Math.floor(
                      clipProgress * mediaItem.filmstripThumbnails!.length,
                    ),
                    mediaItem.filmstripThumbnails!.length - 1,
                  );
                  const thumb = mediaItem.filmstripThumbnails![thumbIndex];
                  return (
                    <div
                      key={i}
                      className="flex-1 h-full bg-cover bg-center opacity-70"
                      style={{
                        backgroundImage: `url(${thumb.url})`,
                        borderRight:
                          i < thumbnailCount - 1
                            ? "1px solid rgba(0,0,0,0.2)"
                            : "none",
                      }}
                    />
                  );
                })
              : Array.from({ length: thumbnailCount }).map((_, i) => (
                  <div
                    key={i}
                    className="flex-1 h-full bg-cover bg-center opacity-60"
                    style={{
                      backgroundImage: `url(${mediaItem.thumbnailUrl})`,
                      borderRight:
                        i < thumbnailCount - 1
                          ? "1px solid rgba(0,0,0,0.2)"
                          : "none",
                    }}
                  />
                ))}
          </div>
        )}

      {isVideo && !mediaItem?.thumbnailUrl && (
        <div className="absolute inset-0 bg-gradient-to-r from-primary/20 to-primary/10 pointer-events-none" />
      )}

      {isImage && (
        <div className="absolute inset-0 bg-gradient-to-r from-primary/20 to-primary/10 flex items-center justify-center pointer-events-none">
          {mediaItem?.thumbnailUrl ? (
            <img
              src={mediaItem.thumbnailUrl}
              alt={clipName}
              className="h-full object-cover opacity-60"
            />
          ) : (
            <Image size={24} className="text-primary/50" />
          )}
        </div>
      )}

      {isMotionClip && (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-r from-teal-500/30 via-cyan-500/20 to-slate-500/20 pointer-events-none">
          <Box size={22} className="text-teal-100/70" />
        </div>
      )}

      {isCompoundClip && (
        <div
          className="absolute inset-0 flex items-center justify-center bg-gradient-to-r from-violet-600/80 via-fuchsia-600/65 to-violet-500/70 pointer-events-none"
          style={
            typeof clip.metadata?.compoundClipColor === "string"
              ? { backgroundColor: clip.metadata.compoundClipColor }
              : undefined
          }
        >
          <Layers size={22} className="text-white/75" />
        </div>
      )}

      <span
        className={`absolute truncate z-10 pointer-events-none text-[11px] font-semibold ${
          isAudio ? "top-1.5" : "bottom-1.5"
        } ${hasLeadingTransitionBadge ? "left-[18px]" : "left-2"} ${
          hasTrailingTransitionBadge ? "right-[18px]" : "right-2"
        } ${
          isSelected ? clipStyle.selectedText : clipStyle.text
        }`}
        style={isAudio ? undefined : { textShadow: "0 1px 2px rgba(0,0,0,0.4)" }}
      >
        {clipName}
      </span>

      {isAudio &&
        (() => {
          const barCount = Math.max(8, Math.floor(width / 6));
          const data = mediaItem?.waveformData;
          return (
            <svg
              className="absolute left-0 bottom-0 w-full pointer-events-none"
              height="28"
              preserveAspectRatio="none"
              viewBox={`0 0 ${barCount * 6 + 6} 28`}
            >
              {Array.from({ length: barCount }).map((_, i) => {
                const amp =
                  data && data.length > 0
                    ? Math.abs(data[Math.floor((i / barCount) * data.length)] ?? 0)
                    : 0.35 + 0.5 * Math.abs(Math.sin(i * 1.3) * Math.cos(i * 0.7));
                const h = Math.max(3, Math.min(24, amp * 26));
                return (
                  <rect
                    key={i}
                    x={i * 6 + 6}
                    y={28 - h}
                    width="2"
                    height={h}
                    fill="#8cc79a"
                  />
                );
              })}
            </svg>
          );
        })()}

      {clip.keyframes && clip.keyframes.length > 0 && (
        <div className="absolute bottom-0 left-0 right-0 h-3 flex items-center pointer-events-none">
          {clip.keyframes.map((kf) => {
            const relativeTime = kf.time - clip.startTime;
            if (relativeTime < 0 || relativeTime > clip.duration) return null;
            const posPercent = (relativeTime / clip.duration) * 100;
            return (
              <div
                key={kf.id}
                className="absolute w-2 h-2 bg-yellow-400 rotate-45 border border-yellow-600"
                style={{ left: `${posPercent}%`, marginLeft: "-4px" }}
                title={`${kf.property} @ ${kf.time.toFixed(2)}s`}
              />
            );
          })}
        </div>
      )}

      {(isVideo || isImage || isAudio) && onTrimClip && (
        <>
          <div
            onMouseDown={handleTrimMouseDown("left")}
            className={`absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize z-20 flex items-center justify-center transition-opacity ${
              isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"
            } ${isSelected ? "bg-primary" : isAudio ? "hover:bg-blue-400/50" : isVideo ? "hover:bg-green-400/50" : "hover:bg-primary/50"}`}
            style={{ borderRadius: "6px 0 0 6px" }}
            onClick={(e) => e.stopPropagation()}
          >
            {isSelected && (
              <div className="w-0.5 h-3 bg-primary-foreground/80 rounded-full" />
            )}
          </div>
          <div
            onMouseDown={handleTrimMouseDown("right")}
            className={`absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize z-20 flex items-center justify-center transition-opacity ${
              isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"
            } ${isSelected ? "bg-primary" : isAudio ? "hover:bg-blue-400/50" : isVideo ? "hover:bg-green-400/50" : "hover:bg-primary/50"}`}
            style={{ borderRadius: "0 6px 6px 0" }}
            onClick={(e) => e.stopPropagation()}
          >
            {isSelected && (
              <div className="w-0.5 h-3 bg-primary-foreground/80 rounded-full" />
            )}
          </div>
        </>
      )}

        </div>
    </ContextMenu>
  );
};
