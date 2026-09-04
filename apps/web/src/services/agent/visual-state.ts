import type { Project, Track } from "@openreel/core";
import { getLiveEditorContext } from "../../stores/editor-context-store";
import { getProjectRevision, useProjectStore } from "../../stores/project-store";

export const VISUAL_STATE_BOARD = { width: 960, height: 540 } as const;
export const VISUAL_STATE_KEYFRAME_INTERVAL = 7;

export type VisualStateChangedField =
  | "project"
  | "preview"
  | "timeline"
  | "playhead"
  | "selection"
  | "references";

export interface ConversationVisualStateCapture {
  readonly version: 1;
  readonly stateRef: string;
  readonly baseRef?: string;
  readonly kind: "keyframe" | "delta" | "metadata";
  readonly projectRevision: number;
  readonly contextRevision: number;
  readonly playheadSeconds: number;
  readonly selectedClipIds: readonly string[];
  readonly selectedTextIds: readonly string[];
  readonly selectedMediaIds: readonly string[];
  readonly changed: readonly VisualStateChangedField[];
  readonly imagePngBase64?: string;
  readonly imageWidth?: number;
  readonly imageHeight?: number;
  readonly regions?: readonly PixelRegionMapping[];
}

export interface PixelRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PixelRegionMapping extends PixelRegion {
  readonly imageX: number;
  readonly imageY: number;
}

interface SemanticSnapshot {
  readonly projectId: string;
  readonly project: string;
  readonly timeline: string;
  readonly playhead: string;
  readonly selection: string;
  readonly references: string;
}

interface VisualCaptureMemory {
  sessionId: string | null;
  sourceId: string;
  sequence: number;
  previousRef: string | null;
  previousPixels: ImageData | null;
  previousSemantic: SemanticSnapshot | null;
  imageDeltaCount: number;
}

function makeSourceId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return (uuid ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).slice(0, 64);
}

const memory: VisualCaptureMemory = {
  sessionId: null,
  sourceId: makeSourceId(),
  sequence: 0,
  previousRef: null,
  previousPixels: null,
  previousSemantic: null,
  imageDeltaCount: 0,
};

function resetMemory(sessionId: string): void {
  memory.sessionId = sessionId;
  memory.sourceId = makeSourceId();
  memory.sequence = 0;
  memory.previousRef = null;
  memory.previousPixels = null;
  memory.previousSemantic = null;
  memory.imageDeltaCount = 0;
}

export function resetConversationVisualState(): void {
  resetMemory("");
  memory.sessionId = null;
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function clipLikeFingerprint(value: {
  readonly id: string;
  readonly trackId: string;
  readonly startTime: number;
  readonly duration: number;
}): readonly [string, string, number, number] {
  return [value.id, value.trackId, rounded(value.startTime), rounded(value.duration)];
}

function semanticSnapshot(
  project: Project,
  context: ReturnType<typeof getLiveEditorContext>,
): SemanticSnapshot {
  return {
    projectId: project.id,
    project: JSON.stringify([
      project.id,
      project.name,
      project.settings.width,
      project.settings.height,
      project.settings.frameRate,
    ]),
    timeline: JSON.stringify([
      rounded(project.timeline.duration),
      project.timeline.tracks.map((track) => [
        track.id,
        track.type,
        track.name,
        track.hidden,
        track.locked,
        track.muted,
        track.clips.map(clipLikeFingerprint),
      ]),
      (project.textClips ?? []).map(clipLikeFingerprint),
      (project.shapeClips ?? []).map(clipLikeFingerprint),
      (project.svgClips ?? []).map(clipLikeFingerprint),
      (project.stickerClips ?? []).map(clipLikeFingerprint),
    ]),
    playhead: String(rounded(context.playheadSeconds ?? 0)),
    selection: JSON.stringify([
      context.selectedClipIds,
      context.selectedTextIds,
      context.selectedMediaIds,
    ]),
    references: JSON.stringify(
      Object.values(context.references ?? {}).map((reference) => [
        reference.number,
        reference.kind,
        reference.stale,
      ]),
    ),
  };
}

function semanticChanges(
  previous: SemanticSnapshot | null,
  current: SemanticSnapshot,
): VisualStateChangedField[] {
  if (!previous || previous.projectId !== current.projectId) {
    return ["project", "preview", "timeline", "playhead", "selection", "references"];
  }
  const changed: VisualStateChangedField[] = [];
  if (previous.project !== current.project) changed.push("project");
  if (previous.timeline !== current.timeline) changed.push("timeline");
  if (previous.playhead !== current.playhead) changed.push("playhead");
  if (previous.selection !== current.selection) changed.push("selection");
  if (previous.references !== current.references) changed.push("references");
  return changed;
}

function panel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  fill = "#171b22",
): void {
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = "#303744";
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
}

