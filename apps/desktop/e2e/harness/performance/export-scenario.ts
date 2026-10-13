import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { Project } from "@reelterminal/core/types/project";
import type { ExportCallbacks, ExportVideoRequest } from "@reelterminal/agent-facade";
import {
  ChromiumExportProvider,
  ExportPerformanceCapture,
  PartFileWriter,
  beginExportPerformanceSpan,
  endExportPerformanceSpan,
  markExportPerformance,
  withExportPerformanceSpan,
  type ExportPerformanceSink,
} from "@reelterminal/runtime-chromium";
import type { ChromiumProviderPool, ChromiumRuntime, ExportProgressJson } from "@reelterminal/runtime-chromium";
import type { JobStatusView } from "@reelterminal/agent-facade";
import { DurableTaskLedger, type DurableTaskInput } from "../../../src/main/live/task-ledger";
import { captureBuildIdentity } from "./identity";
import { ARTIFACTS_DIR } from "../paths";
import { createPerformanceResult, type RawPerformanceOperation } from "./result";
import { performanceFixtureManifestSha256 } from "../../performance/fixtures";
import type { PerformanceRunOptions } from "./driver";
import { validateResultDocument } from "../../../../../scripts/performance/result-contract.mjs";

const E01_DURATION_SECONDS = 3;
const E01_FRAME_RATE = 1;
const E01_INPUT_PAYLOAD_BYTES = 2_000_000;
const E01_MAX_SAMPLES = 100;
const E01_CAPTURE_CAPACITY = 16_384;
const E01_HARD_TIME_LIMIT_MS = 120_000;
const E01_PROGRESS_INTERVAL_MS = 2;

type FakeOutcome = "success" | "failure" | "cancel";
type TerminalState = "done" | "error" | "cancelled";

interface Deferred<T = void> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

interface FakeRuntimeControls {
  register(jobId: string, outcome: FakeOutcome): void;
  waitForStart(jobId: string): Promise<void>;
  readonly runtime: ChromiumRuntime;
}

interface FakeJobResult {
  readonly terminal: TerminalState;
  readonly durationMs: number;
  readonly outputPath: string;
  readonly outputBytes: number;
  readonly inputUnchanged: boolean;
  readonly inputWriteCount: number;
  readonly finalStatus: JobStatusView;
  readonly progressStatusPersisted: boolean;
}

interface ActiveFakeJob {
  readonly terminal: Promise<TerminalState>;
}

/**
 * E01 runs the production export-job coordinator and disk writer against a
 * deterministic fake page backend. It exercises progress, terminal cleanup,
 * and durable status writes without launching a desktop or encoding media.
 */
