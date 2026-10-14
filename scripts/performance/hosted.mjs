// Small hosted-runner adapter; all measurements use the existing opt-in runner.
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRunOptions } from "./run-options.mjs";
import { runKey } from "./p6-support.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.join(root, "apps/desktop/e2e/.artifacts/performance-ci");
const evidence = path.join(output, "hosted.json");
const serial = ["--repeats", "1", "--serial", "--report-only"];

export function hostedPlan(profile) {
  if (!["smoke", "stress", "stability-smoke", "stability"].includes(profile)) throw new Error("unknown hosted profile");
  const short = profile === "smoke" || profile === "stability-smoke";
  const commands = [
    ["--suite", "quick", "--scenario", "T01,H01,P01", "--samples", "5", "--run-timeout-seconds", "600"],
    ...(!short ? [
      ["--suite", "benchmark", "--scenario", "T03", "--clip-count", "2000", "--track-count", "50", "--samples", "25", "--run-timeout-seconds", "1200"],
      ["--suite", "benchmark", "--scenario", "H01", "--node-count", "1000", "--samples", "25", "--run-timeout-seconds", "1200"],
    ] : []),
    ["--suite", "soak", "--scenario", "R01", "--edit-rounds", short ? "10" : "500", "--run-timeout-seconds", short ? "600" : "1800"],
    ["--suite", "soak", "--scenario", "R02", "--duration-seconds", short ? "60" : "1800", "--run-timeout-seconds", short ? "600" : "3000", ...(!short || profile === "stability-smoke" ? ["--saturate-history"] : [])],
  ];
  return commands.map(args => ({ args: [...args, ...serial], options: parseRunOptions([...args, ...serial]), status: "not_run" }));
}

// Completion coverage is independent of elapsed-time performance qualification.
export function stabilityCompletion(record, documents, report) {
  const expected = record.commands.flatMap(command => command.options.scenarios.map(scenario => ({ scenario, options: command.options })));
  const unused = new Set(documents);
  const scenarios = expected.map(({ scenario, options }) => {
    const document = [...unused].find(item => item.run?.scenario_id === scenario &&
      (scenario !== "H01" || item.run?.fixture_manifest?.parameters?.nodeCount === options.nodeCount));
    if (!document) return { scenario, status: "not_run", reason_codes: ["result_missing"] };
    unused.delete(document);
    const reasons = [];
    const checked = report?.runs?.find(item => item.run_key === runKey(document.run.run_id));
    if (!checked || checked.comparison?.status !== "stability_verified") reasons.push(...(checked?.hard_failures?.length ? checked.hard_failures : ["deterministic_evidence_missing"]));
    if (document.build?.source_head !== record.commit) reasons.push("tested_commit_mismatch");
    if (document.status !== "complete" || document.validity?.complete !== true) reasons.push("run_not_complete");
    if (document.operations?.length < 1 || !Array.isArray(document.operations)) reasons.push("operations_missing");
    if (scenario === "T03" && (document.correctness?.undo_redo_full_state_verified !== true ||
        document.run?.fixture_manifest?.parameters?.clipCount !== options.clipCount ||
        document.run?.fixture_manifest?.parameters?.trackCount !== options.trackCount)) reasons.push("dense_state_evidence_missing");
    if (scenario === "P01" && document.correctness?.target_frame_verified !== true) reasons.push("saved_frame_evidence_missing");
    if (scenario === "R01" && document.run?.completed_rounds !== options.editRounds) reasons.push("rounds_incomplete");
    if (scenario === "R02" && (document.run?.requested_duration_seconds !== options.durationSeconds ||
        !(document.run?.elapsed_ms >= options.durationSeconds * 1000) || !(document.run?.completed_rounds > 0))) reasons.push("continuous_duration_incomplete");
    if (scenario === "R02" && options.saturateHistory && !(document.history_saturation?.capacity > 0 &&
        document.history_saturation?.plateauCounts?.length === 10 && document.history_saturation.plateauCounts.every(value => value === document.history_saturation.capacity))) reasons.push("history_saturation_missing");
    return { scenario, status: reasons.length ? "failed" : "passed", reason_codes: [...new Set(reasons)],
      operations: document.operations?.length ?? 0,
      correctness: Object.fromEntries(Object.entries(document.correctness ?? {}).filter(([key, value]) => /^[a-z_]+$/.test(key) && (typeof value === "boolean" || value === null))) };
  });
  const reportValid = report?.purpose === "stability" && report.status === "stability_passed" && report.counts?.hard_failures === 0 && report.counts?.results === expected.length;
  return { purpose: "stability", performance_qualified: false, timings: "reference_only",
    status: reportValid && unused.size === 0 && record.commands.every(command => command.status === "passed") && scenarios.every(item => item.status === "passed") ? "passed" : "failed",
    counts: { passed: scenarios.filter(item => item.status === "passed").length, failed: scenarios.filter(item => item.status === "failed").length, not_run: scenarios.filter(item => item.status === "not_run").length },
    deterministic_report_passed: reportValid, unexpected_results: unused.size, scenarios };
}

