import type { Transform } from "../types/timeline";
import type { Renderer } from "./renderer-factory";

export interface CompositorConfig {
  width: number;
  height: number;
  backgroundColor: [number, number, number, number];
  antialias?: boolean;
}

export class GPUCompositor {
  private renderer: Renderer | null = null;
  private config: CompositorConfig;

  constructor(config: CompositorConfig) {
    this.config = {
      ...config,
      antialias: config.antialias ?? true,
    };
  }

  setRenderer(renderer: Renderer): void {
    this.renderer = renderer;
  }

  getRenderer(): Renderer | null {
    return this.renderer;
  }

  getDevice(): GPUDevice | null {
    return this.renderer?.getDevice() ?? null;
  }

  setBackgroundColor(color: [number, number, number, number]): void {
    this.config.backgroundColor = color;
  }

  resize(width: number, height: number): void {
    this.config.width = width;
    this.config.height = height;
    if (this.renderer) {
      this.renderer.resize(width, height);
    }
  }

  dispose(): void {
    this.renderer = null;
  }
}

export function createDefaultTransform(): Transform {
  return {
    position: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    rotation: 0,
    anchor: { x: 0.5, y: 0.5 },
    opacity: 1,
  };
}

let gpuCompositorInstance: GPUCompositor | null = null;

export function initializeGPUCompositor(
  config: CompositorConfig,
): GPUCompositor {
  if (gpuCompositorInstance) {
    gpuCompositorInstance.dispose();
  }
  gpuCompositorInstance = new GPUCompositor(config);
  return gpuCompositorInstance;
}
