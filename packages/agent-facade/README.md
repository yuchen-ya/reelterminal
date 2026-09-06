# @openreel/agent-facade

Pure-Node, in-process, transport-agnostic agent facade over the ReelTerminal
canonical `Project` state, with headless and live sessions and bundled
read-only tool extensions. Original design: `audit/facade-v0.md`,
`docs/adr/0001-headless-facade-slice-1.md`,
`docs/adr/0002-chromium-runtime-slice-1b.md`.

```ts
import { createAgentFacade } from "@openreel/agent-facade";

const facade = createAgentFacade({ mediaRoots: ["/abs/path/to/media"] });

// Single-initialization lifecycle verb: one project per session, ever.
// An exact retry (same idempotencyKey + same payload) replays the creation
// result without resetting anything; any other second create is a CONFLICT.
await facade["project.create"]({ name: "Demo", idempotencyKey: "create-demo" });
await facade["project.rename"]({
  name: "Dam Letter",
  expectedRevision: 0,
  idempotencyKey: "rename-demo",
});
await facade["media.import"]({ path: "/abs/path/to/media/input.mp4" });
await facade["edit.apply"]({
  ops: [
    { op: "track.add", trackType: "video", trackId: "v1" },
    { op: "clip.add", trackId: "v1", mediaId, startTime: 0, clipId: "c1" },
    { op: "clip.trim", clipId: "c1", inPoint: 0, outPoint: 5 },
    { op: "text.create", text: "Hello world", startTime: 0, duration: 5,
      // Normalized 0..1 frame coordinates (0.5/0.5 = center), identical in
      // preview and export. Keep the anchor point inside [0.05, 0.95].
      position: { x: 0.5, y: 0.15 } },
  ],
  expectedRevision: 1,
  idempotencyKey: "batch-1",
});
// Later batches: track.remove (empty tracks only), media.remove (unreferenced
// media only), clip.move, clip.split, clip.duplicate, clip.rippleDelete,
// clip.setSpeed, clip.setReverse, clip.setTransform, clip.setFade,
// transition.add/update/remove, marker.add (stable-numbered project markers:
// asset/clip/text/timeRange targets, metadata only — never rendered),
// marker.remove (by number),
// text.update (style/position MERGE — omitted keys keep their values),
// text.delete, clip.setVolume (linear gain 0..4; 0 = mute, 1 = unity) —
// ids come from timeline.get/project.get_state. track.remove rejects a track
// that still has clips, overlays, or transitions; media.remove rejects media
// still referenced by any timeline clip.
await facade["edit.apply"]({
  ops: [
    { op: "clip.move", clipId: "c1", startTime: 2 },
    { op: "clip.setSpeed", clipId: "c1", speed: 1.5 },
    { op: "clip.setTransform", clipId: "c1", transform: { scale: { x: 0.75, y: 0.75 }, fitMode: "cover" } },
    { op: "clip.duplicate", clipId: "c1" },
    { op: "text.update", overlayId, style: { color: "#ffcc00" }, position: { x: 0.5, y: 0.85 } },
    { op: "clip.setVolume", clipId: "c1", volume: 1.5 },
  ],
  idempotencyKey: "batch-2",
});
const state = await facade["project.get_state"]();
```

## Verbs

The current registry exposes **26 tools: 24 built-in verbs plus the two
bundled plugin tools** (`media_import_preflight`, `media.inspect`).
`FACADE_VERBS` in `src/types.ts` and `BUNDLED_PLUGINS` in `src/plugins/index.ts`
are the catalog source of truth. MCP maps dots to underscores.

Slice 1: `session.describe` · `capabilities.get` · `project.create` ·
`project.rename` · `project.get_state` · `media.import` · `timeline.get` ·
`edit.apply`

Slice 1b: `preview.render_frame` · `export.start` · `job.status` ·
`job.cancel` · `verify.artifact`

Slice 2a: `project.open` · `project.save`

Slice 3 (ADR 0004): `editor.get_context` — the live/headless-honest
editor-context read. `editor.control` adds ephemeral live playback and
selection/reveal controls.

Slice 6: `project.changes` · `timeline.query` · `edit.validate` ·
`history.get` · `history.control` add bounded delta recovery, scoped reads,
side-effect-free preflight, and canonical live undo/redo. `media.analyze_start`
adds asynchronous media analysis over the generalized `job.status`/
`job.cancel` path. Live and headless sessions implement the same 26-tool
contract over a `LiveProjectStore` seam with no live project copy; headless
history control reports `UNSUPPORTED` because it has no GUI/Core history stack.

