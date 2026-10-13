/**
 * Renderer-local monotonic clock (design phase P1).
 *
 * Microseconds derived from performance.now() of this renderer realm. The
 * values are only comparable within one clockId; cross-process comparisons
 * require a validated sync estimate (see the desktop clock-sync module).
 * A new clock instance gets a fresh processEpoch so events from before and
 * after a reload can never be stitched together.
 */
import type { PerfClock } from "@reelterminal/core";

export interface RendererPerfClock extends PerfClock {
  /** Changes when the renderer reloads; events keep their own epoch. */
  readonly processEpoch: string;
  /** performance.timeOrigin in microseconds, metadata only. */
  readonly timeOriginUs: number;
}

export interface RendererClockOptions {
  /** Injectable for tests; default is this realm's performance.now(). */
  nowMs?: () => number;
  /** Injectable epoch; default is freshly random per clock. */
  epoch?: string;
  timeOriginMs?: number;
}

let clockCounter = 0;

function randomEpoch(random: () => number): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createRendererClock(options: RendererClockOptions = {}): RendererPerfClock {
  const nowMs =
    options.nowMs ??
    (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const processEpoch = options.epoch ?? randomEpoch(Math.random);
  clockCounter += 1;
  const clockId = `renderer-${processEpoch}-${clockCounter}`;
  const timeOriginUs = Math.round(
    (options.timeOriginMs ??
      (typeof performance !== "undefined" ? performance.timeOrigin : 0)) * 1000,
  );
  return {
    clockId,
    processEpoch,
    timeOriginUs,
    nowUs: () => Math.round(nowMs() * 1000),
  };
}
