# Facade v0 — Agent-facing tool surface (design only, no implementation)

Baseline `2566c34e0f8ea22992a85f3ff16e048307b49365`. Inputs: all six area audits +
mechanical catalogs. Goal: a small, transport-agnostic surface an external agent can drive
safely — replacing the 304-tool registry **for external callers** (the registry stays as the
internal/live surface).

## Why not expose the 304 directly

- 190/304 are motion-graphics tools that all funnel into one coarse action
  (`motion/upsertComposition`) — high surface, low marginal value for v0.
- Destructive/expensive gating is inconsistent (AREA-02) and off by default policy
  (DESK-01); no atomicity (CORE-01, DESK-02); no idempotency (genId per call); no revision
  preconditions (CORE F3); silent no-op success on mistyped action types (CORE-08).
- Desktop MCP requires a GUI window and leaks the token (transport-audit.md).

## Facade tool list (19 verbs)

Domain coverage: project, media, timeline, edit, history, preview, export, capability
discovery. Each maps onto audited machinery — no new product code except marked adapters.

| # | Facade verb | Backs onto (evidence) | Letter today |
|---|-------------|------------------------|--------------|
| 1 | `capabilities.get` | `get_capabilities` + CAPABILITY_MANIFEST, extended with live runtime availability (which jobs/adapters are actually wired — fixes RUNNER-06 "capability lies by omission") | P |
| 2 | `project.create` | project-io `createEmptyProject` / host.createProject | P (adapter in headless host) |
| 3 | `project.open` | project-io `loadProjectFile` (version-checked) / host.openProject | A (fs adapter) |
| 4 | `project.save` | `saveProjectFile` `{version,project}` JSON / host.saveProject | A (fs adapter) |
| 5 | `project.get_state` | `get_editor_state` (counts-first) + revision | P |
| 6 | `media.import` | `importMediaFromUrl` generalized: `{path|url}` → fs/fetch → File → mediabunny metadata | A (~50 LOC) |
| 7 | `media.list` | `list_media` | P |
| 8 | `media.delete` | `media/delete` action | P |
| 9 | `timeline.get` | `list_tracks` + `list_clips` + `get_clip` (paged) | P |
| 10 | `edit.apply` | atomic batch over a **closed op set** (below) via `beginTransaction`→per-op `applyAction`→`commitTransaction`, snapshot rollback on any failure | P (wraps existing) |
| 11 | `history.undo` | ActionHistory group undo scoped to facade-created groups only | A (EditingHost lacks undo — add `undoGroup` passthrough) |
| 12 | `history.redo` | same group machinery | A |
| 13 | `history.list` | `getDisplayHistory()` | P |
| 14 | `preview.render_frame` | `runJob("exportFrame")` → dataURL/PNG bytes | C (today); A once a Node rasterizer exists |
| 15 | `export.start` | `runJob("exportVideo"|"exportAudio")` — returns **job handle immediately** instead of blocking 30 min | C (Chromium harness) or A (external runner) |
| 16 | `job.status` | JobRunner poll (gpu-job-runner pattern already polls) | P |
| 17 | `job.cancel` | new — AbortController propagation (aurora/export sessions show the pattern) | A |
| 18 | `verify.artifact` | ffprobe spawn + frame extract + optional OCR/pixel-diff | A (greenfield, small) |
| 19 | `session.describe` | facade self-description: verb list, contract versions, runtime letters per step (the P/A/C/D/X matrix made programmatic) | P |

### `edit.apply` op set (v0, closed allowlist)

`track.add/remove/rename/reorder/lock/hide/mute/solo`, `clip.add/remove/move/trim/split`,
`text.create/update/remove`, `shape.create/update/remove`, `marker.add/remove/update`,
`transition.add/update/remove`, `effect.add/update/remove/toggle`, `clip.setSpeed`,
`clip.setTransform`, `audio.setVolume/setFade`, `subtitle.add/update/remove`,
`project.rename/updateSettings`.