function text(
  ctx: CanvasRenderingContext2D,
  value: string,
  x: number,
  y: number,
  options: { size?: number; color?: string; weight?: number; maxWidth?: number } = {},
): void {
  ctx.fillStyle = options.color ?? "#dce3ee";
  ctx.font = `${options.weight ?? 500} ${options.size ?? 14}px system-ui, sans-serif`;
  ctx.textBaseline = "top";
  ctx.fillText(value, x, y, options.maxWidth);
}

function trackItems(project: Project, track: Track) {
  const overlayCollections = [
    project.textClips ?? [],
    project.shapeClips ?? [],
    project.svgClips ?? [],
    project.stickerClips ?? [],
  ];
  return [
    ...track.clips.map((clip) => ({ ...clip, visualType: track.type })),
    ...overlayCollections.flatMap((clips) =>
      clips
        .filter((clip) => clip.trackId === track.id)
        .map((clip) => ({ ...clip, visualType: track.type })),
    ),
  ];
}

const TRACK_COLORS: Record<Track["type"], string> = {
  video: "#4f8cff",
  audio: "#23b58f",
  image: "#ad77ff",
  text: "#f0b84b",
  graphics: "#e56aa6",
};

function drawTimeline(
  ctx: CanvasRenderingContext2D,
  project: Project,
  playheadSeconds: number,
  selectedIds: ReadonlySet<string>,
): void {
  const x = 16;
  const y = 412;
  const width = 928;
  const height = 112;
  panel(ctx, x, y, width, height, "#12161c");
  const labelWidth = 90;
  const timelineX = x + labelWidth;
  const timelineWidth = width - labelWidth - 12;
  const tracks = project.timeline.tracks.slice(0, 6);
  let duration = Math.max(1, project.timeline.duration);
  for (const track of tracks) {
    for (const clip of trackItems(project, track)) {
      duration = Math.max(duration, clip.startTime + clip.duration);
    }
  }
  const rowHeight = Math.max(13, Math.floor((height - 24) / Math.max(1, tracks.length)));
  text(ctx, "TIMELINE", x + 10, y + 7, { size: 11, color: "#8792a4", weight: 700 });
  tracks.forEach((track, index) => {
    const rowY = y + 23 + index * rowHeight;
    text(ctx, track.name || track.type, x + 10, rowY + 2, {
      size: 10,
      color: track.hidden ? "#596273" : "#aeb8c7",
      maxWidth: labelWidth - 16,
    });
    ctx.fillStyle = index % 2 === 0 ? "#1a2029" : "#171c24";
    ctx.fillRect(timelineX, rowY, timelineWidth, rowHeight - 2);
    for (const clip of trackItems(project, track)) {
      const clipX = timelineX + (Math.max(0, clip.startTime) / duration) * timelineWidth;
      const clipWidth = Math.max(3, (Math.max(0.03, clip.duration) / duration) * timelineWidth);
      ctx.globalAlpha = track.hidden ? 0.35 : 0.9;
      ctx.fillStyle = TRACK_COLORS[track.type];
      ctx.fillRect(clipX, rowY + 2, Math.min(clipWidth, timelineX + timelineWidth - clipX), rowHeight - 6);
      ctx.globalAlpha = 1;
      if (selectedIds.has(clip.id)) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.strokeRect(clipX + 0.5, rowY + 2.5, Math.max(2, Math.min(clipWidth, timelineX + timelineWidth - clipX) - 1), rowHeight - 7);
      }
    }
  });
  const playheadX = timelineX + (Math.min(duration, Math.max(0, playheadSeconds)) / duration) * timelineWidth;
  ctx.strokeStyle = "#ff5d73";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(playheadX, y + 20);
  ctx.lineTo(playheadX, y + height - 5);
  ctx.stroke();
}

