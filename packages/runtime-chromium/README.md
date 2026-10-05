# @reelterminal/runtime-chromium

Real-Chromium render/export runtime for the ReelTerminal agent facade. It
hydrates the canonical `Project` into the core engines
bundled into a headless Chromium page and produces **real pixels**: PNG frame
previews and H.264 MP4 exports, with ffprobe/ffmpeg-based artifact
verification.

This package implements the provider interfaces defined by
[`@reelterminal/agent-facade`](../agent-facade/README.md) (`RenderProvider`,
`ExportProvider`, `ArtifactVerifier`).

## Requirements

- **Chromium** — resolved by `playwright-core`. Install once:
  `pnpm --filter @reelterminal/runtime-chromium exec playwright-core install chromium`
- **ffmpeg + ffprobe** — required for `verify.artifact`, and for the
  explicitly forced video-only frames→ffmpeg export experiment. Resolved
  from explicit config (`ffmpegPath`/`ffprobePath`) or the system `PATH`.
  Never committed, never downloaded by this package, always spawned without
  a shell.

## Quick start

```ts
import { createAgentFacade } from "@reelterminal/agent-facade";
import {
  createChromiumProviders,
  FfmpegArtifactVerifier,
} from "@reelterminal/runtime-chromium";

const providers = createChromiumProviders(); // one Chromium, one probe
const facade = createAgentFacade({
  mediaRoots: ["C:/media"],        // imports only from here
  artifactRoot: "C:/artifacts",    // all outputs land here
  renderProvider: providers.renderProvider,
  exportProvider: providers.exportProvider,
  artifactVerifier: new FfmpegArtifactVerifier(),
});
// …when done: await providers.close();
```

The full 7-step scenario (create 320x180@30 → import `input.mp4` → clip 0–5 s
→ "Hello world" 0–5 s → PNG at 2.5 s → export `output.mp4` → verify) is in
[`examples/hello-world-e2e.mts`](examples/hello-world-e2e.mts). Run the following
from `packages/runtime-chromium/` with esbuild + node (input and output roots are
examples — replace them with existing absolute paths):

```bash
esbuild examples/hello-world-e2e.mts --bundle --platform=node --format=esm \
  --external:playwright-core --external:esbuild --outfile=hello-world-e2e.mjs
node hello-world-e2e.mjs --input /abs/input.mp4 --media-root /abs/media \
  --artifact-root /abs/artifacts
```

(Inside this repo: run from `packages/runtime-chromium/` and use
`node_modules/.bin/esbuild` — esbuild is not hoisted to the repo root.
Outside: any esbuild ≥0.20. `playwright-core` must stay external so its
browser registry resolves.)

## Facade verbs

All verbs return `{ok:true,value} | {ok:false,error}` and never throw for
domain errors.

### `preview.render_frame`

```ts
await facade["preview.render_frame"]({
  timeSec: 2.5,              // 0..timeline duration (end clamps to last frame)
  width: 320, height: 180,   // optional, even numbers; default: project size
  expectedRevision: 2,       // optional optimistic-concurrency precondition
  idempotencyKey: "p1",      // optional; replay returns the same artifact
});
// → { revision, timeSec, width, height, replayed,
//     artifact: {kind:"image", format:"png", path, sizeBytes, sha256, sourceRevision} }
```

### `export.start`

```ts
const started = await facade["export.start"]({
  settings: { width: 320, height: 180, frameRate: 30 }, // optional; MP4/H.264 only
  idempotencyKey: "exp-1",
});
// → { jobId, state:"queued", sourceRevision, replayed:false }
```

Returns **immediately**. The export renders a **frozen project snapshot**
taken at call time (`sourceRevision`); edits after `export.start` proceed
normally and never affect the job. Replaying the same `idempotencyKey` with
the same payload returns the same `jobId`; the same key with a different
payload fails `CONFLICT`.

### `job.status` / `job.cancel`

```ts
await facade["job.status"]({ jobId });
// → { jobId, kind:"export", state:"queued"|"running"|"done"|"error"|"cancelled",
//     progress: {phase, percent, currentFrame, totalFrames} | null,
//     artifact: ArtifactRef | null,   // only on "done"
//     error: {code, message} | null,  // only on "error"
//     sourceRevision, route, cancelRequested, createdAt, updatedAt }
await facade["job.cancel"]({ jobId });  // cooperative; terminal states are no-ops
```

A failed or cancelled job **never** carries an artifact and never leaves an
`output.mp4`/`output.mp4.part` behind — exports write to a `.part` temp name
that is renamed only on success, and the job dir is swept before any
error/cancelled terminalization.

### `verify.artifact`

```ts
await facade["verify.artifact"]({
  path: mp4Path,                       // must be inside artifactRoot
  expect: { container: "mp4", videoCodec: "h264", width: 320, height: 180,
            durationSec: 5, durationToleranceSec: 0.12 },
  compare: {                           // optional pixel comparison
    referencePath: pngOrVideoPath,     // inside artifactRoot or mediaRoots
    timeSec: 2.5, referenceTimeSec: 2.5,
    region: { x: 0.15, y: 0.3, width: 0.7, height: 0.4 }, // optional, 0..1
    mode: "similar",                   // or "different"
    maxMeanAbsDiff: 14,                // similar threshold (0..255)
    minChangedPixelsRatio: 0.02,       // different threshold (0..1)
  },
});
// → { pass, probe: {container, videoCodec, audioCodec, width, height,
//      durationSec, frameCount, frameRate, sizeBytes, sha256},
//     checks: [{name, pass, details}…], compare?: {meanAbsDiff,
//      changedPixelsRatio, region, mode, pass} }
```