Deliberately EXCLUDED in v0: `clip/merge`, `clip/slip`, `clip/slide`, `clip/roll`,
`clip/trimToPlayhead` (no inverses — CORE-02 hollow undo), all restore/* types (undo
machinery), `project/create` action (non-invertible), execute_action/batch_actions raw
passthrough (replaced by this verb), motion/* (deferred; `motion/upsertComposition` makes
later wrapping trivial), creation/* (deferred), ai/job tools (surface via export.start/job.*
pattern later).

## Contracts

### 1. Atomic batch (`edit.apply`)
- Facade wraps the op list in ONE host transaction. Snapshot rollback
  (HeadlessHost pattern — structuredClone, proven byte-identical in probe case 11) on ANY
  op failure; result is all-or-nothing. Never use core `executeMany`/`batch_actions`
  semantics (non-atomic, CORE-01).
- Pre-validate ALL ops (run each action's validate against the current snapshot before
  applying the first) to fail fast without side effects; this also kills the silent-no-op
  trap (CORE-08) because validate-rejected ops error the batch.
- Postcondition report: per-op `{ok, actionType, createdIds}` — created entity ids must be
  surfaced explicitly (core never exposes `lastAddedIds`; facade captures by diffing or by
  reading executor state immediately post-op, core-actions.md F3).

### 2. Revision & conflict
- Facade maintains `revision: integer` per open project, incremented on every successful
  mutation batch; exposed in `project.get_state`.
- All mutating verbs accept `expectedRevision`; mismatch → `CONFLICT` error with
  `{currentRevision}` and no side effects. (Core has no revision concept — this is purely
  facade-level optimistic concurrency over a serialized execution lock, e.g. the existing
  `runExclusive` pattern.)
- Rationale: core actions mutate in place with no CAS (state-authority.md); interleaving
  safety comes from serialization + revision preconditions, not from the engine.

### 3. Idempotency
- Every mutating call accepts `idempotencyKey`. Facade keeps a ledger
  `{key → {status, resultDigest, createdIds}}`; replays of a committed key return the
  stored result without re-executing (core mints fresh action ids per call — registry.ts
  genId — so dedupe MUST live in the facade).
- Keys are scoped per project+session; ledger survives transport retries, not process
  restarts in v0 (documented limitation).

### 4. Async jobs
- `export.start` / future ai verbs return `{jobId}` immediately. `job.status` →
  `{state: queued|running|done|error|cancelled, progress?, artifact?}`. `job.cancel`
  propagates an AbortController (pattern exists in export/aurora session code).
- Today `runJob` blocks up to 30 min over MCP (desktop-mcp.md F8) — the facade's job
  surface exists precisely to remove that.

### 5. Errors
Typed error codes, no stringly matching:
`INVALID_PARAMS` (schema/allowlist), `NOT_FOUND`, `CONFLICT` (revision),
`UNSUPPORTED` (runtime lacks capability — report the letter that WOULD be needed),
`CONFIRMATION_REQUIRED` (facade policy gate), `JOB_FAILED`, `ACTION_FAILED`,
`INTERNAL`. Mirrors the registry's existing codes (executor UNKNOWN_TOOL/TOOL_ERROR,
registry INVALID_PARAMS/NOT_FOUND/UNSUPPORTED/JOB_FAILED/ACTION_FAILED) so nothing is
lost in translation.

### 6. Artifact contract
`export.start` success → `artifact: {kind:"video", container:"mp4", codec:"h264",
durationSec, width, height, sizeBytes, sha256, locator}` where locator is a local path
(headless/CLI), file URL (desktop), or manifest URL (cloud runner). `verify.artifact`
returns `{probe: {...ffprobe fields}, visualCheck: {method: ocr|pixel-diff, pass, evidence}}`.
Artifacts are content-hashed so downstream steps can pin them.

### 7. Confirmation policy
Facade keeps the registry triad (readOnly/destructive/expensive) but re-draws the
boundaries (AREA-02 asymmetry: marker/transition/keyframe/effect deletes currently
ungated). Default policy for external agents: destructive ⇒ CONFIRMATION_REQUIRED unless
the session passed an explicit grant; expensive ⇒ confirm once per session. This inverts
the desktop default-on auto-allow for the external surface only.

## Runtime matrix integration

Per-tool dispositions for all 304 registry tools are in `audit/runtime-matrix.csv`
(column `facade_disposition`, generated by `audit/probes/build-runtime-matrix.mjs` from
`audit/facade-overlays.json`): `collapse` (reads), `facade-core*`, `facade-phase2`,
`facade-defer-v1` (motion), `facade-defer-job` (ai), `facade-replace` (raw).
