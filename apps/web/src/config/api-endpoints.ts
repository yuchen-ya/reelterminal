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
 * Cloud opt-out: setting VITE_REELTERMINAL_CLOUD (legacy name
 * VITE_OPENREEL_CLOUD) to the exact value `off` (case-insensitive) builds
 * the app without first-party cloud calls. Every other value — unset,
 * empty, `false`, `0` — keeps the cloud enabled, so the default behavior
 * never changes. When disabled, cloud-backed features short-circuit before
 * constructing a request and say so in the UI; they never silently fall
 * back to a different host.
 */

const env = import.meta.env as unknown as Record<string, string | undefined>;

/**
 * Env alias resolution (docs/NAMING-AND-COMPATIBILITY.md §3): the new
 * VITE_REELTERMINAL_* name wins when set, the legacy VITE_OPENREEL_* name is
 * read only when the new name is unset. URL overrides below keep their
 * existing `||` empty-string semantics (empty falls through), matching the
 * long-standing VITE_CLOUD_API_URL precedent.
 */
const readEnvAlias = (newName: string, oldName: string): string | undefined => {
  const next = env[newName];
  if (next !== undefined) return next;
  return env[oldName];
};

const isDev = import.meta.env.DEV;

/**
 * Domain-level switch for all first-party cloud services (cloud
 * templates, sharing, transcription, highlight AI). Only the exact
 * value `off` disables; there is deliberately no "enable" value.
 */
export const REELTERMINAL_CLOUD_ENABLED =
  readEnvAlias("VITE_REELTERMINAL_CLOUD", "VITE_OPENREEL_CLOUD")?.toLowerCase() !== "off";

/**
 * ReelTerminal cloud services (templates, sharing, highlight AI).
 *
 * Override with VITE_REELTERMINAL_CLOUD_URL; the legacy
 * VITE_OPENREEL_CLOUD_URL and the older VITE_CLOUD_API_URL are still read
 * as lower-priority compatibility aliases so existing deployments do not
 * silently change target. The newest name wins when several are set.
 */
export const REELTERMINAL_CLOUD_URL =
  readEnvAlias("VITE_REELTERMINAL_CLOUD_URL", "VITE_OPENREEL_CLOUD_URL") ||
  env.VITE_CLOUD_API_URL ||
  (isDev ? "http://localhost:8787" : "https://api.openreel.video");

/**
 * Transcription service (GPU). Override with VITE_REELTERMINAL_TRANSCRIBE_URL
 * (legacy name VITE_OPENREEL_TRANSCRIBE_URL).
 */
export const REELTERMINAL_TRANSCRIBE_URL =
  readEnvAlias("VITE_REELTERMINAL_TRANSCRIBE_URL", "VITE_OPENREEL_TRANSCRIBE_URL") ||
  "https://cloud.openreel.video";
