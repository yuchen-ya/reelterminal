# Extraction Audit — packages/agent-runner + HeadlessHost pure-Node runnability

Baseline: 2566c34e0f8ea22992a85f3ff16e048307b49365 (branch audit/extraction-2566c34).
Scope: `packages/agent-runner/src/*`, evals, `packages/agent/src/headless-host.ts`, `packages/agent/src/loop.ts`,
`packages/agent/src/host.ts`, `packages/core/src/storage/project-serializer.ts`.

## SUMMARY

- The headless path is genuinely runnable in pure Node with no LLM and no browser: a live probe drove
  12 tool-handler calls against `HeadlessHost` through the real registry — read tools, actionTool mutations,
  overlay create/remove fallbacks, job tools, undo via `ActionHistory`, and transaction rollback all behaved
  as designed (12/12 PASS; `audit/probes/headless-smoke.mjs`).
- `packages/agent-runner` is thin glue (~1,100 LOC total): LLM HTTP transport, project file IO, a GPU-job
  HTTP client, a concurrency pool, CLI, and an eval harness. It contains NO rendering/export logic.
- Export/rendering is **not** implemented in Node anywhere in this package. All heavy jobs go through the
  `JobRunner` seam (`host.runJob`); the only concrete production runner is `createGpuJobRunner`, a pure HTTP
  client to a remote GPU worker + auth broker. No ffmpeg/native/wasm export exists on the headless path.
- Of the 304 registry tools: ~273 work against `HeadlessHost` as-is; 12 overlay create/update/remove tools
  work but degrade to raw-action fallbacks; 5 need an injected `JobRunner`; 14 fail cleanly with `UNSUPPORTED`
  because they require optional host methods only the live web/desktop host implements.
- Finding: `create_text_clip` / sibling overlay-create tools FAIL on headless unless the model supplies an
  explicit `clip.id` that is NOT in the tool schema — real latent bug for a Node-only runtime (RUNNER-02).

## FINDINGS

### Run pipeline

- F1. `runHeadlessEdit` constructs `HeadlessHost(project, {jobRunner})`, builds provider-formatted tools from
  the shared registry (`toAnthropicTools()/toOpenAITools()`), builds the system prompt from the host, and runs
  one `runTurn` — packages/agent-runner/src/run.ts:36-63. HIGH
- F2. `runTurn` opens ONE transaction for the whole turn (`host.beginTransaction(turnLabel)` at
  packages/agent/src/loop.ts:116), commits it at every normal stop reason (loop.ts:124,144,245,257) and rolls
  back on any thrown error (loop.ts:267). So atomicity unit = turn, not per-tool-call. HIGH
- F3. On commit-vs-save interplay: `runHeadlessEditFile` persists ONLY if `!dryRun && stoppedReason!=="error"
  && result.committed` — packages/agent-runner/src/run.ts:79-84. Note `committed:true` is also returned for
  `max_steps`/`max_tool_calls` stops, so partial-turn results DO get saved by default. MED (design choice worth flagging)
- F4. Dry-run short-circuits non-read tools in the loop itself, returning synthetic ok results without touching
  the host — packages/agent/src/loop.ts:226-231. The dry-run plan therefore never exercises handlers. HIGH

### HeadlessHost

- F5. Implements exactly the 8 required interface methods plus test helper `setProject`:
  getProject, applyAction, beginTransaction/commit/rollback, runJob, capabilities, requireOpenProject —
  packages/agent/src/headless-host.ts:34-99 (probe prints the same list from the prototype).
- F6. Rollback is snapshot-based, not inverse-replay based: `beginTransaction` stores `structuredClone(project)`
  (headless-host.ts:49), rollback restores it and calls `history.clear()` (headless-host.ts:59-70) — robust to
  inverse-generation failures and history trimming, per its own comment. Probe confirmed byte-identical restore
  AND cleared undo history. Committing deletes the snapshot (headless-host.ts:54-57); committing an unknown
  handle is a silent no-op. HIGH
- F7. `capabilities()` returns the static core `CAPABILITY_MANIFEST` regardless of what jobs are actually
  available (headless-host.ts:85-87) — a headless agent sees "export video" capability even with no JobRunner
  injected. LOW-MED (misleads planners)
- F8. `setProject` clears history (headless-host.ts:96-99); it is NOT part of `EditingHost`
  (packages/agent/src/host.ts:197-275 declares no setProject) — a Host-implementation-specific escape hatch. HIGH

