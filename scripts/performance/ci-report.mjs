#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  baselineGroupDescriptor,
  collectPerformanceArtifacts,
  compareCandidateToBaseline,
  evaluateResultArtifact,
  loadCalibrationDocuments,
  parseCliOptions,
  safePreflightEvidence,
  safeRunEvidence,
  safeCalibrationEvidence,
  validateBaselineManifest,
} from "./p6-support.mjs";

const usage = "Usage: node scripts/performance/ci-report.mjs --directory DIR [--baseline FILE] [--calibration FILE_OR_DIR] --policy report-only|warning --fixed-runner true|false --json FILE --markdown FILE";
const policyValue = (value) => value === "report-only" || value === "warning";
const booleanValue = (value) => value === "true" || value === "false";

function compareRun(evaluation, baseline, policy) {
  const document = evaluation.document;
  if (!document) return { status: "hard_failure", reason_codes: evaluation.hardFailures, metrics: [] };
  if (evaluation.hardFailures.length > 0) return { status: "hard_failure", reason_codes: evaluation.hardFailures, metrics: [] };
  if (document.run?.mode === "trace") return { status: "trace_only", reason_codes: ["trace_mode_not_comparable"], metrics: [] };
  if (!evaluation.calibration.matched) return { status: "report_only", reason_codes: [evaluation.calibration.reason], metrics: [] };
  if (!evaluation.eligible) return { status: "report_only", reason_codes: evaluation.ineligibleReasons, metrics: [] };
  if (!baseline) return { status: "report_only", reason_codes: ["baseline_missing"], metrics: [] };

  const descriptor = baselineGroupDescriptor(document);
  const group = baseline.groups.find((candidate) =>
    candidate.workload_key === descriptor.workload_key &&
    candidate.comparison_identity_sha256 === descriptor.comparison_identity_sha256,
  );
  if (!group) {
    const workloadExists = baseline.groups.some((candidate) => candidate.workload_key === descriptor.workload_key);
    return {
      status: workloadExists ? "incompatible" : "report_only",
      reason_codes: [workloadExists ? "baseline_identity_mismatch" : "baseline_missing_group"],
      metrics: [],
    };
  }

  const metrics = compareCandidateToBaseline(document, group);
  const regressions = metrics.filter((metric) => metric.status === "regression_warning");
  if (regressions.length === 0) {
    return { status: "report_only", reason_codes: ["compatible_results"], metrics };
  }
  if (policy !== "warning") {
    return {
      status: "report_only",
      reason_codes: ["regression_observed_report_only"],
      metrics: metrics.map((metric) => metric.status === "regression_warning" ? { ...metric, status: "regression_reported" } : metric),
    };
  }
  return { status: "warning", reason_codes: ["duration_regression_warning"], metrics };
}

function markdownReport(report) {
  const lines = [
    "# ReelTerminal performance CI report",
    "",
    `Status: **${report.status}**`,
    `Policy: ${report.policy.effective} (requested ${report.policy.requested}); fixed runner: ${report.policy.fixed_runner}`,
    `Baseline: ${report.baseline.status}; calibrated inputs: ${report.calibration.input_count}`,
    `Results: ${report.counts.results}; preflights: ${report.counts.preflights}; duration warnings: ${report.counts.warnings}; hard failures: ${report.counts.hard_failures}`,
    "",
    "| Run | Scenario | Cache | Status | Evidence |",
    "| ---: | --- | --- | --- | --- |",
  ];
  for (const run of report.runs) {
    const evidence = [...run.comparison.reason_codes, ...run.hard_failures].join(", ") || "compatible";
    lines.push(`| ${run.index} | ${run.scenario_id ?? "unknown"} | ${run.cache_state ?? "unknown"} | ${run.comparison.status} | ${evidence} |`);
  }
  const numberText = (value) => Number.isFinite(value) ? value.toFixed(2) : "—";
  lines.push("", "## Operation distributions", "",
    "| Run | Metric | Completed / requested | P50 ms | P95 ms | P99 ms | Comparable change |",
    "| ---: | --- | ---: | ---: | ---: | ---: | --- |",
  );
  for (const run of report.runs) {
    for (const [name, metric] of Object.entries(run.metrics)) {
      const comparison = run.comparison.metrics.find((item) => item.metric === name);
      const change = Number.isFinite(comparison?.change_percent)
        ? `${comparison.percentile}: ${numberText(comparison.change_percent)}% (${numberText(comparison.absolute_delta_ms)} ms)`
        : "—";
      lines.push(`| ${run.index} | ${name} | ${metric.n_completed ?? "—"} / ${metric.n_requested ?? "—"} | ${numberText(metric.p50_ms)} | ${numberText(metric.p95_ms)} | ${numberText(metric.p99_ms)} | ${change} |`);
    }
  }
  if (report.preflights.length > 0) {
    lines.push("", "## Invalid preflight artifacts", "");
    lines.push("| Item | Status | Reason codes |", "| ---: | --- | --- |");
    for (const item of report.preflights) lines.push(`| ${item.index} | ${item.status} | ${item.reason_codes.join(", ") || "unspecified"} |`);
  }
  if (report.hard_failures.length > 0) {
    lines.push("", "## Hard failures", "");
    for (const failure of report.hard_failures) lines.push(`- Run ${failure.index}: ${failure.reason_codes.join(", ")}`);
  }
  lines.push("", "Duration comparisons use run-level quantiles. A warning requires both a relative increase above 20% and an absolute increase above 10 ms. Uncalibrated or incompatible measurements remain report-only.", "");
  return lines.join("\n");
}

