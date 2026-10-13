import { createAnimationFrameSampler } from "../../../../web/src/performance/observers";
import type { ProductPerformanceCaptureApi } from "../../../../web/src/performance/product-capture-bridge";
import type { PerfStartReply, PerfStopReply } from "../../../src/shared/performance-contract";

// Bundled only by the opt-in harness and injected into its isolated renderer.
// These are driver action windows, not product handler/commit instrumentation.
const controller = (globalThis as typeof globalThis & { __reelterminalPerformanceCapture: ProductPerformanceCaptureApi }).__reelterminalPerformanceCapture;
if (!controller) throw new Error("production performance capture bridge unavailable");
const native = (globalThis as typeof globalThis & { reelterminalPerformance: {
  start(request: unknown): Promise<PerfStartReply>;
  stop(request: unknown): Promise<PerfStopReply>;
} }).reelterminalPerformance;
let nativeRunId: string | null = null;
let firstInputUs: number | null = null;
let lastFrameUs: number | null = null;
let intervals: number[] = [];
let frameSampler: ReturnType<typeof createAnimationFrameSampler> | null = null;
let hidden = false;
const onInput = () => { firstInputUs ??= performance.now() * 1000; };
const onVisibility = () => { hidden ||= document.hidden; };

const api = {
  async start(runId: string, _id: string, seconds: number) {
    firstInputUs = null;
    lastFrameUs = null;
    intervals = [];
    hidden = document.hidden;
    const started = await native.start({ schemaVersion: 1, runId, mode: "light", runClockHandshake: true, budgets: { captureSeconds: seconds } });
    if (!started.ok) throw new Error(`main performance start failed: ${started.error}`);
    nativeRunId = started.runId;
    try {
      await controller.start({
        runId, mode: "light",
        budgets: { captureSeconds: seconds, inputSampleEveryN: 1, frameSampleEveryN: 1, memorySampleIntervalSeconds: 0 },
      });
      document.addEventListener("mousedown", onInput, true);
      document.addEventListener("wheel", onInput, true);
      document.addEventListener("keydown", onInput, true);
      document.addEventListener("visibilitychange", onVisibility);
      frameSampler = createAnimationFrameSampler((timestampUs) => {
        if (lastFrameUs !== null && intervals.length < 4096) intervals.push((timestampUs - lastFrameUs) / 1000);
        lastFrameUs = timestampUs;
      });
    } catch (error) {
      document.removeEventListener("mousedown", onInput, true);
      document.removeEventListener("wheel", onInput, true);
      document.removeEventListener("keydown", onInput, true);
      document.removeEventListener("visibilitychange", onVisibility);
      frameSampler?.stop();
      frameSampler = null;
      if (controller.activeRunId) controller.stop();
      const stopped = await native.stop({ schemaVersion: 1, runId: nativeRunId });
      nativeRunId = null;
      if (!stopped.ok) throw new Error(`main performance rollback failed: ${stopped.error}`);
      throw error;
    }
  },
  async stop(_outcome: "ok" | "error" | "timeout") {
    document.removeEventListener("mousedown", onInput, true);
    document.removeEventListener("wheel", onInput, true);
    document.removeEventListener("keydown", onInput, true);
    document.removeEventListener("visibilitychange", onVisibility);
    frameSampler?.stop();
    frameSampler = null;
    // The controller may already have stopped at its hard capture budget.
    const active = controller.activeRunId !== null;
    const report = active ? await controller.stop() : controller.lastReport!;
    const main = await native.stop({ schemaVersion: 1, runId: nativeRunId });
    nativeRunId = null;
    if (!main.ok) throw new Error(`main performance stop failed: ${main.error}`);
    return { report, main, firstInputUs, intervalsMs: intervals, hiddenDuringAction: hidden };
  },
};

(globalThis as typeof globalThis & { __reelterminalPerfDriver: typeof api }).__reelterminalPerfDriver = api;