Visual slice: `visual.inspect` — a read-only sample of 1–12 frames selected
by exactly one of `clipId` (a timeline clip id from `timeline.get`) or an
explicit `timeRange` of the shape `{"startSec": <number ≥ 0>, "endSec":
<number > startSec>}` in timeline seconds. Each frame is a real
provider-rendered artifact (lossless PNG, or a JPEG re-encode when the
`maxFrameBytes` budget — default 1.5 MiB — would be exceeded) with `timeSec`,
a deterministic label, the source revision, and a per-frame `fidelity` record
(source vs delivered raster, format, budget outcome; see `frame-budget.ts`).
The default runtime provider is Chromium. Runtimes with contact-sheet support also return one real PNG contact-sheet
artifact; otherwise `limitations` explains why individual frame artifacts are
the honest fallback. Raster cells are bounded to 1024×1024, with bounded
pixel and byte budgets. The raster defaults to 640 px wide (or the
project width when smaller) with the project aspect preserved, even-rounded;
explicit `width`/`height` must be even integers in [2, 1024]. Frames, cells,
and `preview.render_frame` output all share one compositor and one coordinate
system: layers keep their project-relative geometry at any raster size.

All verbs return `FacadeResult<T>` (`{ ok: true, value } | { ok: false,
error }`) with typed error codes (`INVALID_PARAMS`, `NOT_FOUND`, `CONFLICT`,
`UNSUPPORTED`, `CONFIRMATION_REQUIRED`, `JOB_FAILED`, `ACTION_FAILED`,
`INTERNAL`, `FORBIDDEN`) — never throw for domain errors, never silently
no-op with `ok: true`.

## Guarantees

- **Single-initialization lifecycle**: `project.create` opens the session's
  one project. It lives outside the revision machinery (no
  `expectedRevision`); an exact idempotent retry replays the committed
  creation result with `replayed: true` and does NOT reset the project,
  while any other create attempted with a project open fails `CONFLICT`.
  Slice 1 has no replace/reset verb.
- **Atomic batches**: every mutation is a snapshot transaction over a
  `structuredClone`d draft; any failure discards the draft and the original
  project is byte-exact untouched. One committed call bumps `revision`
  exactly once.
- **Serialized execution**: built-in session verbs run through one execution lane;
  `expectedRevision` gives optimistic concurrency (`CONFLICT` on mismatch).
  Bundled read-only inspection takes a detached snapshot, then renders outside
  that lane with a unique artifact directory per call.
- **Idempotency**: `idempotencyKey` replays return the stored committed
  result without re-executing (scoped per session+project+verb; reusing a
  key with a different payload fails `CONFLICT`; not restart-durable).
- **Strict params**: closed schemas only — unknown fields, wrong field
  names and unsupported ops fail with zero side effects. Project settings
  are hardened (`width`/`height`/`sampleRate`/`channels` positive integers,
  `frameRate` a positive finite number) and only the schema-sanitized
  copies of `settings`/`style` ever reach the project.
- **High-level text intent**: `text.create` uses the first existing text track;
  when none exists it creates the text track in the same atomic batch and undo
  unit. Its `applied` entry reports `[textTrackId, overlayId]` in that case;
  otherwise it reports `[overlayId]`. Read `applied[i].createdIds` by op —
  there is no guessed `results[].clipId` field.
- **Honest capabilities**: `capabilities.get` reports what this runtime
  actually has, per capability, from live provider preflights. The three
  Slice-1b provider interfaces are independent (`RenderProvider`,
  `ExportProvider`, `ArtifactVerifier` in `src/providers.ts`): injecting one
  never flips another's capability, and the dormant Slice-1
  `ProjectRenderAdapter` seam flips nothing at all. A capability is
  available only when the facade ships the verb AND the provider's real
  preflight passed; the verb itself re-checks and fails `UNSUPPORTED`
  otherwise.

## Live-mode contract differences (ADR 0004)

Live sessions (`createLiveFacade`) implement the same 25 verbs against the
open GUI project. Where a verb's behavior must differ by mode, the contract
states it up front instead of letting integrators discover it at runtime:

- `project.create` / `project.open` are unavailable live (the GUI owns the
  project lifecycle) and fail honestly.
- `project.save` takes NO params live — it flushes the GUI's
  autosave/recovery snapshot and reports the current revision; it does not
  write a `.openreel` checkpoint. Live transports advertise a closed empty
  param object for it (`LIVE_VERB_INPUT_SCHEMA_OVERRIDES`); the headless
  `{path, expectedRevision?, overwrite?}` checkpoint schema is headless-only.
- `clip.add` with an explicit `clipId` is honored headless (post-execution
  id override inside the draft transaction) but rejected `INVALID_PARAMS`
  live: the canonical store mints clip ids and there is no draft to rename
  in. Omit `clipId` live and read `applied[i].createdIds` instead.
