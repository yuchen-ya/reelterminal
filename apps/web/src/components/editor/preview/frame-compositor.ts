import type {
  AdjustmentLayer,
  BlendMode,
  SegmentationResult,
  ShapeClip,
  StickerClip,
  SVGClip,
  TextClip,
  Track,
} from "@reelterminal/core";
import {
  createMotionAwareOcclusionMask,
  getBackgroundRemovalEngine,
  getPersonSegmentationEngine,
  getStabilizedTransform,
} from "@reelterminal/core";
import type { Renderer } from "@reelterminal/core";
import { getEffectsBridge } from "../../../bridges/effects-bridge";
import type { ClipTransform } from "./index";
import { clipBackgroundRemovalSettings } from "./background-removal-settings";
import {
  applyEffectsToFrame,
  applyEffectsToFrameCanvas,
  drawFrameWithTransform,
  renderShapeClipToCanvas,
  renderTextClipToCanvas,
} from "./index";

export interface GPULayer {
  bitmap: ImageBitmap;
  transform: ClipTransform;
}

export interface PreparedPreviewFrame {
  frame: ImageBitmap | HTMLCanvasElement | OffscreenCanvas;
  cleanup: () => void;
}

export type PreviewClip = Track["clips"][number];
export type PreviewFrameSource = Parameters<typeof drawFrameWithTransform>[1];
export type PreviewCompositeOperation =
  CanvasRenderingContext2D["globalCompositeOperation"];

export const adjustmentBlendOperation = (mode: BlendMode): PreviewCompositeOperation =>
  mode === "add" || mode === "linear-dodge"
    ? "lighter"
    : (mode as PreviewCompositeOperation);

export const applyPreviewAdjustmentLayers = async (
  canvas: OffscreenCanvas,
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  layers: readonly AdjustmentLayer[],
  time: number,
): Promise<boolean> => {
  let applied = false;
  const effectsBridge = getEffectsBridge();
  if (!effectsBridge.isInitialized()) return false;
  for (const layer of layers) {
    if (
      !layer.enabled ||
      layer.opacity <= 0 ||
      time < layer.startTime ||
      time >= layer.startTime + layer.duration
    ) continue;
    const effects = layer.effects.filter((effect) => effect.enabled !== false);
    if (effects.length === 0) continue;
    let source: ImageBitmap | null = null;
    let processed: ImageBitmap | null = null;
    try {
      source = await createImageBitmap(canvas);
      processed = await effectsBridge.processEffectList(source, effects);
      if (processed.width <= 0 || processed.height <= 0) continue;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity));
      ctx.globalCompositeOperation = adjustmentBlendOperation(layer.blendMode);
      ctx.drawImage(processed, 0, 0, canvas.width, canvas.height);
      ctx.restore();
      applied = true;
    } catch (error) {
      console.warn(`[Preview] Adjustment layer ${layer.id} failed:`, error);
    } finally {
      if (processed && processed !== source) processed.close();
      source?.close();
    }
  }
  return applied;
};

export const clipNeedsFrameProcessing = (clipId: string): boolean => {
  const bgEngine = getBackgroundRemovalEngine();
  if (
    bgEngine?.isInitialized() &&
    clipBackgroundRemovalSettings(clipId).enabled
  ) {
    return true;
  }

  const effectsBridge = getEffectsBridge();
  if (!effectsBridge.isInitialized()) {
    return false;
  }

  if (effectsBridge.getEffects(clipId).some((effect) => effect.enabled)) {
    return true;
  }

  return Object.keys(effectsBridge.getColorGrading(clipId)).length > 0;
};

export const clipCssFilterOnly = (clipId: string): string | null => {
  const bgEngine = getBackgroundRemovalEngine();
  if (
    bgEngine?.isInitialized() &&
    clipBackgroundRemovalSettings(clipId).enabled
  ) {
    return null;
  }
  const effectsBridge = getEffectsBridge();
  if (!effectsBridge.isInitialized()) {
    return null;
  }
  return effectsBridge.getNativeCssFilter(clipId);
};

