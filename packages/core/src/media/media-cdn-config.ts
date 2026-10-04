/**
 * Download locations for the runtime-loaded media cores (EXTERNAL-DEPENDENCIES
 * downloads: the FFmpeg.wasm fallback core and the vidstab cores. FFmpeg uses
 * the public package CDN; vidstab has no default host. Deployments supplying these
 * assets redirect them with setMediaCdnOverrides before the first core load.
 * Empty or missing override fields keep the default for that core. This
 * module owns the defaults so every consumer resolves the same locations;
 * app shells read env overrides in their own config layer and push them here.
 */

export const DEFAULT_FFMPEG_CORE_BASE_URL =
  "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm";
export const DEFAULT_VIDSTAB_MT_URL =
  "";
export const DEFAULT_VIDSTAB_ST_URL =
  "";

export type MediaCdnOverrides = {
  ffmpegCoreBaseUrl?: string;
  vidstabMtUrl?: string;
  vidstabStUrl?: string;
};

let overrides: MediaCdnOverrides = {};

export function setMediaCdnOverrides(next: MediaCdnOverrides): void {
  overrides = { ...next };
}

export function resetMediaCdnOverrides(): void {
  overrides = {};
}

export function getFfmpegCoreBaseUrl(): string {
  return overrides.ffmpegCoreBaseUrl || DEFAULT_FFMPEG_CORE_BASE_URL;
}

export function getVidstabCoreUrl(variant: "mt" | "st"): string {
  const override = variant === "mt" ? overrides.vidstabMtUrl : overrides.vidstabStUrl;
  return (
    override ||
    (variant === "mt" ? DEFAULT_VIDSTAB_MT_URL : DEFAULT_VIDSTAB_ST_URL)
  );
}
