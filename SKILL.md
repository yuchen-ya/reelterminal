---
name: agent-video
description: >-
  Drive the OpenReel Agent Video Engine through the agent-video transport
  (ADR 0003): create/edit a video project, render preview frames, export
  MP4/H.264, verify artifacts, and persist projects across sessions via
  checkpoints. Use when a task asks to build, edit, render, export, verify,
  or resume a video project with agent-video / @openreel/agent-transport.
---

# agent-video — agent transport for the video engine

One `agent-video` process owns exactly **one facade session** and that
session owns exactly **one project**. Two clients are provided:

- `serve` — a long-lived MCP stdio server (the persistent session).
- `run --workflow <abs>` — executes one JSONL workflow over a **fresh**
  session and exits; for agents without an MCP client.
- `doctor` — one machine-readable JSON environment report on stdout.

Binary: `<repo>/packages/agent-transport/dist/cli.js` (build with
`corepack pnpm --filter @openreel/agent-transport build`). Substitute an
absolute path for `<repo>` everywhere below. Authoritative contract:
`docs/adr/0003-agent-transport-slice-2.md`; verb semantics:
`packages/agent-facade/README.md`.

## 1. Run `doctor` first — and trust its reasons

```sh
OPENREEL_AVE_MEDIA_ROOTS=/abs/media \
OPENREEL_AVE_ARTIFACT_ROOT=/abs/artifacts \
OPENREEL_AVE_PROJECT_ROOTS=/abs/checkpoints \
node <repo>/packages/agent-transport/dist/cli.js doctor
```

`doctor` reads only the env config (no root flags). Exit `0` usable ·
`1` degraded · `2` unusable. The report lists the Chromium build,
ffmpeg/ffprobe paths + versions, codec preflight results, the
canonicalized roots, orphan artifacts, checkpoint residue, and the
verdict's `reasons`. If it is not usable, stop and read `reasons` — do
not improvise around a failed preflight.

After connecting, call `capabilities_get` and check every capability you
are about to use. If one is `available: false`, its `reason` is the truth
about why; there is no skill-level workaround. Missing capability ⇒ read
`capabilities_get`'s reason, never "do this instead".

## 2. Configure `serve` per client (configuration, not variants)

The same 15 tools exist on every client. Clients must spawn the server
**directly** (no `sh -c` wrapper — a wrapper that holds stdin open defeats
disconnect detection). Set the `OPENREEL_AVE_*` env vars in the server's
environment; every root value must be an absolute path to an existing
directory.

Codex (`~/.codex/config.toml`, or `codex mcp add`):

```toml
[mcp_servers.agent-video]
command = "/abs/repo/packages/agent-transport/dist/cli.js"
env = { "OPENREEL_AVE_MEDIA_ROOTS" = "/abs/media", "OPENREEL_AVE_ARTIFACT_ROOT" = "/abs/artifacts", "OPENREEL_AVE_PROJECT_ROOTS" = "/abs/checkpoints" }
```

Claude Code (tools become `mcp__agent-video__<tool>`):

```sh
claude mcp add-json agent-video '{"command":"/abs/repo/packages/agent-transport/dist/cli.js","env":{"OPENREEL_AVE_MEDIA_ROOTS":"/abs/media","OPENREEL_AVE_ARTIFACT_ROOT":"/abs/artifacts","OPENREEL_AVE_PROJECT_ROOTS":"/abs/checkpoints"}}'
# equivalent project-scope .mcp.json: {"mcpServers":{"agent-video":{"command":"…","env":{…}}}}
```

DSH (`@deepseek-ai/dsh-mcp-client` plugin entry):

```yaml
serverName: agent-video
transport: stdio
command: /abs/repo/packages/agent-transport/dist/cli.js
env:
  OPENREEL_AVE_MEDIA_ROOTS: /abs/media
  OPENREEL_AVE_ARTIFACT_ROOT: /abs/artifacts
  OPENREEL_AVE_PROJECT_ROOTS: /abs/checkpoints
```

MCP-less agents (Pi-class) use `run` + `doctor`: author a JSONL workflow
(§5), then `node <repo>/packages/agent-transport/dist/cli.js run --workflow
/abs/wf.jsonl --media-root /abs/media --artifact-root /abs/artifacts
--project-root /abs/checkpoints`. One invocation = one fresh session.

## 3. The world model

- `mediaRoots` — where `media_import` may read source files.
- `artifactRoot` — the only place previews/exports/verify artifacts land.
- `projectRoots` — where `project_open`/`project_save` checkpoint files live.
- Roots are fixed at process start (flags beat env; no tool can widen them).
  Multi-project work means multiple `serve` processes, each with its own
  roots and provider set.
