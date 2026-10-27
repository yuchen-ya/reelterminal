/**
 * VideoFrameWorkspace — real-playback video review surface for the AI
 * material workbench.
 *
 * Submodules:
 * - `video/VideoTopToolbar`: 36px single-line header with media info & tool switch
 * - `video/VideoCanvasStage`: Frameless maximized canvas with HUD & SVG annotations
 * - `video/VideoTransportBar`: Timecode, play/pause, step, mark frame/interval & scrubber
 * - `video/VideoFeedbackBar`: Compact single-line feedback submission bar
 * - `WorkbenchIssuePanel`: Right-side collapsible issue panel
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import type React from "react";
import type {
  WorkbenchSpatialAnnotation,
  WorkbenchVideoMarker,
} from "@reelterminal/core";
import type {
  WorkbenchController,
  WorkbenchItemView,
  WorkbenchMutationResult,
} from "../types";
import { resolveItemCompareTargetId } from "./lineage-tree-utils";
import {
  WorkbenchIssuePanel,
  type WorkbenchIssueSaveInput,
} from "./WorkbenchIssuePanel";
import {
  ACTIVE_MARKER_EPSILON_SEC,
  clamp01,
  DEFAULT_STEP_SEC,
  FRAME_MARKER_EPSILON_SEC,
  formatTimecode,
  type MarkerAnchorView,
  MIN_INTERVAL_SEC,
  sortMarkers,
  type VideoMarkerFeedback,
} from "./video/video-helpers";
import {
  buildVideoAnchors,
  removeVideoIssue,
  buildVideoFeedbackTarget,
  buildVideoIssueEntries,
} from "./video/video-issue-helpers";
import { useVideoDrawing } from "./video/useVideoDrawing";
import { VideoTopToolbar } from "./video/VideoTopToolbar";
import { VideoCanvasStage } from "./video/VideoCanvasStage";
import { VideoTransportBar } from "./video/VideoTransportBar";
import { VideoFeedbackBar } from "./video/VideoFeedbackBar";

export type { VideoMarkerFeedback };

export interface VideoFrameWorkspaceProps {
  readonly item: WorkbenchItemView;
  readonly batchVideoItems?: readonly WorkbenchItemView[];
  readonly ensureItemsLoaded?: WorkbenchController["ensureItemsLoaded"];
  readonly openMediaUrl?: WorkbenchController["openMediaUrl"];
  readonly onUpdateVideoMarkers: (
    itemId: string,
    markers: readonly WorkbenchVideoMarker[],
    feedback?: VideoMarkerFeedback,
    expectedVersion?: number,
  ) => Promise<WorkbenchMutationResult>;
  /** Width of the restored issue panel; owned by the page's layout state. */
  readonly issuePanelWidth: number;
  readonly onStartResizeIssuePanel?: (event: React.PointerEvent) => void;
}

