---
name: agent-video
description: >-
  Drive ReelTerminal through its live desktop MCP interface by default: connect
  the external Agent to the open GUI project's 17-tool openreel-live-mcp
  facade, inspect context, edit, preview, export, and verify. The optional
  agent-video serve/run transport remains available for headless workflows.
---

# agent-video — ReelTerminal live desktop first

ReelTerminal is the finishing editor for AI video: **ReelTerminal，你的 AI 视频终点站。
生成发生在任何地方，成片发生在这里。** The default workflow is a live
desktop session where the user and an external Agent are equal peers on the
same GUI project, through different paths:

- The user edits in the ReelTerminal GUI.
- The external Agent connects through `openreel-live-mcp`.
- Both paths use the same canonical project, revisions, undo history, preview,
  export, and verification.

ReelTerminal does not embed a conversational Agent or generative model, manage its
provider keys, run its tool-use loop, or own conversation history. The external
Agent owns its reasoning and conversation;
ReelTerminal owns the editing world and its tool/context boundary.

## 0. Live desktop workflow (default)

1. Open a project in the ReelTerminal desktop editor.
2. Enable **Agent Session** in the collaboration status bar. This starts the
   token-authenticated loopback endpoint for the external Agent.
3. Build and configure the `openreel-live-mcp` MCP connector in the Agent host:

   ```sh
   corepack pnpm --filter @openreel/desktop build:main
   ```

   The
connector reads `~/.openreel/live-endpoint.json` by default to discover the
current loopback URL and bearer token. The endpoint file is short-lived and
is removed when the Agent Session is disabled.

Treat that descriptor as a credential: never `cat`, print, log, paste, or return
its contents. Let `openreel-live-mcp` read it, or read it only inside a client
process that sends the token directly in the loopback Authorization header.
File existence is not a liveness check; after an unclean app exit it may be
stale. Probe the local endpoint without echoing credentials, then launch/prepare
the GUI and let the desktop host replace an unreachable descriptor. HTTP clients
must bypass system proxies for loopback (`127.0.0.1`, `localhost`).

The live desktop path is mandatory for an ordinary user-facing creation brief.
If the endpoint file is absent, that means the desktop session has not been
prepared; it is **not** permission to silently switch to headless mode. When the
Agent host can control local apps, it should launch the desktop editor, create
or open the project through the GUI, enable Agent Session through the GUI, and
then connect. Otherwise ask the user to perform those GUI lifecycle steps. Use
the headless transport only when the user explicitly requests headless work or
no GUI-visible collaboration is required.

An already-open live project is user context, including its aspect ratio, frame
rate, name, and existing edits. Use it as-is unless the user explicitly asks for
a new project or different settings. Do not replace a vertical project with a
horizontal one (or vice versa) merely because one format seems more conventional.

Example MCP configuration (the connector itself owns endpoint-file parsing):

```toml
[mcp_servers.openreel-live-mcp]
command = "node"
args = ["/abs/repo/apps/desktop/dist/live-mcp/index.js"]
```

An installed desktop distribution may also place `openreel-live-mcp` on
`PATH`; in a source checkout, use the built absolute path above so the Agent
configuration is deterministic.

Use an explicit endpoint-file option only if the connector or host requires
one; the default is already `~/.openreel/live-endpoint.json`. Do not copy the
token into project files, prompts, or logs.

This connector exposes the same open GUI project through exactly **17 tools**:

`session_describe` · `capabilities_get` · `project_create` · `project_open` ·
`project_save` · `project_get_state` · `media_import` · `timeline_get` ·
`editor_get_context` · `editor_control` · `edit_apply` · `preview_render_frame` ·
`visual_inspect` ·
`export_start` · `job_status` · `job_cancel` · `verify_artifact`.

The live facade reports GUI-owned project lifecycle operations honestly as
unavailable (`project_create` and `project_open`). `media_import` accepts an
absolute local video/audio path under a root reported by
`capabilities_get.mediaImport.mediaRoots`, imports it into the open canonical
GUI project, and returns the `mediaId` used by later `clip.add` edits. The media
panel updates immediately and the user can undo the import through the normal
GUI history. Agents should create or copy generated assets into one of the
reported roots instead of asking the user to import them manually. For every
new creation task, use `capabilities_get.mediaImport.recommendedRoot` and the
job layout in [`docs/AGENT-WORKSPACE.md`](docs/AGENT-WORKSPACE.md); never scatter
generated media, helper scripts, or deliverables across the source repository.
`editor_get_context` includes the live selection, playhead, ranges, canvas
target, context revision, and stable Agent-reference mapping. References are
session-local (`#1`, `#2`, `#3`, …), deterministic for multi-selection, never
renumbered/reused, and stale after deletion rather than silently rebinding.
The context revision changes on meaningful selection or explicit seek/scrub
changes; ordinary playback ticks do not invalidate a context CAS guard every
frame.

### Short creative briefs are complete requests

When the user gives only an outcome (for example, “make a 30-second promo”),
the default still means the live desktop workflow; never infer headless mode
from a missing endpoint. Treat the open project's settings as part of that
brief. Own the finishing workflow: read capabilities and current context, use
the Agent host's available creation/search/audio tools to prepare suitable assets
inside a reported media root, import them, build the timeline, preview and
visually inspect, iterate, export, and verify the result. Every edit must go
through the live facade so it appears in the open GUI. Ask the user only for a
genuine creative decision or a capability blocker—not for tool choreography.

### Agent workspace discipline