export const preparePreviewFrame = async (
  clipId: string,
  frameCanvas: HTMLCanvasElement | OffscreenCanvas,
  preferBitmap: boolean,
  allowCanvasByRef = false,
): Promise<PreparedPreviewFrame> => {
  const needsProcessing = clipNeedsFrameProcessing(clipId);
  if (!preferBitmap && !needsProcessing) {
    return {
      frame: frameCanvas,
      cleanup: () => {},
    };
  }

  let frameBitmap: ImageBitmap | null = null;
  let processedFrame: ImageBitmap | null = null;

  try {
    frameBitmap = await createImageBitmap(frameCanvas);

    if (!needsProcessing) {
      return {
        frame: frameBitmap,
        cleanup: () => {
          frameBitmap?.close();
        },
      };
    }

    if (allowCanvasByRef) {
      const effectsCanvas = await applyEffectsToFrameCanvas(
        clipId,
        frameBitmap,
      );
      if (effectsCanvas) {
        const sourceBitmap = frameBitmap;
        return {
          frame: effectsCanvas,
          cleanup: () => {
            sourceBitmap.close();
          },
        };
      }
    }

    processedFrame = await applyEffectsToFrame(clipId, frameBitmap);
    if (processedFrame === frameBitmap) {
      return {
        frame: frameBitmap,
        cleanup: () => {
          frameBitmap?.close();
        },
      };
    }

    return {
      frame: processedFrame,
      cleanup: () => {
        processedFrame?.close();
        frameBitmap?.close();
      },
    };
  } catch {
    processedFrame?.close();
    frameBitmap?.close();

    return {
      frame: frameCanvas,
      cleanup: () => {},
    };
  }
};

export const scaleTransformPositionForPreview = (
  transform: ClipTransform,
  scale: number,
): ClipTransform => {
  if (scale === 1) {
    return transform;
  }
  return {
    ...transform,
    position: {
      x: transform.position.x * scale,
      y: transform.position.y * scale,
    },
  };
};

// The rendered project frame is letterboxed ("contain") inside the canvas
// element. Returns the content rect (CSS px, relative to the element's
// top-left) that maps 1:1 onto the project frame, so pointer coordinates can
// be normalized against the frame — the same geometry the selection bounds
// helpers compute inline.
export const projectFrameContentRect = (
  frameWidth: number,
  frameHeight: number,
  elementWidth: number,
  elementHeight: number,
): { x: number; y: number; width: number; height: number } => {
  const frameAspect = frameWidth / frameHeight;
  const elementAspect = elementWidth / elementHeight;
  if (elementAspect > frameAspect) {
    const width = elementHeight * frameAspect;
    return { x: (elementWidth - width) / 2, y: 0, width, height: elementHeight };
  }
  const height = elementWidth / frameAspect;
  return { x: 0, y: (elementHeight - height) / 2, width: elementWidth, height };
};

export const applyStabilizationTransform = (
  clip: Track["clips"][number],
  transform: ClipTransform,
  sourceTime: number,
  canvasWidth: number,
  canvasHeight: number,
  frameWidth: number,
  frameHeight: number,
): ClipTransform => {
  return getStabilizedTransform(
    clip,
    transform,
    sourceTime,
    {
      canvasWidth,
      canvasHeight,
      sourceWidth: frameWidth,
      sourceHeight: frameHeight,
    },
  ) as ClipTransform;
};

// The WebGPU renderer maps a layer's texture onto a full-canvas quad, so a
// scale of {1,1} stretches the source to the canvas. Bake the aspect-fit
// ratio into the layer scale so GPU compositing letterboxes ("contain") like
// the Canvas2D path instead of distorting mismatched-aspect clips.
export const computeFitScale = (
  fitMode: ClipTransform["fitMode"],
  sourceWidth: number,
  sourceHeight: number,
  canvasWidth: number,
  canvasHeight: number,
): { x: number; y: number } => {
  const mode = !fitMode || fitMode === "none" ? "contain" : fitMode;
  if (
    mode === "stretch" ||
    sourceWidth <= 0 ||
    sourceHeight <= 0 ||
    canvasWidth <= 0 ||
    canvasHeight <= 0
  ) {
    return { x: 1, y: 1 };
  }
  const sourceAspect = sourceWidth / sourceHeight;
  const canvasAspect = canvasWidth / canvasHeight;
  let drawWidth: number;
  let drawHeight: number;
  if (mode === "cover") {
    if (sourceAspect > canvasAspect) {
      drawHeight = canvasHeight;
      drawWidth = canvasHeight * sourceAspect;
    } else {
      drawWidth = canvasWidth;
      drawHeight = canvasWidth / sourceAspect;
    }
  } else {
    if (sourceAspect > canvasAspect) {
      drawWidth = canvasWidth;
      drawHeight = canvasWidth / sourceAspect;
    } else {
      drawHeight = canvasHeight;
      drawWidth = canvasHeight * sourceAspect;
    }
  }
  return { x: drawWidth / canvasWidth, y: drawHeight / canvasHeight };
};