### project-io format

- F9. Files saved/load headlessly use `ProjectSerializer.exportToJson/importFromJson/validateProjectJson` over
  a Proxy storage engine whose every member throws ("Storage engine is not available in the headless runner") —
  packages/agent-runner/src/project-io.ts:15-32. Only pure JSON paths are used. HIGH
- F10. File format: `{ "version": "1.0.0", "project": <Project> }` (`SCHEMA_VERSION = "1.0.0"`,
  ProjectFile at packages/core/src/storage/project-serializer.ts:76-81; written at :192-198).
  Save strips media blobs first (`stripMediaBlobs`, serializer.ts:195,399) so files never contain binary data. HIGH
- F11. Loading marks blob-less media items `isPlaceholder: true` and imports older/newer versions via
  `migrateProject` which today just re-normalizes fields (serializer.ts:200-226,268-270). Validation ERRORS on
  missing version/project, WARNS on version mismatch (serializer.ts:242-259); `loadProjectFile` throws only when
  `valid === false` (project-io.ts:50-59), so version-mismatched files load with normalization, not rejection. HIGH
- F12. `createEmptyProject(name?, settings?)` seeds 1920x1080@30, stereo 48k, empty timeline/library with a
  randomUUID id — project-io.ts:34-48. Cast `as unknown as Project` implies full Project shape is broader than
  the constructed object (motion/creation state defaults come from loading-normalization instead). MED

### gpu-job-runner + export queue

- F13. `createGpuJobRunner(config)` is a pure-Node HTTPS client, nothing native: POST `{gpuBaseUrl}/jobs` with
  body `{kind, params}`, then poll GET `/jobs/{jobID}` every 2 s up to 10 min until status is terminal
  (TERMINAL_OK = succeeded/completed/complete/done; TERMINAL_FAIL = failed/error/cancelled/canceled) —
  packages/agent-runner/src/gpu-job-runner.ts:17-18,107-182. Requires live GPU worker + broker infrastructure.
- F14. Auth: `GpuTokenProvider` mints short-lived JWTs via the broker's OPEN, UNATTESTED challenge/token legs
  (`POST /auth/challenge` then `/auth/token`, headers `X-Bundle-ID`; platform default "desktop") —
  gpu-job-runner.ts:33-90. A server-side runner authorizing GPU jobs via an unattested leg is a security-relevant
  design decision. Token cached until <60 s before expiry; 401 triggers one mint-and-retry (gpu-job-runner.ts:128-133).
- F15. The runner is kind-agnostic: ANY `JobKind` string from host.ts:5-14 (transcribe, detectHighlights,
  removeBackground, upscale, generateMusic, inpaint, exportVideo, exportAudio, exportFrame) is forwarded verbatim;
  there is no client-side gating or kind whitelist. Success returns `{ok:true,data:{jobID,status,manifestURL}}` —
  gpu-job-runner.ts:136-181. HIGH