async function writeReports(jsonPath, markdownPath, report) {
  for (const outputPath of [jsonPath, markdownPath]) await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, markdownReport(report), "utf8");
}

let flags;
try {
  flags = parseCliOptions(process.argv.slice(2), {
    "--directory": { required: true },
    "--baseline": {},
    "--calibration": {},
    "--policy": { required: true, validate: policyValue },
    "--fixed-runner": { required: true, validate: booleanValue },
    "--json": { required: true },
    "--markdown": { required: true },
  });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage}\n`);
  process.exitCode = 2;
}

if (flags) {
  try {
    const collection = await collectPerformanceArtifacts(flags["--directory"]);
    const calibrationLoad = await loadCalibrationDocuments(flags["--calibration"]);
    const calibrations = calibrationLoad.documents.map((item) => item.document).filter(Boolean);
    let baseline = null;
    let baselineErrors = [];
    let baselineStatus = "missing";
    if (flags["--baseline"]) {
      try {
        const loaded = JSON.parse(await (await import("node:fs/promises")).readFile(flags["--baseline"], "utf8"));
        baselineErrors = validateBaselineManifest(loaded);
        if (baselineErrors.length === 0) {
          baseline = loaded;
          baselineStatus = "ready";
        } else {
          baselineStatus = "invalid";
        }
      } catch (error) {
        if (error?.code === "ENOENT") baselineStatus = "missing";
        else if (error instanceof SyntaxError) {
          baselineStatus = "invalid";
          baselineErrors = ["baseline_json_invalid"];
        } else {
          throw error;
        }
      }
    }

    const fixedRunner = flags["--fixed-runner"] === "true";
    const effectivePolicy = fixedRunner && flags["--policy"] === "warning" ? "warning" : "report-only";
    const evaluations = [];
    for (const item of collection.results) evaluations.push(await evaluateResultArtifact(item, calibrations));
    const seenRuns = new Set();
    const runs = evaluations.map((evaluation, offset) => {
      const index = offset + 1;
      const evidence = safeRunEvidence(evaluation, index);
      if (evidence.run_key && seenRuns.has(evidence.run_key)) evaluation.hardFailures.push("duplicate_run_id");
      if (evidence.run_key) seenRuns.add(evidence.run_key);
      evidence.hard_failures = [...new Set(evaluation.hardFailures)];
      evidence.comparison = compareRun(evaluation, baseline, effectivePolicy);
      return evidence;
    });

    const preflights = collection.preflights.map((item, offset) => safePreflightEvidence(item, offset + 1));
    const hardFailures = [];
    for (const error of collection.errors) hardFailures.push({ index: null, reason_codes: [error] });
    for (const error of baselineErrors) hardFailures.push({ index: null, reason_codes: [error] });
    for (const run of runs) {
      if (run.hard_failures.length > 0) hardFailures.push({ index: run.index, reason_codes: run.hard_failures });
    }
    for (const preflight of preflights) {
      hardFailures.push({ index: `preflight-${preflight.index}`, reason_codes: preflight.reason_codes.length ? preflight.reason_codes : ["preflight_invalid"] });
    }
    const warnings = runs.filter((run) => run.comparison.status === "warning").length;
    const report = {
      schema: "reelterminal.performance-ci-report/v1",
      generated_at: new Date().toISOString(),
      status: hardFailures.length > 0 ? "failed" : warnings > 0 ? "warning" : "report_only",
      policy: { requested: flags["--policy"], effective: effectivePolicy, fixed_runner: fixedRunner },
      baseline: { status: baselineStatus, errors: baselineErrors },
      calibration: {
        input_count: calibrationLoad.documents.length,
        load_error: calibrationLoad.error,
        qualified_count: calibrations.filter((item) => item?.schema === "reelterminal.probe-calibration/v1" && item.status === "qualified").length,
        artifacts: calibrationLoad.documents.map(safeCalibrationEvidence),
      },
      counts: {
        results: runs.length,
        preflights: preflights.length,
        warnings,
        hard_failures: hardFailures.length,
      },
      collection_errors: collection.errors,
      runs,
      preflights,
      hard_failures: hardFailures,
    };
    await writeReports(flags["--json"], flags["--markdown"], report);
    process.stderr.write(`Performance CI report: ${report.status}; ${runs.length} result(s), ${warnings} warning(s), ${hardFailures.length} hard failure(s).\n`);
    if (hardFailures.length > 0) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