export async function runExportPerformanceScenario(
  options: PerformanceRunOptions,
  repeat: number,
): Promise<string> {
  if (!Number.isInteger(options.samples) || options.samples < 1 || options.samples > E01_MAX_SAMPLES) {
    throw new RangeError(`E01 supports 1..${E01_MAX_SAMPLES} samples; received ${options.samples}`);
  }
  if (!Number.isFinite(options.runTimeoutSeconds) || options.runTimeoutSeconds <= 0) {
    throw new RangeError("E01 requires a positive run timeout");
  }

  const startedAt = performance.now();
  const runId = `e01-${Date.now()}-${repeat}`;
  const budgetMs = Math.min(options.runTimeoutSeconds * 1_000, E01_HARD_TIME_LIMIT_MS);
  const deadlineAt = startedAt + budgetMs;
  const workDeadlineAt = deadlineAt - Math.min(1_000, budgetMs * 0.05);
  const fixtureManifest = {
    schema: "reelterminal.performance-fixture/v1",
    scenarioId: "E01",
    version: 1,
    seed: options.seed,
    parameters: {
      backend: "deterministic-fake-export-provider",
      durationSeconds: E01_DURATION_SECONDS,
      frameRate: E01_FRAME_RATE,
      sampleCount: options.samples,
      fixedInputPayloadBytes: E01_INPUT_PAYLOAD_BYTES,
    },
    expectedSemantics: [
      "Each requested sample completes through the serialized export provider and atomic part-file writer.",
      "Progress updates change durable status only; fixed export input bytes remain identical.",
      "Failure removes partial output and cancellation settles as cancelled without a success-looking artifact.",
      "The fake backend does not encode audio or video; those backend-specific phases remain unavailable.",
    ],
    assets: [],
    requiredCapabilities: ["deterministic-fake-export-provider", "part-file-writer", "durable-task-ledger-v2"],
    expectedOperations: options.samples,
    timeBudgetMs: budgetMs,
  } as const;
  const capture = new ExportPerformanceCapture({
    enabled: true,
    supportedPhases: [
      "submit", "queue", "prepare", "render", "write", "progress",
      "status.persist", "cancel", "finalize",
    ],
    capacity: E01_CAPTURE_CAPACITY,
    openSpanCapacity: 256,
  });

  const build = await withDeadline(captureBuildIdentity(), workDeadlineAt, "E01 build identity");
  if (!build.build_verified) {
    throw new Error(`E01 requires a verified production build: ${build.build_reason}`);
  }
  const environment = fakeBackendEnvironment();
  const runRoot = await mkdtemp(path.join(os.tmpdir(), "reelterminal-e01-export-"));
  const jobsRoot = path.join(runRoot, "jobs");
  const ledgerRoot = path.join(runRoot, "task-records");
  await mkdir(jobsRoot, { recursive: true });
  const inputWriteCounts = new Map<string, number>();
  const ledger = new DurableTaskLedger(ledgerRoot, {
    progressWriteIntervalMs: E01_PROGRESS_INTERVAL_MS,
    exportPerformanceSinkForJob: () => capture,
    onInputWrite: (jobId) => inputWriteCounts.set(jobId, (inputWriteCounts.get(jobId) ?? 0) + 1),
  });
  const behaviors = new Map<string, FakeOutcome>();
  const runtime = createFakeRuntime(capture, behaviors);
  const provider = new ChromiumExportProvider({
    runtime: runtime.runtime,
    exportWatchdogMs: Math.max(options.operationTimeoutMs, 1_000),
    exportTotalBudgetMs: budgetMs,
    exportRoute: async () => "chromium-webcodecs",
    exportPerformanceSinkForJob: () => undefined,
  } as unknown as ChromiumProviderPool);

  const samples: RawPerformanceOperation[] = [];
  const correctness: Record<string, boolean | null> = {
    fixed_input_immutable_verified: null,
    progress_status_persisted_verified: null,
    successful_export_verified: null,
    failed_export_cleanup_verified: null,
    cancellation_cleanup_verified: null,
  };
  const activeJobs = new Map<string, ActiveFakeJob>();
  let failure: Error | null = null;
  let cleanupFailure: Error | null = null;

  try {
    try {
      const sentinel = await runPersistenceSentinel(ledger, ledgerRoot, inputWriteCounts, runId, workDeadlineAt);
      correctness.fixed_input_immutable_verified = sentinel.inputUnchanged && sentinel.inputWriteCount === 1;
      correctness.progress_status_persisted_verified = sentinel.progressPersisted;
      if (!correctness.fixed_input_immutable_verified || !correctness.progress_status_persisted_verified) {
        failure = new Error("E01 immutable-input progress persistence contract failed");
      }
    } catch (error) {
      failure = toError(error);
      correctness.fixed_input_immutable_verified = false;
      correctness.progress_status_persisted_verified = false;
    }

    for (let index = 0; index < options.samples; index += 1) {
      const operationId = `export-${String(index + 1).padStart(4, "0")}`;
      if (performance.now() >= workDeadlineAt) {
        failure ??= new Error("E01 global run budget expired before all requested exports started");
        break;
      }
      const startedMs = performance.now();
      const jobId = `${runId}-sample-${index + 1}`;
      let submitted = false;
      try {
        behaviors.set(jobId, "success");
        const result = await runFakeJob({
          provider, runtime, ledger, capture, jobsRoot, ledgerRoot, inputWriteCounts, activeJobs,
          jobId, outcome: "success", durationSeconds: E01_DURATION_SECONDS,
          operationTimeoutMs: options.operationTimeoutMs, deadlineAt: workDeadlineAt,
          onSubmitted: () => { submitted = true; },
        });
        const progressPersisted = result.progressStatusPersisted;
        const outputVerified = result.terminal === "done" && result.inputUnchanged &&
          result.inputWriteCount === 1 && progressPersisted &&
          result.finalStatus.state === "done" && result.outputBytes > 0;
        correctness.fixed_input_immutable_verified = (correctness.fixed_input_immutable_verified ?? true) && result.inputUnchanged && result.inputWriteCount === 1;
        correctness.progress_status_persisted_verified = (correctness.progress_status_persisted_verified ?? true) && progressPersisted;
        correctness.successful_export_verified = (correctness.successful_export_verified ?? true) && outputVerified;
        samples.push({
          operation_id: operationId,
          metric: "export.end_to_end_verified_ms",
          outcome: result.terminal === "done" ? "ok" : result.terminal === "cancelled" ? "cancelled" : "failed",
          duration_ms: result.terminal === "done" ? result.durationMs : null,
          target_verified: outputVerified,
        });
        if (!outputVerified) failure ??= new Error(`E01 successful export sample ${index + 1} failed verification`);
      } catch (error) {
        failure ??= toError(error);
        correctness.successful_export_verified = false;
        if (!submitted) break;
        samples.push({
          operation_id: operationId,
          metric: "export.end_to_end_verified_ms",
          outcome: performance.now() >= workDeadlineAt ? "timeout" : "failed",
          duration_ms: null,
          waited_ms: performance.now() - startedMs,
          target_verified: false,
        });
        if (performance.now() >= workDeadlineAt) {
          break;
        }
      }
    }

    if (performance.now() < workDeadlineAt) {
      const failedJobId = `${runId}-failure`;
      try {
        behaviors.set(failedJobId, "failure");
        const failed = await runFakeJob({
          provider, runtime, ledger, capture, jobsRoot, ledgerRoot, inputWriteCounts, activeJobs,
          jobId: failedJobId, outcome: "failure", durationSeconds: E01_DURATION_SECONDS,
          operationTimeoutMs: options.operationTimeoutMs, deadlineAt: workDeadlineAt,
        });
        correctness.failed_export_cleanup_verified = failed.terminal === "error" &&
          failed.finalStatus.state === "error" && failed.progressStatusPersisted &&
          failed.inputUnchanged && failed.inputWriteCount === 1 &&
          (await readdir(path.dirname(failed.outputPath))).length === 0;
        correctness.fixed_input_immutable_verified = (correctness.fixed_input_immutable_verified ?? true) && failed.inputUnchanged && failed.inputWriteCount === 1;
        correctness.progress_status_persisted_verified = (correctness.progress_status_persisted_verified ?? true) && failed.progressStatusPersisted;
        if (!correctness.failed_export_cleanup_verified) failure ??= new Error("E01 failed export cleanup contract failed");
      } catch (error) {
        correctness.failed_export_cleanup_verified = false;
        failure ??= toError(error);
      }
    } else {
      correctness.failed_export_cleanup_verified = false;
      failure ??= new Error("E01 global run budget expired before the failure case");
    }

    if (performance.now() < workDeadlineAt) {
      const cancelledJobId = `${runId}-cancel`;
      try {
        behaviors.set(cancelledJobId, "cancel");
        const cancelled = await runFakeJob({
          provider, runtime, ledger, capture, jobsRoot, ledgerRoot, inputWriteCounts, activeJobs,
          jobId: cancelledJobId, outcome: "cancel", durationSeconds: E01_DURATION_SECONDS,
          operationTimeoutMs: options.operationTimeoutMs, deadlineAt: workDeadlineAt,
        });
        correctness.cancellation_cleanup_verified = cancelled.terminal === "cancelled" &&
          cancelled.finalStatus.state === "cancelled" && cancelled.progressStatusPersisted &&
          cancelled.inputUnchanged && cancelled.inputWriteCount === 1 &&
          (await readdir(path.dirname(cancelled.outputPath))).length === 0;
        correctness.fixed_input_immutable_verified = (correctness.fixed_input_immutable_verified ?? true) && cancelled.inputUnchanged && cancelled.inputWriteCount === 1;
        correctness.progress_status_persisted_verified = (correctness.progress_status_persisted_verified ?? true) && cancelled.progressStatusPersisted;
        if (!correctness.cancellation_cleanup_verified) failure ??= new Error("E01 cancellation cleanup contract failed");
      } catch (error) {
        correctness.cancellation_cleanup_verified = false;
        failure ??= toError(error);
      }
    } else {
      correctness.cancellation_cleanup_verified = false;
      failure ??= new Error("E01 global run budget expired before the cancellation case");
    }
  } catch (error) {
    failure ??= toError(error);
  }

  for (const jobId of activeJobs.keys()) {
    try {
      await withDeadline(provider.cancel(jobId), deadlineAt, `E01 cancel cleanup for ${jobId}`);
    } catch (error) {
      cleanupFailure ??= toError(error);
    }
  }
  for (const [jobId, activeJob] of activeJobs) {
    try {
      await withDeadline(activeJob.terminal, deadlineAt, `E01 settle cleanup for ${jobId}`);
      activeJobs.delete(jobId);
    } catch (error) {
      cleanupFailure ??= toError(error);
    }
  }
  if (cleanupFailure) failure ??= cleanupFailure;
  if (!failure) {
    try {
      await withDeadline(rm(runRoot, { recursive: true, force: true }), deadlineAt, "E01 temporary workspace cleanup");
    } catch (error) {
      cleanupFailure = toError(error);
      failure = cleanupFailure;
    }
  }

  const report = capture.report();
  const failureReason = failure ? "scenario_failed" : null;
  const cleanupFailed = cleanupFailure !== null;
  const result = createPerformanceResult({
    run: {
      run_id: runId,
      scenario_id: "E01",
      scenario_version: 1,
      seed: options.seed,
      fixture_manifest: fixtureManifest,
      fixture_manifest_sha256: performanceFixtureManifestSha256(fixtureManifest),
      expected_operations: samples.length,
      mode: "light",
      cache_state: "warm_stateless_fake_backend",
      sampling: { input_every_n: 1, frame_every_n: 1 },
      budgets: {
        capture_seconds: Math.max(0.001, options.operationTimeoutMs / 1_000),
        events_capacity: E01_CAPTURE_CAPACITY,
        run_seconds: budgetMs / 1_000,
      },
      warmup: "not_applicable_fake_backend",
      repeat,
      measurement_boundary: "provider submission to verified final file and durable terminal status",
      backend: "deterministic-fake-export-provider",
      export_duration_seconds: E01_DURATION_SECONDS,
      encode_backend: "unavailable_fake_backend",
      audio_backend: "unavailable_fake_backend",
    },
    build: { ...build },
    environment,
    samples,
    correctness,
    structural: {
      export_samples: options.samples,
      requested_export_samples: options.samples,
      attempted_export_samples: samples.length,
      unattempted_export_samples: Math.max(0, options.samples - samples.length),
      fixed_input_payload_bytes: E01_INPUT_PAYLOAD_BYTES,
      immutable_input_document_writes: sumCounts(inputWriteCounts),
      immutable_input_documents: inputWriteCounts.size,
      immutable_input_rewrites: sumCounts(inputWriteCounts) - inputWriteCounts.size,
      durable_status_writes: report.events.filter((event) => event.kind === "span_end" && event.phase === "status.persist").length,
      export_duration_seconds: E01_DURATION_SECONDS,
      fake_video_frames_per_export: Math.ceil(E01_DURATION_SECONDS * E01_FRAME_RATE),
      performance_events: report.events.length,
      performance_events_dropped: report.eventsDropped,
    },
    validity: {
      complete: report.status === "complete" && failure === null && !cleanupFailed,
      reason_codes: [
        ...(report.status === "complete" ? [] : ["export_performance_capture_incomplete"]),
        ...(failureReason ? [failureReason] : []),
        ...(samples.length < options.samples ? ["requested_operations_not_attempted"] : []),
        ...(cleanupFailed ? ["cleanup_failed"] : []),
      ],
      events_dropped: report.eventsDropped,
      critical_endpoints_dropped: 0,
      probe_calibrated: false,
    },
  });
  const artifactDocument = {
    ...result,
    export_performance: {
      status: report.status,
      clock_status: report.clockStatus,
      phase_status: report.phaseStatus,
      events_dropped: report.eventsDropped,
      collector_errors: report.collectorErrors,
      open_spans: report.openSpans,
      events: report.events,
      retained_temp_root: failure ? path.basename(runRoot) : null,
    },
  };
  const validation = validateResultDocument(artifactDocument);
  if (!validation.valid) throw new Error(`E01 result invalid: ${validation.errors.join("; ")}`);

  const outputDirectory = path.join(ARTIFACTS_DIR, "performance");
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, `${runId}.result.json`);
  await writeFile(outputPath, JSON.stringify(artifactDocument, null, 2), "utf8");
  if (failure) {
    throw new Error(`E01 failed; result ${path.basename(outputPath)}; retained temp ${path.basename(runRoot)}: ${failure.message}`);
  }
  return outputPath;
}

