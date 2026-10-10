import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import {
  mapTimelineToReference,
  type ReferenceComparisonConfig,
  type ReferenceComparisonLayout,
} from "@reelterminal/core/types/reference-comparison";
import type { Action } from "@reelterminal/core/types/actions";
import { useProjectStore } from "../../../stores/project-store";
import { useTimelineStore } from "../../../stores/timeline-store";
import { toast } from "../../../stores/notification-store";
import { useTranslation } from "react-i18next";
import { Columns2, Layers, Settings2 } from "@/icons/lucide-compat";
import { ToolcraftPopover } from "@reelterminal/ui";
import { workspaceManager, type ProjectNodeSummary } from "../../../services/workspace-manager";
import { previewSession } from "../../../services/preview-session";
import { loadMediaBlob } from "../../../services/media-storage";
import {
  createHistoryFrameRenderer,
  type HistoryFrameRenderer,
  type HistoryFrameResult,
} from "./history-frame-renderer";

interface MediaItemLike {
  readonly id: string;
  readonly name?: string;
  readonly type?: string;
  readonly blob?: Blob | null;
  readonly contentUrl?: string;
  readonly originalUrl?: string;
  readonly metadata: { readonly duration: number };
}

export async function resolveReferenceMediaUrl(
  item: Pick<MediaItemLike, "id" | "blob" | "contentUrl" | "originalUrl"> | undefined,
  createObjectUrl: (blob: Blob) => string = (blob) => URL.createObjectURL(blob),
): Promise<{ readonly url: string | null; readonly revoke: boolean }> {
  if (!item) return { url: null, revoke: false };
  const blob = item.blob instanceof Blob ? item.blob : await loadMediaBlob(item.id);
  if (blob) return { url: createObjectUrl(blob), revoke: true };
  // Controlled-media paths are OS paths, not renderer URLs. Their bytes must
  // come through media storage rather than bypassing the desktop's read gate.
  const sourceUrl = [item.contentUrl, item.originalUrl].find(
    (url) => url && /^(https?:|blob:|data:)/i.test(url),
  );
  if (sourceUrl) return { url: sourceUrl, revoke: false };
  return { url: null, revoke: false };
}

function setComparisonAction(config: ReferenceComparisonConfig): Action {
  return {
    type: "reference/setComparison",
    id: `reference-set-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    params: { config },
  };
}

function selectComparisonAction(
  media: MediaItemLike,
  layout: ReferenceComparisonConfig["layout"] = "side-by-side",
): Action {
  return setComparisonAction({
    referenceMediaId: media.id,
    refStartSec: 0,
    refEndSec: media.metadata.duration,
    timelineStartSec: 0,
    rate: 1,
    audioSide: "timeline",
    layout,
  });
}

function clearComparisonAction(): Action {
  return {
    type: "reference/clearComparison",
    id: `reference-clear-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    params: {},
  };
}

/** "初剪 · 10月9日 09:32"-style version label, localized per the active language. */
export function formatVersionTimestamp(timestamp: number, locale?: string): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  const formatter = new Intl.DateTimeFormat(locale || undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return formatter.format(new Date(timestamp));
}

/**
 * History comparison state is UI-LOCAL by design (docs/VERSION-NODES-UX.md):
 * comparing against a node reads an independent read-only snapshot and must
 * never mutate the project, the undo chain, timeline references or the export
 * target — so it deliberately does NOT go through reference/setComparison.
 */
export interface HistoryComparisonState {
  readonly projectId: string;
  readonly nodeId: string;
  readonly name: string;
  readonly createdAt: number;
  readonly durationSec: number;
  readonly width: number;
  readonly height: number;
  readonly layout: ReferenceComparisonLayout;
  readonly overlayOpacity: number;
  /** The only audible side is the current (or previewed) side; the history canvas is silent. */
  readonly audioSide: "current" | "none";
  readonly timelineStartSec: number;
  readonly refStartSec: number;
  readonly renderer: HistoryFrameRenderer;
}

let historySnapshot: HistoryComparisonState | null = null;
const historyListeners = new Set<() => void>();

const emitHistoryChanged = (): void => {
  for (const listener of historyListeners) listener();
};

export const subscribeHistoryComparison = (listener: () => void): (() => void) => {
  historyListeners.add(listener);
  return () => {
    historyListeners.delete(listener);
  };
};

export const getHistoryComparisonSnapshot = (): HistoryComparisonState | null => historySnapshot;

export function useHistoryComparison(): HistoryComparisonState | null {
  return useSyncExternalStore(
    subscribeHistoryComparison,
    getHistoryComparisonSnapshot,
    getHistoryComparisonSnapshot,
  );
}

export function activateHistoryComparison(
  input: Omit<
    HistoryComparisonState,
    "layout" | "overlayOpacity" | "audioSide" | "timelineStartSec" | "refStartSec"
  >,
): void {
  if (historySnapshot && historySnapshot.renderer !== input.renderer) {
    historySnapshot.renderer.dispose();
  }
  historySnapshot = {
    ...input,
    // Carry view preferences across node switches; time offsets reset per node.
    layout: historySnapshot?.layout ?? "side-by-side",
    overlayOpacity: historySnapshot?.overlayOpacity ?? 0.5,
    audioSide: "current",
    timelineStartSec: 0,
    refStartSec: 0,
  };
  emitHistoryChanged();
}

