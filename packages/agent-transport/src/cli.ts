#!/usr/bin/env node
/**
 * `agent-video` — the ADR 0003 slice-2 agent transport CLI.
 *
 * Three subcommands (Decision 3):
 *   serve                — the MCP stdio server; one process == one session
 *   run --workflow <abs> — executable JSONL workflow over a fresh session
 *   doctor               — one machine-readable environment report
 *
 * stdout discipline (Decision 6): stdout carries ONLY MCP frames, step
 * JSON lines, or the doctor report — everything else (logs, usage errors)
 * goes to stderr as single-line JSON. Dependency console.* is redirected
 * to stderr before any dependency module runs.
 */
import process from "node:process";

import {
  logError,
  redirectConsoleToStderr,
  setLogLevel,
} from "./log";

const USAGE = `agent-video — OpenReel Agent Video Engine transport (ADR 0003)

Usage:
  agent-video serve [options]        Start the MCP stdio server (one process == one session)
  agent-video run --workflow <abs> [--keep-going] [options]
                                     Execute a JSONL workflow over a fresh session
  agent-video doctor                 Print the machine-readable environment report
  agent-video --help                 This help

Options (serve/run):
  --media-root <abs>      Repeatable. Roots media.import may read from.
  --artifact-root <abs>   Exactly one. Root for preview/visual/export/verify artifacts.
  --project-root <abs>    Repeatable. Roots for project.open/project.save checkpoints.
  --delivery-root <abs>   Repeatable. Roots export.start destinationPath may deliver to (<root>/jobs/<slug>/output/).
  --log-level <level>     error | info | debug (stderr JSON logs; default info)

Environment (flags beat env):
  OPENREEL_AVE_MEDIA_ROOTS      path-separator list
  OPENREEL_AVE_ARTIFACT_ROOT    single path
  OPENREEL_AVE_PROJECT_ROOTS    path-separator list
  OPENREEL_AVE_DELIVERY_ROOTS   path-separator list
  OPENREEL_TRANSPORT_LOG        error | info | debug

Every root and path input must be ABSOLUTE (relative paths and '~' are
refused, never resolved against the cwd). Missing/relative/non-directory
roots are a startup refusal (exit 2).

Exit codes: serve/run/doctor — 0 ok · 1 degraded (doctor) or first step
failure (run) · 2 unusable (doctor) or invocation/static error · signals
exit 130/143/129; a second signal exits immediately; stdin EOF exits 0.
`;

async function main(): Promise<never> {
  redirectConsoleToStderr();
  const [, , cmd, ...rest] = process.argv;

  switch (cmd) {
    case "serve": {
      const { serveCommand } = await import("./serve");
      return serveCommand(rest);
    }
    case "run": {
      const { runCommand } = await import("./workflow");
      process.exit(await runCommand(rest));
    }
    case "doctor": {
      const { doctorCommand } = await import("./doctor");
      process.exit(await doctorCommand(rest));
    }
    case "--help":
    case "-h":
    case "help":
      process.stdout.write(USAGE);
      process.exit(0);
      break;
    case undefined:
      process.stderr.write(
        `${JSON.stringify({
          ts: new Date().toISOString(),
          level: "error",
          scope: "cli",
          msg: "no subcommand given — expected serve | run | doctor",
        })}\n${USAGE}`,
      );
      process.exit(2);
      break;
    default:
      setLogLevel("info");
      logError("cli", `unknown subcommand "${cmd}" — expected serve | run | doctor`);
      process.stderr.write(USAGE);
      process.exit(2);
  }
}

main().catch((error: unknown) => {
  // Unexpected crash: one stderr JSON log, bounded exit 1.
  logError("cli", "unexpected crash", {
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  });
  process.exit(1);
});
