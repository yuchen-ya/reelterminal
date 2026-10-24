/**
 * Image review workspace for the AI material workbench.
 *
 * Migrated from the prototype ImageViewerWorkspace with the prototype's view
 * structure preserved (grid / zoom review, pinned reference compare, grouped
 * tools, numbered annotations, per-stroke undo). Replaced per the contract:
 *
 * - No ProceduralSceneCanvas / imageConfig procedural art: media comes from
 *   `imagePayload.originalMedia` (object URL for the CURRENT item only; grids
 *   use the persisted `thumbnailUrl` with an explicit placeholder, never fake
 *   art). A saved repair PNG is loaded separately as `repairMedia`; it is
 *   displayed as-is (strokes already burned in) and never re-composited with
 *   the edit canvas.
 *   loading / error / unavailable all render a visible state.
 * - All stage interaction uses Pointer Events (pointerdown/move/up +
 *   setPointerCapture + pointercancel). Stroke points are recorded as
 *   {x, y, pressure} in DECODED SOURCE PIXEL coordinates (display coordinate
 *   x naturalWidth / displayWidth); devices without pressure report 0.5.
 * - The annotation layer (normalized [0,1] WorkbenchSpatialAnnotation, SVG)
 *   is separate from the pixel repair layer (a dedicated transparent canvas).
 *   The eraser erases the repair layer with destination-out and NEVER paints
 *   a background color.
 * - Repair commits go through onSaveImageRepair(itemId, strokes,
 *   renderPatchedImage) where renderPatchedImage composites the repair canvas
 *   onto a copy of the loaded original bitmap and returns a PNG Blob (null
 *   when the original bitmap is unavailable).
 * - Annotation commits go through onUpdateImageAnnotations(itemId,
 *   annotations, feedback?).
 * - The prototype's in-canvas issue kanban is restored as the shared
 *   WorkbenchIssuePanel rendered beside the zoom canvas (its width is owned by
 *   the page, never by this component). The canned "AI prediction" popover is
 *   NOT restored: issue editing is fully manual and grounded in real
 *   annotations and provenance tags.
 */
