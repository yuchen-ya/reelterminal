# @openreel/agent-facade

Pure-Node, in-process, transport-agnostic agent facade over the OpenReel
canonical `Project` state (Slice 1 + Slice 1b). Design: `audit/facade-v0.md`,
`docs/adr/0001-headless-facade-slice-1.md`,
`docs/adr/0002-chromium-runtime-slice-1b.md`.

```ts
import { createAgentFacade } from "@openreel/agent-facade";

const facade = createAgentFacade({ mediaRoots: ["/abs/path/to/media"] });

// Single-initialization lifecycle verb: one project per session, ever.
// An exact retry (same idempotencyKey + same payload) replays the creation
// result without resetting anything; any other second create is a CONFLICT.
await facade["project.create"]({ name: "Demo", idempotencyKey: "create-demo" });
await facade["media.import"]({ path: "/abs/path/to/media/input.mp4" });
await facade["edit.apply"]({
  ops: [
    { op: "track.add", trackType: "video", trackId: "v1" },
    { op: "clip.add", trackId: "v1", mediaId, startTime: 0, clipId: "c1" },
    { op: "clip.trim", clipId: "c1", inPoint: 0, outPoint: 5 },
    { op: "track.add", trackType: "text", trackId: "t1" },
    { op: "text.create", trackId: "t1", text: "Hello world", startTime: 0, duration: 5,
      // Normalized 0..1 frame coordinates (0.5/0.5 = center), identical in
      // preview and export. Keep the anchor point inside [0.05, 0.95].
      position: { x: 0.5, y: 0.15 } },
  ],
  expectedRevision: 1,
  idempotencyKey: "batch-1",
});
// Later batches: text.update (style/position MERGE — omitted keys keep their
// values), text.delete, clip.setVolume (linear gain 0..4; 0 = mute, 1 =
// unity) — overlay ids come from timeline.get textOverlays[].id.
await facade["edit.apply"]({
  ops: [
    { op: "text.update", overlayId, style: { color: "#ffcc00" }, position: { x: 0.5, y: 0.85 } },
    { op: "clip.setVolume", clipId: "c1", volume: 1.5 },
  ],
  idempotencyKey: "batch-2",
});
const state = await facade["project.get_state"]();
```

## Verbs

Slice 1: `session.describe` · `capabilities.get` · `project.create` ·
`project.get_state` · `media.import` · `timeline.get` · `edit.apply`

Slice 1b: `preview.render_frame` · `export.start` · `job.status` ·
`job.cancel` · `verify.artifact`

All verbs return `FacadeResult<T>` (`{ ok: true, value } | { ok: false,
error }`) with typed error codes (`INVALID_PARAMS`, `NOT_FOUND`, `CONFLICT`,
`UNSUPPORTED`, `CONFIRMATION_REQUIRED`, `JOB_FAILED`, `ACTION_FAILED`,
`INTERNAL`) — never throw for domain errors, never silently no-op with
`ok: true`.

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
- **Serialized execution**: all verbs run through one execution lane;
  `expectedRevision` gives optimistic concurrency (`CONFLICT` on mismatch).
- **Idempotency**: `idempotencyKey` replays return the stored committed
  result without re-executing (scoped per session+project+verb; reusing a
  key with a different payload fails `CONFLICT`; not restart-durable).
- **Strict params**: closed schemas only — unknown fields, wrong field
  names and unsupported ops fail with zero side effects. Project settings
  are hardened (`width`/`height`/`sampleRate`/`channels` positive integers,
  `frameRate` a positive finite number) and only the schema-sanitized
  copies of `settings`/`style` ever reach the project.
- **Honest capabilities**: `capabilities.get` reports what this runtime
  actually has, per capability, from live provider preflights. The three
  Slice-1b provider interfaces are independent (`RenderProvider`,
  `ExportProvider`, `ArtifactVerifier` in `src/providers.ts`): injecting one
  never flips another's capability, and the dormant Slice-1
  `ProjectRenderAdapter` seam flips nothing at all. A capability is
  available only when the facade ships the verb AND the provider's real
  preflight passed; the verb itself re-checks and fails `UNSUPPORTED`
  otherwise.

## Slice 1b: preview / export / verify

The facade stays pure Node; pixel/export/verify backing arrives through the
provider interfaces. The reference implementation is
[`@openreel/runtime-chromium`](../runtime-chromium/README.md) (real headless
Chromium + system ffmpeg). Semantics owned by the facade itself:

- `preview.render_frame({timeSec, width?, height?, expectedRevision?,
  idempotencyKey?})` renders one PNG at the current revision into
  `artifactRoot` and returns `{revision, artifact:{kind, format, path,
  sizeBytes, sha256, sourceRevision}, ...}`.
- `export.start({settings?, expectedRevision?, idempotencyKey?})` deep-clones
  the project synchronously (the snapshot's revision is `sourceRevision`),
  registers a job, and returns `{jobId, state:"queued"}` immediately. The
  project stays editable; the job never sees later edits. Same
  idempotencyKey+payload replays the same `jobId`.
- `job.status` / `job.cancel` expose `queued|running|done|error|cancelled`
  with progress, artifact (done only) and error (error only). A failed or
  cancelled job never carries an artifact and the runtime never leaves a
  success-looking file behind (exports write `.part` and rename on success).
- `verify.artifact({path, expect?, compare?})` probes container/codec/
  geometry/duration/frame count (ffprobe) and optionally pixel-compares a
  frame against a reference image/video, with containment enforced
  (`path` inside `artifactRoot`; `referencePath` inside `artifactRoot` or
  `mediaRoots`). Failed expectations are data (`checks[].pass`), not errors.
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
