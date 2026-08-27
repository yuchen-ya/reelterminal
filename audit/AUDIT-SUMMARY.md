# Extraction Audit — Summary

**Verdict: CONDITIONAL GO** — the OpenReel agent layer can be extracted behind a small
facade without product refactoring; the condition is accepting a Chromium harness for the
export/preview leg of the first E2E slice (or descoping export from slice 1).

| | |
|---|---|
| Baseline | `2566c34e0f8ea22992a85f3ff16e048307b49365` (tag `openreel-baseline-2566c34`) |
| Branch | `audit/extraction-2566c34` on `origin` (private lab repo) |
| Date | 2026-08-27 |
| Scope | full agent surface: registry, core actions, hosts, transports, media/render/export |
| Method | 2 mechanical probes (runtime + static cross-check) → 6 parallel area audits → 1 adversarial review (all 10 headline claims attacked, all CONFIRMED) |
| Product code changes | **zero** (`git diff 2566c34..HEAD -- apps packages` is empty) |

## Headline numbers

- **304 tools** in the runtime registry (not 228 — `docs/AGENT-CAPABILITIES.md:5` is stale;
  generator is dynamic so the doc simply was not regenerated). 304 = runtime `toolDefs()`,
  static TOOLS-array split, and all five export projections agree; zero duplicates.
- **110 action types** across 4 disjoint dispatch layers (36 registry handlers, 74 executor
  switch cases, 52 validator cases, 56 inverse-generator cases).
- **19 facade verbs** proposed, replacing the 304 for external callers
  (`facade-v0.md`); per-tool dispositions for all 304 in `runtime-matrix.csv`.
- **52 risks** registered (`risk-register.csv`): 10 high, 22 medium, 20 low/info.
- Headless smoke probe: **12/12 PASS** in pure Node (`audit/probes/headless-smoke.mjs`).

## The 10 findings that matter most

1. **Model layer is genuinely pure-Node.** Registry + HeadlessHost + ActionExecutor load
   and execute in Node 22 with only 2 third-party stubs (probe-verified, 135-file closure).
   ~273/304 tools work against HeadlessHost as-is; 14 fail cleanly UNSUPPORTED; 5 need an
   injected JobRunner; 12 overlay tools degrade. (areas/agent-runner-headless.md)
2. **No pure-Node pixel path exists — anywhere.** Every frame producer needs browser APIs
   (OffscreenCanvas/createImageBitmap/WebCodecs); export = WebCodecs+mediabunny (browser) or
   bundled ffmpeg sidecar (desktop) or external GPU service. Encoder contract takes
   `ImageBitmap`; no frame-injection seam; ffmpeg binaries are not even committed.
   Adversarial review attacked this hard and it held. (areas/media-render-e2e.md F17-F21,
   adversarial-review.md C3)
3. **Overlay split-brain (HIGH).** Render/export read text/shape/svg/sticker clips from
   engine singletons (`titleEngine`/`graphicsEngine`); raw actions write only
   `project.textClips` mirrors — "renders nothing" is documented in the source
   (`host.ts:250-263`) and probe-reproduced. Headless text is invisible; export duration
   ignores overlays while stored `timeline.duration` includes them (NF-1 divergence).
4. **Atomicity does not exist below the facade.** `executeMany`/`batch_actions` are
   best-effort stop-on-failure with prior steps committed (probe-confirmed); the agent loop
   commits on every stop condition including budget exhaustion; rollback only on throw.
   (CORE-01, AREA-01, DESK-02)
5. **Null-inverse undo trap (HIGH, DEMONSTRATED).** 8+ action types have no inverse
   (clip/merge, slip, slide, roll, trimToPlayhead, project/create, restore family);
   undoing one pops it onto the redo stack anyway, and redo re-executes the never-undone
   original — probe: slip(delta=2) → failed undo → redo → inPoint=4. (CORE-02)
6. **Silent no-op success.** Known-prefix unknown action types validate-and-succeed as
   no-ops (no `default:` in validator switches); tool layer repeats it (wrong arg names →
   `ok:true`, zero change — NF-3). Hostile to autonomous agents. (CORE-08, AREA-04, ADV-03)
7. **Desktop MCP is debugger-grade security.** All 304 tools exposed unfiltered over
   loopback HTTP; Bearer token written to a 0600 endpoint file AND shown in the UI;
   destructive/expensive gate defaults to auto-allow=true; no transaction crosses the
   boundary; timed-out calls keep mutating. (DESK-01/02/04)
8. **Headless media ingest is starved.** Only `import_media_from_url` exists and it is
   desktop-gated; core's `media/import` action is unreachable from any tool and zeroes
   metadata. Fix is a ~50 LOC adapter (fs→File→mediabunny, quickMode skips DOM branches —
   feasibility improved by adversarial review C9). (MEDIA-03)
9. **Registry→action topology is facade-friendly.** 61 actionTool + 56 applyMotionAction +
   124 commitMotionComposition tools are pure data-driven mappings (124 motion tools all
   funnel to `motion/upsertComposition`) — collapsing them into ~19 facade verbs is a
   mechanical exercise, not a redesign. (tool-catalog.jsonl `action_type` evidence)
10. **Capability signals lie by omission.** `capabilities()` returns a static manifest
    regardless of injected jobs/host optionals; a headless agent is told export exists until
    it fails with JOB_FAILED. Facade `capabilities.get` must report live availability.
    (RUNNER-06)

