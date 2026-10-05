# @reelterminal/agent-facade

Pure-Node, in-process, transport-agnostic agent facade over the ReelTerminal
canonical `Project` state, with headless and live sessions and bundled
read-only tool extensions. The desktop CLI and MCP adapter use the same
command catalog.

This example creates a separate headless project; it does not attach to the GUI.
Replace the absolute paths with an existing video at least five seconds long.
Live desktop Agents should use the CLI workflow in the root Agent guide.

```ts
import { createAgentFacade, type FacadeResult } from "@reelterminal/agent-facade";

function must<T>(result: FacadeResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

const facade = createAgentFacade({ mediaRoots: ["/abs/path/to/media"] });

// Single-initialization lifecycle verb: one project per session, ever.
// An exact retry (same idempotencyKey + same payload) replays the creation
// result without resetting anything; any other second create is a CONFLICT.
const created = must(await facade["project.create"]({ name: "Demo", idempotencyKey: "create-demo" }));
const renamed = must(await facade["project.rename"]({
  name: "Dam Letter",
  expectedRevision: created.revision,
  idempotencyKey: "rename-demo",
}));
const imported = must(await facade["media.import"]({
  path: "/abs/path/to/media/input.mp4",
  expectedRevision: renamed.revision,
}));
const mediaId = imported.mediaId;
const firstBatch = must(await facade["edit.apply"]({
  ops: [
    { op: "track.add", trackType: "video", trackId: "v1" },
    { op: "track.add", trackType: "text", trackId: "t1" },
    { op: "clip.add", trackId: "v1", mediaId, startTime: 0, clipId: "c1" },
    { op: "clip.trim", clipId: "c1", inPoint: 0, outPoint: 5 },
    { op: "text.create", trackId: "t1", text: "Hello world", startTime: 0, duration: 5,
      // Normalized 0..1 frame coordinates (0.5/0.5 = center), identical in
      // preview and export. Keep the anchor point inside [0.05, 0.95].
      position: { x: 0.5, y: 0.15 } },
  ],
  expectedRevision: imported.revision,
  idempotencyKey: "batch-1",
}));
const overlayId = firstBatch.applied.find((result) => result.op === "text.create")!.createdIds[0];
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
must(await facade["edit.apply"]({
  ops: [
    { op: "clip.move", clipId: "c1", startTime: 2 },
    { op: "clip.setSpeed", clipId: "c1", speed: 1.5 },
    { op: "clip.setTransform", clipId: "c1", transform: { scale: { x: 0.75, y: 0.75 }, fitMode: "cover" } },
    { op: "clip.duplicate", clipId: "c1" },
    { op: "text.update", overlayId, style: { color: "#ffcc00" }, position: { x: 0.5, y: 0.85 } },
    { op: "clip.setVolume", clipId: "c1", volume: 1.5 },
  ],
  expectedRevision: firstBatch.revision,
  idempotencyKey: "batch-2",
}));
const state = must(await facade["project.get_state"]());
```

## Verbs

The current registry is generated from built-in verbs and bundled plugins.
Discover its actual entries with `getCommandCatalog(mode)`; do not hard-code
a tool count in clients.

Lifecycle commands create, open, save, rename, and read a project. Editing
commands import media and apply typed, atomic batches. Context, history, scoped
queries, preflight validation, media analysis, preview, export, verification,
and job control complete the catalog. Discover exact commands and schemas with
`getCommandCatalog(mode)`.

`visual.inspect` — a read-only sample of 1–12 frames selected
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
  There is no project replace/reset verb.
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
  actually has, per capability, from live provider preflights. The independent
  provider interfaces (`RenderProvider`, `ExportProvider`, and
  `ArtifactVerifier` in `src/providers.ts`) do not imply one another. A capability is
  available only when the facade ships the verb AND the provider's real
  preflight passed; the verb itself re-checks and fails `UNSUPPORTED`
  otherwise.

## Live-mode contract

Live sessions (`createLiveFacade`) implement the same registered verbs against the
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

## Access and protocol-independent commands

Live sessions expose explicit `access` (`read-only` or `write`) and writer-lease
fields. Agents own conversations and context management; ReelTerminal owns the
open project and enforces access and revision checks.

`getCommandCatalog("live")` and `getCommandCatalog("headless")` describe the
canonical verbs, schemas, effects and retry policies, including plugin commands.
The desktop's Command API and reelctl use this catalog; MCP is an explicit
adapter over the same API. See the
[Command API guide](../../docs/COMMAND-API.md).

