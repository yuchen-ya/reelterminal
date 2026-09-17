export type AspectRatioPreset =
  | "16:9"
  | "9:16"
  | "1:1"
  | "4:5"
  | "4:3"
  | "21:9"
  | "custom";

export type PlatformPreset =
  | "youtube"
  | "tiktok"
  | "instagram-reels"
  | "instagram-feed"
  | "instagram-stories"
  | "youtube-shorts"
  | "facebook"
  | "twitter"
  | "linkedin";

export interface AspectRatioConfig {
  name: string;
  ratio: number;
  width: number;
  height: number;
  platform?: PlatformPreset;
}

export const ASPECT_RATIO_PRESETS: Record<
  AspectRatioPreset,
  AspectRatioConfig
> = {
  "16:9": {
    name: "Landscape (16:9)",
    ratio: 16 / 9,
    width: 1920,
    height: 1080,
  },
  "9:16": { name: "Portrait (9:16)", ratio: 9 / 16, width: 1080, height: 1920 },
  "1:1": { name: "Square (1:1)", ratio: 1, width: 1080, height: 1080 },
  "4:5": { name: "Portrait (4:5)", ratio: 4 / 5, width: 1080, height: 1350 },
  "4:3": { name: "Classic (4:3)", ratio: 4 / 3, width: 1440, height: 1080 },
  "21:9": {
    name: "Cinematic (21:9)",
    ratio: 21 / 9,
    width: 2560,
    height: 1080,
  },
  custom: { name: "Custom", ratio: 16 / 9, width: 1920, height: 1080 },
};

export const PLATFORM_PRESETS: Record<PlatformPreset, AspectRatioConfig> = {
  youtube: {
    name: "YouTube",
    ratio: 16 / 9,
    width: 1920,
    height: 1080,
    platform: "youtube",
  },
  tiktok: {
    name: "TikTok",
    ratio: 9 / 16,
    width: 1080,
    height: 1920,
    platform: "tiktok",
  },
  "instagram-reels": {
    name: "Instagram Reels",
    ratio: 9 / 16,
    width: 1080,
    height: 1920,
    platform: "instagram-reels",
  },
  "instagram-feed": {
    name: "Instagram Feed",
    ratio: 1,
    width: 1080,
    height: 1080,
    platform: "instagram-feed",
  },
  "instagram-stories": {
    name: "Instagram Stories",
    ratio: 9 / 16,
    width: 1080,
    height: 1920,
    platform: "instagram-stories",
  },
  "youtube-shorts": {
    name: "YouTube Shorts",
    ratio: 9 / 16,
    width: 1080,
    height: 1920,
    platform: "youtube-shorts",
  },
  facebook: {
    name: "Facebook",
    ratio: 16 / 9,
    width: 1920,
    height: 1080,
    platform: "facebook",
  },
  twitter: {
    name: "Twitter/X",
    ratio: 16 / 9,
    width: 1920,
    height: 1080,
    platform: "twitter",
  },
  linkedin: {
    name: "LinkedIn",
    ratio: 16 / 9,
    width: 1920,
    height: 1080,
    platform: "linkedin",
  },
};

export interface DetectedFace {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

export interface ReframeKeyframe {
  time: number;
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
  scale: number;
}

export interface ReframeSettings {
  targetAspectRatio: AspectRatioPreset;
  customRatio?: number;
  trackingSpeed: number;
  padding: number;
  smoothing: number;
  followSubject: boolean;
  centerBias: number;
}

export const DEFAULT_REFRAME_SETTINGS: ReframeSettings = {
  targetAspectRatio: "9:16",
  trackingSpeed: 0.5,
  padding: 0.1,
  smoothing: 0.8,
  followSubject: true,
  centerBias: 0.3,
};

export interface ReframeResult {
  keyframes: ReframeKeyframe[];
  outputWidth: number;
  outputHeight: number;
  success: boolean;
  message?: string;
}

type ProgressCallback = (progress: number, message: string) => void;

export class AutoReframeEngine {
  private canvas: OffscreenCanvas | null = null;
  private ctx: OffscreenCanvasRenderingContext2D | null = null;
  private initialized = false;
  private faceCache: Map<number, DetectedFace[]> = new Map();

