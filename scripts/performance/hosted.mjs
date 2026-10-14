// Small hosted-runner adapter; all measurements use the existing opt-in runner.
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRunOptions } from "./run-options.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.join(root, "apps/desktop/e2e/.artifacts/performance-ci");
const evidence = path.join(output, "hosted.json");
const serial = ["--repeats", "1", "--serial", "--report-only"];

export function hostedPlan(profile) {
  if (!["smoke", "stress"].includes(profile)) throw new Error("profile must be smoke or stress");
  const commands = [
    ["--suite", "quick", "--scenario", "T01,H01,P01", "--samples", "5", "--run-timeout-seconds", "600"],
    ...(profile === "stress" ? [
      ["--suite", "benchmark", "--scenario", "T03", "--clip-count", "2000", "--track-count", "50", "--samples", "25", "--run-timeout-seconds", "1200"],
      ["--suite", "benchmark", "--scenario", "H01", "--node-count", "1000", "--samples", "25", "--run-timeout-seconds", "1200"],
    ] : []),
    ["--suite", "soak", "--scenario", "R01", "--edit-rounds", profile === "smoke" ? "10" : "500", "--run-timeout-seconds", profile === "smoke" ? "600" : "1800"],
    ["--suite", "soak", "--scenario", "R02", "--duration-seconds", profile === "smoke" ? "60" : "1800", "--run-timeout-seconds", profile === "smoke" ? "600" : "3000", ...(profile === "stress" ? ["--saturate-history"] : [])],
  ];
  return commands.map(args => ({ args: [...args, ...serial], options: parseRunOptions([...args, ...serial]), status: "not_run" }));
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
    } : null,
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

async function main(mode) {
  await mkdir(output, { recursive: true });
  if (mode === "prepare") {
    const sha = process.env.PERF_COMMIT;
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
    if (!/^[a-f0-9]{40}$/.test(sha ?? "") || head.status !== 0 || head.stdout.trim() !== sha) throw new Error("checkout must match the full requested commit SHA");
    const record = {
      commit: sha, profile: process.env.PERF_PROFILE, os: process.platform, arch: process.arch,
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
    const directory = path.join(root, "apps/desktop/e2e/.artifacts/performance");
    for (const file of await readdir(directory).catch(error => { if (error.code === "ENOENT") return []; throw error; })) {
      if (!file.endsWith(".result.json")) continue;
      const document = JSON.parse(await readFile(path.join(directory, file), "utf8"));
      if (["R01", "R02"].includes(document.run?.scenario_id)) record.resources.push(resourceEvidence(document));
    }
    await writeFile(evidence, JSON.stringify(record, null, 2));
    const summary = [`Commit: ${record.commit}`, `Profile: ${record.profile}; OS: ${record.os}/${record.arch}; runner: ${record.runner}/${record.runner_image}`, record.boundary, ...record.commands.map(command => `${command.options.scenarios.join(",")}: ${command.status}; ${command.args.join(" ")}`)].join("\n\n");
    await writeFile(path.join(output, "hosted.md"), summary + "\n");
  } else throw new Error("use prepare, run, or summarize");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv[2]);
}
