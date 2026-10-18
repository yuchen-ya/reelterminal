# Agent transport end-to-end checks

The runner exercises the built `reelterminal-agent` CLI through its workflow
interface. It checks project creation, media import, editing, preview,
export, verification, cleanup, and persistence across process restarts.

## Run

Build the transport package, then run the desired scenarios:

```sh
corepack pnpm --filter @reelterminal/agent-transport build
node scripts/agent-transport-e2e/run.mjs
node scripts/agent-transport-e2e/run.mjs --scenario 1
node scripts/agent-transport-e2e/run.mjs --scenario 2
```

The runner needs Node.js, `ffmpeg`, `ffprobe`, and the browser installed for
`@reelterminal/runtime-chromium`. It writes transcripts and reports to a new
directory under the operating system's temporary directory. Pass
`--evidence-dir <path>` to choose another output directory. Generated media,
projects, and artifacts are temporary; `--keep-evidence` retains those files.
On Windows, scenario 2 runs the forced-exit recovery case; its POSIX SIGTERM
cleanup variant is skipped because Windows does not deliver that signal.

The runner labels its workflow clients as simulated. A CLI probe records
whether supported third-party client binaries are available on the machine.

## Options

- `--scenario 1|2|all` selects transport checks, persistence checks, or both.
- `--keep-evidence` retains temporary media, projects, and artifacts.
- `--evidence-dir <path>` selects the transcript output directory.
- `--cli <path>` selects the built CLI entry point.

Render a summary next to an evidence directory:

```sh
node scripts/agent-transport-e2e/report.mjs --evidence-dir <path>
```