The new CLI requires recorded project identity, opening epoch and revision for
edit/apply and history control. The legacy MCP adapter keeps the facade's
optional revision semantics described above for compatibility. All transports
still use the same atomic mutation, idempotency and shared undo implementation.

## Preview, export, and verification

The facade stays pure Node; pixel/export/verify backing arrives through the
provider interfaces. The reference implementation is
[`@reelterminal/runtime-chromium`](../runtime-chromium/README.md) (real headless
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
  headless via `REELTERMINAL_AVE_DELIVERY_ROOTS` / `--delivery-root` and in the
  desktop live host from the Agent workspace root; with none configured,
  `destinationPath` fails fast with the reason.
- `export.start` accepts `settings.upscaling {enabled, quality:
  "fast"|"balanced"|"quality"}` for the export-time upscale pass (WebGPU
  Lanczos + edge-directed interpolation — a deterministic local resampler,
  NOT a neural-network upscaler; the same engine as the GUI export dialog).
  It engages only when the export size exceeds the project canvas size AND
  the runtime has WebGPU; when the pass cannot run, the done job reports
  `upscalingRequestedButInactive: true` — the artifact is valid and NOT
  upscaled, never a silent downgrade.
- The stdio MCP transports (including the desktop `reelterminal-live-mcp`
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

Static images are accepted as a third import type: `PNG`, `JPEG`, `GIF`,
and `WebP`. Image files are classified by extension and then validated by
content (magic-number sniffing plus header dimension parsing — the
mediabunny container probe is not used), and report the same metadata
shape as GUI image imports (`duration` 0, no video/audio tracks).
Recognized-but-unsupported image extensions (bmp, tiff, avif, svg, …)
fail with an explicit `Unsupported media:` error naming the supported
formats; image bytes hidden behind a non-image extension fall through to
the container path and are rejected there.

## HTML→PNG rendering (`media.render_html`)

`media.render_html` turns constrained local HTML/CSS into a PNG artifact
under the media roots, so generated markup reaches the timeline through the
ordinary `media.import` path instead of a side channel. Headless and live
sessions share one artifact core (`src/media-render-html.ts`) with identical
containment checks, output-directory convention, temp-then-publish
discipline, and PNG re-inspection.

- Params: `source` is `{"kind":"path","path":…}` (an `.html` file inside a
  configured media root) or `{"kind":"inline","html":…}` (non-empty markup,
  ≤512 KiB UTF-8; file-based documents are read with an 8 MiB ceiling before
  the policy runs); `assetsRoot` (optional) is an absolute directory inside a
  media root that local relative subresources may resolve into — a path
  source defaults it to the source file's own directory, while inline markup
  without one has no local base and can only ever load `data:` URIs;
  `width`/`height` are required even integers in [2, 4096]; `transparent`
  defaults to `true`; `timeoutMs` is an integer in [1000, 120000] with
  default 30000; `outputDir` defaults to
  `<mediaRoots[0]>/jobs/html-render/<requestKey>/` with `requestKey` derived
  content-addressed from the source and parameters, so identical retries
  land on the same published path instead of clobbering it.
- Result: `{path, width, height, sha256, bytes, missingAssets, replayed}`.
  The verified published path is meant for `media.import`.
- Mutation classification: the verb writes a file, so it sits behind the
  mutation/serialization gates and the idempotency ledger (a replay is
  honored only while the artifact file still exists), but it never touches
  project state and does not bump the revision.
- Availability: reported honestly by `capabilities.get`. It requires a
  `RenderProvider` exposing `renderHtmlPng` (with
  `@reelterminal/runtime-chromium`, the local Playwright Chromium — the same
  supply preview uses), a configured media root for the output, and a
  passing render preflight; otherwise the verb fails `UNSUPPORTED`.
- Security boundary: markup crosses the core `html-policy` string gate
  (scripts, iframe/object/embed, base href, meta refresh, srcset, event
  handlers, `javascript:`/`vbscript:`/non-image `data:` URIs, and network
  references are rejected before a browser sees the document), and the
  renderer adds a second layer: JavaScript is disabled at the context
  switch level and a `page.route` wildcard allowlist lets through only the
  entry document, `file://` subresources whose realpath stays inside
  `assetsRoot`, and non-document `data:` URIs — every remote scheme is
  aborted. Fonts are system fonts only; no network font loading. Blocked or
  missing subresources never fail the render: they are aborted and returned
  in `missingAssets` (those references render blank), so a blank region is
  disclosed data, never a silent surprise.
- Output discipline: temp-then-publish with write-side containment, PNG
  magic/IHDR re-inspection of the actual bytes (never the provider's
  self-report), a 16 MiB published-PNG budget, and `sha256` over the
  published file.

## Custom fonts (`font.upload` / `font.list`)

`font.upload` registers a user-level custom font through the same renderer
path the GUI upload button uses (renderer IndexedDB + FontFace activation):
fonts are user state shared with the GUI across projects, not project
state. Exactly one of `filePath` (absolute path inside a configured media
root) or `dataBase64` is required; decoded bytes are capped at 10 MiB and
formats are `ttf`/`otf`/`woff`/`woff2` (magic-number validated, then
FontFace-loaded). A duplicate family name never overwrites and never
fails: the family is deduped with a numeric suffix and the response
reports the ACTUAL `fontFamily`, which callers must use verbatim in text
styling. `font.list` projects the installed families without bytes. Live
sessions require the host's font-library bridge; headless sessions report
`UNSUPPORTED`. `capabilities.get.fonts` carries availability, reason,
formats, and limits.

## Custom presets (`preset.*` verbs)

`preset.list`/`preset.get`/`preset.create`/`preset.update`/`preset.remove`/
`preset.apply` manage the user's saved custom presets — the same records the
GUI's text, effect, transition, and graphics preset panels read and write
(renderer
IndexedDB). Presets are user state shared across projects, not project
state. Live sessions require the host's preset-library bridge; headless
sessions report `UNSUPPORTED`. `capabilities.get.customPresets` carries
availability, reason, kinds, limits, and apply targets.

- Kinds: `text` (whitelisted text-style fields — code-facing fields such as
  the text shader are excluded), `effect` (1–8 clip effects whose types are
  closed to the engine's 22 parametered clip-effect types: `blur`, `shadow`,
  `glow`, `brightness`, `contrast`, `saturation`, `hue-saturation`,
  `color-balance`, `curves`, `motion-blur`, `radial-blur`, `vignette`,
  `film-grain`, `chromatic-aberration`, `grayscale`, `sepia`, `invert`,
  `sharpen`, `grain`, `temperature`, `tint`, `tonal`; audio effects fail
  `UNSUPPORTED_EFFECT_TYPE`, and `chromaKey`/`shader`/`hue` are declined —
  chroma key and shader saves name where those settings actually live, and
  `hue` stays out until its render paths share one parameter contract),
  and `transition` (one of the 24 engine transition
  types with parameter and duration overrides). Unknown payload fields and
  out-of-range values are rejected with a stable code, never clamped or
  silently dropped. A `graphics` kind validates and stores inline SVG
  through the shared SVG gate; applying it expands to the same
  track/svg-create actions a GUI import produces, in the same undoable
  batch as the other targets.
- Payloads are deep-validated in the facade and re-validated by the
  renderer. `preset.create`/`preset.update`/`preset.remove` accept
  `idempotencyKey` (retry replays the committed result);
  `preset.update` CAS-guards the PRESET record's `revision`
  (`expectedRevision`; stale value fails `CONFLICT`).
- `preset.remove` needs no confirmation and is permanent: projects already
  built from a preset keep their parameter copies, because applying a
  preset copies values into the project and nothing references the preset
  record.
- `preset.apply` expands a preset into one undoable core action batch:
  text targets an EXISTING text clip (`mode:"updateStyle"` — create the
  clip with `edit.apply text.create` first), effect targets explicit
  `clipIds`, transition targets a cut (`clipAId`, optional `clipBId`
  for the in-point edge; omitting `clipBId` applies at the out-point
  edge), and graphics targets a graphics track (optional `trackId` —
  one is created when none exists — plus optional `startTime` and
  `durationSec`, default 5 s). Placement rules are hard rejections, never clamped: a duration
  over the cut's placement cap fails `INVALID_PARAMS` with
  `details.reason` (`PLACEMENT_INVALID`) instead of being shortened — the
  GUI panels pre-clamp with a warning, the Agent side does not. The
  project's `expectedRevision` is CAS-guarded, an omitted value is guarded
  with the current revision, and retries replay through a per-project
  ledger instead of applying twice.
- Visibility is immediate in both directions: a GUI save shows up in the
  next `preset.list`, and an Agent create appears in the open panels
  without polling — one renderer service is the only writer behind both.

## The shipped GUI manual (`help.*` verbs)

`help.list_screens`/`help.describe`/`help.search` serve a GUI manual that
ships with this package as static, hand-maintained data (`src/gui-manual.ts`):
18 curated screen guides, each bilingual (`zh`/`en`), covering how to reach
a screen, when it is visible, the common steps inside it, its
keyboard-shortcut references, and its honest limitations. The manual exists
so an Agent can answer GUI how-to questions WITHOUT reading product source.
All three verbs are read-only and answer from the static module with no
project, provider, or renderer bridge — headless and live sessions (even
read-only ones) expose the identical content, and `capabilities.get.manual`
reports `contentVersion`, `appVersion`, `languages`, `screenCount`, and the
screenshot delivery state.

- `help.list_screens` takes no parameters (closed empty schema) and returns
  the restrained index: `{manual, total, screens}` where each screen is
  `{id, title, summary, hasScreenshot}` — one line per screen, never full
  page bodies.
- `help.describe({screenId})` returns one screen page `{manual,
  screenshotStatus, screen}`: the ordered `entry` path, optional
  `visibility`, `steps`, `shortcutIds`, `limitations`, and search
  `keywords`. `shortcutIds` reference the shared shortcut registry by
  stable id only — key bindings are user-remappable state, so the manual
  deliberately never copies them and the GUI's Settings → Shortcuts panel
  remains the live truth. An unknown `screenId` fails `INVALID_PARAMS` with
  a message that points back at `help.list_screens`.
- `help.search({query})` matches one zh/en keyword (1..100 characters after
  trim, case-insensitive) over titles, summaries, entries, steps,
  limitations, shortcut ids, and keywords, returning `{manual, query, total,
  hits}` with at most 20 hits of `{id, title, summary}` — never full pages.
- The manual's `contentVersion` is mirrored to the documented application
  version (`appVersion`, from the desktop package) and the equality is
  test-enforced, so the answer to "what does THIS build's GUI do" is
  version-bound data, not source reading. FACADE_VERSION remains the facade
  protocol version; the manual binds to the app.
- `screenshot` is delivered where it exists: six of the 18 screens carry a
  real capture, `capabilities.get.manual.screenshots` reports `delivered`,
  and each `help.describe` answer reports `screenshotStatus:"available"`
  with the screenshot data or `"pending"` — no screen ever describes a
  screenshot that does not exist.

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
- `media.analyze_start` supports the built-in `technicalQuality` probe
  (mediabunny + file stat), `audioSummary` (local FFmpeg/ffprobe after a
  real preflight), and the dedicated `silence` and `beatGrid` types:
  `silence` runs the core `detectSilenceRangesInPcm` kernel with the GUI
  silence-cut panel's defaults (−40 dBFS threshold, 0.5 s minimum duration,
  0.1 s padding, tunable via `silenceParams`), and `beatGrid` runs the core
  beat-detection engine (`bpm`/`confidence`/`beats`; downbeats are not
  available — no downbeat detector is installed). `audioSummary`'s
  silence/bpm fields come from the same kernels. `videoReview` is the
  opt-in cloud opinion: it needs media roots, `artifactRoot`, local FFmpeg,
  and the user's own provider credential, and fails before any request
  without them. The remaining declared
  types are individually unavailable in `capabilities.get`; they fail
  `UNSUPPORTED` before job creation.
- New closed edit ops with Core/GUI/renderer parity are `track.update`
  (name/lock/hide/mute/solo), `subtitle.importSrt` (256 KiB/500 cues),
  `clip.setColorGrade` (temperature/tint), `clip.setKeyframes` (renderer-
  supported transform/opacity properties), `clip.applyReframe` (apply an
  Auto Reframe crop plan to one clip: 1–100 source-space crop rectangles
  whose keyframe times the shared core conversion folds onto the clip-local
  keyframe clock by `clip.speed`, with the project canvas retargeted in the
  same atomic batch — one undo unit; each crop's aspect ratio must match the
  output canvas ratio within ±2% relative drift or the op fails
  `INVALID_PARAMS`; subject detection is not part of the op — the GUI
  panel's local skin-region color heuristic (not ML) or the agent's own
  frame inspection supplies the plan, and hand-written plans must guarantee
  the ratio themselves), `media.rename` (media display-
  name rename, ≤120 characters; the source filename and the file on disk are
  never touched), `clip.setChromaKey` (fixed-key chroma keyer for
  green-screen removal: key color, tolerance, edge softness, spill
  suppression; a deterministic local algorithm, not AI matting),
  `clip.setNoiseReduction` (local noise-reduction DSP with the GUI panel's
  presets and parameters; an existing effect is updated in place, never
  stacked, and learned profiles are preserved; not AI or model inference),
  `clip.setDucking` (audio ducking on one clip: the GUI ducking panel's
  threshold/reduction/attack/release/holdTime tuning plus exactly one
  keyframe source — pre-computed `points` or `presenceRanges` that the
  same core kernel the GUI panel uses synthesizes into volume keyframes;
  the keyframes persist in `clip.automation.volume` for preview and export
  as one undo unit, an empty synthesis fails `INVALID_PARAMS`, and trigger
  selection is RMS envelope analysis, not AI),
  `clip.setBackgroundRemoval` (AI background removal on one clip: required
  `enabled` plus the GUI Background Removal panel's `mode`
  (`blur`/`color`/`image`/`video`/`transparent`), `blurAmount` (0..50 px),
  `backgroundColor` (hex), `backgroundImageUrl`/`backgroundVideoUrl`
  (≤2048 chars), `edgeBlur` (0..10 px), and `threshold` (0..1); omitted
  tuning fields merge onto the clip's prior settings, disabling keeps them,
  and the persisted `clip.backgroundRemoval` field is one undoable action
  shared with the GUI panel. Rendering needs MediaPipe person segmentation
  inside the desktop-GUI Chromium runtime (the model downloads on first GUI
  use and is cached); the op persists the setting, but headless-rendered
  frames keep the original background — verify through the desktop GUI),
  and `svg.create`/`svg.update`/`svg.remove` (self-contained inline SVG on
  graphics tracks — the shared core ingest gate rejects scripts, foreign
  objects, event handlers, unsafe URL schemes, external references, and
  documents over 2 MiB or 10,000 elements), `workAsset.capture` (snapshot
  one timeline clip — or a 2..64-clip selection via `clipIds`, saved as
  ONE `kind:"multi"` asset with a relative member layout where any
  failing member rejects the whole set with a per-member list — into a
  project-scoped reusable work asset; read assets
  back via `timeline.query` workAsset entities — capture reports no
  createdIds), `workAsset.rename`/`workAsset.delete` (by `workAssetId`;
  deletion never touches placed instances or project media), and
  `workAsset.instantiate` (place a fresh independent clip — or, for a
  multi asset, restore the whole relative layout all-or-nothing: missing
  member media fails with the full missing list, `trackId` binds the
  anchor lane only and every other lane is fresh, members land by
  relative time and lane relations — optional
  existing same-type `trackId` (`CONFLICT` on mismatch) or a new
  same-type track, optional `startTime` defaulting to the timeline end;
  a missing source media fails `NOT_FOUND`, distinguishable from the
  unknown-id case only by the message text). `clip.addVideoEffect` appends
  one effect to a clip's video effect stack — `effectType` is closed to the
  GUI effect-stack type list (`CLIP_VIDEO_EFFECT_TYPES`, 21 types including
  `chromaKey` and `shader`, each with its own closed parameter contract;
  `shader` takes a builtin `shaderId` plus that shader's parameters), with
  optional per-type closed
  `params` and a deterministic `effectId` for same-batch references. It is
  the same core `effect/add` action as the GUI effect panel — an effect
  with the given parameters, never image analysis: the GUI's "Auto-Color"
  is a fixed three-op preset (`saturation 1.15` + `contrast 1.1` +
  `brightness 5`), not frame-adapted AI. Capability data names the
  remaining professional gaps instead of exposing no-op
  schemas.

## Responsibility boundaries

The facade contains no transport, cloud GPU, or OCR. The desktop supplies the
Command API and CLI/MCP adapters. The facade owns command and state semantics, but contains
no Chromium/Playwright/ffmpeg code — that lives in the runtime package.
Text overlays are canonical model state (`project.textClips` on a
`type:"text"` track); pixel output is available only when a render provider
passes the session preflight.

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
analysis covers `technicalQuality`, `audioSummary`, `silence`, and
`beatGrid` locally, plus the opt-in cloud `videoReview` when the user's own
provider credential is configured — the remaining declared types report
unavailable.
