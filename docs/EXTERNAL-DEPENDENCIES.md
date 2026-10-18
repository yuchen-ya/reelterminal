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
| Agent audio analysis and loudness normalization | Local native FFmpeg/ffprobe, resolved from `REELTERMINAL_FFMPEG_PATH` / `REELTERMINAL_FFPROBE_PATH` or PATH. Loudness work requires `loudnorm`. No model download or audio upload; derived WAV/provenance remain in persistent local media roots. See [Audio normalization](AUDIO-NORMALIZATION.md). |
| Agent denoise and sync-offset analysis | Local native FFmpeg/ffprobe only (`afftdn`/`adeclick`/GCC-PHAT); no model download and no audio upload. See [Audio denoise](AUDIO-DENOISE.md) and [Material analysis](MATERIAL-ANALYSIS.md). |
| Agent speech transcription (`speechTranscript`) | Optional Python runtime (explicit `REELTERMINAL_AUDIO_MODELS_PYTHON`; the app never runs pip). After explicit `transcriptParams.allowModelDownload:true`, funasr/modelscope downloads the pinned SenseVoice-Small weights (936 291 369 bytes, sha256-pinned, Apache-2.0) from ModelScope into `~/.reelterminal/models/modelscope` (or `REELTERMINAL_MODELSCOPE_CACHE`); a local copy can be supplied with `REELTERMINAL_SENSEVOICE_MODEL_DIR`. Recognition runs locally; no audio is uploaded. Missing runtime/model is reported unavailable with the download/disk requirement. See [Audio transcript](AUDIO-TRANSCRIPT.md). |
| Agent speech-activity analysis (VAD) | Silero VAD v5.1.2 (MIT, 2.2 MiB, sha-pinned) from the locked `snakers4/silero-vad` GitHub tag, downloaded once on first `speechActivity` analysis into `~/.reelterminal/models/`, or supplied via `REELTERMINAL_VAD_MODEL`. Inference runs locally through the optional `onnxruntime-node` package (MIT); no audio upload. Capabilities report unavailable until the runtime and pinned model are present. |
| Person/face segmentation | Public Google model storage, unpkg and jsDelivr downloads; processing stays local. |
| FFmpeg.wasm fallback | `unpkg.com/@ffmpeg/core@0.12.6`; downloads code/WASM, not user media. Native FFmpeg is supplied by the user on PATH. |
| Fonts | Desktop packages local fonts. Web/Image/Studio Google Fonts requests and the core Three.js font download remain. |
| Mediabunny fallback | `esm.sh/mediabunny` only if the bundled import fails. |
| Cloud templates, share uploads, cloud highlighter/transcription | Disabled. No default backend URL. Local templates, caption recognition and subtitle import remain available. |
| Stabilization | Disabled without a deployment-supplied vidstab core; no private CDN default. |
| Studio marketplace | Unused submission/API clients removed. Studio editing and package export remain local. |
| Studio samples | Catalog empty; import your own footage. No upstream footage or CDN is supplied. |
| Product analytics | PostHog and tracking calls removed. |
| Updates | Packaged app checks this project's GitHub Releases. Download requires user action; once downloaded, the update installs on the next normal quit after the unsaved-changes guard. Signed installer/update acceptance remains pending. |

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
| `REELTERMINAL_AUDIO_MODELS_PYTHON` | Explicit Python interpreter for optional audio models (SenseVoice speech transcript). The app never installs packages. | Unset / unavailable |
| `REELTERMINAL_SENSEVOICE_MODEL_DIR` | Local pinned SenseVoice-Small directory; bypasses the ModelScope download but is still sha-verified. | `~/.reelterminal/models/modelscope/models/iic/SenseVoiceSmall` |
| `REELTERMINAL_MODELSCOPE_CACHE` | ModelScope cache used when a consented download runs. | `~/.reelterminal/models/modelscope` |
| `REELTERMINAL_QWEN_BASE_URL` | Selects an approved Alibaba review endpoint. | Alibaba DashScope |
| `REELTERMINAL_CRASH_ENDPOINT` | Enables minimal desktop crash reports to a deployment-owned HTTPS endpoint. | Off |

Cloud configuration reads the canonical `VITE_REELTERMINAL_*` variables above;
removed upstream cloud-variable aliases do not restore a backend URL.
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

Silero VAD v5.1.2 (AUD-01) is implemented with the pinned weights above and
the MIT-licensed `onnxruntime-node` package; its notices enter the generated
third-party list at package-build time. The 1.2.2 Windows x64 build packages
the runtime correctly (`onnxruntime-node` and `onnxruntime-common` unpacked in
`app.asar.unpacked`, the win32/x64 NAPI binding beside them, other OS and
unused arch binaries pruned). The macOS and Linux configurations keep their
own platform binary and prune the non-target arch after pack instead of
applying the Windows-only prune, but those installers still need the same load
check on their own platforms before they are represented as VAD-capable.

Planned SenseVoice, DeepFilterNet, speaker separation and other audio backends
in [AUDIO-TODO.md](AUDIO-TODO.md) are not installed or enabled. Their model
delivery, platform support, rights and network behavior must be verified and
documented if implemented; the existing Whisper workflow above remains
distinct.

See [Asset rights review](ASSET-LICENSE-REVIEW.md). Removed sample footage and
retired private mirrors are not default release dependencies. FFmpeg core
artifact/source/license records and the remaining npm notice gaps still need
review before an installer is represented as fully cleared for distribution.
