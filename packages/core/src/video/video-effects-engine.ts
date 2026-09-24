import type { Effect } from "../types/timeline";
import type { Renderer } from "./renderer-factory";
import { MotionShaderRenderer } from "../motion/motion-shader-renderer";
import { getMotionShaderDef } from "../motion/shaders";
import type { MotionShaderDef } from "../motion/shaders";

interface ResolvedShaderEffect {
  readonly def: MotionShaderDef;
  readonly params: Record<string, number | string>;
  readonly time: number;
}

function readShaderTime(params: Record<string, unknown>): number {
  const raw = params.time;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

function readShaderParamValue(raw: unknown): number | string | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") return raw;
  return undefined;
}

function readEffectNumber(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
}

export interface FilterResult {
  image: ImageBitmap;
  processingTime: number;
  gpuAccelerated: boolean;
}

export interface OrderedEffect extends Effect {
  orderIndex: number;
}

export interface VideoEffectsConfig {
  width: number;
  height: number;
  useGPU?: boolean;
  preferWebGPU?: boolean;
}

interface ShaderProgram {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation>;
  attributes: Map<string, number>;
}

export type FilterType =
  | "brightness"
  | "contrast"
  | "saturation"
  | "hue"
  | "blur"
  | "sharpen"
  | "vignette"
  | "grain"
  | "chromaKey"
  | "temperature"
  | "tint"
  | "tonal"
  | "shadow"
  | "glow"
  | "motion-blur"
  | "radial-blur"
  | "chromatic-aberration";

export class VideoEffectsEngine {
  private canvas: OffscreenCanvas | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private shaders: Map<FilterType | "passthrough", ShaderProgram> = new Map();
  private quadBuffer: WebGLBuffer | null = null;
  private texCoordBuffer: WebGLBuffer | null = null;
  private framebuffers: WebGLFramebuffer[] = [];
  private renderTextures: WebGLTexture[] = [];
  private width: number;
  private height: number;
  private initialized = false;
  private initializing = false;
  private initPromise: Promise<boolean> | null = null;

  // New WebGPU renderer (introspection only; effects render on CPU)
  private renderer: Renderer | null = null;
  private useNewRenderer = false;

  // Reusable CPU-effects canvas (FX3): avoids per-frame OffscreenCanvas allocation
  private _fxCanvas: OffscreenCanvas | null = null;
  private _fxCtx: OffscreenCanvasRenderingContext2D | null = null;
  private _fxScratchCanvas: OffscreenCanvas | null = null;
  private _fxScratchCtx: OffscreenCanvasRenderingContext2D | null = null;
  private _shaderAlphaCanvas: OffscreenCanvas | null = null;
  private _shaderAlphaCtx: OffscreenCanvasRenderingContext2D | null = null;

  private _shaderRenderer: MotionShaderRenderer | null = null;

  constructor(config: VideoEffectsConfig) {
    this.width = config.width;
    this.height = config.height;
  }

  async initialize(): Promise<boolean> {
    if (this.initialized) return true;

    if (this.initializing && this.initPromise) {
      return this.initPromise;
    }

    this.initializing = true;
    this.initPromise = this.doInitialize();

    try {
      const result = await this.initPromise;
      this.initialized = result;
      return result;
    } finally {
      this.initializing = false;
    }
  }

  private async doInitialize(): Promise<boolean> {
    // Effects always render through the CPU (Canvas2D) path; the GPU
    // pipelines that this init used to feed were dead payload.
    return true;
  }

  async applyEffects(
    image: ImageBitmap,
    effects: Effect[],
  ): Promise<FilterResult> {
    const startTime = performance.now();
    const enabledEffects = effects.filter((e) => e.enabled);
    if (enabledEffects.length === 0) {
      return {
        image: await createImageBitmap(image),
        processingTime: performance.now() - startTime,
        gpuAccelerated: false,
      };
    }

    // Use CPU processing (Canvas2D filters) - reliable and fast for most effects
    // WebGPU effects pipeline has rendering issues, using CPU for now
    const result = await this.applyEffectsCPU(image, enabledEffects);
    return {
      image: result,
      processingTime: performance.now() - startTime,
      gpuAccelerated: false,
    };
  }

