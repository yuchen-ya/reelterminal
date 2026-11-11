import type { Subtitle } from "../types/timeline";
import { renderAnimatedCaption, type WordSegment } from "./caption-animation-renderer";

export const getActiveSubtitles = (
  subtitles: Subtitle[],
  currentTime: number,
): Subtitle[] => {
  return subtitles.filter((sub) => {
    return currentTime >= sub.startTime && currentTime < sub.endTime;
  });
};

export const renderSubtitleToCanvas = (
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  subtitle: Subtitle,
  canvasWidth: number,
  canvasHeight: number,
  currentTime?: number,
  layoutSize: { width: number; height: number } = {
    width: canvasWidth,
    height: canvasHeight,
  },
): void => {
  const { text, animationStyle, words } = subtitle;
  if (!text || text.trim().length === 0) return;

  const hasAnimation =
    animationStyle && animationStyle !== "none" && words && words.length > 0;
  const time = currentTime ?? subtitle.startTime;

  if (hasAnimation) {
    renderAnimatedSubtitle(
      ctx,
      subtitle,
      canvasWidth,
      canvasHeight,
      time,
      layoutSize,
    );
  } else {
    renderStaticSubtitle(ctx, subtitle, canvasWidth, canvasHeight, layoutSize);
  }
};

const renderStaticSubtitle = (
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  subtitle: Subtitle,
  canvasWidth: number,
  canvasHeight: number,
  layoutSize: { width: number; height: number },
): void => {
  const { text, style } = subtitle;

  ctx.save();

  // Subtitle styles live in project pixels. Scale the context so the rest
  // of the layout runs in layout space and rasterizes into the (possibly
  // downscaled) preview canvas — the same contract as the export renderer.
  ctx.scale(canvasWidth / layoutSize.width, canvasHeight / layoutSize.height);
  canvasWidth = layoutSize.width;
  canvasHeight = layoutSize.height;

  const fontSize = style?.fontSize || 24;
  const fontFamily = style?.fontFamily || "Inter";
  const color = style?.color || "#ffffff";
  const backgroundColor = style?.backgroundColor || "rgba(0, 0, 0, 0.7)";
  const position = style?.position || "bottom";

  ctx.font = `bold ${fontSize}px "${fontFamily}"`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const lines = text.split("\n");
  const lineHeight = fontSize * 1.3;
  const totalHeight = lines.length * lineHeight;

  let baseY: number;
  if (position === "top") {
    baseY = fontSize * 2;
  } else if (position === "center") {
    baseY = canvasHeight / 2 - totalHeight / 2;
  } else {
    baseY = canvasHeight - fontSize * 2 - totalHeight;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;

    const y = baseY + i * lineHeight + lineHeight / 2;
    const metrics = ctx.measureText(line);
    const bgWidth = metrics.width + 20;
    const bgHeight = lineHeight;

    ctx.fillStyle = backgroundColor;
    ctx.fillRect(
      canvasWidth / 2 - bgWidth / 2,
      y - bgHeight / 2,
      bgWidth,
      bgHeight,
    );

    ctx.fillStyle = color;
    ctx.fillText(line, canvasWidth / 2, y);
  }

  ctx.restore();
};

const renderAnimatedSubtitle = (
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  subtitle: Subtitle,
  canvasWidth: number,
  canvasHeight: number,
  currentTime: number,
  layoutSize: { width: number; height: number },
): void => {
  const frame = renderAnimatedCaption(subtitle, currentTime);

  if (!frame.visible || frame.segments.length === 0) {
    return;
  }

  ctx.save();

  // Same project-pixel layout contract as the static subtitle path: the
  // caption engine emits fontSize-relative offsets, which stay correct in
  // layout space while the context scale handles the raster downscale.
  ctx.scale(canvasWidth / layoutSize.width, canvasHeight / layoutSize.height);
  canvasWidth = layoutSize.width;
  canvasHeight = layoutSize.height;

  const style = subtitle.style;
  const fontSize = style?.fontSize || 24;
  const fontFamily = style?.fontFamily || "Inter";
  const baseColor = style?.color || "#ffffff";
  const backgroundColor = style?.backgroundColor || "rgba(0, 0, 0, 0.7)";
  const position = style?.position || "bottom";

  ctx.font = `bold ${fontSize}px "${fontFamily}"`;
  ctx.textBaseline = "middle";

  const lineHeight = fontSize * 1.3;

  let baseY: number;
  if (position === "top") {
    baseY = fontSize * 2 + lineHeight / 2;
  } else if (position === "center") {
    baseY = canvasHeight / 2;
  } else {
    baseY = canvasHeight - fontSize * 2 - lineHeight / 2;
  }

  const totalText = frame.segments.map((s) => s.text).join(" ");
  const totalWidth = ctx.measureText(totalText).width;
  const bgWidth = totalWidth + 30;
  const bgHeight = lineHeight + 10;

  ctx.fillStyle = backgroundColor;
  ctx.fillRect(
    canvasWidth / 2 - bgWidth / 2,
    baseY - bgHeight / 2,
    bgWidth,
    bgHeight,
  );

  let xOffset = canvasWidth / 2 - totalWidth / 2;

  for (const segment of frame.segments) {
    const segmentWidth = ctx.measureText(segment.text + " ").width;

    ctx.save();
    ctx.globalAlpha = segment.opacity;

    const centerX = xOffset + ctx.measureText(segment.text).width / 2;
    const centerY = baseY + segment.offsetY;

    ctx.translate(centerX, centerY);
    ctx.scale(segment.scale, segment.scale);
    ctx.translate(-centerX, -centerY);

    const segmentColor = getSegmentColor(
      segment,
      baseColor,
      style?.highlightColor,
    );
    ctx.fillStyle = segmentColor;
    ctx.textAlign = "left";
    ctx.fillText(segment.text, xOffset, baseY + segment.offsetY);

    ctx.restore();

    xOffset += segmentWidth;
  }

  ctx.restore();
};

const getSegmentColor = (
  segment: WordSegment,
  baseColor: string,
  highlightColor?: string,
): string => {
  if (segment.color) {
    if (segment.color.startsWith("linear-gradient")) {
      return highlightColor || "#ffff00";
    }
    if (segment.color === "transparent") {
      return "rgba(0,0,0,0)";
    }
    return segment.color;
  }

  switch (segment.style) {
    case "highlighted":
    case "active":
      return highlightColor || "#ffff00";
    case "hidden":
      return "rgba(0,0,0,0)";
    default:
      return baseColor;
  }
};
