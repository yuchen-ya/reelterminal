# Command API

The desktop exposes video-project and independent review command catalogs on
loopback. The GUI owns both stores; an external Agent uses `reelctl` to read or
edit an explicit target. Review does not require an open video project.

## Access

The app-lifetime command service starts read-only. For video projects, use
**Allow editing** in the status strip to grant write access and **Set
read-only** to revoke it. The endpoint token is a credential; clients read it
privately and must not print or log it.

## Independent Review Workspace

Select **Review Workspace**, create a data node, and use **Copy connection
instructions** for the current installation. Review editing has its own checkbox;
video write permission does not grant review write permission. Human GUI edits
do not require granting an external Agent access.

```powershell
reelctl review context
reelctl review capabilities
reelctl review describe
reelctl schema review.ingest
reelctl review call review.ingest --file review-input.json
```

`review.context` supplies `{kind:"review", reviewWorkspaceId, instanceId}`.
Node commands additionally require `nodeId`. Resolve the target explicitly and
keep it throughout a task. Node writes require `expectedNodeRevision` and a UUID
`requestId`; directory writes use `expectedWorkspaceRevision`. Revisions are
monotonic through undo/redo. Replaying an identical durable request returns its
receipt, while stale instances/revisions or changed request bodies fail with
`CONFLICT`. Do not substitute a video project ID or infer the node from selection.

Available command families (query their schemas for exact arguments):

- `review.directory.get/apply/history.control`, `review.nodes.list/create` manage
  node metadata, groups, archive and recycle states separately from item history.
- `review.ingest/get/changes`, `review.apply`, `review.versions.get` and
  `review.history.control` share the existing review semantics for four content
  types. Reads are paged (default 100, maximum 500); an exact item/version read
  returns its body. File bytes stay outside command JSON. File ingest prepares
  independent managed originals before committing their references.
- `review.handoff.get` reads an immutable human-published snapshot. Use the
  IDs from each `review.changes.entries[].handoffIds` event to discover published,
  acknowledged, returned or removed snapshots; a removed ID reads `NOT_FOUND`.
  Fetch each snapshot to inspect its current delivery state and historical flag.
  Acknowledgement and rework operations use `review.apply`, exact versions and decision revisions.
  Publishing remains a human GUI action. Migrated/restored handoffs are historical
  evidence and cannot resume old tasks.
- `review.steps.start/complete/fail/list` records actual tool runs, exact
  inputs/outputs, parameters, mappings and failures. Completing a step commits its
  outputs atomically. External reports remain declared; these commands do not run
  a model or infer a processing history from a final file.
- `review.media.inspect` and `review.frames.extract` are shared read-only native
  operations on an exact node-owned version/resource, guarded by node revision.
  Frames reuse the existing FFmpeg processor. Outputs go under
  `agent-workspace/review/jobs/<date>-review-frames-<uuid>/output/`. They do not
  automatically create review items, feedback or steps. Other project processors
  are not available for review targets.
- `review.export.prepare/status/cancel/copy` freezes `original`, `adopted`,
  `node-package` or exact-reference `version` exports. Region/time annotations do
  not crop or trim the exported file. Prepared exports are disposable copies;
  handing a drag to the OS does not prove a target app received it.
- `review.package.inspect/restore` validates a complete node package and restores
  new IDs with references remapped. Missing media/version bodies remain explicit
  gaps. Historical journals are evidence, not executable undo records. Whole-node
  backup is available in the GUI; directory metadata is saved but restoration is
  currently per node.
- `review.attach` copies an exact human-adopted image/video to an explicitly
  selected video project/workspace/runtime through canonical media import. Agent
  use requires both write grants. It adds no timeline clip. A retried import that
  was subsequently undone returns `present:false` instead of resurrecting it.

Legacy migration and permanent node clearing are explicit human GUI actions.
Migration copies readable files, retains unavailable markers, and locks the old
project workbench as a backup. It removes undo groups containing old workbench
actions and clears the redo branch at the normal new-edit boundary; other project
undo remains. Interrupted project-pointer saving can be retried without duplicate
nodes. A source changed by an older application is imported as new batches only
after another preview/confirmation. Old applications do not enforce this lock.
Permanent clearing previews references and requires confirmation to delete all
node history. Other nodes and project copies remain; managed orphan cleanup uses
the existing 24-hour grace period and a later app startup.

