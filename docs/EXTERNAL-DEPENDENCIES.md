# External dependencies — runtime outbound network access

This page lists every runtime outbound network destination in ReelTerminal: what
triggers it, what data it sends, which configuration overrides exist, whether it
can be turned off, and what happens when it fails. It describes **implemented
behavior only** — configuration switches that do not exist in the code are not
offered here, and follow-up ideas are labeled planned.

Scope is runtime traffic of the shipped apps (`apps/web`, `apps/desktop`,
`apps/studio`, `apps/image`, and the desktop agent path). Build-time downloads
(e.g. the `ffmpeg-static` fetch and the Chromium runtime download) and the
loopback desktop↔agent connection (`127.0.0.1`) are not outbound dependencies in
this sense and are not counted below.

The web cloud switch and URL overrides live in
`apps/web/src/config/api-endpoints.ts`; sample entries are in
[`apps/web/.env.example`](../apps/web/.env.example).

## Configuration

| Variable | Effect | Default when unset |
|---|---|---|
| `VITE_REELTERMINAL_CLOUD` | Domain-level kill switch for all first-party web cloud calls (cloud templates read + publish, sharing, transcription, highlight AI). Only the exact value `off` (case-insensitive) disables; there is deliberately no "enable" value. When off, affected features short-circuit before constructing a request and say so in the UI. Legacy `VITE_OPENREEL_CLOUD` is still read when the new name is unset. | Cloud calls enabled |
| `VITE_REELTERMINAL_CLOUD_URL` | Base URL override for the cloud API (templates, sharing, highlight AI). Legacy `VITE_OPENREEL_CLOUD_URL` is still read when the new name is unset. | `http://localhost:8787` in dev, `https://api.openreel.video` in production builds |
| `VITE_CLOUD_API_URL` | Compatibility alias for the same override; lowest priority — `VITE_REELTERMINAL_CLOUD_URL` (then legacy `VITE_OPENREEL_CLOUD_URL`) wins when both are set. | — |
| `VITE_REELTERMINAL_TRANSCRIBE_URL` | Base URL override for the transcription (GPU) service. Legacy `VITE_OPENREEL_TRANSCRIBE_URL` is still read when the new name is unset. | `https://cloud.openreel.video` |
| `VITE_REELTERMINAL_FFMPEG_CORE_URL` | Download-location override for the FFmpeg.wasm fallback core (W9); point it at a mirror or self-hosted copy. No legacy name. | Built-in CDN location |
| `VITE_REELTERMINAL_VIDSTAB_MT_URL` + `VITE_REELTERMINAL_VIDSTAB_ST_URL` | Download-location overrides for the multi-threaded / single-threaded vidstab cores (W10). No legacy names. | Built-in CDN locations |
| `VITE_PUBLIC_POSTHOG_KEY` + `VITE_PUBLIC_POSTHOG_HOST` | PostHog product analytics. Both must be set for analytics to load at all. | Analytics off |
| `DASHSCOPE_API_KEY` | Opt-in credential (read from the desktop host environment, never bundled) for the agent video-review cloud opinion. Without it the review tool fails before any request. | Feature unavailable |
| `REELTERMINAL_QWEN_BASE_URL` | Endpoint override for video review; restricted to official Alibaba compatible-mode/v1 HTTPS endpoints by an allowlist. | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `REELTERMINAL_VIDEO_REVIEW_PROVIDER` | Selects the review provider from the registry (currently only the Qwen provider exists). | Default provider |
| `REELTERMINAL_CRASH_ENDPOINT` | Address for desktop crash reports. **Changing the address is the only effect — there is no value that turns crash reporting off.** Legacy `OPENREEL_CRASH_ENDPOINT` is still read when the new name is unset. | `https://api.openreel.video/crash` |
| `VITE_API_URL` | Base URL for the studio marketplace API (a service outside this repository). | `http://localhost:8787` |

`VITE_*` variables are read at build time (Vite static replacement), so they
shape the built bundle rather than a runtime settings file.

## Outbound endpoints

