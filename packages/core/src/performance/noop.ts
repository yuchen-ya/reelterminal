/**
 * Default disabled sink (design phase P0).
 *
 * The whole measurement system is off by default. When no collector is
 * installed, call sites get this shared frozen instance: `begin` returns the
 * shared NOOP_SPAN sentinel (zero allocation), `end`/`mark`/`count` do
 * nothing, and no clock is ever read.
 */
import type { Outcome, PerfContext, PerfDims, PerfSink, PerfSpan } from "./types";

/** Shared sentinel returned by every NOOP_SINK.begin call. */
export const NOOP_SPAN: Readonly<PerfSpan> = Object.freeze({ id: 0, startedUs: 0 });

export const NOOP_SINK: PerfSink = Object.freeze({
  enabled: false,
  mode: "off",
  begin: (_phase: string, _ctx: PerfContext): PerfSpan => NOOP_SPAN,
  end: (_span: PerfSpan, _outcome: Outcome, _dims?: PerfDims): void => {
    // Off mode: no work, no clock reads, no allocation.
  },
  mark: (_phase: string, _ctx: PerfContext, _dims?: PerfDims): void => {
    // Off mode.
  },
  count: (_key: string, _delta: number, _ctx?: PerfContext): void => {
    // Off mode.
  },
});
