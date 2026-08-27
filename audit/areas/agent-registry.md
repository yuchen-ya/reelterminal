# Extraction Audit — Area: packages/agent (tool registry & loop machinery)

Baseline: 2566c34e0f8ea22992a85f3ff16e048307b49365 (branch audit/extraction-2566c34). Read-only audit; nothing committed.

## SUMMARY

- 304 tools registered in one flat `TOOLS` array inside a single 31,930-line `registry.ts`; runtime composition confirmed mechanically at 215 inline-object / 61 `actionTool` / 21 `readTool` / 4 `overlayRemoveTool` / 3 `jobTool`, spread over the 20 `ToolDomain`s declared in types.ts.
- Execution contract: LLM tool_use → `runTurn` → `executeTool(name,args,host)` → clip-ref resolution → `tool.handler(args, host)` → mostly one `host.applyAction({type,id,timestamp,params})` or an optional host method → `ToolResult{ok,summary,data,error?,image?}`. No JSON-Schema validation runs anywhere; schemas are documentation only (`additionalProperties:true` throughout).
- Confirmation gate is purely flag-driven: `destructive || expensive` triggers `confirmGate` unless `dryRun`. Only 33 destructive + 9 expensive tools are gated; the flag assignment is asymmetric across domains (motion removes flagged, timeline keyframe/marker/transition/effect removals not).
- The whole turn runs inside ONE host transaction begun before the first LLM call. All stop conditions commit (including budget/max_steps/max_tool_calls); rollback happens only when something THROWS — and `batch_actions` swallows failures instead of throwing, so its earlier steps are never rolled back.
- `serialize.ts` exposes compact blob-free views; paging exists ONLY for clips (offset/limit). Motion compositions are dumped full-detail by dedicated readTools with no pagination.
- System prompt names zero nonexistent tools (mechanically checked against the catalog), but generated docs claim 228 tools vs 304 at runtime — stale regeneration.
- Raw domain: `execute_action` dispatches any action type unvalidated; `batch_actions` is sequential stop-on-first-failure, NOT atomic and NOT idempotent.
- Jobs: `JobRunner(kind,params)` is injected per host; registry wraps only 3 of the 9 `JobKind`s as jobTools, but image previews also go through `host.runJob("exportFrame")` internally.
- Error codes are loose string enums, not a closed union (list in FINDINGS #6).

## FINDINGS

1. **Registry shape**: one module-level array `TOOLS: RegisteredTool[]` (packages/agent/src/registry.ts:10664) built from helper factories plus ~215 hand-written object literals; lookup is a Map built once (registry.ts:31854-31862). Provider projections share the same list (`toAnthropicTools` :31875, `toOpenAITools` :31884, `toMcpTools` :31895); `toCapabilityDoc()` regenerates the system prompt's domain-indexed catalog (:31908-31929). Confidence HIGH.

2. **Helper classification flags**:
   - `actionTool(spec)` always `readOnly:false`, destructive/expensive default false (registry.ts:1946-1972).
   - `readTool(...)` hard-codes domain "read", readOnly true, non-destructive/non-expensive (registry.ts:1975-1996).
   - `jobTool(...)` hard-codes `expensive:true` (registry.ts:10595-10620).
   - `overlayRemoveTool(...)` hard-codes `destructive:true` (registry.ts:10622-10661).
   Inline objects restate all three booleans explicitly each time (e.g. registry.ts:31583-31585). Confidence HIGH.

3. **Tool execution contract** (packages/agent/src/executor.ts:32-52): unknown name → `{ok:false,error:{code:"UNKNOWN_TOOL"}}`; then `resolveRefs` upgrades `clipIndex`/`atSec`+`trackIndex` to a canonical `clipId` via `resolveClipId` (executor.ts:11-30; serialize.ts:215-241) so any tool accepts agent-friendly refs even if its schema omits them; thrown errors become `{code:"TOOL_ERROR"}`. Handler results flow to `buildToolResultContent` which JSON-stringifies `{ok,summary,data,error}` and appends base64 image blocks for Anthropic-format transcripts (loop.ts:67-89). Confidence HIGH.

4. **Confirmation flow** (loop.ts:201-223): gate condition `!dryRun && !approveAll && (isDestructive||isExpensive)`; emits `awaiting_confirmation`, awaits `confirmGate(call)`; `"approve_for_turn"` latches approval for the rest of the turn (loop.ts:108,209); `"reject"` returns a coded error result and skips execution (:209-222). Web wiring: autoConfirm → constant approve_for_turn, else a Promise parked on a pending dialog; chat stop resolves it "reject" (apps/web/src/stores/chat-store.ts:234-244, 271-280). Headless runner passes no confirmGate, so everything auto-runs (packages/agent-runner/src/run.ts:53-60). Confidence HIGH.

5. **Limits & dryRun** (loop.ts:91-133, 225-233): defaults maxSteps=12, maxToolCalls=64; maxTokens is a soft ceiling checked BETWEEN steps, committing partial work on "budget" stop (loop.ts:119-133). When the tool-call cap trips mid-batch, remaining tool_uses are answered with synthetic MAX_TOOL_CALLS errors so both providers' transcripts stay resumable (loop.ts:166-192), then the turn commits with stoppedReason "max_tool_calls". In dryRun every non-read-only call returns synthetic `[dry-run] would call X` ok:true WITHOUT invoking confirmGate — dry-run gives no confirmation signal at all. Confidence HIGH.

6. **Error-code conventions actually used** (closed inventory):
   - Loop-generated: `MAX_TOOL_CALLS` (loop.ts:175), `REJECTED` (loop.ts:213), `LOOP_ERROR` (loop.ts:269).
   - Executor-generated: `UNKNOWN_TOOL`, `TOOL_ERROR` (executor.ts:42,50).
   - Registry literals: `INVALID_PARAMS` (~260 uses), `NOT_FOUND` (~334), `UNSUPPORTED` (6), `JOB_FAILED`, `ERROR` (fail() default, registry.ts:429), `ACTION_FAILED` (actionTool fallback :1969), `BATCH_FAILED` (batch_actions :31560).
   - Pass-through codes from core ActionResults (`result.error?.code`) and creation-validation codes (`MISSING_RENDER_OBJECT/LAYER/COMPOSITION`).
   No single type constrains this set — `ToolError.code` is plain string (types.ts:42-45). Confidence HIGH.

7. **Transactional semantics**: runTurn opens the txn before ANY model output (loop.ts:116). Commit points: end_turn :142-154, budget :124, max_tool_calls :245, max_steps :257 — i.e., all cap-stops persist partial edits. Rollback only on exception (loop.ts:266-268). HeadlessHost implements rollback as whole-project structuredClone snapshot restore + history clear, deliberately avoiding inverse-replay fragility (headless-host.ts:44-70). Because the loop treats `ok:false` tool results as normal transcript content rather than exceptions, FAILED tool calls are committed like any other step. Confidence HIGH.

8. **Serialize exposure & paging** (serialize.ts): `EditorStateView` = project id/name/settings(width,height,fps) + counts (+ optional creation summary) :8-30,:110-138; `MediaView`/`TrackView` blob-free :32-63; `ClipView` is flat with hasEffects/hasColorGrading booleans instead of payloads :53-64. Paging: `listClips(project,{offset,limit})` slices AFTER track/time filters :165-198; this offset/limit pair exists on exactly one read surface — media/tracks/compositions/layers have none. `getClipDetail` returns the raw clip object spread into one payload :200-212. Prompt embeds a fresh state snapshot every turn (system-prompt.ts:55). Confidence HIGH.

9. **System-prompt contract**: instructs seconds-float times, id-or-index-or-atSec clip refs, read-before-write, prefer dedicated tools over execute_action, warn that destructive/expensive need confirmation, motions-as-compositions→layers→keyframes workflow, pixel coords with top-left origin, "stop after edits and summarize" (system-prompt.ts:17-57). Mechanically verified: every snake_case tool name referenced by the prompt EXISTS in the registry (0 dangling refs). The prompt embeds capability doc generated from the live registry (registry.ts:31908), so enum references stay synchronized by construction. No count claims inside the prompt itself. Confidence HIGH.

10. **Stale docs**: docs/AGENT-CAPABILITIES.md:5 claims **228 tools**, but gen-docs renders `${count}` dynamically from toolDefs() (gen-docs.ts:13-15) — the doc file simply hasn't been regenerated since ~76 tools were added. Runtime truth is 304 (audit/tool-catalog.jsonl line count). Confidence HIGH.

11. **Raw domain semantics**:
    - `execute_action` (registry.ts:31514-31537): requires open project, wraps args as `{type:String(args.type), params ?? {}}` straight into applyAction; NO allow-list despite description pointing at get_capabilities. destructive:true → gated. Validation of params is entirely delegated to core ActionExecutor.
    - `batch_actions` (registry.ts:31538-31566): iterates sequentially, stops at first failure returning `BATCH_FAILED` with index/type/message; ALREADY-applied earlier actions stay in effect — no compensating rollback, because returning fail() does not throw and therefore does not trip loop rollback (#7). Not atomic; ids regenerated per run so not idempotent under retry. Confidence HIGH.

12. **JobRunner & JobKinds**: `JobKind` = transcribe | detectHighlights | removeBackground | upscale | generateMusic | inpaint | exportVideo | exportAudio | exportFrame — 9 kinds (host.ts:5-14). `runJob(kind,params)` is required on EditingHost (host.ts:207); HeadlessHost without a runner returns `{ok:false,error:"...no job runner configured"}` which jobTool maps to JOB_FAILED (headless-host.ts:72-83). But note registry images ALSO use jobs: `renderMotionFrameResult` calls `host.runJob("exportFrame",...)` (registry.ts:1554-1560) and returns ToolResult.image (registry.ts:1581) — used by render_motion_frame / render_creation_preview. Only 3 of 9 kinds have jobTool wrappers: exportVideo/exportAudio/transcribe (registry.ts:31827-31850); detectHighlights/removeBackground/upscale/generateMusic/inpaint/exportFrame are reachable only through internal helpers or direct host code paths today. Confidence HIGH (counts) / MED (claim that other kinds lack tool surfaces — they may be invoked indirectly).

13. **Optional-host feature detection pattern**: mutation tools calling optional methods check `typeof host.X === "function"` and either fall back to raw actions or fail clearly with UNSUPPORTED (host.ts:213-274 comments document why; registry.ts:15504-15506 import_media_from_url, :31600-31604 export_motion_video). Probe-style reads instead return ok-with-available:false (registry.ts:11123-11128 probe_rigging_backend) — two different "unsupported" dialects surfaced to the model. Availability of every tool was verified against LiveEditorHost + HeadlessHost per catalog `availability_mechanical`. Confidence HIGH.

14. **Overlay dual-path fix**: text/shape/sticker/svg create/update tools prefer engine-aware host methods (createTextOverlay etc.) and fall back to raw project-array actions that would render stale on the live host — host.ts:247-274 documents this class of bug; overlayRemoveTool likewise prefers `removeOverlay` over raw `text|shape|sticker|svg` removal actions (registry.ts:10644-10658, callsites :15720/:15781/:15837/:15891). Any facade must preserve this split-brain. Confidence HIGH.

15. **Confirmation-flag asymmetry**: motion-domain removes ARE destructive (`remove_motion_keyframe/marker/expression/layer/guide/light/effect/mask/...`, delete_motion_composition, delete_motion_variable), while timeline-domain removes are NOT: `remove_keyframe` registry.ts:15619, `remove_transition` :15625, `remove_marker` :15629, `remove_video_effect` :15593, `remove_audio_effect` :15606 (all plain actionTool, no destructive:true). User-facing consequence: deleting markers/transitions/keyframes/effects is never confirmation-gated while deleting a clip is. Medium-severity UX/safety inconsistency. Confidence HIGH.

16. **No argument validation against inputSchema**: `executeTool` never compares args to `tool.inputSchema`; every schema object carries `additionalProperties:true` (builder at registry.ts:407-413). Typos/extra fields pass through into action params silently. Handlers do their own ad-hoc checks (INVALID_PARAMS), but coverage varies per tool (thin wrappers validate almost nothing — e.g. set_clip_speed relies wholly on the action executor). Confidence HIGH.

17. **OpenAI adapter drops images returned by tools**: buildAnthropicBody forwards full block arrays (llm.ts:180-199), but buildOpenAIBody flattens each tool result to the FIRST text block only (llm.ts:284-292) — visual self-check loops (render_motion_frame → compare → iterate) are text-only on OpenAI providers. AnthropicClient/OpenAIClient default maxTokens 4096 (llm.ts:252,359). Retry: `withRetry` absorbs 429/5xx w/ exponential backoff + Retry-After + abortable jittered sleep (llm.ts:129-171); `LLMStopReason` is informational only (llm.ts:7-8). Providers are limited to anthropic|openai BYOK transports injected by callers (apps/web llm-transport makeBYOKClient; packages/agent-runner node-llm). Confidence HIGH.

18. **Observability is event-mapping only** (observability.ts:15-50): events → truncated flat log records; no token/cost persistence beyond RunTurnResult.usage aggregates (loop.ts:111-139 usage accumulation). Confidence HIGH.

## SPOTCHECK

20 of 304 catalog rows re-derived from source. All fields (helper, lines, domain, action_type, host_methods, flags) matched; none MISMATCHED.

| # | Tool | Helper | Fields verified | Verdict | Evidence |
|---|------|--------|-----------------|---------|----------|
| 1 | split_clip | actionTool | helper/action_type/domain/flags | OK | registry.ts:15522 (clip/split) |
| 2 | set_clip_speed | actionTool | helper/action_type/domain/flags | OK | registry.ts:15529 (clip/setSpeed) |
| 3 | add_marker | actionTool | helper/action_type/domain/flags | OK | registry.ts:15628 (marker/add) |
| 4 | remove_clip | actionTool | +destructive:true | OK | registry.ts:15519 |
| 5 | set_color_grading | actionTool | helper/action_type/domain/flags | OK | registry.ts:15599 (clip/setColorGrading) |
| 6 | create_motion_composition | inline-object | helper/domain/lines/host_methods{getProject,requireOpenProject}/at=motion/createComposition | OK | registry.ts:15894-15935 |
| 7 | create_shape_clip | inline-object | helper/domain/lines/host_methods{applyAction,createShapeOverlay}/fallback | OK | registry.ts:15721-15749 |
| 8 | export_motion_video | inline-object | helper/expensive:true/schema enum/headless-missing exportMotionScene | OK | registry.ts:31568-31637 |
| 9 | import_media_from_url | inline-object | helper/domain/UNSUPPORTED path | OK | registry.ts:15494-15513 |
| 10 | probe_rigging_backend | inline-object | helper/read-domain-inline/method guard | OK | registry.ts:11113-11139 |
| 11 | get_editor_state | readTool | helper/lines/flags/no host_methods beyond getProject | OK | registry.ts:10666-10668 |
| 12 | list_clips | readTool | helper/paging schema in source matches catalog | OK | registry.ts:10675-10681 |
| 13 | get_capabilities | readTool | helper/host_methods=[capabilities] | OK | registry.ts:10685-10687 |
| 14 | simulate_creation_cloth | readTool | helper/hostless closure → empty host_methods correct | OK | registry.ts:11062-11112 |
| 15 | get_motion_composition | readTool | helper/lines OK; see FINDING #20 caveat on mediated host use | OK* | registry.ts:23730-23742 |
| 16 | export_video | jobTool | helper/expensive/kind=exportVideo | OK | registry.ts:31827-31834 |
| 17 | export_audio | jobTool | helper/expensive/kind=exportAudio | OK | registry.ts:31835-31842 |
| 18 | transcribe_clip | jobTool | helper/domain=ai/kind=transcribe | OK | registry.ts:31843-31850 |
| 19 | remove_text_clip | overlayRemoveTool | helper/destructive/rawType=text/remove | OK | registry.ts:15720 (helper body :10622-10661) |
| 20 | remove_svg_clip | overlayRemoveTool | helper/destructive/rawType=svg/remove | OK | registry.ts:15891 |

## GAPS

- **G-01** No runtime schema validation of tool arguments (FINDING #16); no zod/AJV dependency anywhere in the package.
- **G-02** Paging only on list_clips; motion compositions/media dumps can be arbitrarily large per call.
- **G-03** OpenAI transcript loses tool-result images (FINDING #17); no provider parity tests across adapter bodies.
- **G-04** Dry-run provides no confirmation simulation for gated tools (loop.ts:225-233).
- **G-05** Only 3 of 9 JobKinds exposed as first-class tools; detectHighlights/removeBackground/upscale/generateMusic/inpaint unreachable from the standard 304-tool surface.
- **G-06** Two "unsupported host" dialects (ok:false+UNSUPPORTED vs ok:true+available:false) with no normalization (FINDING #13).
- **G-07** Mechanical `host_methods` attribution misses host access mediated through helper closures — e.g. get_motion_composition reaches host.getProject() via getMotionComposition (registry.ts:1310) yet catalogs `host_methods: []`. Affects consumers trusting that field for interface-width analysis (MED impact, LOW frequency).
- **G-08** No revision/conflict token anywhere: applyAction takes no expected-state/version; concurrent editor users can silently interleave with agent turns (whole-txn snapshot protects only the headless host).
- **G-09** Documentation drift pipeline exists (gen-docs) but no CI check pins AGENT-CAPABILITIES.md freshness to the registry count.

## RISKS

- **AREA-01 — Non-atomic batch_actions within an otherwise transactional turn** (severity HIGH): batch stops on failure but keeps prior steps (registry.ts:31559-31563); loop commits even failed turns (loop.ts:142-154,244-257). Model-visible ok:false with durable side effects confuses recovery/retry logic.
- **AREA-02 — Inconsistent destructive gating for timeline-domain deletions** (severity MED): markers/transitions/keyframes/video+audio effects delete without confirmation (registry.ts:15593,15606,15619,15625,15629) unlike motion counterparts — user surprise + facade must decide its own policy rather than inherit these flags.
- **AREA-03 — Stale capability docs (228 claimed vs 304 real)** (severity MED): LLM-facing integrations built off AGENT-CAPABILITIES.md under-advertise 76 tools; count lives in prose too (docs/AGENT-CAPABILITIES.md:5), not just machine fields.
- **AREA-04 — Unvalidated passthrough args** (severity MED): additionalProperties:true + zero schema enforcement means malformed LLM args mutate projects until core action handlers reject them late; facade needs strict validation layer (registry.ts:410-413, executor.ts:46-47).
- **AREA-05 — Soft-token budget commits partial turns** (severity LOW-MED): "budget"/max_tokens overshoot documented (loop.ts:22-28) yet still commits; clients assuming atomicity-per-turn will diverge.
- **AREA-06 — Latent widening surface of EditingHost optionals** (severity LOW-MED): 10+ optional host methods each add a feature-detect branch per tool; extraction target must version the seam or hosts/tools drift apart (host.ts:213-275).

## FACADE-NOTES (implications for a ~20-tool agent-facing facade)

- **Collapse by template, keep the txn seam**: 61 actionTools are pure config (name/domain/actionType/title/desc/schema) — a data-driven facade can map them from the existing `ActionToolSpec` table rather than porting handlers. Inline handlers cluster around 5 patterns worth elevating as facade verbs: compose/build (motion creation family ~120 tools), animate/keyframe, inspect/list (25 reads already serialize-driven), overlay CRUD (dual-path engine-aware #14), and job dispatch.
- **Atomic batch must be built, not borrowed**: neither batch_actions nor the loop provides mid-turn rollback; facade should wrap multi-step plans in beginTransaction/commitTransaction explicitly and treat thrown-vs-result failures uniformly (only HeadlessHost's snapshot rollback is robust today, headless-host.ts:44-70).
- **Idempotency is absent by design**: every write mints a fresh action id (registry.ts:400-404, genId) and raw actions don't dedupe. A facade replaying failed turns should use its own request-id ledger keyed by (turn, step) rather than relying on the engine.
- **Async jobs need a unified surface**: today async-ness is implicit — jobTools await synchronously for the whole render/transcription (expensive flag → one confirm per turn latch), while render previews sneak through the same runner (exportFrame). Facade should expose explicit job submission/status/results for all 9 JobKinds and route preview images behind the same mechanism (headless-host.ts:72-83 shows the graceful no-runner degradation to copy).
- **Revision conflicts need a new primitive**: with optimistic-less applyAction, a facade token (project modifiedAt already exists on ProjectRef, host.ts:32) should be threaded as precondition and surfaced as a typed conflict error instead of TOOL_ERROR soup.
- **Keep confirmation taxonomy small but re-draw the boundaries**: adopt the destructive/expensive/readOnly triad (it cleanly sums to the 33+9 gated set, zero overlap) but fix AREA-02 asymmetry; expose an approve_for_turn-equivalent session mode since the web store already models it (chat-store.ts:234-244).
- **Preserve agent-ergonomics contracts**: clipIndex/atSec resolution (#3), counts-first serialized snapshots (#8), per-turn embedded capability doc (#9/#10) are what let a small facade survive; regenerate AGENT-CAPABILITIES.md in CI to stop silent drift.
- **Budget guards belong in the facade**: maxSteps/maxToolCalls defaults (12/64) assume tiny models; 273 mutating × wide motion grammar needs stricter per-tool arg validation up front (the missing schema enforcement is the biggest lever for reliability).