async function runFakeJob(args: {
  readonly provider: ChromiumExportProvider;
  readonly runtime: FakeRuntimeControls;
  readonly ledger: DurableTaskLedger;
  readonly capture: ExportPerformanceCapture;
  readonly jobsRoot: string;
  readonly ledgerRoot: string;
  readonly inputWriteCounts: ReadonlyMap<string, number>;
  readonly activeJobs: Map<string, ActiveFakeJob>;
  readonly jobId: string;
  readonly outcome: FakeOutcome;
  readonly durationSeconds: number;
  readonly operationTimeoutMs: number;
  readonly deadlineAt: number;
  readonly onSubmitted?: () => void;
}): Promise<FakeJobResult> {
  const {
    provider, runtime, ledger, capture, jobsRoot, ledgerRoot, inputWriteCounts, activeJobs,
    jobId, outcome, durationSeconds, operationTimeoutMs, deadlineAt,
  } = args;
  const jobDeadlineAt = Math.min(deadlineAt, performance.now() + operationTimeoutMs);
  assertBeforeDeadline(jobDeadlineAt, `E01 ${jobId} setup`);
  const jobDir = path.join(jobsRoot, jobId);
  await mkdir(jobDir, { recursive: true });
  const project = fakeProject(jobId);
  const input: DurableTaskInput = {
    jobId,
    kind: "export",
    projectId: project.id,
    workspaceId: "e01-workspace",
    sourceRevision: 1,
    inputProject: project,
    parameters: { backend: "deterministic-fake", durationSeconds },
  };
  assertBeforeDeadline(jobDeadlineAt, `E01 ${jobId} immutable input`);
  ledger.begin(input);
  const inputPath = path.join(ledgerRoot, `${jobId}.json`);
  const inputBefore = await readFile(inputPath);
  runtime.register(jobId, outcome);

  let status = ledger.get(jobId)!.status;
  const persistStatus = (next: JobStatusView): void => {
    ledger.update(next);
    status = next;
  };
  let settle!: (value: TerminalState) => void;
  const settled = new Promise<TerminalState>((resolve) => { settle = resolve; });
  const callbacks: ExportCallbacks = {
    onRunning: () => persistStatus({ ...status, state: "running", updatedAt: new Date().toISOString() }),
    onProgress: (event) => persistStatus({
      ...status,
      state: "running",
      progress: {
        phase: event.phase,
        percent: event.percent,
        ...(event.currentFrame !== undefined ? { currentFrame: event.currentFrame } : {}),
        ...(event.totalFrames !== undefined ? { totalFrames: event.totalFrames } : {}),
        ...(event.bytesWritten !== undefined ? { bytesWritten: event.bytesWritten } : {}),
      },
      updatedAt: new Date().toISOString(),
    }),
    onDone: (completion) => {
      const next = { ...status, state: "done" as const, route: completion.route, updatedAt: new Date().toISOString() };
      persistStatus(next);
      settle("done");
    },
    onError: (error) => {
      const next = { ...status, state: "error" as const, error, updatedAt: new Date().toISOString() };
      persistStatus(next);
      settle("error");
    },
    onCancelled: () => {
      const next = { ...status, state: "cancelled" as const, cancelRequested: true, updatedAt: new Date().toISOString() };
      persistStatus(next);
      settle("cancelled");
    },
  };
  const request: ExportVideoRequest = {
    project,
    sourceRevision: 1,
    settings: {
      format: "mp4",
      codec: "h264",
      width: 320,
      height: 180,
      frameRate: E01_FRAME_RATE,
      videoBitrateKbps: 500,
    },
    jobId,
    jobDir,
    mediaFiles: {},
  };

  assertBeforeDeadline(jobDeadlineAt, `E01 ${jobId} submission`);
  const startedAt = performance.now();
  activeJobs.set(jobId, { terminal: settled });
  args.onSubmitted?.();
  await withDeadline(provider.startExport(request, callbacks, capture), jobDeadlineAt, `E01 ${jobId} submission`);
  if (outcome === "cancel") {
    await withDeadline(runtime.waitForStart(jobId), jobDeadlineAt, `E01 ${jobId} backend start`);
    await provider.cancel(jobId);
  }
  const terminal = await withDeadline(settled, jobDeadlineAt, `E01 ${jobId} terminal callback`);
  activeJobs.delete(jobId);
  const inputAfter = await readFile(inputPath);
  const inputUnchanged = inputBefore.equals(inputAfter);
  const finalStatus = ledger.get(jobId)!.status;
  const statusFile = JSON.parse(await readFile(path.join(ledgerRoot, `${jobId}.status.json`), "utf8")) as { status?: JobStatusView };
  const progressStatusPersisted = statusFile.status?.state === finalStatus.state &&
    (terminal !== "done" || (statusFile.status.progress?.phase === "complete" && statusFile.status.progress.percent === 1));
  const outputPath = path.join(jobDir, "output.mp4");
  let outputBytes = 0;
  if (terminal === "done") outputBytes = (await readFile(outputPath)).length;
  const durationMs = performance.now() - startedAt;
  return {
    terminal,
    durationMs,
    outputPath,
    outputBytes,
    inputUnchanged,
    inputWriteCount: inputWriteCounts.get(jobId) ?? 0,
    finalStatus,
    progressStatusPersisted,
  };
}