- **Absolute paths only, everywhere** — every path you pass (tool params,
  workflow fields, flags, env roots) must be absolute. Relative paths and
  `~` are refused, never resolved against any cwd. Paths must resolve
  inside the matching root class; escapes and URLs fail.

## 4. The 15 tools

| Tool | Purpose |
|---|---|
| `session_describe` | Facade self-description (verbs, error codes, step letters) — distinct from MCP `initialize` |
| `capabilities_get` | Live provider preflights |
| `project_create` | Create this session's single project (single-initialization lifecycle verb) |
| `project_open` | Open a checkpoint file into this session's empty project slot (single-initialization lifecycle verb) |
| `project_save` | Save the active project to a checkpoint file (a snapshot, not a mutation) |
| `project_get_state` | Full canonical dump (Decision 8) |
| `media_import` | Path inside `mediaRoots`; URLs refused |
| `timeline_get` | Compact view — preferred read |
| `editor_get_context` | Editor context (selection, playhead, canvas point); headless-honest — see below |
| `edit_apply` | Closed op set; atomic; `expectedRevision` (+`expectedContextRevision` live) + `idempotencyKey` |
| `preview_render_frame` | Replay/ledger only; artifact to `artifactRoot` |
| `export_start` | Snapshot job; returns `jobId` immediately |
| `job_status` | Poll to terminal |
| `job_cancel` | Cooperative; idempotent on terminal jobs |
| `verify_artifact` | ffprobe/pixel checks as data |

Every result is one JSON envelope: `{ok:true, value}` or
`{ok:false, error:{code, message, details}}` with `isError:true` — match on
`error.code` (9 codes: `INVALID_PARAMS NOT_FOUND CONFLICT UNSUPPORTED
CONFIRMATION_REQUIRED JOB_FAILED ACTION_FAILED INTERNAL FORBIDDEN`), never on prose.
Parameter schemas/defaults live in each tool's `inputSchema` and the facade
README — this skill does not restate them. Context discipline: orient with
`timeline_get`; `project_get_state` is an unbounded full dump; artifacts
come back as `{path, sizeBytes, sha256, sourceRevision}` refs, never pixels.

### `editor_get_context` — live vs headless honesty

The verb exists so an agent collaborating with a human can read the
ephemeral editor context: playhead, selected clip/text ids, selected time
range, the normalized canvas target point, a monotonic `contextRevision`,
and `{projectId, projectName, windowId}`.

- **Headless** (this transport — `serve`/`run`/`doctor`): there is no
  editor. The result is honest about it: `mode:"headless"`,
  `contextAvailable:false`, every context field `null`/empty, `windowId`
  `null`. Only `projectRevision` and the project identity are real. Never
  treat the nulls as real values (e.g. do not read "no selection" into
  them — there is no editor to select in).
- **Live** (desktop GUI sessions, ADR 0004): `mode:"live"`,
  `contextAvailable:true`, real context with a real `contextRevision`.
- **`expectedContextRevision` on `edit_apply`:** an agent that derived its
  ops from the live context carries that revision as a CAS guard; a stale
  value fails `CONFLICT` and nothing is applied — re-read
  `editor_get_context` and retry. Headless `edit_apply` rejects the field
  `INVALID_PARAMS` (there is no context to guard).

### Live-mode `edit_apply` / `project_save` honesty

- **Live `edit_apply` revision CAS is unconditional:** when you omit
  `expectedRevision`, the live session attaches the revision of the snapshot
  your ops were translated against, so a human edit landing between your
  read and the apply still fails `CONFLICT` and nothing is applied. An
  explicit `expectedRevision` is honored as-is.
- **Live `project_save` is not a checkpoint:** it flushes the GUI's
  autosave/recovery snapshot and reports the current revision. It does not
  write a `.openreel` project file — the GUI owns where and how project
  files are written.

### The `edit_apply` op vocabulary

Eight ops, one atomic batch each call (the exact fields and bounds live in
`edit_apply`'s `inputSchema`):

- `track.add` — create a track (`trackType`); `clip.add` — place imported
  media on a track; `clip.trim` — move a clip's `inPoint`/`outPoint` (at
  least one, `outPoint` must exceed `inPoint`).
- `text.create` — an overlay on a text track. `position`/`anchor` are
  **normalized 0..1 frame coordinates** (resolution-independent:
  `0.5/0.5` = center, `y:0.85` = lower third) and apply identically in
  previews and exports. Safe area: keep the anchor point inside
  `[0.05, 0.95]` on both axes so text stays fully visible.