Failed expectations are data (`checks[].pass`), not exceptions; only
infrastructure problems (missing binary, unreadable file) fail the call.

## Capabilities tell the truth

`capabilities.get()` reports `preview`/`export`/`verify` independently, each
gated on a **live preflight**, and `session.describe()` flips the E2E step
letters from `X` to `C`/`A` only when the capability is genuinely usable. A
working renderer never implies a working exporter.

The preflight probe runs **on the pool's own runtime** — the same Chromium
instance that would carry the preview/export work — never on a throwaway
probe browser. The result is cached only for that browser's *generation*: a
crash, a watchdog recycle or a failed launch invalidates the cache and the
next preflight re-probes the fresh runtime. A capability can therefore never
serve a stale success produced by a long-dead browser, and verbs re-check
the preflight before acting, so the report and reality stay glued together.

## Export routes

| Route | When | How | Audio |
|---|---|---|---|
| `chromium-webcodecs` (Route W) | **Default**, whenever the probe says the runtime can do it: render path OK **and** ExportEngine initialized **and** H.264 encodable | Existing `ExportEngine` + `WebCodecsBackend` + mediabunny in-page; chunks stream to disk via a writable shim | AAC from the timeline (when present) |
| `chromium-frames-ffmpeg` (Route F) | **Explicit opt-in only** (`forceExportRoute`), for tests/experiments — never selected by the probe | Same `renderFrame` per frame, piped as PNG into system ffmpeg/libx264 | **None — video-only** |

Route F drops audio (frames carry no sound). It is therefore **not a
fallback**: the probe never derives it, the default export capability is
either Route W or honestly `unavailable`, and forcing Route F makes the
capability say so (`details: {route, videoOnly:true, audio:"none",
experimental:true}`). Both routes produce a real MP4/H.264 file; a WebM is
never relabeled. The route is reported in `job.status → route` and in the
machine-readable probe (`runChromiumRuntimeProbe`, saved by tests to
`.artifacts/runtime-probe.json`; the probe records the experiment's
prerequisites as the `videoOnlyFramesRouteAvailable` fact).

## Guarantees and limits

- **Project is authoritative.** The browser hydrates `titleEngine` from
  `project.textClips` and `graphicsEngine` from `project.svgClips`; text
  and SVG overlays render from canonical project state only.
- **Media streams.** Videos reach Chromium as disk-backed `File` objects
  (re-validated inside `mediaRoots`); nothing base64s a video into the page.
  Files >2 GiB are refused at the facade.
- **Outputs are contained.** Everything lands under `artifactRoot` with
  `{path, sizeBytes, sha256, sourceRevision}`. The facade verifies the
  output directories are real (never symlinks/junctions) BEFORE a provider
  writes, and re-validates the written file's realpath AFTER the write — a
  poisoned or swapped output tree fails the verb with zero bytes outside.
- **One browser, one page.** Preview renders and exports serialize; a second
  export stays `queued` until the page is free. Cancellation still reaches a
  running export between frames.
- **The watchdog recovers, never bricks.** Every export runs under a hard
  ceiling (default 10 min). On fire the provider REALLY stops the work
  (in-page abort / ffmpeg kill + browser recycle), lets route cleanup run,
  sweeps the job dir, and only then settles the job — exactly once — as
  `error` with no `.mp4`/`.part` left behind. The pool relaunches Chromium
  on the next operation: preview and export keep working on the same pool.
  Renderer crashes (`page.on("crash")`) take the same recovery path, probe/
  hydrate/render evaluates have a hard page-op ceiling (recycle on fire),
  and preflight probes bound their wait on the shared page (a busy runtime
  answers transient-unavailable rather than stalling the session lane).
- **Input codec ≠ output codec.** Output is always H.264. Input decode
  support is build-dependent and measured by the probe, never assumed:
  VP8/VP9/AV1 decode everywhere; H.264 decode/encode is present in current
  Playwright Chromium on Windows and Linux (probe-verified: Chromium 148)
  but older/leaner builds may lack it — when in doubt, feed VP9/AV1 inputs
  and read `runtime-probe.json`'s per-codec facts.
- **Pixel compare scales references.** `verify.artifact` scales a
  dimension-mismatched reference to the artifact's raster (the normal case
  of comparing an export against its full-resolution source), and clamps a
  `timeSec` at exactly the file's duration onto the last frame.
- ffmpeg/ffprobe are only spawned as explicit binaries (no shell), resolved
  from config or `PATH`.

## Tests

```bash
pnpm --filter @reelterminal/runtime-chromium test:run   # probe + E2E + jobs + verify
pnpm --filter @reelterminal/agent-facade test:run
```

Generated PNGs/MP4s, browsers and ffmpeg binaries are never committed.
