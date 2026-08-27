# Extraction Audit — Adversarial Review

Baseline 2566c34 (branch audit/extraction-2566c34). Stance: every headline claim treated as
wrong until evidence forced agreement. Two new scratch probes were written and run; no
product code touched (`git diff --name-status 2566c34...HEAD -- apps packages` is empty).
Probes run with `node --experimental-transform-types` + loader harness `audit/probes/lib/`.

Verification tooling added:
- `audit/probes/adversarial-count.mjs` — five independent registry projections counted.
- `audit/probes/adversarial-state.mjs` — hostile-input state probe (20 assertions).

## CLAIM-BY-CLAIM VERDICTS

### C1. "The runtime registry has 304 tools, not 228." — CONFIRMED
Independent method (runtime projections, different from dump-tool-catalog.mjs's static TOOLS splitter):
`toolDefs()`=304, `listTools()`=304 (unique 304), `toMcpTools()`=304, `toAnthropicTools()`=304,
`toOpenAITools()`=304; zero duplicate names at any layer (probe output). Domain distribution sums to 304:
read 25, motion 190, project 7, track 10, media 3, clip 11, speed 6, transform 3, effect 5, color 1,
audio 7, subtitle 5, keyframe 3, transition 3, marker 3, text 3, graphics 9, raw 2, export 7, ai 1 —
matches audit/runtime-matrix.csv rows exactly.
Phantom check: all four projections agree, so no tool exists only in one projection. Because
`REGISTRY = new Map(TOOLS.map(t => [t.name, t]))` (registry.ts:31854) would silently collapse duplicates,
the set-vs-length equality (dupes 0) rules out over-counting via re-registration. Reachability caveat:
"registered but unreachable from tools" does exist for half the JobKinds (agent-registry FINDING #12),
but that is a job surface gap, not phantom registration. The stale "228" claim verified in
docs/AGENT-CAPABILITIES.md head ("exposes **228 tools**"), while the auto-generated capability doc
embedded per-turn contains neither number. Confidence: HIGH.

### C2. "The model layer runs in pure Node (headless smoke 12/12 PASS)." — CONFIRMED (with scope limits)
Reproduced exactly: 135-file closure, stubs {polygon-clipping, @paper-design/shaders}, 12/12 PASS,
undo byte-identical restore true (audit/probes/out/headless-smoke.json regenerated this session).
Adversarial inputs do NOT break it: batch_actions failure handling, null-inverse undo/redo poisoning,
zero-metadata trim, post-commit undo, post-rollback mutation, known-prefix garbage types — all behaved
per source expectations and none threw uncaught or corrupted outside documented semantics
(audit/probes/adversarial-state.mjs output). Crucially the smoke verifies real state change, not just
`ok:true`: it asserts project.name, track counts, textClips membership/removal, and byte-identical
rollback restore (headless-smoke.mjs:179-185, 204-213, 219-222, 259-265). Stub-invalidation limit: any
FUTURE probe covering shader/shape-boolean tools (e.g. set_motion_shader_fill, merge_motion_shape_layers,
morph_motion_shape) would be vacuous — `@paper-design/shaders` and polygon-clipping return Proxy garbage;
polygon-clipping is consumed by motion-shape-modifiers.ts/motion-renderer.ts, the shader module by
motion-shader-renderer.ts. The current smoke exercises neither, so its PASS stands, but A-ratings must
not be extended to those ~10 tools on the strength of the smoke alone. Confidence: HIGH.

### C3. "No pure-Node pixel/export path exists." — CONFIRMED
Hunted hard; nothing found. The three generators are `exportVideo` (export-engine.ts:123),
`exportAudio` (:396), `exportImageSequence` (:574); exportVideo hard-requires dynamic mediabunny +
WebCodecs error path (:128-136) and its EncoderBackend contract takes `frame: ImageBitmap`
(encoder-backend.ts:18-24) — no external frame-source injection point anywhere; frames are produced
internally via VideoEngine.renderFrame. Muxer-only mp4 synthesis in Node is a dead end: both bundled
backends need an encoder before the muxer — WebCodecsBackend needs VideoEncoder chunks; NativeFFmpegBackend
sends rawvideo RGBA over desktop IPC to a spawned ffmpeg. Those ffmpeg binaries are NOT committed
(git ls-files apps/desktop/resources → only MANIFEST.json + aurora binaries; fetch script at
apps/desktop/scripts/fetch-ffmpeg.mjs), so even the encoding half has no in-repo binary today. A Node
script could replicate main-process sidecar logic IF ffmpeg existed locally, which would make export
A(encoding)+C(compositing) — the E2E row already says this ("frame rendering STILL needs C").
No hidden child_process usage under packages/core|agent|agent-runner (grep: zero non-test hits).
Confidence: HIGH.

### C4. "Overlay split-brain: raw text/create renders nothing; render reads titleEngine singleton only." — CONFIRMED (one nuance)
Verified across every render path candidate:
- video-engine.ts:1764-1776 `getActiveTextClips` reads ONLY `titleEngine.getAllTextClips()`, no project fallback,
  AND requires a matching `t.type === "text"` track with hidden=false (:1766-1771) — so even engine-registered
  clips vanish without a text track (sharpens RUNNER-02).
- canvas2d-fallback-renderer.ts and webgpu-renderer-impl.ts contain NO textClips/titleEngine reads (they are
  driven by video-engine's compositing).
- Preview.tsx also reads the singleton: `getTitleEngine().getAllTextClips()` (Preview.tsx:1192-1197) feeding
  `allTextClipsRef` → `getActiveTextClips(allTextClips, time)` (:2666) and `renderTextClipToCanvas`
  (preview/canvas-renderers.ts:543). No production render path reads project.textClips.
Nuance (partial refutation of media-render-e2e F16 wording): an actions-only overlay DOES extend the stored
model duration — ActionExecutor.recalculateTimelineDuration runs after EVERY action (action-executor.ts:284-288)
and calculateProjectDuration includes textClips/shapeClips/svgClips/stickerClips/etc.
(timeline/project-duration.ts:12-32). Only ExportEngine's own private calc ignores them (export-engine.ts:1200-1240).
So "neither extends the timeline nor exports" is wrong by halves: project.timeline.duration grows; exported length does not.
Severity of MEDIA-02 unchanged (pixels still invisible headlessly). Confidence: HIGH.

### C5. "executeMany and batch_actions are non-atomic; loop commits partial turns." — CONFIRMED
Source re-read plus probe. executeMany: plain loop, break on first failure, each execute independently commits
project+history (action-executor.ts:129-144); no compensation anywhere. batch_actions handler identical shape
(registry.ts:31545-31564), probe: [rename, clip/trim(missing clipId)] → BATCH_FAILED with the rename still applied
(probe A1/A2). Loop: one txn opened before first LLM call (loop.ts:116); commit returns committed:true for
"budget" (checked between steps, before the LLM call), end_turn (:142-154), max_tool_calls (:244-256) and
max_steps (:257-266); rollback ONLY in catch (loop.ts:267). Failed tool
calls return ToolResults, not throws, so they commit like everything else. No compensating-action logic found
anywhere in loop.ts/registry.ts/core. Also observed: batch stop index misreported as `#${applied}` (count of
successes, so step 3 failing prints "#2") — minor operator bug at registry.ts:31559. Confidence: HIGH.

### C6. "Null-inverse undo arms a bogus redo that double-applies." — CONFIRMED (empirically)
Probe drives ActionExecutor+ActionHistory directly (adversarial-state.mjs cases B/C):
- clip/merge passes validation with ANY params (no validator case) and applies as a ghost-clip APPEND when
  params.originalClip carries a valid Clip object and clipId matches nothing (B1: success=true, ghost present).
  Its inverse is null (no generator case).
- Single-entry: undo() fails with "No inverse action available", state UNCHANGED (still merged/slipped),
  canRedo flips true because action-history.ts:233-240 pops the entry onto redoStack BEFORE the group filter
  drops the null inverse (:260), and executor.undo errors after the pop (action-executor.ts:155-166). B2-B4.
- Double-apply demonstrated with delta-semantics op `clip/slip` (inPoint += delta, action-executor.ts:989-1000):
  slip(delta=2) → failed undo leaves inPoint=2 → redo replays the ORIGINAL never-undone action → inPoint=4 (B8).
  The original never undone is literally re-executed; redo order is also LIFO over a mixed stack, replaying the
  null-inverse entry FIRST (C1-C3). One precision adjustment to CORE-02's wording: the corruption requires the
  replayed action to be non-idempotent (delta ops qualify; my first merge-append attempt was coincidentally
  idempotent — B5 note). Confidence: DEMONSTRATED, HIGH.

### C7. "124 motion tools funnel through motion/upsertComposition." — CONFIRMED
124 catalog rows carry action_type=motion/upsertComposition (counted from runtime-matrix.csv). Sampled five
mutation tools end-to-end: add_motion_layer → applyMotionAction(host,"motion/upsertComposition") at
registry.ts:22746(rel. next-tool scan); animate_layer → commitMotionComposition (helper :1522 → applyMotionAction
:1924); remove_motion_keyframe, set_motion_layer_transform, trim_motion_layer likewise reference the same helpers.
Bypass hunt: searched for direct project mutation from handlers — zero hits of `(host.getProject() as any)`
or array-push on live state (the `.objects.push` hits at :11918/:12152/:12390/:12570 are local draft builders);
recover_motion_scene3d_to_creation and simulate_creation_rigid_drop/rigid_bodies, whose matrix action_type cells
are EMPTY, actually route through persistMotionSceneCreationDraft/commitCreationRigidBake →
applyCreationOperations → applyMotionAction("creation/applyOperation") (registry.ts:7798-7850, rigid-bake lines
~132-136 within helper). So: no bypass found; instead a catalog attribution gap (see Integrity). Confidence: HIGH.

### C8. "Desktop MCP exposes all 304 tools unfiltered, default-on auto-allow, no txn." — CONFIRMED
mcp-listener.ts:174-212 re-read: listTools returns `toMcpTools()` verbatim; callTool checks only
`useSettingsStore.getState().mcpAutoAllowTrustedLocal` against destructive/expensive flags, then
runExclusive(() => executeTool(name,args,getLiveEditorHost())). No whitelist/allowlist/prefix filter exists at
shim, http-server, core.ts, dispatcher, renderer-bridge or listener (grep of full chain). Default `true` at
apps/web/src/stores/settings-store.ts:129. No beginTransaction/commitTransaction call sites anywhere in the
bridge (the per-call serialization is mutual exclusion, not atomicity). The only mitigation is
CONFIRMATION_REQUIRED when auto-allow is off. Confidence: HIGH.

### C9. "Import: no headless path; import_media_from_url desktop-gated; media/import unreachable and zeroes metadata." — CONFIRMED (tool-level)
Three sub-claims hold: (a) catalog contains ZERO tools mapping to media/import (grep = 0 hits), and its executor
stores `duration: 0, width: 0, height: 0, frameRate: 0` (action-executor.ts:356-380); JSON-RPC cannot carry the
required Blob/File param anyway, so even execute_action cannot make it useful from MCP. (b) live-host.ts:242-250:
throws "Media download is only available in the desktop app" without window.openreel.media.fetchUrl; HeadlessHost
has no importMediaFromUrl at all. (c) No byte/base64/dataUrl ingestion tool exists — registry dataUrl matches are
image OUTPUTS only (render_motion_frame result at :1563/1581, creation preview :12798).
Feasibility nuance FOR the A-adapter: MediaImportService is closer to Node-compatible than area report implies —
document.createElement branches are gated behind quickMode (thumbnails :176, waveform :238) and canBrowserPlay is
only invoked for `video/quicktime` files (:150-153), so a plain H.264 mp4 with quickMode=true touches only mediabunny
Input/BlobSource (pure JS). This strengthens e2e row #3's "~50 LOC HeadlessHost.importMediaFromUrl" estimate; it does
not change any letter since no tool surfaces it. Motion-domain import_image_layer inherits the same gate (catalog line 276).
Confidence: HIGH.

### C10. E2E letters 2=P / 3=A / 4=P / 5=model-P,pixels-X / 6=X→C / 7=X→A — CONFIRMED
- "Trim is pure model math": proven at runtime — executeTool("trim_clip",{clipIndex:0,inPoint:1,outPoint:3}) succeeds
  against a project with an EMPTY mediaLibrary (media item absent entirely) and mutates model state (D1/D2); validator
  for clip/trim inspects clip existence and param shapes only, no metadata consult. Additionally reproduced the F9
  stale-base defect empirically: moving BOTH points left `duration=3` where outPoint−inPoint=2 (D2 detail) — the audit
  described this precisely (action-executor.ts:788-813).
  Caveat for consumers: add_clip DOES depend on metadata.duration fallback (=5 s) and trim semantics assume the in/out
  points fit the source — but validation itself is metadata-free, so letter P stands.
- "NO pure-node export can exist": held down per C3 (encoder prerequisite, no injected frame source, no committed
  ffmpeg binary, no child_process usage). Letters 6 (X→C) and 7 (X→A once an ffprobe binary is sourced) stand.
- Spot consistency: letters 2/3/4/5 match source read during C4/C9 verification. Confidence: HIGH.

## NEW-FINDINGS (missed by the six area audits)

NF-1 (MED) Raw overlays DO grow the stored timeline.duration. calculateProjectDuration includes
project.textClips/shapeClips/svgClips/stickerClips/adjustmentLayers/nestedInstances/motionInstances
(packages/core/src/timeline/project-duration.ts:19-25) and runs after every action
(action-executor.ts:284-288). So a headless text/create run persists a longer `timeline.duration` in saved
JSON even though pixels never render. Partially refutes the wording of media-render-e2e F16; any facade
length/duration accounting reading project.timeline.duration will diverge from what exports produce.
NF-2 (MED) clip/merge executes as a silent ghost-clip ADD when originalClip mismatches. Validator has no case
for merge (validator-gap class), the executor appends `params.originalClip` to the track even when NOTHING was
merged away (action-executor.ts:848-869; probe B1). A model sending a plausible-but-wrong merge corrupts the
timeline invisibly and arms the poisoned-redo trap of C6.
NF-3 (MED) Tool-level silent success-no-op. executeTool("trim_clip",{clipId:"c1",startTime:999,endTime:-5})
returned ok:true "trim_clip applied" with ZERO model change — wrong arg names ignored, missing
inPoint/outPoint coalesced to current values. Unlike the loop's transcript failures these look successful to
retry/orchestration layers. Extends AREA-04/CORE-08 from the raw-action layer into the advertised 304-tool
surface (evidence: adversarial-state.mjs "[info] trim with nonsense times" line). Suggests systemic looseness
across thin mapParams wrappers; deserves a per-tool args-diff test suite before facade reliance.
NF-4 (LOW-MED) Creation-draft tools = N separate actions per tool call. persistMotionSceneCreationDraft emits
asset/upsert ×N + scene/upsert + scene/set-active as independent applyAction calls stopping on first failure
(registry.ts:7798-7811,7850+). Under loop txns they group; via direct MCP they land as N+2 separate undo steps
AND a partially-built draft survives if a middle operation fails — undo granularity mismatch across transports.
NF-5 (LOW) Stale-handle mutations survive rollback. After rollbackTransaction, subsequent applyAction calls
apply and persist normally (probe F1/F2): the snapshot restore doesn't close the door, only restores once.
HeadlessHost.commitTransaction is similarly unguarded except for the unknown-handle no-op noted by the audit.
NF-6 (LOW) Committed != irreversible. history persists across commitTransaction; a plain host-side undo()
afterwards reverts the committed turn (probe E1). Correct against live-host UX ("whole turn undoes as one
group") but contradicts any extraction design treating commit as durability; facades must advertise commit as
"grouping ended", not "sealed".
NF-7 (INFO) batch_actions failure index off-by-one: reports `#${applied}` (number of succeeded steps) rather
than the failing step's 1-based position (registry.ts:31559).

## AUDIT-INTEGRITY (mechanical checks)

- tool-catalog.jsonl: 304 lines, all valid JSONL, 304 unique names, expected field set present
  (name/domain/title/description/flags/input_schema/source/action_type/action_via_helper/host_methods/
  core_symbols/uses_map_params/editing_host_optional_methods/availability_mechanical/evidence).
- action-map.jsonl: 110 records, 110 unique action_type values, valid JSONL.
- risk-register.csv: 46 lines = header + 45 data rows, all rows ≥3 columns (parseable).
- runtime-matrix.csv: header + 304 rows; domain tallies match live byDomain counts exactly.
- git: `git diff --stat/name-status 2566c34...HEAD -- apps packages` empty (product code untouched);
  audit artifacts are the only divergence; working tree clean before my two new probe files.
- baseline.json consistent with git log (subject, date, SHA).
- Cross-audit numbers agree: summary json dupes=[] static_runtime_match=true; agent-runner area's viability
  totals (273/12/5/14) consistent with catalog optional-method columns.
- Known acknowledged drift inside the audit itself (confirmed accurate): helper-mediated action routing hides
  host methods and action types — recover_motion_scene3d_to_creation / simulate_creation_rigid_* show empty
  action_type though they dispatch creation/applyOperation (G-07/RUNNER-05); treat matrix action_type column
  as "direct routing only".

## SEVERITY-ADJUSTMENTS

- CORE-02 (null-inverse trap): upgrade confidence HIGH → DEMONSTRATED via probe; severity stays HIGH.
  Mechanics refined: arming happens because undo() pops onto redoStack pre-filter (action-history.ts:233-241
  vs :260); damage requires non-idempotent replay (clip/slip/slide/roll verified; B8).
- AREA-04/CORE-08 (loose input validation): upgrade LOW-MED → MED; now evidenced at the TOOL layer with a
  concrete ok:true no-op (NF-3), not merely additionalProperties:true static reasoning.
- MEDIA-02 (overlay split-brain): severity stays HIGH; add NF-1 nuance so nobody "fixes" it by trusting
  timeline.duration. The fix candidate "(b) getActiveTextClips falls back to project.textClips" would ALSO
  need the text-track requirement handled (video-engine.ts:1766-1771) — fallback alone renders nothing.
- MEDIA-05 (media/import zeroes metadata): stays MEDIUM; add "unusable via execute_action too (Blob cannot
  cross JSON-RPC)" which tightens the claim rather than weakening it.
- MEDIA-06 (FFmpeg.wasm CDN supply chain): downgrade exposure surface slightly — needsTranscode for common
  mp4 with canDecode=true never reaches the CDN path (only MOV/un-decodable inputs do); probability lower than
  stated, impact unchanged.
- RUNNER-03 (partial turns persisted): confirmed from source (loop committed:true paths + run.ts save gating);
  keep MED.
- DESK-01/DESK-02 (auto-allow, no txn): confirmed verbatim from mcp-listener/settings store; keep HIGH/HIGH.
- New risk worth registering: NF-2/NF-3 combined "model-sent plausible nonsense mutates or no-ops invisibly"
  (MED) — merged with upgraded AREA-04 above for the facade checklist.
