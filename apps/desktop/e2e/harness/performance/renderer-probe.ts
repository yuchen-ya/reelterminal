import { CaptureController } from "../../../../web/src/performance/capture-controller";
import { createAnimationFrameSampler } from "../../../../web/src/performance/observers";
import { getPerfSink, type PerfSpan } from "@reelterminal/core";

// Bundled only by the opt-in harness and injected into its isolated renderer.
// These are driver action windows, not product handler/commit instrumentation.
const controller = new CaptureController();
let span: PerfSpan | null = null;
let operationId = "";
let firstInputUs: number | null = null;
let lastFrameUs: number | null = null;
let intervals: number[] = [];
let frameSampler: ReturnType<typeof createAnimationFrameSampler> | null = null;
let hidden = false;
const onInput = () => { firstInputUs ??= performance.now() * 1000; };
const onVisibility = () => { hidden ||= document.hidden; };

const api = {
  start(runId: string, id: string, seconds: number) {
    operationId = id;
    firstInputUs = null;
    lastFrameUs = null;
    intervals = [];
    hidden = document.hidden;
    controller.startCapture({
      runId, mode: "light",
      budgets: { captureSeconds: seconds, inputSampleEveryN: 1, frameSampleEveryN: 1, memorySampleIntervalSeconds: 0 },
    });
    document.addEventListener("mousedown", onInput, true);
    document.addEventListener("wheel", onInput, true);
    document.addEventListener("keydown", onInput, true);
    document.addEventListener("visibilitychange", onVisibility);
    span = getPerfSink().begin("driver.operation", { runId, operationId });
    frameSampler = createAnimationFrameSampler((timestampUs) => {
      if (lastFrameUs !== null && intervals.length < 4096) intervals.push((timestampUs - lastFrameUs) / 1000);
      lastFrameUs = timestampUs;
    });
  },
  stop(outcome: "ok" | "error" | "timeout") {
    document.removeEventListener("mousedown", onInput, true);
    document.removeEventListener("wheel", onInput, true);
    document.removeEventListener("keydown", onInput, true);
    document.removeEventListener("visibilitychange", onVisibility);
    frameSampler?.stop();
    frameSampler = null;
    // The controller may already have stopped at its hard capture budget.
    const active = controller.activeRunId !== null;
    if (active && span) getPerfSink().end(span, outcome);
    const report = active ? controller.stopCapture() : controller.lastReport!;
    span = null;
    return { report, firstInputUs, intervalsMs: intervals, hiddenDuringAction: hidden };
  },
};

(globalThis as typeof globalThis & { __reelterminalPerfDriver: typeof api }).__reelterminalPerfDriver = api;