Before creating any file, call `capabilities_get`. Create exactly one job at
`<recommendedRoot>/jobs/<YYYY-MM-DD>-<short-slug>/` and keep the whole task in
that directory. Use the fixed folders `source/`, `generated/`, `work/`,
`project/`, `output/`, and `evidence/`; write the interpreted request to
`brief.md`. Put only final, verified deliverables in `output/`. Preview frames,
contact sheets, logs, raw captures, generated scripts, and retry artifacts are
not deliverables and belong in `work/` or `evidence/`. Reusable user-approved
brand assets may live in `<recommendedRoot>/shared/`.

The desktop host creates `ReelTerminal Agent Workspace/jobs` and `shared`
under the operating system's Videos folder. `ReelTerminal Agent Imports` is a
legacy readable root, not the destination for new jobs. Do not create task
folders at the repository root, inside source packages, or in `/tmp` (except
truly disposable process scratch). Do not delete another job, `source/`,
`shared/`, or a delivered `output/` unless the user explicitly asks. Full
rules and headless root mapping: [`docs/AGENT-WORKSPACE.md`](docs/AGENT-WORKSPACE.md).

The desktop conversation panel and loopback client transport are landed. Each
external Agent/host still runs and configures its thin server-side adapter at
`/conversation`, atomically writes the private
`~/.openreel/conversation-endpoint.json` descriptor with mode `0600`, and
removes it on exit; ReelTerminal only reads that descriptor. There is no universal
provider connector and no embedded model. MCP tool access through the live
facade remains a separate 17-tool integration and must not be confused with
the conversation transport.

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

## 1. Optional headless workflow: run `doctor` first — and trust its reasons

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

## 2. Optional headless `serve` workflow (configuration, not variants)

The same 17 tools exist on every client. Clients must spawn the server
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

## 4. The 17 tools

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
| `editor_control` | Ephemeral live playback and selection/reveal control; never changes project revision or undo history |
| `edit_apply` | Closed op set; atomic; `expectedRevision` (+`expectedContextRevision` live) + `idempotencyKey` |
| `preview_render_frame` | Replay/ledger only; artifact to `artifactRoot` |
| `visual_inspect` | Sample 1–12 real Chromium frames for a clip or explicit time range; return PNG artifacts and a contact sheet when supported |
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
`timeline_get` (its compact clip view includes effective volume, speed,
reverse state, fades, transform, fit, and crop); `project_get_state` is an unbounded full dump; ordinary
artifacts come back as `{path, sizeBytes, sha256, sourceRevision}` refs. On
successful `visual_inspect`, the stdio `serve` transport and desktop live MCP
also attach bounded MCP PNG image content (contact sheet when supported,
otherwise individual frame blocks). The CLI `run` transport remains JSONL
envelopes plus artifact refs; it does not attach MCP image blocks.

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

Twenty-one ops, one atomic batch each call (the exact fields and bounds live in
`edit_apply`'s `inputSchema`):

- `track.add` — create a track (`trackType`); `track.remove` — remove an empty
  track only (tracks with clips, overlays, or transitions are rejected with a
  machine-readable `CONFLICT`); `media.remove` — remove imported media only
  when no timeline clip references it (otherwise `CONFLICT` lists the clip
  ids); `clip.add` — place imported
  media on a track; `clip.move` — move it to an absolute timeline
  `startTime` and optionally another track; `clip.trim` — move a clip's `inPoint`/`outPoint` (at
  least one, `outPoint` must exceed `inPoint`).
- `clip.split` — cut a clip at an absolute timeline time strictly inside
  its bounds; the result reports the new right-hand `clipId`. Constant-speed
  and reversed clips preserve the correct source ranges; variable-speed and
  freeze-frame clips currently return `UNSUPPORTED`.
- `clip.duplicate` — clone a clip with its timing, effects, transform, speed,
  reverse, fades, and audio settings. Omit `startTime` to use the editor's
  next-free-gap placement; the new clip id is returned.
- `clip.rippleDelete` — remove one clip and close the resulting gap on its
  track, matching the editor's Ripple Delete command.
- `text.create` — an overlay on a text track. If no text track exists, the
  same atomic `edit_apply` batch creates one automatically. Read its
  `applied[i].createdIds` entry: `[textTrackId, overlayId]` for that implicit
  lane, `[overlayId]` when a text track already exists. `position`/`anchor` are
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
- `clip.setSpeed` — constant playback speed `0.1..20`; the timeline
  duration is recomputed from the source span.
- `clip.setReverse` — enable or disable reverse playback without changing
  the clip's timeline placement.
- `clip.setTransform` — patch visual composition fields: pixel offset from
  frame center, X/Y scale, rotation, normalized anchor, opacity, fit mode,
  and normalized source crop. Use `clearCrop:true` to restore the full source.
- `clip.setVolume` — linear gain `0..4` on any clip (audio or video
  track): `0` = mute, `1` = unity; it flows into the exported audio.
- `clip.setFade` — set `fadeIn` and/or `fadeOut` in seconds; each value
  must fit within the current clip duration.
- `clip.remove` — remove one timeline clip (video/audio/image track, not
  a text overlay) by `clipId` (read `tracks[].clips[].id` from
  `timeline_get` first); the gap stays — no ripple.
- `transition.add` — add any editor-supported visual transition between two
  directed, adjacent clips on one visual track; the new transition id is
  returned. `transition.update` changes its type and/or duration, and
  `transition.remove` restores the hard cut. Read transition ids from each
  `timeline_get` track's `transitions` array.

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
  job reports. Stdio MCP transports (including the desktop
  `openreel-live-mcp` connector) may instead include `_meta.progressToken` on
  `export_start` and receive opt-in `notifications/progress` updates. Direct
  loopback HTTP callers have no server-push channel, so the polling contract
  remains their required fallback.
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
