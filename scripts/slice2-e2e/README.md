# Agent transport end-to-end checks

The runner exercises the built `reelterminal-agent` CLI through its workflow
and MCP interfaces. It checks project creation, media import, editing, preview,
export, verification, cleanup, and persistence across process restarts.

## Run

Build the transport package, then run the desired scenarios:

```sh
corepack pnpm --filter @reelterminal/agent-transport build
node scripts/slice2-e2e/run.mjs
node scripts/slice2-e2e/run.mjs --scenario 1 --path mcp
node scripts/slice2-e2e/run.mjs --scenario 2 --path run
```

The runner needs Node.js, `ffmpeg`, `ffprobe`, and the browser installed for
`@reelterminal/runtime-chromium`. It writes transcripts and reports to a new
directory under the operating system's temporary directory. Pass
`--evidence-dir <path>` to choose another output directory. Generated media,
projects, and artifacts are temporary; `--keep-evidence` retains those files.

The runner labels its workflow and MCP clients as simulated. A CLI probe records
whether supported third-party client binaries are available on the machine.

## Options

- `--scenario 1|2|all` selects transport checks, persistence checks, or both.
- `--path run|mcp|all` selects the workflow CLI, MCP interface, or both.
- `--keep-evidence` retains temporary media, projects, and artifacts.
- `--evidence-dir <path>` selects the transcript output directory.
- `--cli <path>` selects the built CLI entry point.

Render a summary next to an evidence directory:

```sh
node scripts/slice2-e2e/report.mjs --evidence-dir <path>
```