function drawStateBoard(
  project: Project,
  context: ReturnType<typeof getLiveEditorContext>,
  includePreview: boolean,
): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = VISUAL_STATE_BOARD.width;
  canvas.height = VISUAL_STATE_BOARD.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  ctx.fillStyle = "#0c0f14";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  text(ctx, project.name || "Untitled project", 16, 13, {
    size: 18,
    color: "#f4f7fb",
    weight: 700,
    maxWidth: 620,
  });
  text(ctx, "REELTERMINAL VISUAL STATE", 720, 17, {
    size: 10,
    color: "#778295",
    weight: 700,
  });

  const previewPanel = { x: 16, y: 44, width: 636, height: 352 };
  panel(ctx, previewPanel.x, previewPanel.y, previewPanel.width, previewPanel.height, "#080a0e");
  const preview = includePreview
    ? document.querySelector<HTMLCanvasElement>('[data-testid="preview-canvas"]')
    : null;
  if (preview && preview.width > 0 && preview.height > 0) {
    const scale = Math.min(
      (previewPanel.width - 12) / preview.width,
      (previewPanel.height - 12) / preview.height,
    );
    const width = preview.width * scale;
    const height = preview.height * scale;
    const x = previewPanel.x + (previewPanel.width - width) / 2;
    const y = previewPanel.y + (previewPanel.height - height) / 2;
    ctx.drawImage(preview, x, y, width, height);
  } else {
    text(ctx, "Preview unavailable", previewPanel.x + 238, previewPanel.y + 164, {
      size: 14,
      color: "#657083",
    });
  }

  const details = { x: 668, y: 44, width: 276, height: 352 };
  panel(ctx, details.x, details.y, details.width, details.height);
  text(ctx, "CURRENT VIEW", details.x + 16, details.y + 16, {
    size: 11,
    color: "#8792a4",
    weight: 700,
  });
  const duration = Math.max(0, project.timeline.duration);
  const rows = [
    `${rounded(context.playheadSeconds ?? 0).toFixed(3)}s / ${rounded(duration).toFixed(3)}s`,
    `${project.settings.width} × ${project.settings.height}  ${project.settings.frameRate} fps`,
    `${project.timeline.tracks.length} tracks  ${project.mediaLibrary.items.length} media`,
  ];
  rows.forEach((row, index) =>
    text(ctx, row, details.x + 16, details.y + 46 + index * 26, {
      size: index === 0 ? 18 : 13,
      color: index === 0 ? "#f4f7fb" : "#b9c3d2",
      weight: index === 0 ? 700 : 500,
    }),
  );

  const selected = [
    ...context.selectedClipIds,
    ...context.selectedTextIds,
    ...context.selectedMediaIds,
  ];
  text(ctx, `SELECTED  ${selected.length}`, details.x + 16, details.y + 145, {
    size: 11,
    color: "#8792a4",
    weight: 700,
  });
  selected.slice(0, 5).forEach((id, index) =>
    text(ctx, id, details.x + 16, details.y + 168 + index * 20, {
      size: 11,
      color: "#d8dfeb",
      maxWidth: details.width - 32,
    }),
  );
  const references = context.references ?? {};
  const referenceCount = Object.keys(references).length;
  text(ctx, `REFERENCES  ${referenceCount}`, details.x + 16, details.y + 285, {
    size: 11,
    color: "#8792a4",
    weight: 700,
  });
  if (referenceCount === 0) {
    text(ctx, "None", details.x + 16, details.y + 308, {
      size: 12,
      color: "#657083",
    });
  } else {
    text(ctx, Object.keys(references).slice(0, 8).join("  "), details.x + 16, details.y + 308, {
      size: 12,
      color: "#d8dfeb",
      maxWidth: details.width - 32,
    });
  }

  drawTimeline(
    ctx,
    project,
    context.playheadSeconds ?? 0,
    new Set([...context.selectedClipIds, ...context.selectedTextIds]),
  );
  return canvas;
}

