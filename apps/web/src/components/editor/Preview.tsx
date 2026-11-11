import { ReviewRangeControl } from "./preview/ReviewRangeControl";
import { getPerfSink, markPerfOperation, withPerfSpan } from "@reelterminal/core";
import { finishPreviewSeek, getPreviewSeek } from "../../performance/seek-flow";
import { PausedVideoFrameReader, SCRUB_VIDEO_IDLE_MS } from "./preview/paused-video-frame";
import { getProjectPerfOperation } from "../../performance/product-flow";
import {
  releasePreviewResourceCounts,
  registerPreviewResourceReader,
} from "../../performance/resource-snapshot";
import { getPreviewPerfOperation, getPreviewViewGeneration, previewSession } from "../../services/preview-session";
import { VersionPreviewLoadingStatus } from "../../desktop/editor/VersionPreviewLoadingStatus";
import { recordCommittedPreviewFrame } from "./preview/frame-performance";
import { canCommitHistoryFrame } from "./preview/history-frame-readiness";
import { SelectionTransformOverlay } from "./preview/SelectionTransformOverlay";
import { collectNativePlaybackImageClips } from "./preview/native-playback-image-clips";
import { captureNativeVideoFrame } from "./preview/native-video-frame";
import { hasMatchingNativeFrameRate, playbackFrameTime } from "./preview/playback-frame-time";
import { scrubVideoCacheKey, scrubVideoCacheLimit } from "./preview/scrub-video-cache";
import { computeLetterboxGeometry } from "./preview/overlay-geometry";
import { usePreviewScrubBar } from "./preview/usePreviewScrubBar";
import React, {
  useRef,
  useEffect,
  useCallback,
  useState,
  useMemo,
  useSyncExternalStore,
} from "react";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  Monitor,
  Maximize2,
  Minimize2,
  Move,
  Loader2,
  ZoomIn,
  Proportions,
  Magnet,
  Crosshair,
  Flag,
} from "@/icons/lucide-compat";
import { ToolcraftButton as Button } from "@reelterminal/ui";
import { ToolcraftIconButton as IconButton } from "@reelterminal/ui";
import { ToolcraftText as Text } from "@reelterminal/ui";
import {
  ToolcraftContextMenu as ContextMenu,
  type ToolcraftContextMenuOption as ContextMenuOption,
} from "@reelterminal/ui";
import { useProjectStore } from "../../stores/project-store";
import { useTimelineStore } from "../../stores/timeline-store";
import { useUIStore } from "../../stores/ui-store";
import { useEditorContextStore } from "../../stores/editor-context-store";
import { ProjectMarkerBadge } from "./ProjectMarkerBadge";
import {
  findClipMarkersActiveAt,
  findTimeRangeMarkersAt,
  markersForSelection,
} from "../../stores/project/project-marker-selectors";
import { toast } from "../../stores/notification-store";
import {
  installProjectRenderFonts,
  releaseProjectRenderFonts,
} from "../../services/project-render-dependencies";
import { useThemeStore } from "../../stores/theme-store";
import { getRenderBridge } from "../../bridges/render-bridge";
import {
  calculateProjectDuration,
  timelineSampleTime,
  type FrameRenderOptions,
  getMasterClock,
  getRealtimeAudioGraph,
  initializeAudioEffectsEngine,
  getPreviewAudioEffects,
  splitProfileAwareNoiseReductionEffects,
  resolveClipAudioEffects as resolveTimelineClipAudioEffects,
  resolveClipVolumeAutomation,
  type Effect,
  type AudioEffectParams,
  type AudioClipSchedule,
  type TextClip,
  type ShapeClip,
  type SVGClip,
  type StickerClip,
  type Subtitle,
  type Mask,
  type ProjectMarker,
  getTrackTransitionAudioFades,
  prepareAudioSpeed,
  prunePreparedAudioSpeed,
  AudioSpeedCapabilityError,
} from "@reelterminal/core";
import { loadAudioBuffer as loadDecodedAudioBuffer } from "../../utils/load-audio-buffer";
import {
  type HandlePosition,
  type InteractionMode,
  formatTime,
  getActiveShapeClips,
  getTransitionAtTime,
  setImageLoadCallback,
  CropModeView,
  MotionPathOverlay,
  computePreviewResolution,
  PREVIEW_MAX_DIMENSION,
  previewQualityScale,
  PREVIEW_QUALITY_OPTIONS,
} from "./preview/index";
import {
  calculateClipTransform,
  calculateOverlayTransform,
  commitPendingCanvasTransform,
  type PendingCanvasTransform,
} from "./preview/canvas-transform";
import { createPreviewTrackIndex } from "./preview/track-index";
import {
  FrameRenderScheduler,
  type FrameRequestToken,
} from "./preview/frame-scheduler";
import { commitRenderedFrame } from "./preview/frame-commit";
import { compareTracksForComposite } from "./preview/composite-track-order";
import { hasOverlappingSortedVideoClips } from "./preview/native-playback-overlap";
import { ProcessingOverlay } from "./ProcessingOverlay";
import type {
  GSAPMotionPathPoint,
  MotionPathConfig,
} from "@reelterminal/core";
import { useTranslation } from "react-i18next";
import {
  clipCssFilterOnly,
  clipNeedsFrameProcessing,
  projectFrameContentRect,
  type PreviewClip,
} from "./preview/frame-compositor";
import { ASPECT_PRESETS, aspectLabelFor } from "./preview/display-options";
import { ReferenceComparisonControl, ReferenceComparisonPanel } from "./preview/ReferenceComparisonPanel";
import {
  computePreviewFrameSize,
  previewFrameOverflows,
  type PreviewZoom,
} from "./preview/preview-viewport";

// Playback frame sourcing must never block the render loop indefinitely: a
// wedged hardware decoder leaves `CanvasSink.getCanvas` pending forever, which
// pins the per-session `isProcessingFrame` latch and freezes the picture while
// the audio-driven clock keeps advancing.
const DECODE_TIMEOUT_MS = 1500;
const PLAYBACK_STALL_TIMEOUT_MS = 2000;
const PLAYBACK_WATCHDOG_INTERVAL_MS = 500;
const PLAYBACK_MAX_AUTO_RESTARTS = 3;

const withTimeout = async <T,>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T | null> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timeoutId = setTimeout(() => {
          console.warn(`[Preview] ${label} timed out after ${ms}ms`);
          resolve(null);
        }, ms);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
};

interface ClipWithPlaceholder {
  isPlaceholder?: boolean;
}