Type: **request** = executable HTTP request; **resource** = model/asset
download; **telemetry** = usage or error reporting. Identifiers (W1, D1, …)
match the readiness investigation matrix for traceability.

### Web app (`apps/web`)

| # | Outbound | Type | Trigger | Data sent | Override / can it be disabled | If it fails |
|---|---|---|---|---|---|---|
| W1 | Google Fonts (`fonts.googleapis.com`, `fonts.gstatic.com`) | resource | Page load, every visit | IP/UA/referer + the requested font families (~60) | **None — cannot be disabled**; host is hardcoded in `index.html` | Browser falls back to system fonts silently |
| W2 | PostHog host (from env) | telemetry | Only if both PostHog env vars are set (default off) | Anonymous event names/properties, page views | Not setting either var disables it | Silent (capture never throws) |
| W3 | Cloud template reads (`GET /templates/scriptable`, `GET /templates`) | request | Welcome gallery mounts; template browser panel opens | No body; visitor IP and feature usage exposed | `VITE_REELTERMINAL_CLOUD=off` skips the request; URL via `VITE_REELTERMINAL_CLOUD_URL` | Visible failed state with a manual retry (distinct from "no templates") |
| W4 | Cloud template publish (`POST /templates`) | request | Saving a template with the Cloud location selected | Template JSON (name, description, timeline structure) | Kill switch disables the Cloud option in the save dialog; URL override as W3 | Error surfaced in the save dialog |
| W5 | Share service (`POST /shares`, share reads, `GET /health`) | request | Share upload / viewing a share page | Upload: the exported video file. Reads: nothing beyond the request | Kill switch short-circuits before any XHR; URL override as W3 | Upload rejects with an explicit message; health check returns false silently. At HEAD no web UI invokes the upload function — only the share *view* path is wired up |
| W6 | Cloud transcription (`/transcribe`, `/jobs/{id}` polling) | request | "Generate Captions (Cloud)" / highlight analysis | The clip's extracted audio (WAV) + language settings | Kill switch disables the button with an explanation; URL via `VITE_REELTERMINAL_TRANSCRIBE_URL` | Failures show a classified title (network / server with status / rate limit / timeout / unparseable response / cloud task failed) with the raw error as a secondary detail line, plus a manual Retry button; the upload times out after 120 s and repeated consecutive polling failures surface a visible failure instead of silently waiting; a Cancel button aborts the run with no error and no captions |
| W7 | Highlight AI (`POST /highlights`) | request | Running highlight analysis (after transcription) | Transcript text with timestamps, audio energy metrics, duration, preferences | Kill switch disables the action with an explanation; URL override as W3 | Classified failure message with a manual Retry button; the submit request times out after 120 s |
| W8 | Whisper model host (`https://media.openreel.video/models/`) | resource | Opening auto-captions / loading a model | No user data (model download only) | **None — cannot be disabled**; host hardcoded, local models are disabled in the worker config | Per-file download progress. Download failures show a classified banner (network unreachable / HTTP status / storage problem) with the original message as a secondary detail line and a manual Retry button, rendered directly under the model download button; unclassified failures keep the raw message and offer no retry. The model is downloaded once and caption recognition always runs locally in the browser — media and transcripts are not uploaded by this path. WebGPU→WASM fallback; no automatic retry |
| W9 | FFmpeg.wasm core (`https://unpkg.com/@ffmpeg/core@0.12.6/...`) | resource | First transcode/probe/audio-extract that needs the fallback core (~31 MB wasm) | No user data | URL via `VITE_REELTERMINAL_FFMPEG_CORE_URL` (mirror or self-hosted copy); **cannot be disabled** | Load errors surface as toasts in affected flows; no automatic retry |
| W10 | Vidstab cores (`https://mediashares.openreel.video/ffmpeg-vidstab/…`) | resource | Enabling stabilization | No user data | URLs via `VITE_REELTERMINAL_VIDSTAB_MT_URL` / `VITE_REELTERMINAL_VIDSTAB_ST_URL`; **cannot be disabled** | Download progress is shown; failure throws a load error |
| W11 | Person segmentation (Google model storage ×2, `unpkg.com` and `cdn.jsdelivr.net` tasks-vision @0.10.35) | resource | Behind Subject / background removal first use (agent-applied `clip.setBackgroundRemoval` rendering also requires this model — the download stays GUI-first-use triggered; headless rendering of the effect has no MediaPipe runtime and keeps the original background) | No user data (model + wasm download) | **None — cannot be disabled**; 4 URLs hardcoded | Visible error and the toggle rolls back (Behind Subject entry). Auto Reframe does NOT use this download — its analysis is the local skin-region color heuristic in `packages/core/src/ai/auto-reframe-engine.ts` |
| W12 | mediabunny CDN fallback (`https://esm.sh/mediabunny@1.25.3`) | resource | Only when the bundled `mediabunny` import throws | No user data | **None — cannot be disabled** | Loss of parallel decode is now observable state in the engine store; the fetch itself still fails silently |
| W13 | 3D text default font (`https://threejs.org/examples/fonts/helvetiker_bold.typeface.json`) | resource | Rendering a 3D text object with the default font | No user data | **None — cannot be disabled** | A stage notice now reports the failure with an explicit manual retry; rendering skips the 3D text |
| W14 | Remote assets referenced by the project (`asset.url` / `originalUrl`) | request | A project references remote URLs and playback/rendering needs them | GET to the target host (referer reveals usage) | Only by not putting remote URLs in the project — no code-level switch | Silently skipped (placeholder) |

