/**
 * VideoFrameWorkspace — real-playback video review surface for the AI
 * material workbench.
 *
 * Migrated from the prototype's VideoFrameWorkspace with the simulation
 * layer DELETED:
 * - `computeTrueVfrPts` (sin-jitter VFR PTS math) and the 24 Hz
 *   `setInterval` fake playback loop are gone. The stage plays
 *   `videoPayload.media.url` through a real `<video>` element; play /
 *   pause / seek / frame stepping all operate on `video.currentTime`, and
 *   the playback-time readout shows `video.currentTime` in seconds. This
 *   browser timeline is not assumed to equal the container's source PTS.
 * - No frame numbers are invented. Without a real decode mapping the HUD
 *   shows "帧索引不可用(无解码映射)"; a marker's `startFrameIndex` is
 *   only DISPLAYED when the data actually carries one — never inferred
 *   from a nominal fps.
 * - Markers anchor to real PTS seconds (`startPtsSec`, intervals with
 *   `endPtsSec > startPtsSec`), bind to the item version they were created
 *   against, and every write goes through `onUpdateVideoMarkers`
 *   (awaited; failures surface in an error banner, never silently).
 * - The prototype's in-canvas issue kanban is restored as the shared
 *   WorkbenchIssuePanel beside the stage (width owned by the page): select a
 *   marker/annotation card → seek to its real PTS and highlight it, edit its
 *   note, reference provenance tags, save, mark rework or delete exactly one
 *   issue. The old inline marker list is gone so there is only ONE selection
 *   and ONE edit surface.
 */

import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Flag,
  Loader2,
  Pause,
  Play,
  Scissors,
  Square,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import type React from "react";
import type {
  WorkbenchDecisionStatus,
  WorkbenchSpatialAnnotation,
  WorkbenchVideoMarker,
} from "@reelterminal/core";
import type {
  WorkbenchItemView,
  WorkbenchMutationResult,
} from "../types";
import {
  WorkbenchIssuePanel,
  type WorkbenchIssueEntry,
  type WorkbenchIssueSaveInput,
} from "./WorkbenchIssuePanel";

/** Feedback payload forwarded with a marker commit (matches the controller). */
export interface VideoMarkerFeedback {
  readonly text: string;
  readonly referencedTagIds: readonly string[];
  readonly markRework: boolean;
  readonly state?: "draft" | "confirmed";
  readonly target?: import("@reelterminal/core").WorkbenchFeedbackTarget;
}

