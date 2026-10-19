import type { Page } from "playwright-core";
import type { ProductPerformanceCaptureApi } from "../../../../web/src/performance/product-capture-bridge";
import type { PerfStopReply } from "../../../src/shared/performance-contract";
import type { RendererWindowEvidence } from "./driver";

export interface StoppedCaptureEvidence extends RendererWindowEvidence {
  main: PerfStopReply;
}

export interface IdleCaptureStopRequest {
  runId: string;
  requireGestureFrame?: boolean;
  requireFrame?: boolean;
}

/** Serialized into the owned page. Keep this function free of runtime imports.
 * The existing driver calls the synchronous product stop before its first await.
 * Checking idle and freezing the renderer therefore share one JavaScript turn.
 */
export function stopCaptureAtIdle(request: IdleCaptureStopRequest): false | Promise<StoppedCaptureEvidence> {
  const target = globalThis as typeof globalThis & {
    __reelterminalPerformanceCapture: ProductPerformanceCaptureApi;
    __reelterminalPerfDriver: { stop(outcome: "ok"): Promise<StoppedCaptureEvidence> };
  };
  const capture = target.__reelterminalPerformanceCapture;
  if (capture.activeRunId === null) throw new Error("capture ended before idle stop");
  if (capture.activeRunId !== request.runId) throw new Error("capture owner changed before idle stop");
  if (capture.pendingSpanCount !== 0 ||
      (request.requireGestureFrame && !(capture.completedGestureFrameCount > 0)) ||
      (request.requireFrame && !(capture.committedFrameCount > 0))) return false;
  return target.__reelterminalPerfDriver.stop("ok");
}

export async function stopCaptureWhenIdle(
  page: Pick<Page, "waitForFunction">,
  request: IdleCaptureStopRequest,
  timeoutMs: number,
): Promise<StoppedCaptureEvidence> {
  const handle = await page.waitForFunction<StoppedCaptureEvidence | false, IdleCaptureStopRequest>(
    stopCaptureAtIdle, request, { timeout: timeoutMs },
  );
  try {
    const evidence = await handle.jsonValue();
    if (!evidence) throw new Error("idle stop returned no capture evidence");
    return evidence;
  } finally {
    await handle.dispose();
  }
}
