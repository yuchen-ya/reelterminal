#!/usr/bin/env node
/** Render a Markdown summary from an agent end-to-end evidence directory. */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const optionIndex = process.argv.indexOf("--evidence-dir");
if (optionIndex < 0 || !process.argv[optionIndex + 1]) {
  throw new Error("usage: node scripts/slice2-e2e/report.mjs --evidence-dir <path>");
}
const evidenceDir = path.resolve(process.argv[optionIndex + 1]);

const EXECUTIONS = [
  { dir: "scenario1/run", label: "Transport via workflow CLI" },
  { dir: "scenario1/mcp", label: "Transport via MCP" },
  { dir: "scenario2/run-sigterm", label: "Persistence via workflow CLI (SIGTERM)" },
  { dir: "scenario2/run-sigkill", label: "Persistence via workflow CLI (SIGKILL)" },
  { dir: "scenario2/mcp-sigterm", label: "Persistence via MCP (SIGTERM)" },
  { dir: "scenario2/mcp-sigkill", label: "Persistence via MCP (SIGKILL)" },
];

async function readOptionalJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function summarizeExecution(execution) {
  let transcript;
  try {
    transcript = await readFile(path.join(evidenceDir, execution.dir, "transcript.jsonl"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }

  let passed = 0;
  let total = 0;
  let fatal = null;
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (record.type === "assert") {
      total += 1;
      if (record.pass) passed += 1;
    } else if (record.type === "fatal") {
      fatal = record.message;
    }
  }
  return { ...execution, passed, total, fatal };
}

async function main() {
  const summaries = [];
  for (const execution of EXECUTIONS) {
    const summary = await summarizeExecution(execution);
    if (summary) summaries.push(summary);
  }
  if (summaries.length === 0) throw new Error(`no scenario transcripts found in ${evidenceDir}`);

  const environment = await readOptionalJson(path.join(evidenceDir, "environment.json"));
  const clientProbe = await readOptionalJson(path.join(evidenceDir, "client-probe.json"));
  const lines = [
    "# Agent transport end-to-end results",
    "",
    `Evidence directory: \`${evidenceDir}\``,
    "",
    "| Scenario | Checks | Result |",
    "|---|---:|---|",
  ];
  for (const summary of summaries) {
    const passed = summary.fatal === null && summary.passed === summary.total;
    lines.push(`| ${summary.label} | ${summary.passed}/${summary.total} | ${passed ? "PASS" : "FAIL"} |`);
  }

  if (environment) {
    lines.push("", "## Environment", "", "| Fact | Value |", "|---|---|");
    lines.push(`| Host | ${environment.host.platform} ${environment.host.arch} (${environment.host.osRelease}) |`);
    lines.push(`| Node.js | ${environment.node} |`);
    lines.push(`| FFmpeg | ${environment.ffmpegVersion ?? "not available"} |`);
    lines.push(`| FFprobe | ${environment.ffprobeVersion ?? "not available"} |`);
    lines.push(`| CLI | \`${environment.cli.path}\` |`);
  }
  if (clientProbe) {
    const installed = clientProbe.probes.filter((probe) => probe.found).map((probe) => probe.cli);
    lines.push("", "Available client CLIs: ", installed.length ? installed.map((name) => `\`${name}\``).join(", ") : "none");
  }

  await writeFile(path.join(evidenceDir, "REPORT.md"), `${lines.join("\n")}\n`, "utf8");
  process.stdout.write(`Report written: ${path.join(evidenceDir, "REPORT.md")}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
