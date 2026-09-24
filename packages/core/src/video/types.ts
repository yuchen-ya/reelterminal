import type { Effect, Transform } from "../types/timeline";

export interface RenderedFrame {
  image: ImageBitmap;
  timestamp: number;
  width: number;
  height: number;
}


export const BLEND_MODES = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
  "add",
  "linear-dodge",
] as const;

export type BlendMode = (typeof BLEND_MODES)[number];

export interface FrameCacheConfig {
  maxFrames: number;
  maxSizeBytes: number;
  preloadAhead: number;
  preloadBehind: number;
}

export interface FrameCacheStats {
  entries: number;
  sizeBytes: number;
  hitRate: number;
  maxSizeBytes: number;
  hits: number;
  misses: number;
}

export interface CachedFrame {
  image: ImageBitmap;
  timestamp: number;
  mediaId: string;
  width: number;
  height: number;
  sizeBytes: number;
  lastAccessed: number;
}

export interface VideoTrackRenderInfo {
  trackId: string;
  index: number;
  hidden: boolean;
  clips: VideoClipRenderInfo[];
}

export interface VideoClipRenderInfo {
  clipId: string;
  mediaId: string;
  media: Blob | File;
  sourceTime: number;
  transform: Transform;
  effects: Effect[];
  opacity: number;
}