/** Returns an aligned changed rectangle; null means visually identical. */
export function changedPixelRegion(
  previous: ImageData,
  current: ImageData,
  alignment = 32,
  padding = 12,
): PixelRegion | null {
  if (previous.width !== current.width || previous.height !== current.height) {
    return { x: 0, y: 0, width: current.width, height: current.height };
  }
  return changedPixelRegionWithin(
    previous,
    current,
    { x: 0, y: 0, width: current.width, height: current.height },
    alignment,
    padding,
  );
}

function changedPixelRegionWithin(
  previous: ImageData,
  current: ImageData,
  bounds: PixelRegion,
  alignment: number,
  padding: number,
): PixelRegion | null {
  let minX = bounds.x + bounds.width;
  let minY = bounds.y + bounds.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) {
    for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
      const offset = (y * current.width + x) * 4;
      if (
        Math.abs(previous.data[offset]! - current.data[offset]!) <= 10 &&
        Math.abs(previous.data[offset + 1]! - current.data[offset + 1]!) <= 10 &&
        Math.abs(previous.data[offset + 2]! - current.data[offset + 2]!) <= 10 &&
        Math.abs(previous.data[offset + 3]! - current.data[offset + 3]!) <= 10
      ) {
        continue;
      }
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) return null;
  const x = Math.max(0, Math.floor((minX - padding) / alignment) * alignment);
  const y = Math.max(0, Math.floor((minY - padding) / alignment) * alignment);
  const right = Math.min(
    current.width,
    Math.ceil((maxX + 1 + padding) / alignment) * alignment,
  );
  const bottom = Math.min(
    current.height,
    Math.ceil((maxY + 1 + padding) / alignment) * alignment,
  );
  return { x, y, width: right - x, height: bottom - y };
}

/** Keep disjoint preview/details/timeline changes from forming one huge crop. */
export function changedPixelRegions(
  previous: ImageData,
  current: ImageData,
): PixelRegion[] {
  if (previous.width !== current.width || previous.height !== current.height) {
    return [{ x: 0, y: 0, width: current.width, height: current.height }];
  }
  const zones: PixelRegion[] = [
    { x: 0, y: 0, width: 960, height: 44 },
    { x: 0, y: 44, width: 660, height: 360 },
    { x: 660, y: 44, width: 300, height: 360 },
    { x: 0, y: 404, width: 960, height: 136 },
  ];
  return zones
    .map((zone) => changedPixelRegionWithin(previous, current, zone, 32, 12))
    .filter((region): region is PixelRegion => region !== null);
}

function pngBase64(canvas: HTMLCanvasElement): string {
  const encoded = canvas.toDataURL("image/png");
  const prefix = "data:image/png;base64,";
  if (!encoded.startsWith(prefix)) throw new Error("Canvas did not produce PNG data");
  return encoded.slice(prefix.length);
}

function packPixelRegions(
  pixels: ImageData,
  regions: readonly PixelRegion[],
): { canvas: HTMLCanvasElement; regions: PixelRegionMapping[] } | null {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(...regions.map((region) => region.width));
  canvas.height = regions.reduce((total, region) => total + region.height, 0);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  let imageY = 0;
  const mappings = regions.map((region) => {
    ctx.putImageData(
      pixels,
      -region.x,
      imageY - region.y,
      region.x,
      region.y,
      region.width,
      region.height,
    );
    const mapping = { ...region, imageX: 0, imageY };
    imageY += region.height;
    return mapping;
  });
  return { canvas, regions: mappings };
}