  async initialize(onProgress?: ProgressCallback): Promise<void> {
    if (this.initialized) return;

    onProgress?.(10, "Initializing auto-reframe engine...");

    this.canvas = new OffscreenCanvas(1920, 1080);
    this.ctx = this.canvas.getContext("2d");

    onProgress?.(100, "Auto-reframe engine ready");
    this.initialized = true;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async analyzeClip(
    frames: ImageBitmap[],
    frameRate: number,
    settings: ReframeSettings,
    onProgress?: ProgressCallback,
  ): Promise<ReframeResult> {
    if (!this.initialized || !this.ctx) {
      return {
        keyframes: [],
        outputWidth: 1920,
        outputHeight: 1080,
        success: false,
        message: "Engine not initialized",
      };
    }

    const targetConfig = this.getTargetConfig(settings);
    const keyframes: ReframeKeyframe[] = [];
    const sourceWidth = frames[0]?.width || 1920;
    const sourceHeight = frames[0]?.height || 1080;

    onProgress?.(0, "Analyzing video frames...");

    let lastCropX = 0;
    let lastCropY = 0;

    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      const time = i / frameRate;
      const progress = Math.round((i / frames.length) * 100);

      onProgress?.(progress, `Analyzing frame ${i + 1}/${frames.length}`);

      const faces = await this.detectFaces(frame, i);

      const crop = this.calculateOptimalCrop(
        sourceWidth,
        sourceHeight,
        targetConfig.ratio,
        faces,
        settings,
        lastCropX,
        lastCropY,
      );

      lastCropX = crop.x;
      lastCropY = crop.y;

      keyframes.push({
        time,
        cropX: crop.x,
        cropY: crop.y,
        cropWidth: crop.width,
        cropHeight: crop.height,
        scale: 1,
      });
    }

    const smoothedKeyframes = this.smoothKeyframes(
      keyframes,
      settings.smoothing,
    );

    onProgress?.(100, "Analysis complete");

    return {
      keyframes: smoothedKeyframes,
      outputWidth: targetConfig.width,
      outputHeight: targetConfig.height,
      success: true,
    };
  }

  async reframeFrame(
    frame: ImageBitmap,
    keyframe: ReframeKeyframe,
    outputWidth: number,
    outputHeight: number,
  ): Promise<ImageBitmap> {
    if (!this.ctx || !this.canvas) {
      return frame;
    }

    this.canvas.width = outputWidth;
    this.canvas.height = outputHeight;

    this.ctx.drawImage(
      frame,
      keyframe.cropX,
      keyframe.cropY,
      keyframe.cropWidth,
      keyframe.cropHeight,
      0,
      0,
      outputWidth,
      outputHeight,
    );

    return createImageBitmap(this.canvas);
  }

  private getTargetConfig(settings: ReframeSettings): AspectRatioConfig {
    if (settings.targetAspectRatio === "custom" && settings.customRatio) {
      const ratio = settings.customRatio;
      if (ratio >= 1) {
        return {
          name: "Custom",
          ratio,
          width: 1920,
          height: Math.round(1920 / ratio),
        };
      } else {
        return {
          name: "Custom",
          ratio,
          width: Math.round(1080 * ratio),
          height: 1080,
        };
      }
    }
    return ASPECT_RATIO_PRESETS[settings.targetAspectRatio];
  }

  private async detectFaces(
    frame: ImageBitmap,
    frameIndex: number,
  ): Promise<DetectedFace[]> {
    if (this.faceCache.has(frameIndex)) {
      return this.faceCache.get(frameIndex)!;
    }

    const faces = this.detectFacesSimple(frame);
    this.faceCache.set(frameIndex, faces);
    return faces;
  }