`NOT_FOUND` distinguishes a missing entity or unavailable retained body; native
file errors additionally report a reason such as `MISSING_FILE` or
`SOURCE_CHANGED`. Read the error before deciding whether to prepare a new export
or preview. Permissions, malformed targets and cross-node references never imply
permission to retry against another target.

## CLI

### Application audio environment (offline)

Settings → Models & environment and the desktop Auto Captions tool can copy a
configuration prompt containing this installation's absolute CLI command.
These local commands do not read an endpoint descriptor, require an open project,
or grant Agent editing access:

```powershell
reelctl environment get
reelctl environment set --file audio-config.json
reelctl environment check
reelctl environment test --file speech.wav --duration 30 --language auto --engine qwen
reelctl environment test --file speech.wav --duration 30 --language auto --engine sensevoice
```

`get` returns the saved configuration and supported fields. `set` replaces the
whole configuration atomically: read it first and preserve unrelated fields.
Supported fields are `python`, `qwenPython`, `qwenModelDir`, `qwenAlignerModelDir`, `separationPython`, `senseVoiceModelDir`,
`speakerModelDir`, `demucsCache`, `vadModel`, `ffmpeg`, and `ffprobe`; each value
must be an absolute path. An empty object clears the saved overrides. The file
lives at `~/.reelterminal/audio-environment.json`, independently of project files;
`REELTERMINAL_AUDIO_CONFIG` redirects it for isolated testing. Saved fields take
precedence over legacy environment variables. Changes apply without restarting.

`python` selects SenseVoice's interpreter; `qwenPython` selects the separate
Qwen recognition/alignment interpreter. Both caption engines run on CPU.
Use the official `Qwen/Qwen3-ASR-1.7B-hf` and
`Qwen/Qwen3-ForcedAligner-0.6B-hf` local directories, with compatible Transformers
(at least 5.13.0), PyTorch, soundfile, numpy and librosa. No model is bundled or
downloaded by the caption action. Recognition and alignment load sequentially.

`check` verifies dependency imports, pinned SenseVoice weights, Qwen model files
and safetensors data lengths, a real VAD session and
FFmpeg availability, without downloading anything. Its `components` manifest
lists validated package versions, model sources, expected weights and space
requirements. `ready` describes default Qwen subtitle readiness;
`captionEngines.qwen` and `captionEngines.sensevoice` report each engine separately,
including their shared aligner. Optional speaker/separation
diagnostics are also returned. Exit code 3 means the requested readiness check
did not pass. `test` actually transcribes up to 120 seconds of a supplied local
16 kHz mono speech WAV (use its actual duration), returns grouped captions with
word timestamps, the selected engine, CPU device and elapsed time, and never edits a project.
A successful dependency check is not transcription acceptance: inspect the test
output against the speech. Obtain user consent before downloading missing models
or dependencies, and reuse existing environments where possible.

The desktop subtitle UI processes the selected audio stream and visible clip
range, divides long audio into contiguous chunks of at most 120 seconds (preferring
quiet boundaries), and writes a fresh editable caption track in one undo batch.
It preserves existing captions. Cancellation, inference failure, and changed
source/project identity prevent partial publication. Constant forward speed is
supported; reverse playback and speed keyframes are rejected. Both engines use
Qwen ForcedAligner word timing; unsupported detected alignment languages fail
explicitly. Decimal points and punctuation from the recognized text are preserved.
The old browser Whisper engine and download UI have been removed.
Jobs survive panel navigation, not app
restart.

### Instruction presets

The user-level material library accepts `kind: "instruction"` with `title` and
`prompt` (maximum 80 and 2000 characters). Library edits use record revisions and
library undo. Adding an instruction to a project copies its text with a fresh ID;
it does not create a live link or carry project-local references into the preset.
Project instruction edits, enable/disable, removal and ordering use project undo.
`material.attach` remains the media/segment import operation; project instruction
edits use the existing collaboration-instruction edit operation.

`media.import` reports `video`, `audio`, or `image` in its result schema.
`reelctl preview frame` is the CLI alias of `preview.render_frame`; use the
catalog's command name when querying its schema.

Use `reelctl` to inspect the session, get current context, discover commands,
validate changes, and apply edits:

