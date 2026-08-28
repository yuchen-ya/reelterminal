# ADR 0002: Chromium Runtime — Slice 1b (pixels, export, verification)

- Status: Accepted
- Date: 2026-08-27
- Branch: `feat/chromium-render-slice-1b`
- Context: ADR 0001 (Slice 1 state-level facade), `audit/facade-v0.md` contracts
  #4/#6, `audit/e2e-contract.md` steps 6–7 (the "C" leg).

## Decisions

### 1. Independent capability interfaces, not one render adapter

Slice 1 reserved a single `ProjectRenderAdapter` seam. Slice 1b replaces that
design with **three independent provider interfaces** in
`packages/agent-facade/src/providers.ts`:

- `RenderProvider` — `preview.render_frame` backing (Chromium frame rasterizer).
- `ExportProvider` — `export.start` / `job.*` backing (Chromium WebCodecs or
  frames→ffmpeg).
- `ArtifactVerifier` — `verify.artifact` backing (ffprobe/ffmpeg + pixel diff).

They are separate because availability is independent: a runtime that can
rasterize a frame cannot necessarily encode H.264 (CI Chromium lacks the
codec), and verification only needs ffprobe/ffmpeg. Capability availability
MUST NOT be inferred from the mere presence of another provider (RUNNER-06 in
both directions: no omission, no inflation). The Slice-1 `renderAdapter`
config field stays dormant forever; the new verbs never consume it.

### 2. Chromium/Playwright implementation lives in its own package

`packages/runtime-chromium` (`@openreel/runtime-chromium`) holds everything
Chromium-specific: the esbuild-bundled browser entry, the Playwright host,
artifact store, ffmpeg/ffprobe spawning, and the provider implementations.
`packages/agent-facade` stays pure Node and transport-agnostic: it defines the
provider interfaces and the five new verbs, and never imports
playwright/esbuild/ffmpeg code. No MCP/CLI transport ships in this slice; the
304-tool registry, Desktop MCP and product UI are untouched.

### 3. Runtime probe before API expansion

A repeatable probe (`runChromiumRuntimeProbe`) launches the real browser and
records machine-readable facts: OffscreenCanvas 2D + PNG encode smoke,
`VideoDecoder.isConfigSupported` (h264/vp8/vp9/av1), `VideoEncoder`
h264/vp8/vp9 (hardware + software preference), `AudioEncoder` AAC, the exact
mediabunny `getFirstEncodableVideoCodec(["avc"])` check the export path uses,
ExportEngine/mediabunny loadability, an optional real H.264 decode smoke
against a sample file, plus browser version/UA/executable. The result is saved
as JSON (CI artifact; local evidence under `docs/slice-1b/runtime-probe/`).
Both providers derive availability from a live probe, not from static config.

### 4. Two honest export routes

- **Route W (preferred):** the existing `ExportEngine.exportVideo` +
  `WebCodecsBackend` + mediabunny run inside Chromium; a
  `FileSystemWritableFileStream`-shaped shim streams muxed chunks to Node,
  which writes them under `artifactRoot`.
- **Route F (fallback):** when the probe says H.264 encode is unavailable
  (e.g. Linux CI Chromium), Node drives the same `renderFrame` per frame and
  pipes PNG frames into a configured/system `ffmpeg` (`image2pipe` → libx264
  → MP4). The fallback still produces a real H.264 MP4; a WebM is never
  relabeled as success. If neither route is possible, `export` reports
  unavailable and `export.start` fails `UNSUPPORTED`.

ffmpeg/ffprobe are resolved only from explicit config or the system `PATH`,
spawned without a shell; no binaries are committed.

### 5. Streaming, containment, and the artifact contract

- Local media stays on disk: Chromium receives files as **disk-backed `File`
  objects** (file-input attachment) only after each path is re-validated
  inside `mediaRoots`. Nothing base64s a video into `page.evaluate`.
- All outputs go under the configured `artifactRoot` (containment-checked);
  exports write `output.part` and rename to `output.mp4` only on success, so
  failed/cancelled jobs leave no success-looking artifact.
- Every returned artifact carries `{path, sizeBytes, sha256, sourceRevision}`.

### 6. Export snapshots the project; jobs are facade-owned

`export.start` deep-clones the canonical project at call time
(`sourceRevision`) and returns `{jobId, state:"queued"}` immediately; later
edits proceed on the live project and never affect the running job. The
facade owns the job registry (`queued|running|done|error|cancelled` +
progress + artifact + error) and the idempotency ledger: replaying the same
`idempotencyKey` with the same payload returns the same `jobId`; the same key
with a different payload is `CONFLICT`. `job.cancel` is cooperative and always
settles the job to a terminal state.

