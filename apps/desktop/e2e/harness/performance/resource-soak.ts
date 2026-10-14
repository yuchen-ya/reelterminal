import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { TimelineState } from "@reelterminal/agent-facade";
import type { CDPSession } from "playwright-core";
import type { CaptureReport } from "../../../../web/src/performance";
import type { ProductPerformanceCaptureApi } from "../../../../web/src/performance/product-capture-bridge";
import type { PerfStopReply } from "../../../src/shared/performance-contract";
import { createPerformanceFixture, performanceFixtureManifestSha256 } from "../../performance/fixtures";
import { launchApp, type LaunchedApp } from "../launch";
import { connectExternalAgent, type ExternalAgent } from "../mcp-client";
import { ARTIFACTS_DIR } from "../paths";
import { enableAgentSessionViaUI } from "../ui";
import { installProbe, prepareProfile, waitForMarker, type PerformanceRunOptions } from "./driver";
import { captureBuildIdentity, readEnvironmentIdentity } from "./identity";
import { createPerformanceResult, summarizeOperations, type RawPerformanceOperation } from "./result";
import { summarizeIdleMemory, type IdleResourceSample } from "./resource-trend";
import { saturateHistory, HISTORY_WARMUP_INTERVAL_MS } from "./history-saturation";
import { validateResultDocument } from "../../../../../scripts/performance/result-contract.mjs";

type ResourceGlobal = typeof globalThis & {
  __reelterminalPerformanceCapture: ProductPerformanceCaptureApi;
  __reelterminalPerfDriver: {
    start(runId: string, id: string, seconds: number): Promise<void>;
    stop(outcome: string): Promise<{ report: CaptureReport; main: PerfStopReply; hiddenDuringAction: boolean }>;
  };
};

class UserRequestedResourceStop extends Error {}

