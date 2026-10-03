# External network access

This page describes runtime requests made by the applications. Build-time
downloads, user-selected remote media URLs, and loopback desktop connections
are listed separately from first-party service requests.

## Configuration

| Setting | Effect | Default |
|---|---|---|
| `VITE_REELTERMINAL_CLOUD` | Disables first-party web cloud calls when set to `off`. | Enabled |
| `VITE_REELTERMINAL_CLOUD_URL` | Changes the web templates, sharing, and highlight service base URL. | `https://api.openreel.video` in production; `http://localhost:8787` in development |
| `VITE_REELTERMINAL_TRANSCRIBE_URL` | Changes the web transcription service base URL. | `https://cloud.openreel.video` |
| `VITE_REELTERMINAL_FFMPEG_CORE_URL` | Changes the FFmpeg.wasm core download location. | Package CDN URL |
| `VITE_REELTERMINAL_VIDSTAB_MT_URL`, `VITE_REELTERMINAL_VIDSTAB_ST_URL` | Change the multi-threaded or single-threaded stabilization core URL. | Package CDN URLs |
| `VITE_PUBLIC_POSTHOG_KEY`, `VITE_PUBLIC_POSTHOG_HOST` | Enables PostHog analytics when both values are set. | Off |
| `REELTERMINAL_CRASH_ENDPOINT` | Enables desktop crash reports when set to a valid HTTPS URL. | Off |
| `DASHSCOPE_API_KEY` | Enables Agent video review. | Unavailable |
| `REELTERMINAL_QWEN_BASE_URL` | Selects the approved Qwen-compatible review endpoint. | Alibaba DashScope |
| `VITE_API_URL` | Sets the Studio marketplace API base URL. | `http://localhost:8787` |

Legacy environment names are accepted only where the corresponding component
implements an alias. Current names take precedence when both are defined.

## Web editor

| Destination | Trigger | Data sent | Controls |
|---|---|---|---|
| Google Fonts (`fonts.googleapis.com`, `fonts.gstatic.com`) | Browser page load. | IP address, user agent, referrer, and requested font families. | The hosted web editor uses the fixed Google Fonts stylesheet. Desktop packages use local fonts. |
| PostHog host | When both PostHog environment values are configured. | Product event names and properties. | Omit either value to disable analytics. |
| `api.openreel.video` | Cloud template reads, template publishing, highlight analysis, or share-service calls. | Reads send request metadata; publishing sends template JSON; highlight analysis sends transcript text and audio metrics; share upload sends the selected video. | `VITE_REELTERMINAL_CLOUD=off` disables first-party cloud calls. No editor screen currently invokes share upload. |
| `cloud.openreel.video` | Cloud transcription. | Extracted clip audio and language settings. | The cloud action is labeled; the UI discloses audio upload before submission. The cloud switch disables the action. |
| Whisper model host (`media.openreel.video/models/`) | Opening auto-captions and loading a model. | Model files only; recognition runs locally. | No URL override or disable switch. |
| FFmpeg.wasm CDN (`unpkg.com`) | First operation that needs the fallback core. | Core files only. | `VITE_REELTERMINAL_FFMPEG_CORE_URL` changes the download location; the fallback cannot be disabled. |
| Vidstab CDN (`mediashares.openreel.video`) | Enabling video stabilization. | Core files only. | The two `VITE_REELTERMINAL_VIDSTAB_*_URL` settings change download locations; stabilization requires a core. |
| Google model storage, `unpkg.com`, and `cdn.jsdelivr.net` | First use of person segmentation. | Model and WebAssembly files only. | No URL override or disable switch. |
| `esm.sh/mediabunny` | Only when the bundled `mediabunny` import fails. | Package files only. | No URL override or disable switch. |
| `threejs.org` | Loading the default 3D text font. | Font data only. | No URL override or disable switch. |
| URLs stored in a project | Import, preview, or render of project media with a remote URL. | A GET request to the URL's host. | Controlled by the project content. The target site receives the request metadata. |

## Desktop editor

| Destination | Trigger | Data sent | Controls |
|---|---|---|---|
| Configured crash endpoint | An uncaught application error, when `REELTERMINAL_CRASH_ENDPOINT` or its legacy alias contains a valid HTTPS URL. | Only `type`, `appVersion`, `platform`, and `electronVersion`. Event type is allowlisted or reported as `unknown`. | No endpoint is configured by default. Local error details remain in local diagnostics; `message`, `stack`, and `context` are not uploaded. |
| GitHub Releases | Packaged app startup checks for an update. | Application version and platform metadata. | There is no update-check disable switch. Download and installation require user action. |

## Studio and image apps

| Application | Destination | Trigger and data | Controls |
|---|---|---|---|
| `apps/studio` | jsDelivr and Google model storage | Loading MediaPipe code, WebAssembly, and models for subject or face previews. No user media is sent. | No URL override or disable switch. |
| `apps/studio` | `VITE_API_URL` marketplace service | Listing, saving, validating, or submitting drafts sends graph JSON, titles, and manifests. Requests include the configured client identity headers. | Change the service base URL; requests and identity headers have no disable switch. |
| `apps/image` | Google Fonts | Loading the app and its font choices sends request metadata and requested families. | No URL override or disable switch. |
| `apps/image` | IMG.LY model/CDN hosts | First use of background removal downloads WebAssembly and model files. The image is processed locally. | The app uses the package's default asset host. |

## Agent video review

Desktop Agent video review is opt-in through `DASHSCOPE_API_KEY`. It sends a
bounded inspection copy of the video and the review question to the configured
Qwen-compatible endpoint. The endpoint is restricted to approved HTTPS hosts.
See [Cloud video review](CLOUD-VIDEO-REVIEW.md).

## Uploads

| Action | Content sent | User disclosure |
|---|---|---|
| Cloud transcription | Extracted audio | The action is labeled as cloud and the UI discloses the upload. |
| Template publishing | Template name, description, and timeline structure | The save dialog identifies publication to the shared template service. |
| Highlight analysis | Transcript text and audio metrics | The UI shows progress and failures. |
| Agent video review | Bounded video copy and review question | The feature requires the user's provider credential. |
| Crash reporting | Event category and application/platform versions | Disabled unless a valid HTTPS endpoint is explicitly configured. |
| PostHog analytics | Product event names and properties | Disabled unless both build-time values are configured. |
