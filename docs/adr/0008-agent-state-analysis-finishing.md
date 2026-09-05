# ADR 0008: Bounded Agent State, Canonical History, and Honest Analysis

- Status: Accepted
- Date: 2026-09-05
- Contract: `facade-slice-6` / 24 facade verbs
- Related: ADR 0003 (transport/schema), ADR 0004 (live canonical store), ADR
  0007 (visual-state context)

## Context

The facade could mutate the shared project safely, but recovery after a long
turn still required broad state reads, validation required attempting an edit,
and the Agent could not inspect/control the GUI's canonical history. Media
understanding also had no asynchronous contract, which tempted either blocking
tools or schema-only capability claims.

## Decisions

### 1. Five bounded state/history verbs

`project.changes`, `timeline.query`, `edit.validate`, `history.get`, and
`history.control` are facade verbs and map 1:1 to MCP tools. Reads have strict
limits and opaque cursors.

- `project.changes` retains 256 in-memory revision batches and pages at most
  200 entity-field changes. The renderer observes every canonical project
  replacement, so manual GUI edits, Agent batches, undo, and redo share one
  journal. Because Core mutates a draft before Zustand publishes its new
  reference, the observer keeps a detached prior snapshot; diffing Zustand's
  shallow `prevState` would miss nested GUI changes. Missing/evicted bases
  return `requiresFullRefresh:true`.
- `timeline.query` filters the local timeline by `@A<n>`/`R<n>` refs, explicit
  entity ids, range, tracks/types, and an allowlisted field projection. Limit
  is at most 200 and neighbor expansion at most two. Bare `#N` is invalid.
- `edit.validate` uses the same op declarations, sanitizers, translator, and
  Core executor as `edit.apply`, but always against a discarded clone. It
  returns normalized ops, conflicts/warnings, affected/created/deleted
  entities, and estimated duration/revision.
- Live `history.get` reads bounded summaries from the GUI/Core history stacks.
  `history.control` calls the normal GUI `undo`/`redo` path behind the writer
  gate, revision CAS, serialized facade lane, and a renderer-side idempotency
  ledger that closes the main↔renderer timeout/retry window. Headless reports
  history unavailable and never guesses inverse operations.

### 2. One asynchronous media-analysis verb

`media.analyze_start` starts a generalized `kind:"analysis"` job. `job.status`
and `job.cancel` now handle both export and analysis jobs; workflow `await`
accepts either job-start verb. Large future results must be artifact refs.

The only built-in available analysis type is `technicalQuality`, implemented by
revalidating the selected imported media path and running the real mediabunny
probe plus a current file fingerprint. `sceneCuts`, `silence`,
`speechTranscript`, `loudness`, `blackFrames`, `duplicateFrames`, `motion`, and
`faces` remain individually unavailable in `capabilities.get`; requesting any
unavailable type fails `UNSUPPORTED` before job creation.

### 3. Closed finishing ops only where parity already exists

The tool count does not grow for editing buttons. `edit.apply` gains four
closed ops that translate to existing Core actions used by the GUI and already
consumed by preview/export:

- `track.update`: name, lock, hidden, muted, and solo;
- `subtitle.importSrt`: strict inline SRT, at most 256 KiB / 500 cues, committed
  through the canonical subtitle model;
- `clip.setColorGrade`: temperature/tint or clear;
- `clip.setKeyframes`: at most 100 clip-local transform/opacity keyframes for
  the property names the shared compositor actually evaluates.

Capability data explicitly marks volume keyframes, bounded LUT import, audio
normalization/ducking/vocal isolation, stabilization, smart reframe, proxy
media, relink, export preset enumeration, and project-specific export preflight
unavailable. Existing adjacent GUI helpers are not sufficient: each needs a
canonical Core action or provider plus preview/export parity before exposure.

## Consequences

- The facade contract grows from 18 to 24 verbs without exposing the legacy
  registry or arbitrary action dispatch.
- All schema emission, runtime validation, stdio transport, desktop loopback,
  and workflow surfaces continue to derive from the facade declarations.
- Journals, idempotency ledgers, and jobs remain session-local and are not
  checkpointed. A project switch or journal gap requires a full refresh.
- Context compaction remains exclusively triggered by an external exact
  `/compact` input; this ADR adds no threshold, timer, or automatic policy.
