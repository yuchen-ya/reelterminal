/**
 * Image review workspace for the AI material workbench.
 *
 * Migrated from the prototype ImageViewerWorkspace with the prototype's view
 * structure preserved (grid / zoom review, pinned reference compare, grouped
 * tools, numbered annotations, per-stroke undo).
 */
import type {
  JSX,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Pin,
  X,
  ImageOff,
} from "lucide-react";
import type {
  WorkbenchPixelStroke,
  WorkbenchRepairBase,
  WorkbenchSpatialAnnotation,
} from "@reelterminal/core";
import type {
  ImageDisplayMode,
  SelectModifiers,
  WorkbenchController,
  WorkbenchItemView,
  WorkbenchMutationResult,
} from "../types";
import {
  WorkbenchIssuePanel,
  type WorkbenchIssueEntry,
  type WorkbenchIssueSaveInput,
} from "./WorkbenchIssuePanel";
import {
  annotationCoordinateLabel,
  clamp,
  drawStrokeOnContext,
  readAccentColor,
  EMPTY_ANNOTATIONS,
  EMPTY_STROKES,
  type AnnotateTool,
  type CanvasWorkMode,
  type RepairTool,
} from "./image/image-canvas-utils";
import { ImageViewerToolbar } from "./image/ImageViewerToolbar";
import { ImageStage } from "./image/ImageStage";
import { useImagePointerInteractions } from "./image/useImagePointerInteractions";

export interface ImageViewerWorkspaceProps {
  readonly currentItem: WorkbenchItemView;
  /** All image items of the batch (grid cards + pinned reference compare). */
  readonly batchImageItems: readonly WorkbenchItemView[];
  readonly hideCollectionNavigation?: boolean;
  readonly onOpenCollection?: () => void;
  readonly selectedIds: readonly string[];
  readonly onSelectItem: (itemId: string, modifiers?: SelectModifiers) => void;
  readonly onUpdateImageAnnotations: WorkbenchController["updateImageAnnotations"];
  readonly onSaveImageRepair: WorkbenchController["saveImageRepair"];
  /** Card-level quick decisions (prototype grid footer). */
  readonly onCommitDecision: WorkbenchController["commitDecision"];
  /** Width of the restored issue panel; owned by the page's layout state. */
  readonly issuePanelWidth: number;
  readonly onStartResizeIssuePanel?: (event: ReactPointerEvent) => void;
}

interface RepairDraftCache {
  readonly strokes: WorkbenchPixelStroke[];
}

