/**
 * Passive failure tracking for the remote default 3D text font.
 *
 * The core renderer (`@openreel/core` motion-three-renderer) downloads its
 * default Text3D font from a hardcoded remote URL and swallows load
 * failures: a failed font simply means the 3D text object is missing from
 * the rendered frame with no signal reaching the UI. This module lets the
 * web layer observe those fetches without changing them.
 *
 * Design constraints (B06):
 * - The observer is strictly passive: it wraps `window.fetch` once and
 *   forwards every call untouched, so the success path gains no extra
 *   requests, latency, or UI.
 * - Only the remote typeface font URL is tracked; same-origin `/fonts/`
 *   loads used by the 2D-preview pipeline are ignored.
 * - Nothing retries automatically; the stage notice offers an explicit
 *   user-driven retry. A recorded failure is cleared only by a later
 *   successful font fetch (e.g. after that retry) or an explicit reset.
 */

import type { MotionComposition } from "@openreel/core/motion/types";

export interface Text3DFontFailure {
  /** The font URL whose fetch failed. */
  url: string;
  /** Short human-readable reason (network error message or HTTP status). */
  message: string;
}

let failure: Text3DFontFailure | null = null;
let installed = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** Matches only remote default-font URLs (e.g. threejs.org helvetiker),
 *  not the app's own same-origin /fonts/ assets. */
export function isRemoteText3DFontUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) && /helvetiker[^/?#]*\.typeface\.json/i.test(url);
}

function extractUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function noteOutcome(url: string, ok: boolean, message?: string): void {
  if (ok) {
    // A later success (e.g. after user retry) clears the stale failure.
    if (failure !== null) {
      failure = null;
      notify();
    }
    return;
  }
  const next: Text3DFontFailure = { url, message: message ?? "font request failed" };
  if (failure?.url === next.url && failure.message === next.message) return;
  failure = next;
  notify();
}

/**
 * Installs a pass-through observer on `window.fetch` (idempotent). Every
 * call is forwarded to the original fetch unmodified; only the outcome of
 * remote typeface-font requests is recorded.
 */
export function installText3DFontFetchObserver(): void {
  if (installed) return;
  if (typeof window === "undefined") return;
  if (typeof window.fetch !== "function") return;
  installed = true;

  const originalFetch = window.fetch;
  window.fetch = function patchedFetch(
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = extractUrl(input);
    const tracked = isRemoteText3DFontUrl(url);
    const promise = originalFetch.call(this, input, init);
    if (!tracked) return promise;
    return promise.then(
      (response) => {
        noteOutcome(
          url,
          response.ok,
          response.ok ? undefined : `HTTP ${response.status}`,
        );
        return response;
      },
      (error: unknown) => {
        noteOutcome(
          url,
          false,
          error instanceof Error ? error.message : "network error",
        );
        throw error;
      },
    );
  };
}

export function getText3DFontFailure(): Text3DFontFailure | null {
  return failure;
}

export function clearText3DFontFailure(): void {
  if (failure === null) return;
  failure = null;
  notify();
}

export function subscribeText3DFontFailure(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

type MotionScene3DLayer = Extract<
  MotionComposition["layers"][number],
  { type: "scene3d" }
>;

/**
 * Whether the composition renders any 3D text object that depends on the
 * remote default font. Used to scope the stage degradation notice to
 * compositions that can actually be affected.
 */
export function compositionHasText3DObjects(
  composition: MotionComposition,
): boolean {
  return (composition.layers ?? []).some((layer) => {
    if (layer.type !== "scene3d") return false;
    const scene = layer as MotionScene3DLayer;
    if (!layer.visible) return false;
    if (scene.object?.kind === "text3d") return true;
    return (scene.objects ?? []).some((entry) => entry.object?.kind === "text3d");
  });
}