  private detectFacesSimple(frame: ImageBitmap): DetectedFace[] {
    if (!this.ctx || !this.canvas) return [];

    this.canvas.width = frame.width;
    this.canvas.height = frame.height;
    this.ctx.drawImage(frame, 0, 0);

    const imageData = this.ctx.getImageData(0, 0, frame.width, frame.height);
    const skinRegions = this.detectSkinRegions(imageData);

    if (skinRegions.length === 0) {
      return [
        {
          x: frame.width * 0.3,
          y: frame.height * 0.2,
          width: frame.width * 0.4,
          height: frame.height * 0.5,
          confidence: 0.3,
        },
      ];
    }

    return skinRegions.map((region) => ({
      x: region.x,
      y: region.y,
      width: region.width,
      height: region.height,
      confidence: region.confidence,
    }));
  }

  private detectSkinRegions(imageData: ImageData): DetectedFace[] {
    const { data, width, height } = imageData;
    const skinMap = new Uint8Array(width * height);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];

        if (this.isSkinColor(r, g, b)) {
          skinMap[y * width + x] = 1;
        }
      }
    }

    const regions = this.findConnectedRegions(skinMap, width, height);

    return regions
      .filter((r) => r.width > width * 0.05 && r.height > height * 0.05)
      .filter((r) => {
        const aspectRatio = r.width / r.height;
        return aspectRatio > 0.5 && aspectRatio < 2;
      })
      .slice(0, 3)
      .map((r) => ({ ...r, confidence: 0.7 }));
  }

  private isSkinColor(r: number, g: number, b: number): boolean {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);

    if (r <= 95 || g <= 40 || b <= 20) return false;
    if (max - min <= 15) return false;
    if (Math.abs(r - g) <= 15) return false;
    if (r <= g || r <= b) return false;
    if (r > 220 && g > 210 && b > 170) return false;

    return true;
  }

  private findConnectedRegions(
    skinMap: Uint8Array,
    width: number,
    height: number,
  ): Array<{ x: number; y: number; width: number; height: number }> {
    const visited = new Uint8Array(width * height);
    const regions: Array<{
      x: number;
      y: number;
      width: number;
      height: number;
    }> = [];
    const blockSize = 8;

    for (let by = 0; by < height; by += blockSize) {
      for (let bx = 0; bx < width; bx += blockSize) {
        const idx = by * width + bx;
        if (skinMap[idx] && !visited[idx]) {
          const region = this.floodFillRegion(
            skinMap,
            visited,
            width,
            height,
            bx,
            by,
            blockSize,
          );
          if (region) {
            regions.push(region);
          }
        }
      }
    }

    return regions;
  }

  private floodFillRegion(
    skinMap: Uint8Array,
    visited: Uint8Array,
    width: number,
    height: number,
    startX: number,
    startY: number,
    blockSize: number,
  ): { x: number; y: number; width: number; height: number } | null {
    let minX = startX,
      maxX = startX;
    let minY = startY,
      maxY = startY;
    let pixelCount = 0;

    const stack: Array<[number, number]> = [[startX, startY]];

    while (stack.length > 0) {
      const [x, y] = stack.pop()!;
      const idx = y * width + x;

      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      if (visited[idx] || !skinMap[idx]) continue;

      visited[idx] = 1;
      pixelCount++;

      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);

      stack.push([x + blockSize, y]);
      stack.push([x - blockSize, y]);
      stack.push([x, y + blockSize]);
      stack.push([x, y - blockSize]);
    }

    if (pixelCount < 10) return null;

    return {
      x: minX,
      y: minY,
      width: maxX - minX + blockSize,
      height: maxY - minY + blockSize,
    };
  }

  private calculateOptimalCrop(
    sourceWidth: number,
    sourceHeight: number,
    targetRatio: number,
    faces: DetectedFace[],
    settings: ReframeSettings,
    lastCropX: number,
    lastCropY: number,
  ): { x: number; y: number; width: number; height: number } {
    const sourceRatio = sourceWidth / sourceHeight;

    let cropWidth: number;
    let cropHeight: number;

    if (sourceRatio > targetRatio) {
      cropHeight = sourceHeight;
      cropWidth = cropHeight * targetRatio;
    } else {
      cropWidth = sourceWidth;
      cropHeight = cropWidth / targetRatio;
    }

    let targetX = (sourceWidth - cropWidth) / 2;
    let targetY = (sourceHeight - cropHeight) / 2;

    if (settings.followSubject && faces.length > 0) {
      const mainFace = faces.reduce((a, b) =>
        a.width * a.height * a.confidence > b.width * b.height * b.confidence
          ? a
          : b,
      );

      const faceCenterX = mainFace.x + mainFace.width / 2;
      const faceCenterY = mainFace.y + mainFace.height / 2;

      const paddingOffset = settings.padding * Math.min(cropWidth, cropHeight);

      targetX = faceCenterX - cropWidth / 2 + paddingOffset * 0;
      targetY = faceCenterY - cropHeight * 0.35;

      targetX =
        targetX * (1 - settings.centerBias) +
        ((sourceWidth - cropWidth) / 2) * settings.centerBias;
      targetY =
        targetY * (1 - settings.centerBias) +
        ((sourceHeight - cropHeight) / 2) * settings.centerBias;
    }

    targetX = Math.max(0, Math.min(targetX, sourceWidth - cropWidth));
    targetY = Math.max(0, Math.min(targetY, sourceHeight - cropHeight));

    if (lastCropX !== 0 || lastCropY !== 0) {
      const smoothFactor = settings.trackingSpeed;
      targetX = lastCropX + (targetX - lastCropX) * smoothFactor;
      targetY = lastCropY + (targetY - lastCropY) * smoothFactor;
    }

    return {
      x: Math.round(targetX),
      y: Math.round(targetY),
      width: Math.round(cropWidth),
      height: Math.round(cropHeight),
    };
  }

  private smoothKeyframes(
    keyframes: ReframeKeyframe[],
    smoothing: number,
  ): ReframeKeyframe[] {
    if (keyframes.length < 3 || smoothing === 0) return keyframes;

    const smoothed: ReframeKeyframe[] = [];
    const windowSize = Math.max(3, Math.round(smoothing * 10));

    for (let i = 0; i < keyframes.length; i++) {
      const start = Math.max(0, i - Math.floor(windowSize / 2));
      const end = Math.min(keyframes.length, i + Math.ceil(windowSize / 2));

      let sumX = 0,
        sumY = 0;
      let count = 0;

      for (let j = start; j < end; j++) {
        sumX += keyframes[j].cropX;
        sumY += keyframes[j].cropY;
        count++;
      }

      smoothed.push({
        ...keyframes[i],
        cropX: Math.round(sumX / count),
        cropY: Math.round(sumY / count),
      });
    }

    return smoothed;
  }

  getKeyframeAtTime(
    keyframes: ReframeKeyframe[],
    time: number,
  ): ReframeKeyframe {
    if (keyframes.length === 0) {
      return {
        time: 0,
        cropX: 0,
        cropY: 0,
        cropWidth: 1920,
        cropHeight: 1080,
        scale: 1,
      };
    }

    if (time <= keyframes[0].time) return keyframes[0];
    if (time >= keyframes[keyframes.length - 1].time)
      return keyframes[keyframes.length - 1];

    for (let i = 0; i < keyframes.length - 1; i++) {
      if (time >= keyframes[i].time && time < keyframes[i + 1].time) {
        const t =
          (time - keyframes[i].time) /
          (keyframes[i + 1].time - keyframes[i].time);
        return this.interpolateKeyframes(keyframes[i], keyframes[i + 1], t);
      }
    }

    return keyframes[keyframes.length - 1];
  }

  private interpolateKeyframes(
    a: ReframeKeyframe,
    b: ReframeKeyframe,
    t: number,
  ): ReframeKeyframe {
    const ease = t * t * (3 - 2 * t);
    return {
      time: a.time + (b.time - a.time) * t,
      cropX: Math.round(a.cropX + (b.cropX - a.cropX) * ease),
      cropY: Math.round(a.cropY + (b.cropY - a.cropY) * ease),
      cropWidth: Math.round(a.cropWidth + (b.cropWidth - a.cropWidth) * ease),
      cropHeight: Math.round(
        a.cropHeight + (b.cropHeight - a.cropHeight) * ease,
      ),
      scale: a.scale + (b.scale - a.scale) * ease,
    };
  }

  clearCache(): void {
    this.faceCache.clear();
  }

  dispose(): void {
    this.canvas = null;
    this.ctx = null;
    this.faceCache.clear();
    this.initialized = false;
  }
}

