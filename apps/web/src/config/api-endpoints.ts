/** Cloud services require an explicit opt-in and a configured backend. */
const env = import.meta.env as unknown as Record<string, string | undefined>;
const cloudRequested = env.VITE_REELTERMINAL_CLOUD?.toLowerCase() === "on";

export const REELTERMINAL_CLOUD_URL = env.VITE_REELTERMINAL_CLOUD_URL || "";
export const REELTERMINAL_TRANSCRIBE_URL = env.VITE_REELTERMINAL_TRANSCRIBE_URL || "";

export const REELTERMINAL_CLOUD_ENABLED =
  cloudRequested && Boolean(REELTERMINAL_CLOUD_URL);
export const REELTERMINAL_TRANSCRIBE_ENABLED =
  cloudRequested && Boolean(REELTERMINAL_TRANSCRIBE_URL);

/**
 * Runtime-loaded FFmpeg.wasm and vidstab cores. Override download locations with
 * VITE_REELTERMINAL_FFMPEG_CORE_URL / VITE_REELTERMINAL_VIDSTAB_MT_URL /
 * VITE_REELTERMINAL_VIDSTAB_ST_URL to point at a mirror or self-hosted copy;
 * empty uses the default FFmpeg CDN; vidstab requires an explicit URL.
 */
export const REELTERMINAL_FFMPEG_CORE_URL =
  env.VITE_REELTERMINAL_FFMPEG_CORE_URL || "";
export const REELTERMINAL_VIDSTAB_MT_URL =
  env.VITE_REELTERMINAL_VIDSTAB_MT_URL || "";
export const REELTERMINAL_VIDSTAB_ST_URL =
  env.VITE_REELTERMINAL_VIDSTAB_ST_URL || "";