## Consequences

- `capabilities.get`/`session.describe` become asynchronous provider-preflight
  aggregations; without providers they report exactly the Slice-1 unavailable
  shape, so Slice-1 semantics are preserved.
- `FACADE_VERBS` grows to 12; `FACADE_CONTRACT_VERSION` becomes
  `facade-slice-1b`; step letters for pixels/export/verify flip from `X` to
  `C`/`A` only when the corresponding preflight passes.
- The Chromium E2E runs in Linux CI (Playwright Chromium; Route F via system
  ffmpeg when needed) and locally on Windows; generated MP4/PNG artifacts,
  browsers and ffmpeg binaries are never committed.

## Amendments (2026-08-28, pre-merge hardening)

**A3 (revises #3): the probe measures the job-carrying runtime, keyed on its
generation.** Provider preflights no longer consume a one-time probe of a
throwaway Chromium. `probeWithRuntime` runs the probe on the pool's OWN
runtime — the browser that would carry the work — and the pool caches the
result only for that browser's generation (bumped on crash/recycle). A stale
"capable" answer can therefore never outlive the browser that produced it;
`runChromiumRuntimeProbe` remains only as the standalone evidence entry
point. Route W additionally requires `exportEngineInit === true`: a codec
the browser can encode is not a route when the engine that feeds it failed
to initialize.

**A4 (revises #4): Route F is an explicit video-only experiment, not a
fallback.** The frames→ffmpeg route drops audio (frames carry no sound), so
silently substituting it for the real export was a capability lie. The probe
summary no longer derives it (`exportRoute` is `chromium-webcodecs` or
`unavailable`; the experiment's prerequisites are recorded as the
`videoOnlyFramesRouteAvailable` fact). Route F runs only when explicitly
forced via `forceExportRoute` (tests/experiments), and then the capability
details say `{videoOnly:true, audio:"none", experimental:true}`.

**A5 (reinforces #5): output containment is verified before AND after every
write.** The facade rejects `renders/`, `exports/` and per-job directories
that are symlinks/junctions (Windows junctions included — lstat reports them
as links) or whose realpath escapes `artifactRoot`, BEFORE a provider writes
a byte; after the write the artifact's realpath is re-validated and an
escaped file is removed, never published. Regression tests pin "zero bytes
outside artifactRoot" for both verbs.

**A6 (reinforces #6): the watchdog stops work, then terminalizes — once —
and never bricks the pool.** On watchdog fire the provider now (a) really
stops the underlying work (in-page abort for Route W, ffmpeg kill for Route
F) and recycles the browser, (b) waits (bounded) for the route's own cleanup
to finish, (c) sweeps the job dir of any `.mp4`/`.part`, and only then (d)
settles the job as `error`. Routes RETURN their outcome and `runJob` is the
single terminalization point, guarded by an exactly-once callback wrapper —
a job can never emit two terminal callbacks. `ChromiumRuntime.recycle()`
replaces "close forever": the same pool launches a fresh browser and keeps
serving preview/export after a watchdog or crash.

**A7 (second adversarial pass, same day): recovery edge cases sealed.** The
page lock is a SINGLE chain for the runtime's lifetime (recycle never resets
it); an operation enqueued before a recycle sees the generation change and
re-enqueues at the tail, so two operations can never run concurrently on the
fresh page. A RENDERER crash (`page.on("crash")`, which never fires the
browser's `disconnected`) triggers the same recycle+generation-bump
recovery as a full crash — the pool can no longer serve stale capabilities
against a dead page. Routes re-check cancellation after acquiring the page
lock, so a job cancelled while queued behind a recycle never runs as a
zombie; a post-terminal re-sweep covers late-settling work. Probe/hydrate/
render evaluates carry a hard page-op ceiling (default 120 s, recycle on
fire) and pool preflight probes bound their WAIT on the shared page
(30 s → transient honest unavailable) so neither a wedged page nor a long
export can stall the facade's serialized lane; graceful browser/server
teardown is itself time-bounded. (playwright-core 1.60 carries NO
protocol-level evaluate timeout — verified with a 185 s evaluate — so the
export watchdog really is the only ceiling an export evaluate needs.)
Known residual (accepted, documented): if the browser MAIN process hangs so
completely that the bounded `browser.close()` times out with the process
alive and no `disconnected` ever firing, the wedged evaluate never rejects
and the single lock chain waits — degradation (a stuck pool), never
corruption, double-terminalization or a capability lie; renderer-level
wedges (the realistic class) are fully covered because closing the browser
rejects the evaluate immediately.
