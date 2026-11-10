# External network access

ReelTerminal ships as a local editor. The publisher operates no template,
sharing, transcription, marketplace or stabilization backend. Fixed model
resources for source builds are published separately on this project's GitHub
Releases; the application does not fetch them at startup.
There are no default runtime requests to the upstream hosted services. Public resource
downloads and user-configured provider requests are described below.

## Default behavior

| Capability | Default delivery |
|---|---|
| Import, edit, save, export, local templates | Local application and files; no cloud backend required. |
| Task-review Agent | Optional requests to the model endpoint configured by the user. A task/source grant is required before its text is sent; setting a key alone does not grant access. Keys are encrypted locally with Electron safeStorage and used for authorized requests to that endpoint. Manual review remains available without a model or key. |
| Task-review region segmentation | The desktop package includes the pinned MobileSAM split ONNX models and Apache-2.0 notices. CPU inference stays local; region segmentation does not upload images or download models at startup. |
| Private Free Boards (Markdown, local HTML, web URL containers) | Markdown and local HTML imports retain only referenced local assets inside the document directory and generate initial HTML snapshots in an isolated Chromium view with network access disabled. Standalone HTTP/S URL containers display only the URL until the user explicitly clicks **Enter browse**, which loads the remote page in an isolated Chromium content view (no Node/preload access, no downloads or permission grants). See [Free Boards guide](HUMAN-BOARDS.zh-CN.md). |
| Local Qwen/SenseVoice captions | Optional user-configured Python interpreters and local Qwen ASR/ForcedAligner model directories; SenseVoice also needs its local runtime/model. The caption worker uses CPU float32 and local files only. No model weights are bundled and the app does not run pip. Settings reports missing components and provides setup guidance. Recognition and alignment stay local. See [user help](USER-GUIDE.md). |
| Legacy browser Whisper captions | The old desktop/browser Whisper download UI has been removed in favor of local Qwen/SenseVoice captions; any remaining browser-only Transformers.js fallback contacts Hugging Face only if explicitly invoked outside the desktop caption UI. |
| Agent audio analysis and loudness normalization | Local native FFmpeg/ffprobe, resolved from `REELTERMINAL_FFMPEG_PATH` / `REELTERMINAL_FFPROBE_PATH` or PATH. Loudness work requires `loudnorm`. No model download or audio upload; derived WAV/provenance remain in persistent local media roots. See [Audio normalization](AUDIO-NORMALIZATION.md). |
| Agent denoise and sync-offset analysis | Local native FFmpeg/ffprobe only (`afftdn`/`adeclick`/GCC-PHAT); no model download and no audio upload. See [Audio denoise](AUDIO-DENOISE.md) and [Material analysis](MATERIAL-ANALYSIS.md). |
| Agent speech transcription (`speechTranscript`) | Optional Python runtime (explicit `REELTERMINAL_AUDIO_MODELS_PYTHON`; the app never runs pip). After explicit `transcriptParams.allowModelDownload:true`, funasr/modelscope downloads the pinned SenseVoice-Small weights (936 291 369 bytes, sha256-pinned, Apache-2.0) from ModelScope into `~/.reelterminal/models/modelscope` (or `REELTERMINAL_MODELSCOPE_CACHE`); a local copy can be supplied with `REELTERMINAL_SENSEVOICE_MODEL_DIR`. Recognition runs locally; no audio is uploaded. Missing runtime/model is reported unavailable with the download/disk requirement. See [Audio transcript](AUDIO-TRANSCRIPT.md). |
| Agent speaker diarization (`speakerDiarization`) | Same optional Python runtime; after explicit `diarizationParams.allowModelDownload:true`, modelscope downloads the pinned CAM++ weights (28 036 335 bytes, sha256-pinned, Apache-2.0) into the modelscope cache (or `REELTERMINAL_CAMPP_SV_MODEL_DIR`). Embeddings and clustering run locally; labels are anonymous. See [Speaker diarization and separation](AUDIO-SEPARATION-DIARIZATION.md). |
| Agent vocal/instrumental separation (`audio.process.separate`) | Optional Python runtime with demucs 4.1 (`REELTERMINAL_SEPARATION_PYTHON` or the shared interpreter). After explicit `allowModelDownload:true`, Hugging Face is contacted for the pinned htdemucs weights (84 025 440 bytes, sha256-pinned, MIT) into `REELTERMINAL_DEMUCS_CACHE` (default `~/.reelterminal/models/demucs`). Separation runs locally; no audio is uploaded. See [Speaker diarization and separation](AUDIO-SEPARATION-DIARIZATION.md). |
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
| Updates | Packaged app checks this project's GitHub application Releases. Download requires user action; once downloaded, the update installs on the next normal quit after the unsaved-changes guard. Legacy unsafe Windows installations are blocked by the new installer; do not use in-place updates for them. Follow [Windows upgrade and backup](WINDOWS-UPGRADE.md#english). Windows builds are unsigned; verify the download source and published checksums. |

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
| `REELTERMINAL_CAMPP_SV_MODEL_DIR` | Local pinned CAM++ speaker-verification directory; bypasses the ModelScope download but is still sha-verified. | `~/.reelterminal/models/modelscope/models/iic/speech_campplus_sv_zh-cn_16k-common` |
| `REELTERMINAL_SEPARATION_PYTHON` | Optional interpreter override for the Demucs separation task (falls back to `REELTERMINAL_AUDIO_MODELS_PYTHON`). | Unset / unavailable |
| `REELTERMINAL_DEMUCS_CACHE` | Hugging Face cache root for the pinned htdemucs weights. | `~/.reelterminal/models/demucs` |
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

## Third-party licenses

Silero VAD v5.1.2 (AUD-01) is implemented with the pinned weights above and
the MIT-licensed `onnxruntime-node` package. Bundled dependencies, their declared
licenses and available upstream notices are listed in the application's
`licenses/` directory. Standard license reference terms, where used for an npm
archive without a package-specific notice, are explicitly identified as such;
they do not invent a copyright attribution.

SenseVoice transcription, anonymous speaker grouping and Demucs separation are implemented as optional local tools, not bundled environments. Their setup and model-download permissions are described above. Qwen/SenseVoice desktop captions are distinct from the sentence-level Agent speechTranscript API. DeepFilterNet and other unimplemented backends must not be presented as available.

Removed sample footage and retired private mirrors are not default release
dependencies. Native FFmpeg and Blender executables are not bundled. The
`licenses/` directory includes the relevant terms and source references for
FFmpeg.wasm, optional external tools and bundled native convenience sidecars.
Users remain responsible for the rights to their own media and optional tools.