- F16. With NO runner injected, `HeadlessHost.runJob` returns graceful failure
  `"Job '<kind>' is not available in this host (no job runner configured)"` and jobTools map it to
  `{ok:false,error:{code:"JOB_FAILED"}}` (registry.ts:10595-10621 jobTool; probe case #8). HIGH
- F17. `runExportQueue` is just a bounded worker pool (default concurrency 2) over any JobRunner, input-order
  results, per-job catch so one failure never aborts the batch — packages/agent-runner/src/export-queue.ts:26-64.
  NOTE: nothing in the repo wires this into a tool or the loop today (library-level API only). HIGH

### cli.ts surface

- F18. Flags: `-p/--project <file>` (required), `-m/--prompt <text>` (required), `--provider anthropic|openai`
  (default anthropic, anything else coerces to anthropic at cli.ts:31), `--model` (defaults claude-sonnet-4 /
  gpt-4o), `-o/--out` (default edit-in-place), `--dry-run`. Usage text cli.ts:64-77; parser cli.ts:15-47. HIGH
- F19. BYOK requirement is hard: exit(1) before running if neither `OPENREEL_API_KEY` nor
  provider-specific `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` is set (cli.ts:49-91). Key used per-request header only
  (x-api-key / Bearer), never stored or logged — node-llm.ts:33-63. Endpoints hardcoded to api.anthropic.com /
  api.openai.com (node-llm.ts:11-14); retry handled by `withRetry` from @openreel/agent (node-llm.ts:74).
  No way to run the CLI prompt-driven WITHOUT an LLM (a scripted/mock client can be injected programmatically
  via `opts.llm` — run.ts:19-20 — but the CLI has no flag for it). HIGH
- F20. Binary name: package.json bin `openreel-agent → dist/cli.cjs` built by tsup;
  main/exports point directly at TS sources (`./src/index.ts`). Package deps are exactly @openreel/agent +
  @openreel/core workspace links. MEDIUM dependency-graph note.

### evals/

- F21. Harness: `EvalCase {name, makeProject, prompt, llm?, expectedTools?, assert}` executed through
  `runHeadlessEdit`; outcomes record pass/fail + failure strings; `expectedTools` asserts the EXACT ordered
  tool sequence extracted from transcript messages — packages/agent-runner/src/evals/harness.ts:6-97.
- F22. Corpus: 3 deterministic SCRIPTED_CASES driven by `MockLLMClient` (rename+add track; two tracks;
  pure-question no-edit) — packages/agent-runner/src/evals/cases.ts:17-71; regression-tested in
  evals/evals.test.ts. Real-LLM mode exists (omit `llm`) but is opt-in-guarded: fails closed unless BOTH
  `opts.model` and `opts.apiKey` are provided (harness.ts:46-55). HIGH
- F23. Registry-wide mechanical probes already exist and should be reused rather than duplicated:
  audit/probes/dump-tool-catalog.mjs (produced audit/tool-catalog.jsonl) and dump-action-map.mjs
  (produced audit/action-map.jsonl). HIGH

### Loop/tool mechanics relevant to headless

- F24. Tool execution funnels through `executeTool(call.name, call.args, host)` in the loop
  (packages/agent/src/loop.ts:232) — handler signature `(args, host)` confirmed live by direct invocation.
- F25. Confirmation gate is wired in the loop for destructive/expensive tools (loop.ts:201-223) but
  `runHeadlessEdit` does NOT pass a `confirmGate` (run.ts:51-60): in headless, expensive tools like
  `export_video` run unattended once called. HIGH security/cost note for extraction.
- F26. Budgets default maxSteps=12, maxToolCalls=64 (loop.ts:102-103); overrun responses are synthesized so the
  transcript stays resumable (loop.ts:164-192). Turn label default "AI edit" vs "Headless edit". HIGH

## HEADLESS-SMOKE

Probe: `audit/probes/headless-smoke.mjs` (scratch, read-only wrt project state; writes
`audit/probes/out/headless-smoke.json`). Load harness: audit/probes/lib/{scan.mjs,openreel-loader.mjs};
closure = 135 files, third-party stubbed: polygon-clipping, @paper-design/shaders. Command:
`node --experimental-transform-types audit/probes/headless-smoke.mjs`.
Project shape modeled on packages/core/src/actions/headless.node.test.ts:7-70.

Result: 12/12 PASS.

| # | call | expectation | result | code | evidence |
|---|------|-------------|--------|------|----------|
| 1 | `get_editor_state.handler({}, host)` | ok | PASS | – | reads getProject |
| 2 | `get_capabilities.handler({}, host)` | ok | PASS | – | CAPABILITY_MANIFEST |
| 3 | `rename_project {name}` | ok + state change | PASS | – | project.name updated |
| 4 | `add_track {trackType:"video"}` | ok + tracks 1→2 | PASS | – | actionTool→applyAction |
| 5 | `create_text_clip {clip:{text,...}}` NO clip.id | graceful fail expected | PASS (fails) | INVALID_PARAMS "text/create requires a clip with an id" |
| 6 | same WITH explicit clip.id | ok | PASS | – | lands in project.textClips=1; NO timeline text track holds it |
| 7 | `remove_text_clip {clipId}` | ok via applyAction fallback | PASS | – | textClips back to 0 |
| 8 | `export_video {}` no jobRunner | graceful fail | PASS | JOB_FAILED (host message quoted in F16) |
| 9 | `export_video {format}` with stub runner | ok + delegation | PASS | – | params passed through verbatim |
| 10 | `host.applyAction(track/add)` then `history.undo()` + inverse replay via executor | restore | PASS | – | inverse type track/remove; byte-identical JSON restore=true |
| 11 | begin → rename+track/add → rollback | state restored + history cleared | PASS | – | cloned snapshot restored; canUndo true→false |
| 12 | begin → rename → commit | change persists | PASS | – | unknown-handle commit silent no-op |

Also printed live: HeadlessHost prototype methods =
applyAction, beginTransaction, capabilities, commitTransaction, getProject, requireOpenProject, rollbackTransaction, runJob, setProject.

## TOOL-VIABILITY

Method/rule: for each of the 304 catalog entries classify using
(a) `availability_mechanical.HeadlessHost.missing_required` (none for any tool), (b) `host_methods` ⊆
{getProject, applyAction, begin/commit/rollbackTransaction, runJob*, capabilities, requireOpenProject} implemented
by HeadlessHost, (c) `editing_host_optional_methods`, corrected against registry source where the static catalog
under-attributes: overlayRemoveTool's removeOverlay guard (registry.ts:10644), motion render queue bridge guards
(registry.ts:31693,31758,31790,31815), and inline runJob uses with kind-qualified `runJob:<kind>` entries
(render_motion_frame, render_creation_preview — exportFrame).

| domain | total | works as-is | works-degraded (action fallback) | needs-jobRunner | needs-optional-method (UNSUPPORTED) |
|-----------|-------|------------|----------------------------------|-----------------|-------------------------------------|
| read | 25 | 23 | – | – | 2 (probe_rigging_backend, inspect_3d_model) |
| motion | 190 | 186 | – | 2 (render_motion_frame, render_creation_preview → exportFrame) | 2 (rig_humanoid_model, import_image_layer) |
| export | 7 | – | – | 2 (export_video, export_audio) | 5 (export_motion_video, queue/run/list/cancel_motion_render_*) |
| ai | 1 | – | – | 1 (transcribe_clip) | – |
| project | 7 | 3 | – | – | 4 (create/list/open/save_project) |
| media | 3 | 2 | – | – | 1 (import_media_from_url) |
| text | 3 | – | 3 | – | – |
| graphics | 9 | – | 9 | – | – |
| track/clip/speed/effect/audio/subtitle/keyframe/transition/marker/color/transform/raw | 46 | 46 | – | – | – |
| **TOTAL** | **304** | **~273** | **12** | **5** | **14** |

Guarded-fallback exceptions (tools check `typeof host.X === "function"` and take another path):
- Degraded-to-action class (12): create_text_clip/update_text_clip/remove_text_clip,
  create_shape_clip/update_shape_clip/remove_shape_clip, sticker×3 (svg×3 too) — registry.ts:10644 (remove),
  15647/15696/15733/15767/15795/15827/15853/15883 (create/update). They return OK on headless via raw
  text/create…shape/remove actions — BUT serialized-only effects (see RUNNER-02/RUNNER-03).
- Fail-clean class (no fallback, `code:"UNSUPPORTED"` + clear human message): every other optional-method tool
  listed above, e.g. registry.ts:15414 (create_project), 15504 (import_media_from_url), 29650 (import_image_layer),
  31600 (export_motion_scene), 11124/11164/11226 (rigging/model), MOTION_RENDER_QUEUE_UNSUPPORTED for the queue
  tools. Catalog gap: these UNSUPPORTED paths and the queue bridge are absent from
  `editing_host_optional_methods` in some rows (see RISKS RUNNER-05).

Notable consequence: HEADLESS MEDIA IS STARVED — the only ingest tool (`import_media_from_url`) requires the
optional live-host fetcher; nothing headless can add real media to `mediaLibrary` (delete/rename exist as
actionTools). Headless projects can edit structure (tracks/clips/text/markers/etc.) over whatever pre-exists in
the JSON.

## GAPS

- G1. No local rendering/export implementation of any JobKind in Node: ffmpeg, wasm, sidecar subprocess — none
  exist here; the ONLY option is remote GPU HTTP (gpu-job-runner.ts) or a hand-written stub runner. E2E export
  on a Node-only runtime means implementing a new JobRunner adapter from scratch.
- G2. `importMediaFromUrl` has no headless equivalent (pure-Node URL fetch + duration/probe would be needed).
- G3. Overlay engine-awareness gap is structural on headless: Title/Graphics engines live in the web app store;
  raw actions write arrays only (documented at host.ts:249-274 comments and confirmed empirically for textClips).
  Any Node facsimile must decide whether serialized-only overlays are acceptable output.
- G4. `save_project` (host.saveProject) unsupported headlessly is fine — persistence goes through
  saveProjectFile — but the CLI/system prompt does not teach the model that distinction; tools still advertise
  save_project in tool lists (it will UNSUPPORTED).
- G5. Eval corpus covers only rename/add-track/no-op; no eval cases exercise overlay fallbacks, job failure
  paths, transactions, or motion domains.
- G6. No MCP entry point surfaces runHeadlessEdit/runExportQueue together; the runner exports are library-only.

## RISKS

- RUNNER-01 [HIGH] Headless expensive actions run WITHOUT confirmation: `runHeadlessEdit` passes no confirmGate
  (run.ts:51-60 vs loop.ts:201-223), so `isDestructive/isExpensive` gates are inert in the CLI/server path.
- RUNNER-02 [HIGH] Overlay create tools fail or produce invisible clips headlessly: schema documents no `clip.id`
  but core handler requires one (probe #5 INVALID_PARAMS "text/create requires a clip with an id";
  handlers/overlay.ts:48); with an id it "succeeds" writing project.textClips while no timeline text track
  references the clip (probe #6 state line) — silent divergence between tool-ok and rendered reality.
- RUNNER-03 [MED] Partial turns persist on max_steps/max_tool_calls (`committed:true`, saved by
  runHeadlessEditFile per F3) — user-visible truncation risk for batch jobs.
- RUNNER-04 [MED] `GpuTokenProvider` authenticates GPU submissions over an unattested open broker leg
  (gpu-job-runner.ts:62-89) — anyone able to reach the broker can mint tokens for GPU spend unless broker-side
  attestation exists elsewhere.
- RUNNER-05 [LOW] Static catalog under-attributes some host dependencies: jobTool-derived runJob usage shows
  empty `host_methods` (export_video/export_audio/transcribe_clip rows), removeOverlay fallback and
  motionRenderQueue guards are missing from `editing_host_optional_methods`; viability numbers here correct them
  from source. Future consumers of tool-catalog.jsonl should re-check helper-kind rows.
- RUNNER-06 [LOW] `capabilities()` lies by omission about jobs/media availability on headless (F7/G4); agents
  planning from CAPABILITY_MANIFEST alone will attempt unsupported flows until they hit UNSUPPORTED/JOB_FAILED.
- RUNNER-07 [LOW] Unknown-handle `commitTransaction` is a silent no-op (probe info line) — maskable double-commit bugs.

## FACADE-NOTES

For a Node-only agent runtime facade (no browser), injecting adapters for these host capabilities suffices to
reach parity with what HeadlessHost + LiveEditorHost collectively cover:

1. Must inject (nothing headless provides): `JobRunner` — either a `createGpuJobRunner` config (gpuBaseUrl,
   brokerBaseUrl, bundleId, instanceId) or a stub/local exporter; covers all 5 needs-jobRunner tools.
   Wire-through already exists: `new HeadlessHost(p,{jobRunner})` (run.ts:39).
2. Should inject for useful headless behavior:
   - media ingest adapter for `importMediaFromUrl(url,name)` (fetch + probe duration/dimensions, push MediaItem)
     unlocks import_media_from_url and motion import_image_layer.
   - file-backed `saveProject` → map to saveProjectFile semantics, or filter save_project out of the advertised
     tool list.
3. Optional surface that can remain UNSUPPORTED (accepted degradation): create/open/list_project lifecycle,
   exportMotionScene, motionRenderQueue bridge, rigging/model-inspection trio. Failure mode is already clean.
4. Not required: overlay engine-aware methods (createTextOverlay etc.) IF serialized-project output is the
   product — the action fallbacks keep those 12 tools functional, though ids must be generated tool-side to fix
   RUNNER-02 (small registry patch, e.g. genId() into clip before applyAction).
5. Transactions and undo must keep snapshot semantics (structuredClone + history.clear on rollback) if a facade
   reimplements EditingHost; tests prove inverse-replay alone is insufficient guard (loop relies on rollback).
6. Persistence contract stays `{version:"1.0.0", project}` JSON; validation-before-load with throw-on-invalid is
   cheap and already proven in vitest suites (project-io.test.ts) runnable under plain node --experimental-transform-types.
