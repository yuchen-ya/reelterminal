#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PERFORMANCE_BASELINE_SCHEMA,
  MINIMUM_BASELINE_RUNS,
  MAXIMUM_BASELINE_RUNS,
  baselineGroupDescriptor,
  collectPerformanceArtifacts,
  compareAggregationIdentity,
  evaluateResultArtifact,
  loadCalibrationDocuments,
  parseCliOptions,
  proposalGroup,
  runKey,
  safeToken,
  validateBaselineManifest,
} from "./p6-support.mjs";

const usage = "Usage: node scripts/performance/manage-baseline.mjs --directory DIR [--baseline FILE] --calibration FILE_OR_DIR --fixed-runner true|false --reason NOTE --output FILE";
const booleanValue = (value) => value === "true" || value === "false";

async function readAcceptedBaseline(filePath) {
  if (!filePath) return null;
  try {
    const manifest = JSON.parse(await readFile(filePath, "utf8"));
    const errors = validateBaselineManifest(manifest);
    if (errors.length > 0) throw new Error(`baseline manifest is not accepted or valid: ${errors.join(", ")}`);
    return manifest;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function splitStableBuildGroups(evaluations) {
  const groups = [];
  for (const evaluation of evaluations) {
    const existing = groups.find((group) =>
      compareAggregationIdentity(group[0].document, evaluation.document).length === 0,
    );
    if (existing) existing.push(evaluation);
    else groups.push([evaluation]);
  }
  return groups;
}

function excludedEntry(evaluation, reasonCodes) {
  return {
    run_key: evaluation.document?.run?.run_id ? runKey(evaluation.document.run.run_id) : null,
    scenario_id: safeToken(evaluation.document?.run?.scenario_id),
    reason_codes: [...new Set(reasonCodes)],
  };
}

async function writeProposal(outputPath, proposal) {
  await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
}

let flags;
try {
  flags = parseCliOptions(process.argv.slice(2), {
    "--directory": { required: true },
    "--baseline": {},
    "--calibration": { required: true },
    "--fixed-runner": { required: true, validate: booleanValue },
    "--reason": { required: true, validate: (value) => value.trim().length > 0 && value.length <= 240 },
    "--output": { required: true },
  });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage}\n`);
  process.exitCode = 2;
}

if (flags) {
  try {
    const [collection, calibrationLoad, existingBaseline] = await Promise.all([
      collectPerformanceArtifacts(flags["--directory"]),
      loadCalibrationDocuments(flags["--calibration"]),
      readAcceptedBaseline(flags["--baseline"]),
    ]);
    const calibrations = calibrationLoad.documents.map((item) => item.document).filter(Boolean);
    const evaluations = [];
    for (const item of collection.results) evaluations.push(await evaluateResultArtifact(item, calibrations));

    const seenRunKeys = new Set(existingBaseline?.groups.flatMap((group) => group.runs.map((run) => run.run_key)) ?? []);
    const excluded = [];
    const candidatesByGroup = new Map();
    for (const evaluation of evaluations) {
      const runId = evaluation.document?.run?.run_id;
      const key = typeof runId === "string" ? runKey(runId) : null;
      let reasons = evaluation.ineligibleReasons ?? ["invalid_result_json"];
      if (key && seenRunKeys.has(key)) reasons = [...reasons, "duplicate_run_id"];
      if (reasons.length > 0 || flags["--fixed-runner"] !== "true") {
        excluded.push(excludedEntry(evaluation, flags["--fixed-runner"] !== "true" ? [...reasons, "fixed_runner_required"] : reasons));
        continue;
      }
      seenRunKeys.add(key);
      const descriptor = baselineGroupDescriptor(evaluation.derivedDocument);
      const group = candidatesByGroup.get(descriptor.group_id) ?? { descriptor, runs: [] };
      group.runs.push(evaluation);
      candidatesByGroup.set(descriptor.group_id, group);
    }

    for (const item of collection.preflights) {
      const reasons = item.error
        ? [item.error]
        : Array.isArray(item.document?.reason_codes)
          ? item.document.reason_codes.filter((value) => safeToken(value))
          : ["preflight_invalid"];
      excluded.push({
        run_key: typeof item.document?.run_id === "string" ? runKey(item.document.run_id) : null,
        scenario_id: safeToken(item.document?.fixture_manifest?.scenarioId),
        reason_codes: reasons.length ? reasons : ["preflight_invalid"],
      });
    }
    for (const error of collection.errors) excluded.push({ run_key: null, scenario_id: null, reason_codes: [error] });

    const proposalGroups = new Map((existingBaseline?.groups ?? []).map((group) => [group.group_id, group]));
    const pendingGroups = [];
    const fixedRunner = flags["--fixed-runner"] === "true";
    const recordedAt = new Date().toISOString();
    if (fixedRunner) {
      for (const { descriptor, runs } of candidatesByGroup.values()) {
        const stableGroups = splitStableBuildGroups(runs);
        let acceptedNewRuns = 0;
        for (const stableRuns of stableGroups) {
          if (stableRuns.length < MINIMUM_BASELINE_RUNS) continue;
          const previousGroup = proposalGroups.get(descriptor.group_id) ?? null;
          proposalGroups.set(
            descriptor.group_id,
            proposalGroup(descriptor, stableRuns, flags["--reason"].trim(), previousGroup, recordedAt),
          );
          acceptedNewRuns += stableRuns.length;
        }
        if (acceptedNewRuns === 0) {
          pendingGroups.push({
            group_id: descriptor.group_id,
            workload_key: descriptor.workload_key,
            comparison_identity_sha256: descriptor.comparison_identity_sha256,
            scenario_id: descriptor.scenario_id,
            cache_state: descriptor.cache_state,
            fixture_manifest_sha256: descriptor.fixture_manifest_sha256,
            metric_identities: descriptor.metric_identities,
            qualified_run_count: runs.length,
            required_run_count: MINIMUM_BASELINE_RUNS,
          });
          for (const run of runs) excluded.push(excludedEntry(run, ["baseline_requires_three_stable_runs"]));
        }
      }
    }

    const groups = [...proposalGroups.values()].sort((left, right) => left.group_id.localeCompare(right.group_id));
    const hasNewGroup = fixedRunner && [...candidatesByGroup.values()].some(({ descriptor, runs }) =>
      splitStableBuildGroups(runs).some((stableRuns) =>
        stableRuns.length >= MINIMUM_BASELINE_RUNS &&
        stableRuns.some((run) => !existingBaseline?.groups.find((group) => group.group_id === descriptor.group_id)?.runs.some((oldRun) => oldRun.run_key === runKey(run.document.run.run_id))),
      ),
    );
    const reasonCodes = [];
    if (!fixedRunner) reasonCodes.push("fixed_runner_required");
    if (fixedRunner && !hasNewGroup) reasonCodes.push("fewer_than_three_stable_qualified_runs");
    const proposal = {
      schema: PERFORMANCE_BASELINE_SCHEMA,
      status: "proposal",
      minimum_qualified_runs: MINIMUM_BASELINE_RUNS,
      maximum_runs_per_group: MAXIMUM_BASELINE_RUNS,
      review: { accepted_by: null, accepted_at: null, reason: null },
      proposal: {
        state: hasNewGroup ? "ready_for_review" : "pending",
        created_at: recordedAt,
        fixed_runner: fixedRunner,
        reason: flags["--reason"].trim(),
        reason_codes: reasonCodes,
        minimum_qualified_runs: MINIMUM_BASELINE_RUNS,
        maximum_runs_per_group: MAXIMUM_BASELINE_RUNS,
        new_groups: hasNewGroup
          ? [...candidatesByGroup.keys()].filter((groupId) => {
            const previousRuns = existingBaseline?.groups.find((group) => group.group_id === groupId)?.runs ?? [];
            return proposalGroups.get(groupId)?.runs.some((run) => !previousRuns.some((oldRun) => oldRun.run_key === run.run_key));
          }).length
          : 0,
      },
      groups,
      pending_groups: pendingGroups,
      excluded,
    };
    await writeProposal(flags["--output"], proposal);
    process.stderr.write(`Performance baseline proposal: ${proposal.proposal.state}; ${proposal.groups.length} group(s), ${proposal.excluded.length} excluded run(s).\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