- `verify.artifact` compare `referencePath` resolves inside `artifactRoot`
  or `mediaRoots` headless; a live session has no `mediaRoots`, so live
  references must live inside `artifactRoot`.
- Live `edit.apply` guards an omitted `expectedRevision` with the revision
  of the snapshot the ops were translated against (unconditional CAS), so a
  human edit landing between read and apply fails `CONFLICT`.

## Agent work mode and authorization are separate

`session.describe` and `editor.get_context` return `workMode` plus an explicit
`workModeSemantics` object in both live and headless sessions. The values are
`guided`, `collaborative` (default), and `autonomous`. They describe default
initiative and alignment density only; they are deliberately not a workflow
state machine and may change at any time.

Live sessions report the independent `access` field (`read-only` or `write`) and
the writer-lease fields. The verb gate reads `access`, never `workMode`, so
selecting Autonomous cannot grant a write verb and selecting Guided cannot
remove an existing authorization. Legacy combined values migrate as follows:
`observe` → Guided + read-only, `assist` → Collaborative + write, and
`autonomous` → Autonomous + write. This preserves the old read-only boundary.
Headless sessions expose the same work-mode fields and default to Collaborative;
they omit the live-only access/writer fields.

The optional external-conversation attachment carries this same context in
`initialize`, `session/resume`, every `session/prompt`, and the namespaced
`openreel/work_mode` change notification. ReelTerminal still retains no model,
provider credential, inference loop, or long-term conversation history.

## Slice 1b: preview / export / verify

The facade stays pure Node; pixel/export/verify backing arrives through the
provider interfaces. The reference implementation is
[`@openreel/runtime-chromium`](../runtime-chromium/README.md) (real headless
Chromium + system ffmpeg). Semantics owned by the facade itself:

- `preview.render_frame({timeSec, width?, height?, expectedRevision?,
  idempotencyKey?})` renders one PNG at the current revision into
  `artifactRoot` and returns `{revision, artifact:{kind, format, path,
  sizeBytes, sha256, sourceRevision}, ...}`. The raster defaults to the
  project's own `settings.width × settings.height`; explicit `width`/`height`
  must be even integers in [2, 8192]. The same compositor renders exports,
  previews, and `visual.inspect` frames, so a smaller raster is a true
  scaled render of the same frame (layers keep project-relative geometry),
  not a re-layout.