// Draws `source` cover-fit and Gaussian-blurred across the whole canvas — the
// blurred letterbox backdrop. Called inline with the live decoded base frame
// (ImageBitmap or video element) so it always has real pixels, then the
// contained clip is drawn on top.
export const drawBlurredBackdrop = (
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  source: HTMLVideoElement | HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
): void => {
  if (sourceWidth <= 0 || sourceHeight <= 0) return;
  const sourceAspect = sourceWidth / sourceHeight;
  const canvasAspect = width / height;
  let drawWidth = width;
  let drawHeight = height;
  if (sourceAspect > canvasAspect) {
    drawHeight = height;
    drawWidth = height * sourceAspect;
  } else {
    drawWidth = width;
    drawHeight = width / sourceAspect;
  }
  const drawX = (width - drawWidth) / 2;
  const drawY = (height - drawHeight) / 2;
  const blurPx = Math.max(Math.min(width, height) / 32, 8);
  ctx.save();
  ctx.filter = `blur(${blurPx}px)`;
  ctx.drawImage(source, drawX, drawY, drawWidth, drawHeight);
  ctx.restore();
};

export const renderFrameWithGPU = async (
  renderer: Renderer,
  frame: ImageBitmap,
  transform: ClipTransform,
  canvasWidth: number,
  canvasHeight: number,
): Promise<ImageBitmap | null> => {
  try {
    const device = renderer.getDevice();
    if (!device) {
      return null;
    }

    renderer.beginFrame();

    const texture = renderer.createTextureFromImage(frame);

    const fitScale = computeFitScale(
      transform.fitMode,
      frame.width,
      frame.height,
      canvasWidth,
      canvasHeight,
    );
    const gpuTransform = {
      position: transform.position,
      scale: {
        x: transform.scale.x * fitScale.x,
        y: transform.scale.y * fitScale.y,
      },
      rotation: transform.rotation,
      anchor: transform.anchor,
      opacity: transform.opacity,
      borderRadius: transform.borderRadius,
    };

    renderer.renderLayer({
      texture,
      transform: gpuTransform,
      effects: [],
      opacity: transform.opacity,
      borderRadius: transform.borderRadius || 0,
    });

    const result = await renderer.endFrame();
    renderer.releaseTexture(texture);

    return result;
  } catch {
    return null;
  }
};

export const renderAllLayersWithGPU = async (
  renderer: Renderer,
  layers: GPULayer[],
  canvasWidth: number,
  canvasHeight: number,
): Promise<ImageBitmap | null> => {
  try {
    const device = renderer.getDevice();

    if (!device || layers.length === 0) {
      return null;
    }

    renderer.beginFrame();

    const textures: ReturnType<typeof renderer.createTextureFromImage>[] = [];

    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];

      const texture = renderer.createTextureFromImage(layer.bitmap);
      textures.push(texture);

      const fitScale = computeFitScale(
        layer.transform.fitMode,
        layer.bitmap.width,
        layer.bitmap.height,
        canvasWidth,
        canvasHeight,
      );
      const gpuTransform = {
        position: layer.transform.position,
        scale: {
          x: layer.transform.scale.x * fitScale.x,
          y: layer.transform.scale.y * fitScale.y,
        },
        rotation: layer.transform.rotation,
        anchor: layer.transform.anchor,
        opacity: layer.transform.opacity,
        borderRadius: layer.transform.borderRadius,
      };

      renderer.renderLayer({
        texture,
        transform: gpuTransform,
        effects: [],
        opacity: layer.transform.opacity,
        borderRadius: layer.transform.borderRadius || 0,
      });
    }

    const result = await renderer.endFrame();

    for (const texture of textures) {
      renderer.releaseTexture(texture);
    }

    return result;
  } catch (e) {
    console.error("[renderAllLayersWithGPU] Error:", e);
    return null;
  }
};

export const hasBehindSubjectText = (textClips: TextClip[]): boolean =>
  textClips.some((textClip) => textClip.behindSubject);