function captureBoard(project: Project, context: ReturnType<typeof getLiveEditorContext>) {
  let canvas = drawStateBoard(project, context, true);
  if (!canvas) return null;
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    // Force the browser's origin-clean check before memory is committed.
    pngBase64(canvas);
    return { canvas, pixels };
  } catch {
    // A cross-origin media frame can taint the composed canvas. Preserve the
    // safe project/timeline state board and replace only that preview tile.
    canvas = drawStateBoard(project, context, false);
    const ctx = canvas?.getContext("2d", { willReadFrequently: true });
    if (!canvas || !ctx) return null;
    return {
      canvas,
      pixels: ctx.getImageData(0, 0, canvas.width, canvas.height),
    };
  }
}

/**
 * Capture the current editor as either a full visual keyframe, one aligned
 * delta crop, or metadata only. Memory is scoped to the attached Agent session
 * so a newly attached Codex thread never receives an orphaned delta.
 */
export function captureConversationVisualState(
  sessionId: string,
): ConversationVisualStateCapture | undefined {
  const store = useProjectStore.getState();
  if (!store.hasOpenProject || typeof document === "undefined") return undefined;
  if (memory.sessionId !== sessionId) resetMemory(sessionId);

  const context = getLiveEditorContext();
  const semantic = semanticSnapshot(store.project, context);
  const changed = semanticChanges(memory.previousSemantic, semantic);
  const stateRef = `vs-${memory.sourceId}-${++memory.sequence}`;
  const baseRef = memory.previousRef ?? undefined;
  const captured = captureBoard(store.project, context);
  const common = {
    version: 1 as const,
    stateRef,
    ...(baseRef ? { baseRef } : {}),
    projectRevision: getProjectRevision(),
    contextRevision: context.contextRevision,
    playheadSeconds: Math.max(0, context.playheadSeconds ?? 0),
    selectedClipIds: [...context.selectedClipIds],
    selectedTextIds: [...context.selectedTextIds],
    selectedMediaIds: [...context.selectedMediaIds],
  };

  if (!captured) {
    memory.previousRef = stateRef;
    memory.previousSemantic = semantic;
    return { ...common, kind: "metadata", changed };
  }

  const projectChanged =
    !memory.previousSemantic || memory.previousSemantic.projectId !== semantic.projectId;
  const regions = memory.previousPixels
    ? changedPixelRegions(memory.previousPixels, captured.pixels)
    : [{ x: 0, y: 0, ...VISUAL_STATE_BOARD }];
  const previewChanged = regions.some(
    (region) =>
      region.x < 660 &&
      region.x + region.width > 0 &&
      region.y < 404 &&
      region.y + region.height > 44,
  );
  if (previewChanged && !changed.includes("preview")) changed.push("preview");

  const regionRatio =
    regions.reduce((area, region) => area + region.width * region.height, 0) /
    (VISUAL_STATE_BOARD.width * VISUAL_STATE_BOARD.height);
  const forceKeyframe =
    !memory.previousPixels ||
    projectChanged ||
    memory.imageDeltaCount >= VISUAL_STATE_KEYFRAME_INTERVAL ||
    regionRatio > 0.35;

  let result: ConversationVisualStateCapture;
  if (regions.length === 0) {
    result = { ...common, kind: "metadata", changed };
  } else if (forceKeyframe) {
    result = {
      ...common,
      kind: "keyframe",
      changed,
      imagePngBase64: pngBase64(captured.canvas),
      imageWidth: VISUAL_STATE_BOARD.width,
      imageHeight: VISUAL_STATE_BOARD.height,
    };
    memory.imageDeltaCount = 0;
  } else {
    const packed = packPixelRegions(captured.pixels, regions);
    if (!packed) {
      result = { ...common, kind: "metadata", changed };
    } else {
      result = {
        ...common,
        kind: "delta",
        changed,
        imagePngBase64: pngBase64(packed.canvas),
        imageWidth: packed.canvas.width,
        imageHeight: packed.canvas.height,
        regions: packed.regions,
      };
      memory.imageDeltaCount += 1;
    }
  }

  memory.previousRef = stateRef;
  memory.previousPixels = captured.pixels;
  memory.previousSemantic = semantic;
  return result;
}
