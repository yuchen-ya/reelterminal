# Extraction Audit — Media Import / Overlay / Preview / Render-Export E2E

Baseline 2566c34 (branch audit/extraction-2566c34). Read-only analysis; no runtime installs
(node_modules absent), so all claims are source-level unless marked "probe evidence" from
audit/probes/out/headless-smoke.json.

## SUMMARY

The editing **model layer** is fully headless-capable: `HeadlessHost` + `ActionExecutor`
run in pure Node (probe: 12/12 PASS, incl. create_text_clip and track ops), so
create_project → import-model-entry → add_clip → trim_clip → text/create all mutate the
project deterministically today.

The **pixel layer** is not headless at all. Every frame producer in the repo requires a
browser canvas stack:
- Preview: `VideoEngine.renderFrame` composites on `OffscreenCanvas` +
  `createImageBitmap`, with `document.createElement("video")` as a decode fallback.
- Export: `ExportEngine.exportVideo` renders frames through `VideoEngine`, encodes via
  WebCodecs (`VideoEncoder`) and muxes via mediabunny (`Output`/`Mp4OutputFormat`);
  the desktop variant pipes RGBA frames to the bundled native ffmpeg sidecar.
  Nothing in the repo can produce output.mp4 in plain Node.

Two structural splits also bite the E2E slice:
1. **Overlay split-brain** — render/export read overlays from module-level engine
   singletons (`titleEngine.getAllTextClips()`), never from `project.textClips`; only the
   live web store path registers clips into those engines. The codebase itself documents
   that raw `text/create` "renders nothing".
2. **Import gating** — the only registry import tool (`import_media_from_url`) hard-fails
   off-desktop (`window.openreel.media.fetchUrl`), and the `media/import` core action
   stores zeroed metadata and is reachable from no tool. A local input.mp4 cannot enter a
   headless project's media library with usable metadata today.

Post-export verification (ffprobe / frame OCR) has zero footprint in the repo: no ffprobe
invocation anywhere (one comment explicitly notes "FFmpeg.wasm doesn't expose ffprobe"),
no tesseract/OCR dependency, no frame-diff utility.

## FINDINGS

- F1 MediaImportService.importMedia(File) probes metadata via mediabunny, then generates
  thumbnails/waveform and falls back to FFmpeg.wasm or native ffmpeg on unsupported codecs.
  packages/core/src/media/media-import-service.ts:91-297. Confidence: high.
- F2 Metadata probe = pure-TS demux via `Input({source:new BlobSource(file)})`:
  duration/dimensions/fps/codec/canDecode from track objects.
  packages/core/src/media/mediabunny-engine.ts:397-478 (input creation :300-303).
  Confidence: high.
- F3 Import uses browser-only APIs in several branches: image thumbnails use
  `document.createElement("canvas")` + `URL.createObjectURL`
  (media-import-service.ts:193-227); MOV playback check creates an HTMLVideoElement
  (:299-325). Confidence: high.
- F4 UI import path bypasses ActionExecutor entirely: the store slice writes
  `project.mediaLibrary.items` directly via zustand `set()`.
  apps/web/src/stores/project/media-slice.ts:112-148. Confidence: high.
- F5 The only registry import tools are `import_media_from_url` and motion-domain
  `import_image_layer`; both require optional host method `importMediaFromUrl`, which only
  `LiveEditorHost` implements. audit/tool-catalog.jsonl lines 64/275;
  packages/agent/src/host.ts:254+ (optional method);
  apps/web/src/services/agent/live-host.ts:242-274;
  packages/agent/src/headless-host.ts (no such method). Confidence: high.
- F6 `LiveEditorHost.importMediaFromUrl` throws "Media download is only available in the
  desktop app" without `window.openreel.media.fetchUrl` (Electron preload bridge).
  live-host.ts:246-250; apps/desktop/src/preload/index.ts:103;
  apps/desktop/src/main/ipc/fetch-url.ts:35 (SSRF-blocked fetch). Confidence: high.
- F7 Core action `media/import` exists (stores `params.file` with blob but ZEROED
  metadata: duration/width/height = 0) and no registry tool maps to it
  (0 catalog hits for `media/import`).
  packages/core/src/actions/action-executor.ts:356-380;
  packages/core/src/actions/action-validator.ts:184-192. Confidence: high.
