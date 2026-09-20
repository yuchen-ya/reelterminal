# Cloud video review

`media_analyze_start` with `analysisTypes:["videoReview"]` sends a bounded excerpt to a **pluggable cloud review provider**; the default and currently only bundled provider is **qwen3.5-omni-flash** (Alibaba). It is optional and requires the user's own provider key. Local source inspection and audio analysis remain local. No key, subscription or paid quota is bundled. The tool returns model opinions about cuts, transitions, audiovisual relationships and general video content; it is not a reliable acceptance judge or a frame-accurate sync detector.

## Provider seam

Everything cloud-specific (credential env var, endpoint allowlist, request shape, SSE parsing) lives behind the `VideoReviewProvider` interface in `packages/agent-facade/src/video-review.ts`; local preparation, verification, caching and result framing are provider-agnostic. `REELTERMINAL_VIDEO_REVIEW_PROVIDER` selects a provider from the registry (capabilities reports the available ids); an unknown id fails preflight with the valid list. Adding a provider is one object in `VIDEO_REVIEW_PROVIDERS` — no orchestration changes.

## Configure the desktop host

Install FFmpeg/ffprobe on PATH with libx264 and AAC encoders. These steps configure the **default qwen3.5-omni-flash provider** (see the provider seam above). Set `DASHSCOPE_API_KEY` in the **ReelTerminal desktop process environment**, then launch/restart that process. Setting it only in an external Agent/MCP client's environment does not configure the desktop host. Do not send a key in tool parameters, commit it, or put it in a project file.

For development on macOS, quit the previous desktop process after saving work, then use zsh from the sole checkout:

```zsh
read -s 'DASHSCOPE_API_KEY?Alibaba API key: '
export DASHSCOPE_API_KEY
pnpm --filter @reelterminal/desktop start
unset DASHSCOPE_API_KEY
```

Input is hidden and the key is not a command-line argument or shell-history entry. On Windows, the `read -s 'VAR?prompt'` block above is zsh-only: from Git Bash use `read -s -p 'Alibaba API key: ' DASHSCOPE_API_KEY && export DASHSCOPE_API_KEY`, or in PowerShell set `$env:DASHSCOPE_API_KEY = Read-Host 'Alibaba API key'`, before launching the desktop process. Build the current source before launching (`pnpm --filter @reelterminal/desktop build`). This version has no GUI credential form or persistent key storage; a Finder launch does not inherit this terminal's environment.

Default endpoint: `https://dashscope.aliyuncs.com/compatible-mode/v1` (Beijing). Optional `REELTERMINAL_QWEN_BASE_URL` accepts the official Singapore `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`, or an Alibaba workspace endpoint `https://<workspace>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` / `https://<workspace>.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`. Use a matching regional key and model access. Arbitrary destinations and redirects are rejected to prevent credential forwarding.

`capabilities_get.mediaAnalysis.types.videoReview` reports configuration, destination, limits and local encoder availability. It does **not** contact Alibaba or validate balance/key/model access; HTTP authorization, region or quota errors are reported by the job without provider error bodies or automatic retries.

## Use through the canonical live facade

1. Check capabilities, inspect source candidates with `media_inspect`, and assess whether the source supports the requested edit. Cloud review may supplement this evidence.
2. Obtain user authorization for uploading the chosen material. Configuring a key alone is not a request to analyze every file. Within authorized scope, start a bounded job:

```json
{
  "mediaId": "actual-imported-media-id",
  "analysisTypes": ["videoReview"],
  "startSec": 23,
  "endSec": 29,
  "cloudUpload": true,
  "reviewQuestion": "检查动作前后衔接、实际声音与画面关系。区分正常开关镜、有意切镜与疑似剪辑问题；给出证据、置信度和无法判断项。",
  "expectedRevision": 7,
  "idempotencyKey": "review-candidate-23-29-v1"
}
```