- `export.start({settings?, destinationPath?, expectedRevision?,
  idempotencyKey?})` deep-clones
  the project synchronously (the snapshot's revision is `sourceRevision`),
  registers a job, and returns `{jobId, state:"queued"}` immediately. The
  project stays editable; the job never sees later edits. Same
  idempotencyKey+payload replays the same `jobId`.
- `destinationPath` (optional) delivers a COPY of the verified artifact into
  the Agent workspace: it must be an absolute, not-yet-existing `.mp4` path
  directly inside `<deliveryRoot>/jobs/<slug>/output/` (see
  `capabilities_get.mediaImport.workspaceLayout` and
  `capabilities_get.export.details.deliveryRoots`). Validation runs before
  the job exists (bad paths fail `INVALID_PARAMS`; an existing destination
  fails `CONFLICT` — delivery never overwrites), and the copy itself is
  atomic-excl. `job.status` reports the outcome as `deliveredTo` /
  `deliveryError`; a delivery failure never downgrades the done job or hides
  its artifact. Delivery roots are session config (`deliveryRoots`), wired
  headless via `OPENREEL_AVE_DELIVERY_ROOTS` / `--delivery-root` and in the
  desktop live host from the Agent workspace root; with none configured,
  `destinationPath` fails fast with the reason.
- The stdio MCP transports (including the desktop `openreel-live-mcp`
  connector) accept `_meta.progressToken` on `export.start` and emit opt-in
  `notifications/progress` updates while the job is running. Direct callers of
  the desktop loopback HTTP endpoint have no server-push channel and should
  keep the documented `job.status` polling flow.
- `job.status` / `job.cancel` expose `queued|running|done|error|cancelled`
  with progress, artifact (done only) and error (error only). A failed or
  cancelled job never carries an artifact and the runtime never leaves a
  success-looking file behind (exports write `.part` and rename on success).
- `verify.artifact({path, expect?, compare?})` probes container/codec/
  geometry/duration/frame count (ffprobe) and optionally pixel-compares a
  frame against a reference image/video, with containment enforced
  (`path` inside `artifactRoot`, or a delivered copy at its exact
  `deliveredTo` location inside `<deliveryRoot>/jobs/<slug>/output/`;
  `referencePath` inside `artifactRoot` or `mediaRoots`). Failed
  expectations are data (`checks[].pass`), not errors.
  Duration expectations should tolerate AAC packaging: the audio stream is
  packed into 1024-sample AAC frames (~21 ms at 48 kHz) plus encoder
  priming, so the MP4 container duration can exceed the video stream by up
  to ~0.1 s (a 30.00 s / 900-frame export reports ≈30.08 s). That is
  expected muxing behavior, not a render defect — assert on
  `probe.frameCount` and a duration tolerance, as the E2E does.
- Output containment is enforced on the WRITE side too: `renders/`,
  `exports/` and per-job directories must be real directories (never
  symlinks/junctions) inside `artifactRoot` before a provider may write, and
  the written artifact's realpath is re-validated afterwards — an escaped
  file is removed and the verb fails, so zero bytes land outside.

## Media import

`media.import` reads local files inside the configured `mediaRoots` only
(realpath containment, `..`/prefix escapes rejected, URLs rejected) and
extracts real metadata (duration, width, height, media type) via mediabunny.
Probing streams from disk through mediabunny's `FilePathSource` with an
explicitly disposed `Input` — the file is never read into memory in full,
and `fileSize` comes from `stat`.

Live sessions use the same path and metadata validation, then delegate the
canonical media-library insertion through `LiveProjectStore.importMedia`.
The live host must provide absolute `mediaRoots` and implement that JSON-safe
bridge; its revision CAS and one undo group are part of the seam contract.
The facade does not send browser `File`/`Blob` objects across the bridge.

## Bounded state, analysis, and finishing additions

- `project.changes` retains 256 revision batches and returns at most 200
  entity-field changes per page. A missing/evicted base is explicit via
  `requiresFullRefresh:true`; the renderer journal observes every canonical
  project replacement, including human GUI edits and Agent commits.
- `timeline.query` filters by `@A<n>`/`R<n>` refs, ids, time, tracks/entity
  types, and allowlisted fields. Limits, cursors, and neighbor expansion are
  hard bounded; bare `#N` references are invalid.
- `edit.validate` validates and executes the exact `edit.apply` op translator
  against a discarded project clone, returning conflicts, warnings, entity
  impact, and estimated revision/duration without touching project/history.
- Live `history.get`/`history.control` delegate to the GUI's canonical history
  and preserve writer gate, revision CAS, renderer-side timeout replay, and
  one project revision per undo/redo. Headless never guesses inverse ops.
- `media.analyze_start` currently supports only the real built-in
  `technicalQuality` probe (mediabunny + file stat). The other declared types
  are individually unavailable in `capabilities.get`; they fail
  `UNSUPPORTED` before job creation.
- New closed edit ops with Core/GUI/renderer parity are `track.update`
  (name/lock/hide/mute/solo), `subtitle.importSrt` (256 KiB/500 cues),
  `clip.setColorGrade` (temperature/tint), and `clip.setKeyframes` (renderer-
  supported transform/opacity properties). Capability data names the remaining
  professional gaps instead of exposing no-op schemas.

## Slice boundaries (what this is NOT)

No MCP/CLI transport, no cloud GPU, no project replace/reset, no OCR. The
facade ships the Slice-1b verbs and owns their state semantics, but contains
no Chromium/Playwright/ffmpeg code — that lives in the runtime package.
Text overlays are canonical model state (`project.textClips` on a
`type:"text"` track); pixel claims exist only when a render provider passed
its live preflight in the session. The Slice-1 `ProjectRenderAdapter` seam
(`src/render/adapter.ts`) remains permanently dormant: no verb consumes it.

## Invariants

See [`./docs/project-invariants.md`](docs/project-invariants.md)
(evidence-backed MUST/MUST-NOT list the facade implements against: canonical
TextClip shape, MEDIA-04 trim split, blob-free MediaItems, duration
recomputation, facade-owned idempotency). Paths above starting with `audit/`
or `docs/adr/` are repo-root-relative; this one lives inside the package.

## Tests

`corepack pnpm test:run` — state-level E2E plus adversarial suites
(atomicity byte-restore, revision conflicts, idempotent replays, strict
params, media-root containment, capability truthfulness).

## Bundled tool extensions

See [Tool plugins](docs/tool-plugins.md) for the trusted startup registry and
`media_inspect`, which samples original video source ranges without editing the
timeline. Its capability is reported under `pluginTools["media.inspect"]`.
Both `media.inspect` and `visual.inspect` can present verified frame evidence in
the desktop inspection panel (lossless PNG, or budget-fitted JPEG with
`fidelity` disclosure). Neither sparse-frame tool evaluates continuous
motion, audio, semantic scenes, or editing rhythm; the built-in asynchronous
analysis provider currently supports only `technicalQuality`.