function createFakeRuntime(
  defaultSink: ExportPerformanceSink,
  behaviors: Map<string, FakeOutcome>,
): FakeRuntimeControls {
  const started = new Map<string, Deferred<void>>();
  const abortWaiters = new Map<string, Deferred<void>>();
  const abortRequested = new Set<string>();
  let activeJobId: string | null = null;

  const runtime = {
    exportWebcodecsStreaming: async (
      project: Project,
      _mediaFiles: Readonly<Record<string, string>>,
      _settings: { width: number; height: number; frameRate: number; videoBitrateKbps: number },
      writer: PartFileWriter,
      onProgress: (event: ExportProgressJson) => void,
      operationOptions: { cancelCheck?: () => boolean; performanceSink?: ExportPerformanceSink } = {},
    ) => {
      const jobId = project.id;
      const sink = operationOptions.performanceSink ?? defaultSink;
      const behavior = behaviors.get(jobId) ?? "success";
      activeJobId = jobId;
      started.get(jobId)?.resolve();
      try {
        await withExportPerformanceSpan(sink, "prepare", async () => undefined);
        const totalFrames = Math.ceil(E01_DURATION_SECONDS * E01_FRAME_RATE);
        const sendProgress = (event: ExportProgressJson): void => {
          markExportPerformance(sink, "progress", {
            progress: event.progress,
            currentFrame: event.currentFrame,
            totalFrames: event.totalFrames,
            bytesWritten: event.bytesWritten,
          });
          onProgress(event);
        };
        sendProgress({ phase: "preparing", progress: 0, currentFrame: 0, totalFrames, bytesWritten: 0 });
        const renderSpan = beginExportPerformanceSpan(sink, "render");
        for (let frame = 0; frame < totalFrames; frame += 1) {
          if (operationOptions.cancelCheck?.()) {
            endExportPerformanceSpan(sink, renderSpan, "cancelled");
            return { success: false, errorCode: "CANCELLED", framesRendered: frame };
          }
          await Promise.resolve();
          sendProgress({
            phase: "rendering",
            progress: (frame + 1) / totalFrames,
            currentFrame: frame + 1,
            totalFrames,
            bytesWritten: 0,
          });
          if (behavior === "failure" && frame === 0) {
            await writer.writeBase64(Buffer.from("partial-output").toString("base64"));
            endExportPerformanceSpan(sink, renderSpan, "error");
            return { success: false, errorCode: "SIMULATED_ENCODE_FAILURE", errorMessage: "fake backend failure", framesRendered: frame + 1 };
          }
          if (behavior === "cancel" && frame === 0) {
            await abortWaiters.get(jobId)!.promise;
            endExportPerformanceSpan(sink, renderSpan, "cancelled");
            return { success: false, errorCode: "CANCELLED", framesRendered: frame + 1 };
          }
        }
        endExportPerformanceSpan(sink, renderSpan, "ok");
        sendProgress({ phase: "muxing", progress: 0.98, currentFrame: totalFrames, totalFrames, bytesWritten: 0 });
        await writer.writeBase64(Buffer.from(`fake-mp4:${jobId}`).toString("base64"));
        const bytesWritten = await writer.finalize();
        sendProgress({ phase: "complete", progress: 1, currentFrame: totalFrames, totalFrames, bytesWritten });
        return { success: true, framesRendered: totalFrames, bytesWritten };
      } finally {
        activeJobId = null;
      }
    },
    abortInPageExport: async () => {
      if (!activeJobId) return;
      abortRequested.add(activeJobId);
      abortWaiters.get(activeJobId)?.resolve();
    },
    recycle: async () => undefined,
  };

  return {
    runtime: runtime as unknown as ChromiumRuntime,
    register(jobId, outcome) {
      behaviors.set(jobId, outcome);
      started.set(jobId, deferred<void>());
      abortWaiters.set(jobId, deferred<void>());
      abortRequested.delete(jobId);
    },
    waitForStart(jobId) {
      if (abortRequested.has(jobId)) return Promise.resolve();
      const signal = started.get(jobId);
      if (!signal) throw new Error(`E01 fake runtime has no registration for ${jobId}`);
      return signal.promise;
    },
  };
}

