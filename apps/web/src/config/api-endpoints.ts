/**
 * Centralized API endpoint configuration.
 *
 * All external service URLs should be defined here so they can be
 * swapped for different environments or self-hosted instances.
 *
 * This module is the single place where the web renderer reads
 * cloud-related environment variables. Business modules must import the
 * exported constants instead of reading `import.meta.env` themselves.
 *
 * Cloud opt-out: setting VITE_OPENREEL_CLOUD to the exact value `off`
 * (case-insensitive) builds the app without first-party cloud calls.
 * Every other value — unset, empty, `false`, `0` — keeps the cloud
 * enabled, so the default behavior never changes. When disabled,
 * cloud-backed features short-circuit before constructing a request and
 * say so in the UI; they never silently fall back to a different host.
 */

const isDev = import.meta.env.DEV;

/**
 * Domain-level switch for all first-party cloud services (cloud
 * templates, sharing, transcription, highlight AI). Only the exact
 * value `off` disables; there is deliberately no "enable" value.
 */
export const OPENREEL_CLOUD_ENABLED =
  import.meta.env.VITE_OPENREEL_CLOUD?.toLowerCase() !== "off";

/**
 * OpenReel cloud services (templates, sharing, highlight AI).
 *
 * Override with VITE_OPENREEL_CLOUD_URL; VITE_CLOUD_API_URL is still
 * read as a compatibility alias so existing deployments do not silently
 * change target. The new name wins when both are set.
 */
export const OPENREEL_CLOUD_URL =
  import.meta.env.VITE_OPENREEL_CLOUD_URL ||
  import.meta.env.VITE_CLOUD_API_URL ||
  (isDev ? "http://localhost:8787" : "https://api.openreel.video");

/** OpenReel transcription service (GPU). Override with VITE_OPENREEL_TRANSCRIBE_URL. */
export const OPENREEL_TRANSCRIBE_URL =
  import.meta.env.VITE_OPENREEL_TRANSCRIBE_URL || "https://cloud.openreel.video";