export const getBehindSubjectStreamId = (
  tracks: readonly Track[],
  time: number,
): string => {
  const activeSourceIds = tracks
    .filter(
      (track) =>
        (track.type === "video" || track.type === "image") && !track.hidden,
    )
    .flatMap((track) =>
      track.clips
        .filter(
          (clip) =>
            time >= clip.startTime && time < clip.startTime + clip.duration,
        )
        .map((clip) => clip.id),
    )
    .sort();
  return `editor:text-behind-subject:${activeSourceIds.join("|") || "canvas"}`;
};

export const subjectMaskRequestCache = new WeakMap<
  ImageBitmap,
  Map<string, Promise<SegmentationResult | null>>
>();
export const subjectOcclusionMaskCache = new WeakMap<
  ImageBitmap,
  WeakMap<SegmentationResult, ImageData>
>();

export const getSubjectMaskForFrame = (
  subjectFrame: ImageBitmap,
  time: number,
  realtime: boolean,
  streamId: string,
): Promise<SegmentationResult | null> => {
  let requests = subjectMaskRequestCache.get(subjectFrame);
  if (!requests) {
    requests = new Map();
    subjectMaskRequestCache.set(subjectFrame, requests);
  }
  const key = `${streamId}:${time}:${Number(realtime)}`;
  const cached = requests.get(key);
  if (cached) return cached;
  const request = getPersonSegmentationEngine().getPersonMask(subjectFrame, {
    timestampMs: time * 1000,
    streamId,
    realtime,
  });
  requests.set(key, request);
  return request;
};

export const createTransparentCanvasSource = (
  width: number,
  height: number,
): HTMLCanvasElement => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")?.clearRect(0, 0, width, height);
  return canvas;
};

export const createTransparentImageBitmap = async (
  width: number,
  height: number,
): Promise<ImageBitmap | null> => {
  try {
    return await createImageBitmap(createTransparentCanvasSource(width, height));
  } catch {
    return null;
  }
};

export const captureSubjectFrame = async (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): Promise<ImageBitmap | null> => {
  try {
    return await createImageBitmap(
      ctx.canvas as HTMLCanvasElement | OffscreenCanvas,
      0,
      0,
      width,
      height,
    );
  } catch {
    return null;
  }
};

export const applySubjectOcclusionMask = (
  textCtx: CanvasRenderingContext2D,
  subjectFrame: ImageBitmap | null,
  canvasWidth: number,
  canvasHeight: number,
  maskResult: SegmentationResult | null,
): boolean => {
  if (!subjectFrame || !maskResult) return false;

  try {
    const maskCanvas = new OffscreenCanvas(maskResult.width, maskResult.height);
    const maskCtx = maskCanvas.getContext("2d");
    if (!maskCtx) return false;

    let occlusionMask = subjectOcclusionMaskCache
      .get(subjectFrame)
      ?.get(maskResult);
    if (!occlusionMask) {
      occlusionMask = maskResult.mask;
    }
    if (
      !subjectOcclusionMaskCache.get(subjectFrame)?.has(maskResult) &&
      maskResult.referenceWidth > 0 &&
      maskResult.referenceHeight > 0 &&
      maskResult.referenceRgba.length ===
        maskResult.referenceWidth * maskResult.referenceHeight * 4
    ) {
      try {
        const currentReferenceCanvas = new OffscreenCanvas(
          maskResult.referenceWidth,
          maskResult.referenceHeight,
        );
        const currentReferenceCtx = currentReferenceCanvas.getContext("2d", {
          willReadFrequently: true,
        });
        if (currentReferenceCtx) {
          currentReferenceCtx.drawImage(
            subjectFrame,
            0,
            0,
            maskResult.referenceWidth,
            maskResult.referenceHeight,
          );
          const currentRgba = currentReferenceCtx.getImageData(
            0,
            0,
            maskResult.referenceWidth,
            maskResult.referenceHeight,
          ).data;
          const motionAwareMaskRgba = createMotionAwareOcclusionMask(
            maskResult.mask.data,
            maskResult.width,
            maskResult.height,
            maskResult.referenceRgba,
            currentRgba,
            maskResult.referenceWidth,
            maskResult.referenceHeight,
          );
          occlusionMask = new ImageData(maskResult.width, maskResult.height);
          occlusionMask.data.set(motionAwareMaskRgba);
        }
      } catch {
        // Keep using the exact matte if frame readback or motion estimation
        // fails. Dropping the whole text layer here creates a visible blink.
        occlusionMask = maskResult.mask;
      }
    }

    let frameMasks = subjectOcclusionMaskCache.get(subjectFrame);
    if (!frameMasks) {
      frameMasks = new WeakMap();
      subjectOcclusionMaskCache.set(subjectFrame, frameMasks);
    }
    frameMasks.set(maskResult, occlusionMask);

    maskCtx.putImageData(occlusionMask, 0, 0);
    textCtx.save();
    textCtx.globalCompositeOperation = "destination-out";
    textCtx.imageSmoothingEnabled = true;
    textCtx.imageSmoothingQuality = "high";
    textCtx.drawImage(maskCanvas, 0, 0, canvasWidth, canvasHeight);
    textCtx.restore();
    return true;
  } catch {
    return false;
  }
};

