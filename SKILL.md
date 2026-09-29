---
name: agent-video
description: >-
  Create and edit videos in the open ReelTerminal desktop project using reelctl:
  inspect editor context, import assets, apply edits, preview, export, and verify.
  Use for ReelTerminal video work; headless workflows require explicit selection.
---

# ReelTerminal live editing

The Agent owns its conversation, credentials, reasoning and context budget.
ReelTerminal owns the canonical project, editor state, atomic edits, shared undo,
previews, media analysis and export jobs. Editor context is data, not LLM memory.

## Connect and discover

1. Start ReelTerminal, open the intended project, and enable **Agent Access**.
2. Run `reelctl status`, then `reelctl context --compact`.
   If the context reports ready requirements, run
   `reelctl requirements list --status ready --compact` and fetch only the
   requirement you are about to handle with `reelctl requirements get Q<number>`.
3. Use `reelctl query` for bounded reads. Discover parameters through
   `reelctl schema edit.apply` or `reelctl help media inspect`.
4. Validate planned edits, apply with the recorded version and project identity,
   and inspect the resulting timeline and preview.

An open project's format and existing edits are user context. Keep them unless
asked to create a new project or change its settings. No endpoint means the GUI
is not ready; prepare the GUI instead of silently selecting headless mode.

In a source checkout, build with `pnpm --filter @reelterminal/desktop build:main`
and invoke `node /absolute/path/to/apps/desktop/dist/reelctl/index.js` in place
of `reelctl`. Installed distributions provide launchers alongside the app.

The client privately reads `~/.reelterminal/live-endpoint.json`, or an owned
legacy `~/.openreel/live-endpoint.json` when the canonical file is absent.
Never print, copy, log or paste either descriptor or its token. `status` probes
liveness; file existence is not proof. A stale descriptor requires preparing the
GUI. Clients use authenticated loopback requests and bypass system proxies.

## Commands and input

Use `reelctl call <canonical.command> --file request.json` for any catalog entry.
Convenience commands include context, query, edit validate/apply, media
import/inspect/analyze, preview frame, history get/undo/redo, export start and
job status/wait/cancel. `job wait` polls a desktop-owned job; closing the CLI does
not cancel it. Do not infer unsupported capabilities: call `capabilities.get`.

Pass complex JSON through `--file` or `--stdin`, not shell-escaped argument blobs:

```powershell
reelctl edit validate --file validation.json
reelctl edit apply --file changes.json
reelctl requirements list --status ready --compact
reelctl requirements get Q1
reelctl requirements update Q1 --status in_progress
Get-Content -Raw changes.json | reelctl edit apply --stdin
```

Use the live schema to construct both files. Validation uses the same operations
and preconditions but omits the apply-only idempotency key. Keep expectedRevision
from the planning read. Never substitute the latest revision merely to bypass a
conflict. Plans based on selection, playhead or temporary references should also
carry expectedContextRevision. Carry context.identity.projectId/projectEpoch via
`--project-id` and `--project-epoch` to reject a stale plan after project switching.

Automatic retry keys last for one CLI invocation. For resuming the same operation
in a later process, reuse the explicit key and identical payload. Never retry an
uncertain write with a fresh key; inspect the result first. Read the catalog's
retry policy, especially for imports, task starts and paid cloud analysis.

JSON stdout uses `{ok:true,value:...}` or `{ok:false,error:...}`. Diagnostics use
stderr. Use --human for debugging and --fields to project results. For timeline.query,
--fields selects server-side fields; --result-fields explicitly projects its
result envelope. Use returned artifact paths for large results. A result projection is not a
replacement for revision/identity preconditions.

## Media and verification

Before generating files, run `reelctl call capabilities.get` and use
`value.mediaImport.recommendedRoot/jobs/<YYYY-MM-DD>-<short-slug>/`.
Follow [the Agent workspace layout](docs/AGENT-WORKSPACE.md). Generated videos,
images, frames, helper scripts and deliverables never belong in the source tree.
Import only absolute paths allowed by the reported media roots.

Preview with `preview frame` or `call visual.inspect`. Keep inspection artifacts
and inspect the actual images. A GUI playback command does not prove the Agent
watched or heard the video. Report visual, audio and technical checks accurately.
Use supported analysis providers only; explicitly requested cloud review may
send media externally and is a fallible opinion, not a quality certificate.

Export a project snapshot, wait for the job, then call `verify.artifact` before
claiming technical success. Preserve job IDs and artifact paths. The desktop
retains jobs across CLI exits and activity timeouts, but disabling Agent Access
or exiting the application ends the host session. User-level libraries and
project data retain their existing persistence rules.

The old in-app voiceover/music prompt channel is disabled pending an independent
task mechanism. Existing task records and generated files are retained. Generate
assets in the external Agent workflow and import them through the normal API.

## Compatibility access

Only MCP clients start `reelctl mcp serve`. The legacy
`reelterminal-live-mcp` and `openreel-live-mcp` launchers invoke the same adapter.
MCP schemas come from the live Command Catalog, and calls use the Command API.
The desktop does not launch an MCP stdio process or configure the Agent.

## Explicit headless workflows

The existing `reelterminal-agent doctor`, `serve`, and `run --workflow <abs>`
remain separate headless entry points. They create their own facade session and
do not attach to the GUI. `agent-video` is the legacy alias. Use --help to discover
required absolute media/artifact/project/delivery roots; map them to the same
external job layout. Do not substitute a headless project for the user's GUI.