export function VideoFrameWorkspace({
  item,
  batchVideoItems = [],
  ensureItemsLoaded,
  openMediaUrl,
  onUpdateVideoMarkers,
  issuePanelWidth,
  onStartResizeIssuePanel,
}: VideoFrameWorkspaceProps): JSX.Element {
  const payload = item.videoPayload;

  // --- refs ---------------------------------------------------------------
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const compareVideoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  /** In-memory per-item playback position; switching items restores it. */
  const timeCacheRef = useRef<Map<string, number>>(new Map());
  /** Seek target to apply once the freshly-switched video has metadata. */
  const pendingSeekRef = useRef<number | null>(null);
  const scrubbingRef = useRef<boolean>(false);
  const idCounterRef = useRef<number>(0);

  const makeId = useCallback((prefix: string): string => {
    idCounterRef.current += 1;
    return `${prefix}_${Date.now().toString(36)}_${idCounterRef.current}`;
  }, []);

  // --- playback state (all derived from the real <video> element) -----------
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [videoTime, setVideoTime] = useState<number>(0);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [videoReady, setVideoReady] = useState<boolean>(false);
  const [videoErrorMsg, setVideoErrorMsg] = useState<string | null>(null);
  const [videoSize, setVideoSize] = useState<{ w: number; h: number } | null>(null);

  // --- review UI state ------------------------------------------------------
  const [drawTool, setDrawTool] = useState<"box" | "arrow" | "pan">("box");
  const [zoom, setZoom] = useState<number>(100);
  const [pan, setPan] = useState<{ readonly x: number; readonly y: number }>({ x: 0, y: 0 });
  const [loupeEnabled, setLoupeEnabled] = useState<boolean>(false);
  const [selectedAnchorId, setSelectedAnchorId] = useState<string | null>(null);
  const [stepSec, setStepSec] = useState<number>(DEFAULT_STEP_SEC);
  const [inPts, setInPts] = useState<number | null>(null);
  const [outPts, setOutPts] = useState<number | null>(null);
  const [feedbackDraft, setFeedbackDraft] = useState<string>("");
  const [feedbackTagIds, setFeedbackTagIds] = useState<readonly string[]>([]);
  const [markRework, setMarkRework] = useState<boolean>(true);
  const [mutationError, setMutationError] = useState<string | null>(null);

  // --- side-by-side comparison state ----------------------------------------
  const [pinnedRefId, setPinnedRefId] = useState<string | null>(null);
  const [manualCompareId, setManualCompareId] = useState<string | null>(null);
  const [showCompareSplit, setShowCompareSplit] = useState<boolean>(false);

  const autoCompareTargetId = useMemo(
    () => resolveItemCompareTargetId(item, batchVideoItems),
    [batchVideoItems, item],
  );

  const effectiveCompareId = useMemo(() => {
    if (manualCompareId && manualCompareId !== item.id) return manualCompareId;
    if (autoCompareTargetId && autoCompareTargetId !== item.id) return autoCompareTargetId;
    if (pinnedRefId && pinnedRefId !== item.id) return pinnedRefId;
    const fallback = batchVideoItems.find((candidate) => candidate.id !== item.id);
    return fallback?.id ?? null;
  }, [autoCompareTargetId, batchVideoItems, item.id, manualCompareId, pinnedRefId]);

  const compareItem = useMemo(
    () =>
      effectiveCompareId
        ? batchVideoItems.find((candidate) => candidate.id === effectiveCompareId) ?? null
        : null,
    [batchVideoItems, effectiveCompareId],
  );

  const compareCandidates = useMemo(
    () =>
      batchVideoItems
        .filter((candidate) => candidate.id !== item.id)
        .map((candidate) => ({
          id: candidate.id,
          title: `${candidate.agentGuidance?.nodeSlotLabel ?? candidate.title} (v${candidate.version})`,
        })),
    [batchVideoItems, item.id],
  );

  // Auto-enable comparison when Agent bound a compare target (or parent video lineage exists)
  useEffect(() => {
    if (autoCompareTargetId && autoCompareTargetId !== item.id) {
      setManualCompareId(autoCompareTargetId);
      setShowCompareSplit(true);
    } else if (pinnedRefId && pinnedRefId !== item.id) {
      setManualCompareId(pinnedRefId);
    } else {
      setManualCompareId(null);
      setShowCompareSplit(false);
    }
  }, [autoCompareTargetId, item.id, pinnedRefId]);

  // Ensure the reference video's payload & media URL are loaded when comparison is active
  useEffect(() => {
    if (!showCompareSplit || !compareItem) return;
    if (!compareItem.videoPayload) {
      ensureItemsLoaded?.([compareItem.id]);
      return;
    }
    const media = compareItem.videoPayload.media;
    if (media.status !== "ready" && !media.url) {
      openMediaUrl?.(media.mediaId);
    }
  }, [compareItem, ensureItemsLoaded, openMediaUrl, showCompareSplit]);

  const markers = useMemo(
    () => sortMarkers(payload?.markers ?? []),
    [payload?.markers],
  );
  const duration = videoDuration ?? payload?.durationSec ?? null;

  // --- mutation plumbing ------------------------------------------------------
  const commitMarkers = useCallback(
    async (
      next: readonly WorkbenchVideoMarker[],
      feedback?: VideoMarkerFeedback,
    ): Promise<boolean> => {
      try {
        const result = await onUpdateVideoMarkers(
          item.id,
          sortMarkers(next),
          feedback,
          item.version,
        );
        if (result.ok) {
          setMutationError(null);
          return true;
        }
        setMutationError(result.message);
        return false;
      } catch (err) {
        setMutationError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [item.id, item.version, onUpdateVideoMarkers],
  );

  const realTime = useCallback((): number => {
    const video = videoRef.current;
    return video ? video.currentTime : videoTime;
  }, [videoTime]);

  const markerAtTime = useCallback(
    (t: number): WorkbenchVideoMarker | null => {
      for (const m of markers) {
        if (m.type === "frame") {
          if (Math.abs(m.startPtsSec - t) <= ACTIVE_MARKER_EPSILON_SEC) return m;
        } else {
          const end = m.endPtsSec ?? m.startPtsSec + MIN_INTERVAL_SEC;
          if (t >= m.startPtsSec && t < end) return m;
        }
      }
      return null;
    },
    [markers],
  );

  const activeMarker = useMemo(() => markerAtTime(videoTime), [markerAtTime, videoTime]);
  const activeAnnotations = activeMarker?.annotations ?? [];

  // --- drawing hook -----------------------------------------------------------
  const handleAnnotationCreated = useCallback(
    (annotation: WorkbenchSpatialAnnotation, t: number) => {
      const target = markerAtTime(t);
      let next: readonly WorkbenchVideoMarker[];
      if (target) {
        next = markers.map((m) =>
          m.id === target.id ? { ...m, annotations: [...m.annotations, annotation] } : m,
        );
      } else {
        next = [
          ...markers,
          {
            id: makeId("vfm"),
            type: "frame" as const,
            startPtsSec: t,
            annotationContainer: true,
            note: "",
            version: item.version,
            annotations: [annotation],
          },
        ];
      }
      setSelectedAnchorId(annotation.id);
      void commitMarkers(next);
    },
    [commitMarkers, item.version, makeId, markerAtTime, markers],
  );

  const {
    isDrawing,
    draftStart,
    draftCurrent,
    resetDrawing,
    handleStagePointerDown,
    handleStagePointerMove,
    handleStagePointerUp,
  } = useVideoDrawing({
    stageRef,
    videoRef,
    videoReady,
    videoSize,
    activeAnnotations,
    drawTool,
    realTime,
    makeId,
    onAnnotationCreated: handleAnnotationCreated,
    onSelectAnchor: setSelectedAnchorId,
  });

  // --- item switching: pause, reset per-item state, restore cached time -----
  useEffect(() => {
    const video = videoRef.current;
    setIsPlaying(false);
    setVideoReady(false);
    setVideoErrorMsg(null);
    setVideoSize(null);
    setVideoDuration(null);
    setVideoTime(0);
    setZoom(100);
    setPan({ x: 0, y: 0 });
    resetDrawing();
    setSelectedAnchorId(null);
    setInPts(null);
    setOutPts(null);
    setFeedbackDraft("");
    setFeedbackTagIds([]);
    setMarkRework(true);
    scrubbingRef.current = false;
    if (video) {
      video.pause();
      const cached = timeCacheRef.current.get(item.id);
      pendingSeekRef.current =
        typeof cached === "number" && Number.isFinite(cached) ? cached : 0;
      if (video.readyState >= 1) {
        const target = pendingSeekRef.current;
        pendingSeekRef.current = null;
        const dur =
          Number.isFinite(video.duration) && video.duration > 0
            ? video.duration
            : target;
        video.currentTime = Math.min(Math.max(0, target), dur);
        setVideoTime(video.currentTime);
      }
    } else {
      pendingSeekRef.current = 0;
    }
    return () => {
      const el = videoRef.current;
      if (el && Number.isFinite(el.currentTime)) {
        timeCacheRef.current.set(item.id, el.currentTime);
      }
    };
  }, [item.id, resetDrawing]);

  // Smooth playhead while actually playing
  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    const tick = (): void => {
      const video = videoRef.current;
      if (video) {
        setVideoTime(video.currentTime);
        const refVideo = compareVideoRef.current;
        if (refVideo && refVideo.readyState >= 1) {
          if (Math.abs(refVideo.currentTime - video.currentTime) > 0.12) {
            const refDur =
              Number.isFinite(refVideo.duration) && refVideo.duration > 0
                ? refVideo.duration
                : video.currentTime;
            refVideo.currentTime = Math.min(Math.max(0, video.currentTime), refDur);
          }
        }
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [isPlaying]);

  // Flattened anchors & issue entries
  const anchors = useMemo<MarkerAnchorView[]>(
    () => buildVideoAnchors(markers),
    [markers],
  );

  const issueEntries = useMemo(
    () => buildVideoIssueEntries(anchors, markers, item.version),
    [anchors, item.version, markers],
  );

  const handleSubmitFeedback = useCallback(async (): Promise<void> => {
    const text = feedbackDraft.trim();
    if (text.length === 0) {
      setMutationError("反馈内容为空,未提交");
      return;
    }
    const ok = await commitMarkers(markers, {
      text,
      referencedTagIds: feedbackTagIds,
      markRework,
    });
    if (ok) setFeedbackDraft("");
  }, [commitMarkers, feedbackDraft, feedbackTagIds, markers, markRework]);

  // --- real playback controls ---------------------------------------------------
  const seekTo = useCallback(
    (t: number): void => {
      const video = videoRef.current;
      if (!video || !videoReady) return;
      const dur =
        Number.isFinite(video.duration) && video.duration > 0
          ? video.duration
          : duration ?? 0;
      const clamped = Math.min(Math.max(0, t), dur);
      video.pause();
      video.currentTime = clamped;
      const refVideo = compareVideoRef.current;
      if (refVideo) {
        refVideo.pause();
        if (refVideo.readyState >= 1) {
          const refDur =
            Number.isFinite(refVideo.duration) && refVideo.duration > 0
              ? refVideo.duration
              : clamped;
          refVideo.currentTime = Math.min(Math.max(0, clamped), refDur);
        }
      }
      setVideoTime(clamped);
    },
    [duration, videoReady],
  );

  const handleTogglePlay = useCallback((): void => {
    const video = videoRef.current;
    if (!video || !videoReady) return;
    const refVideo = compareVideoRef.current;
    if (video.paused) {
      if (refVideo && refVideo.readyState >= 1) {
        const refDur =
          Number.isFinite(refVideo.duration) && refVideo.duration > 0
            ? refVideo.duration
            : video.currentTime;
        refVideo.currentTime = Math.min(Math.max(0, video.currentTime), refDur);
        void refVideo.play().catch(() => undefined);
      }
      video.play().catch((err: unknown) => {
        setMutationError(
          `无法开始播放: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    } else {
      video.pause();
      refVideo?.pause();
    }
  }, [videoReady]);

  const handleStep = useCallback(
    (direction: 1 | -1): void => {
      seekTo(realTime() + direction * stepSec);
    },
    [realTime, seekTo, stepSec],
  );

  const handleLoadedMetadata = useCallback((): void => {
    const video = videoRef.current;
    if (!video) return;
    setVideoReady(true);
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      setVideoSize({ w: video.videoWidth, h: video.videoHeight });
    }
    if (Number.isFinite(video.duration) && video.duration > 0) {
      setVideoDuration(video.duration);
    }
    const target = pendingSeekRef.current;
    pendingSeekRef.current = null;
    if (target !== null && Number.isFinite(target)) {
      const dur =
        Number.isFinite(video.duration) && video.duration > 0
          ? video.duration
          : target;
      video.currentTime = Math.min(Math.max(0, target), dur);
    }
    setVideoTime(video.currentTime);
  }, []);

  // --- marker actions ---------------------------------------------------------
  const handleMarkCurrentFrame = useCallback((): void => {
    const t = Number(realTime().toFixed(3));
    const existing = markers.find(
      (m) => m.type === "frame" && Math.abs(m.startPtsSec - t) <= FRAME_MARKER_EPSILON_SEC,
    );
    if (existing) {
      if (existing.annotationContainer !== false) {
        void commitMarkers(markers.map(marker => marker.id === existing.id
          ? { ...marker, annotationContainer: false, note: marker.note || `源帧 ${formatTimecode(t)} 待诊断问题` }
          : marker));
      }
      setSelectedAnchorId(existing.id);
      return;
    }
    const marker: WorkbenchVideoMarker = {
      id: makeId("vfm"),
      annotationContainer: false,
      type: "frame",
      startPtsSec: t,
      note: `源帧 ${formatTimecode(t)} 待诊断问题`,
      version: item.version,
      annotations: [],
    };
    setSelectedAnchorId(marker.id);
    void commitMarkers([...markers, marker]);
  }, [commitMarkers, item.version, makeId, markers, realTime]);

  const handleSetIn = useCallback((): void => {
    const t = realTime();
    setInPts(t);
    if (outPts !== null && outPts <= t) {
      setOutPts(t + Math.max(stepSec, MIN_INTERVAL_SEC));
    }
  }, [outPts, realTime, stepSec]);

  const handleSetOut = useCallback((): void => {
    const t = realTime();
    if (inPts !== null && t <= inPts) {
      setOutPts(inPts + Math.max(stepSec, MIN_INTERVAL_SEC));
    } else {
      setOutPts(t);
    }
  }, [inPts, realTime, stepSec]);

  const handleMarkInterval = useCallback((): void => {
    const t = realTime();
    const start = inPts ?? t;
    const end = Math.max(start + MIN_INTERVAL_SEC, outPts ?? t);
    const marker: WorkbenchVideoMarker = {
      id: makeId("vfm_int"),
      type: "interval",
      startPtsSec: Number(start.toFixed(3)),
      endPtsSec: Number(end.toFixed(3)),
      note: `区间 [${start.toFixed(2)}s, ${end.toFixed(2)}s) 待诊断`,
      version: item.version,
      annotations: [],
    };
    setSelectedAnchorId(marker.id);
    void commitMarkers([...markers, marker]);
  }, [commitMarkers, inPts, item.version, makeId, markers, outPts, realTime]);

  /** Select a card → seek to the issue's real PTS and pause the player. */
  const handleSelectIssue = useCallback(
    (issueId: string): void => {
      const anchor = anchors.find((candidate) => candidate.anchorId === issueId);
      setSelectedAnchorId(issueId);
      if (!anchor) return;
      const marker = markers.find((candidate) => candidate.id === anchor.markerId);
      if (marker) seekTo(marker.startPtsSec);
    },
    [anchors, markers, seekTo],
  );

  const handleSaveIssue = useCallback(
    async (
      issueId: string,
      input: WorkbenchIssueSaveInput,
    ): Promise<WorkbenchMutationResult> => {
      const anchor = anchors.find((candidate) => candidate.anchorId === issueId);
      if (!anchor) {
        return { ok: false, code: "NOT_FOUND", message: "问题锚点不存在" };
      }
      const next = markers.map((marker) => {
        if (marker.id !== anchor.markerId) return marker;
        if (anchor.kind === "marker") return { ...marker, note: input.text };
        return {
          ...marker,
          annotations: marker.annotations.map((annotation) =>
            annotation.id === issueId ? { ...annotation, label: input.text } : annotation,
          ),
        };
      });
      const sourceMarker = markers.find((marker) => marker.id === anchor.markerId);
      const sourceAnnotation = sourceMarker?.annotations.find(
        (annotation) => annotation.id === issueId,
      );
      const target = buildVideoFeedbackTarget(
        anchor,
        sourceMarker,
        sourceAnnotation,
        videoSize,
      );
      const result = await onUpdateVideoMarkers(
        item.id,
        sortMarkers(next),
        {
          text: input.text,
          referencedTagIds: input.referencedTagIds,
          markRework: input.markRework,
          state: "confirmed",
          ...(target ? { target } : {}),
        },
        item.version,
      );
      if (!result.ok) {
        setMutationError(result.message);
        return result;
      }
      setMutationError(null);
      setSelectedAnchorId(issueId);
      return result;
    },
    [anchors, item.id, item.version, markers, onUpdateVideoMarkers, videoSize],
  );

  const handleDeleteIssue = useCallback(
    async (issueId: string): Promise<WorkbenchMutationResult> => {
      const anchor = anchors.find((candidate) => candidate.anchorId === issueId);
      if (!anchor) {
        return { ok: false, code: "NOT_FOUND", message: "问题锚点不存在" };
      }
      const next = removeVideoIssue(markers, anchor);
      const result = await onUpdateVideoMarkers(
        item.id,
        sortMarkers(next),
        undefined,
        item.version,
      );
      if (!result.ok) {
        setMutationError(result.message);
        return result;
      }
      setMutationError(null);
      const remaining = buildVideoAnchors(next);
      const deletedIndex = anchors.findIndex(candidate => candidate.anchorId === issueId);
      setSelectedAnchorId(current => current === null || remaining.some(candidate => candidate.anchorId === current)
        ? current
        : remaining[Math.min(deletedIndex, remaining.length - 1)]?.anchorId ?? null);
      return result;
    },
    [anchors, item.id, item.version, markers, onUpdateVideoMarkers],
  );

  // --- scrubber events --------------------------------------------------------
  const seekFromClientX = useCallback(
    (clientX: number, el: HTMLDivElement): void => {
      if (duration === null || duration <= 0) return;
      const rect = el.getBoundingClientRect();
      const ratio = clamp01((clientX - rect.left) / rect.width);
      seekTo(ratio * duration);
    },
    [duration, seekTo],
  );

  const handleScrubPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (duration === null || duration <= 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      scrubbingRef.current = true;
      seekFromClientX(e.clientX, e.currentTarget);
    },
    [duration, seekFromClientX],
  );

  const handleScrubPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (!scrubbingRef.current) return;
      seekFromClientX(e.clientX, e.currentTarget);
    },
    [seekFromClientX],
  );

  const handleScrubPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      scrubbingRef.current = false;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    },
    [],
  );

  const durationLabel =
    duration !== null && duration > 0 ? `${duration.toFixed(3)}s` : "未提供";

  if (!payload) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg text-sm text-fg-3">
        视频内容未提供(videoPayload 缺失)
      </div>
    );
  }

  const svgViewBox = videoSize ? `0 0 ${videoSize.w} ${videoSize.h}` : "0 0 1000 562.5";
  const canSubmitFeedback = feedbackDraft.trim().length > 0;

  const stepZoom = useCallback((delta: number): void => {
    setZoom((prev) => {
      const next = Math.min(500, Math.max(100, prev + delta));
      if (next === 100) setPan({ x: 0, y: 0 });
      return next;
    });
  }, []);

  const resetZoom = useCallback((): void => {
    setZoom(100);
    setPan({ x: 0, y: 0 });
  }, []);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg">
      {/* Top toolbar */}
      <VideoTopToolbar
        resolution={payload.resolution}
        durationLabel={durationLabel}
        version={item.version}
        drawTool={drawTool}
        onSelectDrawTool={setDrawTool}
        videoReady={videoReady}
        zoom={zoom}
        onStepZoom={stepZoom}
        onResetZoom={resetZoom}
        loupeEnabled={loupeEnabled}
        onToggleLoupe={() => setLoupeEnabled((v) => !v)}
        isPinnedRef={pinnedRefId === item.id}
        onTogglePinCurrent={() =>
          setPinnedRefId((prev) => (prev === item.id ? null : item.id))
        }
        compareCandidates={compareCandidates}
        compareTargetId={effectiveCompareId}
        onSelectCompareTarget={(id) => {
          setManualCompareId(id);
          if (id) setShowCompareSplit(true);
        }}
        showCompareSplit={showCompareSplit && !!compareItem}
        onToggleCompareSplit={() => setShowCompareSplit((v) => !v)}
      />

      {/* Main viewer area: Video Stage + Separator + Issue Panel */}
      <div className="flex min-h-0 flex-1 items-stretch overflow-hidden bg-[#0d0f12]">
        <VideoCanvasStage
          stageRef={stageRef}
          videoRef={videoRef}
          videoUrl={payload.media.url}
          mediaStatus={payload.media.status}
          mediaError={payload.media.error}
          videoReady={videoReady}
          videoTime={videoTime}
          videoSize={videoSize}
          svgViewBox={svgViewBox}
          activeMarker={activeMarker}
          activeAnnotations={activeAnnotations}
          selectedAnchorId={selectedAnchorId}
          anchors={anchors}
          isDrawing={isDrawing}
          draftStart={draftStart}
          draftCurrent={draftCurrent}
          videoErrorMsg={videoErrorMsg}
          drawTool={drawTool}
          zoom={zoom}
          pan={pan}
          onPanChange={setPan}
          onStepZoom={stepZoom}
          loupeEnabled={loupeEnabled}
          currentTitle={`${item.agentGuidance?.nodeSlotLabel ?? item.title} (v${item.version})`}
          showCompareSplit={showCompareSplit && !!compareItem}
          compareVideoRef={compareVideoRef}
          compareVideoUrl={compareItem?.videoPayload?.media.url ?? null}
          compareTitle={
            compareItem
              ? `${compareItem.agentGuidance?.nodeSlotLabel ?? compareItem.title} (v${compareItem.version})`
              : undefined
          }
          onPointerDown={handleStagePointerDown}
          onPointerMove={handleStagePointerMove}
          onDeleteSelected={selectedAnchorId ? () => { void handleDeleteIssue(selectedAnchorId); } : undefined}
          onPointerCancel={resetDrawing}
          onPointerUp={handleStagePointerUp}
          onLoadedMetadata={handleLoadedMetadata}
          onDurationChange={() => {
            const video = videoRef.current;
            if (video && Number.isFinite(video.duration) && video.duration > 0) {
              setVideoDuration(video.duration);
            }
          }}
          onTimeUpdate={() => {
            const video = videoRef.current;
            if (video && !isPlaying) setVideoTime(video.currentTime);
          }}
          onSeeked={() => {
            const video = videoRef.current;
            if (video) setVideoTime(video.currentTime);
          }}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => setIsPlaying(false)}
          onError={() => {
            const video = videoRef.current;
            const code = video?.error?.code;
            setVideoErrorMsg(
              `视频加载/解码失败${code !== undefined ? `(错误码 ${code})` : ""}`,
            );
          }}
        />

        {onStartResizeIssuePanel && (
          <div
            role="separator"
            aria-orientation="vertical"
            onPointerDown={onStartResizeIssuePanel}
            className="group flex w-1.5 shrink-0 cursor-col-resize items-center justify-center bg-[#0d0f12]"
            title="拖拽调整问题栏宽度"
          >
            <div className="h-10 w-0.5 rounded-full bg-border-strong group-hover:bg-accent" />
          </div>
        )}

        <WorkbenchIssuePanel
          itemId={item.id}
          itemVersion={item.version}
          issues={issueEntries}
          selectedIssueId={selectedAnchorId}
          onSelectIssue={handleSelectIssue}
          onDeleteIssue={handleDeleteIssue}
          onSaveIssue={handleSaveIssue}
          provenanceTags={item.provenanceTags}
          feedbacks={item.feedbacks}
          {...(item.agentGuidance ? { agentGuidance: item.agentGuidance } : {})}
          {...(item.feedback
            ? {
                lastFeedback: {
                  text: item.feedback.text,
                  referencedTagIds: item.feedback.referencedTagIds,
                  isDraft: item.feedback.isDraft,
                },
              }
            : {})}
          widthPx={issuePanelWidth}
          emptyHint="暂停后在画面拖拽框选问题位置，或使用下方「标问题帧 / 标问题区间」创建标记。"
        />
      </div>

      {/* Transport bar */}
      <VideoTransportBar
        videoTime={videoTime}
        duration={duration}
        durationLabel={durationLabel}
        isPlaying={isPlaying}
        videoReady={videoReady}
        stepSec={stepSec}
        onChangeStepSec={setStepSec}
        onStep={handleStep}
        onTogglePlay={handleTogglePlay}
        onMarkCurrentFrame={handleMarkCurrentFrame}
        inPts={inPts}
        outPts={outPts}
        onSetIn={handleSetIn}
        onSetOut={handleSetOut}
        onMarkInterval={handleMarkInterval}
        markers={markers}
        onSeekTo={seekTo}
        onScrubPointerDown={handleScrubPointerDown}
        onScrubPointerMove={handleScrubPointerMove}
        onScrubPointerUp={handleScrubPointerUp}
      />

      {/* Single-line compact feedback bar */}
      <VideoFeedbackBar
        guidance={item.agentGuidance}
        status={item.status}
        feedbackDraft={feedbackDraft}
        onChangeFeedbackDraft={setFeedbackDraft}
        onSubmitFeedback={() => void handleSubmitFeedback()}
        canSubmitFeedback={canSubmitFeedback}
        provenanceTags={item.provenanceTags}
        feedbackTagIds={feedbackTagIds}
        onToggleFeedbackTag={(tagId) =>
          setFeedbackTagIds((prev) =>
            prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId],
          )
        }
        markRework={markRework}
        onChangeMarkRework={setMarkRework}
        mutationError={mutationError}
        onDismissMutationError={() => setMutationError(null)}
      />
    </div>
  );
}