### Desktop app (`apps/desktop`)

| # | Outbound | Type | Trigger | Data sent | Override / can it be disabled | If it fails |
|---|---|---|---|---|---|---|
| D1 | Crash reports (`https://api.openreel.video/crash`) | telemetry | Any uncaught exception, unhandled rejection, or renderer/child-process death | Error message (≤8 KB) / stack (≤16 KB), app version, platform/CPU/OS/Electron versions, timestamp | `REELTERMINAL_CRASH_ENDPOINT` changes the address only — **cannot be disabled** | Silent; 4 s timeout, never escalates a crash |
| D2 | Update check (`github.com/yuchen-ya/reelterminal/releases`) | request | Packaged builds only, at launch; downloading needs explicit user confirmation | Version/platform metadata | **No skip switch**; dev runs are a no-op | Error state broadcast to the renderer UI |

### Studio (`apps/studio`, experimental)

| # | Outbound | Type | Trigger | Data sent | Override / can it be disabled | If it fails |
|---|---|---|---|---|---|---|
| S1 | DetectorPool (jsdelivr `@mediapipe/tasks-vision@0.10.35` wasm, pinned to the npm dependency, plus Google face/segmenter models) | resource | Enabling subject/face preview in the effect view | No user data | **None — cannot be disabled**; hosts hardcoded | Errors propagate to the preview engine |
| S2 | Marketplace API (`VITE_API_URL`, default `http://localhost:8787`; service outside this repository) | request | Opening blueprint/asset lists, saving, validating, submitting drafts | Graph JSON, titles, manifest; **every request carries hardcoded identity headers** (`X-User-Id: u-studio`, `X-Creator-Id: c-studio`, `X-Creator-Handle: augani`) | `VITE_API_URL` changes the target; the identity headers and the requests themselves **cannot be disabled** | Errors thrown with method, path, and status |

### Image (`apps/image`, experimental / dormant)

| # | Outbound | Type | Trigger | Data sent | Override / can it be disabled | If it fails |
|---|---|---|---|---|---|---|
| I1 | Google Fonts (`fonts.googleapis.com` static CSS + dynamic per-font CSS and preloads) | resource | Page load; selecting/previewing fonts | IP/UA + font families and weights | **None — cannot be disabled** | Page CSS falls back silently; dynamic loads reject visibly |
| I2 | `@imgly/background-removal` default CDN | resource | One-click background removal | No user data (wasm + model download; the image itself is processed locally) | **None — cannot be disabled**; the package's `publicPath` override point exists but is not used | Progress is visible; failure propagates to the caller |

