/**
 * Privacy layer between call sites and stored events (design phase P1).
 *
 * Rules (see docs/performance/README.md):
 * - Phase/counter labels must match an enum-like pattern; a non-conforming
 *   label is replaced WHOLESALE (prefix truncation would keep secret
 *   fragments like URL queries or paths).
 * - dim keys follow the same label rules; dim values must be finite numbers
 *   or booleans — anything else (strings, objects, NaN) is dropped and
 *   counted, never stringified.
 * - Anonymous ids are salted hashes; the salt is random per run so the same
 *   project/node name cannot be joined across runs.
 */
import { DEFAULT_PERF_BUDGETS } from "@reelterminal/core";
import type { PerfDims, PerfEvent } from "@reelterminal/core";

const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const INVALID_PHASE_LABEL = "perf.invalid-phase";
export const LABEL_POOL_OVERFLOW = "perf.label-overflow";

export interface PrivacyLimits {
  readonly maxLabelLength: number;
  readonly maxDimKeyLength: number;
  readonly maxDimsPerEvent: number;
}

export function defaultPrivacyLimits(): PrivacyLimits {
  return {
    maxLabelLength: DEFAULT_PERF_BUDGETS.maxLabelLength,
    maxDimKeyLength: DEFAULT_PERF_BUDGETS.maxDimKeyLength,
    maxDimsPerEvent: DEFAULT_PERF_BUDGETS.maxDimsPerEvent,
  };
}

export interface LabelSanitizeResult {
  readonly label: string;
  /** true when the input was rejected (invalid pattern or overlong pool). */
  readonly rejected: boolean;
  /** true when a valid-but-overlong label was truncated. */
  readonly truncated: boolean;
}

/**
 * Sanitize one label. Invalid patterns are replaced with INVALID_PHASE_LABEL
 * (the caller counts them as labelsDropped); valid overlong labels are
 * truncated (counted as truncatedFields).
 */
export function sanitizeLabel(label: string, limits: PrivacyLimits): LabelSanitizeResult {
  if (typeof label !== "string" || label.length === 0 || !LABEL_PATTERN.test(label)) {
    return { label: INVALID_PHASE_LABEL, rejected: true, truncated: false };
  }
  if (label.length > limits.maxLabelLength) {
    return {
      label: label.slice(0, limits.maxLabelLength),
      rejected: false,
      truncated: true,
    };
  }
  return { label, rejected: false, truncated: false };
}

export interface DimsSanitizeResult {
  readonly dims: PerfDims;
  /** Number of keys or values removed. */
  readonly dropped: number;
  readonly truncated: boolean;
}

/**
 * Sanitize dims: keys must be valid labels, values must be finite numbers or
 * booleans, at most maxDimsPerEvent entries survive (extras dropped).
 */
export function sanitizeDims(
  dims: PerfDims | undefined,
  limits: PrivacyLimits,
): DimsSanitizeResult {
  if (dims === undefined || dims === null) return { dims: {}, dropped: 0, truncated: false };
  if (typeof dims !== "object" || Array.isArray(dims)) {
    return { dims: {}, dropped: 1, truncated: false };
  }
  const out: Record<string, number | boolean> = {};
  let dropped = 0;
  let truncated = false;
  let kept = 0;
  for (const [rawKey, rawValue] of Object.entries(dims as Record<string, unknown>)) {
    if (kept >= limits.maxDimsPerEvent) {
      dropped += 1;
      continue;
    }
    const key = sanitizeLabel(rawKey, limits);
    if (key.rejected) {
      dropped += 1;
      continue;
    }
    if (key.truncated) truncated = true;
    if (
      (typeof rawValue !== "number" && typeof rawValue !== "boolean") ||
      (typeof rawValue === "number" && !Number.isFinite(rawValue))
    ) {
      dropped += 1;
      continue;
    }
    out[key.label] = rawValue;
    kept += 1;
  }
  return { dims: out, dropped, truncated };
}

export interface EventSanitizeResult {
  readonly event: PerfEvent;
  readonly labelsDropped: number;
  readonly truncatedFields: number;
}

/** Apply label and dims sanitization to a fully built event. */
export function sanitizeEvent(
  event: PerfEvent,
  limits: PrivacyLimits = defaultPrivacyLimits(),
): EventSanitizeResult {
  // Only phase and dims are rewritten; the kind-specific shape is untouched,
  // which the union cannot prove — hence the narrow intersection read and
  // the final structural cast.
  const source = event as PerfEvent & { dims?: PerfDims };
  const phase = sanitizeLabel(source.phase, limits);
  const dims = sanitizeDims(source.dims, limits);
  const hasDims = Object.keys(dims.dims).length > 0;
  const sanitized = {
    ...event,
    phase: phase.label,
    ...(hasDims ? { dims: dims.dims } : {}),
  } as PerfEvent;
  const labelsDropped = phase.rejected ? 1 : 0;
  const truncatedFields = (phase.truncated ? 1 : 0) + (dims.truncated ? 1 : 0);
  return { event: sanitized, labelsDropped, truncatedFields };
}

// ---------------------------------------------------------------------------
// Anonymous ids
// ---------------------------------------------------------------------------

function fnv1a(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Random per-run salt; collisions only matter within one run. */
export function createRunSalt(): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Deterministic within a run (same name + salt → same id), unlinkable across
 * runs (salt changes). Not cryptographic — it exists so raw names never enter
 * stored output, not to resist targeted de-anonymization.
 */
export function anonymizeId(value: string, salt: string): string {
  const a = fnv1a(`${salt}\u0000${value}`, 0x811c9dc5);
  const b = fnv1a(`${value}\u0001${salt}`, 0x9dc5811c);
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}