// Strict numeric projection: never upload profiles, paths, endpoint data, or raw traces.
export function resourceEvidence(document) {
  const numeric = value => Number.isFinite(value) ? value : null;
  return {
    scenario: ["R01", "R02"].includes(document.run?.scenario_id) ? document.run.scenario_id : null,
    completed_rounds: numeric(document.run?.completed_rounds),
    requested_duration_seconds: numeric(document.run?.requested_duration_seconds),
    elapsed_ms: numeric(document.run?.elapsed_ms),
    history_saturation: document.history_saturation ? {
      capacity: numeric(document.history_saturation.capacity),
      edits: numeric(document.history_saturation.edits),
      elapsed_ms: numeric(document.history_saturation.elapsed_ms),
      interval_ms: numeric(document.history_saturation.interval_ms),
    } : null,
    capture: calibrationEvidence({ controls: { currentCapture: document.last_capture } }).capture,
    idle: (document.idle_samples ?? []).map(sample => ({
      elapsed_ms: numeric(sample.elapsed_ms), heap_bytes: numeric(sample.heap_bytes),
      dom_nodes: numeric(sample.dom?.nodes), event_listeners: numeric(sample.dom?.event_listeners),
      resources: Object.fromEntries(Object.entries({
        history: ["actionUndo", "actionRedo", "actionCapacity", "changeJournalRevisions"],
        workspace: ["runtimes", "queuedWrites", "pendingWrites", "failedWriteCount"],
        media: ["ownedBlobUrls", "previewVideoCacheEntries", "previewImageBitmapCacheEntries", "motionImageBitmapCacheEntries", "motionVideoElementCacheEntries"],
        fonts: ["projectLeases", "projectFaces"],
      }).map(([group, keys]) => [group, Object.fromEntries(keys.map(key => [key, numeric(sample.resources?.[group]?.[key])]))])),
      rss_bytes: (sample.rss ?? []).map(row => ({
        role: ["main", "renderer", "gpu", "utility"].includes(row.role) ? row.role : "other",
        bytes: numeric(row.rss_bytes),
      })),
    })),
  };
}

export function calibrationEvidence(document) {
  const capture = document.controls?.currentCapture;
  const numeric = value => Number.isFinite(value) && value >= 0 ? value : null;
  const phaseEvidence = phases => Object.fromEntries([
    "capture_start_ms", "capture_export_ms", "read_before_ms", "read_verify_ms",
    "poll_wait_ms", "poll_wait_count", "verification_reads", "drag_ms",
    "drag_geometry_ms", "drag_input_driver_ms", "drag_verification_ms",
    "drag_raf_wait_ms", "drag_raf_browser_ms", "drag_raf_max_browser_ms", "drag_raf_count",
    "marker_ms", "save_key_ms", "save_wait_ms", "settle_ms",
  ].filter(key => numeric(phases?.[key]) !== null).map(key => [key, phases[key]]));
  return {
    status: ["qualified", "probe_overhead_exceeded", "invalid"].includes(document.status) ? document.status : "unknown",
    completed_groups: Array.isArray(document.runs) ? document.runs.length : 0,
    durations_ms: (document.runs ?? []).map(run => Number.isFinite(run.durationMs) ? run.durationMs : null),
    // Preserve already-recorded numeric evidence for attribution. CPU scope
    // includes initialization/export; it is not the wall qualification metric.
    task_duration_scope: "includes_capture_initialization_and_export",
    task_window_scope: "CDP_samples_bracket_unchanged_wall_window_without_capture_start_or_export",
    phase_scope: "Node_await_elapsed; drag_raf_browser_ms_uses_renderer_clock; drag_subphases_are_nested",
    current_phases: phaseEvidence(document.controls?.currentPhases),
    current_window_task_seconds: numeric(document.controls?.currentWindowTaskSeconds),
    runs: (document.runs ?? []).slice(0, 20).map((run, index) => ({
      index,
      mode: ["off", "light"].includes(run.mode) ? run.mode : "unknown",
      duration_ms: numeric(run.durationMs),
      task_seconds: numeric(run.taskSeconds),
      task_window_seconds: numeric(run.taskWindowSeconds),
      phases: phaseEvidence(run.phases),
      export_ms: numeric(run.exportMs),
      events: Number.isInteger(run.events) && run.events >= 0 ? run.events : null,
      heap_bytes_before: numeric(run.heapBytesBefore),
      heap_bytes_after: numeric(run.heapBytesAfter),
      rss_bytes: numeric(run.rssBytes),
    })),
    capture: capture ? {
      status: ["complete", "incomplete", "aborted"].includes(capture.status) ? capture.status : "unknown",
      reason_codes: (capture.reasonCodes ?? []).filter(value => typeof value === "string" && /^[a-z_:]+$/.test(value)),
      wall_duration_us: Number.isFinite(capture.wallDurationUs) ? capture.wallDurationUs : null,
      hidden_during_action: typeof capture.hiddenDuringAction === "boolean" ? capture.hiddenDuringAction : null,
      main_status: ["complete", "incomplete", "unavailable"].includes(capture.mainStatus) ? capture.mainStatus : "unknown",
      main_reason_codes: (capture.mainReasonCodes ?? []).filter(value => typeof value === "string" && /^[a-z_:]+$/.test(value)),
      main_open_spans: numeric(capture.mainOpenSpans),
      renderer_open_spans: numeric(capture.rendererOpenSpans),
      main_oldest_open_span_us: numeric(capture.mainOldestOpenSpanUs),
      main_open_phases: (capture.mainOpenPhases ?? []).filter(value => ["live.ipc.main.request", "other"].includes(value)).slice(0, 8),
    } : null,
  };
}

