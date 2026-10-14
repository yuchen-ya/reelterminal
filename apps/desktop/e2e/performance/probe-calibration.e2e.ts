import { describe, expect, test } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CaptureReport } from "../../../web/src/performance";
import type { TimelineState } from "@reelterminal/agent-facade";
import { launchApp, type LaunchedApp } from "../harness/launch";
import { ARTIFACTS_DIR } from "../harness/paths";
import { connectExternalAgent, type ExternalAgent } from "../harness/mcp-client";
import { enableAgentSessionViaUI } from "../harness/ui";
import { acquirePerformanceLock, captureComplete, prepareProfile, installProbe, dragTo, waitForMarker, type RendererWindowEvidence } from "../harness/performance/driver";
import { captureBuildIdentity, readEnvironmentIdentity } from "../harness/performance/identity";
import { createPerformanceFixture } from "./fixtures";

interface CalibrationGlobal {
  __reelterminalPerfDriver: {
    start(runId: string, operationId: string, seconds: number): Promise<void>;
    stop(outcome: "ok"): Promise<RendererWindowEvidence>;
  };
  __reelterminalPerformanceCapture: {
    start(request: unknown): void;
    stop(): CaptureReport;
    pendingSpanCount: number;
    activeRunId: string | null;
  };
}

interface CalibrationRun {
  mode: "off" | "light";
  durationMs: number;
  taskSeconds: number;
  heapBytesBefore: number;
  heapBytesAfter: number;
  rssBytes: number;
  exportMs: number;
  events: number;
}

const enabled = process.env.REELTERMINAL_PERFORMANCE_CALIBRATION === "1";
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