### Desktop agent path (`packages/agent-facade`)

| # | Outbound | Type | Trigger | Data sent | Override / can it be disabled | If it fails |
|---|---|---|---|---|---|---|
| A1 | Agent video review (Alibaba DashScope compatible-mode endpoint) | request | Only a desktop-agent `reviewVideo` task **with** `DASHSCOPE_API_KEY` configured | A bounded inspection copy (≤20 s, ≤12 MB, 720p h264, base64) + the review question; bearer credential in the header | Opt-in by design: without the key no request is made; endpoint restricted to official Alibaba hosts | `FacadeError`, 120 s timeout, concurrency cap 2; provider error bodies are not surfaced |

Links that are plain navigation, not requests: the mobile blocker links to
`https://openreel.video` only on click, and share page URLs are string-built
from `window.location` or the desktop preload origin.

## Uploads

What leaves the machine, where it goes, and what the UI currently discloses
before the upload:

| Action | Receiver | Content sent | Disclosure in the current UI |
|---|---|---|---|
| Cloud transcription | `cloud.openreel.video` `/transcribe` (self-operated GPU worker) | The clip's extracted audio | Button is labeled "(Cloud)" and a notice above it states the audio upload before you click |
| Template publish | `api.openreel.video` `/templates` | Template JSON (name, description, timeline structure) | The save dialog states that Cloud save publishes to the public cloud template library where others can browse and use it |
| Highlight AI | `api.openreel.video` `/highlights` | Transcript text + audio energy metrics | No purpose notice before the upload; progress and failure messages are shown |
| Share upload | `api.openreel.video` `/shares` | The exported video file | Kill-switch covered; no disclosure UI, and at HEAD no web UI invokes the upload path |
| Agent video review | The user-configured DashScope endpoint | Bounded ≤20 s / ≤12 MB inspection copy | Opt-in with the user's own key; see [`CLOUD-VIDEO-REVIEW.md`](CLOUD-VIDEO-REVIEW.md) |
| Crash reports | `api.openreel.video` `/crash` | Error messages/stacks + platform versions | No notice and no switch (see limitations) |
| PostHog events | The env-configured PostHog host | Anonymous events and page views | Off unless both env vars are set; no in-app toggle |
| Studio marketplace drafts | `VITE_API_URL` (out-of-repo service) | Graph JSON + fixed identity headers | No disclosure of the hardcoded identity headers beyond this page |

## Known limitations

The following are accurate statements about the current code, not promises:

- **Google Fonts (W1, I1) fire on page load in web and image and cannot be
  disabled or redirected by any configuration.** The only mitigation is
  network-level blocking; the apps then render with system fonts.
- **Model and asset hosts cannot be disabled**: the whisper model host (W8),
  the FFmpeg.wasm unpkg core (W9), the vidstab CDN (W10), the
  person-segmentation URLs (W11), the mediabunny esm.sh fallback (W12), the 3D
  text font (W13), the studio DetectorPool (S1), and the imgly default CDN (I2)
  all load from fixed locations. W9 and W10 accept download-location overrides
  (`VITE_REELTERMINAL_FFMPEG_CORE_URL`, `VITE_REELTERMINAL_VIDSTAB_*_URL`) for
  mirrored or self-hosted copies; the rest have no override switch. Self-hosting
  or offline-packing them is planned follow-up work recorded in the readiness
  plan, not an existing capability.
- **Desktop crash reporting cannot be turned off.** `REELTERMINAL_CRASH_ENDPOINT`
  only redirects where reports go, and reports are silent.
- **The desktop update check has no skip switch** in packaged builds; only the
  download step asks for confirmation.
- **The studio marketplace client always attaches hardcoded identity headers**
  (S2) and has no switch to omit them.
- **Changing a URL is not an API-compatibility guarantee.** The overrides point
  at different deployments of the same service contract; pointing them at
  unrelated servers will fail in feature-specific ways.
- Several cloud reads that are disabled by the kill switch degrade to clearly
  explained disabled UI; but the non-cloud resource downloads above have no
  such switch at all.
