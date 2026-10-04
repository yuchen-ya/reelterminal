# External network access

ReelTerminal ships as a local editor. The publisher operates no template,
sharing, transcription, marketplace, model-mirror or stabilization service.
There are no default runtime requests to the upstream hosted services. Public resource
downloads and user-configured provider requests are described below.

## Default behavior

| Capability | Default delivery |
|---|---|
| Import, edit, save, export, local templates | Local application and files; no cloud backend required. |
| Whisper captions | ONNX Community models downloaded directly from Hugging Face by Transformers.js; recognition runs locally. The existing model choices and browser cache remain. First-use download requires network access. |
| Person/face segmentation | Public Google model storage, unpkg and jsDelivr downloads; processing stays local. |
| FFmpeg.wasm fallback | `unpkg.com/@ffmpeg/core@0.12.6`; downloads code/WASM, not user media. Native FFmpeg is supplied by the user on PATH. |
| Fonts | Desktop packages local fonts. Web/Image/Studio Google Fonts requests and the core Three.js font download remain. |
| Mediabunny fallback | `esm.sh/mediabunny` only if the bundled import fails. |
| Cloud templates, share uploads, cloud highlighter/transcription | Disabled. No default backend URL. Local templates, caption recognition and subtitle import remain available. |
| Stabilization | Disabled without a deployment-supplied vidstab core; no private CDN default. |
| Studio marketplace | Unused submission/API clients removed. Studio editing and package export remain local. |
| Studio samples | Catalog empty; import your own footage. No upstream footage or CDN is supplied. |
| Product analytics | PostHog and tracking calls removed. |
| Updates | Packaged app checks this project's GitHub Releases. Download and installation require user action; signed installer/update acceptance remains pending. |

Resource GET requests disclose ordinary request metadata (IP, user agent and
possibly referrer). They do not upload the edited clip. Remote URLs contained
in user projects contact their chosen hosts when loaded.

## Explicit optional integrations

| Setting | Effect | Default |
|---|---|---|
| `VITE_REELTERMINAL_CLOUD` | Only `on` opts in to a deployment-owned cloud integration. | Off |
| `VITE_REELTERMINAL_CLOUD_URL` | Backend for template reads/publishing, sharing and highlight analysis. Required before these capabilities enable. | Empty |
| `VITE_REELTERMINAL_TRANSCRIBE_URL` | Cloud transcription backend. Required independently before its action enables. | Empty |
| `VITE_REELTERMINAL_FFMPEG_CORE_URL` | Overrides the public FFmpeg core download base. | Package CDN |
| `VITE_REELTERMINAL_VIDSTAB_MT_URL`, `VITE_REELTERMINAL_VIDSTAB_ST_URL` | Supply the appropriate licensed core for the browser's thread mode. | Empty / disabled |
| `DASHSCOPE_API_KEY` | Enables the user's optional Agent video review provider. Explicit upload authorization is still required. | Unavailable |
| `REELTERMINAL_QWEN_BASE_URL` | Selects an approved Alibaba review endpoint. | Alibaba DashScope |
| `REELTERMINAL_CRASH_ENDPOINT` | Enables minimal desktop crash reports to a deployment-owned HTTPS endpoint. | Off |

Existing cloud environment aliases retain their precedence for explicit
configured deployments. They no longer restore an upstream default URL.
The application does not provide or promise those optional hosted services.

An enabled cloud action sends the content selected for that action: template
JSON, a shared video, transcript/audio metrics, or transcription audio. Agent
video review sends a bounded video excerpt and question using the user's key;
see [Cloud video review](CLOUD-VIDEO-REVIEW.md). Configuring a provider key alone
does not authorize uploading every file.

Crash reporting sends only an allowlisted event category and app/platform
versions when its endpoint is configured; error message, stack and context
remain local.

## Rights and release records

See [Asset rights review](ASSET-LICENSE-REVIEW.md). Removed sample footage and
retired private mirrors are not default release dependencies. FFmpeg core
artifact/source/license records and the remaining npm notice gaps still need
review before an installer is represented as fully cleared for distribution.
