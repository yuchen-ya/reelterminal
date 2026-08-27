# Media / Render / Export Map

Baseline `2566c34e0f8ea22992a85f3ff16e048307b49365`. Primary evidence:
`audit/areas/media-render-e2e.md` (F1-F25), probe `audit/probes/out/headless-smoke.json`.

## Pipeline map

### 1. Import
| Aspect | Reality | Evidence |
|---|---|---|
| UI path | drag-drop/picker → store `importMedia(file)` → MediaBridge → `MediaImportService` | media-render-e2e.md F1, §Import |
| Metadata probe | pure-TS demux via mediabunny `Input({source: BlobSource})` → duration/dims/fps/codec | F2 (`mediabunny-engine.ts:397-478`) |
| Browser-only branches | thumbnails (`document.createElement("canvas")`), MOV check (`HTMLVideoElement`) | F3 |
| Agent tool | `import_media_from_url` → **desktop-only** bridge `window.openreel.media.fetchUrl` | F5-F6 |
| Core action | `media/import` exists but stores ZEROED metadata and is mapped from **no tool** | F7 |
| Model authority | direct store write, **bypasses ActionExecutor** (undo-exempt) | F4 |
| Headless state | starved — no fs/Blob ingest path | agent-runner-headless.md §TOOL-VIABILITY |

### 2. Trim
`trim_clip` tool → action `clip/trim` → executor case (action-executor.ts:788-813): sets
inPoint/outPoint, duration = out−in. Pure model math — works in every host. Known edge:
stale-base recompute when BOTH points change in one action (MEDIA-04).

### 3. Text overlay ("Hello world")
Two lanes, divergent:
- **Live lane**: `create_text_clip` tool → `LiveEditorHost.createTextOverlay` → store →
  `titleEngine` singleton + history mirror. Renders.
- **Raw lane**: `text/create` action → `project.textClips` only → **renders nothing**
  (documented `host.ts:250-263`; probe case 5-6).
Render reader: `VideoEngine.getActiveTextClips()` ← `titleEngine.getAllTextClips()`
(video-engine.ts:1764-1776; also requires a visible `type:"text"` track, :1766-1771);
export duration calc reads the same singleton (export-engine.ts:1211) — a text-only headless
project fails export with "Timeline is empty". Nuance from adversarial review (NF-1): raw
overlay actions DO grow the **stored** `project.timeline.duration` (calculateProjectDuration
includes textClips, project-duration.ts:19-25, runs after every action) — model length and
exported length diverge, so duration is not a trustworthy proxy for what exports.

### 4. Preview
`Preview.tsx` (8,453 lines) Canvas2D compositor, 150ms debounce on `project.modifiedAt`;
RenderBridge → `VideoEngine.renderFrame` (OffscreenCanvas) used mainly for export/effects;
WebGPU/three.js are best-effort accelerators with 2D fallbacks. **No Node implementation of
any stage** (F17, F18). Cheapest headless-preview route: consolidate on
`VideoEngine.renderFrame` (no React) — still requires OffscreenCanvas/createImageBitmap or a
canvas polyfill.

### 5. Export
| Environment | Encoder | Muxer | Delivery | Evidence |
|---|---|---|---|---|
| Browser (live) | WebCodecs `VideoEncoder` (h264/vp9/h265 per container) | mediabunny `Output`+Mp4/WebM/Mov | showSaveFilePicker / download; agent path additionally needs desktop broker upload (`gpu.uploadExport`) | F20-F21 |
| Desktop | bundled native ffmpeg sidecar (libx264/aac, ProRes) fed RGBA over IPC | ffmpeg | file on disk | F21 |
| Headless | **nothing** — `runJob` fails w/o JobRunner (probe case 8); `createGpuJobRunner` = HTTPS client to external GPU infra returning manifestURL only | — | broker-side manifest | F22-F23 |

FFmpeg.wasm (@ffmpeg/core 0.12.6 from **unpkg CDN**) is import-fallback only, never export
(MEDIA-06). No ffprobe/OCR/frame-compare tooling anywhere in repo (F24).

## Environment dependency summary

| Capability | Pure Node | Browser | Desktop Electron |
|---|---|---|---|
| Project model edits (tracks/clips/trim/markers/…) | ✅ probe-proven | ✅ | ✅ |
| Media import w/ metadata | needs ~50 LOC adapter (fs→File→mediabunny) | ✅ | ✅ |
| Overlay text that renders | ❌ engine-sync adapter needed | ✅ | ✅ |
| Frame render / preview | ❌ no compositor | ✅ Canvas2D/OffscreenCanvas | ✅ |
| mp4 export | ❌ (cloud GPU runner = external service) | ✅ WebCodecs | ✅ native ffmpeg |
| Post-export verification | ❌ greenfield (trivial once ffprobe binary chosen) | ❌ | ffmpeg bundled, no ffprobe wired |