- `text.update` — edit one overlay by `overlayId` (read
  `textOverlays[].id` from `timeline_get`/`project_get_state` first —
  also where its current `position`/`anchor` are surfaced). At least one
  updatable field is required; **`style` merges** with the existing style
  and `position`/`anchor` merge with the existing placement — omitted
  keys keep their values.
- `text.delete` — remove an overlay by `overlayId`.
- `clip.setVolume` — linear gain `0..4` on any clip (audio or video
  track): `0` = mute, `1` = unity; it flows into the exported audio.
- `clip.remove` — remove one timeline clip (video/audio/image track, not
  a text overlay) by `clipId` (read `tracks[].clips[].id` from
  `timeline_get` first); the gap stays — no ripple.

Ops in one batch see each other's results, and a failure anywhere rolls
the whole batch back; a deleted overlay or clip stays deleted after
`project.save` → `project.open`.

## 5. Idempotency, revisions, and the export loop

- **Idempotency keys:** mint one fresh key per logical mutation; a retry
  reuses the SAME key with the byte-identical payload (it replays the
  committed result, `replayed:true`); the same key with a different payload
  fails `CONFLICT`. The ledger is per session/process: after `project.open`
  (or any new process), mint fresh keys.
- **Revisions:** each committed mutation bumps the revision exactly once;
  pass `expectedRevision` on mutations to guard against concurrent change.
- **Exports are jobs** (so 60 s client tool timeouts stay manageable):
  `export_start {idempotencyKey}` ⇒ `{jobId, state:"queued"}` ⇒ poll
  `job_status` every 2–5 s until a terminal state (`done`/`error`/
  `cancelled`) — then stop polling. In a `run` workflow the same wait is a
  bounded `await` step (`timeoutMs` required, ≤ 3 600 000; `pollMs`
  250–30 000). Never guess artifact paths — use the `artifact.path` the
  job reports.
- **Always finish with `verify_artifact`:** assert on `checks[].pass` and
  the `compare` numbers; the report is data, the files stay on disk.
- **Preview before exporting** (`preview_render_frame {timeSec}`) so pixel
  questions are answered by `verify_artifact` compares against the PNG.
- `run` workflow rules: JSONL, one step per line, unique step `id`s, `$ref`
  references point only to EARLIER steps (single hop, structural
  substitution — no templating, no expressions), default
  stop-on-first-failure (exit 1; `--keep-going` continues, exit still
  reflects the first failure; static/invocation errors exit 2 before any
  step runs). One JSON line per step on stdout.

## 6. Disconnect kills jobs

Jobs, the idempotency ledger, and provider state live **only inside the
process**. A session that dies takes its running jobs with it: poll every
job to a terminal state **before** disconnecting/exiting. After a restart
no session remembers the project (`NOT_FOUND`) or its jobs. Files an
interrupted export may leave under `artifactRoot` are unregistered —
`doctor` lists them as "orphan — unverifiable, do not trust as an
artifact" and nothing auto-deletes them; never treat one as a deliverable.

## 7. Checkpoints (cross-session persistence)

- **Save** with `project_save {path, expectedRevision?}` — a snapshot, not
  a mutation: the returned `revision` equals the pre-save revision. Default
  is **no-overwrite**: an existing target fails `CONFLICT`. Save each
  milestone to a NEW versioned path (`promo-v1.openreel.json`,
  `promo-v2.openreel.json`, …). If a save's outcome is unknown (e.g.
  timeout), do not blindly retry the same path — save to a fresh versioned
  path instead. Checkpoint paths must be inside `projectRoots`.
- **Resume** by calling `project_open {path}` in a FRESH session/process
  (with an active project it fails `CONFLICT` — one project per process,
  ever). Open validates containment, format version, integrity hash,
  structure, and every media reference; any failure refuses the open with
  the reason (moved/changed media lists the offending `mediaIds` — no
  relink exists). The project continues at the saved revision.
- **Fresh keys after every open** — the ledger is per-session and is never
  saved.
- **Before saving a checkpoint you intend to resume from**, poll every job
  to a terminal state; jobs are never part of a checkpoint.
- Durable: exactly the checkpoint file. Not durable: jobs, ledger, provider
  state, previews/exports in flight.

## 8. If something is missing

Read the `reason`/`details` in the error or in `capabilities_get`/`doctor`.
That is the whole instruction — this skill deliberately adds no fallbacks,
retries, or workarounds the facade does not have.