(enabled ? describe : describe.skip)("P3 production probe controls and ABBA calibration", () => {
  test("detects blocking, distinguishes async waiting, and measures five ABBA blocks", async () => {
    const release = await acquirePerformanceLock();
    let launched: LaunchedApp | undefined;
    let agent: ExternalAgent | undefined;
    let success = false;
    let artifactWritten = false;
    const runs: CalibrationRun[] = [];
    const controls: Record<string, unknown> = {};
    const directory = path.join(ARTIFACTS_DIR, "performance");
    const artifact = path.join(directory, `probe-calibration-${Date.now()}.json`);
    try {
      const build = await captureBuildIdentity();
      expect(build.build_verified, build.build_reason).toBe(true);
      const fixture = createPerformanceFixture({ scenarioId: "T01", seed: "42" });
      const runDir = await prepareProfile(fixture);
      launched = await launchApp({ runDir, skipLocaleReload: true });
      const page = launched.page;
      await launched.app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        window.setContentSize(1280, 800);
        window.show();
        window.focus();
      });
      const environment = await readEnvironmentIdentity(launched);
      expect(environment.visible).toBe(true);
      expect(environment.focused).toBe(true);
      expect(environment.devtools_open).toBe(false);
      await page.getByRole("button", { name: `Open ${fixture.project!.name}`, exact: true }).click();
      await page.getByTestId("agent-access-status").waitFor();
      await enableAgentSessionViaUI(page, launched.endpointFile);
      await launched.waitForEndpointFile();
      agent = await connectExternalAgent(launched.endpointFile);
      const snap = page.getByRole("button", { name: "Snap on (N)", exact: true });
      if (await snap.count()) await snap.click();
      const zoomBox = (await page.getByRole("slider", { name: "Timeline zoom", exact: true }).boundingBox())!;
      await page.mouse.click(zoomBox.x + zoomBox.width * 0.85, zoomBox.y + zoomBox.height / 2);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await waitForMarker(page, fixture, 30_000);
      await installProbe(page);
      const target = { projectId: fixture.projectId!, workspaceId: fixture.workspaceId! };
      const readClip = async () => {
        const state = await agent!.callTool<TimelineState>("timeline_get", target, { timeoutMs: 30_000 });
        if (!state.ok) throw new Error("calibration timeline read failed");
        return state.value!.tracks.flatMap(track => track.clips).find(clip => clip.id === fixture.targetMediaClipId)!;
      };
      const box = (await page.locator(`[data-live-editor-target-id="${fixture.targetMediaClipId}"]`).first().boundingBox())!;
      const initialClip = await readClip();
      const pixelsPerSecond = box.width / initialClip.duration;
      const rulerBox = (await page.getByTestId("timeline-time-ruler").boundingBox())!;
      await page.mouse.click(rulerBox.x + 3 * pixelsPerSecond, rulerBox.y + rulerBox.height / 2);
      await waitForMarker(page, fixture, 30_000);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Performance.enable");
      const metrics = async () => {
        const result = await cdp.send("Performance.getMetrics");
        return Object.fromEntries(result.metrics.map((metric: { name: string; value: number }) => [metric.name, metric.value]));
      };
      const start = (id: string) => page.evaluate(id => (globalThis as unknown as CalibrationGlobal).__reelterminalPerfDriver.start(id, id, 30), id);
      const stop = async () => (await page.evaluate(() => (globalThis as unknown as CalibrationGlobal).__reelterminalPerfDriver.stop("ok"))).report;
      const settle = () => page.waitForFunction(() => {
        const api = (globalThis as unknown as CalibrationGlobal).__reelterminalPerformanceCapture;
        return api.pendingSpanCount === 0;
      }, null, { timeout: 30_000 });

      await start("probe-hidden-window");
      // Inject visibility at the browser boundary. Native window hiding can
      // suspend renderer IPC under automation, including capture teardown.
      const hiddenCapture = await page.evaluate(async () => {
        Object.defineProperty(document, "hidden", { configurable: true, value: true });
        try {
          document.dispatchEvent(new Event("visibilitychange"));
          return await (globalThis as unknown as CalibrationGlobal).__reelterminalPerfDriver.stop("ok");
        } finally {
          Reflect.deleteProperty(document, "hidden");
          document.dispatchEvent(new Event("visibilitychange"));
        }
      });
      expect(hiddenCapture.hiddenDuringAction).toBe(true);
      expect(captureComplete(hiddenCapture)).toBe(false);
      controls.hiddenWindow = {
        source: "synthetic_visibilitychange",
        hiddenDuringAction: hiddenCapture.hiddenDuringAction,
        rejectedByDriver: !captureComplete(hiddenCapture),
      };
      await waitForMarker(page, fixture, 30_000);

      await start("probe-blocking");
      await page.evaluate(() => new Promise<void>(resolve => setTimeout(() => {
        const deadline = performance.now() + 80;
        while (performance.now() < deadline) { /* positive control */ }
        resolve();
      }, 0)));
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const blocking = await stop();
      controls.blocking = blocking;
      const longTask = blocking.events.find(event => event.phase === "main.longtask" && event.kind === "sample" && Number(event.dims?.durationMs) >= 70);
      expect(blocking.observerCapabilities.longTask).toBe("supported");
      expect(longTask).toBeDefined();

      await start("probe-async");
      const beforeAsync = await metrics();
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 150)));
      const afterAsync = await metrics();
      const waiting = await stop();
      expect(waiting.wallDurationUs).toBeGreaterThanOrEqual(140_000);
      const asyncTaskMs = (afterAsync.TaskDuration! - beforeAsync.TaskDuration!) * 1000;
      expect(asyncTaskMs).toBeLessThan(80);
      controls.async = { report: waiting, taskMs: asyncTaskMs };

      // Identical six-gesture groups return to the same timeline geometry.
      // CDP metrics and process RSS are read outside the measured workload.
      for (let block = 0; block < 5; block++) {
        for (const mode of ["off", "light", "light", "off"] as const) {
          await waitForMarker(page, fixture, 30_000);
          const oldSaves = page.getByTestId("notification-toast").filter({ hasText: "Current edits saved" });
          for (const toast of await oldSaves.all()) await toast.getByRole("button", { name: "Dismiss notification" }).click();
          const before = await metrics();
          if (mode === "light") await start(`probe-abba-${runs.length}`);
          const started = await page.evaluate(() => performance.now());
          for (let gesture = 0; gesture < 6; gesture++) {
            const beforeClip = await readClip();
            const delta = gesture % 2 === 0 ? 24 : -24;
            controls.currentGesture = { block, mode, gesture, beforeStartTime: beforeClip.startTime, pixelsPerSecond, delta };
            await dragTo(page, fixture.targetMediaClipId!, delta, 5_000);
            const expected = beforeClip.startTime + delta / pixelsPerSecond;
            const deadline = performance.now() + 30_000;
            let actual = await readClip();
            while (Math.abs(actual.startTime - expected) > 0.06 && performance.now() < deadline) {
              await page.waitForTimeout(25);
              actual = await readClip();
            }
            expect(Math.abs(actual.startTime - expected)).toBeLessThanOrEqual(0.06);
          }
          await waitForMarker(page, fixture, 30_000);
          await page.keyboard.press("Control+s");
          await page.getByTestId("notification-toast").getByText("Current edits saved", { exact: true }).last().waitFor();
          await settle();
          const stopped = await page.evaluate(() => performance.now());
          const exportStarted = performance.now();
          const windowEvidence = mode === "light"
            ? await page.evaluate(() => (globalThis as unknown as CalibrationGlobal).__reelterminalPerfDriver.stop("ok"))
            : null;
          const report = windowEvidence?.report ?? null;
          const exportMs = performance.now() - exportStarted;
          if (report) {
            // Keep bounded failure diagnostics before asserting completeness.
            // Raw events, endpoint descriptors and profiles stay on the runner.
            controls.currentCapture = {
              status: report.status,
              reasonCodes: report.reasonCodes,
              stopReason: report.stopReason,
              wallDurationUs: report.wallDurationUs,
              drops: report.drops,
              hiddenDuringAction: windowEvidence!.hiddenDuringAction,
              mainStatus: windowEvidence!.main?.ok ? windowEvidence!.main.mainCapture.status : "unavailable",
              mainReasonCodes: windowEvidence!.main?.ok ? windowEvidence!.main.mainCapture.reasonCodes : [],
            };
            console.info("PERFORMANCE_CALIBRATION_CAPTURE", controls.currentCapture);
            // Qualification covers both collectors and action-window visibility,
            // as required by the same driver used for performance scenarios.
            expect(captureComplete(windowEvidence!)).toBe(true);
            expect(report.status).toBe("complete");
            expect(report.events.filter(event => event.phase === "semantic-state.committed")).toHaveLength(6);
            expect(report.counters["project.full-json-copies"] ?? 0).toBe(0);
          } else {
            expect(await page.evaluate(() => (globalThis as unknown as CalibrationGlobal).__reelterminalPerformanceCapture.activeRunId)).toBeNull();
          }
          const after = await metrics();
          const rssBytes = await launched.app.evaluate(({ app }) => app.getAppMetrics().filter(metric => metric.type === "Tab").reduce((sum, metric) => sum + metric.memory.workingSetSize * 1024, 0));
          runs.push({ mode, durationMs: stopped - started, taskSeconds: after.TaskDuration! - before.TaskDuration!, heapBytesBefore: before.JSHeapUsedSize!, heapBytesAfter: after.JSHeapUsedSize!, rssBytes, exportMs, events: report ? report.events.length + report.criticalEvents.length : 0 });
          console.info("PERFORMANCE_CALIBRATION_PROGRESS", { block, mode, completed_groups: runs.length, duration_ms: stopped - started });
        }
      }
      const offMs = median(runs.filter(run => run.mode === "off").map(run => run.durationMs));
      const lightMs = median(runs.filter(run => run.mode === "light").map(run => run.durationMs));
      // Provisional 2% goal plus 5ms/gesture tolerance for real-input timing.
      const toleranceMs = Math.max(offMs * 0.02, 6 * 5);
      const calibrated = lightMs - offMs <= toleranceMs;
      await mkdir(directory, { recursive: true });
      await writeFile(artifact, JSON.stringify({ schema: "reelterminal.probe-calibration/v1", status: calibrated ? "qualified" : "probe_overhead_exceeded", build, environment, controls, runs, comparison: { offMedianMs: offMs, lightMedianMs: lightMs, toleranceMs, overheadPercent: (lightMs / offMs - 1) * 100, method: "five_ABBA_blocks_same_instance_six_real_gestures", heap: "CDP_JSHeapUsedSize_not_total_allocation", cpu: "CDP_TaskDuration", rss: "Electron_renderer_working_set_bytes" } }, null, 2));
      artifactWritten = true;
      console.info("PERFORMANCE_CALIBRATION", artifact);
      expect(calibrated, "probe_overhead_exceeded; inspect calibration artifact").toBe(true);
      await cdp.detach();
      success = true;
    } finally {
      try {
        if (!success && !artifactWritten) {
          await mkdir(directory, { recursive: true });
          await writeFile(artifact, JSON.stringify({ schema: "reelterminal.probe-calibration/v1", status: "invalid", controls, runs }, null, 2));
          if (launched && !launched.page.isClosed()) {
            await launched.page.screenshot({ path: artifact.replace(/\.json$/, ".png"), timeout: 5_000 });
          }
        }
      } finally {
        try {
          await agent?.close();
        } finally {
          try {
            await launched?.close({ keepRunDir: !success });
          } finally {
            await release();
          }
        }
      }
    }
  }, 600_000);
});