/* ------------------------------------------------------------------ */
/* Crop-keyframe → transform-keyframe conversion (pure, shared)        */
/* ------------------------------------------------------------------ */

/**
 * Upper bound on transform keyframes one reframe result may emit — the same
 * per-clip limit the facade's clip.setKeyframes op enforces and the renderer
 * evaluates per frame.
 */
export const MAX_REFRAME_TRANSFORM_KEYFRAMES = 100;

/** Source media dimensions the reframe crop rectangles are expressed in. */
export interface ReframeSourceInfo {
  readonly width: number;
  readonly height: number;
}

/**
 * Clip timing needed to fold analysis times onto the clip's own keyframe
 * clock: the renderer evaluates transform keyframes on clip-LOCAL timeline
 * time (see video-engine getAnimatedTransform), while analysis keyframe
 * times are source-media seconds measured from the extraction start (the
 * clip's in-point). At constant speed, local = source / speed.
 */
export interface ReframeClipTiming {
  /** Clip timeline duration in seconds (post-speed). */
  readonly duration: number;
  /** Playback speed (> 0); omitted or 1 means real time. */
  readonly speed?: number;
}

/**
 * One renderer-ready transform keyframe produced by the conversion. Four of
 * these (position.x/y, scale.x/y) are emitted per kept analysis keyframe,
 * all sharing the same folded time.
 */
