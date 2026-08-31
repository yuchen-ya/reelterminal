/**
 * `agent-video doctor` driver (Appendix D step 1). Doctor reads ONLY the
 * OPENREEL_AVE_* env configuration, so it is spawned with the scenario's
 * roots in its environment and no root flags. One single-line JSON report
 * arrives on stdout; stderr carries the JSON logs.
 */
import { spawn } from "node:child_process";

export async function runDoctor({ cliPath, env, recorder, label }) {
  const child = spawn(process.execPath, [cliPath, "doctor"], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  const jsonLines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (jsonLines.length !== 1) {
    throw new Error(
      `doctor stdout carried ${jsonLines.length} non-empty lines (expected exactly 1 JSON report); stdout=${stdout.slice(0, 2000)} stderr=${stderr.slice(-2000)}`,
    );
  }
  const report = JSON.parse(jsonLines[0]);
  await recorder?.record("doctor", { label, exitCode, report, stderrTail: stderr.slice(-2000) });
  return { exitCode, report };
}

/** Standard doctor assertions (Appendix D step 1 + honesty sections). */
export function doctorChecks({ exitCode, report, env }) {
  const roots = report.config?.roots ?? {};
  return [
    {
      name: "doctor exit code is 0 (usable)",
      pass: exitCode === 0 && report.verdict?.classification === "usable",
      detail: `exit=${exitCode} classification=${report.verdict?.classification} reasons=${JSON.stringify(report.verdict?.reasons)}`,
    },
    {
      name: "report lists the Chromium build",
      pass: typeof report.chromium?.browserBuild === "string" && report.chromium.browserBuild.length > 0,
      detail: `browserBuild=${report.chromium?.browserBuild} launchOk=${report.chromium?.launchOk}`,
    },
    {
      name: "report lists ffmpeg + ffprobe paths",
      pass:
        report.ffmpeg?.available === true &&
        typeof report.ffmpeg?.ffmpegPath === "string" &&
        typeof report.ffmpeg?.ffprobePath === "string",
      detail: `ffmpeg=${report.ffmpeg?.ffmpegPath} ffprobe=${report.ffmpeg?.ffprobePath}`,
    },
    {
      name: "codec preflight results present (render + h264 encode/decode + export route)",
      pass:
        report.codecs?.renderAvailable === true &&
        report.codecs?.h264EncodeAvailable === true &&
        report.codecs?.h264DecodeAvailable === true &&
        typeof report.codecs?.exportRoute === "string" &&
        report.codecs.exportRoute !== "unavailable",
      detail: JSON.stringify(report.codecs),
    },
    {
      name: "canonicalized roots echoed for all three classes",
      pass:
        Array.isArray(roots.mediaRoots) &&
        roots.mediaRoots.length > 0 &&
        roots.mediaRoots.every((r) => r.status === "ok" && typeof r.canonical === "string") &&
        roots.artifactRoot?.status === "ok" &&
        typeof roots.artifactRoot?.canonical === "string" &&
        Array.isArray(roots.projectRoots) &&
        roots.projectRoots.length > 0 &&
        roots.projectRoots.every((r) => r.status === "ok" && typeof r.canonical === "string"),
      detail: JSON.stringify({
        mediaRoots: roots.mediaRoots?.map((r) => `${r.raw}→${r.canonical}`),
        artifactRoot: roots.artifactRoot && `${roots.artifactRoot.raw}→${roots.artifactRoot.canonical}`,
        projectRoots: roots.projectRoots?.map((r) => `${r.raw}→${r.canonical}`),
      }),
    },
    {
      name: "provider availability reported (mediaImport/preview/export/verify/persistence)",
      pass:
        report.providers?.mediaImport?.available === true &&
        report.providers?.preview?.available === true &&
        report.providers?.export?.available === true &&
        report.providers?.verify?.available === true &&
        report.providers?.persistence?.available === true,
      detail: JSON.stringify(report.providers),
    },
    {
      name: "orphan section present with the no-auto-delete note",
      pass:
        typeof report.orphans?.note === "string" &&
        report.orphans.note.includes("never auto-deleted") &&
        Array.isArray(report.orphans?.jobDirs),
      detail: report.orphans?.note?.slice(0, 200),
    },
    {
      name: "browser-reaper verification present",
      pass: typeof report.browserReaper?.verified === "boolean",
      detail: JSON.stringify(report.browserReaper),
    },
  ];
}
