/**
 * Sink injection point (design phase P0).
 *
 * Product call sites read the current sink with getPerfSink() and are
 * expected to guard on `enabled` before doing any measurement-related work.
 * A collector (renderer capture controller, test spy) installs itself for
 * the duration of one capture and restores the NOOP sink afterwards, so the
 * default state of the application is measurement-free.
 */
import { NOOP_SINK } from "./noop";
import { classifyPerfError, errorKindToOutcome, isCaptureMode } from "./types";
import type { PerfContext, PerfDims, PerfSink, PerfSpan } from "./types";

let currentSink: PerfSink = NOOP_SINK;

/**
 * Install a sink. Null/undefined restores the shared NOOP sink. A sink that
 * is disabled, malformed or runs mode "off" is not installed — the slot
 * always ends up either a valid enabled sink or the NOOP sentinel, so
 * callers never need defensive checks beyond `enabled`.
 */
export function setPerfSink(sink: PerfSink | null | undefined): void {
  if (!isValidSink(sink)) {
    currentSink = NOOP_SINK;
    return;
  }
  currentSink = sink;
}

/** Currently installed sink; NOOP_SINK unless a capture is active. */
export function getPerfSink(): PerfSink {
  return currentSink;
}

function isValidSink(sink: PerfSink | null | undefined): sink is PerfSink {
  if (sink === null || sink === undefined) return false;
  if (typeof sink !== "object") return false;
  if (sink.enabled !== true) return false;
  if (!isCaptureMode(sink.mode) || sink.mode === "off") return false;
  return (
    typeof sink.begin === "function" &&
    typeof sink.end === "function" &&
    typeof sink.mark === "function" &&
    typeof sink.count === "function"
  );
}

/**
 * Run a synchronous function under one span. The disabled path calls `fn`
 * directly with no other work; the enabled path never swallows or replaces
 * the original exception and never turns a collector failure into a business
 * failure (sink implementations are contractually non-throwing).
 */
export function runMeasured<T>(phase: string, ctx: PerfContext, fn: () => T): T {
  const sink = getPerfSink();
  if (!sink.enabled) return fn();
  const span = sink.begin(phase, ctx);
  try {
    const result = fn();
    sink.end(span, "ok");
    return result;
  } catch (error) {
    sink.end(span, errorKindToOutcome(classifyPerfError(error)));
    throw error;
  }
}

/** Async counterpart of runMeasured; awaits settle before ending the span. */
export async function withPerfSpan<T>(
  phase: string,
  ctx: PerfContext,
  fn: () => Promise<T>,
): Promise<T> {
  const sink = getPerfSink();
  if (!sink.enabled) return fn();
  const span = sink.begin(phase, ctx);
  try {
    const result = await fn();
    sink.end(span, "ok");
    return result;
  } catch (error) {
    sink.end(span, errorKindToOutcome(classifyPerfError(error)));
    throw error;
  }
}

/** End a span produced outside runMeasured/withPerfSpan with a safe outcome. */
export function endSpanWithError(span: PerfSpan, error: unknown, dims?: PerfDims): void {
  const sink = getPerfSink();
  if (!sink.enabled) return;
  sink.end(span, errorKindToOutcome(classifyPerfError(error)), dims);
}
