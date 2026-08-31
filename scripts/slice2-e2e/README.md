# slice2-e2e — black-box E2E evidence runner (slice 2d)

Executes the Appendix D contracts of `docs/adr/0003-agent-transport-slice-2.md`
against the REAL built transport binary
(`packages/agent-transport/dist/cli.js`) and writes committed evidence under
`docs/slice-2/evidence/`:

- **scenario 1** — `slice2-transport-e2e`: doctor → discover → create →
  import → edit → honesty probes → preview → export → verify (including both
  pixel compares) → cleanup honesty (disconnect + restart + orphan listing).
- **scenario 2** — `slice2-persistence-e2e`: save/kill/open across full
  process boundaries in BOTH kill variants (clean SIGTERM and SIGKILL, both
  must pass), revision/timeline/pixel continuity, and the five corruption
  honesty probes.

Each scenario runs over two paths:

- `--path run` — the runner authors Appendix-B.6 JSONL workflows and invokes
  `agent-video run` (the MCP-less, Pi-class path; deliberately-failing probes
  are separate invocations or one `--keep-going` run whose nonzero exit is
  the expected outcome).
- `--path mcp` — a scripted stdio MCP client over `serve` (raw NDJSON, same
  framing as `packages/agent-transport/test/helpers.ts`).

**Honesty rule (Appendix D):** a client may be claimed "verified" only when
executed by that client's real binary. Both paths here are scripted
simulators and are labeled **`simulated`** in the evidence.

## Usage

```sh
# Build the binary the runner spawns (required). If dist/ already exists,
# remove it first (tsup's clean chokes on the symlinked runtime deps — the
# same hazard packages/agent-transport/test/global-setup.ts works around):
rm -rf packages/agent-transport/dist
corepack pnpm --filter @openreel/agent-transport build

# Everything (scenario 1 run+mcp, scenario 2 run/mcp x SIGTERM/SIGKILL):
node scripts/slice2-e2e/run.mjs

# One scenario / one path:
node scripts/slice2-e2e/run.mjs --scenario 1 --path mcp
node scripts/slice2-e2e/run.mjs --scenario 2 --path run

# Flags:
#   --scenario 1|2|all      (default all)
#   --path run|mcp|all      (default all; scenario 2 always runs both kill
#                            variants for the selected path)
#   --evidence-dir <abs>    (default docs/slice-2/evidence)
#   --keep-evidence         keep the generated temp env dir (media, artifacts,
#                           checkpoints) instead of deleting it
#   --cli <abs cli.js>      override the binary under test
```

Any failed machine check aborts the scenario; the raw transcript
(`transcript.jsonl` in the scenario's evidence dir) carries every doctor
report, workflow line, MCP frame, and the failing assertion.

## Evidence layout

```
docs/slice-2/evidence/
  environment.json            host/toolchain facts of the run
  client-probe.json           real-client CLI probe results (honesty rule)
  scenario1/run/              transcript.jsonl + assertions.md + sha256s.txt
  scenario1/mcp/
  scenario2/run-sigterm/
  scenario2/run-sigkill/
  scenario2/mcp-sigterm/
  scenario2/mcp-sigkill/
docs/slice-2/REPORT.md        the run report tying it all together
```

REPORT.md is rendered from the committed transcripts by
`node scripts/slice2-e2e/report.mjs` — rerun it after any evidence run.

Generated media/artifacts/checkpoints are NOT committed; they live in a fresh
OS temp dir per scenario execution (`--keep-evidence` prints and keeps it).

## Requirements

Node ESM, no dependencies beyond the workspace. On PATH: `ffmpeg` +
`ffprobe` (a build without `drawtext` is fine — the input falls back to bare
`testsrc2`). The Playwright-managed Chromium of `@openreel/runtime-chromium`
must be installed. Real 1080p exports take minutes; the full plan runs about
twenty to forty minutes.