/** Serial edit/undo/redo with fixed assets, rotated captures, and idle samples. */
export async function runResourceSoakScenario(scenarioId: "R01" | "R02", options: PerformanceRunOptions, repeat: number): Promise<string> {
  const base = createPerformanceFixture({ scenarioId: "H01", seed: options.seed, parameters: { nodeCount: 10 } });
  const fixture = {
    ...base,
    manifest: {
      ...base.manifest, scenarioId,
      parameters: { editRounds: scenarioId === "R01" ? options.editRounds : 0, durationSeconds: scenarioId === "R02" ? options.durationSeconds : 0, actionIntervalMs: options.actionIntervalMs, clipCount: 1, nodeCount: 10, saturateHistory: options.saturateHistory ?? false },
      expectedSemantics: ["Fixed clip/media/node count through edit, undo, redo, save and history preview return.", "Idle save queues drain and temporary resources return to their warmed baseline.", "Memory observations use idle segments without forced GC; RSS is not VRAM."],
      expectedOperations: scenarioId === "R01" ? options.editRounds : Math.ceil(options.durationSeconds * 1000 / options.actionIntervalMs),
      timeBudgetMs: options.runTimeoutSeconds * 1000,
    },
  };
  const runId = `${scenarioId.toLowerCase()}-${Date.now()}-${repeat}`;
  const build = await captureBuildIdentity();
  if (!build.build_verified) throw new Error("resource soak requires a matching production build");
  const directory = path.join(ARTIFACTS_DIR, "performance");
  await mkdir(directory, { recursive: true });
  const runDir = await prepareProfile(fixture);
  await writeFile(path.join(directory, `${runId}.profile.json`), JSON.stringify({ run_id: runId, retained_profile: runDir, source_head: build.source_head }));
  let launched: LaunchedApp | undefined;
  let agent: ExternalAgent | undefined;
  let cdp: CDPSession | undefined;
  let environment: Awaited<ReturnType<typeof readEnvironmentIdentity>> | undefined;
  let failure: unknown;
  let timedOut = false;
  let activeCapture = false;
  let userRequestedStop = false;
  const operations: RawPerformanceOperation[] = [];
  const idle: IdleResourceSample[] = [];
  const reasons: string[] = [];
  let eventsDropped = 0;
  let endpointsDropped = 0;
  let rounds = 0;
  let revision = 0;
  let started = 0;
  let measuredElapsedMs = 0;
  let saturation: { capacity: number; edits: number; plateauCounts: number[]; elapsed_ms: number; interval_ms: number } | null = null;
  let lastCapture: Record<string, unknown> | null = null;
  const correctness: Record<string, boolean | null> = { final_state_verified: null, target_frame_verified: null, resources_returned_verified: null, save_queue_drained_verified: null };
  const runDeadline = performance.now() + options.runTimeoutSeconds * 1000;
  const watchdog = setTimeout(() => {
    timedOut = true;
    void launched?.close({ keepRunDir: true }).catch((error) => { failure ??= error; });
  }, options.runTimeoutSeconds * 1000);
  try {
    launched = await launchApp({ runDir, skipLocaleReload: true });
    const page = launched.page;
    cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    page.setDefaultTimeout(options.operationTimeoutMs);
    await launched.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.setContentSize(1280, 800); window.show(); window.focus();
    });
    environment = await readEnvironmentIdentity(launched);
    if (!environment.visible || environment.devtools_open) throw new Error("invalid resource-soak window");
    await installProbe(page);
    await page.getByRole("button", { name: `Open ${fixture.project!.name}`, exact: true }).click();
    await enableAgentSessionViaUI(page, launched.endpointFile);
    agent = await connectExternalAgent(launched.endpointFile);
    const target = { projectId: fixture.projectId!, workspaceId: fixture.workspaceId! };
    const read = async () => {
      const reply = await agent!.callTool<TimelineState>("timeline_get", target, { timeoutMs: options.operationTimeoutMs });
      if (!reply.ok) throw new Error(`resource timeline read failed: ${reply.error?.code}`);
      revision = reply.value!.revision;
      return reply.value!;
    };
    const initial = await read();
    const clip = initial.tracks.flatMap((track) => track.clips)[0]!;
    const clipBox = await page.locator(`[data-live-editor-target-id="${clip.id}"]`).first().boundingBox();
    const rulerBox = await page.getByTestId("timeline-time-ruler").boundingBox();
    if (!clipBox || !rulerBox) throw new Error("resource fixture timeline geometry unavailable");
    await page.mouse.click(rulerBox.x + 3 * clipBox.width / clip.duration, rulerBox.y + rulerBox.height / 2);
    const currentMarker = { ...fixture, targetMarker: { ...fixture.targetMarker!, rgb: [210, 75, 75] as const } };
    const verifyPlayhead = async () => {
      const context = await agent!.callTool<{ playheadSeconds: number }>("editor_get_context", target, { timeoutMs: options.operationTimeoutMs });
      if (!context.ok || Math.abs(context.value!.playheadSeconds - 3) > 0.06) throw new Error("resource history preview did not preserve the editing playhead");
    };
    const stateMatches = async (time: number) => {
      const state = await read();
      const clips = state.tracks.flatMap((track) => track.clips);
      if (clips.length !== 1 || state.tracks.length !== initial.tracks.length || Math.abs(clips[0]!.startTime - time) > 0.001 || clips[0]!.mediaId !== clip.mediaId || clips[0]!.duration !== clip.duration) throw new Error("resource cycle changed fixed fixture state");
      await waitForMarker(page, currentMarker, options.operationTimeoutMs);
    };
    const historyRoundTrip = async () => {
      const node = page.getByTestId(`version-node-${fixture.targetNodeId}`);
      if (!await node.isVisible()) await page.getByTestId("current-archive-entry").click();
      await node.scrollIntoViewIfNeeded(); await node.dblclick();
      await page.getByTestId("version-preview-banner").waitFor();
      await waitForMarker(page, fixture, options.operationTimeoutMs);
      await page.getByTestId("version-preview-return").click();
      await page.getByTestId("version-preview-banner").waitFor({ state: "hidden" });
      await verifyPlayhead();
      await waitForMarker(page, currentMarker, options.operationTimeoutMs);
    };
    const settleAndSample = async () => {
      // Save completion is observed through the production queue registry.
      await page.keyboard.press("Control+s");
      await page.waitForFunction(async () => {
        const snapshot = await (globalThis as ResourceGlobal).__reelterminalPerformanceCapture.readResources();
        return snapshot.workspace.queuedWrites === 0 && snapshot.workspace.pendingWrites === 0;
      }, null, { timeout: options.operationTimeoutMs });
      // One full second without actions after the durable queue has drained.
      await page.waitForTimeout(1000);
      const renderer = await page.evaluate(async () => ({
        resources: await (globalThis as ResourceGlobal).__reelterminalPerformanceCapture.readResources(),
        heap: (globalThis.performance as globalThis.Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null,
        visible: !document.hidden,
      }));
      if (!renderer.visible) throw new Error("resource-soak window hidden");
      if (renderer.resources.workspace.failedWriteCount > 0) throw new Error("resource-soak save failed instead of draining successfully");
      // Read available V8/DOM metrics during stable idle, without requesting GC.
      const metrics = await cdp!.send("Performance.getMetrics");
      const heap = Object.fromEntries(metrics.metrics.map((metric: { name: string; value: number }) => [metric.name, metric.value]));
      const main = await launched!.app.evaluate(({ app }) => {
        const memory = process.memoryUsage();
        return {
          main_memory: { heap_used_bytes: memory.heapUsed, heap_total_bytes: memory.heapTotal, external_bytes: memory.external, array_buffer_bytes: memory.arrayBuffers },
          rss: app.getAppMetrics().filter((metric) => ["Browser", "Tab", "Renderer", "GPU", "Utility"].includes(metric.type)).map((metric) => ({
            role: metric.type === "Browser" ? "main" : metric.type === "Tab" ? "renderer" : metric.type.toLowerCase(),
            process_epoch: `${metric.pid}-${metric.creationTime}`,
            rss_bytes: metric.memory?.workingSetSize === undefined ? null : metric.memory.workingSetSize * 1024,
          })),
        };
      });
      const sample: IdleResourceSample = { elapsed_ms: performance.now() - started, heap_bytes: heap.JSHeapUsedSize ?? renderer.heap, heap_source: heap.JSHeapUsedSize !== undefined ? "CDP_JSHeapUsedSize" : renderer.heap !== null ? "Chromium_estimate" : "unavailable", heap_total_bytes: heap.JSHeapTotalSize ?? null, main_memory: main.main_memory, dom: { nodes: heap.Nodes ?? null, documents: heap.Documents ?? null, event_listeners: heap.JSEventListeners ?? null }, rss: main.rss, resources: renderer.resources as unknown as Record<string, unknown> };
      idle.push(sample);
      await appendFile(path.join(directory, `${runId}.idle.jsonl`), `${JSON.stringify(sample)}\n`);
      correctness.save_queue_drained_verified = true;
      console.info("PERFORMANCE_RESOURCE_PROGRESS", {
        scenario: scenarioId,
        elapsed_seconds: Math.round((performance.now() - started) / 1000),
        completed_rounds: rounds,
        pending_writes: renderer.resources.workspace.pendingWrites,
        undo_entries: renderer.resources.history.actionUndo,
        renderer_heap_mib: Math.round((sample.heap_bytes ?? 0) / 1048576 * 100) / 100,
        main_heap_mib: Math.round(main.main_memory.heap_used_bytes / 1048576 * 100) / 100,
        owned_blob_urls: renderer.resources.media.ownedBlobUrls,
      });
      return renderer.resources;
    };
    // Prime both views and optional worker initialization outside measured runs.
    await verifyPlayhead();
    await historyRoundTrip();
    await stateMatches(clip.startTime);
    if (options.saturateHistory) {
      const warmStarted = performance.now();
      const saturated = await saturateHistory(
        () => page.evaluate(async () => (await (globalThis as ResourceGlobal).__reelterminalPerformanceCapture.readResources()).history),
        async (index) => {
          const moved = await agent!.callTool<{ revision: number }>("edit_apply", { ...target, expectedRevision: revision, ops: [{ op: "clip.move", clipId: clip.id, startTime: index % 2 === 0 ? clip.startTime + 0.5 : clip.startTime }] }, { timeoutMs: options.operationTimeoutMs });
          if (!moved.ok || moved.value!.revision !== revision + 1) throw new Error("history warmup edit did not commit one revision");
          revision = moved.value!.revision;
          if (index % 100 === 0) console.info("PERFORMANCE_HISTORY_WARMUP", { edits: index + 1 });
        },
        () => page.waitForTimeout(HISTORY_WARMUP_INTERVAL_MS),
      );
      saturation = { ...saturated, elapsed_ms: performance.now() - warmStarted, interval_ms: HISTORY_WARMUP_INTERVAL_MS };
      // Restore the fixed start using another real edit if warmup ended offset.
      const state = await read();
      if (state.tracks.flatMap(track => track.clips)[0]!.startTime !== clip.startTime) {
        const restored = await agent.callTool<{ revision: number }>("edit_apply", { ...target, expectedRevision: revision, ops: [{ op: "clip.move", clipId: clip.id, startTime: clip.startTime }] }, { timeoutMs: options.operationTimeoutMs });
        if (!restored.ok) throw new Error("history warmup final edit failed");
        revision = restored.value!.revision;
      }
      await stateMatches(clip.startTime);
      await historyRoundTrip();
    }
    if (scenarioId === "R02" && runDeadline - performance.now() < (options.durationSeconds + 60) * 1000) {
      reasons.push("insufficient_measurement_budget");
      throw new Error("resource-soak startup left insufficient time for measurement and cleanup; increase --run-timeout-seconds");
    }
    started = performance.now();
    const baseline = await settleAndSample();
    let lastIdle = started;
    while (scenarioId === "R01" ? rounds < options.editRounds : performance.now() - started < options.durationSeconds * 1000) {
      if (timedOut) throw new Error("resource-soak elapsed budget exceeded");
      // An explicit external marker asks for a complete idle boundary, never
      // kills the editor or bypasses final queue/state/resource verification.
      if (process.env.REELTERMINAL_RESOURCE_STOP_FILE && existsSync(process.env.REELTERMINAL_RESOURCE_STOP_FILE)) {
        userRequestedStop = true;
        break;
      }
      const operationId = `edit-undo-redo-${rounds}`;
      const cycleStart = performance.now();
      await page.evaluate(({ runId, operationId, seconds }) => (globalThis as ResourceGlobal).__reelterminalPerfDriver.start(runId, operationId, seconds), { runId, operationId, seconds: options.operationTimeoutMs / 1000 });
      activeCapture = true;
      const beforeTime = rounds % 2 === 0 ? clip.startTime : clip.startTime + 0.5;
      const afterTime = rounds % 2 === 0 ? clip.startTime + 0.5 : clip.startTime;
      const moved = await agent.callTool<{ revision: number }>("edit_apply", { ...target, expectedRevision: revision, ops: [{ op: "clip.move", clipId: clip.id, startTime: afterTime }] }, { timeoutMs: options.operationTimeoutMs });
      if (!moved.ok || moved.value!.revision !== revision + 1) throw new Error("soak edit did not commit one revision");
      revision = moved.value!.revision;
      await stateMatches(afterTime);
      for (const action of ["undo", "redo"] as const) {
        const reply = await agent.callTool<{ revision: number }>("history_control", { ...target, action, expectedRevision: revision, idempotencyKey: `${runId}-${rounds}-${action}` }, { timeoutMs: options.operationTimeoutMs });
        if (!reply.ok || reply.value!.revision !== revision + 1) throw new Error(`soak ${action} failed: ${reply.error?.code ?? `revision ${revision} -> ${reply.value!.revision}`}`);
        revision = reply.value!.revision;
        await stateMatches(action === "undo" ? beforeTime : afterTime);
      }
      await page.waitForFunction(() => (globalThis as ResourceGlobal).__reelterminalPerformanceCapture.pendingSpanCount === 0, null, { timeout: options.operationTimeoutMs });
      const evidence = await page.evaluate(() => (globalThis as ResourceGlobal).__reelterminalPerfDriver.stop("ok"));
      activeCapture = false;
      const main = evidence.main.ok ? evidence.main.mainCapture : null;
      const ended = new Set(main?.events.filter(event => event.kind === "span_end").map(event => event.spanId));
      const openDetails = main?.events.flatMap(event => event.kind === "span_begin" && !ended.has(event.spanId)
        ? [{ phase: event.phase === "live.ipc.main.request" ? event.phase : "other", ageUs: Math.max(0, main.stoppedUs - event.tsUs) }] : []).slice(0, 8) ?? [];
      lastCapture = {
        status: evidence.report.status, reasonCodes: evidence.report.reasonCodes,
        wallDurationUs: evidence.report.wallDurationUs, hiddenDuringAction: evidence.hiddenDuringAction,
        rendererOpenSpans: evidence.report.openSpans,
        mainStatus: evidence.main.ok ? evidence.main.mainCapture.status : "unavailable",
        mainReasonCodes: evidence.main.ok ? evidence.main.mainCapture.reasonCodes : ["main_capture_unavailable"],
        mainOpenSpans: evidence.main.ok ? evidence.main.mainCapture.openSpans : null,
        mainOpenPhases: openDetails.map(detail => detail.phase),
        mainOldestOpenSpanUs: Math.max(0, ...openDetails.map(detail => detail.ageUs)),
      };
      eventsDropped += evidence.report.drops.eventsDropped + (evidence.main.ok ? evidence.main.mainCapture.eventsDropped : 0);
      endpointsDropped += evidence.report.drops.criticalEndpointsDropped;
      if (evidence.hiddenDuringAction || evidence.report.status !== "complete" || !evidence.main.ok || evidence.main.mainCapture.status !== "complete") {
        console.info("RESOURCE_CAPTURE_FAILURE", JSON.stringify(lastCapture));
        throw new Error("resource cycle capture incomplete");
      }
      operations.push({ operation_id: operationId, metric: "edit_undo_redo_content_verified_ms", outcome: "ok", duration_ms: evidence.report.wallDurationUs / 1000, target_verified: true });
      rounds++;
      if (performance.now() - lastIdle >= 30_000 || (scenarioId === "R01" && rounds % 100 === 0)) {
        await historyRoundTrip(); await stateMatches(afterTime); await settleAndSample(); lastIdle = performance.now();
      }
      if (scenarioId === "R02") {
        const remaining = options.actionIntervalMs - (performance.now() - cycleStart);
        if (remaining > 0) await page.waitForTimeout(remaining);
      }
    }
    await historyRoundTrip();
    await stateMatches(rounds % 2 === 0 ? clip.startTime : clip.startTime + 0.5);
    const final = await settleAndSample();
    // History is intentionally retained but bounded; transient view leases return.
    if (final.history.actionUndo > final.history.actionCapacity || final.history.actionRedo !== 0 || final.history.changeJournalRevisions > 256) throw new Error("history/journal exceeded its production bound");
    if (saturation && idle.some(sample => {
      const history = sample.resources.history as { actionUndo: number; actionCapacity: number };
      return history.actionCapacity !== saturation!.capacity || history.actionUndo !== saturation!.capacity;
    })) throw new Error("history capacity was not stable throughout observation");
    for (const key of ["projectLeases", "projectFaces"] as const) if (final.fonts[key] !== baseline.fonts[key]) throw new Error("font leases did not return to the warmed baseline");
    if (final.workspace.runtimes !== baseline.workspace.runtimes || final.media.ownedBlobUrls !== baseline.media.ownedBlobUrls) throw new Error("runtime/blob resource count grew across fixed-asset cycles");
    for (const key of ["previewVideoCacheEntries", "previewImageBitmapCacheEntries", "motionImageBitmapCacheEntries", "motionVideoElementCacheEntries"] as const) {
      if (final.media[key] !== baseline.media[key]) throw new Error("fixed-media caches did not return to their warmed baseline");
    }
    correctness.final_state_verified = true; correctness.target_frame_verified = true; correctness.resources_returned_verified = true;
    measuredElapsedMs = performance.now() - started;
    if (userRequestedStop) throw new UserRequestedResourceStop("user requested a graceful resource-soak stop");
  } catch (error) {
    failure = error;
    reasons.push(error instanceof UserRequestedResourceStop ? "user_requested_stop" : timedOut ? "run_timeout" : "resource_soak_failed");
    operations.push({ operation_id: `failed-${rounds}`, metric: "edit_undo_redo_content_verified_ms", outcome: error instanceof UserRequestedResourceStop ? "cancelled" : timedOut || (error as Error).name === "TimeoutError" ? "timeout" : "failed", duration_ms: null, waited_ms: started ? performance.now() - started : 0, target_verified: false });
    const failureDirectory = path.join(ARTIFACTS_DIR, "performance");
    await mkdir(failureDirectory, { recursive: true });
    await writeFile(path.join(failureDirectory, `${runId}.failure.json`), JSON.stringify({ error: String(error), completed_rounds: rounds, history_saturation: saturation, idle_samples: idle }, null, 2));
    await launched?.page.screenshot({ path: path.join(failureDirectory, `${runId}.failure.png`), timeout: 5_000 }).catch(() => undefined);
  } finally {
    clearTimeout(watchdog);
    if (activeCapture && launched && !launched.page.isClosed()) {
      try { await launched.page.evaluate(() => (globalThis as ResourceGlobal).__reelterminalPerfDriver.stop("error")); }
      catch (error) { failure ??= error; reasons.push("capture_cleanup_failed"); }
    }
    try { await agent?.close(); } catch (error) { failure ??= error; reasons.push("connector_cleanup_failed"); }
    await cdp?.detach().catch(() => undefined);
    try { await launched?.close({ keepRunDir: true }); } catch (error) { failure ??= error; reasons.push("process_cleanup_failed"); }
  }
  if (!environment) {
    await writeFile(path.join(directory, `${runId}.preflight.json`), JSON.stringify({ schema: "reelterminal.performance-preflight/v1", status: "invalid", reason_codes: [...reasons, "environment_unavailable"], retained_profile: runDir, build }));
    throw failure ?? new Error("resource-soak environment unavailable");
  }
  const result = createPerformanceResult({
    run: {
      run_id: runId,
      scenario_id: scenarioId,
      scenario_version: 1,
      seed: options.seed,
      fixture_manifest: fixture.manifest,
      fixture_manifest_sha256: performanceFixtureManifestSha256(fixture.manifest),
      mode: "light",
      cache_state: "warm_fixed_views",
      sampling: { input_every_n: 1, frame_every_n: 1 },
      budgets: { capture_seconds: options.operationTimeoutMs / 1000, events_capacity: 16384, run_seconds: options.runTimeoutSeconds },
      expected_operations: operations.length,
      completed_rounds: rounds,
      requested_duration_seconds: scenarioId === "R02" ? options.durationSeconds : null,
      elapsed_ms: measuredElapsedMs || (started ? performance.now() - started : 0),
      action_interval_ms: options.actionIntervalMs,
      warmup: "one_history_preview_return",
      actual_presented: "unsupported",
      forced_gc: false,
      user_requested_stop: userRequestedStop,
    },
    build: { ...build }, environment: { ...environment }, samples: operations, correctness,
    validity: { complete: !failure, reason_codes: reasons, events_dropped: eventsDropped, critical_endpoints_dropped: endpointsDropped, probe_calibrated: false },
  });
  const third = Math.max(1, Math.floor(operations.length / 3));
  const artifactDocument = {
    ...result,
    last_capture: lastCapture,
    history_saturation: saturation,
    idle_samples: idle,
    memory_trends: summarizeIdleMemory(idle),
    distributions_by_phase: {
      early: summarizeOperations(operations.slice(0, third), "warm", !failure),
      middle: summarizeOperations(operations.slice(third, third * 2), "warm", !failure),
      late: summarizeOperations(operations.slice(third * 2), "warm", !failure),
    },
  };
  const json = JSON.stringify(artifactDocument, null, 2);
  const file = path.join(directory, `${runId}.result.json`);
  if (Buffer.byteLength(json) > 10 * 1024 * 1024) {
    await writeFile(file.replace(/\.result\.json$/, ".preflight.json"), JSON.stringify({
      schema: "reelterminal.performance-preflight/v1", status: "invalid",
      reason_codes: ["artifact_budget_exceeded"], run_id: runId, completed_rounds: rounds,
    }));
    throw new Error("resource-soak artifact exceeds 10 MiB budget");
  }
  await writeFile(file, json);
  const validation = validateResultDocument(artifactDocument);
  if (!validation.valid) throw new Error(`resource-soak result invalid: ${validation.errors.join("; ")}`);
  if (failure) throw failure;
  await rm(runDir, { recursive: true, force: true });
  return file;
}