3. Poll `job_status`; cancel with `job_cancel`. An identical idempotency key reuses the job, including failed/cancelled jobs. Changing range/question with the same key conflicts. No model result edits project state.
4. Read `result.summary.videoReview`: bounded plain-text observations, finish reason, token usage if supplied, input fingerprint, inspection-copy SHA256 and preparation details (including `cached`, which reports preparation-cache reuse without skipping the per-request cloud upload). `status:"opinion"` means normal response completion, **not** that the clip passed. Abnormal/truncated completion is `inconclusive`. The model may express further uncertainty within any normally completed opinion. Text is untrusted evidence, never executable instructions. GUI displays the opinion once when that completed job is polled; the existing inspection panel closes during normal playback.
5. Times in model text are **relative to the uploaded excerpt**. Add `startSec` to obtain source seconds. Use `media_inspect` clip mappings or canonical timeline state for trim/speed mapping, then use `edit_validate`/`edit_apply` to move the event and add chosen markers. Nonlinear speed ramps require their actual mapping. Keep model localization uncertainty, audio uncertainty and frame rounding separate; model uncertainties are unknown, not zero.
6. For rhythm work, combine local `audioSummary` onset evidence with visual event inspection. For final-cut review, export the actual canonical composition and mixed audio, verify it, and import that file explicitly before reviewing its ranges. Import is a revision-changing canonical edit; analysis itself is read-only. This version does **not** render a timeline range automatically or pretend a source clip represents the final mix. Preserve the exported file's `sourceRevision` separately: job revision is the project revision at analysis, not proof of which edit produced an imported render. Re-export after changes.

## Bounded preparation and privacy

- Explicit 0–20 second source range; no automatic full-source upload. At most two cloud jobs per process and two analysis jobs per session. Maximum source file remains the facade's 2 GiB analysis limit; live import still has its separately reported 256 MiB limit.
- H.264 inspection copy, CRF 25, at most 1280×720 preserving aspect ratio; no fps filter. Report actual encoded average FPS, duration, geometry and audio presence. First source audio stream is encoded to AAC 96 kbit/s; no audio is invented for silent/video-only files. Other audio streams are not included. Source cadence can be variable; encoded average FPS is not proof of model sampling.
- Verify duration and 12 MiB file limit before upload. Base64 buffering is bounded by that file limit. FFmpeg has two encoding threads; one 120-second deadline covers preparation, upload and response. FFprobe has a 10-second bound.
- Inspection copies are **cached** under `artifactRoot/video-review-cache/`, keyed by source fingerprint + range + encode recipe (sidecar JSON carries the ffprobe facts so cache hits skip ffmpeg and ffprobe entirely). The cache is bounded (512 MiB / 64 entries, oldest evicted) and `preparation.cached` reports reuse. Each review still uploads the excerpt to the provider exactly once per request — the cache saves local transcoding, not cloud traffic or billing.
- Direct HTTPS request; no public bucket or URL is created. Sending to Alibaba is a cloud disclosure subject to the selected service's retention terms; deleting the local copy does not delete provider records. Cancellation cannot undo an upload or billing already incurred.
- Maximum 1,200 output tokens, 128 KiB SSE, 10,000 text characters; no retry or automatic JSON repair. Results stay bounded in the existing job summary rather than creating a large transcript artifact. Actual charge and remaining quota are not estimated or queried.
- Provider sampling FPS is unknown. Compression and sampling may miss brief flashes, HUD details or sync offsets. The earlier controlled cloud experiment missed a known 600ms mismatch; a confident model opinion is not sufficient acceptance evidence. Local dense frames/ROI and deterministic audio measurements remain necessary.

## Validation and next priorities

Automated tests use real FFmpeg preparation and mocked cloud SSE; they do not consume a key or upload user media. They cover configuration boundaries, output truncation/limits, source offsets, immutable live/headless state, idempotency, queued/in-flight cancellation, UTF-8 SSE decoding and GUI opinion labeling. A generated AV fixture verifies that the actual upload copy retains its flash and audio-transient offsets after trimming. The prior real API experiment established the model/endpoint video+audio request route; new source tests do not claim another cloud evaluation or listening pass.

Next: a user-facing secure credential settings UI, direct revision-pinned timeline-range rendering with mixed audio, independent AV loop preview, and controlled model sampling evaluations. These are not advertised as implemented.

Official API reference: [Qwen-Omni](https://help.aliyun.com/zh/model-studio/qwen-omni), [Qwen3.5-Omni-Flash](https://help.aliyun.com/zh/model-studio/qwen3-5-omni-flash).