- F8 `add_clip` defaults duration to 5 s when metadata.duration is falsy — so media
  imported through `media/import` still yields a playable-length clip, just wrong length.
  packages/core/src/actions/action-executor.ts:683-689. Confidence: high.
- F9 Trim semantics: `clip/trim` sets inPoint/outPoint and recomputes
  `duration = outPoint − inPoint`. When BOTH points change in one action the second
  recompute subtracts the ORIGINAL inPoint (stale base), shifting duration if inPoint moves.
  packages/core/src/actions/action-executor.ts:788-813 (stale-base bug at :799-806).
  Confidence: high (read of code); behavior edge case unprobed.
- F10 Renderer honors trim when sampling sources (`clip.inPoint` used for decode offsets).
  packages/core/src/video/video-engine.ts:392,873,2181,2313. Confidence: high.
- F11 Text overlay dual-path: registry `create_text_clip` prefers optional host
  `createTextOverlay`, else falls back to raw `text/create` action.
  packages/agent/src/registry.ts:15636-15677. Confidence: high.
- F12 Overlay actions (`text|shape|svg|sticker × create|update|remove`) only mutate
  `project.textClips` etc.; registered via generic handlers.
  packages/core/src/actions/handlers/overlay.ts:38-146. Confidence: high.
- F13 Render-time text reader pulls from the module singleton `titleEngine`, NOT the
  project array: `getActiveTextClips()` filters `titleEngine.getAllTextClips()`;
  drawing happens in `titleEngine.renderText` onto an OffscreenCanvas composite.
  packages/core/src/video/video-engine.ts:1764-1776,1826-1848;
  singleton at packages/core/src/text/title-engine.ts:995. Confidence: high.
- F14 host.ts documents the consequence verbatim: raw `text/create` "only appends to
  project.textClips and never reaches the engine, so it renders nothing".
  packages/agent/src/host.ts:250-263. Confidence: high.
- F15 Web store resyncs engines from the project ONLY on undo/redo/load:
  `syncOverlayEnginesFromProject()` loads `project.textClips` back into the same core
  singleton. apps/web/src/stores/project/store-helpers.ts:219-230 (call sites
  history-slice.ts:274,486). Headless has no equivalent. Confidence: high.
- F16 ExportEngine timeline-duration calc also reads singletons
  (titleEngine/graphicsEngine `getAll*Clips`), so an actions-only text overlay neither
  extends the timeline nor exports.
  packages/core/src/export/export-engine.ts:1199-1240 (:1211). Confidence: high.
- F17 Preview pipeline: RenderBridge → VideoEngine.renderFrame(project,time,
  undefined,undefined,{realtime:true}) → draw to visible canvas, rAF-debounced scrubbing.
  apps/web/src/bridges/render-bridge.ts:172-237; consumer
  apps/web/src/components/editor/Preview.tsx:2621. RendererFactory picks WebGPU when
  `navigator.gpu` exists, Canvas2D fallback otherwise.
  packages/core/src/video/renderer-factory.ts:42-58,86-110. Confidence: high.
- F18 No pure-Node frame-render path exists. `render_motion_frame` resolves to
  `host.runJob("exportFrame")`, implemented only by the web/desktop job runner via
  `renderMotionCompositionFrameToDataUrl` (ImageBitmap → PNG dataURL).
  packages/agent/src/registry.ts:23743-23764,1532-1577;
  apps/web/src/services/agent/export-job-runner.ts:226-264;
  apps/web/src/motion/export-motion-frame.ts:230-260. HeadlessHost returns
  "no job runner configured" (packages/agent/src/headless-host.ts:72-83). Confidence: high.
- F19 export_video is a jobTool delegating to `host.runJob("exportVideo")` and promising a
  presigned URL (~15 min). packages/agent/src/registry.ts:10595-10620,31827-31834.
  Confidence: high.
