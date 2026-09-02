/**
 * Centralized API endpoint configuration.
 *
 * All external service URLs should be defined here so they can be
 * swapped for different environments or self-hosted instances.
 */

const isDev = import.meta.env.DEV;

/** OpenReel cloud services */
export const OPENREEL_CLOUD_URL = isDev
  ? "http://localhost:8787"
  : "https://api.openreel.video";

/** OpenReel transcription service (GPU) */
export const OPENREEL_TRANSCRIBE_URL = "https://cloud.openreel.video";