export function updateHistoryComparison(
  patch: Partial<
    Pick<
      HistoryComparisonState,
      "layout" | "overlayOpacity" | "audioSide" | "timelineStartSec" | "refStartSec"
    >
  >,
): void {
  if (!historySnapshot) return;
  historySnapshot = { ...historySnapshot, ...patch };
  emitHistoryChanged();
}

export function closeHistoryComparison(): void {
  if (!historySnapshot) return;
  historySnapshot.renderer.dispose();
  historySnapshot = null;
  emitHistoryChanged();
}

/**
 * Source picker shared by the toolbar popover: reference media (project state)
 * plus a second section listing the current project's history nodes
 * (UI-local state). Lives outside the popover so it can be exercised directly.
 */
export function ComparisonSourcePicker({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const project = useProjectStore((state) => state.project);
  const executeAction = useProjectStore((state) => state.executeAction);
  const history = useHistoryComparison();
  const [nodes, setNodes] = useState<ProjectNodeSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);
  const config = project.referenceComparison;
  const videoItems = project.mediaLibrary.items.filter(
    (item) => item.type === "video" && item.metadata.duration > 0,
  );

  useEffect(() => {
    const target = workspaceManager.getActiveTarget();
    if (!target) {
      setNodes([]);
      return;
    }
    let cancelled = false;
    void workspaceManager
      .listNodes(target.projectId)
      .then((list) => {
        if (!cancelled) setNodes(list);
      })
      .catch(() => {
        if (!cancelled) setNodes([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const apply = async (action: Action) => {
    const result = await executeAction(action);
    setError(result.success ? null : result.error?.message ?? t("Could not configure comparison."));
    if (result.success) onClose();
  };

  const selectHistoryNode = async (nodeId: string) => {
    if (activating) return;
    const target = workspaceManager.getActiveTarget();
    if (!target) return;
    setActivating(true);
    try {
      const record = await workspaceManager.getNode(target.projectId, nodeId);
      if (!record) throw new Error("history node is not available");
      const renderer = await createHistoryFrameRenderer(target.projectId, record);
      activateHistoryComparison({
        projectId: target.projectId,
        nodeId: record.id,
        name: record.name,
        createdAt: record.createdAt,
        durationSec: renderer.durationSec,
        width: renderer.width,
        height: renderer.height,
        renderer,
      });
      onClose();
    } catch {
      toast.error(t("versioning.compareSourceMissing"));
      onClose();
    } finally {
      setActivating(false);
    }
  };

  return (
    <div className="w-64 space-y-3 bg-bg-elev p-3 text-xs text-fg">
      <label className="block space-y-2">
        <span className="font-medium">{t("Reference comparison")}</span>
        <select
          aria-label={t("Choose reference video")}
          value={config?.referenceMediaId ?? ""}
          disabled={videoItems.length === 0}
          className="h-8 w-full rounded-md border border-border bg-bg-2 px-2 text-fg outline-none focus:border-accent"
          onChange={(event) => {
            const media = videoItems.find((item) => item.id === event.target.value);
            if (media) {
              // Switching to a reference source leaves any history compare.
              closeHistoryComparison();
              void apply(selectComparisonAction(media, config?.layout));
            }
          }}
        >
          <option value="" disabled>{t("Choose reference video")}</option>
          {videoItems.map((item) => (
            <option key={item.id} value={item.id}>{item.name ?? item.id}</option>
          ))}
        </select>
      </label>
      {videoItems.length === 0 && (
        <p className="text-fg-muted">{t("Add a video to the media library to compare it.")}</p>
      )}
      <label className="block space-y-2">
        <span className="font-medium">{t("versioning.compareHistory")}</span>
        <select
          aria-label={t("versioning.compareHistory")}
          value={history?.nodeId ?? ""}
          disabled={nodes.length === 0}
          className="h-8 w-full rounded-md border border-border bg-bg-2 px-2 text-fg outline-none focus:border-accent"
          onChange={(event) => {
            const value = event.target.value;
            if (value) void selectHistoryNode(value);
          }}
        >
          <option value="" disabled>{t("versioning.compareHistory")}</option>
          {nodes.map((node) => (
            <option
              key={node.id}
              value={node.id}
              title={node.summary || undefined}
            >
              {`${node.name} · ${formatVersionTimestamp(node.createdAt, i18n.language)}`}
            </option>
          ))}
        </select>
      </label>
      {config && (
        <button
          type="button"
          className="h-8 w-full rounded-md border border-border bg-bg-2 hover:bg-hover"
          onClick={() => void apply(clearComparisonAction())}
        >
          {t("Close reference comparison")}
        </button>
      )}
      {history && (
        <button
          type="button"
          className="h-8 w-full rounded-md border border-border bg-bg-2 hover:bg-hover"
          onClick={() => {
            closeHistoryComparison();
            onClose();
          }}
        >
          {t("Close reference comparison")}
        </button>
      )}
      {error && <p role="alert" className="text-red-400">{error}</p>}
    </div>
  );
}

/** Optional comparison entry in the player toolbar, away from the picture. */
export function ReferenceComparisonControl() {
  const { t } = useTranslation();
  const project = useProjectStore((state) => state.project);
  const [open, setOpen] = useState(false);
  const config = project.referenceComparison;
  const history = useHistoryComparison();

  return (
    <ToolcraftPopover
      placement="above"
      alignment="end"
      label={t("Reference comparison")}
      isOpen={open}
      onOpenChange={setOpen}
      content={<ComparisonSourcePicker onClose={() => setOpen(false)} />}
    >
      <button
        type="button"
        title={t("Reference comparison")}
        aria-label={t("Reference comparison")}
        className={`flex h-[34px] shrink-0 items-center gap-1.5 rounded-[7px] px-2 text-[11px] font-medium transition-colors ${config || history ? "bg-accent-soft text-accent" : "bg-bg-2 text-fg-2 hover:bg-bg-3 hover:text-fg"}`}
      >
        <Columns2 size={16} aria-hidden />
        {t("desktop.editor.compare")}
      </button>
    </ToolcraftPopover>
  );
}

function timeLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00.00";
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${remaining.toFixed(2).padStart(5, "0")}`;
}

/**
 * History sides share the reference comparison's one linear mapping
 * (rate 1, default offsets 0/0 — labelled "aligned by time"). A mapped time
 * at/after the snapshot duration clamps, which the panel renders as the
 * honest no-picture notice instead of freezing on the last frame.
 */
function historyMappingConfig(
  history: HistoryComparisonState,
  frameRate: number,
): ReferenceComparisonConfig {
  return {
    referenceMediaId: history.nodeId,
    refStartSec: history.refStartSec,
    refEndSec: Math.max(history.refStartSec + 1 / frameRate, history.durationSec),
    timelineStartSec: history.timelineStartSec,
    rate: 1,
    audioSide: "timeline",
    layout: history.layout,
  };
}

/**
 * In-player comparison. Two source kinds share the same layouts:
 * - reference media (project state via reference/setComparison): the timeline
 *   frame is mirrored from the canonical preview renderer and the reference
 *   plays in a <video>;
 * - history nodes (UI-local state): the history side is decoded from the
 *   node's immutable snapshot by a HistoryFrameRenderer at the snapshot's own
 *   canvas size; each side scales via object-fit (doc: 不同尺寸按各自画布适配显示).
 * Only the main player owns transport controls.
 */
export const ReferenceComparisonPanel: React.FC<{
  timelineCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  userMuted?: boolean;
  controlsContainer?: HTMLElement | null;
  settingsContainer?: HTMLElement | null;
}> = ({ timelineCanvasRef, userMuted = false, controlsContainer, settingsContainer }) => {
  const { t, i18n } = useTranslation();
  const project = useProjectStore((state) => state.project);
  const executeAction = useProjectStore((state) => state.executeAction);
  const playheadPosition = useTimelineStore((state) => state.playheadPosition);
  const playbackState = useTimelineStore((state) => state.playbackState);
  const playbackRate = useTimelineStore((state) => state.playbackRate);
  const frameRate = project?.settings.frameRate ?? 30;
  const config = project?.referenceComparison ?? null;
  const history = useHistoryComparison();
  const historyMode = history !== null;
  const previewState = useSyncExternalStore(
    previewSession.subscribe,
    previewSession.getSnapshot,
    previewSession.getSnapshot,
  );
  const previewInfo = previewState.active ? previewState.info : null;
  const mediaItems = useMemo(
    () => (project?.mediaLibrary?.items ?? []) as MediaItemLike[],
    [project?.mediaLibrary?.items],
  );
  const videoItems = useMemo(
    () => mediaItems.filter((item) => item.type === "video" && item.metadata.duration > 0),
    [mediaItems],
  );
  const referenceItem = useMemo(
    () => config ? mediaItems.find((item) => item.id === config.referenceMediaId) : undefined,
    [config, mediaItems],
  );

  const [referenceUrl, setReferenceUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [referenceTime, setReferenceTime] = useState(0);
  const [referenceReady, setReferenceReady] = useState(false);
  const [historyFrameState, setHistoryFrameState] = useState<HistoryFrameResult>("frame");
  const mirrorRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const playPendingRef = useRef<HTMLVideoElement | null>(null);
  const historyCanvasRef = useRef<HTMLCanvasElement>(null);
  const mapping = config ? mapTimelineToReference(config, playheadPosition) : null;
  // History sides use the same linear mapping (rate 1) labelled "aligned by
  // time"; clamped means the mapped time is outside the snapshot's duration.
  const historyMapping = history
    ? mapTimelineToReference(historyMappingConfig(history, frameRate), playheadPosition)
    : null;

  useEffect(() => {
    let cancelled = false;
    let ownedUrl: string | null = null;
    setReferenceUrl(null);
    setReferenceReady(false);
    setReferenceTime(0);
    setError(null);
    void resolveReferenceMediaUrl(referenceItem).then((resolved) => {
      if (cancelled) {
        if (resolved.revoke && resolved.url) URL.revokeObjectURL(resolved.url);
        return;
      }
      if (resolved.revoke) ownedUrl = resolved.url;
      setReferenceUrl(resolved.url);
    }).catch(() => {
      if (!cancelled) setError(t("Reference media could not be loaded."));
    });
    return () => {
      cancelled = true;
      if (ownedUrl) URL.revokeObjectURL(ownedUrl);
    };
  }, [config?.referenceMediaId, referenceItem, t]);

  // Exit history compare when the active project changes so an old node is
  // never carried into another project's picture (doc: 项目切换退出原项目对比).
  const activeProjectId = useSyncExternalStore(
    workspaceManager.subscribe,
    () => workspaceManager.getSnapshot().activeProjectId,
  );
  useEffect(() => {
    const active = getHistoryComparisonSnapshot();
    if (active && activeProjectId !== null && active.projectId !== activeProjectId) {
      closeHistoryComparison();
    }
  }, [activeProjectId, history]);

  // Unmount releases history comparison resources (renderer, blob URLs, decoders).
  useEffect(() => () => {
    closeHistoryComparison();
  }, []);

  // Mirror the canonical renderer so comparison and the ordinary player show
  // exactly the same timeline frame without creating another timeline render.
  useEffect(() => {
    if (!config && !historyMode) return;
    let frame = 0;
    const draw = () => {
      const source = timelineCanvasRef.current;
      const mirror = mirrorRef.current;
      if (source && mirror && source.width && source.height) {
        if (mirror.width !== source.width) mirror.width = source.width;
        if (mirror.height !== source.height) mirror.height = source.height;
        const context = mirror.getContext("2d");
        context?.clearRect(0, 0, mirror.width, mirror.height);
        context?.drawImage(source, 0, 0);
      }
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [config, historyMode, timelineCanvasRef]);

  // History side: map the shared playhead onto the snapshot and render at
  // most one frame at a time (throttled to the project frame rate; a paused
  // scrub renders on demand). renderAt reports "no-frame" past the snapshot
  // duration, which surfaces as the honest no-picture notice.
  const historyInFlightRef = useRef(false);
  const historyQueuedRef = useRef<number | null>(null);
  const historyLastKeyRef = useRef("");

  const runHistoryRender = useCallback(async (timeSec: number) => {
    const renderer = history?.renderer;
    if (!renderer) return;
    if (historyInFlightRef.current) {
      historyQueuedRef.current = timeSec;
      return;
    }
    historyInFlightRef.current = true;
    try {
      const canvas = historyCanvasRef.current;
      if (canvas) {
        const result = await renderer.renderAt(timeSec, canvas);
        setHistoryFrameState(result);
      }
    } catch {
      setError(t("versioning.compareSourceMissing"));
    } finally {
      historyInFlightRef.current = false;
      const queued = historyQueuedRef.current;
      historyQueuedRef.current = null;
      if (queued !== null && queued !== timeSec) void runHistoryRender(queued);
    }
  }, [history, t]);

  // Scrub/immediate sync: rerenders whenever the mapped playhead time changes.
  useEffect(() => {
    if (!history) return;
    const mapped = mapTimelineToReference(historyMappingConfig(history, frameRate), playheadPosition);
    const quantized = Math.round(mapped.referenceSec * frameRate) / frameRate;
    // Node id in the key so switching versions always redraws even at the
    // same mapped time; layout too, because switching layouts remounts the
    // canvas and a paused playhead would otherwise leave it blank.
    const key = `${history.nodeId}:${history.layout}:${mapped.clamped}:${quantized.toFixed(4)}:${history.renderer.revision}`;
    if (key === historyLastKeyRef.current) return;
    historyLastKeyRef.current = key;
    void runHistoryRender(quantized);
  }, [history, playheadPosition, frameRate, runHistoryRender]);

  // Playback continuity loop for the history side.
  useEffect(() => {
    if (!history) return;
    let raf = 0;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const state = useTimelineStore.getState();
      const mapped = mapTimelineToReference(historyMappingConfig(history, frameRate), state.playheadPosition);
      const quantized = Math.round(mapped.referenceSec * frameRate) / frameRate;
      const key = `${history.nodeId}:${history.layout}:${mapped.clamped}:${quantized.toFixed(4)}:${history.renderer.revision}`;
      if (key !== historyLastKeyRef.current) {
        historyLastKeyRef.current = key;
        void runHistoryRender(quantized);
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [history, frameRate, runHistoryRender]);

  const syncReference = useCallback(() => {
    const video = videoRef.current;
    if (!video || !config || !Number.isFinite(video.duration) || video.duration <= 0) return;
    const state = useTimelineStore.getState();
    const mapped = mapTimelineToReference(config, state.playheadPosition);
    const target = Math.max(0, Math.min(mapped.referenceSec, config.refEndSec - 1e-4, video.duration - 1e-4));
    const playing = state.playbackState === "playing" && mapped.clamped === "none" && mapped.referenceSec < config.refEndSec;
    const tolerance = playing ? 2 / frameRate : 0.001;
    if (Math.abs(video.currentTime - target) > tolerance) video.currentTime = target;
    setReferenceTime(video.currentTime);
    video.muted = userMuted || config.audioSide !== "reference" || !playing;
    video.playbackRate = state.playbackRate;
    if (playing) {
      if (video.paused && playPendingRef.current !== video) {
        playPendingRef.current = video;
        void video.play().catch(() => {
          if (videoRef.current === video && useTimelineStore.getState().playbackState === "playing") {
            setError(t("Reference playback could not start."));
          }
        }).finally(() => {
          if (playPendingRef.current === video) playPendingRef.current = null;
        });
      }
    } else video.pause();
  }, [config, frameRate, userMuted, t]);

  useEffect(() => {
    syncReference();
  }, [syncReference, playheadPosition, playbackState, playbackRate, referenceUrl]);

  const handleReferenceMetadata = () => {
    setReferenceReady(true);
    syncReference();
  };

  useEffect(() => {
    const video = videoRef.current;
    return () => video?.pause();
  }, [referenceUrl, config?.layout, historyMode]);

  const updateConfig = useCallback((patch: Partial<ReferenceComparisonConfig>) => {
    if (!config) return;
    void executeAction(setComparisonAction({ ...config, ...patch })).then((result) => {
      setError(result.success ? null : result.error?.message ?? t("Could not update comparison."));
    });
  }, [config, executeAction, t]);

  const selectReference = useCallback((mediaId: string) => {
    const media = videoItems.find((item) => item.id === mediaId);
    if (!media) return;
    // Picking a reference media leaves any active history comparison.
    closeHistoryComparison();
    void executeAction(selectComparisonAction(media, config?.layout)).then((result) => {
      setError(result.success ? null : result.error?.message ?? t("Could not configure comparison."));
    });
  }, [config?.layout, executeAction, t, videoItems]);

  const alignCurrentFrame = useCallback(() => {
    if (!config || !videoRef.current || !Number.isFinite(videoRef.current.currentTime)) return;
    const duration = Number.isFinite(videoRef.current.duration)
      ? videoRef.current.duration
      : referenceItem?.metadata.duration ?? config.refEndSec;
    const alignedReferenceTime = Math.max(0, Math.min(videoRef.current.currentTime, duration - 1 / frameRate));
    updateConfig({
      refStartSec: alignedReferenceTime,
      refEndSec: Math.max(config.refEndSec, alignedReferenceTime + 1 / frameRate),
      timelineStartSec: playheadPosition,
    });
  }, [config, frameRate, playheadPosition, referenceItem?.metadata.duration, updateConfig]);

  const clearComparison = useCallback(() => {
    void executeAction(clearComparisonAction()).then((result) => {
      setError(result.success ? null : result.error?.message ?? t("Could not clear comparison."));
      setAdvancedOpen(false);
    });
  }, [executeAction, t]);

  const closeActiveComparison = useCallback(() => {
    if (historyMode) {
      closeHistoryComparison();
      setAdvancedOpen(false);
    } else {
      clearComparison();
    }
  }, [clearComparison, historyMode]);

  const handleReferenceError = useCallback(() => {
    setReferenceReady(false);
    setError(t("Reference media could not be loaded."));
  }, [t]);

  const handleReferenceScrub = (value: number) => {
    const video = videoRef.current;
    if (!video || playbackState === "playing") return;
    video.currentTime = value;
    setReferenceTime(value);
  };

  if (!historyMode && !config) return null;

  const isOverlay = historyMode ? history!.layout === "overlay" : config!.layout === "overlay";
  const canAlign = Boolean(referenceReady && referenceUrl && videoRef.current && Number.isFinite(videoRef.current.duration));

  const versionSideLabel = (name: string, createdAt: number | null): string =>
    createdAt !== null && createdAt > 0
      ? t("versioning.compareVersionSide", {
          name,
          time: formatVersionTimestamp(createdAt, i18n.language),
        })
      : name;
  // In read-only preview the watched node is one side and must be labelled as
  // a version — never as "current editing" (doc: 不能把它称为“当前编辑”).
  const previewingNode = previewInfo?.nodeName ? previewInfo : null;
  const currentSideLabel = previewingNode
    ? versionSideLabel(previewingNode.nodeName, previewingNode.createdAt)
    : t("versioning.compareCurrentSide");
  const historySideLabel = history
    ? versionSideLabel(history.name, history.createdAt)
    : "";
  const historyNoFrame = historyFrameState === "no-frame";
  const audibleSideLabel = previewingNode
    ? previewingNode.nodeName
    : t("versioning.compareCurrentSide");

  const changeSource = (value: string) => {
    if (history && value === history.nodeId) return;
    const media = videoItems.find((item) => item.id === value);
    if (media) selectReference(media.id);
  };

  const renderComparisonSurface = (side: "history" | "current") =>
    side === "history" ? (
      <canvas
        ref={historyCanvasRef}
        aria-label={historySideLabel}
        className={isOverlay ? "absolute inset-0 h-full w-full object-contain" : "h-full w-full object-contain"}
        style={isOverlay ? { opacity: history!.overlayOpacity, pointerEvents: "none" } : undefined}
      />
    ) : (
      <canvas
        ref={mirrorRef}
        aria-label={currentSideLabel}
        className={isOverlay ? "absolute inset-0 h-full w-full object-contain" : "h-full w-full object-contain"}
      />
    );

  const advancedContent = historyMode ? (
        <div data-testid="comparison-settings" className="w-full rounded-md border border-border bg-bg-elev p-3 text-[11px] text-fg">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span>{t("versioning.compareTimeAligned")}</span>
            <output>{timeLabel(historyMapping?.referenceSec ?? 0)}</output>
          </div>
          <label className="mb-2 flex items-center justify-between gap-2">
            <span>{t("Timeline start")}</span>
            <input
              aria-label={t("Timeline start")}
              type="number"
              min={0}
              step={1 / frameRate}
              key={`history-timeline-start-${history!.timelineStartSec}`}
              defaultValue={history!.timelineStartSec}
              onBlur={(event) => {
                const value = Number(event.currentTarget.value);
                if (Number.isFinite(value) && value !== history!.timelineStartSec) {
                  updateHistoryComparison({ timelineStartSec: Math.max(0, value) });
                }
              }}
              className="w-24 rounded bg-white/10 px-1.5 py-1 text-right text-white"
            />
          </label>
          <label className="mb-2 flex items-center justify-between gap-2">
            <span>{t("Reference position")}</span>
            <input
              aria-label={t("Reference position")}
              type="number"
              min={0}
              step={1 / frameRate}
              key={`history-ref-start-${history!.refStartSec}`}
              defaultValue={history!.refStartSec}
              onBlur={(event) => {
                const value = Number(event.currentTarget.value);
                if (Number.isFinite(value) && value !== history!.refStartSec) {
                  updateHistoryComparison({ refStartSec: Math.max(0, value) });
                }
              }}
              className="w-24 rounded bg-white/10 px-1.5 py-1 text-right text-white"
            />
          </label>
          {isOverlay && (
            <label className="mb-2 flex items-center gap-2">
              <span className="shrink-0">{t("Overlay opacity")}</span>
              <input
                aria-label={t("Overlay opacity")}
                type="range"
                min={0.05}
                max={1}
                step={0.05}
                value={history!.overlayOpacity}
                onChange={(event) => updateHistoryComparison({ overlayOpacity: Number(event.target.value) })}
                className="flex-1 accent-emerald-500"
              />
            </label>
          )}
          <fieldset>
            <legend className="mb-1">{t("Audio source")}</legend>
            {/* The history side is a silent canvas render, so exactly one side
                can ever be audible — the current (or previewed) node. */}
            <span
              aria-label={`${t("Audio source")}: ${audibleSideLabel}`}
              className="inline-block rounded bg-emerald-700 px-2 py-1"
            >{audibleSideLabel}</span>
          </fieldset>
          {historyMapping?.clamped !== "none" && (
            <p className="mt-2 text-amber-300">{t("versioning.compareNoFrame")}</p>
          )}
        </div>
      ) : (
        <div data-testid="comparison-settings" className="w-full rounded-md border border-border bg-bg-elev p-3 text-[11px] text-fg">
          <div className="mb-1 flex items-center justify-between gap-2">
            <label htmlFor="reference-position">{t("Reference position")}</label>
            <output>{timeLabel(referenceTime)}</output>
          </div>
          <input
            id="reference-position"
            aria-label={t("Reference position")}
            type="range"
            min={0}
            max={referenceItem?.metadata.duration ?? config!.refEndSec}
            step={1 / frameRate}
            value={Math.min(referenceTime, referenceItem?.metadata.duration ?? config!.refEndSec)}
            disabled={playbackState === "playing" || !referenceUrl}
            onChange={(event) => handleReferenceScrub(Number(event.target.value))}
            className="mb-2 w-full accent-emerald-500"
          />
          <button
            type="button"
            disabled={!canAlign || playbackState === "playing"}
            onClick={alignCurrentFrame}
            className="mb-2 w-full rounded bg-emerald-700 px-2 py-1.5 font-medium disabled:opacity-50"
          >{t("Align this reference frame to the timeline playhead")}</button>
          <label className="mb-2 flex items-center justify-between gap-2">
            <span>{t("Reference end")}</span>
            <input
              aria-label={t("Reference end")}
              type="number"
              min={config!.refStartSec + 1 / frameRate}
              max={referenceItem?.metadata.duration}
              step={1 / frameRate}
              key={`reference-end-${config!.refEndSec}`}
              defaultValue={config!.refEndSec}
              onBlur={(event) => {
                const value = Number(event.currentTarget.value);
                if (Number.isFinite(value) && value !== config!.refEndSec) updateConfig({ refEndSec: value });
              }}
              className="w-24 rounded bg-white/10 px-1.5 py-1 text-right text-white"
            />
          </label>
          <label className="mb-2 flex items-center justify-between gap-2">
            <span>{t("Timeline start")}</span>
            <input
              aria-label={t("Timeline start")}
              type="number"
              min={0}
              step={1 / frameRate}
              key={`timeline-start-${config!.timelineStartSec}`}
              defaultValue={config!.timelineStartSec}
              onBlur={(event) => {
                const value = Number(event.currentTarget.value);
                if (Number.isFinite(value) && value !== config!.timelineStartSec) updateConfig({ timelineStartSec: Math.max(0, value) });
              }}
              className="w-24 rounded bg-white/10 px-1.5 py-1 text-right text-white"
            />
          </label>
          {isOverlay && (
            <label className="mb-2 flex items-center gap-2">
              <span className="shrink-0">{t("Overlay opacity")}</span>
              <input
                aria-label={t("Overlay opacity")}
                type="range"
                min={0.05}
                max={1}
                step={0.05}
                value={config!.overlayOpacity ?? 0.5}
                onChange={(event) => updateConfig({ overlayOpacity: Number(event.target.value) })}
                className="flex-1 accent-emerald-500"
              />
            </label>
          )}
          <fieldset>
            <legend className="mb-1">{t("Audio source")}</legend>
            <div className="flex gap-1">
              {([
                ["timeline", t("Timeline audio")],
                ["reference", t("Reference audio")],
                ["none", t("Mute all")],
              ] as const).map(([side, label]) => (
                <button
                  key={side}
                  type="button"
                  aria-pressed={config!.audioSide === side}
                  onClick={() => updateConfig({ audioSide: side })}
                  className="flex-1 rounded bg-white/10 px-1.5 py-1 hover:bg-white/20 aria-pressed:bg-emerald-700"
                >{label}</button>
              ))}
            </div>
          </fieldset>
          {mapping?.clamped !== "none" && (
            <p className="mt-2 text-amber-300">{t("Reference playback is outside the mapped range.")}</p>
          )}
        </div>
      );

  const alignmentLabel = historyMode
    ? t("versioning.compareTimeAligned")
    : t("Reference {{reference}} ↔ Timeline {{timeline}}", {
        reference: timeLabel(config!.refStartSec),
        timeline: timeLabel(config!.timelineStartSec),
      });

  const controls = (
      <div data-testid="comparison-controls" className="border-b border-border bg-bg-2 px-2 py-1.5 text-[11px] text-fg">
        <div className="flex min-w-0 items-center gap-1.5">
        <label className="sr-only" htmlFor="reference-comparison-media">{t("Choose reference video")}</label>
        <select
          id="reference-comparison-media"
          aria-label={historyMode ? t("versioning.compareHistory") : t("Choose reference video")}
          value={historyMode ? history!.nodeId : config!.referenceMediaId}
          className="w-28 min-w-0 shrink-0 bg-transparent text-fg outline-none"
          onChange={(event) => changeSource(event.target.value)}
        >
          {historyMode && history && (
            <option value={history.nodeId} className="text-black">
              {`${history.name} · ${formatVersionTimestamp(history.createdAt, i18n.language)}`}
            </option>
          )}
          {videoItems.map((item) => (
            <option key={item.id} value={item.id} className="text-black">{item.name ?? item.id}</option>
          ))}
        </select>
        <span title={alignmentLabel} className="min-w-0 flex-1 truncate text-fg-muted">{alignmentLabel}</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            aria-label={t("Side by side")}
            title={t("Side by side")}
            aria-pressed={!isOverlay}
            onClick={() => (historyMode ? updateHistoryComparison({ layout: "side-by-side" }) : updateConfig({ layout: "side-by-side" }))}
            className="flex h-7 w-7 items-center justify-center rounded hover:bg-hover aria-pressed:bg-emerald-700 aria-pressed:text-white"
          ><Columns2 size={16} aria-hidden /></button>
          <button
            type="button"
            aria-label={t("Overlay comparison")}
            title={t("Overlay comparison")}
            aria-pressed={isOverlay}
            onClick={() => (historyMode ? updateHistoryComparison({ layout: "overlay" }) : updateConfig({ layout: "overlay" }))}
            className="flex h-7 w-7 items-center justify-center rounded hover:bg-hover aria-pressed:bg-emerald-700 aria-pressed:text-white"
          ><Layers size={16} aria-hidden /></button>
          <button
            type="button"
            aria-label={t("Advanced")}
            title={t("Advanced")}
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((open) => !open)}
            className="flex h-7 w-7 items-center justify-center rounded hover:bg-hover"
          ><Settings2 size={16} aria-hidden /></button>
          <button
            type="button"
            aria-label={t("Close reference comparison")}
            title={t("Close reference comparison")}
            onClick={closeActiveComparison}
            className="flex h-7 w-7 items-center justify-center rounded text-fg-muted hover:bg-hover hover:text-fg"
          >×</button>
        </div>
        </div>

        {!historyMode && mapping?.clamped !== "none" && (
          <p role="status" className="w-full text-amber-300">
            {mapping?.clamped === "before"
              ? t("Reference playback has not reached the aligned start.")
              : t("Reference playback has reached the aligned end.")}
          </p>
        )}
        {error && <p role="alert" className="w-full text-red-300">{error}</p>}
      </div>
  );

  return (
    <>
      {controlsContainer === undefined ? controls : controlsContainer ? createPortal(controls, controlsContainer) : null}
      {advancedOpen && (settingsContainer === undefined ? advancedContent : settingsContainer ? createPortal(advancedContent, settingsContainer) : null)}
    <div
      data-testid="reference-comparison-viewport"
      data-reference-comparison="active"
      className="absolute inset-0 z-40 overflow-hidden rounded-[inherit] bg-black"
      onClick={(event) => event.stopPropagation()}
      onMouseMove={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        // Esc inside the comparison surface releases its resources.
        if (event.key === "Escape" && historyMode) {
          event.stopPropagation();
          closeActiveComparison();
        }
      }}
    >
      {historyMode ? (
        isOverlay ? (
          <div className="absolute inset-0" data-testid="comparison-surfaces">
            {renderComparisonSurface("current")}
            {renderComparisonSurface("history")}
            {historyNoFrame && (
              <div role="status" data-testid="history-no-frame" className="absolute inset-0 grid place-content-center px-4 text-center text-sm text-white">
                {t("versioning.compareNoFrame")}
              </div>
            )}
            <span className="absolute bottom-2 left-2 rounded bg-black/65 px-2 py-1 text-[10px] text-white">{historySideLabel}</span>
            <span className="absolute bottom-2 right-2 rounded bg-black/65 px-2 py-1 text-[10px] text-white">{currentSideLabel}</span>
          </div>
        ) : (
          <div className="absolute inset-0 flex" data-testid="comparison-surfaces">
            <div className="relative min-w-0 flex-1 bg-black">
              {renderComparisonSurface("history")}
              {historyNoFrame && (
                <div role="status" data-testid="history-no-frame" className="absolute inset-0 grid place-content-center px-4 text-center text-sm text-white">
                  {t("versioning.compareNoFrame")}
                </div>
              )}
              <span className="absolute bottom-2 left-2 rounded bg-black/65 px-2 py-1 text-[10px] text-white">{historySideLabel}</span>
            </div>
            <div className="relative min-w-0 flex-1 bg-black">
              {renderComparisonSurface("current")}
              <span className="absolute bottom-2 right-2 rounded bg-black/65 px-2 py-1 text-[10px] text-white">{currentSideLabel}</span>
            </div>
          </div>
        )
      ) : !referenceUrl ? (
        <div role="status" className="absolute inset-0 grid place-content-center gap-2 bg-[#39100d] text-center text-white">
          <strong>{t("Reference media is unavailable")}</strong>
          <span className="text-sm">{t("Restore the file or choose another reference video.")}</span>
        </div>
      ) : isOverlay ? (
        <div className="absolute inset-0" data-testid="comparison-surfaces">
          <canvas
            ref={mirrorRef}
            aria-label={t("Timeline video")}
            className="absolute inset-0 h-full w-full object-contain"
          />
          <video
            ref={videoRef}
            src={referenceUrl}
            muted={userMuted || config!.audioSide !== "reference"}
            onLoadedMetadata={handleReferenceMetadata}
            onTimeUpdate={(event) => setReferenceTime(event.currentTarget.currentTime)}
            onError={handleReferenceError}
            aria-label={t("Reference video")}
            playsInline
            preload="auto"
            className="absolute inset-0 h-full w-full object-contain"
            style={{ opacity: config!.overlayOpacity ?? 0.5, pointerEvents: "none" }}
          />
          <span className="absolute bottom-2 left-2 rounded bg-black/65 px-2 py-1 text-[10px] text-white">{t("Timeline")}</span>
        </div>
      ) : (
        <div className="absolute inset-0 flex" data-testid="comparison-surfaces">
          <div className="relative min-w-0 flex-1 bg-black">
            <video
              ref={videoRef}
              src={referenceUrl}
              muted={userMuted || config!.audioSide !== "reference"}
              onLoadedMetadata={handleReferenceMetadata}
              onTimeUpdate={(event) => setReferenceTime(event.currentTarget.currentTime)}
              onError={handleReferenceError}
              aria-label={t("Reference video")}
              playsInline
              preload="auto"
              className="h-full w-full object-contain"
            />
            <span className="absolute bottom-2 left-2 rounded bg-black/65 px-2 py-1 text-[10px] text-white">{t("Reference")}</span>
          </div>
          <div className="relative min-w-0 flex-1 bg-black">
            <canvas
              ref={mirrorRef}
              aria-label={t("Timeline video")}
              className="h-full w-full object-contain"
            />
            <span className="absolute bottom-2 right-2 rounded bg-black/65 px-2 py-1 text-[10px] text-white">{t("Timeline")}</span>
          </div>
        </div>
      )}

    </div>
    </>
  );
};