async function main(mode) {
  await mkdir(output, { recursive: true });
  if (mode === "prepare") {
    const sha = process.env.PERF_COMMIT;
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
    if (!/^[a-f0-9]{40}$/.test(sha ?? "") || head.status !== 0 || head.stdout.trim() !== sha) throw new Error("checkout must match the full requested commit SHA");
    const record = {
      commit: sha, profile: process.env.PERF_PROFILE, os: process.platform, arch: process.arch,
      purpose: process.env.PERF_PROFILE?.startsWith("stability") ? "stability" : "performance",
      performance_qualified: false,
      runner: process.env.RUNNER_ENVIRONMENT, runner_image: process.env.ImageOS,
      runner_image_version: process.env.ImageVersion, cpu: os.cpus()[0]?.model,
      logical_cores: os.cpus().length, total_memory_bytes: os.totalmem(),
      run_id: process.env.GITHUB_RUN_ID, commands: hostedPlan(process.env.PERF_PROFILE),
      boundary: "Synthetic isolated Electron profiles; hosted timings are report-only; no physical GPU, real-media export, or local-machine performance claim.",
    };
    await writeFile(evidence, JSON.stringify(record, null, 2));
    console.info(JSON.stringify(record));
  } else if (mode === "run") {
    const record = JSON.parse(await readFile(evidence, "utf8"));
    for (const command of record.commands) {
      console.info("HOSTED_SCENARIO", record.commit, command.args.join(" "));
      const result = spawnSync(process.execPath, [path.join(root, "scripts/performance/run.mjs"), ...command.args], { cwd: root, stdio: "inherit", windowsHide: true });
      command.exit_code = result.status;
      command.status = result.status === 0 ? "passed" : "failed";
      await writeFile(evidence, JSON.stringify(record, null, 2));
      if (result.status !== 0) { process.exitCode = 1; break; }
    }
  } else if (mode === "summarize") {
    const record = JSON.parse(await readFile(evidence, "utf8"));
    record.resources = [];
    record.calibrations = [];
    const documents = [];
    const directory = path.join(root, "apps/desktop/e2e/.artifacts/performance");
    for (const file of await readdir(directory).catch(error => { if (error.code === "ENOENT") return []; throw error; })) {
      if (file.startsWith("probe-calibration-") && file.endsWith(".json")) {
        record.calibrations.push(calibrationEvidence(JSON.parse(await readFile(path.join(directory, file), "utf8"))));
      }
      if (!file.endsWith(".result.json")) continue;
      const document = JSON.parse(await readFile(path.join(directory, file), "utf8"));
      documents.push(document);
      if (["R01", "R02"].includes(document.run?.scenario_id)) record.resources.push(resourceEvidence(document));
    }
    if (record.purpose === "stability") {
      const report = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
      record.stability = stabilityCompletion(record, documents, report);
      if (record.stability.status !== "passed") process.exitCode = 1;
    }
    await writeFile(evidence, JSON.stringify(record, null, 2));
    const summary = [`Commit: ${record.commit}`, `Profile: ${record.profile}; purpose: ${record.purpose}; OS: ${record.os}/${record.arch}; runner: ${record.runner}/${record.runner_image}`,
      record.purpose === "stability" ? `Stability: ${record.stability.status}; passed/failed/not run: ${record.stability.counts.passed}/${record.stability.counts.failed}/${record.stability.counts.not_run}. Timings are reference only; performance qualification was not evaluated.` : "Original performance calibration applies.",
      record.boundary, ...record.commands.map(command => `${command.options.scenarios.join(",")}: ${command.status}; ${command.args.join(" ")}`)].join("\n\n");
    await writeFile(path.join(output, "hosted.md"), summary + "\n");
  } else throw new Error("use prepare, run, or summarize");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv[2]);
}