export interface ReframeTransformKeyframe {
  readonly id: string;
  readonly property: "position.x" | "position.y" | "scale.x" | "scale.y";
  readonly time: number;
  readonly value: number;
  readonly easing: "linear";
}

/**
 * Downsample to exactly `max` entries; the first and the last entry of the
 * input always survive.
 */
function downsampleToCap<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  const stride = (items.length - 1) / (max - 1);
  const out: T[] = [];
  for (let index = 0; index < max; index++) {
    out.push(items[Math.round(index * stride)]!);
  }
  out[max - 1] = items[items.length - 1]!;
  return out;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * Convert an Auto Reframe analysis result (keyframed source-space crop
 * rectangles) into the transform keyframes the renderer actually consumes
 * through `clip.setKeyframes` / the core `keyframe/setAll` action.
 *
 * Math (matches drawFrameToContext's default "contain" fit with the default
 * center anchor): the frame is contain-fitted to the (already resized)
 * output canvas at fit size (fw, fh), scaled by k = fw/sourceWidth from
 * source pixels. Making the crop rect cover the canvas exactly therefore
 * needs:
 *   zoom    = outputWidth / cropWidth           (crop-width based fill)
 *   scale   = zoom * sourceWidth / fw           (ctx scale compensating fit)
 *   pos.x   = zoom * (sourceWidth/2 - cropCenterX)
 *   pos.y   = zoom * (sourceHeight/2 - cropCenterY)
 * The engine's crop always has the target ratio (cropWidth/cropHeight ==
 * outputWidth/outputHeight), so the same zoom fills vertically too; only
 * sub-pixel rounding from the engine's Math.round on the crop can remain.
 *
 * Assumes the clip's base transform is at its defaults (center anchor,
 * contain fit) — reframe composes a fresh position/scale animation and
 * replaces the clip's whole keyframe set via keyframe/setAll.
 *
 * Times are folded from the source clock to the clip-local keyframe clock
 * (analysis seconds / speed) and clamped to the clip duration. More than
 * {@link MAX_REFRAME_TRANSFORM_KEYFRAMES} / 4 analysis points are thinned
 * with first/last preserved.
 */