```powershell
reelctl status
reelctl context --compact
reelctl schema edit.apply
reelctl edit validate --file validation.json
reelctl edit apply --file changes.json
```

Frame-exact production tools (see
[MEDIA-REVIEW-WORKFLOWS.md](MEDIA-REVIEW-WORKFLOWS.md)) share the same
catalog: `reelctl frames extract`, `reelctl frames sheet`,
`reelctl video compare`, `reelctl patch apply`, and the candidate analysis
types via `reelctl media analyze --media-id m1 --type sceneCuts --type
blackFrames --type duplicateFrames`. `reelctl schema <command>` shows each
command's exact arguments.

Frame tools require a self-contained local media file. MP4/MOV, WebM/Matroska,
AVI, FLV, MPEG/TS, Ogg, NUT, ASF and common still-image inputs are allowlisted;
codec availability depends on the installed FFmpeg. HLS, concat, DASH and
image-sequence playlists must be consolidated before use. MOV external tracks
are disabled. Network shares and device paths are refused. See
[the security policy](../SECURITY.md) for the limits of these checks.

Edit requests use the current project identity, project epoch, and revision.
The desktop applies a batch through the shared action history, so Agent edits
are visible in the GUI and can be undone there.

Workspace and node verbs share the same catalog. Regular saves — GUI Ctrl+S,
autosave, and normal edit commands — only persist the editing workspace; a save
never creates a version. `node.save` is the retention verb: it records the
workspace as an immutable version node and requires `expectedRevision` plus an
idempotency key (omit `name` to auto-name; unchanged content dedupes to the
existing node). `node.rename` takes `projectId`, `nodeId`, `name` and optional
`summary`; it changes only that display metadata — no revision, no idempotency
key, no new version. `node.restore` adopts a node into a target workspace.
`reelctl schema node.save` and `reelctl schema node.rename` show exact
arguments; workspace operations are described in
[MULTI-PROJECT-USAGE.md](MULTI-PROJECT-USAGE.md).

## Project collaboration instructions

The Board's **Collaboration instructions** tab contains optional user-authored
guidance. New and legacy projects start with no instructions. The **Tasks** tab
retains the existing requirements workflow; instructions have no task status.

`reelctl context --compact` includes `collaborationInstructions.enabledCount`
and the enabled items' `id`, `title`, and `updatedAt`. When instructions exist,
read their complete text against the explicit target returned by context:

```powershell
reelctl schema collaboration.instructions.get
reelctl call collaboration.instructions.get --project-id <projectId> --workspace-id <workspaceId>
```

This read-only command returns `revision`, `projectId`, `workspaceId`, and an
`instructions` array containing the complete enabled entries, including their
saved references. It is available without Agent write access. Disabled entries
are excluded; an empty array adds no creative or delivery preference. The CLI
uses the same catalog and contract.

Refresh context before a new round of work and before committing edits. Reread
the full guidance when its summary changes, including removals. Saving guidance
does not push a message to an external Agent or interrupt an existing job; it
becomes available on the next read. This first version exposes no Agent mutation
command for instructions: the user adds, edits, enables or removes them in the
Board. References are source material, not instructions, and a named tool or
skill does not establish availability or grant additional access.