import type {
  JSX,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Brush,
  Check,
  Columns2,
  Eraser,
  Eye,
  ImageOff,
  LayoutGrid,
  LoaderCircle,
  Maximize2,
  Move,
  Pin,
  Pipette,
  RotateCcw,
  Square,
  Trash2,
  TriangleAlert,
  Type,
  X,
  ZoomIn,
  ZoomOut,
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

type CanvasWorkMode = "navigate" | "annotate" | "repair";
type RepairTool = "brush" | "eraser" | "eyedropper";
type AnnotateTool = "box" | "arrow" | "text";

/** Brush size in source pixels (stored on WorkbenchPixelStroke.size). */
const BRUSH_SIZE_SOURCE_PX = 14;
/** New-annotation colors use host token values (tailwind status tokens / --accent). */
const ANNOTATION_COLOR_BOX = "#eab308";
const ANNOTATION_COLOR_ARROW = "#ef4444";
const ANNOTATION_COLOR_TEXT = "#10b981";
const FALLBACK_ACCENT = "#10b981";
/** Neutral dark used for on-image label chips (readable over any media). */
const LABEL_CHIP_BG = "rgba(17, 24, 39, 0.92)";

const MIN_ANNOTATION_DRAG = 0.02;
const EMPTY_STROKES: readonly WorkbenchPixelStroke[] = [];
const EMPTY_ANNOTATIONS: readonly WorkbenchSpatialAnnotation[] = [];

const DECISION_STATUS_LABEL: Record<WorkbenchItemView["status"], string> = {
  pending: "待审阅",
  kept: "已保留",
  modified: "已修改",
  rework: "待返工",
  discarded: "已丢弃",
};

const STATUS_TEXT_CLASS: Record<WorkbenchItemView["status"], string> = {
  pending: "text-fg-2",
  kept: "text-accent",
  modified: "text-accent",
  rework: "text-status-warning",
  discarded: "text-status-error",
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readAccentColor(): string {
  if (typeof window === "undefined") return FALLBACK_ACCENT;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue("--accent")
    .trim();
  return value.length > 0 ? value : FALLBACK_ACCENT;
}

/** Pointer pressure for stroke width; devices without pressure report 0.5. */
function pointerPressure(e: ReactPointerEvent): number {
  return e.pressure > 0 ? e.pressure : 0.5;
}

function pressureFactor(pressure: number): number {
  return 0.35 + 0.65 * clamp(pressure, 0, 1);
}

/**
 * Renders one repair stroke onto the transparent repair canvas. Eraser
 * strokes erase previously drawn repair content only (destination-out) —
 * they never paint the background color.
 */
function drawStrokeOnContext(
  ctx: CanvasRenderingContext2D,
  stroke: WorkbenchPixelStroke,
): void {
  const points = stroke.points;
  if (points.length === 0) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (stroke.tool === "eraser") {
    ctx.globalCompositeOperation = "destination-out";
    ctx.strokeStyle = "rgba(0, 0, 0, 1)";
    ctx.fillStyle = "rgba(0, 0, 0, 1)";
  } else {
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
  }
  if (points.length === 1) {
    const radius = Math.max((stroke.size * pressureFactor(points[0].pressure)) / 2, 0.5);
    ctx.beginPath();
    ctx.arc(points[0].x, points[0].y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    ctx.lineWidth = Math.max(
      stroke.size * pressureFactor((a.pressure + b.pressure) / 2),
      0.5,
    );
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.restore();
}

/** Paint one newly sampled segment without clearing or replaying earlier strokes. */
function drawStrokeSegmentOnContext(
  ctx: CanvasRenderingContext2D,
  stroke: WorkbenchPixelStroke,
  from: WorkbenchPixelStroke["points"][number],
  to: WorkbenchPixelStroke["points"][number],
): void {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (stroke.tool === "eraser") {
    ctx.globalCompositeOperation = "destination-out";
    ctx.strokeStyle = "rgba(0, 0, 0, 1)";
  } else {
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = stroke.color;
  }
  ctx.lineWidth = Math.max(
    stroke.size * pressureFactor((from.pressure + to.pressure) / 2),
    0.5,
  );
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.restore();
}

function annotationCoordinateLabel(
  ann: WorkbenchSpatialAnnotation,
  natural: { readonly w: number; readonly h: number } | null,
): string {
  if (!natural) return "源像素坐标未提供";
  if (ann.tool === "box") {
    const px = Math.round(ann.x * natural.w);
    const py = Math.round(ann.y * natural.h);
    const pw = Math.round((ann.w ?? 0) * natural.w);
    const ph = Math.round((ann.h ?? 0) * natural.h);
    return `源像素 [${px}, ${py}, ${pw}×${ph}]`;
  }
  return `源像素 (${Math.round(ann.x * natural.w)}, ${Math.round(ann.y * natural.h)})`;
}

export interface ImageViewerWorkspaceProps {
  readonly currentItem: WorkbenchItemView;
  /** All image items of the batch (grid cards + pinned reference compare). */
  readonly batchImageItems: readonly WorkbenchItemView[];
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

interface InProgressRepairStroke extends Omit<WorkbenchPixelStroke, "points"> {
  points: WorkbenchPixelStroke["points"][number][];
}

/**
 * Image workspace: grid triage + zoomed review canvas with a normalized
 * annotation layer and a source-pixel repair layer. Drafting state is cached
 * per itemId+version so switching items never crosses drafts.
 */
export function ImageViewerWorkspace({
  currentItem,
  batchImageItems,
  selectedIds,
  onSelectItem,
  onUpdateImageAnnotations,
  onSaveImageRepair,
  onCommitDecision,
  issuePanelWidth,
  onStartResizeIssuePanel,
}: ImageViewerWorkspaceProps): JSX.Element {
  const [viewMode, setViewMode] = useState<"zoom" | "grid">("zoom");
  const [pinnedRefId, setPinnedRefId] = useState<string | null>(null);
  const [showCompareSplit, setShowCompareSplit] = useState<boolean>(false);

  const [workMode, setWorkMode] = useState<CanvasWorkMode>("annotate");
  const [repairTool, setRepairTool] = useState<RepairTool>("brush");
  const [annotateTool, setAnnotateTool] = useState<AnnotateTool>("box");
  const [brushColor, setBrushColor] = useState<string>(() => readAccentColor());

  const [zoom, setZoom] = useState<number>(100);
  const [pan, setPan] = useState<{ readonly x: number; readonly y: number }>({ x: 0, y: 0 });
  const [holdOriginal, setHoldOriginal] = useState<boolean>(false);

  const [natural, setNatural] = useState<{ readonly w: number; readonly h: number } | null>(null);
  const [imgError, setImgError] = useState<boolean>(false);
  const [areaSize, setAreaSize] = useState<{ readonly w: number; readonly h: number }>({
    w: 0,
    h: 0,
  });

  const [draftStart, setDraftStart] = useState<{ readonly x: number; readonly y: number } | null>(
    null,
  );
  const [draftCurrent, setDraftCurrent] = useState<{
    readonly x: number;
    readonly y: number;
  } | null>(null);
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
  const draftStrokeRef = useRef<{
    readonly pointerId: number;
    readonly stroke: InProgressRepairStroke;
  } | null>(null);
  const panDragRef = useRef<{
    readonly pointerId: number;
    readonly startX: number;
    readonly startY: number;
    readonly originX: number;
    readonly originY: number;
  } | null>(null);
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

  const draftKey = `${currentItem.id}:${currentItem.version}`;
  const draftStrokes = draftsByItemVersion[draftKey]?.strokes ?? EMPTY_STROKES;

  const pinnedRefItem =
    batchImageItems.find((item) => item.id === pinnedRefId) ?? null;

  const selectedCount = useMemo(
    () => batchImageItems.filter((item) => selectedIds.includes(item.id)).length,
    [batchImageItems, selectedIds],
  );

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
    draftStrokeRef.current = null;
    setDraftStart(null);
    setDraftCurrent(null);
    setMutationError(null);
    setDisplayMode(payload?.initialDisplayMode ?? "original");
    setRepairBase("latest");
    setRepairNotice(null);
  }, [currentItem.id, currentItem.version, payload?.initialDisplayMode]);

  // New bitmap → re-detect natural size and clear decode errors.
  useEffect(() => {
    setNatural(null);
    setImgError(false);
  }, [activeUrl]);

  // A missing/broken saved repair must not masquerade as the editing base.
  useEffect(() => {
    if (repair && repairedMedia?.status === "error") {
      setRepairBase("source");
      setRepairNotice("已保存修补结果不可用，已切到原图底图");
    }
  }, [repair, repairedMedia?.status]);

  // Track the zoom-canvas area so the stage fits while keeping the exact
  // image aspect (display box == image box keeps coordinate math honest).
  // Re-attach when the zoom canvas remounts (grid ↔ zoom): observing the old
  // detached node would leave `areaSize` at 0 and the stage at 1px.
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
  }, [measureArea, viewMode]);

  // Rebuild the transparent layer when committed strokes or the bitmap change.
  // Pointer moves paint only their new segment directly on the canvas below.
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

  /** Display → normalized [0,1] and source-pixel coordinates on the stage. */
  const toStagePoint = useCallback(
    (clientX: number, clientY: number) => {
      const stage = stageRef.current;
      const nat = natural;
      if (!stage || !nat) return null;
      const rect = stage.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const nx = clamp((clientX - rect.left) / rect.width, 0, 1);
      const ny = clamp((clientY - rect.top) / rect.height, 0, 1);
      return {
        normalized: { x: nx, y: ny },
        source: { x: Math.round(nx * nat.w), y: Math.round(ny * nat.h) },
      };
    },
    [natural],
  );

  const capturePointer = (e: ReactPointerEvent<HTMLDivElement>): void => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Pointer may already be released; drawing continues from move events.
    }
  };

  const commitAnnotations = useCallback(
    async (
      next: readonly WorkbenchSpatialAnnotation[],
      selectId?: string,
    ): Promise<void> => {
      // Geometry-only content change; issue feedback is written only by the
      // explicit save/rework buttons in WorkbenchIssuePanel.
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

  const findHitAnnotation = useCallback(
    (pt: { readonly x: number; readonly y: number }): WorkbenchSpatialAnnotation | null => {
      for (let i = annotations.length - 1; i >= 0; i -= 1) {
        const ann = annotations[i];
        if (ann.tool === "box") {
          const w = ann.w ?? 0.15;
          const h = ann.h ?? 0.15;
          if (pt.x >= ann.x && pt.x <= ann.x + w && pt.y >= ann.y && pt.y <= ann.y + h) {
            return ann;
          }
        } else if (Math.hypot(pt.x - ann.x, pt.y - ann.y) < 0.04) {
          return ann;
        }
      }
      return null;
    },
    [annotations],
  );

  const sampleColor = useCallback(
    (source: { readonly x: number; readonly y: number }): void => {
      const img = imgRef.current;
      const repairLayer = repairCanvasRef.current;
      const nat = natural;
      if (!img || !nat || !img.complete || !img.naturalWidth) {
        setMutationError("取色失败:原图尚未就绪");
        return;
      }
      const scratch = document.createElement("canvas");
      scratch.width = nat.w;
      scratch.height = nat.h;
      const ctx = scratch.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        setMutationError("取色失败:无法创建采样画布");
        return;
      }
      try {
        ctx.drawImage(img, 0, 0, nat.w, nat.h);
        if (repairLayer && repairLayer.width > 0 && repairLayer.height > 0) {
          ctx.drawImage(repairLayer, 0, 0);
        }
        const px = Math.floor(clamp(source.x, 0, nat.w - 1));
        const py = Math.floor(clamp(source.y, 0, nat.h - 1));
        const data = ctx.getImageData(px, py, 1, 1).data;
        const hex = `#${[data[0], data[1], data[2]]
          .map((v) => v.toString(16).padStart(2, "0"))
          .join("")}`;
        setBrushColor(hex);
        setRepairTool("brush");
        setMutationError(null);
      } catch {
        setMutationError("取色失败:图像数据不可读");
      }
    },
    [natural],
  );

  /**
   * Composites the repair layer onto a copy of the loaded original bitmap
   * (same-origin object URL, so drawing cannot taint the canvas) and encodes
   * a PNG. Returns null when the original bitmap is unavailable.
   */
  const renderPatchedImage = useCallback(async (): Promise<Blob | null> => {
    const img = imgRef.current;
    const repair = repairCanvasRef.current;
    if (
      !img ||
      !img.complete ||
      !img.naturalWidth ||
      !img.naturalHeight ||
      !repair ||
      repair.width <= 0 ||
      repair.height <= 0
    ) {
      return null;
    }
    const out = document.createElement("canvas");
    out.width = repair.width;
    out.height = repair.height;
    const ctx = out.getContext("2d");
    if (!ctx) return null;
    try {
      ctx.drawImage(img, 0, 0, out.width, out.height);
      ctx.drawImage(repair, 0, 0);
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
      // Controller committed a new version; drop the local draft cache so the
      // new saved-repair image becomes the only visible base.
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

  const handleStagePointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || !canDraw) return;
    capturePointer(e);

    if (workMode === "navigate") {
      panDragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        originX: pan.x,
        originY: pan.y,
      };
      return;
    }

    const pt = toStagePoint(e.clientX, e.clientY);
    if (!pt) return;

    if (workMode === "repair") {
      if (draftStrokeRef.current) return;
      if (repairTool === "eyedropper") {
        sampleColor(pt.source);
        return;
      }
      const stroke: InProgressRepairStroke = {
        id: nextId("stroke"),
        tool: repairTool === "eraser" ? "eraser" : "brush",
        color: brushColor,
        size: BRUSH_SIZE_SOURCE_PX,
        points: [{ x: pt.source.x, y: pt.source.y, pressure: pointerPressure(e) }],
      };
      draftStrokeRef.current = { pointerId: e.pointerId, stroke };
      const context = repairCanvasRef.current?.getContext("2d");
      if (context) drawStrokeOnContext(context, stroke);
      return;
    }

    // Annotate mode: clicking an existing mark selects it instead of drawing.
    const hit = findHitAnnotation(pt.normalized);
    if (hit) {
      setSelectedAnnotationId(hit.id);
      return;
    }
    if (annotateTool === "text") {
      const ann: WorkbenchSpatialAnnotation = {
        id: nextId("ann"),
        tool: "text",
        x: pt.normalized.x,
        y: pt.normalized.y,
        label: "问题点",
        color: ANNOTATION_COLOR_TEXT,
      };
      const next = [...annotations, ann];
      void commitAnnotations(next, ann.id);
      return;
    }
    setDraftStart(pt.normalized);
    setDraftCurrent(pt.normalized);
  };

  const handleStagePointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const panDrag = panDragRef.current;
    if (panDrag && panDrag.pointerId === e.pointerId) {
      setPan({
        x: panDrag.originX + (e.clientX - panDrag.startX),
        y: panDrag.originY + (e.clientY - panDrag.startY),
      });
      return;
    }
    if (!canDraw) return;
    const pt = toStagePoint(e.clientX, e.clientY);
    if (!pt) return;
    const activeStroke = draftStrokeRef.current;
    if (activeStroke) {
      if (activeStroke.pointerId !== e.pointerId) return;
      const draftStroke = activeStroke.stroke;
      const last = draftStroke.points[draftStroke.points.length - 1];
      if (Math.abs(last.x - pt.source.x) + Math.abs(last.y - pt.source.y) < 1) return;
      const nextPoint = {
        x: pt.source.x,
        y: pt.source.y,
        pressure: pointerPressure(e),
      };
      draftStroke.points.push(nextPoint);
      const context = repairCanvasRef.current?.getContext("2d");
      if (context) drawStrokeSegmentOnContext(context, draftStroke, last, nextPoint);
    } else if (draftStart) {
      setDraftCurrent(pt.normalized);
    }
  };

  const handleStagePointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (panDragRef.current?.pointerId === e.pointerId) {
      panDragRef.current = null;
      return;
    }

    const activeStroke = draftStrokeRef.current;
    if (activeStroke) {
      if (activeStroke.pointerId !== e.pointerId) return;
      const finished: WorkbenchPixelStroke = activeStroke.stroke;
      draftStrokeRef.current = null;
      if (finished.points.length > 0) {
        setDraftsByItemVersion((prev) => ({
          ...prev,
          [draftKey]: {
            strokes: [...(prev[draftKey]?.strokes ?? EMPTY_STROKES), finished],
          },
        }));
      }
      return;
    }

    if (draftStart && draftCurrent && annotateTool !== "text") {
      const start = draftStart;
      const current = draftCurrent;
      const nat = natural;
      setDraftStart(null);
      setDraftCurrent(null);
      if (!nat) return;
      const dragDist = Math.hypot(current.x - start.x, current.y - start.y);
      if (dragDist < MIN_ANNOTATION_DRAG) return;

      if (annotateTool === "box") {
        const x = Math.min(start.x, current.x);
        const y = Math.min(start.y, current.y);
        const w = Math.max(0.03, Math.abs(current.x - start.x));
        const h = Math.max(0.03, Math.abs(current.y - start.y));
        const ann: WorkbenchSpatialAnnotation = {
          id: nextId("ann"),
          tool: "box",
          x,
          y,
          w,
          h,
          label: "圈注区域",
          color: ANNOTATION_COLOR_BOX,
        };
        const next = [...annotations, ann];
        void commitAnnotations(next, ann.id);
      } else {
        const ann: WorkbenchSpatialAnnotation = {
          id: nextId("ann"),
          tool: "arrow",
          x: start.x,
          y: start.y,
          endX: current.x,
          endY: current.y,
          label: "指向问题",
          color: ANNOTATION_COLOR_ARROW,
        };
        const next = [...annotations, ann];
        void commitAnnotations(next, ann.id);
      }
    }
  };

  const handleStagePointerCancel = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (draftStrokeRef.current && draftStrokeRef.current.pointerId !== e.pointerId) return;
    if (panDragRef.current && panDragRef.current.pointerId !== e.pointerId) return;
    panDragRef.current = null;
    draftStrokeRef.current = null;
    setDraftStart(null);
    setDraftCurrent(null);
    redrawRepairCanvas();
  };

  const handleClearAnnotations = async (): Promise<void> => {
    if (annotations.length === 0) return;
    setSelectedAnnotationId(null);
    await commitAnnotations(EMPTY_ANNOTATIONS);
  };

  // --- restored issue panel: real annotation cards, manual save/rework ------
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
      setSelectedAnnotationId((current) => (current === issueId ? null : current));
      return result;
    },
    [annotations, currentItem.id, currentItem.version, onUpdateImageAnnotations],
  );

  const handleCardSelect = (item: WorkbenchItemView, e: ReactMouseEvent): void => {
    onSelectItem(item.id, { ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey });
  };

  const handleCardOpen = (item: WorkbenchItemView): void => {
    onSelectItem(item.id);
    setViewMode("zoom");
  };

  /** Prototype grid footer: 保留 / 丢弃 act on exactly this card. */
  const handleCardDecision = useCallback(
    async (
      item: WorkbenchItemView,
      decision: "kept" | "discarded",
    ): Promise<void> => {
      const result = await onCommitDecision(decision, [item.id]);
      setMutationError(result.ok ? null : result.message);
    },
    [onCommitDecision],
  );

  const stepZoom = (delta: number): void => {
    setZoom((z) => clamp(z + delta, 60, 180));
  };

  const dimensionLabel = natural
    ? `${natural.w} × ${natural.h}`
    : payload?.naturalWidth && payload?.naturalHeight
      ? `${payload.naturalWidth} × ${payload.naturalHeight}`
      : "尺寸未提供";

  const stageCursorClass =
    workMode === "annotate"
      ? "cursor-crosshair"
      : workMode === "repair"
        ? "cursor-cell"
        : "cursor-grab";

  const segmentedButton = (active: boolean): string =>
    `flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
      active ? "bg-bg-3 text-fg" : "text-fg-3 hover:text-fg"
    }`;

  const toolButton = (active: boolean, activeClass: string): string =>
    `rounded p-1 transition-colors ${
      active ? activeClass : "text-fg-3 hover:text-fg"
    }`;

  const renderStageMediaPlaceholder = (): JSX.Element => {
    if (!payload || !originalMedia) {
      return (
        <div className="flex max-w-md flex-col items-center gap-2 rounded-xl border border-border bg-bg-1 px-6 py-8 text-center">
          <ImageOff className="h-6 w-6 text-fg-3" />
          <div className="text-sm text-fg-2">图像数据未提供</div>
          <div className="text-xs text-fg-3">该条目缺少图像载荷,无法审阅</div>
        </div>
      );
    }
    if (originalMedia.status === "loading") {
      return (
        <div className="flex max-w-md flex-col items-center gap-2 rounded-xl border border-border bg-bg-1 px-6 py-8 text-center">
          <LoaderCircle className="h-6 w-6 animate-spin text-fg-3" />
          <div className="text-sm text-fg-2">媒体加载中…</div>
          <div className="text-xs text-fg-3">{originalMedia.displayName}</div>
        </div>
      );
    }
    if (originalMedia.status === "error") {
      return (
        <div className="flex max-w-md flex-col items-center gap-2 rounded-xl border border-status-error/40 bg-bg-1 px-6 py-8 text-center">
          <TriangleAlert className="h-6 w-6 text-status-error" />
          <div className="text-sm text-fg-2">媒体加载失败</div>
          <div className="text-xs text-status-error">{originalMedia.error ?? "未知错误"}</div>
        </div>
      );
    }
    if (originalMedia.status === "unavailable") {
      return (
        <div className="flex max-w-md flex-col items-center gap-2 rounded-xl border border-border bg-bg-1 px-6 py-8 text-center">
          <ImageOff className="h-6 w-6 text-fg-3" />
          <div className="text-sm text-fg-2">媒体不可用</div>
          <div className="text-xs text-fg-3">
            {originalMedia.error ?? "原始媒体文件不存在或已被丢弃"}
          </div>
        </div>
      );
    }
    if (imgError) {
      return (
        <div className="flex max-w-md flex-col items-center gap-2 rounded-xl border border-status-error/40 bg-bg-1 px-6 py-8 text-center">
          <TriangleAlert className="h-6 w-6 text-status-error" />
          <div className="text-sm text-fg-2">图片解码失败</div>
          <div className="text-xs text-fg-3">{originalMedia.displayName ?? currentItem.title}</div>
        </div>
      );
    }
    return (
      <div className="flex max-w-md flex-col items-center gap-2 rounded-xl border border-border bg-bg-1 px-6 py-8 text-center">
        <LoaderCircle className="h-6 w-6 animate-spin text-fg-3" />
        <div className="text-sm text-fg-2">媒体未就绪</div>
        <div className="text-xs text-fg-3">原始媒体仅当前条目可用</div>
      </div>
    );
  };

  const naturalUnit = natural ? natural.w / 640 : 1;
  const isDraftBoxVisible = workMode === "annotate" && annotateTool === "box";
  const isDraftArrowVisible = workMode === "annotate" && annotateTool === "arrow";

  const renderAnnotationMarks = (): JSX.Element | null => {
    if (!natural || holdOriginal) return null;
    const u = naturalUnit;
    const accentStyle = { fill: "var(--accent)", stroke: "var(--accent)" } as const;
    return (
      <svg
        viewBox={`0 0 ${natural.w} ${natural.h}`}
        preserveAspectRatio="none"
        className="pointer-events-none absolute inset-0 h-full w-full"
      >
        <defs>
          <marker
            id="rt-image-arrowhead"
            markerWidth="8"
            markerHeight="8"
            refX="7"
            refY="4"
            orient="auto"
          >
            <path d="M0,0 L8,4 L0,8 Z" fill={ANNOTATION_COLOR_ARROW} />
          </marker>
        </defs>

        {annotations.map((ann, idx) => {
          const isSelected = selectedAnnotationId === ann.id;
          if (ann.tool === "box") {
            const rx = ann.x * natural.w;
            const ry = ann.y * natural.h;
            const rw = (ann.w ?? 0.15) * natural.w;
            const rh = (ann.h ?? 0.15) * natural.h;
            return (
              <g key={ann.id}>
                <rect
                  x={rx}
                  y={ry}
                  width={rw}
                  height={rh}
                  rx={4 * u}
                  fill={isSelected ? undefined : ann.color}
                  fillOpacity={isSelected ? 0.16 : 0.08}
                  stroke={isSelected ? undefined : ann.color}
                  strokeWidth={(isSelected ? 3 : 2) * u}
                  strokeDasharray={isSelected ? undefined : `${6 * u} ${4 * u}`}
                  style={isSelected ? accentStyle : undefined}
                />
                <rect
                  x={rx}
                  y={Math.max(2 * u, ry - 24 * u)}
                  width={34 * u}
                  height={20 * u}
                  rx={4 * u}
                  fill={LABEL_CHIP_BG}
                  stroke={isSelected ? undefined : ann.color}
                  strokeWidth={1 * u}
                  style={isSelected ? { stroke: "var(--accent)" } : undefined}
                />
                <text
                  x={rx + 8 * u}
                  y={Math.max(16 * u, ry - 10 * u)}
                  fill={isSelected ? undefined : ann.color}
                  fontSize={11 * u}
                  fontWeight={700}
                  style={isSelected ? { fill: "var(--accent)" } : undefined}
                >
                  #{idx + 1}
                </text>
              </g>
            );
          }
          if (ann.tool === "arrow") {
            const x1 = ann.x * natural.w;
            const y1 = ann.y * natural.h;
            const x2 = (ann.endX ?? ann.x + 0.1) * natural.w;
            const y2 = (ann.endY ?? ann.y + 0.1) * natural.h;
            return (
              <g key={ann.id}>
                <line
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke={isSelected ? undefined : ann.color}
                  strokeWidth={(isSelected ? 3.5 : 2.5) * u}
                  markerEnd="url(#rt-image-arrowhead)"
                  style={isSelected ? accentStyle : undefined}
                />
                <text
                  x={x1 + 4 * u}
                  y={Math.max(16 * u, y1 - 8 * u)}
                  fontSize={12 * u}
                  fontWeight={700}
                  fill={isSelected ? undefined : ann.color}
                  stroke={LABEL_CHIP_BG}
                  strokeWidth={3 * u}
                  paintOrder="stroke"
                  style={isSelected ? { fill: "var(--accent)" } : undefined}
                >
                  #{idx + 1}
                  {isSelected && ann.label ? ` ${ann.label.slice(0, 20)}` : ""}
                </text>
              </g>
            );
          }
          const tx = ann.x * natural.w;
          const ty = ann.y * natural.h;
          return (
            <g key={ann.id}>
              <circle
                cx={tx}
                cy={ty}
                r={6 * u}
                fill={isSelected ? undefined : ann.color}
                style={isSelected ? { fill: "var(--accent)" } : undefined}
              />
              <text
                x={tx + 10 * u}
                y={ty + 4 * u}
                fontSize={12 * u}
                fontWeight={700}
                fill={isSelected ? undefined : ann.color}
                stroke={LABEL_CHIP_BG}
                strokeWidth={3 * u}
                paintOrder="stroke"
                style={isSelected ? { fill: "var(--accent)" } : undefined}
              >
                #{idx + 1}
                {isSelected && ann.label ? ` ${ann.label.slice(0, 20)}` : ""}
              </text>
            </g>
          );
        })}

        {isDraftBoxVisible && draftStart && draftCurrent && (
          <rect
            x={Math.min(draftStart.x, draftCurrent.x) * natural.w}
            y={Math.min(draftStart.y, draftCurrent.y) * natural.h}
            width={Math.abs(draftCurrent.x - draftStart.x) * natural.w}
            height={Math.abs(draftCurrent.y - draftStart.y) * natural.h}
            fill="var(--accent)"
            fillOpacity={0.16}
            strokeWidth={2.5 * u}
            style={{ stroke: "var(--accent)" }}
          />
        )}
        {isDraftArrowVisible && draftStart && draftCurrent && (
          <line
            x1={draftStart.x * natural.w}
            y1={draftStart.y * natural.h}
            x2={draftCurrent.x * natural.w}
            y2={draftCurrent.y * natural.h}
            strokeWidth={2.5 * u}
            markerEnd="url(#rt-image-arrowhead)"
            style={{ stroke: "var(--accent)" }}
          />
        )}
      </svg>
    );
  };

  const renderStage = (): JSX.Element => {
    if (
      !activeMedia ||
      activeMedia.status !== "ready" ||
      !activeUrl ||
      imgError
    ) {
      return renderStageMediaPlaceholder();
    }
    // Until the bitmap is decoded (natural size known) the img stays mounted
    // at 1px so onLoad fires; drawing overlays only appear once ready.
    const ready = natural !== null && display !== null;
    return (
      <>
        <div
          ref={stageRef}
          data-testid="image-stage"
          className={`relative select-none ${ready ? `shadow-lg ${stageCursorClass}` : ""}`}
          style={
            ready && display
              ? {
                  width: display.w,
                  height: display.h,
                  transform: `scale(${zoom / 100}) translate(${pan.x}px, ${pan.y}px)`,
                }
              : undefined
          }
        >
          <img
            ref={imgRef}
            src={activeUrl}
            alt={activeMedia.displayName}
            draggable={false}
            data-display-mode={usingRepair ? "repaired" : "original"}
            onLoad={(e) => {
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
              setNatural({ w: width, h: height });
              setImgError(false);
              measureArea();
            }}
            onError={() => {
              if (usingRepair) {
                setDisplayMode("original");
                setRepairNotice("修补结果不可用，已回退原图");
                return;
              }
              setImgError(true);
            }}
            className={ready ? "block h-full w-full" : "block h-px w-px opacity-0"}
          />

          {/* Repair edit layer: only THIS draft session's unsaved strokes. */}
          {ready && workMode === "repair" && (
            <canvas
              ref={repairCanvasRef}
              className="pointer-events-none absolute inset-0 h-full w-full"
            />
          )}
          {ready && renderAnnotationMarks()}

          {/* Pointer-capture drawing surface. */}
          {ready && (
            <div
              className={`absolute inset-0 touch-none ${stageCursorClass}`}
              data-testid="image-stage-pointer-surface"
              onPointerDown={handleStagePointerDown}
              onPointerMove={handleStagePointerMove}
              onPointerUp={handleStagePointerUp}
              onPointerCancel={handleStagePointerCancel}
            />
          )}
        </div>
        {!ready && (
          <div className="absolute flex max-w-md flex-col items-center gap-2 rounded-xl border border-border bg-bg-1 px-6 py-8 text-center">
            <LoaderCircle className="h-6 w-6 animate-spin text-fg-3" />
            <div className="text-sm text-fg-2">媒体加载中…</div>
            <div className="text-xs text-fg-3">{activeMedia.displayName}</div>
          </div>
        )}
      </>
    );
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
      <div className="pointer-events-none absolute left-3 top-3 z-10">
        <div className="rounded border border-border bg-bg-1 px-2 py-0.5 font-mono text-[11px] tabular-nums text-fg-3">
          {dimensionLabel}
        </div>
      </div>
      <div ref={areaRef} className="absolute inset-0 flex items-center justify-center">
        {renderStage()}
      </div>
    </div>
  );

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg">
      {/* Top Sub-Toolbar */}
      <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border bg-bg-1 px-3">
        <div className="flex items-center gap-1.5">
          <div className="flex items-center gap-0.5 rounded-lg border border-border bg-bg-2 p-0.5">
            <button type="button" onClick={() => setViewMode("grid")} className={segmentedButton(viewMode === "grid")}>
              <LayoutGrid className="h-3.5 w-3.5" />
              网格筛选 ({batchImageItems.length})
            </button>
            <button type="button" onClick={() => setViewMode("zoom")} className={segmentedButton(viewMode === "zoom")}>
              <Maximize2 className="h-3.5 w-3.5" />
              画板精审
            </button>
          </div>

          {viewMode === "zoom" && (
            <>
              <div className="mx-1 h-4 w-px bg-border" />
              <button
                type="button"
                onClick={() => setShowCompareSplit((prev) => !prev)}
                className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                  showCompareSplit
                    ? "border-accent bg-accent-soft text-accent"
                    : "border-border bg-bg-1 text-fg-2 hover:text-fg"
                }`}
              >
                <Columns2 className="h-3.5 w-3.5" />
                并排参考对比
              </button>
              <button
                type="button"
                onClick={() =>
                  setPinnedRefId((prev) => (prev === currentItem.id ? null : currentItem.id))
                }
                className={`flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-2 py-1 text-xs transition-colors ${
                  pinnedRefId === currentItem.id
                    ? "border-status-warning/40 bg-status-warning/15 text-status-warning"
                    : "border-border bg-bg-1 text-fg-3 hover:text-fg"
                }`}
              >
                <Pin className="h-3 w-3" />
                {pinnedRefId === currentItem.id ? "已设为参考图" : "固定为参考"}
              </button>
            </>
          )}
        </div>

        {/* Center Mode Switcher + tool groups */}
        {viewMode === "zoom" && (
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-0.5 rounded-lg border border-border bg-bg-2 p-0.5">
              <button
                type="button"
                onClick={() => setWorkMode("navigate")}
                className={segmentedButton(workMode === "navigate")}
                data-testid="image-mode-navigate"
              >
                <Move className="h-3.5 w-3.5" />
                平移查看
              </button>
              <button
                type="button"
                onClick={() => setWorkMode("annotate")}
                data-testid="image-mode-annotate"
                className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  workMode === "annotate"
                    ? "bg-status-warning/15 text-status-warning"
                    : "text-fg-3 hover:text-fg"
                }`}
              >
                <Square className="h-3.5 w-3.5" />
                Agent 问题圈注 ({annotations.length})
              </button>
              <button
                type="button"
                onClick={() => setWorkMode("repair")}
                data-testid="image-mode-repair"
                className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  workMode === "repair"
                    ? "bg-status-info/15 text-status-info"
                    : "text-fg-3 hover:text-fg"
                }`}
              >
                <Brush className="h-3.5 w-3.5" />
                像素轻修层 ({draftStrokes.length})
              </button>
            </div>

            {workMode === "annotate" && (
              <div className="flex items-center gap-1 rounded-lg border border-border bg-bg-1 px-2 py-0.5">
                <button
                  type="button"
                  onClick={() => setAnnotateTool("box")}
                  className={toolButton(annotateTool === "box", "bg-status-warning/20 text-status-warning")}
                  title="矩形框选位置"
                >
                  <Square className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setAnnotateTool("arrow")}
                  className={toolButton(annotateTool === "arrow", "bg-status-warning/20 text-status-warning")}
                  title="箭头指向问题"
                >
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setAnnotateTool("text")}
                  className={toolButton(annotateTool === "text", "bg-status-warning/20 text-status-warning")}
                  title="点击锚定问题点"
                >
                  <Type className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => void handleClearAnnotations()}
                  disabled={annotations.length === 0}
                  className="rounded p-1 text-fg-3 transition-colors hover:text-status-error disabled:opacity-30"
                  title="清空全部圈注"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            {workMode === "repair" && (
              <div className="flex items-center gap-1.5 rounded-lg border border-border bg-bg-1 px-2 py-0.5">
                <span
                  className="whitespace-nowrap font-mono text-[10px] text-fg-3"
                  data-testid="repair-base-label"
                >
                  底图：{repairBase === "latest" && repair ? `已保存修补 v${repair.producedVersion}` : "原图"}
                </span>
                {repair && (
                  <button
                    type="button"
                    onClick={() =>
                      setRepairBase((prev) => (prev === "latest" ? "source" : "latest"))
                    }
                    className="whitespace-nowrap rounded border border-border bg-bg-2 px-1.5 py-0.5 text-[10px] text-fg-2 hover:text-fg"
                    title="切换修补底图；保存会记录本次基线，不会把旧基线再叠加一次"
                    data-testid="repair-base-toggle"
                  >
                    {repairBase === "latest" ? "从原图重新修补" : "使用已保存修补"}
                  </button>
                )}
                <span className="mx-1 h-4 w-px bg-border" />
                <button
                  type="button"
                  onClick={() => setRepairTool("eyedropper")}
                  className={toolButton(repairTool === "eyedropper", "bg-status-info/20 text-status-info")}
                  title="取色(吸取画面颜色作为画笔色)"
                >
                  <Pipette className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setRepairTool("brush")}
                  className={toolButton(repairTool === "brush", "bg-status-info/20 text-status-info")}
                  title="修补画笔"
                >
                  <Brush className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setRepairTool("eraser")}
                  className={toolButton(repairTool === "eraser", "bg-status-info/20 text-status-info")}
                  title="橡皮擦(仅擦除修补层)"
                >
                  <Eraser className="h-3.5 w-3.5" />
                </button>
                <input
                  type="color"
                  value={brushColor}
                  onChange={(e) => setBrushColor(e.target.value)}
                  className="h-5 w-5 cursor-pointer rounded border-0 bg-transparent p-0"
                  title="画笔颜色"
                />
                <button
                  type="button"
                  onClick={handleUndoStroke}
                  disabled={draftStrokes.length === 0}
                  className="rounded p-1 text-fg-3 transition-colors hover:text-fg disabled:opacity-30"
                  title="撤销上一笔(未提交草稿)"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => void handleSaveRepair()}
                  disabled={draftStrokes.length === 0 || savingRepair}
                  className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-accent-foreground transition-colors hover:bg-accent-strong disabled:opacity-40"
                >
                  {savingRepair ? "提交中…" : `提交修补(${draftStrokes.length} 笔)`}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Right: Hold-to-Compare & Zoom */}
        <div className="flex items-center gap-1.5">
          {viewMode === "zoom" && (
            <>
              {repair && (
                <div className="flex items-center rounded-md border border-border bg-bg-2 p-0.5">
                  <button
                    type="button"
                    onClick={() => setDisplayMode("original")}
                    className={`rounded px-2 py-1 text-xs ${
                      displayMode === "original"
                        ? "bg-bg-3 text-fg"
                        : "text-fg-3 hover:text-fg"
                    }`}
                    data-testid="image-display-original"
                  >
                    查看原图
                  </button>
                  <button
                    type="button"
                    onClick={() => setDisplayMode("repaired")}
                    disabled={!repairReady}
                    className={`rounded px-2 py-1 text-xs disabled:opacity-40 ${
                      displayMode === "repaired"
                        ? "bg-bg-3 text-fg"
                        : "text-fg-3 hover:text-fg"
                    }`}
                    data-testid="image-display-repaired"
                  >
                    查看修补
                  </button>
                </div>
              )}
              <button
                type="button"
                onPointerDown={() => setHoldOriginal(true)}
                onPointerUp={() => setHoldOriginal(false)}
                onPointerLeave={() => setHoldOriginal(false)}
                onPointerCancel={() => setHoldOriginal(false)}
                className={`flex shrink-0 items-center gap-1 whitespace-nowrap rounded border px-2 py-1 text-xs transition-colors ${
                  holdOriginal
                    ? "border-accent bg-accent-soft text-accent"
                    : "border-border bg-bg-1 text-fg-2 hover:text-fg"
                }`}
                title={repair ? "按住临时查看真原图（无笔画/无修补）" : "暂无已保存修补，当前即原图"}
              >
                <Eye className="h-3.5 w-3.5" />
                按住看原图
              </button>
              <div className="flex items-center rounded-md border border-border bg-bg-2 px-1">
                <button
                  type="button"
                  onClick={() => stepZoom(-20)}
                  className="p-1 text-fg-3 hover:text-fg"
                  title="缩小"
                >
                  <ZoomOut className="h-3.5 w-3.5" />
                </button>
                <span className="px-1.5 font-mono text-xs tabular-nums text-fg-2">{zoom}%</span>
                <button
                  type="button"
                  onClick={() => stepZoom(20)}
                  className="p-1 text-fg-3 hover:text-fg"
                  title="放大"
                >
                  <ZoomIn className="h-3.5 w-3.5" />
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Mutation error banner (never silent) */}
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

      {/* Main Content Area */}
      {viewMode === "grid" ? (
        <div className="flex-1 overflow-y-auto bg-stage-bg p-4">
          <div className="mb-3 flex items-center justify-between text-xs text-fg-2">
            <span>
              网格批量筛选视图 · 单击选择,支持 <code className="text-fg">Ctrl/Cmd</code> 多选与{" "}
              <code className="text-fg">Shift</code> 连选;双击卡片进入精修画板
            </span>
            <span className="font-mono tabular-nums">
              当前图片集已选 {selectedCount} / {batchImageItems.length} 项
            </span>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {batchImageItems.map((item) => {
              const isSelected = selectedIds.includes(item.id);
              const isCurrent = currentItem.id === item.id;
              const isPinned = pinnedRefId === item.id;
              const thumbnail = item.imagePayload?.originalMedia.thumbnailUrl ?? null;
              const annotationCount = item.imagePayload?.annotations.length ?? 0;
              return (
                <div
                  key={item.id}
                  onClick={(e) => handleCardSelect(item, e)}
                  onDoubleClick={() => handleCardOpen(item)}
                  className={`group relative cursor-pointer overflow-hidden rounded-xl border bg-bg-1 transition-all ${
                    isSelected
                      ? "border-accent shadow-glow"
                      : isCurrent
                        ? "border-border-strong"
                        : "border-border hover:border-border-strong"
                  }`}
                >
                  <div className="relative aspect-video w-full overflow-hidden bg-bg-2">
                    {thumbnail ? (
                      <img
                        src={thumbnail}
                        alt={item.imagePayload?.originalMedia.displayName ?? item.title}
                        draggable={false}
                        className="h-full w-full select-none object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-fg-3">
                        <ImageOff className="h-5 w-5" />
                        <span className="text-[11px]">未提供缩略图</span>
                      </div>
                    )}
                    <div className="absolute left-2.5 top-2.5 flex items-center gap-1.5">
                      {item.imagePayload?.repair && (
                        <span className="rounded border border-status-info/40 bg-status-info/15 px-1 py-0.5 font-mono text-[10px] text-status-info">
                          已修补
                        </span>
                      )}
                      <div
                        className={`flex h-5 w-5 items-center justify-center rounded border font-mono text-xs ${
                          isSelected
                            ? "border-accent bg-accent font-bold text-accent-foreground"
                            : "border-white/25 bg-black/65 text-transparent group-hover:border-white/50"
                        }`}
                      >
                        <Check className="h-3.5 w-3.5" />
                      </div>
                      {isPinned && (
                        <span className="rounded border border-status-warning/30 bg-black/75 px-2 py-0.5 text-[11px] font-medium text-status-warning">
                          参考基准
                        </span>
                      )}
                    </div>

                    <div className="absolute right-2.5 top-2.5 flex items-center gap-1.5 rounded bg-black/75 px-2 py-0.5 text-[11px] text-fg-2">
                      <span className={STATUS_TEXT_CLASS[item.status]}>
                        {DECISION_STATUS_LABEL[item.status]}
                      </span>
                      {annotationCount > 0 && (
                        <>
                          <span>·</span>
                          <span className="text-status-warning">{annotationCount} 圈注</span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2 p-3">
                    <div className="min-w-0">
                      <div className="truncate text-xs font-semibold text-fg">{item.title}</div>
                      <div className="mt-0.5 truncate text-[11px] text-fg-3">
                        {item.provenanceTags.map((tag) => `@${tag.shortName}`).join(" · ") ||
                          "无溯源标签"}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleCardDecision(item, "kept");
                        }}
                        className="rounded border border-accent/40 bg-accent-soft px-2 py-1 text-[11px] font-medium text-accent transition-colors hover:bg-accent/20"
                        title="保留此图片（仅此条目）"
                        data-testid="image-card-keep"
                      >
                        保留
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleCardDecision(item, "discarded");
                        }}
                        className="rounded border border-border bg-bg-2 px-2 py-1 text-[11px] text-fg-2 transition-colors hover:text-status-error"
                        title="丢弃此图片（只写本批状态，不删除源文件）"
                        data-testid="image-card-discard"
                      >
                        丢弃
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden bg-stage-bg">
          <div className="flex min-h-0 min-w-0 flex-1 gap-3 overflow-hidden p-3">
            {showCompareSplit && pinnedRefItem ? (
              <div className="grid min-h-0 w-full grid-cols-2 gap-3">
                <div className="flex h-full min-w-0 flex-col items-center justify-center overflow-hidden rounded-xl border border-border bg-bg-1 p-3">
                  <div className="mb-2 flex w-full items-center justify-between px-1">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-status-warning">
                      <Pin className="h-3.5 w-3.5" />
                      <span>并排参考图:{pinnedRefItem.title}</span>
                    </div>
                    <span className="font-mono text-[11px] text-fg-3">
                      {pinnedRefItem.provenanceTags.map((tag) => `@${tag.shortName}`).join(" · ") ||
                        "无溯源标签"}
                    </span>
                  </div>
                  <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-border-strong bg-bg-2">
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
            onSelectIssue={setSelectedAnnotationId}
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
            emptyHint="在画布上用矩形/箭头圈出问题位置后，可在此写明返工建议并引用来源标签。"
          />
        </div>
      )}
    </div>
  );
}
