/**
 * Centralized API endpoint configuration.
 *
 * Business modules import these constants for cloud configuration.
 * Cloud integrations are off by default; VITE_REELTERMINAL_CLOUD=on opts in;
 * VITE_OPENREEL_CLOUD is accepted when the primary setting is unset.
 */

const env = import.meta.env as unknown as Record<string, string | undefined>;

/**
 * Primary environment names take precedence, including empty values.
 * URL defaults below treat an empty value as unset.
 */
const readEnvAlias = (newName: string, oldName: string): string | undefined => {
  const next = env[newName];
  if (next !== undefined) return next;
  return env[oldName];
};

/** Cloud integrations require an explicit opt-in and a configured backend. */
const cloudRequested =
  readEnvAlias("VITE_REELTERMINAL_CLOUD", "VITE_OPENREEL_CLOUD")?.toLowerCase() === "on";

export const REELTERMINAL_CLOUD_URL =
  (readEnvAlias("VITE_REELTERMINAL_CLOUD_URL", "VITE_OPENREEL_CLOUD_URL") ??
    env.VITE_CLOUD_API_URL) || "";
export const REELTERMINAL_TRANSCRIBE_URL =
  readEnvAlias("VITE_REELTERMINAL_TRANSCRIBE_URL", "VITE_OPENREEL_TRANSCRIBE_URL") || "";

export const REELTERMINAL_CLOUD_ENABLED =
  cloudRequested && Boolean(REELTERMINAL_CLOUD_URL);
export const REELTERMINAL_TRANSCRIBE_ENABLED =
  cloudRequested && Boolean(REELTERMINAL_TRANSCRIBE_URL);

/**
 * Runtime-loaded FFmpeg.wasm and vidstab cores. Override download locations with
 * VITE_REELTERMINAL_FFMPEG_CORE_URL / VITE_REELTERMINAL_VIDSTAB_MT_URL /
 * VITE_REELTERMINAL_VIDSTAB_ST_URL to point at a mirror or self-hosted copy;
 * unset or empty keeps the default CDN locations owned by @reelterminal/core.
 */
export const REELTERMINAL_FFMPEG_CORE_URL =
  env.VITE_REELTERMINAL_FFMPEG_CORE_URL || "";
export const REELTERMINAL_VIDSTAB_MT_URL =
  env.VITE_REELTERMINAL_VIDSTAB_MT_URL || "";
export const REELTERMINAL_VIDSTAB_ST_URL =
  env.VITE_REELTERMINAL_VIDSTAB_ST_URL || "";