export interface VideoFrameWorkspaceProps {
  readonly item: WorkbenchItemView;
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

const FRAME_MARKER_EPSILON_SEC = 0.02;
const ACTIVE_MARKER_EPSILON_SEC = 0.05;
const MIN_INTERVAL_SEC = 0.05;
const DEFAULT_STEP_SEC = 0.1;
/** Below this drag distance a pointer gesture is a click, not a drawing. */
const DRAW_MIN_DRAG = 0.025;
/** Hit-test radius (normalized) for picking arrows/points. */
const ANNOTATION_HIT_RADIUS = 0.06;
const DEFAULT_BOX_W = 0.18;
const DEFAULT_BOX_H = 0.18;

const STATUS_LABEL: Record<WorkbenchDecisionStatus, string> = {
  pending: "待决定",
  kept: "已保留",
  modified: "已修改",
  rework: "返工中",
  discarded: "已丢弃",
};

interface MarkerAnchorView {
  /** Marker id or annotation id — one selectable "anchor". */
  readonly anchorId: string;
  readonly markerId: string;
  readonly kind: "marker" | "annotation";
  readonly indexNumber: number;
  readonly coordinateLabel: string;
}

interface NormalizedPoint {
  readonly x: number;
  readonly y: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function formatTimecode(seconds: number): string {
  const t = Math.max(0, seconds);
  const mm = Math.floor(t / 60);
  const ss = Math.floor(t % 60);
  const mmm = Math.floor((t - Math.floor(t)) * 1000);
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(mmm).padStart(3, "0")}`;
}

function formatScrubLabel(seconds: number): string {
  return seconds < 10 ? `${seconds.toFixed(2)}s` : `${seconds.toFixed(1)}s`;
}

function sortMarkers(
  markers: readonly WorkbenchVideoMarker[],
): WorkbenchVideoMarker[] {
  return [...markers].sort((a, b) => a.startPtsSec - b.startPtsSec);
}

function isInsideBox(
  pt: NormalizedPoint,
  ann: WorkbenchSpatialAnnotation,
): boolean {
  const w = ann.w ?? DEFAULT_BOX_W;
  const h = ann.h ?? DEFAULT_BOX_H;
  return pt.x >= ann.x && pt.x <= ann.x + w && pt.y >= ann.y && pt.y <= ann.y + h;
}

export function VideoFrameWorkspace({
  item,
  onUpdateVideoMarkers,
  issuePanelWidth,
  onStartResizeIssuePanel,
}: VideoFrameWorkspaceProps): JSX.Element {
  const payload = item.videoPayload;

  // --- refs ---------------------------------------------------------------
  const videoRef = useRef<HTMLVideoElement | null>(null);
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
  const [videoSize, setVideoSize] = useState<{ w: number; h: number } | null>(
    null,
  );

  // --- review UI state ------------------------------------------------------
  const [drawTool, setDrawTool] = useState<"box" | "arrow">("box");
  const [selectedAnchorId, setSelectedAnchorId] = useState<string | null>(null);
  const [isDrawing, setIsDrawing] = useState<boolean>(false);
  const [draftStart, setDraftStart] = useState<NormalizedPoint | null>(null);
  const [draftCurrent, setDraftCurrent] = useState<NormalizedPoint | null>(null);
  const [stepSec, setStepSec] = useState<number>(DEFAULT_STEP_SEC);
  const [inPts, setInPts] = useState<number | null>(null);
  const [outPts, setOutPts] = useState<number | null>(null);
  const [feedbackDraft, setFeedbackDraft] = useState<string>("");
  const [feedbackTagIds, setFeedbackTagIds] = useState<readonly string[]>([]);
  const [markRework, setMarkRework] = useState<boolean>(true);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const markers = useMemo(
    () => sortMarkers(payload?.markers ?? []),
    [payload?.markers],
  );
  const duration = videoDuration ?? payload?.durationSec ?? null;

  // --- item switching: pause, reset per-item state, restore cached time -----
  useEffect(() => {
    const video = videoRef.current;
    setIsPlaying(false);
    setVideoReady(false);
    setVideoErrorMsg(null);
    setVideoSize(null);
    setVideoDuration(null);
    setVideoTime(0);
    setIsDrawing(false);
    setDraftStart(null);
    setDraftCurrent(null);
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
      pendingSeekRef.current = typeof cached === "number" && Number.isFinite(cached) ? cached : 0;
      if (video.readyState >= 1) {
        // Metadata for this src is already present (same-element re-use).
        const target = pendingSeekRef.current;
        pendingSeekRef.current = null;
        const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : target;
        video.currentTime = Math.min(Math.max(0, target), dur);
        setVideoTime(video.currentTime);
      }
    } else {
      pendingSeekRef.current = 0;
    }
    return () => {
      // Cache the outgoing item's position before the id changes.
      const el = videoRef.current;
      if (el && Number.isFinite(el.currentTime)) {
        timeCacheRef.current.set(item.id, el.currentTime);
      }
    };
  }, [item.id]);

  // Smooth playhead while actually playing — reads the REAL currentTime
  // every frame; there is no synthetic tick source anywhere in this file.
  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    const tick = (): void => {
      const video = videoRef.current;
      if (video) setVideoTime(video.currentTime);
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [isPlaying]);

  // --- derived views ---------------------------------------------------------
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

  /** Flattened anchors (markers + their annotations) with stable numbering. */
  const anchors = useMemo<MarkerAnchorView[]>(() => {
    const list: MarkerAnchorView[] = [];
    let counter = 1;
    for (const m of markers) {
      const frameLabel =
        m.startFrameIndex !== undefined ? ` · 帧 #${m.startFrameIndex}` : "";
      const markerLabel =
        m.type === "frame"
          ? `帧标记 @ ${m.startPtsSec.toFixed(3)}s${frameLabel}`
          : `区间 [${m.startPtsSec.toFixed(3)}s, ${(m.endPtsSec ?? m.startPtsSec).toFixed(3)}s)`;
      list.push({
        anchorId: m.id,
        markerId: m.id,
        kind: "marker",
        indexNumber: counter++,
        coordinateLabel: markerLabel,
      });
      for (const ann of m.annotations) {
        list.push({
          anchorId: ann.id,
          markerId: m.id,
          kind: "annotation",
          indexNumber: counter++,
          coordinateLabel: `${markerLabel} · 圈注 #${counter - 1}`,
        });
      }
    }
    return list;
  }, [markers]);


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
      setVideoTime(clamped);
    },
    [duration, videoReady],
  );

  const realTime = useCallback((): number => {
    const video = videoRef.current;
    return video ? video.currentTime : videoTime;
  }, [videoTime]);

  const handleTogglePlay = useCallback((): void => {
    const video = videoRef.current;
    if (!video || !videoReady) return;
    if (video.paused) {
      video.play().catch((err: unknown) => {
        setMutationError(
          `无法开始播放: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    } else {
      video.pause();
    }
  }, [videoReady]);

  const handleStep = useCallback(
    (direction: 1 | -1): void => {
      seekTo(realTime() + direction * stepSec);
    },
    [realTime, seekTo, stepSec],
  );

  // --- video element events -------------------------------------------------
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
      const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : target;
      video.currentTime = Math.min(Math.max(0, target), dur);
    }
    setVideoTime(video.currentTime);
  }, []);

  // --- annotation drawing ---------------------------------------------------
  /** Normalized coords relative to the VIDEO CONTENT rect (object-contain math),
   * so annotations stay glued to the picture even when the surface letterboxes. */
  const getNormalizedPoint = useCallback(
    (clientX: number, clientY: number): NormalizedPoint => {
      const el = stageRef.current;
      if (!el) return { x: 0.5, y: 0.5 };
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return { x: 0.5, y: 0.5 };
      const surfaceRatio = rect.width / rect.height;
      const contentRatio = videoSize ? videoSize.w / videoSize.h : 16 / 9;
      let contentW = rect.width;
      let contentH = rect.height;
      let offX = 0;
      let offY = 0;
      if (surfaceRatio > contentRatio) {
        contentW = rect.height * contentRatio;
        offX = (rect.width - contentW) / 2;
      } else {
        contentH = rect.width / contentRatio;
        offY = (rect.height - contentH) / 2;
      }
      return {
        x: clamp01((clientX - rect.left - offX) / contentW),
        y: clamp01((clientY - rect.top - offY) / contentH),
      };
    },
    [videoSize],
  );

  const hitTestAnnotation = useCallback(
    (pt: NormalizedPoint): WorkbenchSpatialAnnotation | null => {
      for (let i = activeAnnotations.length - 1; i >= 0; i--) {
        const ann = activeAnnotations[i];
        if (ann.tool === "box") {
          if (isInsideBox(pt, ann)) return ann;
        } else if (Math.hypot(pt.x - ann.x, pt.y - ann.y) < ANNOTATION_HIT_RADIUS) {
          return ann;
        }
      }
      return null;
    },
    [activeAnnotations],
  );

  const handleStagePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (!videoReady) return;
      // Drawing always lands on a paused frame.
      videoRef.current?.pause();
      const pt = getNormalizedPoint(e.clientX, e.clientY);
      const hit = hitTestAnnotation(pt);
      if (hit) {
        setSelectedAnchorId(hit.id);
        return;
      }
      e.currentTarget.setPointerCapture(e.pointerId);
      setIsDrawing(true);
      setDraftStart(pt);
      setDraftCurrent(pt);
    },
    [getNormalizedPoint, hitTestAnnotation, videoReady],
  );

  const handleStagePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (!isDrawing) return;
      setDraftCurrent(getNormalizedPoint(e.clientX, e.clientY));
    },
    [getNormalizedPoint, isDrawing],
  );

  const handleStagePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      if (!isDrawing || !draftStart || !draftCurrent) return;
      setIsDrawing(false);

      // Ignore accidental tiny clicks so the canvas stays clean.
      const dragDist = Math.hypot(draftCurrent.x - draftStart.x, draftCurrent.y - draftStart.y);
      setDraftStart(null);
      setDraftCurrent(null);
      if (dragDist < DRAW_MIN_DRAG) return;

      const t = Number(realTime().toFixed(3));
      const defaultNote = `播放时间 ${t.toFixed(3)}s 局部异常`;
      const annotation: WorkbenchSpatialAnnotation =
        drawTool === "box"
          ? {
              id: makeId("v_ann"),
              tool: "box",
              x: Math.min(draftStart.x, draftCurrent.x),
              y: Math.min(draftStart.y, draftCurrent.y),
              w: Math.max(DRAW_MIN_DRAG, Math.abs(draftCurrent.x - draftStart.x)),
              h: Math.max(DRAW_MIN_DRAG, Math.abs(draftCurrent.y - draftStart.y)),
              label: defaultNote,
              color: "#f43f5e",
              ptsSec: t,
            }
          : {
              id: makeId("v_ann"),
              tool: "arrow",
              x: draftStart.x,
              y: draftStart.y,
              endX: draftCurrent.x,
              endY: draftCurrent.y,
              label: defaultNote,
              color: "#f59e0b",
              ptsSec: t,
            };

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
            note: `源帧 ${formatTimecode(t)} 待诊断问题`,
            version: item.version,
            annotations: [annotation],
          },
        ];
      }
      setSelectedAnchorId(annotation.id);
      void commitMarkers(next);
    },
    [commitMarkers, draftCurrent, draftStart, drawTool, isDrawing, item.version, makeId, markerAtTime, markers, realTime],
  );

  // --- marker actions ---------------------------------------------------------
  const handleMarkCurrentFrame = useCallback((): void => {
    const t = Number(realTime().toFixed(3));
    const existing = markers.find(
      (m) => m.type === "frame" && Math.abs(m.startPtsSec - t) <= FRAME_MARKER_EPSILON_SEC,
    );
    if (existing) {
      setSelectedAnchorId(existing.id);
      return;
    }
    const marker: WorkbenchVideoMarker = {
      id: makeId("vfm"),
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

  // --- restored issue panel: marker/annotation cards with real PTS ------------
  const issueEntries = useMemo<readonly WorkbenchIssueEntry[]>(() => {
    const list: WorkbenchIssueEntry[] = [];
    for (const anchor of anchors) {
      const marker = markers.find((candidate) => candidate.id === anchor.markerId);
      if (!marker) continue;
      const staleVersion = marker.version !== item.version;
      if (anchor.kind === "marker") {
        list.push({
          id: anchor.anchorId,
          kind: "marker",
          indexNumber: anchor.indexNumber,
          coordinateLabel: anchor.coordinateLabel,
          note: marker.note,
          version: marker.version,
          staleVersion,
          annotationCount: marker.annotations.length,
          ptsLabel: `${marker.startPtsSec.toFixed(3)}s`,
        });
        continue;
      }
      const annotation = marker.annotations.find(
        (candidate) => candidate.id === anchor.anchorId,
      );
      if (!annotation) continue;
      list.push({
        id: anchor.anchorId,
        kind: "annotation",
        indexNumber: anchor.indexNumber,
        coordinateLabel: anchor.coordinateLabel,
        note: annotation.label ?? "",
        version: marker.version,
        staleVersion,
        color: annotation.color,
        tool: annotation.tool,
        ptsLabel: `${marker.startPtsSec.toFixed(3)}s`,
      });
    }
    return list;
  }, [anchors, item.version, markers]);

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
      const target =
        anchor.kind === "marker" && sourceMarker
          ? {
              kind: "video-marker" as const,
              markerId: sourceMarker.id,
              startPtsSec: sourceMarker.startPtsSec,
              ...(sourceMarker.endPtsSec !== undefined
                ? { endPtsSec: sourceMarker.endPtsSec }
                : {}),
              // Only a real stored decode index counts as a frame mapping.
              hasFrameMapping: sourceMarker.startFrameIndex !== undefined,
            }
          : sourceAnnotation
            ? {
                kind: "pixel-region" as const,
                annotationId: sourceAnnotation.id,
                x: sourceAnnotation.x,
                y: sourceAnnotation.y,
                ...(sourceAnnotation.w !== undefined ? { w: sourceAnnotation.w } : {}),
                ...(sourceAnnotation.h !== undefined ? { h: sourceAnnotation.h } : {}),
                ...(videoSize ? { naturalWidth: videoSize.w, naturalHeight: videoSize.h } : {}),
              }
            : undefined;
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
      const next =
        anchor.kind === "marker"
          ? markers.filter((marker) => marker.id !== anchor.markerId)
          : markers.map((marker) =>
              marker.id !== anchor.markerId
                ? marker
                : {
                    ...marker,
                    annotations: marker.annotations.filter(
                      (annotation) => annotation.id !== anchor.anchorId,
                    ),
                  },
            );
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
      setSelectedAnchorId((current) => (current === issueId ? null : current));
      return result;
    },
    [anchors, item.id, item.version, markers, onUpdateVideoMarkers],
  );

  // --- scrubber ----------------------------------------------------------------
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

  // --- small render helpers ------------------------------------------------------
  const durationLabel =
    duration !== null && duration > 0 ? `${duration.toFixed(3)}s` : "未提供";

  const renderMediaFallback = (): JSX.Element => {
    const status = payload?.media.status ?? "unavailable";
    if (status === "loading") {
      return (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-fg-2">
          <Loader2 className="h-6 w-6 animate-spin text-accent" />
          <span className="text-xs">媒体加载中…</span>
        </div>
      );
    }
    if (status === "error") {
      return (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-6 text-center">
          <TriangleAlert className="h-6 w-6 text-status-error" />
          <span className="text-sm font-medium text-status-error">媒体加载失败</span>
          <span className="text-xs text-fg-3">{payload?.media.error ?? "未知错误"}</span>
        </div>
      );
    }
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-6 text-center">
        <TriangleAlert className="h-6 w-6 text-status-warning" />
        <span className="text-sm font-medium text-fg-2">媒体不可用</span>
        <span className="text-xs text-fg-3">
          该条目的源媒体未挂载(无可用 URL),无法播放或标注
        </span>
      </div>
    );
  };

  // All hooks run before any conditional return.
  if (!payload) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg text-sm text-fg-3">
        视频内容未提供(videoPayload 缺失)
      </div>
    );
  }

  const svgViewBox = videoSize ? `0 0 ${videoSize.w} ${videoSize.h}` : "0 0 1000 562.5";
  const scrubberDisabled = duration === null || duration <= 0;
  const playheadPct = duration !== null && duration > 0 ? clamp01(videoTime / duration) * 100 : 0;
  const guidance = item.agentGuidance;
  const canSubmitFeedback = feedbackDraft.trim().length > 0;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg">
      {/* Top sub-bar: media metadata + annotation tool toggle */}
      <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border bg-bg-1 px-4">
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <span className="rounded border border-border bg-bg-2 px-2 py-0.5 font-mono text-fg">
            {payload.resolution ?? "分辨率未提供"}
          </span>
          <span className="rounded border border-border bg-bg-2 px-2 py-0.5 font-mono text-fg-2">
            时长 {durationLabel}
          </span>
          <span className="rounded border border-border bg-bg-2 px-2 py-0.5 font-mono text-accent">
            v{item.version}
          </span>
          <span className="truncate text-fg-3">
            暂停后框选/画箭头圈注；标记使用播放器时间，源 PTS 未映射时外部处理可能偏移
          </span>
        </div>

        <div className="flex shrink-0 items-center rounded-lg border border-border bg-bg p-0.5">
          <button
            type="button"
            onClick={() => setDrawTool("box")}
            disabled={!videoReady}
            className={`flex items-center gap-1 rounded px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40 ${
              drawTool === "box" ? "bg-accent-soft text-accent" : "text-fg-3 hover:text-fg"
            }`}
          >
            <Square className="h-3.5 w-3.5" />
            框选问题位置
          </button>
          <button
            type="button"
            onClick={() => setDrawTool("arrow")}
            disabled={!videoReady}
            className={`flex items-center gap-1 rounded px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40 ${
              drawTool === "arrow" ? "bg-accent-soft text-accent" : "text-fg-3 hover:text-fg"
            }`}
          >
            <ArrowUpRight className="h-3.5 w-3.5" />
            箭头指出位置
          </button>
        </div>
      </div>

      {/* Main area: viewer + issue panel on top, transport spanning both below */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden bg-stage-bg p-3">
        <div className="flex min-h-0 flex-1 items-stretch gap-3 overflow-hidden">
          {/* Video stage */}
          <div
            data-workbench-player="true"
            className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center rounded-xl border border-border bg-bg p-3"
          >
          <div className="absolute left-3 top-3 z-10 flex items-center gap-2">
            <span className="rounded-md border border-border bg-bg-2 px-2.5 py-1 font-mono text-xs tabular-nums text-accent">
              播放时间: {videoTime.toFixed(3)}s
            </span>
            <span className="rounded-md border border-border bg-bg-2 px-2.5 py-1 text-xs text-fg-2">
              帧索引不可用(无解码映射)
            </span>
            {activeMarker && (
              <span className="rounded-md border border-rose-500/40 bg-rose-500/15 px-2.5 py-1 text-xs font-medium text-rose-300">
                ⚑ 当前位置含 {activeMarker.annotations.length} 处圈注(单击框体可在下方编辑)
              </span>
            )}
          </div>

          <div
            ref={stageRef}
            onPointerDown={handleStagePointerDown}
            onPointerMove={handleStagePointerMove}
            onPointerUp={handleStagePointerUp}
            className={`relative aspect-video max-h-[85%] w-full max-w-[880px] overflow-hidden rounded-lg border border-border-strong bg-bg-2 shadow-sm ${
              videoReady ? "cursor-crosshair" : ""
            }`}
          >
            {payload.media.status === "ready" && payload.media.url ? (
              <>
                <video
                  ref={videoRef}
                  src={payload.media.url}
                  className="absolute inset-0 h-full w-full object-contain"
                  playsInline
                  preload="auto"
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
                {/* Annotation overlay: anchored to the paused frame's PTS */}
                <svg
                  viewBox={svgViewBox}
                  preserveAspectRatio="xMidYMid meet"
                  className="pointer-events-none absolute inset-0 h-full w-full"
                >
                  <defs>
                    <marker
                      id="vfw-arrowhead"
                      markerWidth="8"
                      markerHeight="8"
                      refX="7"
                      refY="4"
                      orient="auto"
                    >
                      <path d="M0,0 L8,4 L0,8 Z" className="fill-status-warning" />
                    </marker>
                  </defs>
                  {activeAnnotations.map((ann) => {
                    const isSelected = selectedAnchorId === ann.id;
                    const anchorNumber =
                      anchors.find((a) => a.anchorId === ann.id)?.indexNumber ?? 1;

                    if (ann.tool === "box") {
                      const rx = ann.x * (videoSize?.w ?? 1000);
                      const ry = ann.y * (videoSize?.h ?? 562.5);
                      const rw = (ann.w ?? DEFAULT_BOX_W) * (videoSize?.w ?? 1000);
                      const rh = (ann.h ?? DEFAULT_BOX_H) * (videoSize?.h ?? 562.5);
                      return (
                        <g key={ann.id}>
                          <rect
                            x={rx}
                            y={ry}
                            width={rw}
                            height={rh}
                            rx="4"
                            className={
                              isSelected
                                ? "fill-accent-soft stroke-accent"
                                : "fill-rose-500/10 stroke-rose-500"
                            }
                            strokeWidth={isSelected ? 3 : 2}
                            strokeDasharray={isSelected ? "none" : "6 4"}
                          />
                          <rect
                            x={rx}
                            y={Math.max(2, ry - 24)}
                            width={isSelected ? Math.min(340, (ann.label?.length ?? 6) * 13 + 48) : 38}
                            height="22"
                            rx="4"
                            className={
                              isSelected
                                ? "fill-accent stroke-accent"
                                : "fill-bg-2 stroke-rose-500"
                            }
                            strokeWidth="1"
                          />
                          <text
                            x={rx + 8}
                            y={Math.max(17, ry - 9)}
                            fontSize="12"
                            fontWeight="700"
                            className={isSelected ? "fill-accent-foreground" : "fill-rose-300"}
                          >
                            {isSelected ? `#${anchorNumber} ${(ann.label ?? "").slice(0, 22)}` : `#${anchorNumber}`}
                          </text>
                        </g>
                      );
                    }

                    const x1 = ann.x * (videoSize?.w ?? 1000);
                    const y1 = ann.y * (videoSize?.h ?? 562.5);
                    const x2 = (ann.endX ?? ann.x + 0.1) * (videoSize?.w ?? 1000);
                    const y2 = (ann.endY ?? ann.y + 0.1) * (videoSize?.h ?? 562.5);
                    return (
                      <g key={ann.id}>
                        <line
                          x1={x1}
                          y1={y1}
                          x2={x2}
                          y2={y2}
                          markerEnd="url(#vfw-arrowhead)"
                          className={isSelected ? "stroke-accent" : "stroke-status-warning"}
                          strokeWidth={isSelected ? 3.5 : 2.5}
                        />
                        <rect
                          x={x1 - 4}
                          y={Math.max(2, y1 - 24)}
                          width={isSelected ? Math.min(320, (ann.label?.length ?? 6) * 13 + 48) : 38}
                          height="20"
                          rx="4"
                          className={isSelected ? "fill-accent" : "fill-bg-2"}
                        />
                        <text
                          x={x1 + 4}
                          y={Math.max(16, y1 - 10)}
                          fontSize="12"
                          fontWeight="700"
                          className={isSelected ? "fill-accent-foreground" : "fill-status-warning"}
                        >
                          {isSelected ? `#${anchorNumber} ${(ann.label ?? "").slice(0, 20)}` : `#${anchorNumber}`}
                        </text>
                      </g>
                    );
                  })}

                  {isDrawing && draftStart && draftCurrent && (
                    <rect
                      x={Math.min(draftStart.x, draftCurrent.x) * (videoSize?.w ?? 1000)}
                      y={Math.min(draftStart.y, draftCurrent.y) * (videoSize?.h ?? 562.5)}
                      width={Math.abs(draftCurrent.x - draftStart.x) * (videoSize?.w ?? 1000)}
                      height={Math.abs(draftCurrent.y - draftStart.y) * (videoSize?.h ?? 562.5)}
                      className="fill-accent-soft stroke-accent"
                      strokeWidth="2.5"
                    />
                  )}
                </svg>
                {videoErrorMsg && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-bg px-6 text-center">
                    <TriangleAlert className="h-6 w-6 text-status-error" />
                    <span className="text-sm font-medium text-status-error">{videoErrorMsg}</span>
                  </div>
                )}
              </>
            ) : (
              renderMediaFallback()
            )}
          </div>
        </div>

          {onStartResizeIssuePanel && (
            <div
              role="separator"
              aria-orientation="vertical"
              onPointerDown={onStartResizeIssuePanel}
              className="group flex w-1.5 shrink-0 cursor-col-resize items-center justify-center"
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

        {/* Transport + PTS-based frame strip (spans viewer + issue panel) */}
        <div className="flex shrink-0 flex-col gap-2 rounded-xl border border-border bg-bg-1 p-2.5">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="font-mono text-sm font-semibold tabular-nums text-accent">
                {formatTimecode(videoTime)}
              </span>
              <span className="font-mono text-xs tabular-nums text-fg-3">
                / {durationLabel}
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => handleStep(-1)}
                disabled={!videoReady}
                className="flex items-center gap-1 whitespace-nowrap rounded border border-border bg-bg-2 px-2 py-1 font-mono text-xs text-fg hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
                title={`后退 ${stepSec}s`}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                -{stepSec}s
              </button>
              <button
                type="button"
                onClick={handleTogglePlay}
                disabled={!videoReady}
                className="flex h-8 w-9 items-center justify-center rounded-md bg-accent text-accent-foreground transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isPlaying ? (
                  <Pause className="h-4 w-4 fill-current" />
                ) : (
                  <Play className="h-4 w-4 fill-current" />
                )}
              </button>
              <button
                type="button"
                onClick={() => handleStep(1)}
                disabled={!videoReady}
                className="flex items-center gap-1 whitespace-nowrap rounded border border-border bg-bg-2 px-2 py-1 font-mono text-xs text-fg hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
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
                      setStepSec(Math.min(1, Math.max(0.01, parsed)));
                    }
                  }}
                  className="w-14 rounded border border-border bg-bg-2 px-1.5 py-0.5 text-right font-mono text-xs text-fg focus:border-accent focus:outline-none"
                />
              </label>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={handleMarkCurrentFrame}
                disabled={!videoReady}
                className="flex items-center gap-1 whitespace-nowrap rounded-md border border-rose-500/40 bg-rose-500/15 px-2.5 py-1 text-xs font-medium text-rose-300 transition-colors hover:bg-rose-500/25 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Flag className="h-3.5 w-3.5" />
                标问题帧 @ {videoTime.toFixed(2)}s
              </button>

              <div className="flex items-center gap-1 rounded-md border border-border bg-bg px-1.5 py-0.5 text-xs">
                <button
                  type="button"
                  onClick={handleSetIn}
                  disabled={!videoReady}
                  className="whitespace-nowrap rounded bg-bg-2 px-1.5 py-0.5 font-mono text-fg-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
                  title="把当前播放位置设为区间入点"
                >
                  ↳ In: {inPts !== null ? `${inPts.toFixed(3)}s` : "—"}
                </button>
                <button
                  type="button"
                  onClick={handleSetOut}
                  disabled={!videoReady}
                  className="whitespace-nowrap rounded bg-bg-2 px-1.5 py-0.5 font-mono text-fg-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
                  title="把当前播放位置设为区间出点"
                >
                  ↪ Out: {outPts !== null ? `${outPts.toFixed(3)}s` : "—"}
                </button>
                <button
                  type="button"
                  onClick={handleMarkInterval}
                  disabled={!videoReady}
                  className="flex items-center gap-1 whitespace-nowrap rounded bg-status-warning/20 px-2 py-0.5 font-medium text-status-warning hover:bg-status-warning/30 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Scissors className="h-3 w-3" />
                  标问题区间 [{inPts !== null ? inPts.toFixed(2) : "—"}, {outPts !== null ? outPts.toFixed(2) : "—"})
                </button>
              </div>
            </div>
          </div>

          {/* Frame strip — ticks, markers and playhead all positioned by PTS seconds */}
          <div
            onPointerDown={handleScrubPointerDown}
            onPointerMove={handleScrubPointerMove}
            onPointerUp={handleScrubPointerUp}
            className={`relative h-8 select-none overflow-hidden rounded-lg border border-border bg-bg ${
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
                      seekTo(m.startPtsSec);
                    }}
                    style={{ left: `${leftPct}%`, width: `${Math.max(1.5, widthPct)}%` }}
                    className="absolute bottom-1 top-1 rounded-sm border-x-2 border-status-warning bg-status-warning/25"
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
                    seekTo(m.startPtsSec);
                  }}
                  style={{ left: `${leftPct}%` }}
                  className="absolute bottom-0 top-0 w-1.5 -ml-0.5 bg-rose-500"
                  title={`${m.startPtsSec.toFixed(3)}s ${m.note} — 点击跳转`}
                />
              );
            })}

            <div
              style={{ left: `${playheadPct}%` }}
              className="pointer-events-none absolute bottom-0 top-0 w-0.5 bg-white"
            >
              <div className="-ml-1 -mt-1 h-2.5 w-2.5 rotate-45 rounded-sm bg-white" />
            </div>
          </div>

        </div>
      </div>

      {/* Footer: agent guidance + item-level feedback (decisions live in the
          bottom details dock, matching the prototype) */}
      <div className="shrink-0 border-t border-border bg-bg-1 px-4 py-2.5">
        {mutationError && (
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-status-error/40 bg-status-error/10 px-3 py-1.5 text-xs text-status-error">
            <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 break-all">{mutationError}</span>
            <button
              type="button"
              onClick={() => setMutationError(null)}
              className="shrink-0 hover:text-fg"
            >
              ✕
            </button>
          </div>
        )}
        <div className="flex items-center gap-2 text-xs">
          <span className="shrink-0 text-fg-3">AI 指引:</span>
          <span
            className="min-w-0 flex-1 truncate text-fg-2"
            title={guidance ? `${guidance.whatHappened} ${guidance.whatToDoNext}` : undefined}
          >
            {guidance ? `${guidance.branchName} · ${guidance.whatToDoNext}` : "未提供"}
          </span>
          <span
            className={`shrink-0 rounded border px-2 py-0.5 ${
              item.status === "pending"
                ? "border-border text-fg-3"
                : item.status === "rework"
                  ? "border-status-warning/40 text-status-warning"
                  : item.status === "discarded"
                    ? "border-status-error/40 text-status-error"
                    : "border-accent text-accent"
            }`}
          >
            {STATUS_LABEL[item.status]}
          </span>
        </div>
        <div className="mt-2 flex items-center gap-2 text-xs">
          <input
            value={feedbackDraft}
            onChange={(e) => setFeedbackDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSubmitFeedback) void handleSubmitFeedback();
            }}
            placeholder="返工/审阅说明(与问题标记一并发送,可选)"
            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-bg-2 px-2.5 text-xs text-fg placeholder:text-fg-3 focus:border-accent focus:outline-none"
          />
          {item.provenanceTags.length > 0 ? (
            <div className="flex shrink-0 items-center gap-1">
              {item.provenanceTags.map((tag) => {
                const active = feedbackTagIds.includes(tag.id);
                return (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() =>
                      setFeedbackTagIds((prev) =>
                        prev.includes(tag.id)
                          ? prev.filter((id) => id !== tag.id)
                          : [...prev, tag.id],
                      )
                    }
                    className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                      active
                        ? "border-accent bg-accent-soft text-accent"
                        : "border-border bg-bg-2 text-fg-3 hover:text-fg-2"
                    }`}
                    title={`引用溯源标签 @${tag.shortName}`}
                  >
                    @{tag.shortName}
                  </button>
                );
              })}
            </div>
          ) : (
            <span className="shrink-0 text-fg-3">无可用溯源标签</span>
          )}
          <label className="flex shrink-0 items-center gap-1 text-fg-2">
            <input
              type="checkbox"
              checked={markRework}
              onChange={(e) => setMarkRework(e.target.checked)}
              className="accent-accent"
            />
            标记返工
          </label>
          <button
            type="button"
            onClick={() => void handleSubmitFeedback()}
            disabled={!canSubmitFeedback}
            className="shrink-0 rounded-md border border-accent px-2.5 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
          >
            提交反馈
          </button>
        </div>
      </div>
    </div>
  );
}
