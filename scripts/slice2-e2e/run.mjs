#!/usr/bin/env node
/** Run agent transport scenarios and write evidence outside the source tree. */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { arch, platform, release, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { E2EEnvironment, ffprobeVersion } from "./lib/env.mjs";
import { gitSha, probeClientClis, sha256File } from "./lib/common.mjs";
import { Recorder } from "./lib/recorder.mjs";
import { runDoctor } from "./lib/doctor.mjs";
import { scenario1Mcp, scenario1Run } from "./lib/scenario1.mjs";
import { scenario2Mcp, scenario2Run } from "./lib/scenario2.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");

function parseArgs(argv) {
  const options = {
    scenario: "all",
    path: "all",
    keepEvidence: false,
    evidenceDir: null,
    cli: path.join(repoRoot, "packages", "agent-transport", "dist", "cli.js"),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`flag ${arg} requires a value`);
      return argv[i];
    };
    switch (arg) {
      case "--scenario":
        options.scenario = value();
        break;
      case "--path":
        options.path = value();
        break;
      case "--keep-evidence":
        options.keepEvidence = true;
        break;
      case "--evidence-dir":
        options.evidenceDir = path.resolve(value());
        break;
      case "--cli":
        options.cli = path.resolve(value());
        break;
      default:
        throw new Error(`unknown flag "${arg}"`);
    }
  }
  if (!["1", "2", "all"].includes(options.scenario)) throw new Error("--scenario must be 1|2|all");
  if (!["run", "mcp", "all"].includes(options.path)) throw new Error("--path must be run|mcp|all");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.cli)) {
    throw new Error(
      `built CLI not found at ${options.cli} — run: corepack pnpm --filter @reelterminal/agent-transport build`,
    );
  }
  options.evidenceDir ??= await mkdtemp(path.join(tmpdir(), "reelterminal-agent-e2e-"));
  await mkdir(options.evidenceDir, { recursive: true });
  console.log(`Evidence directory: ${options.evidenceDir}`);

  const plan = [];
  if (options.scenario === "1" || options.scenario === "all") {
    if (options.path === "run" || options.path === "all") plan.push({ scenario: 1, path: "run" });
    if (options.path === "mcp" || options.path === "all") plan.push({ scenario: 1, path: "mcp" });
  }
  if (options.scenario === "2" || options.scenario === "all") {
    if (options.path === "run" || options.path === "all") {
      plan.push({ scenario: 2, path: "run", variant: "SIGTERM" });
      plan.push({ scenario: 2, path: "run", variant: "SIGKILL" });
    }
    if (options.path === "mcp" || options.path === "all") {
      plan.push({ scenario: 2, path: "mcp", variant: "SIGTERM" });
      plan.push({ scenario: 2, path: "mcp", variant: "SIGKILL" });
    }
  }
  console.log(`agent-e2e: ${plan.length} execution(s) planned: ${plan.map((p) => JSON.stringify(p)).join(", ")}`);

  const results = [];
  for (const entry of plan) {
    const dirName =
      entry.scenario === 1
        ? path.join("scenario1", entry.path)
        : path.join("scenario2", `${entry.path}-${entry.variant.toLowerCase()}`);
    const dir = path.join(options.evidenceDir, dirName);
    const label =
      entry.scenario === 1
        ? `scenario1 (${entry.path}; simulated client)`
        : `scenario2 (${entry.path}; ${entry.variant} variant; simulated client)`;
    const recorder = new Recorder(dir, label);
    await recorder.open();
    const env = new E2EEnvironment({ keep: options.keepEvidence });
    const startedAt = Date.now();
    try {
      await env.setup();
      const fn =
        entry.scenario === 1
          ? entry.path === "run"
            ? scenario1Run
            : scenario1Mcp
          : entry.path === "run"
            ? scenario2Run
            : scenario2Mcp;
      await fn({ env, recorder, cliPath: options.cli, variant: entry.variant });
      const totals = await recorder.close();
      results.push({ ...entry, dir, status: "PASS", ...totals });
      console.log(`PASS ${label} — ${totals.passed}/${totals.total} checks; evidence: ${dir}`);
    } catch (error) {
      await recorder.record("fatal", { message: error instanceof Error ? error.stack : String(error) });
      const totals = await recorder.close();
      results.push({ ...entry, dir, status: "FAIL", error: String(error instanceof Error ? error.message : error), ...totals });
      console.error(`FAIL ${label}: ${error instanceof Error ? error.message : error}`);
      console.error(`raw transcript: ${recorder.transcriptPath}`);
    } finally {
      const kept = await env.cleanup();
      if (kept) console.log(`evidence env kept at ${kept} (--keep-evidence)`);
    }
  }

  // Record host details and installed client probes.
  await writeEnvironmentBlock(options);
  const probes = await probeClientClis();
  await writeFile(
    path.join(options.evidenceDir, "client-probe.json"),
    `${JSON.stringify(
      {
        note: "Workflow and MCP clients in this run are scripted and labeled simulated.",
        probedAt: new Date().toISOString(),
        probes,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const failed = results.filter((r) => r.status === "FAIL");
  console.log("\n=== agent-e2e summary ===");
  for (const result of results) {
    console.log(
      `${result.status}  scenario${result.scenario} ${result.path}${result.variant ? ` ${result.variant}` : ""}  ${result.passed ?? 0}/${result.total ?? 0} checks  → ${result.dir}`,
    );
  }
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

async function writeEnvironmentBlock(options) {
  const [sha, ffmpegVersion, ffprobeVer, cliSha] = await Promise.all([
    gitSha(repoRoot),
    ffprobeVersion("ffmpeg"),
    ffprobeVersion("ffprobe"),
    sha256File(options.cli),
  ]);
  let doctorFacts = null;
  const env = new E2EEnvironment({ keep: false });
  try {
    await env.setup();
    const { report } = await runDoctor({
      cliPath: options.cli,
      env: env.cliEnv(),
      recorder: null,
      label: "environment-harvest",
    });
    doctorFacts = {
      chromiumBuild: report.chromium?.browserBuild ?? null,
      transportVersion: report.transport?.version ?? null,
      exportRoute: report.codecs?.exportRoute ?? null,
      verdict: report.verdict?.classification ?? null,
    };
  } catch (error) {
    doctorFacts = { error: String(error instanceof Error ? error.message : error) };
  } finally {
    await env.cleanup();
  }
  const block = {
    note: "Environment details for this run.",
    generatedAt: new Date().toISOString(),
    repo: "reelterminal",
    repoHeadSha: sha,
    cli: { path: options.cli, sha256: cliSha },
    host: { platform: platform(), arch: arch(), osRelease: release() },
    node: process.version,
    ffmpegVersion,
    ffprobeVersion: ffprobeVer,
    doctorFacts,
  };
  await writeFile(
    path.join(options.evidenceDir, "environment.json"),
    `${JSON.stringify(block, null, 2)}\n`,
    "utf8",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