  /**
   * Applies effects using Canvas 2D CPU rendering (fallback from GPU).
   * Optimization: Split effects into two categories:
   * 1. CSS filters (brightness, contrast, hue, blur, saturate): hardware-accelerated by browsers
   * 2. Pixel-level effects (sharpen, vignette, grain, chroma-key): require manual pixel manipulation
   *
   * This avoids manual pixel manipulation for simple effects while supporting complex ones.
   * CSS filters are chained in one drawImage call for efficiency.
   */
  private getFxContext(
    width: number,
    height: number,
  ): OffscreenCanvasRenderingContext2D {
    if (
      !this._fxCanvas ||
      !this._fxCtx ||
      VideoEffectsEngine.needsResize(this._fxCanvas, width, height)
    ) {
      const canvas = this._fxCanvas ?? new OffscreenCanvas(width, height);
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        throw new Error("Failed to acquire 2D context for CPU effects");
      }
      this._fxCanvas = canvas;
      this._fxCtx = ctx;
    }

    return this._fxCtx;
  }

  private getFxScratchContext(
    width: number,
    height: number,
  ): OffscreenCanvasRenderingContext2D {
    if (
      !this._fxScratchCanvas ||
      !this._fxScratchCtx ||
      VideoEffectsEngine.needsResize(this._fxScratchCanvas, width, height)
    ) {
      const canvas = this._fxScratchCanvas ?? new OffscreenCanvas(width, height);
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        throw new Error("Failed to acquire scratch context for ordered effects");
      }
      this._fxScratchCanvas = canvas;
      this._fxScratchCtx = ctx;
    }
    return this._fxScratchCtx;
  }

  static needsResize(
    canvas: OffscreenCanvas,
    width: number,
    height: number,
  ): boolean {
    return canvas.width !== width || canvas.height !== height;
  }

  private categorizeEffects(effects: Effect[]): {
    cssFilters: string[];
    pixelEffects: Effect[];
  } {
    const cssFilters: string[] = [];
    const pixelEffects: Effect[] = [];

    for (const effect of effects) {
      const filterString = this.buildCSSFilter(effect);
      if (filterString) {
        cssFilters.push(filterString);
      } else {
        pixelEffects.push(effect);
      }
    }

    return { cssFilters, pixelEffects };
  }

  hasPixelLevelEffects(effects: Effect[]): boolean {
    for (const effect of effects) {
      if (!this.buildCSSFilter(effect)) {
        return true;
      }
    }
    return false;
  }

  getCssFilterString(effects: Effect[]): string | null {
    const enabledEffects = effects.filter((effect) => effect.enabled);
    const { cssFilters, pixelEffects } = this.categorizeEffects(enabledEffects);
    if (pixelEffects.length > 0) {
      return null;
    }
    if (cssFilters.length === 0) {
      return null;
    }
    return cssFilters.join(" ");
  }

  private static isShaderEffect(effect: Effect): boolean {
    return effect.type === "shader";
  }

  private resolveShaderEffect(effect: Effect): ResolvedShaderEffect | null {
    if (!VideoEffectsEngine.isShaderEffect(effect)) return null;
    const params = effect.params as Record<string, unknown>;
    const shaderId = params.shaderId;
    if (typeof shaderId !== "string" || shaderId.length === 0) return null;
    const def = getMotionShaderDef(shaderId);
    if (!def || def.category !== "effect") return null;

    const resolvedParams: Record<string, number | string> = {};
    for (const paramDef of def.params) {
      const value = readShaderParamValue(params[paramDef.name]);
      resolvedParams[paramDef.name] =
        value === undefined ? paramDef.default : value;
    }

    return { def, params: resolvedParams, time: readShaderTime(params) };
  }

  private applyShaderEffect(
    ctx: OffscreenCanvasRenderingContext2D,
    canvas: OffscreenCanvas,
    resolved: ResolvedShaderEffect,
    width: number,
    height: number,
  ): void {
    if (!MotionShaderRenderer.isSupported()) return;
    if (!this._shaderRenderer) {
      this._shaderRenderer = new MotionShaderRenderer();
    }
    if (
      !this._shaderAlphaCanvas ||
      !this._shaderAlphaCtx ||
      VideoEffectsEngine.needsResize(this._shaderAlphaCanvas, width, height)
    ) {
      const alphaCanvas =
        this._shaderAlphaCanvas ?? new OffscreenCanvas(width, height);
      alphaCanvas.width = width;
      alphaCanvas.height = height;
      const alphaCtx = alphaCanvas.getContext("2d");
      if (!alphaCtx) return;
      this._shaderAlphaCanvas = alphaCanvas;
      this._shaderAlphaCtx = alphaCtx;
    }
    const alphaCtx = this._shaderAlphaCtx;
    alphaCtx.save();
    alphaCtx.setTransform(1, 0, 0, 1, 0, 0);
    alphaCtx.globalCompositeOperation = "copy";
    alphaCtx.filter = "none";
    alphaCtx.drawImage(canvas, 0, 0, width, height);
    alphaCtx.restore();
    const result = this._shaderRenderer.render(resolved.def, {
      width,
      height,
      time: resolved.time,
      params: resolved.params,
      inputCanvas: canvas,
    });
    if (!result) return;
    ctx.save();
    ctx.filter = "none";
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(result, 0, 0, width, height);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(this._shaderAlphaCanvas, 0, 0, width, height);
    ctx.restore();
  }

  private async renderEffectsOntoFxCanvas(
    image: ImageBitmap,
    effects: Effect[],
  ): Promise<OffscreenCanvas> {
    const width = image.width;
    const height = image.height;
    const ctx = this.getFxContext(width, height);

    ctx.filter = "none";
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0);

    // Preserve authored stack order. Adjacent CSS filters may be safely fused,
    // but pixel and shader passes form ordering boundaries and must see the
    // output of every preceding effect.
    let pendingCssFilters: string[] = [];
    const flushCssFilters = (): void => {
      if (pendingCssFilters.length === 0) return;
      this.applyCssFilterBatch(ctx, pendingCssFilters, width, height);
      pendingCssFilters = [];
    };

    for (const effect of effects) {
      const cssFilter = this.buildCSSFilter(effect);
      if (cssFilter) {
        pendingCssFilters.push(cssFilter);
        continue;
      }

      flushCssFilters();
      if (VideoEffectsEngine.isShaderEffect(effect)) {
        const resolved = this.resolveShaderEffect(effect);
        if (resolved) {
          this.applyShaderEffect(ctx, ctx.canvas, resolved, width, height);
        }
      } else {
        await this.applyEffectPixelLevel(ctx, effect, width, height);
      }
    }
    flushCssFilters();

    return ctx.canvas;
  }

  private applyCssFilterBatch(
    ctx: OffscreenCanvasRenderingContext2D,
    filters: readonly string[],
    width: number,
    height: number,
  ): void {
    const scratch = this.getFxScratchContext(width, height);
    scratch.save();
    scratch.setTransform(1, 0, 0, 1, 0, 0);
    scratch.globalCompositeOperation = "copy";
    scratch.filter = filters.join(" ");
    scratch.drawImage(ctx.canvas, 0, 0, width, height);
    scratch.restore();

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "copy";
    ctx.filter = "none";
    ctx.drawImage(scratch.canvas, 0, 0, width, height);
    ctx.restore();
  }

  private async applyEffectsCPU(
    image: ImageBitmap,
    effects: Effect[],
  ): Promise<ImageBitmap> {
    const canvas = await this.renderEffectsOntoFxCanvas(image, effects);
    return createImageBitmap(canvas);
  }

  async applyEffectsToCanvas(
    image: ImageBitmap,
    effects: Effect[],
  ): Promise<OffscreenCanvas | null> {
    const enabledEffects = effects.filter((e) => e.enabled);
    if (enabledEffects.length === 0) {
      return null;
    }
    return this.renderEffectsOntoFxCanvas(image, enabledEffects);
  }

  private async applyEffectPixelLevel(
    ctx: OffscreenCanvasRenderingContext2D,
    effect: Effect,
    width: number,
    height: number,
  ): Promise<void> {
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    const params = effect.params as Record<string, unknown>;

    switch (effect.type) {
      case "sharpen": {
        const amount = readEffectNumber(params.amount, 0);
        this.applySharpenKernel(data, width, height, amount);
        break;
      }
      case "vignette": {
        const vigAmount = readEffectNumber(params.amount, 0);
        const midpoint = readEffectNumber(params.midpoint, 0.5);
        const feather = readEffectNumber(params.feather, 0.3);
        this.applyVignette(data, width, height, vigAmount, midpoint, feather);
        break;
      }
      case "grain": {
        const grainAmount = readEffectNumber(params.amount, 0);
        this.applyGrain(data, grainAmount);
        break;
      }
      case "chromaKey": {
        const keyColor = params.keyColor as
          | { r: number; g: number; b: number }
          | undefined;
        const tolerance = readEffectNumber(params.tolerance, 0.3);
        const softness = readEffectNumber(params.edgeSoftness, 0.1);
        const spillSuppression = readEffectNumber(params.spillSuppression, 0);
        this.applyChromaKey(
          data,
          keyColor || { r: 0, g: 1, b: 0 },
          tolerance,
          softness,
          spillSuppression,
        );
        break;
      }
      // Color grading filters
      case "temperature": {
        const temperature = readEffectNumber(params.value, 0);
        this.applyTemperature(data, temperature);
        break;
      }
      case "tint": {
        const tint = readEffectNumber(params.value, 0);
        this.applyTint(data, tint);
        break;
      }
      case "tonal": {
        const shadows = readEffectNumber(params.shadows, 0);
        const midtones = readEffectNumber(params.midtones, 0);
        const highlights = readEffectNumber(params.highlights, 0);
        this.applyTonal(data, shadows, midtones, highlights);
        break;
      }
      case "motion-blur": {
        const distance = readEffectNumber(params.distance, 0);
        const angle = readEffectNumber(params.angle, 0);
        this.applyMotionBlur(data, width, height, distance, angle);
        break;
      }
      case "radial-blur": {
        const amount = readEffectNumber(params.amount, 0);
        const centerX = readEffectNumber(params.centerX, 50);
        const centerY = readEffectNumber(params.centerY, 50);
        this.applyRadialBlur(data, width, height, amount, centerX, centerY);
        break;
      }
      case "chromatic-aberration": {
        const amount = readEffectNumber(params.amount, 0);
        this.applyChromaticAberration(data, width, height, amount);
        break;
      }
    }

    ctx.putImageData(imageData, 0, 0);
  }

  private applySharpenKernel(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    amount: number,
  ): void {
    const normalizedAmount = amount / 100;
    const copy = new Uint8ClampedArray(data);
    const kernel = [
      0,
      -normalizedAmount,
      0,
      -normalizedAmount,
      1 + 4 * normalizedAmount,
      -normalizedAmount,
      0,
      -normalizedAmount,
      0,
    ];

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          for (let ky = -1; ky <= 1; ky++) {
            for (let kx = -1; kx <= 1; kx++) {
              const idx = ((y + ky) * width + (x + kx)) * 4 + c;
              sum += copy[idx] * kernel[(ky + 1) * 3 + (kx + 1)];
            }
          }
          data[(y * width + x) * 4 + c] = Math.max(0, Math.min(255, sum));
        }
      }
    }
  }

  private applyVignette(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    amount: number,
    midpoint: number,
    feather: number,
  ): void {
    const normalizedAmount = amount / 100;
    const centerX = width / 2;
    const centerY = height / 2;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dx = (x - centerX) / centerX;
        const dy = (y - centerY) / centerY;
        const dist = Math.sqrt(dx * dx + dy * dy) / Math.SQRT2;

        const vignette = this.smoothstep(
          midpoint - feather,
          midpoint + feather,
          dist,
        );
        const factor = 1 - vignette * normalizedAmount;

        const idx = (y * width + x) * 4;
        data[idx] = Math.round(data[idx] * factor);
        data[idx + 1] = Math.round(data[idx + 1] * factor);
        data[idx + 2] = Math.round(data[idx + 2] * factor);
      }
    }
  }

  private smoothstep(edge0: number, edge1: number, x: number): number {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }

  private applyGrain(data: Uint8ClampedArray, amount: number): void {
    const normalizedAmount = amount / 100;
    const intensity = normalizedAmount * 50;
    for (let i = 0; i < data.length; i += 4) {
      const noise = (Math.random() - 0.5) * intensity;
      data[i] = Math.max(0, Math.min(255, data[i] + noise));
      data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise));
      data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise));
    }
  }

  private applyChromaKey(
    data: Uint8ClampedArray,
    keyColor: { r: number; g: number; b: number },
    tolerance: number,
    softness: number,
    spillSuppression = 0,
  ): void {
    const keyR = keyColor.r * 255;
    const keyG = keyColor.g * 255;
    const keyB = keyColor.b * 255;
    const tolDist = tolerance * 441.67; // sqrt(255^2 * 3)
    const softDist = softness * 441.67;

    // De-spill channel selection (keyColor is constant per call): pull the
    // key color's dominant channel back toward the average of the other two,
    // weighted by the suppression amount. Mirrors u_spillSuppression in the
    // GPU chromaKey shader so both paths stay visually identical.
    const keyMax = Math.max(keyColor.r, keyColor.g, keyColor.b);
    const suppressGreen = spillSuppression > 0 && keyColor.g === keyMax;
    const suppressBlue = !suppressGreen && spillSuppression > 0 && keyColor.b === keyMax;
    const suppressRed = !suppressGreen && !suppressBlue && spillSuppression > 0;

    for (let i = 0; i < data.length; i += 4) {
      const dr = data[i] - keyR;
      const dg = data[i + 1] - keyG;
      const db = data[i + 2] - keyB;
      const dist = Math.sqrt(dr * dr + dg * dg + db * db);

      const alpha = this.smoothstep(
        tolDist - softDist,
        tolDist + softDist,
        dist,
      );
      if (alpha > 0) {
        if (suppressGreen) {
          const avgRB = (data[i] + data[i + 2]) / 2;
          data[i + 1] = Math.round(
            data[i + 1] - Math.max(0, data[i + 1] - avgRB) * spillSuppression,
          );
        } else if (suppressBlue) {
          const avgRG = (data[i] + data[i + 1]) / 2;
          data[i + 2] = Math.round(
            data[i + 2] - Math.max(0, data[i + 2] - avgRG) * spillSuppression,
          );
        } else if (suppressRed) {
          const avgGB = (data[i + 1] + data[i + 2]) / 2;
          data[i] = Math.round(
            data[i] - Math.max(0, data[i] - avgGB) * spillSuppression,
          );
        }
      }
      data[i + 3] = Math.round(data[i + 3] * alpha);
    }
  }

  private applyTemperature(data: Uint8ClampedArray, temperature: number): void {
    const normalizedTemp = temperature / 100;

    for (let i = 0; i < data.length; i += 4) {
      let r = data[i];
      let g = data[i + 1];
      let b = data[i + 2];

      if (normalizedTemp > 0) {
        r = Math.min(255, r + normalizedTemp * 51);
        g = Math.min(255, g + normalizedTemp * 25.5);
        b = Math.max(0, b - normalizedTemp * 51);
      } else {
        r = Math.max(0, r + normalizedTemp * 51);
        g = Math.max(0, g + normalizedTemp * 12.75);
        b = Math.min(255, b - normalizedTemp * 51);
      }

      data[i] = Math.round(r);
      data[i + 1] = Math.round(g);
      data[i + 2] = Math.round(b);
    }
  }

  private applyTint(data: Uint8ClampedArray, tint: number): void {
    const normalizedTint = tint / 100;

    for (let i = 0; i < data.length; i += 4) {
      let r = data[i];
      let g = data[i + 1];
      let b = data[i + 2];

      r = Math.max(0, Math.min(255, r + normalizedTint * 25.5));
      g = Math.max(0, Math.min(255, g - normalizedTint * 51));
      b = Math.max(0, Math.min(255, b + normalizedTint * 25.5));

      data[i] = Math.round(r);
      data[i + 1] = Math.round(g);
      data[i + 2] = Math.round(b);
    }
  }

  private applyTonal(
    data: Uint8ClampedArray,
    shadows: number,
    midtones: number,
    highlights: number,
  ): void {
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] / 255;
      const g = data[i + 1] / 255;
      const b = data[i + 2] / 255;
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      const shadowWeight = 1 - this.smoothstep(0, 0.33, luma);
      const highlightWeight = this.smoothstep(0.66, 1, luma);
      const midtoneWeight = Math.max(0, 1 - shadowWeight - highlightWeight);
      const adjustment =
        shadows * shadowWeight * 0.3 +
        midtones * midtoneWeight * 0.3 +
        highlights * highlightWeight * 0.3;

      data[i] = Math.round(Math.max(0, Math.min(255, (r + adjustment) * 255)));
      data[i + 1] = Math.round(
        Math.max(0, Math.min(255, (g + adjustment) * 255)),
      );
      data[i + 2] = Math.round(
        Math.max(0, Math.min(255, (b + adjustment) * 255)),
      );
    }
  }

  private applyMotionBlur(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    distance: number,
    angle: number,
  ): void {
    const blurDistance = Math.max(0, distance);
    if (blurDistance <= 0) {
      return;
    }

    const copy = new Uint8ClampedArray(data);
    const sampleCount = Math.max(2, Math.min(16, Math.ceil(blurDistance / 4) + 1));
    const radians = (angle * Math.PI) / 180;
    const dirX = Math.cos(radians);
    const dirY = Math.sin(radians);
    const maxOffset = blurDistance / 2;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let red = 0;
        let green = 0;
        let blue = 0;
        let alpha = 0;
        let samples = 0;

        for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
          const t = sampleCount === 1 ? 0 : sampleIndex / (sampleCount - 1);
          const offset = (t - 0.5) * 2 * maxOffset;
          const sampleX = Math.round(x + dirX * offset);
          const sampleY = Math.round(y + dirY * offset);

          if (
            sampleX < 0 ||
            sampleX >= width ||
            sampleY < 0 ||
            sampleY >= height
          ) {
            continue;
          }

          const sampleOffset = (sampleY * width + sampleX) * 4;
          red += copy[sampleOffset];
          green += copy[sampleOffset + 1];
          blue += copy[sampleOffset + 2];
          alpha += copy[sampleOffset + 3];
          samples += 1;
        }

        if (samples === 0) {
          continue;
        }

        const pixelOffset = (y * width + x) * 4;
        data[pixelOffset] = Math.round(red / samples);
        data[pixelOffset + 1] = Math.round(green / samples);
        data[pixelOffset + 2] = Math.round(blue / samples);
        data[pixelOffset + 3] = Math.round(alpha / samples);
      }
    }
  }

  private applyRadialBlur(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    amount: number,
    centerX: number,
    centerY: number,
  ): void {
    const blurAmount = Math.max(0, amount);
    if (blurAmount <= 0) {
      return;
    }

    const copy = new Uint8ClampedArray(data);
    const sampleCount = Math.max(2, Math.min(12, Math.ceil(blurAmount / 8) + 2));
    const strength = Math.max(0, Math.min(1, blurAmount / 100));
    const centerPixelX = (centerX / 100) * Math.max(0, width - 1);
    const centerPixelY = (centerY / 100) * Math.max(0, height - 1);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const deltaX = x - centerPixelX;
        const deltaY = y - centerPixelY;
        let red = 0;
        let green = 0;
        let blue = 0;
        let alpha = 0;
        let samples = 0;

        for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
          const t = sampleCount === 1 ? 0 : sampleIndex / (sampleCount - 1);
          const scale = 1 + (t - 0.5) * strength * 1.5;
          const sampleX = Math.round(centerPixelX + deltaX * scale);
          const sampleY = Math.round(centerPixelY + deltaY * scale);

          if (
            sampleX < 0 ||
            sampleX >= width ||
            sampleY < 0 ||
            sampleY >= height
          ) {
            continue;
          }

          const sampleOffset = (sampleY * width + sampleX) * 4;
          red += copy[sampleOffset];
          green += copy[sampleOffset + 1];
          blue += copy[sampleOffset + 2];
          alpha += copy[sampleOffset + 3];
          samples += 1;
        }

        if (samples === 0) {
          continue;
        }

        const pixelOffset = (y * width + x) * 4;
        data[pixelOffset] = Math.round(red / samples);
        data[pixelOffset + 1] = Math.round(green / samples);
        data[pixelOffset + 2] = Math.round(blue / samples);
        data[pixelOffset + 3] = Math.round(alpha / samples);
      }
    }
  }

  private applyChromaticAberration(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    amount: number,
  ): void {
    const offset = Math.max(0, Math.round(amount / 2));
    if (offset <= 0) {
      return;
    }

    const copy = new Uint8ClampedArray(data);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const pixelOffset = (y * width + x) * 4;
        const redX = Math.min(width - 1, x + offset);
        const blueX = Math.max(0, x - offset);
        const redOffset = (y * width + redX) * 4;
        const blueOffset = (y * width + blueX) * 4;

        data[pixelOffset] = copy[redOffset];
        data[pixelOffset + 1] = copy[pixelOffset + 1];
        data[pixelOffset + 2] = copy[blueOffset + 2];
        data[pixelOffset + 3] = copy[pixelOffset + 3];
      }
    }
  }

  private toFilterColor(color: string | undefined, opacity: number): string {
    const alpha = Math.max(0, Math.min(1, opacity));
    if (!color) {
      return `rgba(0, 0, 0, ${alpha})`;
    }

    if (color.startsWith("rgb(" ) || color.startsWith("rgba(")) {
      return color;
    }

    const normalized = color.replace(/^#/, "");
    const hex =
      normalized.length === 3
        ? normalized
            .split("")
            .map((char) => `${char}${char}`)
            .join("")
        : normalized;

    if (hex.length !== 6) {
      return `rgba(0, 0, 0, ${alpha})`;
    }

    const red = Number.parseInt(hex.slice(0, 2), 16);
    const green = Number.parseInt(hex.slice(2, 4), 16);
    const blue = Number.parseInt(hex.slice(4, 6), 16);

    if (Number.isNaN(red) || Number.isNaN(green) || Number.isNaN(blue)) {
      return `rgba(0, 0, 0, ${alpha})`;
    }

    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  }

  private buildCSSFilter(effect: Effect): string {
    const params = effect.params as Record<string, number | string>;
    const value = typeof params.value === "number" ? params.value : 0;

    switch (effect.type) {
      case "brightness":
        return `brightness(${1 + value / 100})`;
      case "contrast":
        return `contrast(${readEffectNumber(params.value, 1)})`;
      case "saturation":
        return `saturate(${readEffectNumber(params.value, 1)})`;
      case "grayscale":
        return `grayscale(${readEffectNumber(params.amount, 1)})`;
      case "sepia":
        return `sepia(${readEffectNumber(params.amount, 1)})`;
      case "invert":
        return `invert(${readEffectNumber(params.amount, 1)})`;
      case "hue":
        return `hue-rotate(${readEffectNumber(params.rotation, 0)}deg)`;
      case "blur":
        return `blur(${readEffectNumber(params.radius, 0)}px)`;
      case "shadow": {
        const color = this.toFilterColor(
          typeof params.color === "string" ? params.color : undefined,
          typeof params.opacity === "number" ? params.opacity : 0.8,
        );
        return `drop-shadow(${readEffectNumber(params.offsetX, 0)}px ${readEffectNumber(params.offsetY, 0)}px ${readEffectNumber(params.blur, 0)}px ${color})`;
      }
      case "glow": {
        const radius = readEffectNumber(params.radius, 0);
        const intensity =
          typeof params.intensity === "number"
            ? Math.max(0, Math.min(3, params.intensity))
            : 1;
        const primaryColor = this.toFilterColor(
          typeof params.color === "string" ? params.color : undefined,
          Math.min(1, 0.35 * intensity),
        );
        const secondaryColor = this.toFilterColor(
          typeof params.color === "string" ? params.color : undefined,
          Math.min(1, 0.2 * intensity),
        );
        return `drop-shadow(0 0 ${radius}px ${primaryColor}) drop-shadow(0 0 ${Math.max(1, radius / 2)}px ${secondaryColor})`;
      }
      default:
        return "";
    }
  }

  reorderEffects(
    effects: Effect[],
    fromIndex: number,
    toIndex: number,
  ): Effect[] {
    const result = [...effects];
    const [removed] = result.splice(fromIndex, 1);
    result.splice(toIndex, 0, removed);
    return result;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;

    if (this.canvas) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    // Resize new renderer if available
    if (this.renderer) {
      this.renderer.resize(width, height);
    }
  }

  getAvailableFilters(): FilterType[] {
    return [
      "brightness",
      "contrast",
      "saturation",
      "hue",
      "blur",
      "sharpen",
      "vignette",
      "grain",
      "chromaKey",
      "temperature",
      "tint",
      "tonal",
      "shadow",
      "glow",
      "motion-blur",
      "radial-blur",
      "chromatic-aberration",
    ];
  }

  isFilterSupported(filterType: string): boolean {
    return this.getAvailableFilters().includes(filterType as FilterType);
  }

  dispose(): void {
    // Clean up new renderer
    if (this.renderer) {
      this.renderer.destroy();
      this.renderer = null;
    }
    this.useNewRenderer = false;

    // Clean up legacy WebGL2 resources
    if (this.gl) {
      for (const shader of this.shaders.values()) {
        this.gl.deleteProgram(shader.program);
      }
      this.shaders.clear();
      if (this.quadBuffer) this.gl.deleteBuffer(this.quadBuffer);
      if (this.texCoordBuffer) this.gl.deleteBuffer(this.texCoordBuffer);
      for (const fb of this.framebuffers) {
        this.gl.deleteFramebuffer(fb);
      }
      for (const tex of this.renderTextures) {
        this.gl.deleteTexture(tex);
      }

      this.framebuffers = [];
      this.renderTextures = [];
    }

    if (this._shaderRenderer) {
      this._shaderRenderer.dispose();
      this._shaderRenderer = null;
    }

    this.canvas = null;
    this.gl = null;
    this._fxCanvas = null;
    this._fxCtx = null;
    this._fxScratchCanvas = null;
    this._fxScratchCtx = null;
    this._shaderAlphaCanvas = null;
    this._shaderAlphaCtx = null;
    this.initialized = false;
  }

  getRendererType(): string {
    if (this.useNewRenderer && this.renderer) {
      return this.renderer.type;
    }
    if (this.gl) {
      return "legacy-webgl2";
    }
    return "cpu";
  }

  isUsingWebGPU(): boolean {
    return this.useNewRenderer && this.renderer?.type === "webgpu";
  }
}
let videoEffectsEngineInstance: VideoEffectsEngine | null = null;

export function getVideoEffectsEngine(
  width: number = 1920,
  height: number = 1080,
): VideoEffectsEngine {
  if (!videoEffectsEngineInstance) {
    videoEffectsEngineInstance = new VideoEffectsEngine({ width, height });
    videoEffectsEngineInstance.initialize().catch((error) => {
      console.error(
        "[VideoEffectsEngine] Background initialization failed:",
        error,
      );
    });
  } else if (
    videoEffectsEngineInstance["width"] !== width ||
    videoEffectsEngineInstance["height"] !== height
  ) {
    videoEffectsEngineInstance.resize(width, height);
  }
  return videoEffectsEngineInstance;
}