## E2E minimal path — verdict per step (details: `e2e-contract.md`)

| Step | Letter | Note |
|---|---|---|
| Agent → MCP transport | D | desktop-window-bound; v0 bypasses via direct `executeTool` seam |
| facade → headless runtime | **P** | probe-proven |
| create_project | P→A | ~20 LOC host passthrough |
| import input.mp4 | **A** | ~50 LOC `HeadlessHost.importMediaFromUrl` |
| trim 0–5s | **P** | metadata-free (probe); send single-point trim |
| add "Hello world" | model **P** / pixels **X** | needs engine-sync adapter or renderer fallback (~15-50 LOC) |
| export output.mp4 | **X** headless → **C** pragmatic | Chromium harness running the existing web job runner |
| ffprobe + frame/OCR | X→**A** | greenfield, ~30 LOC once ffprobe binary source chosen |

No unexplained unknowns remain on this path: every X names its blocker and its smallest
unblocking adapter.

## Facade v0 (details: `facade-v0.md`)

19 verbs — capabilities.get; project.create/open/save/get_state; media.import/list/delete;
timeline.get; edit.apply (atomic batch over a closed op set); history.undo/redo/list;
preview.render_frame; export.start; job.status/cancel; verify.artifact; session.describe.
Contracts defined: atomic batch (pre-validate + snapshot txn), revision preconditions
(facade-owned counter — core has none), idempotency ledger (core mints fresh ids),
async-job surface (replaces 30-min blocking calls), typed error taxonomy, content-hashed
artifact contract, re-drawn confirmation policy. No facade implementation in this phase.

## First recommended implementation slice

**Slice 1 (pure Node, ~1-2 days): the headless model E2E.**
1. `HeadlessHost.importMediaFromUrl(pathOrUrl)` adapter (fs→File→mediabunny, quickMode).
2. `HeadlessHost.createTextOverlay` engine-sync adapter (register into `titleEngine` +
   mirror), plus tool-side clip.id generation (RUNNER-02).
3. Facade skeleton (library, no transport): `edit.apply` with snapshot txn + strict arg
   validation + idempotency ledger; `project.get_state` with revision counter.
4. E2E script: create → import input.mp4 → add_clip → trim 0–5 → text → assert project
   JSON diffs (state-level verification only). All P.
**Slice 1b: pixels.** Chromium harness (Playwright) driving the existing web export job
runner, download intercepted; `verify.artifact` via system ffprobe + frame extract;
OCR/pixel check for "Hello world". Upgrades step 6 to C and completes the brief's path.

## Open product decisions (need owner input)

1. **Export leg strategy**: Chromium harness (fastest, honest C) vs investing in a Node
   compositor extraction (large, multi-week) vs cloud GPU runner (external infra + broker
   trust, RUNNER-04). Audit recommends Chromium harness for slice 1b.
2. **Desktop MCP hardening** (default-off auto-allow, token exposure, preload FS scoping):
   product-security decisions, out of facade scope but documented (DESK-01/03/04).
3. **ffprobe/binary sourcing policy** for verify.artifact: system package vs bundled.
4. **Facade packaging**: in-process library first (recommended) vs standalone service.

## Deliverables index

| File | Content |
|---|---|
| `audit/baseline.json` | pinned baseline, pushed refs, exclusion verification, environment |
| `audit/tool-catalog.jsonl` | 304 tools × mechanical fields (schema/flags/helper/action/host methods/core symbols/availability) |
| `audit/action-map.jsonl` | 110 action types × dispatch layers + live validate/invert probes |
| `audit/runtime-matrix.csv` | 304 tools × host availability + facade disposition |
| `audit/state-authority.md` | per-slice authority map incl. the overlay split |
| `audit/transport-audit.md` | 6 transports, auth, txn semantics, security verdict |
| `audit/media-render-map.md` | import/trim/text/preview/export pipelines per environment |
| `audit/e2e-contract.md` | the P/A/C/D/X path + the contract its implementation must honor |
| `audit/facade-v0.md` | 19 verbs + 7 contracts |
| `audit/risk-register.csv` | 52 risks w/ evidence + facade mitigation |
| `audit/areas/*.md` | 6 area reports + adversarial review |
| `audit/probes/**` | reproducible probes (registry dump, action map, headless smoke, adversarial count/state, matrix builder) |

## Verification checklist (all green)

- [x] 304/304 tools cataloged (the brief's "228" is a stale doc number; the true set is
      fully covered — verified by two independent methods).
- [x] No unexplained unknown on the E2E path (each X carries blocker + minimal adapter).
- [x] `git diff 2566c34..HEAD -- apps packages` empty (also verified by adversarial review).
- [x] No secrets, no local absolute paths, no media files in audit artifacts (grep-verified).
- [x] This report carries an explicit verdict + next slice.
- [x] All commits land on `audit/extraction-2566c34`; main untouched; no release.

## Reproduce

```sh
node --experimental-transform-types audit/probes/dump-tool-catalog.mjs   # 304, static==runtime
node --experimental-transform-types audit/probes/dump-action-map.mjs     # 110 action types
node --experimental-transform-types audit/probes/headless-smoke.mjs      # 12/12 PASS
node --experimental-transform-types audit/probes/adversarial-count.mjs   # independent recount
node --experimental-transform-types audit/probes/adversarial-state.mjs   # hostile-input probes
node audit/probes/build-runtime-matrix.mjs                               # runtime-matrix.csv
```
