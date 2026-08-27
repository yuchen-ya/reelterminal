# @openreel/runtime-chromium

Real-Chromium render/export runtime for the OpenReel agent facade (Slice 1b,
ADR 0002). It hydrates the canonical `Project` into the existing core engines
bundled into a headless Chromium page and produces **real pixels**: PNG frame
previews and H.264 MP4 exports, with ffprobe/ffmpeg-based artifact
verification.

No MCP, no CLI, no product-UI changes: this package implements the
transport-agnostic provider interfaces defined by
[`@openreel/agent-facade`](../agent-facade/README.md) (`RenderProvider`,
`ExportProvider`, `ArtifactVerifier`).

## Requirements

- **Chromium** — resolved by `playwright-core`. Install once:
  `pnpm --filter @openreel/runtime-chromium exec playwright-core install chromium`
- **ffmpeg + ffprobe** — required for `verify.artifact` and for the
  frames→ffmpeg export fallback. Resolved from explicit config
  (`ffmpegPath`/`ffprobePath`) or the system `PATH`. Never committed, never
  downloaded by this package, always spawned without a shell.

## Quick start

```ts
import { createAgentFacade } from "@openreel/agent-facade";
import {
  createChromiumProviders,
  FfmpegArtifactVerifier,
} from "@openreel/runtime-chromium";

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
[`examples/hello-world-e2e.mts`](examples/hello-world-e2e.mts). Run it from
anywhere with esbuild + node (paths are examples — use absolute ones):

```bash
esbuild examples/hello-world-e2e.mts --bundle --platform=node --format=esm \
  --external:playwright-core --external:esbuild --outfile=hello-world-e2e.mjs
node hello-world-e2e.mjs --input /abs/input.mp4 --media-root /abs/media \
  --artifact-root /abs/artifacts
```

(Inside this repo: `node_modules/.bin/esbuild`. Outside: any esbuild ≥0.20.
`playwright-core` must stay external so its browser registry resolves.)

## Facade verbs added by Slice 1b

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
`output.mp4`/`.part` behind — exports write `output.part` and rename only on
success.

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
gated on a **live preflight** (a real Chromium probe / ffmpeg resolution), and
`session.describe()` flips the E2E step letters from `X` to `C`/`A` only when
the capability is genuinely usable. A working renderer never implies a
working exporter.

## Export routes (probe-selected, both honest)

| Route | When | How |
|---|---|---|
| `chromium-webcodecs` | Chromium can encode H.264 (e.g. Windows/macOS) | Existing `ExportEngine` + `WebCodecsBackend` + mediabunny in-page; chunks stream to disk via a writable shim |
| `chromium-frames-ffmpeg` | CI Chromium (no H.264 encode, e.g. Linux) | Same `renderFrame` per frame, piped as PNG into system ffmpeg/libx264 |

Both produce a real MP4/H.264 file; a WebM is never relabeled. The route is
reported in `job.status → route` and in the machine-readable probe
(`runChromiumRuntimeProbe`, saved by tests to
`.artifacts/runtime-probe.json`).

## Guarantees and limits

- **Project is authoritative.** The browser hydrates `titleEngine` from
  `project.textClips`; nothing else drives overlay rendering.
- **Media streams.** Videos reach Chromium as disk-backed `File` objects
  (re-validated inside `mediaRoots`); nothing base64s a video into the page.
  Files >2 GiB are refused at the facade.
- **Outputs are contained.** Everything lands under `artifactRoot` with
  `{path, sizeBytes, sha256, sourceRevision}`.
- **One browser, one page.** Preview renders and exports serialize; a second
  export stays `queued` until the page is free. Cancellation still reaches a
  running export between frames.
- **Input codec ≠ output codec.** Stock Chromium decodes VP8/VP9/AV1
  everywhere; H.264 *decode* depends on the platform build (present on
  Windows/macOS, absent on Linux CI Chromium). Output is always H.264.
- ffmpeg/ffprobe are only spawned as explicit binaries (no shell), resolved
  from config or `PATH`.

## Tests

```bash
pnpm --filter @openreel/runtime-chromium test:run   # probe + E2E + jobs + verify
pnpm --filter @openreel/agent-facade test:run       # facade incl. Slice-1
```

Generated PNGs/MP4s, browsers and ffmpeg binaries are never committed.