async function runPersistenceSentinel(
  ledger: DurableTaskLedger,
  ledgerRoot: string,
  inputWriteCounts: ReadonlyMap<string, number>,
  runId: string,
  deadlineAt: number,
): Promise<{ inputUnchanged: boolean; inputWriteCount: number; progressPersisted: boolean }> {
  const jobId = `${runId}-immutable-input`;
  const input = {
    jobId,
    kind: "export" as const,
    projectId: jobId,
    workspaceId: "e01-workspace",
    sourceRevision: 1,
    inputProject: {
      ...fakeProject(jobId),
      syntheticPayload: "x".repeat(E01_INPUT_PAYLOAD_BYTES),
    } as unknown as Project,
    parameters: { backend: "fixed-input-persistence-sentinel" },
  } satisfies DurableTaskInput;
  ledger.begin(input);
  const inputPath = path.join(ledgerRoot, `${jobId}.json`);
  const before = await readFile(inputPath);
  let status = ledger.get(jobId)!.status;
  const update = (next: JobStatusView): void => {
    ledger.update(next);
    status = next;
  };
  update({ ...status, state: "running", updatedAt: new Date().toISOString() });
  for (let step = 1; step <= 20; step += 1) {
    update({
      ...status,
      progress: { phase: "rendering", percent: step / 20, currentFrame: step, totalFrames: 20 },
      updatedAt: new Date().toISOString(),
    });
  }
  if (!(await readFile(inputPath)).equals(before)) {
    throw new Error("E01 progress update rewrote the fixed task input document");
  }
  const progressPersisted = await waitForPersistedProgress(path.join(ledgerRoot, `${jobId}.status.json`), deadlineAt);
  return {
    inputUnchanged: (await readFile(inputPath)).equals(before),
    inputWriteCount: inputWriteCounts.get(jobId) ?? 0,
    progressPersisted,
  };
}

