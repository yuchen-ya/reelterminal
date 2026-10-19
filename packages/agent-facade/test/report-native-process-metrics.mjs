import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

const [directory, destination] = process.argv.slice(2);
if (!directory || !destination) throw new Error("Usage: report-native-process-metrics.mjs raw-directory report.json");
const labels = ["competing", "isolated"];
const reports = [];
for (const label of labels) {
  let raw;
  try { raw = JSON.parse(await readFile(path.join(directory, `${label}-results.json`), "utf8")); }
  catch { /* A stopped/failed command may not have completed its reporter. */ }
  const group = raw?.testResults?.find(item => item.name.replaceAll("\\", "/").endsWith("/audio-normalize.test.ts"));
  const cases = (group?.assertionResults ?? []).map(item => ({ title: item.title, status: item.status, durationMs: item.duration }));
  const events = [];
  let unreadableLines = 0;
  for (const file of await readdir(directory).catch(() => [])) {
    if (!file.startsWith(`${label}.`) || !file.endsWith(".jsonl")) continue;
    for (const line of (await readFile(path.join(directory, file), "utf8")).split(/\r?\n/).filter(Boolean)) {
      try { events.push(JSON.parse(line)); } catch { unreadableLines++; }
    }
  }
  const invoked = events.filter(item => item.event === "invoked");
  const closed = new Set(events.filter(item => item.event === "closed").map(item => `${item.ownerPid}:${item.id}`));
  reports.push({ label, suiteSucceeded: raw?.success ?? false, totalSuiteCases: raw?.numTotalTests ?? 0,
    nativeCases: cases, checkpoints: events.filter(item => item.event === "checkpoint"),
    pendingProcesses: invoked.filter(item => !closed.has(`${item.ownerPid}:${item.id}`)).map(item => ({ ownerPid: item.ownerPid, id: item.id, stage: item.stage, childPid: item.childPid })),
    unreadableLines, nativeEvents: events,
    allNativeCasesPassed: cases.length > 0 && cases.every(item => item.status === "passed") });
}
const version = executable => {
  try { return execFileSync(executable, ["-version"], { encoding: "utf8", windowsHide: true }).split(/\r?\n/)[0]; }
  catch { return "unavailable"; }
};
const report = {
  schema: "reelterminal.native-process-diagnostic/v1",
  sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  sourceDirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()),
  platform: process.platform, arch: process.arch, node: process.version,
  pathFfmpegVersion: version("ffmpeg"), pathFfprobeVersion: version("ffprobe"), reports,
  limits: ["Native lifetimes are wall time, not native CPU time.",
    "Recorder overhead fields cover writes before that event, excluding its own final write.",
    "The process trace is capped at 128 native processes per Node worker.",
    "Post-timeout continuations may overlap later cases; correlate invocations to checkpoint UTC and the original deadline.",
    "A successful isolated diagnostic never overrides a failed competing suite.",
    "Hosted timing is not local-machine performance qualification."],
};
await mkdir(path.dirname(destination), { recursive: true });
await writeFile(destination, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ sourceHead: report.sourceHead, reports: reports.map(({ label, suiteSucceeded, allNativeCasesPassed, nativeCases, pendingProcesses }) =>
  ({ label, suiteSucceeded, allNativeCasesPassed, cases: nativeCases.length, pendingProcesses: pendingProcesses.length })) }));
// Both the original suite and the isolated diagnostic remain required.
if (!reports.every(item => item.suiteSucceeded && item.allNativeCasesPassed && item.unreadableLines === 0 && item.nativeEvents.length > 0 && item.pendingProcesses.length === 0)) process.exitCode = 1;
