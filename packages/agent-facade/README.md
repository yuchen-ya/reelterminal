# @openreel/agent-facade

Pure-Node, in-process, transport-agnostic agent facade over the OpenReel
canonical `Project` state (Slice 1). Design: `audit/facade-v0.md`,
`docs/adr/0001-headless-facade-slice-1.md`.

```ts
import { createAgentFacade } from "@openreel/agent-facade";

const facade = createAgentFacade({ mediaRoots: ["/abs/path/to/media"] });

await facade["project.create"]({ name: "Demo" });
await facade["media.import"]({ path: "/abs/path/to/media/input.mp4" });
await facade["edit.apply"]({
  ops: [
    { op: "track.add", trackType: "video", trackId: "v1" },
    { op: "clip.add", trackId: "v1", mediaId, startTime: 0, clipId: "c1" },
    { op: "clip.trim", clipId: "c1", inPoint: 0, outPoint: 5 },
    { op: "track.add", trackType: "text", trackId: "t1" },
    { op: "text.create", trackId: "t1", text: "Hello world", startTime: 0, duration: 5 },
  ],
  expectedRevision: 1,
  idempotencyKey: "batch-1",
});
const state = await facade["project.get_state"]();
```

## Verbs

`session.describe` · `capabilities.get` · `project.create` ·
`project.get_state` · `media.import` · `timeline.get` · `edit.apply`

All verbs return `FacadeResult<T>` (`{ ok: true, value } | { ok: false,
error }`) with typed error codes (`INVALID_PARAMS`, `NOT_FOUND`, `CONFLICT`,
`UNSUPPORTED`, `ACTION_FAILED`, `INTERNAL`) — never throw for domain errors,
never silently no-op with `ok: true`.

## Guarantees

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
  names and unsupported ops fail with zero side effects.
- **Honest capabilities**: `capabilities.get` reports what this runtime
  actually has; preview/export are unavailable until a render adapter is
  injected.

## Media import

`media.import` reads local files inside the configured `mediaRoots` only
(realpath containment, `..`/prefix escapes rejected, URLs rejected) and
extracts real metadata (duration, width, height, media type) via mediabunny.

## Slice boundaries (what this is NOT)

No Chromium/pixel rendering, no export, no OCR/verification, no MCP/CLI
transport, no cloud GPU. Text overlays are canonical model state
(`project.textClips` on a `type:"text"` track) — pixel rendering is NOT
verified or claimed here. The Slice-1b seam is `ProjectRenderAdapter`
(`src/render/adapter.ts`): a future Chromium runtime hydrates from the
serialized project returned by `project.get_state`.

## Invariants

See `docs/project-invariants.md` (evidence-backed MUST/MUST-NOT list the
facade implements against: canonical TextClip shape, MEDIA-04 trim split,
blob-free MediaItems, duration recomputation, facade-owned idempotency).

## Tests

`corepack pnpm test:run` — state-level E2E plus adversarial suites
(atomicity byte-restore, revision conflicts, idempotent replays, strict
params, media-root containment, capability truthfulness).