async function waitForPersistedProgress(statusPath: string, deadlineAt: number): Promise<boolean> {
  while (performance.now() < deadlineAt) {
    const document = JSON.parse(await readFile(statusPath, "utf8")) as { status?: JobStatusView };
    if (document.status?.progress?.percent === 1) return true;
    const remainingMs = deadlineAt - performance.now();
    if (remainingMs <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(5, remainingMs)));
  }
  return false;
}

function fakeProject(id: string): Project {
  return {
    id,
    name: "E01 deterministic fake export input",
    createdAt: 1_700_000_000_000,
    modifiedAt: 1_700_000_000_000,
    settings: { width: 320, height: 180, frameRate: E01_FRAME_RATE, sampleRate: 48_000, channels: 2 },
    mediaLibrary: { items: [] },
    timeline: { tracks: [], subtitles: [], duration: E01_DURATION_SECONDS, markers: [] },
  };
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

async function withDeadline<T>(promise: Promise<T>, deadlineAt: number, label: string): Promise<T> {
  const remainingMs = assertBeforeDeadline(deadlineAt, label);
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded its deadline`)), remainingMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function assertBeforeDeadline(deadlineAt: number, label: string): number {
  const remainingMs = deadlineAt - performance.now();
  if (remainingMs <= 0) throw new Error(`${label} exceeded its deadline`);
  return remainingMs;
}

function sumCounts(counts: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const count of counts.values()) total += count;
  return total;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function fakeBackendEnvironment(): Record<string, unknown> {
  const cpus = os.cpus();
  return {
    electron: process.versions.electron ?? "not_used_fake_backend",
    chrome: process.versions.chrome ?? "not_used_fake_backend",
    os: { platform: process.platform, release: os.release(), arch: process.arch },
    runner_class: process.env.CI ? "ci" : "local",
    cpu: { model: cpus[0]?.model.trim() || "unknown", logical_cores: os.availableParallelism?.() ?? Math.max(1, cpus.length) },
    memory: { total_bytes: os.totalmem(), free_bytes: os.freemem() },
    gpu: { info_status: "unavailable", devices: [], feature_status: {} },
    visible: null,
    focused: null,
    window_css_px: null,
    window_content_dip_px: null,
    device_scale_factor: null,
    refresh_hz_estimate: null,
    devtools_open: null,
    decode_backend: null,
    parallel_decoder_available: null,
    capabilities: {
      webgpu: null,
      wasm: null,
      shared_array_buffer: null,
      hardware_concurrency: Math.max(1, os.availableParallelism?.() ?? cpus.length),
      device_memory_gb: null,
    },
    power_state: "unknown",
    load_state: "unknown",
    occlusion_state: "unknown",
  };
}