export const renderOverlayLayerWithEffects = async (
  ctx: CanvasRenderingContext2D,
  clipId: string,
  canvasWidth: number,
  canvasHeight: number,
  render: (layerCtx: CanvasRenderingContext2D) => void | Promise<void>,
): Promise<void> => {
  if (!clipNeedsFrameProcessing(clipId)) {
    await render(ctx);
    return;
  }
  const layerCanvas = document.createElement("canvas");
  layerCanvas.width = canvasWidth;
  layerCanvas.height = canvasHeight;
  const layerCtx = layerCanvas.getContext("2d");
  if (!layerCtx) return;
  await render(layerCtx);
  const prepared = await preparePreviewFrame(
    clipId,
    layerCanvas,
    false,
    true,
  );
  try {
    ctx.drawImage(prepared.frame, 0, 0, canvasWidth, canvasHeight);
  } finally {
    prepared.cleanup();
  }
};

export const renderShapeClipWithEffects = async (
  ctx: CanvasRenderingContext2D,
  shapeClip: ShapeClip | SVGClip | StickerClip,
  canvasWidth: number,
  canvasHeight: number,
  time: number,
): Promise<void> => {
  await renderOverlayLayerWithEffects(
    ctx,
    shapeClip.id,
    canvasWidth,
    canvasHeight,
    (layerCtx) =>
      renderShapeClipToCanvas(
        layerCtx,
        shapeClip,
        canvasWidth,
        canvasHeight,
        time,
      ),
  );
};

export const renderTextClipWithSubjectMask = async (
  ctx: CanvasRenderingContext2D,
  textClip: TextClip,
  canvasWidth: number,
  canvasHeight: number,
  time: number,
  subjectFrame: ImageBitmap | null,
  realtime = true,
  streamId = "editor:text-behind-subject:canvas",
): Promise<void> => {
  let subjectMask: SegmentationResult | null = null;
  if (textClip.behindSubject && subjectFrame) {
    const segEngine = getPersonSegmentationEngine();
    if (segEngine.isInitialized()) {
      subjectMask = await getSubjectMaskForFrame(
        subjectFrame,
        time,
        realtime,
        streamId,
      );
    }
    // During the worker's first realtime inference, keep the text hidden
    // instead of flashing it in front of the subject for one or two frames.
    if (!subjectMask && realtime) return;
  }

  const renderTextLayer = (targetCtx: CanvasRenderingContext2D) =>
    renderOverlayLayerWithEffects(
      targetCtx,
      textClip.id,
      canvasWidth,
      canvasHeight,
      (layerCtx) =>
        renderTextClipToCanvas(
          layerCtx,
          textClip,
          canvasWidth,
          canvasHeight,
          time,
        ),
    );

  if (!textClip.behindSubject || !subjectFrame || !subjectMask) {
    await renderTextLayer(ctx);
    return;
  }

  const textLayerCanvas = document.createElement("canvas");
  textLayerCanvas.width = canvasWidth;
  textLayerCanvas.height = canvasHeight;
  const textLayerCtx = textLayerCanvas.getContext("2d");
  if (!textLayerCtx) return;
  await renderTextLayer(textLayerCtx);
  if (
    !applySubjectOcclusionMask(
      textLayerCtx,
      subjectFrame,
      canvasWidth,
      canvasHeight,
      subjectMask,
    )
  ) {
    return;
  }
  ctx.drawImage(textLayerCanvas, 0, 0, canvasWidth, canvasHeight);
};