export function reframeKeyframesToTransformKeyframes(
  result: ReframeResult,
  source: ReframeSourceInfo,
  clip: ReframeClipTiming,
): ReframeTransformKeyframe[] {
  const { outputWidth, outputHeight } = result;
  if (
    outputWidth <= 0 ||
    outputHeight <= 0 ||
    source.width <= 0 ||
    source.height <= 0 ||
    result.keyframes.length === 0
  ) {
    return [];
  }

  const speed =
    clip.speed !== undefined && Number.isFinite(clip.speed) && clip.speed > 0
      ? clip.speed
      : 1;

  const sourceAspect = source.width / source.height;
  const canvasAspect = outputWidth / outputHeight;
  // Default "contain" fit dimensions (drawFrameToContext).
  const fitWidth =
    sourceAspect > canvasAspect
      ? outputWidth
      : outputHeight * sourceAspect;
  const fitHeight =
    sourceAspect > canvasAspect
      ? outputWidth / sourceAspect
      : outputHeight;
  const fitScaleX = fitWidth / source.width;
  const fitScaleY = fitHeight / source.height;

  const crops = downsampleToCap(
    result.keyframes,
    Math.max(1, Math.floor(MAX_REFRAME_TRANSFORM_KEYFRAMES / 4)),
  );

  const keyframes: ReframeTransformKeyframe[] = [];
  crops.forEach((crop, index) => {
    const zoom = outputWidth / Math.max(1e-6, crop.cropWidth);
    const scale = zoom / fitScaleX;
    const centerX = crop.cropX + crop.cropWidth / 2;
    const centerY = crop.cropY + crop.cropHeight / 2;
    const time = Math.min(
      clip.duration,
      Math.max(0, crop.time / speed),
    );

    const base = `reframe-${index}-`;
    keyframes.push(
      {
        id: `${base}position.x`,
        property: "position.x",
        time,
        value: round4(scale * (fitWidth / 2 - fitScaleX * centerX)),
        easing: "linear",
      },
      {
        id: `${base}position.y`,
        property: "position.y",
        time,
        value: round4(scale * (fitHeight / 2 - fitScaleY * centerY)),
        easing: "linear",
      },
      {
        id: `${base}scale.x`,
        property: "scale.x",
        time,
        value: round4(scale),
        easing: "linear",
      },
      {
        id: `${base}scale.y`,
        property: "scale.y",
        time,
        value: round4(scale),
        easing: "linear",
      },
    );
  });
  return keyframes;
}

let autoReframeEngineInstance: AutoReframeEngine | null = null;

export function getAutoReframeEngine(): AutoReframeEngine | null {
  return autoReframeEngineInstance;
}

export function initializeAutoReframeEngine(): AutoReframeEngine {
  if (!autoReframeEngineInstance) {
    autoReframeEngineInstance = new AutoReframeEngine();
  }
  return autoReframeEngineInstance;
}

export function disposeAutoReframeEngine(): void {
  if (autoReframeEngineInstance) {
    autoReframeEngineInstance.dispose();
    autoReframeEngineInstance = null;
  }
}