export const Preview: React.FC<{ showHeader?: boolean }> = ({ showHeader = true }) => {
  const previewResourceOwnerRef = useRef<object>({});
  const previewOwnedBlobUrlCountRef = useRef(0);
  const { t: tr } = useTranslation();
  const previewSessionState = useSyncExternalStore(previewSession.subscribe, previewSession.getSnapshot);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const videoAreaRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<number | null>(null);
  const renderBridgeInitialized = useRef<boolean>(false);
  const lastGoodFrameRef = useRef<ImageBitmap | null>(null);
  const lastGoodPlaybackCanvasRef = useRef<OffscreenCanvas | null>(null);
  const playbackCanvasBackRef = useRef<OffscreenCanvas | null>(null);
  const decodeRequestSeqRef = useRef(0);
  const scrubVideoReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const lastPreviewRenderTimeRef = useRef(0);

  // Native video element for hardware-accelerated playback (much faster for 4K)
  const nativePlaybackActiveRef = useRef<boolean>(false);
  const nativeVideoCacheRef = useRef<
    Map<string, { video: HTMLVideoElement; url: string; sourceBlob: Blob }>
  >(new Map());

  const audioGraphRef = useRef<ReturnType<typeof getRealtimeAudioGraph> | null>(
    null,
  );
  const audioBufferCacheRef = useRef<Map<string, AudioBuffer>>(new Map());
  const processedAudioBufferCacheRef = useRef<Map<string, AudioBuffer>>(new Map());
  const noAudioBufferRef = useRef<Set<string>>(new Set());

  const getAudioBufferCacheKey = (mediaId: string, audioTrackIndex?: number): string =>
    `${mediaId}:${audioTrackIndex ?? 0}`;

  const loadAudioBuffer = (
    audioContext: AudioContext | BaseAudioContext,
    blob: Blob,
    audioTrackIndex: number = 0,
  ): Promise<AudioBuffer | null> =>
    loadDecodedAudioBuffer(audioContext, blob, {
      audioTrackIndex,
      respectNoAudioStream: true,
    });

  const getAudioEffectSignature = useCallback((effects: Effect[]): string =>
    JSON.stringify(
      effects.map((effect) => ({
        id: effect.id,
        type: effect.type,
        enabled: effect.enabled,
        params: effect.params,
        metadata: effect.metadata,
      })),
    ), []);

  const getPreviewAudioBufferForEffects = useCallback(
    async (
      audioBuffer: AudioBuffer,
      baseCacheKey: string,
      effects: Effect[],
    ): Promise<{ audioBuffer: AudioBuffer; effects: Effect[] }> => {
      const previewEffects = getPreviewAudioEffects(
        effects.filter((effect) => effect.enabled),
      );
      const { profileAwareNoiseEffects, realtimeEffects } =
        splitProfileAwareNoiseReductionEffects(previewEffects);

      if (profileAwareNoiseEffects.length === 0) {
        return { audioBuffer, effects: realtimeEffects };
      }

      const processedCacheKey = `${baseCacheKey}:profile-denoise:${getAudioEffectSignature(profileAwareNoiseEffects)}`;
      const cached = processedAudioBufferCacheRef.current.get(processedCacheKey);
      if (cached) {
        return { audioBuffer: cached, effects: realtimeEffects };
      }

      const effectsEngine = await initializeAudioEffectsEngine();
      let processedBuffer = audioBuffer;

      for (const effect of profileAwareNoiseEffects) {
        const params = effect.params as AudioEffectParams["noiseReduction"];
        if (!params.profile) {
          continue;
        }

        processedBuffer = await effectsEngine.applyNoiseReductionWithProfileData(
          processedBuffer,
          params.profile,
          params.reduction ?? 0.5,
          params.focus ?? "balanced",
          params.threshold ?? -40,
        );
      }

      processedAudioBufferCacheRef.current.set(processedCacheKey, processedBuffer);
      return { audioBuffer: processedBuffer, effects: realtimeEffects };
    },
    [getAudioEffectSignature],
  );

  const getResolvedClipAudioEffects = useCallback((clip: PreviewClip): Effect[] => {
    return resolveTimelineClipAudioEffects(clip, {
      tracks: timelineTracksRef.current,
    });
  }, []);

  const getResolvedClipVolumeAutomation = useCallback((clip: PreviewClip) =>
    resolveClipVolumeAutomation(clip, {
      tracks: timelineTracksRef.current,
    }), []);

  const [userMuted, setIsMuted] = useState(false);
  const comparisonAudioSide = useProjectStore((state) => state.project?.referenceComparison?.audioSide);
  const referenceComparison = useProjectStore((state) => state.project?.referenceComparison ?? null);
  const isMuted = userMuted || (comparisonAudioSide !== undefined && comparisonAudioSide !== "timeline");
  const [isRenderBridgeReady, setIsRenderBridgeReady] = useState(false);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [videoAreaSize, setVideoAreaSize] = useState({ width: 0, height: 0 });
  const [comparisonControlsContainer, setComparisonControlsContainer] =
    useState<HTMLElement | null>(null);
  const [comparisonSettingsContainer, setComparisonSettingsContainer] =
    useState<HTMLElement | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [previewZoom, setPreviewZoom] = useState<PreviewZoom>({ mode: "fit" });
  const [showZoomMenu, setShowZoomMenu] = useState(false);
  const [showQualityMenu, setShowQualityMenu] = useState(false);
  const [showAspectMenu, setShowAspectMenu] = useState(false);
  const [showCompositionGrid, setShowCompositionGrid] = useState(false);
  const [showSafeMargins, setShowSafeMargins] = useState(false);
  const [canvasSnappingEnabled, setCanvasSnappingEnabled] = useState(true);

  // "agent target point" affordance. While armed, the
  // next real click on the preview canvas is converted to normalized 0..1
  // coordinates against the project frame and stored in the editor context.
  const [targetPointArmed, setTargetPointArmed] = useState(false);
  const setComparisonControlsContainerRef = useCallback(
    (element: HTMLDivElement | null) => {
      setComparisonControlsContainer(element);
    },
    [],
  );
  const setComparisonSettingsContainerRef = useCallback(
    (element: HTMLDivElement | null) => {
      setComparisonSettingsContainer(element);
    },
    [],
  );

  const getLastGoodPreviewFrame = useCallback(
    () => {
      const phase = previewSession.getSnapshot().loading?.phase;
      if (phase === "awaiting-first-valid-frame" || phase === "restoring-context") return null;
      return lastGoodPlaybackCanvasRef.current ?? lastGoodFrameRef.current;
    },
    [],
  );

  const clearPlaybackCanvasBuffers = useCallback(() => {
    lastGoodPlaybackCanvasRef.current = null;
    playbackCanvasBackRef.current = null;
  }, []);

  const rememberPlaybackFrame = useCallback(
    (
      source: CanvasImageSource,
      width: number,
      height: number,
    ): void => {
      let front = lastGoodPlaybackCanvasRef.current;
      let back = playbackCanvasBackRef.current;
      if (
        !front ||
        !back ||
        front.width !== width ||
        front.height !== height ||
        back.width !== width ||
        back.height !== height
      ) {
        try {
          front = new OffscreenCanvas(width, height);
          back = new OffscreenCanvas(width, height);
        } catch {
          return;
        }
      }

      const context = back.getContext("2d");
      if (!context) return;

      try {
        context.clearRect(0, 0, width, height);
        context.drawImage(source, 0, 0, width, height);
      } catch {
        // A failed best-effort snapshot leaves the previously confirmed frame
        // in the front buffer for the next fallback draw.
        return;
      }

      const previousBitmap = lastGoodFrameRef.current;
      lastGoodPlaybackCanvasRef.current = back;
      playbackCanvasBackRef.current = front;
      lastGoodFrameRef.current = null;
      previousBitmap?.close();
    },
    [],
  );
  const agentTargetPoint = useEditorContextStore((state) => state.canvasPoint);
  const setAgentTargetPoint = useEditorContextStore(
    (state) => state.setCanvasPoint,
  );
  const clearAgentTargetPoint = useEditorContextStore(
    (state) => state.clearCanvasPoint,
  );

  const ZOOM_OPTIONS: ReadonlyArray<{ label: string; zoom: PreviewZoom }> = [
    { label: "Fit to window", zoom: { mode: "fit" } },
    ...[50, 75, 100, 125, 150, 200].map((value) => ({
      label: `${value}%`,
      zoom: { mode: "percent" as const, value },
    })),
  ];

  const isDark = useThemeStore((state) => state.isDark);

  // The preview canvas background / letterbox bars. A project "color" canvas
  // fill overrides the theme stage so the preview matches the exported video;
  // otherwise the bars follow the theme (--screen-bg token). Kept in a ref so
  // every render path (scrub, playback, transitions) picks up the current
  // value without re-creating callbacks. (Blur fill draws a cover-fit blurred
  // backdrop of the base clip in both preview and export.)
  const previewBgRef = useRef<string>("#000000");

  // Canvas interaction state for resize/move
  const [interactionMode, setInteractionMode] =
    useState<InteractionMode>("none");
  const [activeHandle, setActiveHandle] = useState<HandlePosition | null>(null);
  const [lockAspectRatio, setLockAspectRatio] = useState(true);
  const interactionStartRef = useRef<{
    x: number;
    y: number;
    transform: { x: number; y: number; scaleX: number; scaleY: number };
  } | null>(null);
  const pendingTransformRef = useRef<PendingCanvasTransform | null>(null);
  const rafIdRef = useRef<number | null>(null);

  // Track if we're currently interacting to prevent re-renders during resize/move
  const isInteractingRef = useRef<boolean>(false);
  // Throttle store updates during interaction (update at most every 32ms ~30fps)
  const lastStoreUpdateRef = useRef<number>(0);
  const STORE_UPDATE_THROTTLE_MS = 32;
  // Throttle playhead updates during playback to reduce React re-renders
  const lastPlayheadUpdateRef = useRef<number>(0);
  // Keep React/timeline updates from competing with continuous media playback.
  // The video canvas still renders on every animation frame; only the heavier
  // editor-wide playhead state update is capped to roughly 30fps.
  const PLAYHEAD_UPDATE_THROTTLE_MS = 33;
  // Live transform state for immediate visual feedback during interaction
  const [liveTransform, setLiveTransform] = useState<{
    position: { x: number; y: number };
    scale: { x: number; y: number };
  } | null>(null);
  const [canvasSnapGuides, setCanvasSnapGuides] = useState<{
    x: number | null;
    y: number | null;
  }>({ x: null, y: null });

  // Track interaction target type (video clip or text clip)
  const [interactionTargetType, setInteractionTargetType] = useState<
    "clip" | "text-clip" | "shape-clip" | null
  >(null);

  // Video element cache for native hardware-accelerated frame decoding (thumbnails/scrubbing)
  // Much more reliable than MediaBunny's CanvasSink for random-access seeking
  const videoElementCacheRef = useRef<
    Map<string, { video: HTMLVideoElement; url: string; sourceBlob: Blob; lastUsed: number; reader: PausedVideoFrameReader }>
  >(new Map());

  const releaseVideoElement = useCallback(
    (entry: { video: HTMLVideoElement; url: string; reader?: PausedVideoFrameReader }): void => {
      const { video, url } = entry;
      if (entry.reader) getPerfSink().count("decoder.released", 1);
      entry.reader?.dispose();
      video.pause();
      video.removeAttribute("src");
      video.onloadedmetadata = null;
      video.onerror = null;
      video.load();
      URL.revokeObjectURL(url);
      previewOwnedBlobUrlCountRef.current -= 1;
    },
    [],
  );

  const evictOldestVideoElement = useCallback((): void => {
    let oldestKey = "";
    let oldestTime = Infinity;
    for (const [key, entry] of videoElementCacheRef.current.entries()) {
      if (entry.lastUsed < oldestTime) {
        oldestTime = entry.lastUsed;
        oldestKey = key;
      }
    }

    if (!oldestKey) return;

    const oldEntry = videoElementCacheRef.current.get(oldestKey);
    if (!oldEntry) return;

    releaseVideoElement(oldEntry);
    videoElementCacheRef.current.delete(oldestKey);
  }, [releaseVideoElement]);

  const cancelPendingScrubDecode = useCallback((): void => {
    // Bumping the sequence marks every in-flight decode stale — its result
    // resolves to null at the next checkpoint instead of painting a frame
    // from a media source that no longer exists.
    decodeRequestSeqRef.current += 1;
    frameSchedulerRef.current?.invalidate();
  }, []);

  const releaseScrubVideoElements = useCallback((): void => {
    if (scrubVideoReleaseTimerRef.current) {
      clearTimeout(scrubVideoReleaseTimerRef.current);
      scrubVideoReleaseTimerRef.current = null;
    }
    cancelPendingScrubDecode();
    for (const entry of videoElementCacheRef.current.values()) {
      releaseVideoElement(entry);
    }
    videoElementCacheRef.current.clear();
  }, [cancelPendingScrubDecode, releaseVideoElement]);

  const scheduleScrubVideoReleaseRef = useRef<() => void>(() => {});
  const scheduleScrubVideoRelease = useCallback((): void => {
    if (scrubVideoReleaseTimerRef.current) {
      clearTimeout(scrubVideoReleaseTimerRef.current);
    }
    scrubVideoReleaseTimerRef.current = setTimeout(() => {
      // Never yank the decoders out from under an active drag or an
      // in-flight render — re-arm instead of clearing.
      if (
        useTimelineStore.getState().isScrubbing ||
        frameSchedulerRef.current?.busy
      ) {
        scrubVideoReleaseTimerRef.current = null;
        scheduleScrubVideoReleaseRef.current();
        return;
      }
      releaseScrubVideoElements();
    }, SCRUB_VIDEO_IDLE_MS);
  }, [releaseScrubVideoElements]);
  scheduleScrubVideoReleaseRef.current = scheduleScrubVideoRelease;

  // Track canvas size changes for resize handles positioning
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setCanvasSize({ width, height });
        // CSS size belongs to the selection handles. The frame compositor
        // owns its buffer at the canvas's internal preview resolution; a
        // resize during async decode must not replace it with an empty one.
      }
    });

    resizeObserver.observe(canvas);
    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    const videoArea = videoAreaRef.current;
    if (!videoArea) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setVideoAreaSize({ width, height });
      }
    });

    resizeObserver.observe(videoArea);
    return () => resizeObserver.disconnect();
  }, []);

  // Project store - subscribe to the entire project to ensure re-renders
  // when any part of the project changes (including clips)
  const project = useProjectStore((state) => state.project);
  const workspaceId = useProjectStore((state) => state.workspaceId);
  const previewViewIdentityRef = useRef({ projectId: project.id, workspaceId, viewGeneration: null as number | null });
  const getMediaItem = useProjectStore((state) => state.getMediaItem);

  useEffect(() => {
    const ownerId = `preview:${workspaceId ?? project.id}`;
    let active = true;
    void installProjectRenderFonts(project, ownerId).then(() => {
      if (active && !isPlayingRef.current) frameSchedulerRef.current?.request(playheadPositionRef.current, useProjectStore.getState().projectRevision, undefined, { force: true });
    }).catch((error: unknown) => {
      console.warn("Could not load a project render font; preview will use its fallback.", error);
    });
    return () => {
      active = false;
      releaseProjectRenderFonts(ownerId);
    };
  }, [project.id, project.renderFonts, workspaceId]);

  // Preview from the active workspace's canonical project snapshot. The
  // EngineStore overlay engines are session-wide derived caches and can lag a
  // workspace activation; project arrays are the authoritative view state.
  const allTextClips = useMemo(() => {
    return project.textClips ?? [];
  }, [project.textClips]);

  const allShapeClips = useMemo(() => {
    return [
      ...(project.shapeClips ?? []),
      ...(project.svgClips ?? []),
      ...(project.stickerClips ?? []),
    ];
  }, [project.shapeClips, project.svgClips, project.stickerClips]);

  const clipMasksById = useMemo(() => {
    const byClip = new Map<string, Mask[]>();
    for (const mask of project.masks ?? []) {
      const existing = byClip.get(mask.clipId) ?? [];
      byClip.set(mask.clipId, [...existing, mask]);
    }
    return byClip;
  }, [project.masks]);

  const allSubtitles = useMemo(() => {
    return project.timeline.subtitles || [];
  }, [project.timeline.subtitles]);

  const updateClipTransform = useProjectStore(
    (state) => state.updateClipTransform,
  );
  const updateTextTransform = useProjectStore(
    (state) => state.updateTextTransform,
  );
  const updateShapeTransform = useProjectStore(
    (state) => state.updateShapeTransform,
  );
  const beginHistoryGroup = useProjectStore((state) => state.beginHistoryGroup);
  const endHistoryGroup = useProjectStore((state) => state.endHistoryGroup);
  const updateSettings = useProjectStore((state) => state.updateSettings);
  const timelineTracks = project.timeline.tracks;
  const previewTrackIndex = useMemo(
    () => createPreviewTrackIndex(timelineTracks),
    [timelineTracks],
  );
  const settings = project.settings;

  const canvasFillMode = project.timeline.backgroundFillMode;
  const canvasFillColor = project.timeline.layoutBackgroundColor;
  useEffect(() => {
    if (canvasFillMode === "color" && canvasFillColor) {
      previewBgRef.current = canvasFillColor;
      return;
    }
    previewBgRef.current = "#000000";
  }, [canvasFillMode, canvasFillColor]);

  const playbackQuality = useUIStore((state) => state.playbackQuality);
  const setPlaybackQuality = useUIStore((state) => state.setPlaybackQuality);
  const previewRes = useMemo(
    () =>
      computePreviewResolution(
        settings.width,
        settings.height,
        PREVIEW_MAX_DIMENSION *
          previewQualityScale(playbackQuality, settings.width, settings.height),
      ),
    [settings.width, settings.height, playbackQuality],
  );

  const previewFrameSize = useMemo(() => {
    return computePreviewFrameSize({
      viewport: videoAreaSize,
      project: { width: settings.width, height: settings.height },
      zoom: previewZoom,
      columns: referenceComparison?.layout === "side-by-side" ? 2 : 1,
    });
  }, [settings.height, settings.width, videoAreaSize, previewZoom, referenceComparison?.layout]);
  const previewFrameHasOverflow = previewFrameOverflows(previewFrameSize, videoAreaSize);

  // Keep a ref to timelineTracks for use in playback effect without causing re-runs
  const timelineTracksRef = useRef(timelineTracks);
  useEffect(() => {
    timelineTracksRef.current = timelineTracks;
  }, [timelineTracks]);

  // Current canvas fill mode in a ref so the (stable) preview-background
  // helper always reads the latest value even when the big render callbacks
  // captured it before the mode changed.
  const canvasFillModeRef = useRef(canvasFillMode);
  useEffect(() => {
    canvasFillModeRef.current = canvasFillMode;
  }, [canvasFillMode]);
  const canvasFillColorRef = useRef(canvasFillColor);
  useEffect(() => {
    canvasFillColorRef.current = canvasFillColor;
  }, [canvasFillColor]);

  // Project pixel dimensions for text/subtitle layout. The preview canvas is
  // downscaled from these, and the text renderers need the original size so
  // project-pixel font sizes stay proportional (same contract as the export
  // path passing settings.width/height). Kept in a ref so the big render
  // callbacks stay stable across settings changes.
  // Keep a ref to isScrubbing for use in playback loop
  const isScrubbingRef = useRef(false);

  const selectedItems = useUIStore((state) => state.selectedItems);
  const cropMode = useUIStore((state) => state.cropMode);
  const cropClipId = useUIStore((state) => state.cropClipId);
  const setCropMode = useUIStore((state) => state.setCropMode);
  const exportState = useUIStore((state) => state.exportState);
  const motionPathMode = useUIStore((state) => state.motionPathMode);
  const motionPathClipId = useUIStore((state) => state.motionPathClipId);
  const select = useUIStore((state) => state.select);

  // Field-by-field selectors instead of a whole-store subscription: scrub
  // ticks change playheadPosition/isScrubbing many times per second and must
  // not drag every unrelated timeline field through a full Preview re-render.
  const playheadPosition = useTimelineStore((state) => state.playheadPosition);
  const playbackState = useTimelineStore((state) => state.playbackState);
  const playbackLockedReason = useTimelineStore(
    (state) => state.playbackLockedReason,
  );
  const playbackRate = useTimelineStore((state) => state.playbackRate);
  const isScrubbing = useTimelineStore((state) => state.isScrubbing);
  const pause = useTimelineStore((state) => state.pause);
  const togglePlayback = useTimelineStore((state) => state.togglePlayback);
  const setPlayheadPosition = useTimelineStore(
    (state) => state.setPlayheadPosition,
  );

  useEffect(() => {
    isScrubbingRef.current = isScrubbing;
  }, [isScrubbing]);

  const isPlaying = playbackState === "playing";

  const motionPathClip = React.useMemo(() => {
    if (!motionPathMode || !motionPathClipId) return null;
    for (const track of project.timeline.tracks) {
      const clip = track.clips.find((c) => c.id === motionPathClipId);
      if (clip) return clip;
    }
    return null;
  }, [motionPathMode, motionPathClipId, project.timeline.tracks]);

  const [motionPathConfig, setMotionPathConfig] = React.useState<MotionPathConfig | null>(null);

  React.useEffect(() => {
    if (motionPathClip) {
      setMotionPathConfig({
        clipId: motionPathClip.id,
        enabled: true,
        pathType: "bezier",
        points: [],
        showPath: true,
        autoOrient: false,
        alignOrigin: [0.5, 0.5],
      });
    } else {
      setMotionPathConfig(null);
    }
  }, [motionPathClip]);

  const handleMotionPathPointMove = React.useCallback(
    (index: number, x: number, y: number) => {
      setMotionPathConfig((prev) => {
        if (!prev) return prev;
        const newPoints = [...prev.points];
        newPoints[index] = { ...newPoints[index], x, y };
        return { ...prev, points: newPoints };
      });
    },
    []
  );

  const handleMotionPathPointAdd = React.useCallback(
    (point: GSAPMotionPathPoint) => {
      setMotionPathConfig((prev) => {
        if (!prev) return prev;
        const newPoints = [...prev.points, point].sort((a, b) => a.time - b.time);
        return { ...prev, points: newPoints };
      });
    },
    []
  );

  const handleMotionPathPointRemove = React.useCallback((index: number) => {
    setMotionPathConfig((prev) => {
      if (!prev) return prev;
      const newPoints = prev.points.filter((_, i) => i !== index);
      return { ...prev, points: newPoints };
    });
  }, []);

  const handleMotionPathControlPointMove = React.useCallback(
    (pointIndex: number, handleType: "cp1" | "cp2", x: number, y: number) => {
      setMotionPathConfig((prev) => {
        if (!prev) return prev;
        const newPoints = [...prev.points];
        const point = newPoints[pointIndex];
        if (!point.controlPoints) {
          point.controlPoints = { cp1: { x: 0, y: 0 }, cp2: { x: 0, y: 0 } };
        }
        point.controlPoints[handleType] = { x, y };
        return { ...prev, points: newPoints };
      });
    },
    []
  );

  // Include every authored timeline surface, including Motion, subtitles and
  // adjustment layers, in the clock's playback range.
  const actualEndTime = useMemo(() => calculateProjectDuration(project), [project]);

  // RenderBridge is guaranteed to be initialized before Preview renders (see EditorInterface)
  useEffect(() => {
    if (renderBridgeInitialized.current) return;

    const bridge = getRenderBridge();
    if (canvasRef.current) {
      bridge.setCanvas(canvasRef.current);
    }
    renderBridgeInitialized.current = true;
    setIsRenderBridgeReady(true);
  }, []);

  useEffect(() => {
    const nativeVideoCache = nativeVideoCacheRef.current;
    return () => {
      releaseScrubVideoElements();
      // Expire every in-flight render and free the remembered frame — a late
      // task must never paint into an unmounted canvas.
      frameSchedulerRef.current?.invalidate();

      for (const [, entry] of nativeVideoCache) {
        releaseVideoElement(entry);
      }
      nativeVideoCache.clear();

      lastGoodFrameRef.current?.close();
      lastGoodFrameRef.current = null;
      clearPlaybackCanvasBuffers();
    };
  }, [
    clearPlaybackCanvasBuffers,
    releaseScrubVideoElements,
    releaseVideoElement,
  ]);

  // Set canvas internal resolution ONLY when project settings change
  // This follows the WebGPU best practice of keeping internal resolution fixed
  // and using CSS/transforms for display scaling (prevents flickering during resize)
  // Using useLayoutEffect to ensure canvas size is set before first paint
  React.useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Always ensure canvas has correct size
    if (
      canvas.width !== previewRes.width ||
      canvas.height !== previewRes.height
    ) {
      canvas.width = previewRes.width;
      canvas.height = previewRes.height;
    }
  }, [previewRes.width, previewRes.height]);

  useEffect(() => {
    if (isRenderBridgeReady && canvasRef.current) {
      const bridge = getRenderBridge();
      bridge.setCanvas(canvasRef.current);
    }
  }, [isRenderBridgeReady]);

  const rateRef = useRef(playbackRate);
  const startPositionRef = useRef(playheadPosition);
  // Watchdog heartbeat: timestamp of the last frame actually presented to the
  // visible canvas. A wedged render loop leaves the picture frozen while the
  // audio clock keeps publishing time, so the heartbeat is the only reliable
  // stall signal.
  const lastPresentedFrameAtRef = useRef<number>(0);
  const playbackRestartCountRef = useRef<number>(0);
  const [playbackSessionNonce, setPlaybackSessionNonce] = useState(0);

  // MediaBunny playback resources - map of clipId to resources for multi-track playback
  const playbackResourcesRef = useRef<
    Map<
      string,
      {
        input: { [Symbol.dispose]?: () => void };
        sink: unknown;
        mediaId: string;
        sourceBlob: Blob;
        clipId: string;
        trackIndex: number;
      }
    >
  >(new Map());


  useEffect(() => {
    rateRef.current = playbackRate;
  }, [playbackRate]);

  useEffect(() => {
    if (!isPlaying) {
      startPositionRef.current = playheadPosition;
    }
  }, [isPlaying, playheadPosition]);

  const cleanupPlaybackResources = useCallback(() => {
    const resources = playbackResourcesRef.current;
    for (const [, resource] of resources) {
      resource.input[Symbol.dispose]?.();
    }
    playbackResourcesRef.current = new Map();

  }, []);

  useEffect(() => () => cleanupPlaybackResources(), [cleanupPlaybackResources]);

  const cleanupAudioResources = useCallback(() => {
    if (audioGraphRef.current) {
      audioGraphRef.current.stopScheduler();
      audioGraphRef.current.stopAllClips();
    }
  }, []);

  useEffect(() => {
    if (audioGraphRef.current) {
      audioGraphRef.current.setPreviewMuted(isMuted);
    }
  }, [isMuted]);

  const preDecodeAllAudioBuffers = useCallback(async (): Promise<void> => {
    const tracks = timelineTracksRef.current;
    const audioTracks = tracks.filter((t) => t.type === "audio" && !t.hidden);
    const videoTracks = tracks.filter(
      (t) => (t.type === "video" || t.type === "image") && !t.hidden,
    );

    if (!audioGraphRef.current) {
      audioGraphRef.current = getRealtimeAudioGraph();
    }
    const audioGraph = audioGraphRef.current;
    const audioContext = audioGraph.getAudioContext();

    const allTracks = [...audioTracks, ...videoTracks];
    const clipIds = new Set(allTracks.flatMap((track) => track.clips.map((clip) => clip.id)));
    for (const buffer of audioBufferCacheRef.current.values()) prunePreparedAudioSpeed(buffer, clipIds);
    const hasSoloTracks = allTracks.some((track) => track.type !== "image" && track.solo);

    for (const track of allTracks) {
      for (const clip of track.clips) {
        const cacheKey = getAudioBufferCacheKey(clip.mediaId, clip.audioTrackIndex);
        let audioBuffer: AudioBuffer | null | undefined =
          audioBufferCacheRef.current.get(cacheKey);

        if (!audioBuffer) {
          if (noAudioBufferRef.current.has(cacheKey)) {
            continue;
          }
          const mediaItem = getMediaItem(clip.mediaId);
          if (!mediaItem?.blob) {
            continue;
          }

          try {
            audioBuffer = await loadAudioBuffer(
              audioContext,
              mediaItem.blob,
              clip.audioTrackIndex ?? 0,
            );
            if (audioBuffer) {
              audioBufferCacheRef.current.set(cacheKey, audioBuffer);
            } else {
              noAudioBufferRef.current.add(cacheKey);
            }
          } catch {
            audioBuffer = null;
            noAudioBufferRef.current.add(cacheKey);
          }
        }

        if (audioBuffer) {
          let previewBuffer = audioBuffer;
          const audioEffects = getResolvedClipAudioEffects(clip).filter(
            (effect: Effect) => effect.enabled,
          );
          if (audioEffects.length > 0) {
            previewBuffer = (await getPreviewAudioBufferForEffects(audioBuffer, cacheKey, audioEffects)).audioBuffer;
          }
          if (!track.muted && (!hasSoloTracks || track.solo) &&
              (clip.volume > 0 || clip.automation?.volume?.some((point) => point.value > 0))) {
            await prepareAudioSpeed(audioContext, previewBuffer, clip);
          }
        }
      }
    }
  }, [getMediaItem, getPreviewAudioBufferForEffects, getResolvedClipAudioEffects]);

  // Pre-warm audio decode caches when the timeline settles after an edit (e.g.
  // moving/adding a clip), so the realtime scheduler finds decoded buffers ready
  // on the first play tick instead of silently dropping clips until a lazy decode
  // lands (~0.5-1s "lag then smooth"). Debounced so it never runs mid-drag, and
  // skipped during playback. preDecodeAllAudioBuffers is idempotent (cached and
  // negatively-cached buffers are no-ops), so re-warming after each edit is cheap.
  const audioWarmupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioWarmupIdleRef = useRef<number | null>(null);
  useEffect(() => {
    if (isPlaying) {
      return;
    }

    if (audioWarmupTimerRef.current) {
      clearTimeout(audioWarmupTimerRef.current);
    }

    audioWarmupTimerRef.current = setTimeout(() => {
      audioWarmupTimerRef.current = null;
      if (isInteractingRef.current) {
        return;
      }

      const warm = () => {
        void preDecodeAllAudioBuffers().catch(() => {});
      };

      const idle = (
        window as Window & {
          requestIdleCallback?: (
            cb: () => void,
            opts?: { timeout: number },
          ) => number;
        }
      ).requestIdleCallback;

      if (typeof idle === "function") {
        audioWarmupIdleRef.current = idle(warm, { timeout: 1000 });
      } else {
        warm();
      }
    }, 250);

    return () => {
      if (audioWarmupTimerRef.current) {
        clearTimeout(audioWarmupTimerRef.current);
        audioWarmupTimerRef.current = null;
      }
    };
  }, [timelineTracks, isPlaying, preDecodeAllAudioBuffers]);

  const getAudioClipsForScheduler = useCallback(
    (time: number): AudioClipSchedule[] => {
      const tracks = timelineTracksRef.current;
      const tracksWithAudio = tracks.filter(
        (t) => (t.type === "audio" || t.type === "video") && !t.hidden && !t.muted &&
          (!tracks.some((candidate) => !candidate.hidden &&
            (candidate.type === "audio" || candidate.type === "video") && candidate.solo) || t.solo),
      );
      const schedules: AudioClipSchedule[] = [];

      for (const track of tracksWithAudio) {
        for (const clip of track.clips) {
          const clipEnd = clip.startTime + clip.duration;
          if (clipEnd <= time || clip.startTime > time + 1) {
            continue;
          }

          const audioBuffer = audioBufferCacheRef.current.get(
            getAudioBufferCacheKey(clip.mediaId, clip.audioTrackIndex),
          );
          if (!audioBuffer) {
            continue;
          }

          const audioEffects = getResolvedClipAudioEffects(clip).filter(
            (e: Effect) => e.enabled,
          );
          const previewEffects = getPreviewAudioEffects(audioEffects);
          const { profileAwareNoiseEffects, realtimeEffects } =
            splitProfileAwareNoiseReductionEffects(previewEffects);
          let scheduleAudioBuffer = audioBuffer;
          let scheduleEffects = previewEffects;

          if (profileAwareNoiseEffects.length > 0) {
            const processedCacheKey = `${getAudioBufferCacheKey(
              clip.mediaId,
              clip.audioTrackIndex,
            )}:profile-denoise:${getAudioEffectSignature(profileAwareNoiseEffects)}`;
            const processedAudioBuffer =
              processedAudioBufferCacheRef.current.get(processedCacheKey);

            if (processedAudioBuffer) {
              scheduleAudioBuffer = processedAudioBuffer;
              scheduleEffects = realtimeEffects;
            }
          }
          const transitionFades = getTrackTransitionAudioFades(track, clip.id);

          schedules.push({
            clipId: clip.id,
            trackId: track.id,
            audioBuffer: scheduleAudioBuffer,
            startTime: clip.startTime,
            endTime: clipEnd,
            mediaOffset: clip.inPoint || 0,
            mediaEnd: clip.outPoint,
            reversed: clip.reversed,
            speedKeyframes: clip.speedKeyframes,
            freezeFrames: clip.freezeFrames,
            pitchCorrection: clip.pitchCorrection,
            volume: clip.volume ?? 1,
            volumeAutomation: getResolvedClipVolumeAutomation(clip),
            pan: 0,
            effects: scheduleEffects,
            speed: clip.speed ?? 1,
            fadeIn: Math.max(
              clip.fade?.fadeIn ?? 0,
              transitionFades.fadeIn,
            ),
            fadeOut: Math.max(
              clip.fade?.fadeOut ?? 0,
              transitionFades.fadeOut,
            ),
          });
        }
      }

      return schedules;
    },
    [
      getAudioEffectSignature,
      getResolvedClipAudioEffects,
      getResolvedClipVolumeAutomation,
    ],
  );

  /**
   * Decode a single frame from a clip at a specific time using native video element
   * Native video elements provide reliable hardware-accelerated random-access seeking
   */
  const decodeClipFrame = useCallback(
    async (
      clip: {
        id: string;
        mediaId: string;
        startTime: number;
        inPoint?: number;
      },
      mediaItem: NonNullable<ReturnType<typeof getMediaItem>>,
      time: number,
      sourceTime: number,
      token?: FrameRequestToken,
    ): Promise<ImageBitmap | null> => {
      if (!mediaItem.blob) return null;
      const mediaBlob = mediaItem.blob;

      if (mediaItem.type === "image") {
        try {
          return await createImageBitmap(mediaItem.blob);
        } catch {
          return null;
        }
      }

      const requestSeq = ++decodeRequestSeqRef.current;
      const isStaleRequest = () => requestSeq !== decodeRequestSeqRef.current;

      if (scrubVideoReleaseTimerRef.current) {
        clearTimeout(scrubVideoReleaseTimerRef.current);
        scrubVideoReleaseTimerRef.current = null;
      }

      // No trailing debounce here: the FrameRenderScheduler already keeps at
      // most one render in flight with the latest target pending, so a plain
      // decode runs as soon as it is asked for. (A trailing debounce reset by
      // every pointer move meant a continuous drag produced zero frames.)
      try {
        const mediaTime = sourceTime;
        const cacheKey = scrubVideoCacheKey(clip.id, mediaItem.id, false);
        let cached = videoElementCacheRef.current.get(cacheKey);
        if (cached && cached.sourceBlob !== mediaBlob) {
          releaseVideoElement(cached);
          videoElementCacheRef.current.delete(cacheKey);
          cached = undefined;
        }

        if (!cached) {
          const url = URL.createObjectURL(mediaBlob);
          previewOwnedBlobUrlCountRef.current += 1;
          const video = document.createElement("video");
          video.src = url;
          video.muted = true;
          video.playsInline = true;
          video.preload = "metadata";
          video.crossOrigin = "anonymous";
          const reader = new PausedVideoFrameReader(video);
          cached = { video, url, sourceBlob: mediaBlob, lastUsed: Date.now(), reader };
          videoElementCacheRef.current.set(cacheKey, cached);
          getPerfSink().count("decoder.created", 1);
          const loaded = token?.performance
            ? await withPerfSpan("frame.video-load", token.performance.context, () => reader.waitForMetadata())
            : await reader.waitForMetadata();
          if (isStaleRequest() || (loaded !== "ready" && loaded !== "cached")) {
            finishPreviewSeek(token?.seek, isStaleRequest() ? "cancelled" : loaded === "timeout" ? "timeout" : "error");
            if (videoElementCacheRef.current.get(cacheKey) === cached) {
              releaseVideoElement(cached);
              videoElementCacheRef.current.delete(cacheKey);
            }
            return null;
          }

          const cacheLimit = scrubVideoCacheLimit(timelineTracksRef.current, time, id => getMediaItem(id)?.type);
          while (videoElementCacheRef.current.size > cacheLimit) {
            evictOldestVideoElement();
          }
        }

        getPerfSink().count("decoder.used", 1);
        cached.lastUsed = Date.now();
        const { video } = cached;

        const clampedTime = Math.max(
          0,
          Math.min(mediaTime, video.duration - 0.001),
        );
        // Chromium converts seeks to microseconds. Round upward so an exact
        // project-frame boundary (for example 32/30s) cannot truncate to the
        // preceding source frame. This moves the target by less than 1us.
        const seekTime = clampedTime <= 0 && video.duration > 0.002
          ? 0.001 : Math.ceil(clampedTime * 1_000_000) / 1_000_000;
        markPerfOperation(token?.performance, "frame.video-seek-target", { sourceTimeSeconds: seekTime });
        const identity = useProjectStore.getState();
        const readFrame = () => cached.reader.seek(seekTime, () => {
            const state = useProjectStore.getState();
            if (videoElementCacheRef.current.get(cacheKey)?.video === video &&
              !isPlayingRef.current && playheadPositionRef.current === time &&
              state.project.id === identity.project.id && state.workspaceId === identity.workspaceId &&
              state.projectRevision === identity.projectRevision &&
              (token?.viewGeneration === undefined || token.viewGeneration === getPreviewViewGeneration())) {
              requestFrameRender(time, true);
            }
          });
        const result = token?.performance
          ? await withPerfSpan("frame.video-seek", token.performance.context, readFrame)
          : await readFrame();
        markPerfOperation(token?.performance, `frame.video-${result}`);
        getPerfSink().count(`decoder.seek-${result}`, 1);
        if (result === "cached") getPerfSink().count("decoder.cache-hit", 1);
        if (result !== "ready" && result !== "cached") {
          finishPreviewSeek(token?.seek, result === "timeout" ? "timeout" : result === "error" ? "error" : "cancelled");
          scheduleScrubVideoRelease();
          return null;
        }
        if (isStaleRequest()) return null;

        const frame = await createImageBitmap(video);
        if (isStaleRequest()) {
          frame.close();
          return null;
        }
        scheduleScrubVideoRelease();
        return frame;
      } catch {
        // Evict using the same clip/source/stabilization identity as lookup.
        finishPreviewSeek(token?.seek, "error");
        const failedKey = scrubVideoCacheKey(
          clip.id,
          mediaItem.id,
          false,
        );
        const cached = videoElementCacheRef.current.get(failedKey);
        if (cached) {
          releaseVideoElement(cached);
          videoElementCacheRef.current.delete(failedKey);
        }
        scheduleScrubVideoRelease();
        return null;
      }
    },
    [
      evictOldestVideoElement,
      getMediaItem,
      releaseVideoElement,
      scheduleScrubVideoRelease,
    ],
  );

  // Background for empty-project and missing-media hints only.
  const fillPreviewBackground = useCallback(
    (
      ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
      _time: number,
      width: number,
      height: number,
    ): void => {
      if (canvasFillModeRef.current === "color" && canvasFillColorRef.current) {
        ctx.fillStyle = canvasFillColorRef.current;
      } else {
        ctx.fillStyle = previewBgRef.current;
      }
      ctx.fillRect(0, 0, width, height);
    },
    [],
  );

  // Paused seeking keeps its bounded native decoder and scheduler. Only raw
  // source pixels cross into the compositor; transforms, overlays and effects
  // are evaluated once from the same immutable project snapshot as export.
  const renderFrameDirectly = useCallback(
    async (time: number, token?: FrameRequestToken): Promise<boolean> => {
      const canvas = canvasRef.current;
      const mainCtx = canvas?.getContext("2d");
      if (!canvas || !mainCtx) return false;
      const snapshot = useProjectStore.getState().project;
      const duration = calculateProjectDuration(snapshot);
      if (duration === 0) return false;
      const sampleTime = timelineSampleTime(
        time, duration, snapshot.settings.frameRate,
      );
      const scheduler = frameSchedulerRef.current;
      const isCurrent = () => !token || !scheduler || scheduler.isCurrent(token);
      const visibleClips = snapshot.timeline.tracks
        .filter(track =>
          !track.hidden && (track.type === "video" || track.type === "image"),
        )
        .flatMap(track => track.clips)
        .filter(clip =>
          sampleTime >= clip.startTime && sampleTime < clip.startTime + clip.duration,
        );
      if (visibleClips.some(clip => (clip as ClipWithPlaceholder).isPlaceholder)) return false;
      const expectedVideoClipIds = new Set(
        visibleClips
          .filter(clip =>
            typeof clip.metadata?.compoundClipId !== "string" &&
            !clip.mediaId.startsWith("compound:"),
          )
          .map(clip => clip.id),
      );
      const decodeSourceFrame: NonNullable<FrameRenderOptions["decodeSourceFrame"]> = async (clip, media, sourceTime) => {
        const isTopLevelClip = snapshot.timeline.tracks.some(track =>
          track.clips.some(item => item === clip),
        );
        if (media.type !== "video" || !isTopLevelClip) return null;
        const decode = () => decodeClipFrame(clip, media, time, sourceTime, token);
        const frame = token?.performance
          ? await withPerfSpan("frame.decode", {
              ...token.performance.context,
              parentSpanId: token.performance.span.id,
            }, decode)
          : await decode();
        markPerfOperation(token?.performance, "frame.decoded", { frameAvailable: Boolean(frame) });
        return frame;
      };
      const frame = await getRenderBridge().renderFrame(sampleTime, {
        project: snapshot,
        width: canvas.width || previewRes.width,
        height: canvas.height || previewRes.height,
        realtime: false,
        decodeSourceFrame,
        isCurrent,
      });
      if (!frame) return false;
      try {
        const phase = previewSession.getSnapshot().loading?.phase;
        const historyFramePending =
          phase === "awaiting-first-valid-frame" || phase === "restoring-context";
        const decodedVideoClipIds = new Set(frame.decodedClipIds ?? []);
        const completeVideoContent = [...expectedVideoClipIds].every(id => decodedVideoClipIds.has(id));
        if (!canCommitHistoryFrame({
          historyFramePending,
          renderedContent: true,
          expectedVideoClipIds,
          decodedVideoClipIds,
        })) return false;
        if (!completeVideoContent && getLastGoodPreviewFrame()) return false;
        markPerfOperation(token?.performance, "frame.composited");
        const result = await commitRenderedFrame(
          {
            isCurrent,
            claimCommit: () => !token || !scheduler || scheduler.markCommitted(token),
            lastGood: lastGoodFrameRef,
          },
          {
            produce: () => createImageBitmap(frame.image),
            paint: committed => {
              mainCtx.clearRect(0, 0, canvas.width, canvas.height);
              mainCtx.drawImage(committed, 0, 0, canvas.width, canvas.height);
            },
          },
        );
        if (result === "committed") {
          recordCommittedPreviewFrame(snapshot, token, completeVideoContent);
          clearPlaybackCanvasBuffers();
        }
        return result === "committed";
      } finally {
        frame.image.close();
      }
    },
    [
      decodeClipFrame,
      previewRes.width,
      previewRes.height,
      getLastGoodPreviewFrame,
      clearPlaybackCanvasBuffers,
    ],
  );

  const renderFrameDirectlyRef = useRef(renderFrameDirectly);
  useEffect(() => {
    renderFrameDirectlyRef.current = renderFrameDirectly;
  }, [renderFrameDirectly]);

  const isPlayingRef = useRef(isPlaying);
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  const playheadPositionRef = useRef(playheadPosition);
  useEffect(() => {
    playheadPositionRef.current = playheadPosition;
  }, [playheadPosition]);

  const renderFallbackFrame = useCallback(
    async (time: number, token?: FrameRequestToken) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      if (canvas.width === 0 || canvas.height === 0) {
        canvas.width = previewRes.width;
        canvas.height = previewRes.height;
      }

      const fallbackCanvas = new OffscreenCanvas(canvas.width, canvas.height);
      const ctx = fallbackCanvas.getContext("2d") as unknown as CanvasRenderingContext2D | null;
      if (!ctx) return;
      const scheduler = frameSchedulerRef.current;
      const isCurrent = () => !token || !scheduler || scheduler.isCurrent(token);
      if (!isCurrent()) return;

      const snapshot = useProjectStore.getState().project;
      const emptyText = isDark ? "#52525b" : "#a1a1aa";
      const textPrimary = isDark ? "#ffffff" : "#18181b";
      const textSecondary = isDark ? "#a1a1aa" : "#71717a";

      const hasActiveVideoContent = timelineTracks.some((track) =>
        (track.type === "video" || track.type === "image") && !track.hidden &&
        track.clips.some((clip) =>
          time >= clip.startTime && time < clip.startTime + clip.duration &&
          !(clip as ClipWithPlaceholder).isPlaceholder,
        ),
      );
      const historyFramePhase = previewSession.getSnapshot().loading?.phase;
      const historyFramePending =
        historyFramePhase === "awaiting-first-valid-frame" || historyFramePhase === "restoring-context";
      // A missing media frame may temporarily retain the last complete image,
      // but never paint new overlays onto that already-composited image.
      const lastGood = getLastGoodPreviewFrame();
      if (lastGood && hasActiveVideoContent && !historyFramePending) return;
      fillPreviewBackground(ctx, time, fallbackCanvas.width, fallbackCanvas.height);

      const allRenderableTracks = timelineTracks
        .map((track, idx) => ({ track, originalIndex: idx }))
        .filter(
          ({ track }) =>
            (track.type === "video" ||
              track.type === "image" ||
              track.type === "text" ||
              track.type === "graphics") &&
            !track.hidden,
        )
        .sort(compareTracksForComposite);

      for (const { track } of allRenderableTracks) {
        if (track.type === "video" || track.type === "image") {
          for (const clip of track.clips) {
            const clipStart = clip.startTime;
            const clipEnd = clip.startTime + clip.duration;

            if (time >= clipStart && time < clipEnd) {
              const mediaItem = getMediaItem(clip.mediaId);
              if (mediaItem) {
                if (!isCurrent()) return;
                ctx.fillStyle = textPrimary;
                ctx.font = "bold 24px Inter, sans-serif";
                ctx.textAlign = "center";
                ctx.fillText(
                  mediaItem.name,
                  fallbackCanvas.width / 2,
                  fallbackCanvas.height / 2,
                );
                ctx.font = "16px Inter, sans-serif";
                ctx.fillStyle = textSecondary;
                ctx.fillText(
                  `${formatTime(time)} / ${formatTime(clip.duration)}`,
                  fallbackCanvas.width / 2,
                  fallbackCanvas.height / 2 + 30,
                );
              } else if ((clip as ClipWithPlaceholder).isPlaceholder) {
                if (!isCurrent()) return;
                ctx.fillStyle = textSecondary;
                ctx.font = "bold 20px Inter, sans-serif";
                ctx.textAlign = "center";
                ctx.fillText(
                  "Drop media here",
                  fallbackCanvas.width / 2,
                  fallbackCanvas.height / 2,
                );
                ctx.font = "14px Inter, sans-serif";
                ctx.fillStyle = emptyText;
                ctx.fillText(
                  "Replace this placeholder with your content",
                  fallbackCanvas.width / 2,
                  fallbackCanvas.height / 2 + 28,
                );
              }
            }
          }
        }
      }

      // Empty-state hint reflects the timeline itself, not the frame under the
      // playhead: with clips on the timeline the playhead can still sit in a
      // gap between them, and hinting "import media" there is wrong. Show the
      // hint only while no track holds any clip (motion instances, which are
      // not clips, still suppress it while they render).
      const timelineHasNoClips = timelineTracks.every(
        (track) => track.clips.length === 0,
      );

      if (timelineHasNoClips && calculateProjectDuration(snapshot) === 0) {
        if (!isCurrent()) return;
        ctx.fillStyle = emptyText;
        ctx.font = "24px Inter, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(tr("Import media to get started"), fallbackCanvas.width / 2, fallbackCanvas.height / 2);
      }

      const targetCanvas = canvasRef.current;
      const targetContext = targetCanvas?.getContext("2d");
      if (!targetCanvas || !targetContext || !isCurrent()) return;
      if (historyFramePending && hasActiveVideoContent) return;
      const commitResult = await commitRenderedFrame(
        {
          isCurrent,
          claimCommit: () => !token || !scheduler || scheduler.markCommitted(token),
          lastGood: lastGoodFrameRef,
        },
        {
          produce: () => createImageBitmap(fallbackCanvas),
          paint: (frame) => {
            targetContext.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
            targetContext.drawImage(frame, 0, 0, targetCanvas.width, targetCanvas.height);
          },
        },
      );
      if (commitResult === "committed") {
        // A committed background is a valid first frame for an intentionally
        // empty timeline. A media clip awaiting decode is not: keep loading
        // until its actual content frame commits.
        recordCommittedPreviewFrame(
          useProjectStore.getState().project,
          token,
          !hasActiveVideoContent,
        );
        clearPlaybackCanvasBuffers();
      }
    },
    [
      timelineTracks,
      getMediaItem,
      previewRes.width,
      previewRes.height,
      fillPreviewBackground,
      clearPlaybackCanvasBuffers,
      getLastGoodPreviewFrame,
      isDark,
      tr,
    ],
  );

  const renderFallbackFrameRef = useRef(renderFallbackFrame);
  useEffect(() => {
    renderFallbackFrameRef.current = renderFallbackFrame;
  }, [renderFallbackFrame]);

  // Single owner of paused-preview frame rendering: at most one render in
  // flight, only the latest requested target kept pending. Replaces the old
  // trailing debounce in decodeClipFrame — that debounce was reset by every
  // pointer move, so a continuous drag produced zero frames until the pointer
  // stopped. Every async draw entry (scrub effect, image loads, transform
  // commits, preview invalidations) routes through requestFrameRender so an
  // old task can never paint over a newer seek.
  const frameSchedulerRef = useRef<FrameRenderScheduler | null>(null);
  if (!frameSchedulerRef.current) {
    frameSchedulerRef.current = new FrameRenderScheduler(async (token) => {
      const projectAtStart = useProjectStore.getState().project;
      try {
        const rendered = await renderFrameDirectlyRef.current(token.time, token);
        if (!rendered) {
          await renderFallbackFrameRef.current(token.time, token);
        }
      } catch (error) {
        console.warn("[Preview] frame render failed:", error);
        if (frameSchedulerRef.current?.isCurrent(token)) {
          await previewSession.failPendingFrame(projectAtStart, error);
        }
      }
    }, getPreviewViewGeneration, () => {
      const state = useProjectStore.getState();
      return JSON.stringify([state.project.id, state.workspaceId, state.projectRevision]);
    });
  }

  const requestFrameRender = useCallback((time: number, force = false) => {
    const state = useProjectStore.getState();
    const seek = getPreviewSeek(time, { projectId: state.project.id, workspaceId: state.workspaceId, revision: state.projectRevision });
    frameSchedulerRef.current?.request(
      time,
      state.projectRevision,
      getPerfSink().enabled ? seek?.operation ?? getPreviewPerfOperation(state.project) ?? getProjectPerfOperation(state.project) : undefined,
      { continuous: seek?.kind === "frame-step" || seek?.kind === "scrub", seek, force },
    );
  }, []);

  useEffect(() => {
    setImageLoadCallback(() => {
      if (!isPlayingRef.current) {
        requestFrameRender(playheadPositionRef.current, true);
      }
    });
    return () => setImageLoadCallback(null);
  }, [requestFrameRender]);

  // Check if we can use native video element playback (much faster, hardware-accelerated)
  const canUseNativeVideoPlayback = useCallback(
    (
      startPosition: number,
    ): {
      canUse: boolean;
      clips: Array<{
        clip: (typeof timelineTracks)[0]["clips"][0];
        mediaItem: NonNullable<ReturnType<typeof getMediaItem>>;
      }>;
      imageClips?: Array<{
        clip: (typeof timelineTracks)[0]["clips"][0];
        trackIndex: number;
      }>;
    } => {
      const tracks = timelineTracks;
      if (
        tracks.some(
          (track) =>
            !track.hidden &&
            track.clips.some(
              (clip) =>
                clip.startTime + clip.duration > startPosition &&
                typeof clip.metadata?.compoundClipId === "string",
            ),
        )
      ) {
        return { canUse: false, clips: [] };
      }
      const videoTracks = tracks.filter((t) => t.type === "video" && !t.hidden);

      const allVideoClips: Array<{
        clip: (typeof tracks)[0]["clips"][0];
        mediaItem: NonNullable<ReturnType<typeof getMediaItem>>;
      }> = [];
      for (const track of videoTracks) {
        for (const clip of track.clips) {
          if (clip.startTime + clip.duration > startPosition) {
            if (clip.stabilization?.renderedSource || clipMasksById.has(clip.id)) {
              return { canUse: false, clips: [] };
            }
            const mediaItem = getMediaItem(clip.mediaId);
            if (mediaItem?.blob && mediaItem.type === "video") {
              if (
                !hasMatchingNativeFrameRate(mediaItem.metadata?.frameRate, project.settings.frameRate) ||
                (clip.speed ?? 1) !== 1 ||
                clip.reversed ||
                Boolean(clip.speedKeyframes?.length) ||
                Boolean(clip.freezeFrames?.length) ||
                (clipNeedsFrameProcessing(clip.id) &&
                  clipCssFilterOnly(clip.id) === null)
              ) {
                return { canUse: false, clips: [] };
              }
              allVideoClips.push({ clip, mediaItem });
            }
          }
        }
      }

      const hasActiveAudioEffects = tracks.some(
        (track) =>
          (track.type === "audio" || track.type === "video") &&
          !track.hidden &&
          track.clips.some((clip) => {
            if (clip.startTime + clip.duration <= startPosition) {
              return false;
            }

            return getPreviewAudioEffects(
              getResolvedClipAudioEffects(clip),
            ).some(
              (effect) => effect.enabled,
            );
          }),
      );

      if (hasActiveAudioEffects) {
        return { canUse: false, clips: [] };
      }

      if (allVideoClips.length === 0) return { canUse: false, clips: [] };

      allVideoClips.sort((a, b) => a.clip.startTime - b.clip.startTime);

      // Check for overlapping clips (multi-layer) - can't use native playback for compositing
      if (
        hasOverlappingSortedVideoClips(
          allVideoClips.map(({ clip }) => clip),
        )
      ) {
        return { canUse: false, clips: [] };
      }

      // Note: Text/graphics overlays are now supported in native video playback
      // They are rendered using CPU canvas2D after the video frame

      // Collect image clips for background compositing (don't disable native
      // playback). Image clips may also sit on video tracks (e.g. a JPG still
      // next to MP4 clips) — collecting only image tracks made those stills
      // invisible during playback while the paused preview showed them.
      const imageClips = collectNativePlaybackImageClips(
        tracks,
        (clip) => getMediaItem(clip.mediaId)?.type,
      );

      if (imageClips.some(({ clip }) => clipMasksById.has(clip.id))) {
        return { canUse: false, clips: [] };
      }

      return { canUse: true, clips: allVideoClips, imageClips };
    },
    [timelineTracks, getMediaItem, getResolvedClipAudioEffects, clipMasksById, project.settings.frameRate],
  );

  // Start native video playback using hardware-accelerated video elements (handles multiple clips)
  const startNativeVideoPlayback = useCallback(
    async (
      clips: Array<{
        clip: (typeof timelineTracks)[0]["clips"][0];
        mediaItem: NonNullable<ReturnType<typeof getMediaItem>>;
      }>,
      startPosition: number,
      onEnd: () => void,
      isCurrentSession: () => boolean,
    ): Promise<() => void> => {
      const canvas = canvasRef.current;
      if (!canvas || clips.length === 0) {
        onEnd();
        return () => {};
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        onEnd();
        return () => {};
      }

      let isActive = true;
      const sessionActive = () => isActive && isCurrentSession();
      if (!sessionActive()) return () => {};
      nativePlaybackActiveRef.current = true;

      await preDecodeAllAudioBuffers();
      if (!sessionActive()) return () => {};

      const videoCache = nativeVideoCacheRef.current;
      const loadingVideos = new Map<string, Promise<void>>();

      const loadVideoForClip = (
        clip: (typeof timelineTracks)[0]["clips"][0],
        mediaItem: NonNullable<ReturnType<typeof getMediaItem>>,
        cacheIdOverride?: string,
      ): Promise<void> => {
        if (!sessionActive()) return Promise.resolve();
        const videoCacheId = cacheIdOverride ?? clip.mediaId;

        const existingLoad = loadingVideos.get(videoCacheId);
        if (existingLoad) {
          return existingLoad;
        }

        if (!mediaItem.blob) return Promise.resolve();
        const playBlob = mediaItem.blob;
        const cached = videoCache.get(videoCacheId);
        if (cached?.sourceBlob === playBlob && cached.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          return Promise.resolve();
        }
        if (cached) {
          releaseVideoElement(cached);
          videoCache.delete(videoCacheId);
        }
        const cacheId = videoCacheId;
        const url = URL.createObjectURL(playBlob);
        previewOwnedBlobUrlCountRef.current += 1;
        const video = document.createElement("video");
        video.src = url;
        video.muted = true;
        video.playsInline = true;
        video.preload = "auto";

        videoCache.set(cacheId, { video, url, sourceBlob: playBlob });

        const loadPromise = new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            video.onloadedmetadata = null;
            video.onloadeddata = null;
            video.oncanplay = null;
            video.onerror = null;
            loadingVideos.delete(cacheId);
            resolve();
          };
          video.onloadeddata = finish;
          video.oncanplay = finish;
          video.onloadedmetadata = () => {
            if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
              finish();
            }
          };
          video.onerror = finish;
          video.load();
          setTimeout(finish, 1200);
        });

        loadingVideos.set(cacheId, loadPromise);
        return loadPromise;
      };

      const activeStartClip = clips.find(
        ({ clip }) =>
          startPosition >= clip.startTime &&
          startPosition < clip.startTime + clip.duration,
      );
      if (activeStartClip) {
        await loadVideoForClip(activeStartClip.clip, activeStartClip.mediaItem);
      }

      for (const entry of clips) {
        if (entry !== activeStartClip) {
          void loadVideoForClip(entry.clip, entry.mediaItem);
        }
      }

      if (!sessionActive()) return () => {};
      const masterClock = getMasterClock();
      masterClock.setDuration(actualEndTime);
      masterClock.seek(startPosition);

      if (!audioGraphRef.current) {
        audioGraphRef.current = getRealtimeAudioGraph();
      }
      const audioGraph = audioGraphRef.current;
      audioGraph.setPreviewMuted(isMuted);

      const tracksWithAudio = timelineTracks.filter(
        (t) => (t.type === "audio" || t.type === "video") && !t.hidden,
      );
      audioGraph.retainTracks(new Set(tracksWithAudio.map((track) => track.id)));
      for (const audioTrack of tracksWithAudio) {
        audioGraph.createTrack({
          trackId: audioTrack.id,
          volume: 1,
          pan: 0,
          muted: audioTrack.muted || false,
          solo: audioTrack.solo || false,
          effects: [],
        });
      }

      await audioGraph.resume();
      if (!sessionActive()) return () => {};
      audioGraph.seekTo(startPosition);
      let rafId: number | null = null;

      const waitForDrawableVideoFrame = async (
        video: HTMLVideoElement,
        timeoutMs = 300,
      ): Promise<void> => {
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          return;
        }

        await new Promise<void>((resolve) => {
          let settled = false;
          let timeoutId: ReturnType<typeof setTimeout> | null = null;
          const finish = () => {
            if (settled) return;
            settled = true;
            if (timeoutId) clearTimeout(timeoutId);
            video.removeEventListener("loadeddata", finish);
            video.removeEventListener("canplay", finish);
            resolve();
          };
          video.addEventListener("loadeddata", finish);
          video.addEventListener("canplay", finish);
          timeoutId = setTimeout(finish, timeoutMs);
        });
      };

      const syncVideoToSourceTime = async (
        video: HTMLVideoElement,
        sourceTime: number,
      ): Promise<void> => {
        const videoTime = sourceTime;

        let needsDrawableWait = video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA;
        if (Math.abs(video.currentTime - videoTime) > 0.1) {
          needsDrawableWait = true;
          await new Promise<void>((resolve) => {
            let settled = false;
            let timeoutId: ReturnType<typeof setTimeout> | null = null;
            const finish = () => {
              if (settled) return;
              settled = true;
              if (timeoutId) clearTimeout(timeoutId);
              video.removeEventListener("seeked", finish);
              resolve();
            };
            video.addEventListener("seeked", finish);
            timeoutId = setTimeout(finish, 250);
            video.currentTime = videoTime;
          });
        } else if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
          needsDrawableWait = true;
          video.currentTime = videoTime;
        }

        if (needsDrawableWait) {
          await waitForDrawableVideoFrame(video);
        }
      };

      const playVideoElement = async (video: HTMLVideoElement): Promise<void> => {
        video.playbackRate = rateRef.current;
        if (!video.paused) {
          return;
        }
        try {
          await video.play();
        } catch {
          // The canvas renderer can still draw the current frame if autoplay is blocked.
        }
      };

      // Once PTS fails to establish the project's cadence, keep this session
      // on core's sequential decoder instead of waiting for native timeouts on
      // every output frame (for example, a VFR source with a long held sample).
      let nativePtsUsable = true;
      const drawFrameInner = async () => {
        if (!sessionActive() || !nativePlaybackActiveRef.current) return;
        const currentPlayhead = masterClock.currentTime;
        if (currentPlayhead >= actualEndTime) {
          cleanup();
          setPlayheadPosition(0);
          startPositionRef.current = 0;
          onEnd();
          return;
        }
        if (!masterClock.isPlaying) {
          cleanup();
          if (!isScrubbingRef.current) onEnd();
          return;
        }
        const now = performance.now();
        if (now - lastPlayheadUpdateRef.current >= PLAYHEAD_UPDATE_THROTTLE_MS) {
          lastPlayheadUpdateRef.current = now;
          setPlayheadPosition(currentPlayhead);
        }
        const identity = useProjectStore.getState();
        const snapshot = identity.project;
        const stillCurrent = () => {
          const state = useProjectStore.getState();
          return sessionActive() && nativePlaybackActiveRef.current &&
            state.project.id === identity.project.id &&
            state.workspaceId === identity.workspaceId &&
            state.projectRevision === identity.projectRevision;
        };
        let sampled: { image: ImageBitmap; mediaTime: number } | null = null;
        let sampledClip: (typeof clips)[0]["clip"] | undefined;
        const transportFrameTime = playbackFrameTime(currentPlayhead, snapshot.settings.frameRate);
        let sampleTime = transportFrameTime;
        // Matching native cadence may supply a complete project frame. A PTS
        // between project frame heads cannot become an overlay sample time.
        // Multi-source transitions use core's exact sequential decoders.
        if (nativePtsUsable && !getTransitionAtTime(transportFrameTime, snapshot.timeline.tracks)) {
          sampledClip = snapshot.timeline.tracks
            .filter(track => !track.hidden)
            .flatMap(track => track.clips)
            .find(clip =>
              transportFrameTime >= clip.startTime &&
              transportFrameTime < clip.startTime + clip.duration &&
              clips.some(entry => entry.clip.id === clip.id),
            );
          const sampledMediaId = sampledClip?.mediaId;
          const media = snapshot.mediaLibrary.items.find(item => item.id === sampledMediaId);
          if (sampledClip && media && !sampledClip.stabilization?.renderedSource) {
            await loadVideoForClip(sampledClip, media);
            const video = videoCache.get(media.id)?.video;
            if (video && stillCurrent()) {
              await syncVideoToSourceTime(
                video, sampledClip.inPoint + currentPlayhead - sampledClip.startTime,
              );
              await playVideoElement(video);
              sampled = await captureNativeVideoFrame(video);
              if (!sampled) nativePtsUsable = false;
              if (sampled) {
                const mappedTime = sampledClip.startTime + sampled.mediaTime - sampledClip.inPoint;
                sampleTime = Math.round(mappedTime * snapshot.settings.frameRate) / snapshot.settings.frameRate;
                if (
                  Math.abs(mappedTime - sampleTime) >= 0.000001 ||
                  sampleTime < sampledClip.startTime ||
                  sampleTime >= sampledClip.startTime + sampledClip.duration ||
                  Math.abs(sampleTime - transportFrameTime) > 1 / snapshot.settings.frameRate + 0.000001
                ) {
                  sampled.image.close();
                  sampled = null;
                  nativePtsUsable = false;
                  sampleTime = transportFrameTime;
                }
              }
            }
          }
        }
        if (!sampled) sampledClip = undefined;
        if (!stillCurrent()) {
          sampled?.image.close();
          return;
        }
        // Stop sources that have left the picture before awaiting compositor
        // work, which can be substantially slower than the decoder clock.
        for (const [id, entry] of videoCache) {
          if (id !== sampledClip?.mediaId) entry.video.pause();
        }
        const decodeSourceFrame: NonNullable<FrameRenderOptions["decodeSourceFrame"]> = async (clip, media, sourceTime) =>
          sampled && clip.id === sampledClip?.id && media.id === clip.mediaId &&
          Math.abs(sourceTime - sampled.mediaTime) < 0.000001
            ? createImageBitmap(sampled.image)
            : null;
        const frame = await getRenderBridge().renderFrame(sampleTime, {
          project: snapshot,
          width: canvas.width,
          height: canvas.height,
          realtime: true,
          decodeSourceFrame,
          isCurrent: stillCurrent,
        });
        sampled?.image.close();
        if (frame) {
          try {
            if (stillCurrent()) {
              ctx.clearRect(0, 0, canvas.width, canvas.height);
              ctx.drawImage(frame.image, 0, 0, canvas.width, canvas.height);
              rememberPlaybackFrame(canvas, canvas.width, canvas.height);
              lastPresentedFrameAtRef.current = performance.now();
              masterClock.reportVideoTime(currentPlayhead);
            }
          } finally {
            frame.image.close();
          }
        }
        if (sessionActive() && nativePlaybackActiveRef.current) {
          rafId = requestAnimationFrame(() => { void drawFrame(); });
        }
      };

      // Keep frame errors bounded so presentation can stop with the clock.
      let drawFrameErrors = 0;
      const drawFrame = async (): Promise<void> => {
        try {
          await drawFrameInner();
          drawFrameErrors = 0;
        } catch (error) {
          if (!sessionActive() || !nativePlaybackActiveRef.current) return;
          drawFrameErrors += 1;
          console.error(
            `[Preview] drawFrame error (${drawFrameErrors}):`,
            error,
          );
          if (drawFrameErrors > 60) {
            console.error(
              "[Preview] drawFrame failing repeatedly; stopping playback",
            );
            cleanup();
            onEnd();
            return;
          }
          rafId = requestAnimationFrame(() => {
            drawFrame();
          });
        }
      };

      const cleanup = (preserveCaches = false) => {
        isActive = false;
        nativePlaybackActiveRef.current = false;
        if (rafId) cancelAnimationFrame(rafId);

        if (preserveCaches) {
          for (const [, entry] of videoCache) {
            entry.video.pause();
          }
        } else {
          for (const [, entry] of videoCache) {
            releaseVideoElement(entry);
          }
          videoCache.clear();
        }

        if (preserveCaches) {
          masterClock.pause();
        } else {
          masterClock.stop();
        }
        audioGraph.stopScheduler();
      };

      await masterClock.play();
      if (!sessionActive()) return () => {};
      audioGraph.startScheduler(getAudioClipsForScheduler, (error) => {
        masterClock.pause();
        pause();
        toast.error("Audio playback failed", error.message);
      });
      rafId = requestAnimationFrame(() => { drawFrame(); });

      return cleanup;
    },
    [
      actualEndTime,
      getAudioClipsForScheduler,
      isMuted,
      preDecodeAllAudioBuffers,
      pause,
      releaseVideoElement,
      setPlayheadPosition,
      rememberPlaybackFrame,
      timelineTracks,
    ],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    if (canvas.width === 0 || canvas.height === 0) {
      canvas.width = previewRes.width;
      canvas.height = previewRes.height;
    }

    if (!isPlaying) {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
      playbackRestartCountRef.current = 0;
      cleanupAudioResources();
      return;
    }

    if (actualEndTime <= 0) {
      pause();
      return;
    }

    // A paused preview render may still be awaiting decode. Invalidate its
    // commit before playback starts so a late frame cannot replace live output.
    frameSchedulerRef.current?.invalidate();

    let isActive = true;
    let nativeCleanup: ((preserveCaches?: boolean) => void) | null = null;

    if (startPositionRef.current >= actualEndTime - 0.001) {
      startPositionRef.current = 0;
      setPlayheadPosition(0);
    }
    const playbackStartPosition = startPositionRef.current;

    // Stall watchdog: the audio-driven clock keeps publishing time
    // even when a render loop wedges mid-await, so "playing but no presented
    // frame" is the only reliable freeze signal. Recover by rebuilding the
    // playback pipeline at the live playhead instead of freezing silently.
    lastPresentedFrameAtRef.current = performance.now();
    const watchdogId = setInterval(() => {
      if (!isActive) return;
      const masterClock = getMasterClock();
      if (!masterClock.isPlaying) {
        lastPresentedFrameAtRef.current = performance.now();
        return;
      }
      const stalledFor = performance.now() - lastPresentedFrameAtRef.current;
      if (stalledFor < PLAYBACK_STALL_TIMEOUT_MS) return;
      playbackRestartCountRef.current += 1;
      if (playbackRestartCountRef.current <= PLAYBACK_MAX_AUTO_RESTARTS) {
        console.error(
          `[Preview] Playback stalled for ${Math.round(stalledFor)}ms without a presented frame; ` +
            `rebuilding playback pipeline (attempt ${playbackRestartCountRef.current})`,
        );
        setPlaybackSessionNonce((n) => n + 1);
      } else {
        console.error(
          "[Preview] Playback stalled repeatedly; pausing playback",
        );
        pause();
      }
    }, PLAYBACK_WATCHDOG_INTERVAL_MS);

    const findAllClipsAtTime = (time: number) => {
      const tracks = timelineTracksRef.current;
      const results: Array<{
        clip: (typeof tracks)[0]["clips"][0];
        track: (typeof tracks)[0];
        trackIndex: number;
      }> = [];

      tracks.forEach((track, originalIndex) => {
        if (
          (track.type === "video" || track.type === "image") &&
          !track.hidden
        ) {
          for (const clip of track.clips) {
            if (
              time >= clip.startTime &&
              time < clip.startTime + clip.duration
            ) {
              results.push({ clip, track, trackIndex: originalIndex });
            }
          }
        }
      });

      return results.sort((a, b) => a.trackIndex - b.trackIndex);
    };

    const initClipResources = async (
      clip: (typeof timelineTracksRef.current)[0]["clips"][0],
      trackIndex: number,
      mediaItem = getMediaItem(clip.mediaId),
    ) => {
      if (!mediaItem?.blob || clip.stabilization?.renderedSource) {
        return null;
      }

      // Images don't need MediaBunny resources - they're rendered directly via createImageBitmap
      if (mediaItem.type === "image") {
        return null;
      }

      try {
        const mediabunny = await import("mediabunny");
        const { Input, ALL_FORMATS, BlobSource, CanvasSink } = mediabunny;

        const input = new Input({
          source: new BlobSource(mediaItem.blob),
          formats: ALL_FORMATS,
        });

        const videoTrack = await input.getPrimaryVideoTrack();
        if (!videoTrack) {
          input[Symbol.dispose]?.();
          return null;
        }

        const canDecode = await videoTrack.canDecode();
        if (!canDecode) {
          input[Symbol.dispose]?.();
          return null;
        }

        const sink = new CanvasSink(videoTrack, {
          poolSize: 3,
        });

        return {
          input,
          sink,
          mediaId: clip.mediaId,
          sourceBlob: mediaItem.blob,
          clipId: clip.id,
          trackIndex,
        };
      } catch (error) {
        console.error(
          `[Preview] Failed to init resources for clip ${clip.id}:`,
          error,
        );
        return null;
      }
    };

    const startMultiTrackPlayback = async () => {
      // Warm the currently visible video decoders while the audio graph starts.
      for (const { clip, trackIndex } of findAllClipsAtTime(playbackStartPosition)) {
        if (!playbackResourcesRef.current.has(clip.id)) {
          const resources = await initClipResources(clip, trackIndex);
          if (!isActive) {
            resources?.input[Symbol.dispose]?.();
            return;
          }
          if (resources) playbackResourcesRef.current.set(clip.id, resources);
        }
      }
      await preDecodeAllAudioBuffers();
      if (!isActive) return;

      if (!audioGraphRef.current) {
        audioGraphRef.current = getRealtimeAudioGraph();
      }
      const audioGraph = audioGraphRef.current;
      audioGraph.setPreviewMuted(isMuted);

      const tracksWithAudio = timelineTracksRef.current.filter(
        (t) => (t.type === "audio" || t.type === "video") && !t.hidden,
      );
      audioGraph.retainTracks(new Set(tracksWithAudio.map((track) => track.id)));
      for (const track of tracksWithAudio) {
        audioGraph.createTrack({
          trackId: track.id,
          volume: 1,
          pan: 0,
          muted: track.muted || false,
          solo: track.solo || false,
          effects: [],
        });
      }

      await audioGraph.resume();
      if (!isActive) return;

      const mainCtx = canvas.getContext("2d");
      if (!mainCtx) {
        console.error("[Preview] Failed to get 2D context");
        pause();
        return;
      }

      const masterClock = getMasterClock();
      masterClock.setDuration(actualEndTime);
      masterClock.seek(playbackStartPosition);

      audioGraph.seekTo(playbackStartPosition);
      await masterClock.play();
      if (!isActive) return;
      audioGraph.startScheduler(getAudioClipsForScheduler, (error) => {
        masterClock.pause();
        pause();
        toast.error("Audio playback failed", error.message);
      });

      const frameDuration = 1000 / 30;
      let lastFrameTimestamp = performance.now();
      let isProcessingFrame = false;

      const processMultiTrackFrame = async () => {
        if (!isActive) return;

        if (isProcessingFrame) {
          return;
        }
        isProcessingFrame = true;

        const currentPlayhead = masterClock.currentTime;

        try {
          if (currentPlayhead >= actualEndTime) {
            isProcessingFrame = false;
            cleanupPlaybackResources();
            cleanupAudioResources();
            masterClock.stop();
            setPlayheadPosition(0);
            startPositionRef.current = 0;
            pause();
            return;
          }

          if (!masterClock.isPlaying) {
            isProcessingFrame = false;
            cleanupPlaybackResources();
            cleanupAudioResources();
            if (!isScrubbingRef.current) {
              pause();
            }
            return;
          }

          // Keep the timeline UI clock-aligned with audio even when decoding or
          // effects make the current visual frame expensive to produce.
          const nowPlayhead = performance.now();
          if (nowPlayhead - lastPlayheadUpdateRef.current >= PLAYHEAD_UPDATE_THROTTLE_MS) {
            lastPlayheadUpdateRef.current = nowPlayhead;
            setPlayheadPosition(currentPlayhead);
          }

          const identity = useProjectStore.getState();
          const snapshot = identity.project;
          const sampleTime = playbackFrameTime(currentPlayhead, snapshot.settings.frameRate);
          const stillCurrent = () => {
            const state = useProjectStore.getState();
            return isActive && state.project.id === identity.project.id &&
              state.workspaceId === identity.workspaceId &&
              state.projectRevision === identity.projectRevision;
          };
          const decodeSourceFrame: NonNullable<FrameRenderOptions["decodeSourceFrame"]> = async (clip, media, sourceTime) => {
            if (media.type !== "video" || media.id !== clip.mediaId) return null;
            const trackIndex = snapshot.timeline.tracks.findIndex(track =>
              track.clips.some(item => item === clip),
            );
            if (trackIndex < 0) return null;
            let resources = playbackResourcesRef.current.get(clip.id);
            if (resources && resources.sourceBlob !== media.blob) {
              resources.input[Symbol.dispose]?.();
              playbackResourcesRef.current.delete(clip.id);
              resources = undefined;
            }
            if (!resources) {
              resources = await initClipResources(clip, trackIndex, media) ?? undefined;
              if (!stillCurrent()) {
                resources?.input[Symbol.dispose]?.();
                return null;
              }
              if (resources) playbackResourcesRef.current.set(clip.id, resources);
            }
            if (!resources) return null;
            const result = await withTimeout(
              (resources.sink as {
                getCanvas: (time: number) => Promise<{
                  canvas: HTMLCanvasElement | OffscreenCanvas;
                } | null>;
              }).getCanvas(sourceTime),
              DECODE_TIMEOUT_MS,
              `Frame decode for clip ${clip.id}`,
            );
            return result?.canvas && stillCurrent() ? createImageBitmap(result.canvas) : null;
          };
          const frame = await getRenderBridge().renderFrame(sampleTime, {
            project: snapshot,
            width: canvas.width,
            height: canvas.height,
            realtime: true,
            decodeSourceFrame,
            isCurrent: stillCurrent,
          });
          if (frame) {
            try {
              if (stillCurrent()) {
                mainCtx.clearRect(0, 0, canvas.width, canvas.height);
                mainCtx.drawImage(frame.image, 0, 0, canvas.width, canvas.height);
                rememberPlaybackFrame(canvas, canvas.width, canvas.height);
                lastPresentedFrameAtRef.current = performance.now();
              }
            } finally {
              frame.image.close();
            }
          }

          masterClock.reportVideoTime(currentPlayhead);
          const now = performance.now();
          const elapsed = now - lastFrameTimestamp;
          const targetTime = frameDuration / rateRef.current;

          const delay = Math.max(0, targetTime - elapsed);
          lastFrameTimestamp = now;

          isProcessingFrame = false;

          if (isActive) {
            scheduleMultiTrackFrameAt(now + delay);
          }
        } catch (error) {
          isProcessingFrame = false;
          if (!isActive) return;
          console.error("[Preview] Multi-track frame error:", error);
          cleanupPlaybackResources();
          pause();
        }
      };

      function scheduleMultiTrackFrameAt(dueAt: number): void {
        if (!isActive) return;
        const waitForDueFrame = (timestamp: number) => {
          if (!isActive) return;
          if (timestamp < dueAt) {
            animationRef.current = requestAnimationFrame(waitForDueFrame);
            return;
          }
          void processMultiTrackFrame();
        };
        animationRef.current = requestAnimationFrame(waitForDueFrame);
      }

      scheduleMultiTrackFrameAt(performance.now());
    };

    const startPlayback = async () => {
      const nativeCheck = canUseNativeVideoPlayback(playbackStartPosition);

      if (nativeCheck.canUse && nativeCheck.clips.length > 0) {
        try {
          nativeCleanup = await startNativeVideoPlayback(
            nativeCheck.clips,
            playbackStartPosition,
            () => pause(),
            () => isActive,
          );
          return nativeCleanup;
        } catch (error) {
          if (error instanceof AudioSpeedCapabilityError) throw error;
          console.warn(
            "[Preview] Native video playback failed, falling back to MediaBunny:",
            error,
          );
        }
      }
      await startMultiTrackPlayback();
    };

    startPlayback().catch((error) => {
      console.error("[Preview] startPlayback error:", error);
      cleanupAudioResources();
      getMasterClock().pause();
      pause();
      toast.error("Audio playback failed", error instanceof Error ? error.message : String(error));
    });

    return () => {
      clearInterval(watchdogId);
      isActive = false;
      nativePlaybackActiveRef.current = false;
      const masterClock = getMasterClock();
      if (masterClock.isPlaying || masterClock.isPaused) {
        startPositionRef.current = masterClock.currentTime;
      }
      if (nativeCleanup) {
        const pausedForResume =
          useTimelineStore.getState().playbackState === "paused";
        nativeCleanup(pausedForResume);
        nativeCleanup = null;
      }
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
      masterClock.pause();
      cleanupAudioResources();
    };
  }, [
    isPlaying,
    playbackSessionNonce,
    canUseNativeVideoPlayback,
    startNativeVideoPlayback,
    actualEndTime,
    setPlayheadPosition,
    pause,
    getMediaItem,
    cleanupPlaybackResources,
    cleanupAudioResources,
    preDecodeAllAudioBuffers,
    getAudioClipsForScheduler,
    isMuted,
    previewRes.width,
    previewRes.height,
    previewRes.scale,
    getLastGoodPreviewFrame,
    rememberPlaybackFrame,
    project.motionInstances,
    clipMasksById,
    fillPreviewBackground,
  ]);

  const lastModifiedAtRef = useRef<number>(project.modifiedAt);
  const initialPausedFrameRequestedRef = useRef(false);
  const lastPlayheadForRenderRef = useRef<number>(playheadPosition);
  const projectRevision = useProjectStore((state) => state.projectRevision);
  const lastRevisionForRenderRef = useRef<number>(projectRevision);
  const modifiedRenderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasScrubbingRef = useRef<boolean>(false);

  useEffect(() => {
    if (isPlaying) return;

    if (isInteractingRef.current) {
      lastModifiedAtRef.current = project.modifiedAt;
      lastRevisionForRenderRef.current = projectRevision;
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;

    const scrubJustEnded = wasScrubbingRef.current && !isScrubbing;
    wasScrubbingRef.current = isScrubbing;

    const playheadChanged = playheadPosition !== lastPlayheadForRenderRef.current;
    const modifiedChanged = project.modifiedAt !== lastModifiedAtRef.current;
    // projectRevision bumps on every committed mutation
    // (manual, agent, undo/redo), including paths that never stamp modifiedAt.
    const revisionChanged = projectRevision !== lastRevisionForRenderRef.current;
    if (revisionChanged) {
      const operation = getProjectPerfOperation(project);
      if (operation) operation.sink.mark("visual-state.committed", { ...operation.context, revision: projectRevision });
    }

    lastModifiedAtRef.current = project.modifiedAt;
    lastPlayheadForRenderRef.current = playheadPosition;
    lastRevisionForRenderRef.current = projectRevision;

    const previousRenderTime = lastPreviewRenderTimeRef.current;
    const isLargeJump =
      Math.abs(playheadPosition - previousRenderTime) > 1 ||
      playheadPosition < previousRenderTime - 0.25;
    // Tear down the decoder cache only on genuine jumps (clicks, shortcut
    // seeks). Adjacent scrub positions look like large jumps at fit zoom —
    // destroying the <video> elements there cancelled every in-flight decode
    // and left the preview blank for the whole drag.
    if (isLargeJump && !isScrubbing) {
      releaseScrubVideoElements();
    }
    lastPreviewRenderTimeRef.current = playheadPosition;

    if (!initialPausedFrameRequestedRef.current) {
      initialPausedFrameRequestedRef.current = true;
      requestFrameRender(playheadPosition);
    } else if (playheadChanged) {
      requestFrameRender(playheadPosition);
    } else if (scrubJustEnded) {
      // Drag release must paint the exact release position even when the
      // store value did not change (the last move already landed there).
      requestFrameRender(playheadPosition);
    } else if (modifiedChanged || revisionChanged) {
      if (modifiedRenderTimerRef.current) {
        clearTimeout(modifiedRenderTimerRef.current);
      }
      modifiedRenderTimerRef.current = setTimeout(() => {
        modifiedRenderTimerRef.current = null;
        requestFrameRender(playheadPosition);
      }, 150);
    }

    return () => {
      if (modifiedRenderTimerRef.current) {
        clearTimeout(modifiedRenderTimerRef.current);
        modifiedRenderTimerRef.current = null;
      }
    };
  }, [
    playheadPosition,
    isPlaying,
    isScrubbing,
    requestFrameRender,
    renderFrameDirectly,
    renderFallbackFrame,
    releaseScrubVideoElements,
    project.modifiedAt,
    projectRevision,
    isDark,
  ]);

  // Keep the canvas/decoder registration alive across workspace activation,
  // but discard every view-specific frame and source cache before requesting
  // the newly active project's first frame. Paused renders are gated by the
  // scheduler epoch; playback effects stop their old loop on workspace pause.
  useEffect(() => {
    const previous = previewViewIdentityRef.current;
    const loadingViewGeneration =
      previewSessionState.loading?.phase === "awaiting-first-valid-frame" ||
      previewSessionState.loading?.phase === "restoring-context"
        ? previewSessionState.loading.generation
        : previous.viewGeneration;
    if (
      previous.projectId === project.id &&
      previous.workspaceId === workspaceId &&
      previous.viewGeneration === loadingViewGeneration
    ) return;
    previewViewIdentityRef.current = {
      projectId: project.id,
      workspaceId,
      viewGeneration: loadingViewGeneration,
    };

    releaseScrubVideoElements();
    frameSchedulerRef.current?.invalidate();
    const keepPreviousHistoryFrame = previewSessionState.loading !== null;
    if (!keepPreviousHistoryFrame) {
      lastGoodFrameRef.current?.close();
      lastGoodFrameRef.current = null;
      clearPlaybackCanvasBuffers();
    }

    cleanupPlaybackResources();
    for (const entry of nativeVideoCacheRef.current.values()) {
      releaseVideoElement(entry);
    }
    nativeVideoCacheRef.current.clear();

    processedAudioBufferCacheRef.current.clear();
    audioBufferCacheRef.current.clear();
    noAudioBufferRef.current.clear();

    if (modifiedRenderTimerRef.current) {
      clearTimeout(modifiedRenderTimerRef.current);
      modifiedRenderTimerRef.current = null;
    }
    lastModifiedAtRef.current = project.modifiedAt;
    lastRevisionForRenderRef.current = projectRevision;
    lastPlayheadForRenderRef.current = playheadPosition;
    lastPreviewRenderTimeRef.current = playheadPosition;
    initialPausedFrameRequestedRef.current = true;

    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (canvas && context && !keepPreviousHistoryFrame) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      fillPreviewBackground(context, playheadPosition, canvas.width, canvas.height);
    }

    if (!isPlaying) requestFrameRender(playheadPosition);
  }, [
    project.id,
    project.modifiedAt,
    workspaceId,
    previewSessionState.loading?.generation,
    previewSessionState.loading?.phase,
    playheadPosition,
    projectRevision,
    isPlaying,
    releaseScrubVideoElements,
    clearPlaybackCanvasBuffers,
    cleanupPlaybackResources,
    releaseVideoElement,
    fillPreviewBackground,
    requestFrameRender,
  ]);

  const [previewInvalidateCounter, setPreviewInvalidateCounter] = useState(0);
  const fillPreviewBackgroundRef = useRef(fillPreviewBackground);
  useEffect(() => {
    fillPreviewBackgroundRef.current = fillPreviewBackground;
  }, [fillPreviewBackground]);
  useEffect(() => {
    const handler = (event: Event) => {
      const discardRetainedFrame =
        (event as CustomEvent<{ discardRetainedFrame?: boolean }>).detail?.discardRetainedFrame;
      if (discardRetainedFrame) {
        lastGoodFrameRef.current?.close();
        lastGoodFrameRef.current = null;
        clearPlaybackCanvasBuffers();
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        if (canvas && context) {
          context.clearRect(0, 0, canvas.width, canvas.height);
          fillPreviewBackgroundRef.current(
            context,
            playheadPositionRef.current,
            canvas.width,
            canvas.height,
          );
        }
      }
      frameSchedulerRef.current?.invalidate();
      processedAudioBufferCacheRef.current.clear();
      if (audioGraphRef.current) {
        audioGraphRef.current.seekTo(getMasterClock().currentTime);
      }
      setPreviewInvalidateCounter((c) => c + 1);
    };
    window.addEventListener("reelterminal:preview-invalidate", handler);
    return () => window.removeEventListener("reelterminal:preview-invalidate", handler);
  }, [clearPlaybackCanvasBuffers]);

  useEffect(() => {
    if (isPlaying || previewInvalidateCounter === 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    requestFrameRender(playheadPositionRef.current, true);
  }, [previewInvalidateCounter, isPlaying, requestFrameRender]);

  const selectedClipId = useMemo(() => {
    const clipSelection = selectedItems.find((item) => item.type === "clip");
    return clipSelection?.id || null;
  }, [selectedItems]);

  const selectedClip = useMemo(() => {
    if (!selectedClipId) return null;
    return previewTrackIndex.clipsById.get(selectedClipId) ?? null;
  }, [selectedClipId, previewTrackIndex]);

  const clipAtPlayhead = useMemo(() => {
    const videoTracks = timelineTracks.filter(
      (t) => (t.type === "video" || t.type === "image") && !t.hidden,
    );
    for (const track of videoTracks) {
      for (const clip of track.clips) {
        const clipStart = clip.startTime;
        const clipEnd = clip.startTime + clip.duration;
        if (playheadPosition >= clipStart && playheadPosition < clipEnd) {
          return clip;
        }
      }
    }
    return null;
  }, [timelineTracks, playheadPosition]);

  const selectedTextClipId = useMemo(() => {
    const textClipSelection = selectedItems.find(
      (item) => item.type === "text-clip",
    );
    return textClipSelection?.id || null;
  }, [selectedItems]);

  const selectedTextClip = useMemo<TextClip | null>(() => {
    if (!selectedTextClipId) return null;
    return allTextClips.find((clip) => clip.id === selectedTextClipId) || null;
  }, [selectedTextClipId, allTextClips]);

  const activeTextClip = selectedTextClip;

  const clipBounds = useMemo(() => {
    const clip = selectedClip || clipAtPlayhead;
    if (!clip || !canvasRef.current || !overlayRef.current) return null;

    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    const overlayRect = overlay.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();

    const clipTransform = clip.transform || {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      opacity: 1,
      anchor: { x: 0.5, y: 0.5 },
    };

    const transform = liveTransform
      ? {
          ...clipTransform,
          position: liveTransform.position,
          scale: liveTransform.scale,
        }
      : clipTransform;

    const canvasWidth = settings.width;
    const canvasHeight = settings.height;

    const geo = computeLetterboxGeometry(
      canvasWidth,
      canvasHeight,
      canvasRect.width,
      canvasRect.height,
    );
    // Same canvas aspect the letterbox helper uses internally; reused by the
    // fit-mode math below.
    const canvasAspect = canvasWidth / canvasHeight;

    const fitMode =
      !clipTransform.fitMode || clipTransform.fitMode === "none"
        ? "contain"
        : clipTransform.fitMode;
    const mediaItem = getMediaItem(clip.mediaId);
    const mediaWidth = mediaItem?.metadata?.width ?? canvasWidth;
    const mediaHeight = mediaItem?.metadata?.height ?? canvasHeight;

    let baseWidth: number;
    let baseHeight: number;

    if (fitMode === "stretch") {
      baseWidth = canvasWidth;
      baseHeight = canvasHeight;
    } else if (fitMode === "cover") {
      const mediaAspect = mediaWidth / mediaHeight;
      if (mediaAspect > canvasAspect) {
        baseHeight = canvasHeight;
        baseWidth = canvasHeight * mediaAspect;
      } else {
        baseWidth = canvasWidth;
        baseHeight = canvasWidth / mediaAspect;
      }
    } else {
      const mediaAspect = mediaWidth / mediaHeight;
      if (mediaAspect > canvasAspect) {
        baseWidth = canvasWidth;
        baseHeight = canvasWidth / mediaAspect;
      } else {
        baseHeight = canvasHeight;
        baseWidth = canvasHeight * mediaAspect;
      }
    }

    const clipWidth = baseWidth * transform.scale.x * geo.displayScale;
    const clipHeight = baseHeight * transform.scale.y * geo.displayScale;

    const offsetX = transform.position.x * geo.displayScale;
    const offsetY = transform.position.y * geo.displayScale;

    const canvasOffsetX = canvasRect.left - overlayRect.left + geo.letterboxOffsetX;
    const canvasOffsetY = canvasRect.top - overlayRect.top + geo.letterboxOffsetY;

    const centerX = canvasOffsetX + geo.actualWidth / 2 + offsetX;
    const centerY = canvasOffsetY + geo.actualHeight / 2 + offsetY;

    return {
      x: centerX - clipWidth / 2,
      y: centerY - clipHeight / 2,
      width: clipWidth,
      height: clipHeight,
      centerX,
      centerY,
      displayScale: geo.displayScale,
    };
  }, [
    selectedClip,
    clipAtPlayhead,
    settings.width,
    settings.height,
    canvasSize,
    liveTransform,
    getMediaItem,
  ]);

  const textClipBounds = useMemo(() => {
    if (!selectedTextClip || !canvasRef.current || !overlayRef.current)
      return null;

    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    const overlayRect = overlay.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();

    const { transform, style, text } = selectedTextClip;

    const canvasWidth = settings.width;
    const canvasHeight = settings.height;

    const geo = computeLetterboxGeometry(
      canvasWidth,
      canvasHeight,
      canvasRect.width,
      canvasRect.height,
    );

    const lines = text.split("\n");
    const lineHeight = style.fontSize * style.lineHeight;
    const estimatedHeight = lines.length * lineHeight;
    const estimatedWidth =
      style.fontSize * Math.max(...lines.map((l) => l.length)) * 0.6;

    const textWidth = estimatedWidth * transform.scale.x * geo.displayScale;
    const textHeight = estimatedHeight * transform.scale.y * geo.displayScale;

    const posX = transform.position.x * canvasWidth * geo.displayScale;
    const posY = transform.position.y * canvasHeight * geo.displayScale;

    const canvasOffsetX = canvasRect.left - overlayRect.left + geo.letterboxOffsetX;
    const canvasOffsetY = canvasRect.top - overlayRect.top + geo.letterboxOffsetY;

    const centerX = canvasOffsetX + posX;
    const centerY = canvasOffsetY + posY;

    return {
      x: centerX - textWidth / 2,
      y: centerY - textHeight / 2,
      width: textWidth,
      height: textHeight,
      centerX,
      centerY,
      displayScale: geo.displayScale,
      isTextClip: true,
    };
  }, [selectedTextClip, settings.width, settings.height, canvasSize]);

  const selectedShapeClipId = useMemo(() => {
    const shapeClipSelection = selectedItems.find(
      (item) => item.type === "shape-clip",
    );
    return shapeClipSelection?.id || null;
  }, [selectedItems]);

  const selectedShapeClip = useMemo<
    ShapeClip | SVGClip | StickerClip | null
  >(() => {
    if (!selectedShapeClipId) return null;
    return (
      allShapeClips.find((clip) => clip.id === selectedShapeClipId) || null
    );
  }, [selectedShapeClipId, allShapeClips]);

  const activeShapeClip = selectedShapeClip;

  // Agent target point: while armed, the next real click on the canvas is a
  // genuine user gesture that pins a normalized 0..1 frame position for the
  // agent. Capture phase so the click never reaches the
  // graphics-selection handler underneath.
  const handleTargetPointClickCapture = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if ((event.target as HTMLElement).closest("[data-reference-comparison]")) return;
      if (!targetPointArmed) return;
      event.preventDefault();
      event.stopPropagation();
      setTargetPointArmed(false);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const content = projectFrameContentRect(
        settings.width,
        settings.height,
        rect.width,
        rect.height,
      );
      const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
      setAgentTargetPoint({
        x: clamp01((event.clientX - rect.left - content.x) / content.width),
        y: clamp01((event.clientY - rect.top - content.y) / content.height),
      });
    },
    [targetPointArmed, settings.width, settings.height, setAgentTargetPoint],
  );

  // Marker position for the stored point, in % of the canvas element so it
  // tracks resizes; re-derived from the same letterbox geometry. Rendered as a
  // DOM overlay (pointer-events: none) — never into the render surface, so it
  // cannot leak into export pixels.
  const agentTargetMarkerStyle = useMemo<React.CSSProperties | null>(() => {
    if (!agentTargetPoint || canvasSize.width <= 0 || canvasSize.height <= 0) {
      return null;
    }
    const content = projectFrameContentRect(
      settings.width,
      settings.height,
      canvasSize.width,
      canvasSize.height,
    );
    return {
      left: `${((content.x + agentTargetPoint.x * content.width) / canvasSize.width) * 100}%`,
      top: `${((content.y + agentTargetPoint.y * content.height) / canvasSize.height) * 100}%`,
    };
  }, [agentTargetPoint, canvasSize, settings.width, settings.height]);

  // Persisted project review markers: a top-left stack of amber pills for
  // markers relevant to the current frame — time ranges containing the
  // playhead, clip/text markers whose element is active, and markers on
  // selected entities. DOM overlay only (pointer-events: none), so it can
  // never leak into export pixels.
  const addProjectMarker = useProjectStore((state) => state.addProjectMarker);
  const reviewMarkerPills = useMemo(() => {
    const frameRate = settings.frameRate > 0 ? settings.frameRate : 30;
    const byNumber = new Map<
      number,
      { marker: ProjectMarker; selected: boolean }
    >();
    const collect = (marker: ProjectMarker, selected: boolean) => {
      const existing = byNumber.get(marker.number);
      byNumber.set(marker.number, {
        marker,
        selected: (existing?.selected ?? false) || selected,
      });
    };
    for (const marker of findTimeRangeMarkersAt(
      project.markers,
      playheadPosition,
      frameRate,
    )) {
      collect(marker, false);
    }
    for (const marker of findClipMarkersActiveAt(
      project.markers,
      project,
      playheadPosition,
    )) {
      collect(marker, false);
    }
    for (const marker of markersForSelection(project.markers, selectedItems)) {
      collect(marker, true);
    }
    return [...byNumber.values()].sort(
      (a, b) => a.marker.number - b.marker.number,
    );
  }, [project, playheadPosition, selectedItems, settings.frameRate]);

  const previewMarkerMenuItems = useMemo<ContextMenuOption[]>(
    () => [
      {
        label: tr("reviewMarkers.addAtPlayhead"),
        icon: <Flag size={14} aria-hidden />,
        onClick: () => {
          void addProjectMarker({
            kind: "timeRange",
            start: playheadPosition,
            end: playheadPosition,
          }).then((result) => {
            if (!result.success) {
              toast.error(
                tr("reviewMarkers.addFailed"),
                result.error?.message,
              );
            }
          });
        },
      },
    ],
    [tr, addProjectMarker, playheadPosition],
  );

  const handlePreviewKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (
        target.closest(
          "input, textarea, select, button, [contenteditable='true']",
        )
      ) {
        return;
      }
      if (event.key === "Escape" && (targetPointArmed || agentTargetPoint)) {
        setTargetPointArmed(false);
        clearAgentTargetPoint();
        event.preventDefault();
        return;
      }
      const direction =
        event.key === "ArrowLeft"
          ? { x: -1, y: 0 }
          : event.key === "ArrowRight"
            ? { x: 1, y: 0 }
            : event.key === "ArrowUp"
              ? { x: 0, y: -1 }
              : event.key === "ArrowDown"
                ? { x: 0, y: 1 }
                : null;
      if (!direction || selectedItems.length === 0) return;

      const amount = event.shiftKey ? 10 : 1;
      const pixelX = direction.x * amount;
      const pixelY = direction.y * amount;
      const normalizedX = pixelX / Math.max(1, settings.width);
      const normalizedY = pixelY / Math.max(1, settings.height);
      const pending: Promise<unknown>[] = [];
      let changed = false;

      beginHistoryGroup("Nudge canvas selection");
      for (const item of selectedItems) {
        if (item.type === "clip") {
          const clip = timelineTracks
            .flatMap((track) => track.clips)
            .find((candidate) => candidate.id === item.id);
          if (!clip) continue;
          changed = true;
          pending.push(
            updateClipTransform(item.id, {
              position: {
                x: clip.transform.position.x + pixelX,
                y: clip.transform.position.y + pixelY,
              },
            }),
          );
          continue;
        }

        if (item.type === "text-clip") {
          const clip = allTextClips.find((candidate) => candidate.id === item.id);
          if (!clip) continue;
          changed = true;
          updateTextTransform(item.id, {
            position: {
              x: clip.transform.position.x + normalizedX,
              y: clip.transform.position.y + normalizedY,
            },
          });
          continue;
        }

        if (item.type === "shape-clip") {
          const clip = allShapeClips.find((candidate) => candidate.id === item.id);
          if (!clip) continue;
          changed = true;
          updateShapeTransform(item.id, {
            position: {
              x: clip.transform.position.x + normalizedX,
              y: clip.transform.position.y + normalizedY,
            },
          });
        }
      }

      if (!changed) {
        endHistoryGroup();
        return;
      }
      event.preventDefault();
      void Promise.all(pending).finally(endHistoryGroup);
    },
    [
      agentTargetPoint,
      allShapeClips,
      allTextClips,
      beginHistoryGroup,
      clearAgentTargetPoint,
      endHistoryGroup,
      selectedItems,
      settings.height,
      settings.width,
      targetPointArmed,
      timelineTracks,
      updateClipTransform,
      updateShapeTransform,
      updateTextTransform,
    ],
  );

  const [hoveredGraphicClipId, setHoveredGraphicClipId] = useState<string | null>(null);

  const activeGraphicClips = useMemo(() => {
    // getActiveShapeClips returns all graphic clip types (shapes, SVGs, and stickers)
    return getActiveShapeClips(allShapeClips, playheadPosition);
  }, [allShapeClips, playheadPosition]);

  const getGraphicClipDisplayBounds = useCallback(
    (clip: ShapeClip | SVGClip | StickerClip) => {
      if (!canvasRef.current || !overlayRef.current) return null;

      const canvas = canvasRef.current;
      const overlay = overlayRef.current;
      const overlayRect = overlay.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();

      const { transform } = clip;

      const canvasWidth = settings.width;
      const canvasHeight = settings.height;

      const geo = computeLetterboxGeometry(
        canvasWidth,
        canvasHeight,
        canvasRect.width,
        canvasRect.height,
      );

      let baseWidth: number;
      let baseHeight: number;

      if (clip.type === "svg") {
        const svgClip = clip as SVGClip;
        const svgW = svgClip.viewBox?.width || 200;
        const svgH = svgClip.viewBox?.height || 200;
        const svgAspect = svgW / svgH;
        if (svgAspect > 1) {
          baseWidth = canvasWidth;
          baseHeight = canvasWidth / svgAspect;
        } else {
          baseHeight = canvasHeight;
          baseWidth = canvasHeight * svgAspect;
        }
      } else {
        baseWidth = 200;
        baseHeight = 200;
      }

      const shapeWidth = baseWidth * transform.scale.x * geo.displayScale;
      const shapeHeight = baseHeight * transform.scale.y * geo.displayScale;

      const posX = transform.position.x * canvasWidth * geo.displayScale;
      const posY = transform.position.y * canvasHeight * geo.displayScale;

      const canvasOffsetX = canvasRect.left - overlayRect.left + geo.letterboxOffsetX;
      const canvasOffsetY = canvasRect.top - overlayRect.top + geo.letterboxOffsetY;

      const centerX = canvasOffsetX + posX;
      const centerY = canvasOffsetY + posY;

      return {
        x: centerX - shapeWidth / 2,
        y: centerY - shapeHeight / 2,
        width: shapeWidth,
        height: shapeHeight,
        centerX,
        centerY,
        displayScale: geo.displayScale,
      };
    },
    [settings.width, settings.height],
  );

  // Selection bounds for the currently selected graphic clip: the exact same
  // geometry as the hover/hit-test bounds above, so reuse it instead of
  // duplicating the letterbox math. canvasSize stays a recompute trigger —
  // the rects are read live from the DOM and must refresh after resizes.
  const shapeClipBounds = useMemo(
    () =>
      selectedShapeClip ? getGraphicClipDisplayBounds(selectedShapeClip) : null,
    [selectedShapeClip, getGraphicClipDisplayBounds, canvasSize],
  );

  const findGraphicClipAtPoint = useCallback(
    (clientX: number, clientY: number): ShapeClip | SVGClip | StickerClip | null => {
      if (!overlayRef.current) return null;
      const overlayRect = overlayRef.current.getBoundingClientRect();
      const pointX = clientX - overlayRect.left;
      const pointY = clientY - overlayRect.top;

      for (let i = activeGraphicClips.length - 1; i >= 0; i--) {
        const clip = activeGraphicClips[i];
        const bounds = getGraphicClipDisplayBounds(clip);
        if (!bounds) continue;

        if (
          pointX >= bounds.x &&
          pointX <= bounds.x + bounds.width &&
          pointY >= bounds.y &&
          pointY <= bounds.y + bounds.height
        ) {
          return clip;
        }
      }
      return null;
    },
    [activeGraphicClips, getGraphicClipDisplayBounds],
  );

  const selectedSubtitleId = useMemo(() => {
    const subtitleSelection = selectedItems.find(
      (item) => item.type === "subtitle",
    );
    return subtitleSelection?.id || null;
  }, [selectedItems]);

  const selectedSubtitleObj = useMemo<Subtitle | null>(() => {
    if (!selectedSubtitleId) return null;
    return allSubtitles.find((sub) => sub.id === selectedSubtitleId) || null;
  }, [selectedSubtitleId, allSubtitles]);

  const subtitleBounds = useMemo(() => {
    if (!selectedSubtitleObj || !canvasRef.current || !overlayRef.current)
      return null;
    if (
      playheadPosition < selectedSubtitleObj.startTime ||
      playheadPosition >= selectedSubtitleObj.endTime
    )
      return null;

    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    const overlayRect = overlay.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();

    const fontSize = selectedSubtitleObj.style?.fontSize || 24;
    const position = selectedSubtitleObj.style?.position || "bottom";
    const lines = selectedSubtitleObj.text.split("\n");
    const lineHeight = fontSize * 1.3;
    const totalHeight = lines.length * lineHeight;

    const canvasWidth = settings.width;
    const canvasHeight = settings.height;

    const geo = computeLetterboxGeometry(
      canvasWidth,
      canvasHeight,
      canvasRect.width,
      canvasRect.height,
    );

    let baseY: number;
    if (position === "top") {
      baseY = fontSize * 2;
    } else if (position === "center") {
      baseY = canvasHeight / 2 - totalHeight / 2;
    } else {
      baseY = canvasHeight - fontSize * 2 - totalHeight;
    }

    const subtitleWidth = canvasWidth * 0.8 * geo.displayScale;
    const subtitleHeight = totalHeight * geo.displayScale;

    const canvasOffsetX = canvasRect.left - overlayRect.left + geo.letterboxOffsetX;
    const canvasOffsetY = canvasRect.top - overlayRect.top + geo.letterboxOffsetY;

    const centerX = canvasOffsetX + geo.actualWidth / 2;
    const topY = canvasOffsetY + baseY * geo.displayScale;

    return {
      x: centerX - subtitleWidth / 2,
      y: topY,
      width: subtitleWidth,
      height: subtitleHeight,
      centerX,
      centerY: topY + subtitleHeight / 2,
      displayScale: geo.displayScale,
    };
  }, [
    selectedSubtitleObj,
    settings.width,
    settings.height,
    canvasSize,
    playheadPosition,
  ]);

  const handleHandleMouseDown = useCallback(
    (e: React.MouseEvent, handle: HandlePosition) => {
      e.stopPropagation();
      e.preventDefault();

      const clip = selectedClip || clipAtPlayhead;
      if (!clip) return;

      const transform = clip.transform || {
        position: { x: 0, y: 0 },
        scale: { x: 1, y: 1 },
        rotation: 0,
        opacity: 1,
        anchor: { x: 0.5, y: 0.5 },
      };

      isInteractingRef.current = true;
      setInteractionMode("resize");
      setActiveHandle(handle);
      interactionStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        transform: {
          x: transform.position.x,
          y: transform.position.y,
          scaleX: transform.scale.x,
          scaleY: transform.scale.y,
        },
      };
    },
    [selectedClip, clipAtPlayhead],
  );

  const handleClipMouseDown = useCallback(
    (e: React.MouseEvent) => {
      useUIStore.getState().setDesktopInspectorTab("properties");
      e.stopPropagation();
      e.preventDefault();

      const clip = selectedClip || clipAtPlayhead;
      if (!clip) return;

      const transform = clip.transform || {
        position: { x: 0, y: 0 },
        scale: { x: 1, y: 1 },
        rotation: 0,
        opacity: 1,
        anchor: { x: 0.5, y: 0.5 },
      };

      isInteractingRef.current = true;
      setInteractionMode("move");
      interactionStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        transform: {
          x: transform.position.x,
          y: transform.position.y,
          scaleX: transform.scale.x,
          scaleY: transform.scale.y,
        },
      };
    },
    [selectedClip, clipAtPlayhead],
  );

  const handleTextClipMouseDown = useCallback(
    (e: React.MouseEvent) => {
      useUIStore.getState().setDesktopInspectorTab("properties");
      e.stopPropagation();
      e.preventDefault();

      if (!activeTextClip) return;

      const { transform } = activeTextClip;

      isInteractingRef.current = true;
      setInteractionMode("move");
      setInteractionTargetType("text-clip");
      interactionStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        transform: {
          x: transform.position.x,
          y: transform.position.y,
          scaleX: transform.scale.x,
          scaleY: transform.scale.y,
        },
      };
    },
    [activeTextClip],
  );

  const handleTextHandleMouseDown = useCallback(
    (e: React.MouseEvent, handle: HandlePosition) => {
      e.stopPropagation();
      e.preventDefault();

      if (!activeTextClip) return;

      const { transform } = activeTextClip;

      isInteractingRef.current = true;
      setInteractionMode("resize");
      setActiveHandle(handle);
      setInteractionTargetType("text-clip");
      interactionStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        transform: {
          x: transform.position.x,
          y: transform.position.y,
          scaleX: transform.scale.x,
          scaleY: transform.scale.y,
        },
      };
    },
    [activeTextClip],
  );

  const handleShapeClipMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();

      if (!activeShapeClip) return;

      const { transform } = activeShapeClip;

      isInteractingRef.current = true;
      setInteractionMode("move");
      setInteractionTargetType("shape-clip");
      interactionStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        transform: {
          x: transform.position.x,
          y: transform.position.y,
          scaleX: transform.scale.x,
          scaleY: transform.scale.y,
        },
      };
    },
    [activeShapeClip],
  );

  const handleShapeHandleMouseDown = useCallback(
    (e: React.MouseEvent, handle: HandlePosition) => {
      e.stopPropagation();
      e.preventDefault();

      if (!activeShapeClip) return;

      const { transform } = activeShapeClip;

      isInteractingRef.current = true;
      setInteractionMode("resize");
      setActiveHandle(handle);
      setInteractionTargetType("shape-clip");
      interactionStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        transform: {
          x: transform.position.x,
          y: transform.position.y,
          scaleX: transform.scale.x,
          scaleY: transform.scale.y,
        },
      };
    },
    [activeShapeClip],
  );

  const handleGraphicsMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (interactionMode !== "none") {
        setHoveredGraphicClipId(null);
        return;
      }

      const clip = findGraphicClipAtPoint(e.clientX, e.clientY);
      setHoveredGraphicClipId(clip ? clip.id : null);
    },
    [interactionMode, findGraphicClipAtPoint],
  );

  const handleGraphicsClick = useCallback(
    (e: React.MouseEvent) => {
      if (interactionMode !== "none") return;

      const clip = findGraphicClipAtPoint(e.clientX, e.clientY);
      if (clip) {
        useUIStore.getState().setDesktopInspectorTab("properties");
        select({ type: "shape-clip", id: clip.id });
        e.stopPropagation();
      }
    },
    [interactionMode, findGraphicClipAtPoint, select],
  );

  const commitPendingTransform = useCallback(
    (): boolean =>
      commitPendingCanvasTransform(pendingTransformRef, {
        clip: updateClipTransform,
        text: updateTextTransform,
        shape: updateShapeTransform,
      }),
    [updateClipTransform, updateTextTransform, updateShapeTransform],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (interactionMode === "none" || !interactionStartRef.current) return;

      if (
        interactionTargetType === "text-clip" &&
        textClipBounds &&
        activeTextClip
      ) {
        const deltaX = e.clientX - interactionStartRef.current.x;
        const deltaY = e.clientY - interactionStartRef.current.y;
        const { displayScale } = textClipBounds;

        const calculated = calculateOverlayTransform({
          mode: interactionMode,
          handle: activeHandle,
          start: interactionStartRef.current.transform,
          deltaX,
          deltaY,
          displayScale,
          boundsWidth: textClipBounds.width,
          boundsHeight: textClipBounds.height,
          canvasWidth: settings.width,
          canvasHeight: settings.height,
          lockAspectRatio,
          snappingEnabled: canvasSnappingEnabled && !e.altKey,
        });
        const newTransform = calculated.transform;
        setCanvasSnapGuides(calculated.guides);
        pendingTransformRef.current = {
          target: "text-clip",
          targetId: activeTextClip.id,
          transform: newTransform,
        };

        if (!rafIdRef.current) {
          rafIdRef.current = requestAnimationFrame(() => {
            const now = performance.now();
            if (
              now - lastStoreUpdateRef.current >= STORE_UPDATE_THROTTLE_MS
            ) {
              lastStoreUpdateRef.current = now;
              commitPendingTransform();
            }
            rafIdRef.current = null;
          });
        }
        return;
      }

      if (
        interactionTargetType === "shape-clip" &&
        shapeClipBounds &&
        activeShapeClip
      ) {
        const deltaX = e.clientX - interactionStartRef.current.x;
        const deltaY = e.clientY - interactionStartRef.current.y;
        const { displayScale } = shapeClipBounds;

        const calculated = calculateOverlayTransform({
          mode: interactionMode,
          handle: activeHandle,
          start: interactionStartRef.current.transform,
          deltaX,
          deltaY,
          displayScale,
          boundsWidth: shapeClipBounds.width,
          boundsHeight: shapeClipBounds.height,
          canvasWidth: settings.width,
          canvasHeight: settings.height,
          lockAspectRatio,
          snappingEnabled: canvasSnappingEnabled && !e.altKey,
        });
        const newTransform = calculated.transform;
        setCanvasSnapGuides(calculated.guides);
        pendingTransformRef.current = {
          target: "shape-clip",
          targetId: activeShapeClip.id,
          transform: newTransform,
        };

        if (!rafIdRef.current) {
          rafIdRef.current = requestAnimationFrame(() => {
            const now = performance.now();
            if (
              now - lastStoreUpdateRef.current >= STORE_UPDATE_THROTTLE_MS
            ) {
              lastStoreUpdateRef.current = now;
              commitPendingTransform();
            }
            rafIdRef.current = null;
          });
        }
        return;
      }

      if (!clipBounds) return;
      const clip = selectedClip || clipAtPlayhead;
      if (!clip) return;

      const deltaX = e.clientX - interactionStartRef.current.x;
      const deltaY = e.clientY - interactionStartRef.current.y;
      const { displayScale } = clipBounds;

      const calculated = calculateClipTransform({
        mode: interactionMode,
        handle: activeHandle,
        start: interactionStartRef.current.transform,
        deltaX,
        deltaY,
        displayScale,
        boundsWidth: clipBounds.width,
        boundsHeight: clipBounds.height,
        canvasWidth: settings.width,
        canvasHeight: settings.height,
        lockAspectRatio,
        snappingEnabled: canvasSnappingEnabled && !e.altKey,
      });
      const newTransform = calculated.transform;
      setCanvasSnapGuides(calculated.guides);

      pendingTransformRef.current = {
        target: "clip",
        targetId: clip.id,
        transform: newTransform,
      };

      const currentTransform = clip.transform || {
        position: { x: 0, y: 0 },
        scale: { x: 1, y: 1 },
      };
      setLiveTransform({
        position: newTransform.position || currentTransform.position,
        scale: newTransform.scale || currentTransform.scale,
      });

      if (!rafIdRef.current) {
        rafIdRef.current = requestAnimationFrame(() => {
          const now = performance.now();
          if (now - lastStoreUpdateRef.current >= STORE_UPDATE_THROTTLE_MS) {
            lastStoreUpdateRef.current = now;
            commitPendingTransform();
          }
          rafIdRef.current = null;
        });
      }
    },
    [
      interactionMode,
      activeHandle,
      clipBounds,
      selectedClip,
      clipAtPlayhead,
      updateClipTransform,
      settings.width,
      settings.height,
      canvasSnappingEnabled,
      lockAspectRatio,
      interactionTargetType,
      textClipBounds,
      activeTextClip,
      updateTextTransform,
      shapeClipBounds,
      activeShapeClip,
      updateShapeTransform,
      commitPendingTransform,
    ],
  );

  const handleMouseUp = useCallback(() => {
    commitPendingTransform();
    setInteractionTargetType(null);
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }

    const wasInteracting = isInteractingRef.current;
    isInteractingRef.current = false;
    setInteractionMode("none");
    setActiveHandle(null);
    interactionStartRef.current = null;
    setLiveTransform(null);
    setCanvasSnapGuides({ x: null, y: null });

    if (wasInteracting) {
      requestFrameRender(playheadPosition);
    }
  }, [commitPendingTransform, requestFrameRender, playheadPosition]);

  const handleCropChange = useCallback(
    (crop: { x: number; y: number; width: number; height: number }) => {
      if (cropClipId) {
        updateClipTransform(cropClipId, { crop });
      }
    },
    [cropClipId, updateClipTransform],
  );

  const handleCropComplete = useCallback(() => {
    setCropMode(false);
  }, [setCropMode]);

  const handleCropCancel = useCallback(() => {
    setCropMode(false);
  }, [setCropMode]);

  useEffect(() => {
    if (interactionMode !== "none") {
      const handleGlobalMouseUp = () => {
        commitPendingTransform();
        if (rafIdRef.current) {
          cancelAnimationFrame(rafIdRef.current);
          rafIdRef.current = null;
        }

        const wasInteracting = isInteractingRef.current;
        isInteractingRef.current = false;
        setInteractionMode("none");
        setActiveHandle(null);
        interactionStartRef.current = null;
        setLiveTransform(null);

        if (wasInteracting) {
          requestFrameRender(playheadPosition);
        }
      };

      window.addEventListener("mouseup", handleGlobalMouseUp);
      return () => window.removeEventListener("mouseup", handleGlobalMouseUp);
    }
  }, [
    interactionMode,
    requestFrameRender,
    playheadPosition,
    commitPendingTransform,
  ]);

  // ---- Preview scrub bar: pointer-drag seeking -------------------------
  const {
    scrubBarRef,
    handleScrubPointerDown,
    handleScrubPointerMove,
    handleScrubPointerEnd,
    handleScrubKeyDown,
    handleSkipBack,
    handleSkipForward,
  } = usePreviewScrubBar({ actualEndTime, playheadPosition });

  const handleFullscreen = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    if (!document.fullscreenElement) {
      setPreviewZoom({ mode: "fit" });
      container
        .requestFullscreen()
        .then(() => {
          setIsFullscreen(true);
        })
        .catch((err) => {
          console.error("Error entering fullscreen:", err);
        });
    } else {
      document
        .exitFullscreen()
        .then(() => {
          setIsFullscreen(false);
        })
        .catch((err) => {
          console.error("Error exiting fullscreen:", err);
        });
    }
  }, []);

  const handleMaximize = useCallback(() => {
    setPreviewZoom({ mode: "fit" });
    setIsMaximized((prev) => !prev);
  }, []);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () =>
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  const progressPercentage =
    actualEndTime > 0 ? (playheadPosition / actualEndTime) * 100 : 0;

  const showResizeHandles = !isPlaying && selectedClip && clipBounds;

  const showTextClipHandles = !isPlaying && selectedTextClip && textClipBounds;


  const showShapeClipHandles =
    !isPlaying &&
    selectedShapeClip &&
    shapeClipBounds;

  const showSubtitleOverlay =
    !isPlaying && selectedSubtitleObj && subtitleBounds;

  const cropClip = useMemo(() => {
    if (!cropMode || !cropClipId) return null;

    for (const track of timelineTracks) {
      const clip = track.clips.find((c) => c.id === cropClipId);
      if (clip) return clip;
    }
    return null;
  }, [cropMode, cropClipId, timelineTracks]);

  // The blob URL created below must not accumulate across memo recomputes:
  // revoke the previous one before minting a new URL, and revoke the last one
  // on unmount. The URL is still created during render on purpose so
  // CropModeView receives a usable src in the very same commit.
  const cropMediaUrlRef = useRef<string | null>(null);

  useEffect(() => {
    registerPreviewResourceReader(previewResourceOwnerRef.current, () => ({
      videoCacheEntries:
        videoElementCacheRef.current.size + nativeVideoCacheRef.current.size,
      imageBitmapCacheEntries: 0,
      ownedBlobUrls: previewOwnedBlobUrlCountRef.current,
    }));
    return () => releasePreviewResourceCounts(previewResourceOwnerRef.current);
  }, []);

  const cropMediaData = useMemo(() => {
    if (!cropMode || !cropClipId || !cropClip) return null;

    const mediaItem = getMediaItem(cropClip.mediaId);
    if (!mediaItem) return null;

    let src: string | null = null;
    if (mediaItem.blob) {
      if (cropMediaUrlRef.current) {
        URL.revokeObjectURL(cropMediaUrlRef.current);
        previewOwnedBlobUrlCountRef.current -= 1;
      }
      src = URL.createObjectURL(mediaItem.blob);
      cropMediaUrlRef.current = src;
      previewOwnedBlobUrlCountRef.current += 1;
    } else if (mediaItem.contentUrl ?? mediaItem.originalUrl) {
      src = mediaItem.contentUrl ?? mediaItem.originalUrl ?? null;
    }

    if (!src) return null;

    return {
      src,
      type: mediaItem.type as "video" | "image",
    };
  }, [cropMode, cropClipId, cropClip, getMediaItem]);

  useEffect(
    () => () => {
      if (cropMediaUrlRef.current) {
        URL.revokeObjectURL(cropMediaUrlRef.current);
        cropMediaUrlRef.current = null;
        previewOwnedBlobUrlCountRef.current -= 1;
      }
    },
    [],
  );

  const cropVideoSrc = cropMediaData?.src ?? null;
  const cropMediaType = cropMediaData?.type ?? "video";

  const shouldShowCropMode = cropMode && cropClipId && cropClip && cropVideoSrc;

  return (
    <div
      ref={containerRef}
      data-tour="preview"
      tabIndex={0}
      aria-label={tr("Preview canvas")}
      onKeyDown={handlePreviewKeyDown}
      onPointerDownCapture={(event) => {
        const target = event.target as HTMLElement;
        if (!target.closest("input, textarea, select, button")) {
          containerRef.current?.focus({ preventScroll: true });
        }
      }}
      className="w-full h-full min-h-0 min-w-0 bg-stage-bg flex flex-col relative group overflow-hidden outline-none"
    >
      {/* ── Panel bar header (mockup: 'Player') ───────────────── */}
      {showHeader && !isMaximized && !isFullscreen && (
        <div className="flex items-center px-3.5 py-2 border-b border-border bg-bg-1 gap-2.5 min-h-[38px] shrink-0">
          <Text type="label" color="primary" weight="semibold" className="text-[13px] tracking-tight text-fg m-0">{tr("Player")}</Text>
          <div className="ml-auto flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-accent" title={tr("Live preview")} />
          </div>
        </div>
      )}

      {/* Crop Mode View - Full Screen Overlay */}
      {shouldShowCropMode && (
        <CropModeView
          clip={cropClip!}
          videoSrc={cropVideoSrc}
          mediaType={cropMediaType}
          currentTime={playheadPosition}
          canvasWidth={canvasSize.width}
          canvasHeight={canvasSize.height}
          onCropChange={handleCropChange}
          onComplete={handleCropComplete}
          onCancel={handleCropCancel}
        />
      )}

      <div
        ref={setComparisonControlsContainerRef}
        className="w-full shrink-0 empty:hidden"
      />

      <div className="flex flex-1 min-h-0 min-w-0">
      {/* Video Area */}
      <div
        ref={videoAreaRef}
        className={`flex-1 min-h-0 min-w-0 relative flex bg-bg-1 transition-all duration-300 ${
          isMaximized || isFullscreen ? "p-0" : referenceComparison ? "p-[4px]" : "p-[18px]"
        } ${previewFrameHasOverflow ? "items-start justify-start overflow-auto" : "items-center justify-center overflow-hidden"}`}
        onMouseMove={interactionMode !== "none" ? handleMouseMove : undefined}
        onMouseUp={handleMouseUp}
      >
        <ContextMenu items={previewMarkerMenuItems} menuWidth={260} size="sm">
        <div
          ref={overlayRef}
          className={`relative bg-[var(--screen-bg)] overflow-visible transition-all duration-300 ${
            isMaximized || isFullscreen
              ? "rounded-none ring-0 shadow-none"
              : isDark
                ? "shadow-2xl rounded-[10px] ring-1 ring-border shadow-[0_0_50px_rgba(0,0,0,0.5)]"
                : "rounded-[10px] ring-1 ring-border shadow-sm"
          }`}
          style={{
            width: `${previewFrameSize.width}px`,
            height: `${previewFrameSize.height}px`,
            maxWidth: "none",
            maxHeight: "none",
            flex: "none",
          }}
          onMouseMove={!isPlaying ? handleGraphicsMouseMove : undefined}
          onClick={!isPlaying ? handleGraphicsClick : undefined}
          onClickCapture={handleTargetPointClickCapture}
          onMouseLeave={() => setHoveredGraphicClipId(null)}
        >
          <canvas
            ref={canvasRef}
            data-testid="preview-canvas"
            width={previewRes.width}
            height={previewRes.height}
            className="w-full h-full object-contain bg-[var(--screen-bg)] rounded-[10px]"
            style={{
              cursor: targetPointArmed
                ? "crosshair"
                : hoveredGraphicClipId && !isPlaying
                  ? "pointer"
                  : "default",
            }}
          />

          {previewSessionState.loading ? (
            <div
              data-testid="preview-loading-overlay"
              className="absolute inset-0 z-40 flex items-start justify-center bg-black/20 p-4 backdrop-blur-[1px]"
            >
              <VersionPreviewLoadingStatus className="w-full max-w-sm" />
            </div>
          ) : null}

          {agentTargetMarkerStyle ? (
            <div
              aria-label={tr("Agent target point")}
              className="pointer-events-none absolute z-30"
              style={agentTargetMarkerStyle}
            >
              <span className="absolute -translate-x-1/2 -translate-y-1/2 block h-3 w-3 rounded-full border-2 border-accent bg-accent/30 shadow-[0_0_4px_rgba(0,0,0,0.6)]" />
            </div>
          ) : null}

          {!cropMode && reviewMarkerPills.length > 0 ? (
            <div
              aria-label={tr("reviewMarkers.ariaLabel")}
              className="pointer-events-none absolute left-2 top-2 z-30 flex flex-col items-start gap-1"
            >
              {reviewMarkerPills.slice(0, 6).map(({ marker, selected }) => (
                <ProjectMarkerBadge
                  key={marker.id}
                  number={marker.number}
                  label={marker.label}
                  selected={selected}
                  size="md"
                />
              ))}
              {reviewMarkerPills.length > 6 ? (
                <span className="inline-block rounded-[4px] bg-[#f59e0b]/80 px-2 py-1 text-[10px] font-bold leading-none text-[#201300] shadow-[0_1px_5px_rgba(0,0,0,0.35)]">
                  {tr("reviewMarkers.more", {
                    count: reviewMarkerPills.length - 6,
                  })}
                </span>
              ) : null}
            </div>
          ) : null}

          {showCompositionGrid && !cropMode ? (
            <div
              aria-label={tr("Composition grid")}
              className="pointer-events-none absolute inset-0 z-20"
            >
              {[1, 2].map((line) => (
                <React.Fragment key={line}>
                  <span
                    className="absolute inset-y-0 w-px bg-white/45 shadow-[0_0_1px_rgba(0,0,0,0.9)]"
                    style={{ left: `${(line / 3) * 100}%` }}
                  />
                  <span
                    className="absolute inset-x-0 h-px bg-white/45 shadow-[0_0_1px_rgba(0,0,0,0.9)]"
                    style={{ top: `${(line / 3) * 100}%` }}
                  />
                </React.Fragment>
              ))}
            </div>
          ) : null}

          {showSafeMargins && !cropMode ? (
            <div
              aria-label={tr("Title and action safe margins")}
              className="pointer-events-none absolute inset-0 z-20"
            >
              <span className="absolute inset-[5%] border border-dashed border-white/60 shadow-[0_0_1px_rgba(0,0,0,0.9)]" />
              <span className="absolute inset-[10%] border border-white/75 shadow-[0_0_1px_rgba(0,0,0,0.9)]" />
              <span className="absolute left-[10%] top-[10%] rounded-br bg-black/55 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white/80">
                {tr("Title safe")}</span>
            </div>
          ) : null}

          {canvasSnapGuides.x !== null && !cropMode ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 z-30 w-px bg-accent shadow-[0_0_3px_var(--accent)]"
              style={{ left: `${canvasSnapGuides.x * 100}%` }}
            />
          ) : null}
          {canvasSnapGuides.y !== null && !cropMode ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 z-30 h-px bg-accent shadow-[0_0_3px_var(--accent)]"
              style={{ top: `${canvasSnapGuides.y * 100}%` }}
            />
          ) : null}

          {/* Processing Overlay */}
          <ProcessingOverlay />

          {/* Motion Path Overlay */}
          {motionPathMode && motionPathConfig && motionPathClip && (
            <div className="absolute inset-0 pointer-events-auto z-30">
              <MotionPathOverlay
                config={motionPathConfig}
                canvasWidth={settings.width}
                canvasHeight={settings.height}
                currentTime={playheadPosition - motionPathClip.startTime}
                clipDuration={motionPathClip.duration}
                onPointMove={handleMotionPathPointMove}
                onPointAdd={handleMotionPathPointAdd}
                onPointRemove={handleMotionPathPointRemove}
                onControlPointMove={handleMotionPathControlPointMove}
                disabled={isPlaying}
              />
            </div>
          )}

          {/* Export Overlay */}
          {exportState.isExporting && (
            <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm">
              <div
                role="status"
                aria-live="polite"
                className="w-full max-w-[360px] rounded-xl border border-white/15 bg-neutral-950/95 p-5 text-white shadow-2xl"
              >
                <div className="mb-5 flex min-w-0 items-start gap-3">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/20 ring-1 ring-primary/40">
                    <Loader2 size={21} className="animate-spin text-primary" />
                  </div>
                  <div className="min-w-0 flex-1 pt-0.5">
                    <Text
                      type="label"
                      weight="semibold"
                      display="block"
                      className="text-sm leading-5 text-white"
                    >
                      {tr("Exporting Video")}</Text>
                    <Text
                      type="supporting"
                      display="block"
                      maxLines={2}
                      className="mt-1 text-xs leading-4 text-white/75"
                    >
                      {exportState.phase || "Preparing..."}
                    </Text>
                  </div>
                </div>

                <div className="mb-4 min-w-0">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <span className="text-[11px] font-medium text-white/80">
                      {tr("Export Progress")}</span>
                    <span className="shrink-0 font-mono text-[11px] font-semibold text-white">
                      {Math.round(exportState.progress)}%
                    </span>
                  </div>
                  <div className="h-2.5 overflow-hidden rounded-full bg-white/15">
                    <div
                      className="h-full rounded-full bg-primary transition-all duration-300"
                      style={{
                        width: `${Math.min(100, Math.max(0, exportState.progress))}%`,
                      }}
                    />
                  </div>
                </div>

                <Text
                  type="supporting"
                  display="block"
                  className="text-center text-[11px] leading-4 text-white/70"
                >
                  {tr("You can keep editing once the export finishes.")}</Text>
              </div>
            </div>
          )}

          {/* Resize/Transform Overlay */}
          {!cropMode && showResizeHandles && clipBounds && (
            <SelectionTransformOverlay
              bounds={clipBounds}
              lockAspectRatio={lockAspectRatio}
              theme="primary"
              moveTitle={tr("Drag to move")}
              onToggleLock={() => setLockAspectRatio(!lockAspectRatio)}
              onMoveHandleMouseDown={handleClipMouseDown}
              onHandleMouseDown={handleHandleMouseDown}
            />
          )}

          {/* Text Clip Resize/Transform Overlay */}
          {showTextClipHandles && textClipBounds && (
            <SelectionTransformOverlay
              bounds={textClipBounds}
              lockAspectRatio={lockAspectRatio}
              theme="cyan"
              moveTitle={tr("Drag to move text")}
              onToggleLock={() => setLockAspectRatio(!lockAspectRatio)}
              onMoveHandleMouseDown={handleTextClipMouseDown}
              onHandleMouseDown={handleTextHandleMouseDown}
            />
          )}

          {/* Shape Clip Resize/Transform Overlay */}
          {showShapeClipHandles && shapeClipBounds && (
            <div
              className="absolute pointer-events-none"
              style={{
                left: shapeClipBounds.x,
                top: shapeClipBounds.y,
                width: shapeClipBounds.width,
                height: shapeClipBounds.height,
              }}
            >
              {selectedShapeClip.type !== "svg" && (
                <div className="absolute inset-0 border-2 border-green-500 pointer-events-none" />
              )}

              {/* Move handle (center) */}
              <div
                className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 bg-green-500/80 rounded-full flex items-center justify-center cursor-move pointer-events-auto hover:bg-green-500 transition-colors"
                onMouseDown={handleShapeClipMouseDown}
                title={tr("Drag to move shape")}
              >
                <Move size={14} className="text-white" />
              </div>

              {/* Aspect ratio lock toggle */}
              <Button
                label={lockAspectRatio ? tr("Unlock aspect ratio") : tr("Lock aspect ratio")}
                variant="ghost"
                className={`absolute -top-8 left-1/2 -translate-x-1/2 px-2 py-1 text-[10px] rounded pointer-events-auto transition-colors ${
                  lockAspectRatio
                    ? "bg-green-500 text-white"
                    : "bg-background-tertiary text-text-secondary border border-border hover:bg-background-elevated"
                }`}
                onClick={() => setLockAspectRatio(!lockAspectRatio)}
              >
                {lockAspectRatio ? "🔒 Locked" : "🔓 Free"}
              </Button>

              {/* Corner resize handles */}
              <div
                className="absolute -left-2 -top-2 w-4 h-4 bg-white border-2 border-green-500 rounded-sm cursor-nw-resize pointer-events-auto hover:bg-green-500 hover:border-white transition-colors"
                onMouseDown={(e) => handleShapeHandleMouseDown(e, "nw")}
              />
              <div
                className="absolute -right-2 -top-2 w-4 h-4 bg-white border-2 border-green-500 rounded-sm cursor-ne-resize pointer-events-auto hover:bg-green-500 hover:border-white transition-colors"
                onMouseDown={(e) => handleShapeHandleMouseDown(e, "ne")}
              />
              <div
                className="absolute -left-2 -bottom-2 w-4 h-4 bg-white border-2 border-green-500 rounded-sm cursor-sw-resize pointer-events-auto hover:bg-green-500 hover:border-white transition-colors"
                onMouseDown={(e) => handleShapeHandleMouseDown(e, "sw")}
              />
              <div
                className="absolute -right-2 -bottom-2 w-4 h-4 bg-white border-2 border-green-500 rounded-sm cursor-se-resize pointer-events-auto hover:bg-green-500 hover:border-white transition-colors"
                onMouseDown={(e) => handleShapeHandleMouseDown(e, "se")}
              />

              {/* Edge resize handles */}
              <div
                className="absolute left-1/2 -translate-x-1/2 -top-2 w-6 h-4 bg-white border-2 border-green-500 rounded-sm cursor-n-resize pointer-events-auto hover:bg-green-500 hover:border-white transition-colors"
                onMouseDown={(e) => handleShapeHandleMouseDown(e, "n")}
              />
              <div
                className="absolute left-1/2 -translate-x-1/2 -bottom-2 w-6 h-4 bg-white border-2 border-green-500 rounded-sm cursor-s-resize pointer-events-auto hover:bg-green-500 hover:border-white transition-colors"
                onMouseDown={(e) => handleShapeHandleMouseDown(e, "s")}
              />
              <div
                className="absolute top-1/2 -translate-y-1/2 -left-2 w-4 h-6 bg-white border-2 border-green-500 rounded-sm cursor-w-resize pointer-events-auto hover:bg-green-500 hover:border-white transition-colors"
                onMouseDown={(e) => handleShapeHandleMouseDown(e, "w")}
              />
              <div
                className="absolute top-1/2 -translate-y-1/2 -right-2 w-4 h-6 bg-white border-2 border-green-500 rounded-sm cursor-e-resize pointer-events-auto hover:bg-green-500 hover:border-white transition-colors"
                onMouseDown={(e) => handleShapeHandleMouseDown(e, "e")}
              />
            </div>
          )}

          {/* Subtitle Selection Overlay */}
          {showSubtitleOverlay && subtitleBounds && (
            <div
              className="absolute pointer-events-none"
              style={{
                left: subtitleBounds.x,
                top: subtitleBounds.y,
                width: subtitleBounds.width,
                height: subtitleBounds.height,
              }}
            >
              {/* Selection border - yellow/orange for subtitles */}
              <div className="absolute inset-0 border-2 border-yellow-500 rounded-lg pointer-events-none animate-pulse" />
              <div className="absolute -top-6 left-1/2 -translate-x-1/2 px-2 py-0.5 bg-yellow-500 rounded text-[10px] font-medium text-black whitespace-nowrap">
                {tr("Subtitle Selected - Edit in Inspector")}</div>
            </div>
          )}

          {/* Graphic Clip Hover Indicators */}
          {!cropMode && !isPlaying &&
            activeGraphicClips.map((clip) => {
              if (clip.type === "svg") return null;
              if (clip.id === selectedShapeClipId) return null;
              if (clip.id !== hoveredGraphicClipId) return null;
              const bounds = getGraphicClipDisplayBounds(clip);
              if (!bounds) return null;
              return (
                <div
                  key={clip.id}
                  className="absolute pointer-events-none z-10"
                  style={{
                    left: bounds.x,
                    top: bounds.y,
                    width: bounds.width,
                    height: bounds.height,
                  }}
                >
                  <div className="absolute inset-0 border-2 border-dashed border-white/80 rounded-sm" />
                  <div
                    aria-hidden="true"
                    className="absolute -top-6 left-1/2 -translate-x-1/2 px-2 py-0.5 bg-black/70 rounded text-[10px] text-white whitespace-nowrap"
                  >
                    {tr("Click to select")}</div>
                </div>
              );
            })}
          <ReferenceComparisonPanel
            timelineCanvasRef={canvasRef}
            userMuted={userMuted}
            controlsContainer={comparisonControlsContainer}
            settingsContainer={comparisonSettingsContainer}
          />
        </div>
        </ContextMenu>
      </div>
      <div
        ref={setComparisonSettingsContainerRef}
        className="w-80 max-w-[40%] shrink-0 min-h-0 overflow-y-auto empty:hidden"
      />
      </div>

      {/* Player Controls with integrated Scrub Bar */}
      <div
        className={`border-t border-border transition-all duration-300 ${
          isMaximized || isFullscreen
            ? "absolute bottom-0 left-0 right-0 z-50 bg-bg-1 backdrop-blur-sm"
            : "z-20 bg-bg-1"
        }`}
      >
        {/* Scrub Bar - integrated at top of controls. Pointer capture keeps
            the drag alive outside the thin bar; the padded wrapper widens the
            hit area so hover never resizes the drag target. */}
        <div
          ref={scrubBarRef}
          role="slider"
          tabIndex={0}
          aria-label={tr("Scrub bar")}
          aria-valuemin={0}
          aria-valuemax={Math.max(0, Math.round(actualEndTime))}
          aria-valuenow={Math.round(playheadPosition * 100) / 100}
          aria-valuetext={`${formatTime(playheadPosition)} / ${formatTime(actualEndTime)}`}
          className="group relative cursor-pointer py-2.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          onPointerDown={handleScrubPointerDown}
          onPointerMove={handleScrubPointerMove}
          onPointerUp={handleScrubPointerEnd}
          onPointerCancel={handleScrubPointerEnd}
          onKeyDown={handleScrubKeyDown}
        >
          <div className="h-1.5 bg-bg-2 rounded-full relative overflow-hidden">
            <div
              className="h-full bg-accent relative pointer-events-none shadow-glow"
              style={{ width: `${progressPercentage}%` }}
            >
              <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full shadow-md opacity-0 group-hover:opacity-100 transition-opacity transform scale-0 group-hover:scale-100 duration-100 border border-black/20" />
            </div>
          </div>
        </div>

        {/* Controls row */}
        <div data-testid="preview-controls" className="min-h-12 px-4 py-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
          <span className="font-mono text-[13px] tabular-nums tracking-tight font-medium">
            <span className="text-fg-2">{formatTime(playheadPosition)}</span>
            <span className="text-fg-muted mx-1.5">/</span>
            <span className="text-fg-muted">{formatTime(actualEndTime)}</span>
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-4 mx-auto">
          <IconButton
            label={tr("Skip back 5s")}
            icon={<SkipBack size={18} />}
            variant="ghost"
            size="sm"
            onClick={handleSkipBack}
            className="w-8 h-8 grid place-items-center rounded-md text-fg-2 hover:bg-hover hover:text-fg transition-colors"
          />
          <IconButton
            label={playbackLockedReason ?? tr(isPlaying ? "Pause" : "Play")}
            icon={
              isPlaying ? (
                <Pause size={18} fill="currentColor" />
              ) : playbackLockedReason ? (
                <Loader2 size={18} className="animate-spin" />
              ) : (
                <Play size={18} fill="currentColor" className="ml-0.5" />
              )
            }
            variant="ghost"
            size="md"
            onClick={() => {
              togglePlayback();
            }}
            isDisabled={Boolean(playbackLockedReason)}
            className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${
              playbackLockedReason
                ? "bg-bg-2 text-fg-muted cursor-not-allowed"
                : "bg-bg-2 text-fg hover:bg-bg-3"
            }`}
          />
          <IconButton
            label={tr("Skip forward 5s")}
            icon={<SkipForward size={18} />}
            variant="ghost"
            size="sm"
            onClick={handleSkipForward}
            className="w-8 h-8 grid place-items-center rounded-md text-fg-2 hover:bg-hover hover:text-fg transition-colors"
          />
        </div>

        <div className="flex max-w-full shrink-0 flex-wrap gap-1.5 items-center whitespace-nowrap [&>button]:shrink-0 [&>div]:shrink-0">
          <IconButton
            label={tr("Set agent target point")}
            icon={<Crosshair size={16} />}
            variant="ghost"
            size="sm"
            aria-pressed={targetPointArmed}
            onClick={() => {
              if (targetPointArmed || agentTargetPoint) {
                setTargetPointArmed(false);
                clearAgentTargetPoint();
              } else {
                setTargetPointArmed(true);
              }
            }}
            className={`w-[34px] h-[34px] grid place-items-center rounded-[7px] transition-colors ${
              targetPointArmed || agentTargetPoint
                ? "bg-accent-soft text-accent"
                : "bg-bg-2 text-fg-2 hover:text-fg hover:bg-bg-3"
            }`}
          />
          <IconButton
            label={userMuted ? tr("Unmute") : tr("Mute")}
            icon={userMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
            variant="ghost"
            size="sm"
            onClick={() => setIsMuted(!userMuted)}
            className={`w-[34px] h-[34px] grid place-items-center rounded-[7px] transition-colors ${
              userMuted
                ? "bg-bg-2 text-status-error"
                : "bg-bg-2 text-fg-2 hover:text-fg hover:bg-bg-3"
            }`}
          />

          {/* Aspect ratio (project canvas size) */}
          <div className="relative">
            <Button
              label={tr("Aspect ratio")}
              variant="ghost"
              onClick={() => setShowAspectMenu(!showAspectMenu)}
              className="flex items-center gap-1.5 rounded-[7px] bg-bg-2 px-[11px] py-[7px] text-[12px] font-medium text-fg-2 hover:bg-bg-3 hover:text-fg transition-colors"
            >
              <div className="flex items-center gap-1">
                <Proportions size={12} />
                <span>{aspectLabelFor(settings.width, settings.height)}</span>
              </div>
            </Button>
            {showAspectMenu && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setShowAspectMenu(false)}
                />
                <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-bg-elev border border-border rounded-md shadow-md py-1 z-50 min-w-[120px]">
                  {ASPECT_PRESETS.map((opt) => {
                    const isActive =
                      settings.width === opt.width &&
                      settings.height === opt.height;
                    return (
                      <Button
                        key={opt.label}
                        label={`${opt.label} ${opt.width} by ${opt.height}`}
                        variant="ghost"
                        onClick={() => {
                          void updateSettings({
                            width: opt.width,
                            height: opt.height,
                          });
                          setShowAspectMenu(false);
                        }}
                        className={`w-full px-3 py-1.5 text-[11px] font-mono text-left hover:bg-hover transition-colors flex items-center justify-between gap-3 ${
                          isActive ? "text-accent" : "text-fg-2"
                        }`}
                        >
                        <span>{tr(opt.label)}</span>
                        <span className="text-fg-3 text-[10px]">
                          {opt.width}×{opt.height}
                        </span>
                      </Button>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          {/* Playback Quality (render resolution) */}
          <div className="relative">
            <Button
              label={tr("Playback quality")}
              variant="ghost"
              onClick={() => setShowQualityMenu(!showQualityMenu)}
              className="rounded-[7px] bg-bg-2 px-[11px] py-[7px] text-[12px] font-medium text-fg-2 hover:bg-bg-3 hover:text-fg transition-colors"
            >
              {PREVIEW_QUALITY_OPTIONS.find((o) => o.value === playbackQuality)
                ?.label ?? "Auto"}
            </Button>
            {showQualityMenu && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setShowQualityMenu(false)}
                />
                <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-bg-elev border border-border rounded-md shadow-md py-1 z-50 min-w-[80px]">
                  {PREVIEW_QUALITY_OPTIONS.map((opt) => (
                    <Button
                      key={opt.value}
                      label={tr(opt.label)}
                      variant="ghost"
                      onClick={() => {
                        setPlaybackQuality(opt.value);
                        setShowQualityMenu(false);
                      }}
                      className={`w-full px-3 py-1.5 text-[11px] font-mono text-left hover:bg-hover transition-colors ${
                        playbackQuality === opt.value
                          ? "text-accent"
                          : "text-fg-2"
                      }`}
                    >
                      {tr(opt.label)}
                    </Button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Zoom Control */}
          <div className="relative">
            <Button
              label={tr("Preview Zoom")}
              variant="ghost"
              onClick={() => setShowZoomMenu(!showZoomMenu)}
              className="flex items-center gap-1.5 rounded-[7px] bg-bg-2 px-[11px] py-[7px] text-[12px] font-medium text-fg-2 hover:bg-bg-3 hover:text-fg transition-colors"
            >
              <div className="flex items-center gap-1">
                <ZoomIn size={12} />
                <span>{previewZoom.mode === "fit" ? tr("Fit") : `${Math.round(previewZoom.value)}%`}</span>
              </div>
            </Button>
            {showZoomMenu && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setShowZoomMenu(false)}
                />
                <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-bg-elev border border-border rounded-md shadow-md py-1 z-50 min-w-[80px]">
                  {ZOOM_OPTIONS.map((opt) => (
                    <Button
                      key={opt.label}
                      label={tr(opt.label)}
                      variant="ghost"
                      onClick={() => {
                        setPreviewZoom(opt.zoom);
                        setShowZoomMenu(false);
                      }}
                      className={`w-full px-3 py-1.5 text-[11px] font-mono text-left hover:bg-hover transition-colors ${
                        previewZoom.mode === opt.zoom.mode &&
                        (opt.zoom.mode === "fit" || (previewZoom.mode === "percent" && previewZoom.value === opt.zoom.value))
                          ? "text-accent"
                          : "text-fg-2"
                      }`}
                    >
                      {tr(opt.label)}
                    </Button>
                  ))}
                </div>
              </>
            )}
          </div>

          <ReferenceComparisonControl />
          <ReviewRangeControl />

          <IconButton
            label={tr("Canvas snapping")}
            icon={<Magnet size={16} />}
            variant="ghost"
            size="sm"
            aria-pressed={canvasSnappingEnabled}
            onClick={() => {
              setCanvasSnappingEnabled((enabled) => !enabled);
              setCanvasSnapGuides({ x: null, y: null });
            }}
            className={`w-[34px] h-[34px] grid place-items-center rounded-[7px] transition-colors ${
              canvasSnappingEnabled
                ? "bg-accent-soft text-accent"
                : "bg-bg-2 text-fg-2 hover:text-fg hover:bg-bg-3"
            }`}
          />
          <IconButton
            label={tr("Composition grid")}
            icon={<Move size={16} />}
            variant="ghost"
            size="sm"
            aria-pressed={showCompositionGrid}
            onClick={() => setShowCompositionGrid((visible) => !visible)}
            className={`w-[34px] h-[34px] grid place-items-center rounded-[7px] transition-colors ${
              showCompositionGrid
                ? "bg-accent-soft text-accent"
                : "bg-bg-2 text-fg-2 hover:text-fg hover:bg-bg-3"
            }`}
          />
          <IconButton
            label={tr("Title and action safe margins")}
            icon={<Proportions size={16} />}
            variant="ghost"
            size="sm"
            aria-pressed={showSafeMargins}
            onClick={() => setShowSafeMargins((visible) => !visible)}
            className={`w-[34px] h-[34px] grid place-items-center rounded-[7px] transition-colors ${
              showSafeMargins
                ? "bg-accent-soft text-accent"
                : "bg-bg-2 text-fg-2 hover:text-fg hover:bg-bg-3"
            }`}
          />

          <IconButton
            label={isFullscreen ? tr("Exit Full Screen") : tr("Full Screen")}
            icon={<Monitor size={16} />}
            variant="ghost"
            size="sm"
            onClick={handleFullscreen}
            className={`w-[34px] h-[34px] grid place-items-center rounded-[7px] transition-colors ${
              isFullscreen
                ? "bg-accent-soft text-accent"
                : "bg-bg-2 text-fg-2 hover:text-fg hover:bg-bg-3"
            }`}
          />
          <IconButton
            label={isMaximized ? tr("Restore Size") : tr("Maximize Preview")}
            icon={isMaximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            variant="ghost"
            size="sm"
            onClick={handleMaximize}
            className={`w-[34px] h-[34px] grid place-items-center rounded-[7px] transition-colors ${
              isMaximized
                ? "bg-accent-soft text-accent"
                : "bg-bg-2 text-fg-2 hover:text-fg hover:bg-bg-3"
            }`}
          />
        </div>
        </div>
      </div>
      {/* Reference comparison (P1) — the GUI surface of the shared config */}
    </div>
  );
};

export default Preview;