The copied startup prompt provides connection, discovery and safety rules.
It does not prescribe a creative process or require video export. Export and
artifact verification apply when file delivery is requested. See
[Agent collaboration guidance](AGENT-GUIDE.md#collaboration-instructions) and
[file workspace rules](AGENT-WORKSPACE.md).

## Local audio workflow

`media.analyze_start` supports `audioSummary`, `silence` and `beatGrid` in live
and headless sessions. Audio analysis requires an artifact root. `job.status`
returns compact audio statistics and a record ID; `analysis.get` defaults to a
summary. Request `view: "events"` for time-window pagination or
`view: "waveform"` for bounded waveform points. See
[MATERIAL-ANALYSIS.md](MATERIAL-ANALYSIS.md) for the series and window contract.

`audio.process.normalize` starts a local two-pass loudness job. After it reaches
`done`, `audio.process.register` explicitly imports the persistent derived WAV
into its source project/workspace with revision checks. Neither command replaces
timeline clips. Both require write access in live mode. Parameters, measured
target tolerances and the 120-second/48 kHz limits are documented in
[AUDIO-NORMALIZATION.md](AUDIO-NORMALIZATION.md).

Use `reelctl schema` for the command index and `reelctl schema <command>` for
exact arguments. `reelctl schema --domain <domain>` filters the index by the
command's leading name segment (`audio`, `media`, `edit`, ...); the filtered
entries come from the same catalog and unknown domains are rejected with the
available domain list. `capabilities.get` accepts an optional `domain`
parameter (`audio`, `video`, `frames`, `motion`, `render`, `export`) that
scopes probing to that domain: unrelated probes never start, and every
probe-backed status outside the requested domain is reported as
`probed: false`/not available rather than ready. Verbs keep their real
pre-execution checks either way.

## Headless sessions

For a standalone workflow, use `reelterminal-agent run --workflow <abs>` and configure its project,
media, artifact, and delivery roots. A headless session owns its own project;
it does not open or replace the desktop project.

Package-level API details are in
[`../packages/agent-facade/README.md`](../packages/agent-facade/README.md) and
[`../packages/runtime-chromium/README.md`](../packages/runtime-chromium/README.md).

## Production management

`media.production_list`, `batch.start`, `batch.get` and `batch.resume` are
discovered through the shared CLI catalog. `edit.apply` adds
`media.setProduction`; `media.replace` accepts `preserveFrames: true` for
verified CFR/frame-count preservation. See
[PRODUCTION-MANAGEMENT.md](PRODUCTION-MANAGEMENT.md) for shared GUI records,
review-to-board adoption, batch persistence boundaries and rendering details.

## AI material workbench

The workbench (`workbench.*` verbs, shared by reelctl and the GUI project
store) reviews batches of Agent-produced items. Four content kinds are
first-class: `image`, `text`, `data` and `video`. Text corpora and data tables
carry their own payloads — they are never disguised as media files; image and
video items reference existing project media ids (import bytes first).

- `workbench.ingest` — create or append a batch with stable item ids
  (`{batchId, name, items: [{id, title, type, content, provenanceTags?,
  agentGuidance?, lineage?, groupMode?, compareWithItemId?, videoPayload?}]}`). Re-submitting an existing item id is an
  idempotent skip; ids are never reused for different content. Supports
  `expectedRevision` and `idempotencyKey` like other writes.
- Keep item titles and agentGuidance.nodeSlotLabel compact: prefer 4–8 Chinese
  characters / ≤15 characters, without repeating the batch name prefix.
- Set item.groupMode or lineage.groupMode to "board" for candidate images,
  storyboard sequences or sparse text/data reviewed together on an adaptive board
  (collapsed parent by default). Use "category" for folder-only grouping
  (expanded by default). The item value takes precedence.
- For rework videos or A/B comparison, set compareWithItemId to the baseline video
  item ID in the same batch. videoPayload.compareWithItemId is also accepted.
  Both must be non-empty strings when supplied; normalization copies the selected
  value to both item and videoPayload, with the top-level value taking precedence.
  These fields are also supported by independent review.ingest and
  review.steps.complete ingest inputs through the shared schema and conversion.
- Video marker legacy fields `startPtsSec`, `endPtsSec` and annotation `ptsSec`
  use the browser media timeline (`HTMLVideoElement.currentTime`). New video
  handoff items declare `videoTimeBasis: "browser-current-time"`; this also
  applies to independent `review.handoff.get`. They are not automatic container
  PTS conversions. With no source-frame mapping, do not infer a frame number or
  add/subtract `start_time`; external source processing may need a separate
  verified mapping. `review.frames.extract` supplies its own exact decode-index
  and PTS facts and does not automatically attach them to GUI markers.
- `workbench.get` — read batches/items with status, versions, feedback counts
  and pagination (`limit` ≤ 200). Data tables return `rowCount`/columns by
  default; pass `includeData: true` for full rows. Text returns the current
  text plus a version count. Default output stays bounded; opt in with
  `includeFeedback` (per-issue `intent`/`target`/`clearedBy`/`historical`),
  `includeMarkers` (browser-time ranges, `timeBasis: "browser-current-time"`
  and `hasFrameMapping`, no fake frame
  numbers) and `includeRevisions` (kind/producedVersion/media/base). Each
  response carries `read: {capturedAt, stateRevision}` for one store snapshot.
- `workbench.changes` — decision and handoff events for one batch, keyed by a
  `projectRevision` cursor. An older cursor returns `stale: true` with a full
  re-read; a newer cursor is a CONFLICT.
- `workbench.handoff.get` — read an immutable published snapshot by
  `snapshotId` (the legacy `handoffId` is the same identity). The snapshot
  carries execution-level `issues` per item: `itemVersion`, stable `issueId`,
  full pixel/video/data-cell/text geometry, and `referencedTags` frozen at
  publish time (`referenceState: "unresolved"` keeps the raw value). It also
  freezes `provenanceTags`, `imageAnnotations`, `videoMarkers` and
  `revisions`. Omit both ids to read only the latest snapshot header.
  Superseded snapshots stay byte-identical; only delivery bookkeeping
  (`deliveryState`, `returnedItemIds`) advances. Publishing a snapshot with the
  same content is an idempotent replay (`replayed: true`); changing feedback
  publishes a new snapshot linked by `supersedesHandoffId`, scoped per item.

`edit.apply` ops for the agent channel: `workbench.decide` (operator is always
recorded as `agent` — human verdicts come from the GUI; `expectedItemVersion`
guards against stale decisions), `workbench.content.update` (text or explicit
data cell patches; **requires `expectedItemVersion`**, and a valueless patch
must resolve a proposal), `workbench.feedback.save`, `workbench.handoff.ack`
and `workbench.rework`. Rework results are bound to the handoff item's
`itemVersion` and decision revision: a human revision, retrieval, re-decision
or a newer handoff covering that item rejects the old result with CONFLICT.
Text rework appends the produced version and keeps older bodies byte-identical
(no in-place overwrite of the parent version). Members of one handoff return
independently; the handoff only reads `rework_returned` after every rework
target has returned. Publishing a handoff is a human action in the GUI; there
is no agent publish op by design.

`editor.get_context` additionally reports `workbench: {activeBatchId,
currentItemId, selectedItemIds}` while the workbench page is the active
desktop page (`null` otherwise).


### 审阅 GLB（轻量只读预览）

独立 `review.ingest` 的正式类型为 `model3d`，内容是
`{"type":"model3d","resourceId":"<FileResource UUID>"}`；`files` 使用
`model/gltf-binary`，不是图片/视频 mediaId。`review.apply` 的 content.update/rework
及 `review.steps.complete` 沿用同一内容结构、显式目标、revision/requestId 守卫。
未支持预览的 GLB 原件仍注册并可按 original/version/adopted 导出，不隐式转换视频。
视频项目不接受模型 attach。

查看器只接受自包含 GLB 2.0，嵌入 PNG/JPEG、基础 PBR/unlit 与已有骨骼/morph 动画。
外部 URI、未知 required 扩展、Draco/Meshopt/KTX2 和实例扩展明确拒绝预览；没有 CDN
或自动下载解码器。当前预览门限是 48 MiB 文件、96 MiB 保守展开计数、16M 纹理像素、
4096 纹理边长、50 万含实例三角图元、10000 节点和 128 层层级。门限是资源保护，
不保证门限内任意模型的外观或性能。实际样例和环境见 `REVIEW-3D-PREVIEW-DELIVERY.md`。

GUI `model-view` 反馈 target 包含 observationId、模型 resourceId、screenshotResourceId、
observation（neutral-r182-v1 preset、背景、相机 position/quaternion/target/fov/near/far、
动画 index/name/time 或 null、CSS 视口宽高）；feedback.itemVersion 绑定准确版本。
`review.get` 和 `review.handoff.get` 可读回这些真实值。截图是反馈资源，不是新模型版本。
相机/播放变化不产生内容修订；旧观察在新 GLB 上不被自动套用。没有 mesh/vertex
永久锚点、自动坐标配准或动画映射 API。

含 model3d 的 `node.json` 使用 archive schemaVersion 2；原文件清单 manifest 仍为
通用库存格式 v1。当前 reader 同时接受 archive v1/v2，并拒绝把 model3d 冒充 v1；
旧 reader 会明确拒绝 v2。恢复生成新实体/资源身份，历史交接不可执行；原 GLB、
当前截图和历史截图均进入包及保留引用，恢复后再次打包仍保留其库存。