- F20 Web/desktop executor wiring: `DesktopApp.tsx` injects `createExportJobRunner()` into
  LiveEditorHost; it selects WebCodecsBackend (mp4→avc/h264, webm→vp9, mov→h265/hevc,
  prefer-hardware) with NativeFFmpegBackend fallback, then uploads via
  `window.openreel.gpu.uploadExport` — desktop-only ("Export upload is only available in
  the desktop app"). apps/web/src/desktop/DesktopApp.tsx:73;
  apps/web/src/services/agent/export-job-runner.ts:184-214,145-176. Confidence: high.
- F21 Encoding/muxing reality per environment:
  - Browser/live: mediabunny `Output` + Mp4/WebM/MovOutputFormat muxing, WebCodecs
    `getFirstEncodableVideoCodec` encoding. packages/core/src/export/webcodecs-backend.ts:18-120.
  - Desktop: renderer streams RGBA frames over IPC; main process spawns bundled
    resources/bin/<platform>-<arch>/ffmpeg with `-f rawvideo -pix_fmt rgba … libx264/aac`
    (+ ProRes profiles via encode-args). apps/web/src/services/native-ffmpeg-backend.ts:87,173;
    apps/desktop/src/main/ipc/export.ts:15-72; apps/desktop/src/main/sidecar/export-job.ts:33-72;
    apps/desktop/src/main/sidecar/ffmpeg-path.ts:11-20.
  - FFmpeg.wasm (@ffmpeg/core@0.12.6 fetched from unpkg CDN) is used ONLY for import-time
    transcode fallbacks, never project export.
    packages/core/src/media/ffmpeg-fallback.ts:3,130-152.
- F22 Headless export state: CLI (`openreel-agent`, packages/agent-runner) wires NO
  jobRunner; probe case "export_video (no jobRunner)" fails exactly as coded.
  packages/agent-runner/src/cli.ts:95; packages/agent-runner/src/run.ts:44;
  audit/probes/out/headless-smoke.json cases[8]. Confidence: high/probe.
- F23 Cloud alternative: `createGpuJobRunner` POSTs `{kind,params}` to remote GPU worker
  infra behind a broker JWT and polls to a manifest URL — external service required;
  artifact lands broker-side, no local file handling in-repo.
  packages/agent-runner/src/gpu-job-runner.ts:107-186. Batch helper exists:
  packages/agent-runner/src/export-queue.ts:31-70. Confidence: high.
- F24 Verification tooling: none. No ffprobe invocation anywhere (comment at
  packages/core/src/media/ffmpeg-fallback.ts:443: "FFmpeg.wasm doesn't expose ffprobe");
  tesseract/OCR: zero references in packages/ or apps/. Closest in-repo visual check is
  `render_motion_frame`/`render_creation_preview` (motion comps only, needs browser canvas).
  Confidence: high.
- F25 Headless runtime purity proven by probe harness: 135-file closure loads in Node with
  only @paper-design/shaders + polygon-clipping stubbed; transaction rollback restores
  byte-identical projects. audit/probes/lib/openreel-loader.mjs;
  audit/probes/out/headless-smoke.json (closure, undo_restored_byte_identical). Confidence: high.

## PIPELINES

### Import
Entry points: drag-drop/file picker → AssetsPanel/Toolbar → store `importMedia(file)`
(media-slice.ts:22) → MediaBridge.importFile (media-bridge.ts:192) → MediaImportService
(core). Agent path: `import_media_from_url` tool → host.importMediaFromUrl (desktop only)
→ same store `importMedia`. Model changes: none via actions — direct store write appends a
MediaItem {blob, metadata, thumbnails, waveformData} to project.mediaLibrary (undo-exempt);
render path: preview decodes later from MediaItem.blob. Environment deps: File/Blob +
mediabunny (BlobSource), HTML elements for thumbnails/MOV check, FFmpeg.wasm CDN load on
unsupported codecs, Electron bridge for URL fetch. Persisted blobs go to IndexedDB
(saveMediaBlob); JSON project save strips blobs (stripMediaBlobs,
storage/project-serializer.ts:362-372) and reload marks items `isPlaceholder:true`
(:214-228) — a serialized headless project carries NO pixels.

### Trim
Tool `trim_clip` (registry.ts TOOLS entry next to add_clip, ~:15521 catalog line) →
action_type `clip/trim` → executor switch case "clip/trim"
(action-executor.ts:788-813): sets clip.inPoint/outPoint, recomputes duration = out−in.
Validator: per-type param checks (action-map.jsonl line 31 shows valid=false probe for
missing clipId). Renderer applies inPoint to decode sampling (F10). Pure model math —
works identically in every host. Note stale-base quirk when both points move (F9).

### Text overlay
Two lanes. (a) Live lane: tool `create_text_clip` → LiveEditorHost.createTextOverlay
(live-host.ts:489-536) ensures a text track, calls store.createTextClip
(text-graphics-slice.ts:216) which registers the TextClip in the core `titleEngine`
singleton AND records `text/create` into history/model (store-helpers recordOverlayCreate
store-helpers.ts:97-126). (b) Raw lane: `text/create` action → overlay handler mutates only
`project.textClips` (handlers/overlay.ts:42-63). Render reads lane-(a) state only: VideoEngine
.getActiveTextClips → titleEngine.renderText → OffscreenCanvas composite (video-engine.ts:
1764-1848); ExportEngine counts text end-times from the same singleton
(export-engine.ts:1211). TextClip lives at project.textClips[]
(types/project.ts:34) with type def in text/types.ts; the RENDER copy lives in
TitleEngine memory — they diverge outside the web store.

### Preview
Preview.tsx (apps/web/src/components/editor/Preview.tsx:2621) drives RenderBridge
(apps/web/src/bridges/render-bridge.ts:172-237):
videoEngine.renderFrame(project, time, undefined, undefined, {realtime:true}) →
drawFrameToCanvas; PlaybackController/master-timeline-clock tick the playhead
(packages/core/src/playback/). Frame production = mediabunny CanvasSink decode (WebCodecs
inside mediabunny) with document.createElement("video") fallback, composited on
OffscreenCanvas; GPU effects via WebGPU when navigator.gpu present, Canvas2D fallback
(renderer-factory.ts:42-58; video/canvas2d-fallback-renderer.ts; gpu-compositor.ts).
No Node implementation of any stage.

### Export
Model→pixels→bytes chain (all environments): ExportEngine.exportVideo generator
(export-engine.ts:~140-330) loops frames → VideoEngine.renderFrame → EncoderBackend
.addVideoFrame → backend muxes; audio encoded to WAV chunks first or after depending on
backend (`audioBeforeVideo`). Backends: WebCodecsBackend (browser; mediabunny mux +
WebCodecs encode; h264/hevc/vp9/av1), NativeFFmpegBackend (desktop IPC → sidecar ffmpeg,
libx264/aac, ProRes). Delivery: web Toolbar → services/export-runner.ts:413-418 with
showSaveFilePicker/memory stream (Download); agent job runner → upload to broker via
desktop-only `window.openreel.gpu.uploadExport` (export-job-runner.ts:151-176); desktop UI
streams to disk via CF writer (ipc/export.ts). Headless: nothing runs (probe-verified);
cloud runner delegates to remote GPU infra returning manifestURL. Guardrail:
ProRes/H.265 require native encoder; web normalizes to H.264 behind an acknowledge flag
(exportSettingsRequireNativeEncoder, export-engine.ts bottom; ExportDialog.tsx:328-341;
live-host.ts:292-303 for motion).

## E2E-CLASSIFICATION

Target: external Agent → MCP transport → facade → headless runtime → import input.mp4 →
trim 0–5s → add "Hello world" text → export output.mp4 → ffprobe + frame/OCR verification.
Letters: P pure Node | A injected adapter needed | C Chromium/browser needed |
D Electron desktop only | X missing/inconsistent/unverifiable.

| # | Step | Letter | Exists TODAY (names, path:line) | Blocker for P | Smallest unblocking adapter |
|---|------|--------|----------------------------------|---------------|------------------------------|
| 1 | External agent → MCP transport | D | MCP HTTP(JSON-RPC)+token+stdio shim inside Electron main: apps/desktop/src/main/mcp/server.ts:71-96, http-server.ts:81-131; renderer sidecar shim → handleMcpBridgeRequest apps/web/src/services/agent/mcp-listener.ts:168-198 | Only transport is desktop-local; forwards over IPC to the LIVE editor host | Skip MCP: call `executeTool(name,args,headlessHost)` (packages/agent/src/executor.ts:32) directly from a Node script; or a 100-line standalone stdio/stdreamable-http wrapper around it |
| 2 | Facade + headless runtime | P | HeadlessHost packages/agent/src/headless-host.ts:19-100; executeTool packages/agent/src/executor.ts:32; runTurn loop packages/agent/src/loop.ts; LLM client packages/agent-runner/src/node-llm.ts; probe evidence audit/probes/out/headless-smoke.json | None | None (already works; keep stub list: @paper-design/shaders, polygon-clipping) |
| 2a | create_project | P | create_project tool (actionTool project/create) → project/updateSettings-style executors | None | None |
| 3 | Import input.mp4 into media library | A→X | Tool import_media_from_url packages/agent/src/registry.ts:15494-15513 → LiveEditorHost.importMediaFromUrl live-host.ts:242-274 (D-gated bridge); core action media/import executor action-executor.ts:356-380 (unreachable from any tool; zeroes metadata) | Tool needs desktop fetchUrl bridge (D); no fs/Blob ingestion in HeadlessHost; mediabunny metadata probe needs a Blob (BlobSource) and thumbnails need canvas | Implement `HeadlessHost.importMediaFromUrl(pathOrUrl)`: fs.readFile → `new File([bytes])` (Node ≥20 global) → construct MediaItem with metadata from a new lightweight mediabunny extractMetadata call; accept 5s-default durations initially; skip thumbs/waveform (quickMode already skips them, media-import-service.ts:58-66). ~50 LOC; no C needed unless real decoding required |
| 3a | add_clip mediaId→track | P | add_clip → clip/add action-executor.ts:657-697 (duration falls back to 5s when metadata missing — pairs safely with a thin importer) | None | None |
| 4 | Trim clip to 0–5s | P | trim_clip → clip/trim, action-executor.ts:788-813; renderer honors inPoint (video-engine.ts:2181,2313) | None (pure model math; note F9 stale-base edge when both points move) | None |
| 5 | Add "Hello world" text | model P / pixels X | Tool create_text_clip registry.ts:15636-15677; raw lane text/create handlers/overlay.ts:42-63 mutates project.textClips ONLY; render reader titleEngine.getAllTextClips() video-engine.ts:1764-1776; self-documentation host.ts:250-256 | In headless, project.textClips is dead data: nothing registers clips into the titleEngine singleton the renderer/export read | One-lane fix either way: (a) implement HeadlessHost.createTextOverlay calling `titleEngine.createTextClip(...)` (same object web uses, engine-store.ts:186,197), or (b) make getActiveTextClips fall back to project.textClips filtered by text tracks — (b) fixes every environment at once (~15 LOC) |
| 6 | Export output.mp4 | X (C/D for pixels; plus upload coupling) | Job path: export_video → runJob exportVideo registry.ts:10595-10620; headless host fails w/o jobRunner headless-host.ts:72-83 (probe case 8); live impl export-job-runner.ts:184-214 (WebCodecs+mediabunny, browser/D); native ffmpeg desktop sidecar apps/desktop/src/main/sidecar/export-job.ts:33-72; cloud delegate gpu-job-runner.ts:107-186 | Entire frame pipeline needs OffscreenCanvas/ImageBitmap/(WebGPU)/WebCodecs — browsers only; presigned-URL delivery additionally needs desktop broker (window.openreel.gpu.uploadExport, export-job-runner.ts:151-153) | Minimal honest slice: Chromium (puppeteer/playwright) running the existing web job runner against a seeded project, saving the Blob to disk instead of uploading (skip step via a tiny patch or intercept download) → letter becomes C, no product-code change if downloads intercepted. Alternative: inject a JobRunner that shells out to an external ffmpeg build (A) but frame rendering STILL needs C — there is no Node compositor |
| 7 | ffprobe verification | X | Zero ffprobe usage anywhere; comment admits absence ffmpeg-fallback.ts:443; bundling ships only ffmpeg binaries (apps/desktop/resources/bin layout per ffmpeg-path.ts:11-20) | No binary and no orchestration exist | ~30 LOC Node child_process spawn of system/bundled ffprobe (container codec/duration match) — letter A once a binary source is chosen (system package or new bundle entry); frame/OCR verification likewise A (extract frame via ffmpeg → PNG, compare pixels or run OCR lib) — everything downstream exists in no form today |

Net: steps 1–5(except text pixels) are already P or one small adapter away; step 6 requires
Chromium (or a net-new Node compositor, which would be a major extraction item); step 7 is
greenfield but trivial once a container/codec oracle exists.

## GAPS

- G1 No headless pixel path: preview/every-export/`render_motion_frame` depend on
  OffscreenCanvas/createImageBitmap/WebCodecs/document. This is THE gap for an agent E2E
  slice that must observe its own output (F17, F18, probe evidence).
- G2 Overlay state split-brain between project arrays and engine singletons, including the
  export timeline-length calculation — headless text/shape work silently vanishes at
  render/export, and a text-only project would even fail with "Timeline is empty"
  (export-engine.ts:196-210 combined with F16) (F13-F16).
- G3 No tool-reachable import of local-bytes into headless library: desktop-only
  URL bridge + orphaned zero-metadata media/import action (F5-F7).
- G4 Serialized projects carry no media blobs (isPlaceholder on reload), so even a perfect
  headless renderer would face clip→blob=dead-reference across process boundaries
  (storage/project-serializer.ts:214-228,362-406).
- G5 No post-export verification surface: no ffprobe/tesseract/frame-compare anywhere;
  container-level contract (mp4/h264/aac) is asserted only by construction (G-gap feeds
  MEDIA-07).
- G6 Job delivery coupling: export_video's returned `data.url` exists only via desktop
  broker; plain-browser render results are dropped at upload (ok:false) rather than saved
  locally (F20).

## RISKS

- MEDIA-01 severity HIGH — First agent E2E slice cannot produce/observe output.mp4
  headlessly; requires Chromium harness (C) or a net-new Node compositor. Evidence: F18,
  F21, G1; probe case 8 (audit/probes/out/headless-smoke.json).
- MEDIA-02 severity HIGH — Overlay actions succeed-but-invisible outside the live web
  store (and text-only timelines break export length calc). Evidence: F13-F16, host.ts
  comment, G2. Probability HIGH if agent tools are driven against HeadlessHost.
- MEDIA-03 severity MEDIUM — import_media_from_url advertised generically but hard-gated
  to desktop; import_image_layer inherits the gate (catalog line 275). Blocks stock-media
  workflows for browser agents too, not just headless. Evidence: F5, F6.
- MEDIA-04 severity MEDIUM — clip/trim stale-base duration recompute when inPoint and
  outPoint change together shifts duration by ΔinPoint (off-by-shift trims).
  Evidence: F9, action-executor.ts:798-806.
- MEDIA-05 severity MEDIUM — media/import zeroes metadata → add_clip silently yields 5s
  default; combined with G4, headless round-trips lose blob+metadata integrity.
  Evidence: F7, F8, G4.
- MEDIA-06 severity LOW-MEDIUM — FFmpeg.wasm fallback fetches unpkg-hosted core at runtime
  (CDN availability + pinned-version supply-chain exposure) during import of
  unsupported codecs. Evidence: ffmpeg-fallback.ts:3,130-152.
- MEDIA-07 severity LOW — Verification gap (no ffprobe/OCR) means exported artifacts can
  only be trusted structurally, forcing external tooling into any QA story.
  Evidence: F24, G5.
- MEDIA-08 severity LOW — Cloud GPU runner returns only manifestURL; artifact retrieval /
  persistence is out-of-repo contract, unverifiable here. Evidence: F23, gpu-job-runner.ts
  terminal return.

## FACADE-NOTES

- The de-facto facade surface already exists and is headless-clean:
  `executeTool(name, args, EditingHost)` (packages/agent/src/executor.ts:32) +
  `toolDefs()` (registry.ts) + `EditingHost` interface (packages/agent/src/host.ts).
  A standalone MCP façade = this function wrapped in a transport; zero product edits.
- Host seams to fill for parity, mirroring LiveEditorHost's own workaround set
  (live-host.ts:489-761): importMediaFromUrl, createTextOverlay/createShapeOverlay family,
  exportMotionScene, motionRenderQueue. HeadlessHost implementing createTextOverlay via
  `titleEngine` closes the worst semantic trap (MEDIA-02) cheaply.
- Recommended JobRunner seam pattern is established: options.jobRunner injection
  (headless-host.ts:31, run.ts:44) vs DesktopApp's setJobRunner (DesktopApp.tsx:73). A
  `chromium-job-runner` slotting into the same interface upgrades the E2E slice from X to C
  without touching the registry.
- Transport note: desktop MCP listener gates destructive/expensive tools behind
  "trusted local auto-allow" (mcp-listener.ts:180-190) — an agent driver must account for
  CONFIRMATION_REQUIRED on export_video/confirm-class tools.
- Probe harness reuse: audit/probes/lib/{scan.mjs,openreel-loader.mjs} already boot the full
  editing closure in Node with two third-party stubs; extend headless-smoke.mjs with the
  classified E2E cases (import adapter, trim math incl. F9 regression, text-engine sync)
  before building adapters.