export function ImageViewerWorkspace({
  currentItem,
  batchImageItems,
  onOpenCollection,
  hideCollectionNavigation = false,
  onUpdateImageAnnotations,
  onSaveImageRepair,
  issuePanelWidth,
  onStartResizeIssuePanel,
}: ImageViewerWorkspaceProps): JSX.Element {
  const viewMode = "zoom" as const;
  const [pinnedRefId, setPinnedRefId] = useState<string | null>(null);
  const [showCompareSplit, setShowCompareSplit] = useState<boolean>(false);

  const [workMode, setWorkMode] = useState<CanvasWorkMode>("annotate");
  const [repairTool, setRepairTool] = useState<RepairTool>("brush");
  const [annotateTool, setAnnotateTool] = useState<AnnotateTool>("box");
  const [brushColor, setBrushColor] = useState<string>(() => readAccentColor());

  const [zoom, setZoom] = useState<number>(100);
  const [loupeEnabled, setLoupeEnabled] = useState<boolean>(false);
  const [holdOriginal, setHoldOriginal] = useState<boolean>(false);

  const [decodedImage, setDecodedImage] = useState<{ url: string; w: number; h: number } | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [areaSize, setAreaSize] = useState<{ readonly w: number; readonly h: number }>({
    w: 0,
    h: 0,
  });

  const [savingRepair, setSavingRepair] = useState<boolean>(false);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);

  /** Repair drafts keyed by `${itemId}:${version}` — never cross item drafts. */
  const [draftsByItemVersion, setDraftsByItemVersion] = useState<
    Record<string, RepairDraftCache>
  >({});

  const imgRef = useRef<HTMLImageElement | null>(null);
  const repairCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const areaRef = useRef<HTMLDivElement | null>(null);
  const idSeqRef = useRef<number>(0);

  const payload = currentItem.imagePayload;
  const originalMedia = payload?.originalMedia;
  const repairedMedia = payload?.repairMedia;
  const repair = payload?.repair;
  const annotations = payload?.annotations ?? EMPTY_ANNOTATIONS;

  const [displayMode, setDisplayMode] = useState<ImageDisplayMode>(
    payload?.initialDisplayMode ?? "original",
  );
  const [repairBase, setRepairBase] = useState<"latest" | "source">("latest");
  const [repairNotice, setRepairNotice] = useState<string | null>(null);

  const repairReady =
    repairedMedia?.status === "ready" && Boolean(repairedMedia.url);
  const usingRepair =
    workMode === "repair"
      ? repairBase === "latest" && Boolean(repair) && repairReady
      : displayMode === "repaired" && !holdOriginal && repairReady;
  const activeMedia = usingRepair ? repairedMedia : originalMedia;
  const activeUrl = activeMedia?.url ?? null;
  // Bind decode state to its source. A passive reset on URL changes can run
  // after a cached image's load event and leave it hidden forever.
  const natural = decodedImage?.url === activeUrl ? decodedImage : null;
  const imgError = activeUrl !== null && failedUrl === activeUrl;

  const draftKey = `${currentItem.id}:${currentItem.version}`;
  const draftStrokes = draftsByItemVersion[draftKey]?.strokes ?? EMPTY_STROKES;

  const pinnedRefItem =
    batchImageItems.find((item) => item.id === pinnedRefId) ?? null;


  const canDraw =
    viewMode === "zoom" &&
    payload !== undefined &&
    activeMedia !== undefined &&
    activeMedia.status === "ready" &&
    activeUrl !== null &&
    !imgError &&
    natural !== null;

  const nextId = (prefix: string): string => {
    idSeqRef.current += 1;
    return `${prefix}_${Date.now().toString(36)}_${idSeqRef.current}`;
  };

  // Reset transient state on item/version switch; drafts live in the keyed cache.
  useEffect(() => {
    setSelectedAnnotationId(null);
    setMutationError(null);
    setDisplayMode(payload?.initialDisplayMode ?? "original");
    setRepairBase("latest");
    setRepairNotice(null);
  }, [currentItem.id, currentItem.version, payload?.initialDisplayMode]);

  // A missing/broken saved repair must not masquerade as the editing base.
  useEffect(() => {
    if (repair && repairedMedia?.status === "error") {
      setRepairBase("source");
      setRepairNotice("已保存修补结果不可用，已切到原图底图");
    }
  }, [repair, repairedMedia?.status]);

  const measureArea = useCallback((): void => {
    const el = areaRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setAreaSize((prev) =>
        prev.w === rect.width && prev.h === rect.height
          ? prev
          : { w: rect.width, h: rect.height },
      );
    }
  }, []);

  useEffect(() => {
    measureArea();
    const el = areaRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 0 && rect.height > 0) {
        setAreaSize({ w: rect.width, h: rect.height });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [measureArea, viewMode, showCompareSplit, pinnedRefId]);

  const redrawRepairCanvas = useCallback((): void => {
    const canvas = repairCanvasRef.current;
    if (!canvas || !natural) return;
    if (canvas.width !== natural.w) canvas.width = natural.w;
    if (canvas.height !== natural.h) canvas.height = natural.h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const stroke of draftStrokes) drawStrokeOnContext(ctx, stroke);
  }, [natural, draftStrokes]);

  useEffect(() => {
    if (workMode === "repair") redrawRepairCanvas();
  }, [workMode, redrawRepairCanvas]);

  const display = useMemo(() => {
    if (!natural || areaSize.w <= 0 || areaSize.h <= 0) return null;
    const scale = Math.min(areaSize.w / natural.w, areaSize.h / natural.h);
    return {
      w: Math.max(1, Math.floor(natural.w * scale)),
      h: Math.max(1, Math.floor(natural.h * scale)),
    };
  }, [natural, areaSize]);

  const commitAnnotations = useCallback(
    async (
      next: readonly WorkbenchSpatialAnnotation[],
      selectId?: string,
    ): Promise<void> => {
      const result = await onUpdateImageAnnotations(
        currentItem.id,
        next,
        undefined,
        currentItem.version,
      );
      if (!result.ok) {
        setMutationError(result.message);
        return;
      }
      setMutationError(null);
      if (selectId) setSelectedAnnotationId(selectId);
    },
    [onUpdateImageAnnotations, currentItem.id, currentItem.version],
  );

  const renderPatchedImage = useCallback(async (): Promise<Blob | null> => {
    const img = imgRef.current;
    const repairCanvas = repairCanvasRef.current;
    if (
      !img ||
      !img.complete ||
      !img.naturalWidth ||
      !img.naturalHeight ||
      !repairCanvas ||
      repairCanvas.width <= 0 ||
      repairCanvas.height <= 0
    ) {
      return null;
    }
    const out = document.createElement("canvas");
    out.width = repairCanvas.width;
    out.height = repairCanvas.height;
    const ctx = out.getContext("2d");
    if (!ctx) return null;
    try {
      ctx.drawImage(img, 0, 0, out.width, out.height);
      ctx.drawImage(repairCanvas, 0, 0);
      return await new Promise<Blob | null>((resolve) => {
        out.toBlob((blob) => resolve(blob), "image/png");
      });
    } catch {
      return null;
    }
  }, []);

  const handleSaveRepair = useCallback(async (): Promise<void> => {
    if (draftStrokes.length === 0) return;
    if (repairBase === "latest" && repair && !repairReady) {
      setMutationError("已保存修补结果不可用，请切换为“从原图重新修补”后再保存");
      return;
    }
    const base: WorkbenchRepairBase =
      repairBase === "latest" && repair
        ? { kind: "revision", revisionId: repair.revisionId }
        : { kind: "source" };
    setSavingRepair(true);
    try {
      const result = await onSaveImageRepair(
        currentItem.id,
        [...draftStrokes],
        renderPatchedImage,
        base,
      );
      if (!result.ok) {
        setMutationError(result.message);
        return;
      }
      setMutationError(null);
      setRepairNotice(
        base.kind === "source"
          ? "已从原图生成新修补版本"
          : "已在已保存修补上生成新版本",
      );
      setDisplayMode("repaired");
      setDraftsByItemVersion((prev) => {
        const next = { ...prev };
        delete next[draftKey];
        return next;
      });
    } finally {
      setSavingRepair(false);
    }
  }, [
    onSaveImageRepair,
    currentItem.id,
    draftStrokes,
    renderPatchedImage,
    draftKey,
    repairBase,
    repair,
    repairReady,
  ]);

  const handleUndoStroke = (): void => {
    if (draftStrokes.length === 0) return;
    setDraftsByItemVersion((prev) => ({
      ...prev,
      [draftKey]: { strokes: (prev[draftKey]?.strokes ?? EMPTY_STROKES).slice(0, -1) },
    }));
  };

  const onStrokeFinished = useCallback(
    (finished: WorkbenchPixelStroke) => {
      setDraftsByItemVersion((prev) => ({
        ...prev,
        [draftKey]: {
          strokes: [...(prev[draftKey]?.strokes ?? EMPTY_STROKES), finished],
        },
      }));
    },
    [draftKey],
  );

  const {
    pan,
    setPan,
    draftStart,
    draftCurrent,
    handleStagePointerDown,
    handleStagePointerMove,
    handleStagePointerUp,
    handleStagePointerCancel,
  } = useImagePointerInteractions({
    canDraw,
    workMode,
    repairTool,
    annotateTool,
    brushColor,
    stageRef,
    imgRef,
    repairCanvasRef,
    natural,
    annotations,
    setBrushColor,
    setRepairTool,
    setSelectedAnnotationId,
    commitAnnotations,
    onStrokeFinished,
    redrawRepairCanvas,
    setMutationError,
    nextId,
  });

  const handleClearAnnotations = async (): Promise<void> => {
    if (annotations.length === 0) return;
    setSelectedAnnotationId(null);
    await commitAnnotations(EMPTY_ANNOTATIONS);
  };

  const issueEntries = useMemo<readonly WorkbenchIssueEntry[]>(
    () =>
      annotations.map((ann, index) => ({
        id: ann.id,
        kind: "annotation" as const,
        indexNumber: index + 1,
        coordinateLabel: annotationCoordinateLabel(ann, natural),
        note: ann.label ?? "",
        version: currentItem.version,
        color: ann.color,
        tool: ann.tool,
        ...(ann.ptsSec !== undefined
          ? { ptsLabel: `PTS ${ann.ptsSec.toFixed(3)}s` }
          : {}),
      })),
    [annotations, currentItem.version, natural],
  );

  const handleSaveIssue = useCallback(
    async (
      issueId: string,
      input: WorkbenchIssueSaveInput,
    ): Promise<WorkbenchMutationResult> => {
      const annotation = annotations.find((ann) => ann.id === issueId);
      if (!annotation) {
        return { ok: false, code: "NOT_FOUND", message: "圈注不存在" };
      }
      const next = annotations.map((ann) =>
        ann.id === issueId ? { ...ann, label: input.text } : ann,
      );
      const target = {
        kind: "pixel-region" as const,
        annotationId: annotation.id,
        x: annotation.x,
        y: annotation.y,
        ...(annotation.w !== undefined ? { w: annotation.w } : {}),
        ...(annotation.h !== undefined ? { h: annotation.h } : {}),
        ...(payload?.naturalWidth !== undefined
          ? { naturalWidth: payload.naturalWidth }
          : {}),
        ...(payload?.naturalHeight !== undefined
          ? { naturalHeight: payload.naturalHeight }
          : {}),
      };
      const result = await onUpdateImageAnnotations(
        currentItem.id,
        next,
        {
          text: input.text,
          referencedTagIds: input.referencedTagIds,
          markRework: input.markRework,
          state: "confirmed",
          target,
        },
        currentItem.version,
      );
      if (!result.ok) {
        setMutationError(result.message);
        return result;
      }
      setMutationError(null);
      setSelectedAnnotationId(issueId);
      return result;
    },
    [annotations, currentItem.id, currentItem.version, onUpdateImageAnnotations, payload],
  );

  const handleDeleteIssue = useCallback(
    async (issueId: string): Promise<WorkbenchMutationResult> => {
      const remaining = annotations.filter((ann) => ann.id !== issueId);
      if (remaining.length === annotations.length) {
        return { ok: false, code: "NOT_FOUND", message: "圈注不存在" };
      }
      const result = await onUpdateImageAnnotations(
        currentItem.id,
        remaining,
        undefined,
        currentItem.version,
      );
      if (!result.ok) {
        setMutationError(result.message);
        return result;
      }
      setMutationError(null);
      const deletedIndex = annotations.findIndex(annotation => annotation.id === issueId);
      setSelectedAnnotationId(current => current === issueId
        ? remaining[Math.min(deletedIndex, remaining.length - 1)]?.id ?? null
        : current);
      return result;
    },
    [annotations, currentItem.id, currentItem.version, onUpdateImageAnnotations, selectedAnnotationId],
  );

  const stepZoom = (delta: number): void => {
    setZoom((prev) => clamp(prev + delta, 20, 500));
  };

  const resetZoom = (): void => {
    setZoom(100);
    setPan({ x: 0, y: 0 });
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>): void => {
    const delta = e.deltaY < 0 ? 20 : -20;
    stepZoom(delta);
  };

  const dimensionLabel = natural
    ? `${natural.w} × ${natural.h}`
    : payload?.naturalWidth && payload?.naturalHeight
      ? `${payload.naturalWidth} × ${payload.naturalHeight}`
      : "—";

  const stageCursorClass =
    workMode === "navigate"
      ? "cursor-grab active:cursor-grabbing"
      : workMode === "repair"
        ? repairTool === "eyedropper"
          ? "cursor-crosshair"
          : "cursor-crosshair"
        : "cursor-crosshair";

  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>): void => {
    const width = e.currentTarget.naturalWidth;
    const height = e.currentTarget.naturalHeight;
    if (
      usingRepair &&
      payload?.naturalWidth &&
      payload?.naturalHeight &&
      (width !== payload.naturalWidth || height !== payload.naturalHeight)
    ) {
      setDisplayMode("original");
      setRepairBase("source");
      setRepairNotice("修补结果尺寸与源图不一致，已回退原图");
      return;
    }
    setDecodedImage({ url: e.currentTarget.src, w: width, h: height });
    setFailedUrl(null);
    measureArea();
  };

  const handleImageError = (): void => {
    if (usingRepair) {
      setDisplayMode("original");
      setRepairNotice("修补结果不可用，已回退原图");
      return;
    }
    setFailedUrl(activeUrl);
  };

  const compareSourceUrl = (() => {
    if (!pinnedRefItem) return null;
    if (
      pinnedRefItem.id === currentItem.id &&
      originalMedia?.status === "ready" &&
      originalMedia.url
    ) {
      return originalMedia.url;
    }
    return pinnedRefItem.imagePayload?.originalMedia.thumbnailUrl ?? null;
  })();

  const renderCanvasArea = (): JSX.Element => (
    <div
      className={`relative min-w-0 overflow-hidden ${
        showCompareSplit && pinnedRefItem ? "" : "flex-1"
      }`}
    >
      <div className="sr-only">
        {dimensionLabel}
      </div>
      <div ref={areaRef} className="absolute inset-0 flex items-center justify-center">
        <ImageStage
          stageRef={stageRef}
          imgRef={imgRef}
          repairCanvasRef={repairCanvasRef}
          activeMedia={activeMedia}
          payload={payload}
          activeUrl={activeUrl}
          imgError={imgError}
          currentItemTitle={currentItem.title}
          usingRepair={usingRepair}
          natural={natural}
          display={display}
          zoom={zoom}
          pan={pan}
          loupeEnabled={loupeEnabled}
          workMode={workMode}
          stageCursorClass={stageCursorClass}
          holdOriginal={holdOriginal}
          annotations={annotations}
          selectedAnnotationId={selectedAnnotationId}
          annotateTool={annotateTool}
          draftStart={draftStart}
          draftCurrent={draftCurrent}
          onImageLoad={handleImageLoad}
          onImageError={handleImageError}
          onStagePointerDown={handleStagePointerDown}
          onStagePointerMove={handleStagePointerMove}
          onDeleteSelected={workMode === "annotate" && selectedAnnotationId ? () => { void handleDeleteIssue(selectedAnnotationId); } : undefined}
          onStagePointerUp={handleStagePointerUp}
          onStagePointerCancel={handleStagePointerCancel}
          onWheel={handleWheel}
        />
      </div>
    </div>
  );

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg">
      <ImageViewerToolbar
        hideCollectionNavigation={hideCollectionNavigation}
        viewMode={viewMode}
        setViewMode={mode => { if (mode === "grid") onOpenCollection?.(); }}
        batchImageItemsCount={batchImageItems.length}
        showCompareSplit={showCompareSplit}
        setShowCompareSplit={setShowCompareSplit}
        pinnedRefId={pinnedRefId}
        setPinnedRefId={setPinnedRefId}
        currentItemId={currentItem.id}
        workMode={workMode}
        setWorkMode={setWorkMode}
        annotationsCount={annotations.length}
        draftStrokesCount={draftStrokes.length}
        annotateTool={annotateTool}
        setAnnotateTool={setAnnotateTool}
        onClearAnnotations={handleClearAnnotations}
        repair={repair}
        repairBase={repairBase}
        setRepairBase={setRepairBase}
        repairTool={repairTool}
        setRepairTool={setRepairTool}
        brushColor={brushColor}
        setBrushColor={setBrushColor}
        onUndoStroke={handleUndoStroke}
        onSaveRepair={handleSaveRepair}
        savingRepair={savingRepair}
        repairReady={repairReady}
        displayMode={displayMode}
        setDisplayMode={setDisplayMode}
        holdOriginal={holdOriginal}
        setHoldOriginal={setHoldOriginal}
        zoom={zoom}
        stepZoom={stepZoom}
        onResetZoom={resetZoom}
        loupeEnabled={loupeEnabled}
        onToggleLoupe={() => setLoupeEnabled((v) => !v)}
      />

      {mutationError && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-status-error/40 bg-status-error/10 px-3 py-1.5 text-xs text-status-error">
          <span className="truncate">提交失败:{mutationError}</span>
          <button
            type="button"
            onClick={() => setMutationError(null)}
            className="shrink-0 hover:opacity-80"
            title="关闭"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {repairNotice && (
        <div
          className="flex shrink-0 items-center justify-between gap-2 border-b border-status-warning/40 bg-status-warning/10 px-3 py-1.5 text-xs text-status-warning"
          data-testid="repair-notice"
        >
          <span className="truncate">{repairNotice}</span>
          <button
            type="button"
            onClick={() => setRepairNotice(null)}
            className="shrink-0 hover:opacity-80"
            title="关闭"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

        <div className="flex min-h-0 flex-1 overflow-hidden bg-stage-bg">
          <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
            {showCompareSplit && pinnedRefItem ? (
              <div className="grid min-h-0 w-full grid-cols-2 gap-2 p-2">
                <div className="flex h-full min-w-0 flex-col items-center justify-center overflow-hidden rounded-lg border border-border bg-bg-1 p-2">
                  <div className="mb-1.5 flex w-full items-center justify-between px-1">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-status-warning">
                      <Pin className="h-3.5 w-3.5" />
                      <span>并排参考图: {pinnedRefItem.title}</span>
                    </div>
                    <span className="font-mono text-[11px] text-fg-3">
                      {pinnedRefItem.provenanceTags.map((tag) => `@${tag.shortName}`).join(" · ") ||
                        "无溯源标签"}
                    </span>
                  </div>
                  <div className="relative aspect-video w-full overflow-hidden rounded border border-border-strong bg-bg-2">
                    {compareSourceUrl ? (
                      <img
                        src={compareSourceUrl}
                        alt={pinnedRefItem.imagePayload?.originalMedia.displayName ?? pinnedRefItem.title}
                        draggable={false}
                        title={
                          pinnedRefItem.id === currentItem.id
                            ? undefined
                            : "缩略图预览(原始媒体仅当前条目可用)"
                        }
                        className="h-full w-full select-none object-contain"
                      />
                    ) : (
                      <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-fg-3">
                        <ImageOff className="h-5 w-5" />
                        <span className="text-[11px]">参考图缩略图未提供</span>
                      </div>
                    )}
                  </div>
                </div>
                {renderCanvasArea()}
              </div>
            ) : (
              renderCanvasArea()
            )}
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
            itemId={currentItem.id}
            itemVersion={currentItem.version}
            issues={issueEntries}
            selectedIssueId={selectedAnnotationId}
            onSelectIssue={(issueId) => {
              setSelectedAnnotationId(issueId);
              setZoom(100);
              setPan({ x: 0, y: 0 });
              setHoldOriginal(false);
              setWorkMode("annotate");
            }}
            onDeleteIssue={handleDeleteIssue}
            onSaveIssue={handleSaveIssue}
            provenanceTags={currentItem.provenanceTags}
            feedbacks={currentItem.feedbacks}
            {...(currentItem.agentGuidance
              ? { agentGuidance: currentItem.agentGuidance }
              : {})}
            {...(currentItem.feedback
              ? {
                  lastFeedback: {
                    text: currentItem.feedback.text,
                    referencedTagIds: currentItem.feedback.referencedTagIds,
                    isDraft: currentItem.feedback.isDraft,
                  },
                }
              : {})}
            widthPx={issuePanelWidth}
            emptyHint="先选上方「标记问题」，在图片上拖出方框或箭头；再点选标记，在这里填写修改要求。"
          />
        </div>
    </div>
  );
}
