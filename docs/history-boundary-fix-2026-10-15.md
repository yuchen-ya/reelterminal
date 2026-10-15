# Unified history boundaries follow-up

Windows x64 verification, 2026-10-15. Starting HEAD was
`62163425b8e88d008cccf91b01036c9e0d555134`, including native export protection
`0898916943f86dcf1114f40d06a9cbe72a3fc31e`. The original investigation record in
[history-boundary-verification-2026-10-15.md](history-boundary-verification-2026-10-15.md)
is preserved as historical evidence. Its test probes now assert correct behavior;
the three injected engine-failure observations remain explicitly identified.

## Contract and implementation

- **Whole project replacement** uses `ProjectState.loadProject` in
  `project/lifecycle-slice.ts`. `TemplatesTab.handleApplyTemplate` now uses that
  existing boundary, matching the welcome/inspector template entrances. Successful
  replacement installs fresh ActionHistory/ActionExecutor instances, resets recipe
  undo/redo and the redo journal, and loads overlay engines. Replacement itself is
  not undoable, consistent with the existing load contract. Confirmation cancel
  never reaches that boundary and preserves project reference, revision and history.
  Built-in IDs remain unchanged: assigning unique IDs would not make old commands
  valid against a new project. No persisted schema or migration is introduced.
- **New persisted edits** use the `set` publisher inside `createProjectStore`, also
  installed as the store's `setState`. Direct setters (including all three 3D
  controls, overlay transform/blend/animation, track grouping and media relinking)
  clear action redo, recipe redo and the journal through `invalidateRedoBranches`.
  Recorded action/recipe commits already carry their explicit branch envelope;
  they retain normal action proximity grouping. Both paths retain legitimate undo.
  Rejecting an edit before publishing preserves the branch. `rawSet` is reserved
  for history replay, project lifecycle/recovery, rejected-recipe compensation,
  and transient Motion gesture previews; the final Motion action commit invalidates
  redo. Non-project UI state writes do not invalidate history. Same-value setters
  keep their existing committed-edit convention. 3D setters remain non-undoable;
  adding new undo actions was not needed to prevent stale redo overwrites.
- **Ordering** uses `ActionHistory.nextSequence`, a per-history monotonic counter
  shared with successful recipe apply/update. The final canonical action push
  allocates its order; draft executors do not choose canonical order. `history-slice`
  compares sequences, and the Agent history summary sorts by the same field while
  keeping its external response schema. Undo/redo retain the original sequence;
  timestamps remain display metadata. Sequence gaps after discarded work are safe.
- **Grouping** uses `ActionHistory.breakGroup` at recipe commits, direct persisted
  edits and successful history traversal. It prevents proximity grouping across
  the boundary and segments still-open owner-scoped groups without losing their
  close handles. Ordinary adjacent updates retain their existing 100 ms grouping.
  Auto-group IDs include a counter to avoid same-clock ID reuse.

## Repair regression evidence

Before changing product source, the converted component/store/order probes produced
**12 failures and 7 passes** on the starting HEAD. Failures comprised three project
replacement cases, six 3D branch cases, same-millisecond ordering, and two grouping
cases (including an open explicit gesture). The passing cases included cancellation,
normal grouping, opposite same-clock order and three separately tracked injected
faults. This is a repair red/green check, not a pass of defect-observation assertions.

Coverage includes real built-in YouTube Intro/TikTok Promo ID overlap, replacement
cancel/success, old deletion redo rejection, new-project legal undo/redo, valid
recipe undo/redo, 3D text and timeline setters, rejected setters, controlled equal
clock order in both directions and repeated undo/redo, 1000/1040/1080 ms grouping,
open gesture boundaries, ordinary proximity grouping, and a mixed ordinary edit →
recipe → recipe undo → 3D edit → whole replacement → undo/redo sequence.

The isolated Electron regressions use actual mouse/keyboard/native-select input.
The Agent connection only reads project/history. `whole-template-history.e2e.ts`
verifies cancel equality, blocked old audio/deletion history, no Channel Name/CTA
mixing, and legitimate delete/undo/redo after replacement. `template-history.e2e.ts`
verifies the previous recipe branch fix and all three real 3D inspector controls
on a recipe text overlay after recipe-update undo. The topmost text overlay is
selected because both generated texts overlap on the same timeline lane. Each
launch uses the harness's private temporary profile, endpoint and synthesized video.
The user's running app, project and media were not accessed. Raw screenshots/state
remain gitignored; no personal paths, credentials or source media are committed.

Commands (standard repository scripts; a temporary pnpm PATH shim was needed in
this Windows shell, without changing repository dependency files):

```text
pnpm -r --workspace-concurrency=1 typecheck
pnpm -r --workspace-concurrency=1 lint
pnpm --filter @reelterminal/web exec vitest run --maxWorkers=2
pnpm --filter @reelterminal/core exec vitest run src/actions/action-history.test.ts src/actions/action-executor.test.ts src/actions/media-byte-retention.test.ts --maxWorkers=1
pnpm --filter @reelterminal/desktop build:renderer
pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts e2e/whole-template-history.e2e.ts e2e/template-history.e2e.ts
pnpm --filter @reelterminal/desktop exec vitest run src/main/sidecar/export-job.test.ts src/main/ipc/export.test.ts test/export-file-protection.test.ts test/export-integration.test.ts test/ipc-contract.test.ts
```

Local full web run: **288 files, 1885 passed, 7 existing skips**. After the final
Motion preview exception/history-traversal boundary, targeted history, Motion,
Agent bridge and renderer export verification: **8 files, 115 passed**. Core
history/executor/media retention: **105 passed**. Desktop native export protection:
**36 passed**, with `EXPECT_FFMPEG=1`, including actual FFmpeg output/decode and the
Windows lock case. No installer or release package was produced.

An initial sandboxed Electron launch failed before any test gesture (one skipped
case, suite launch error). Outside the sandbox the isolated app launched normally.
Two development GUI attempts exposed locator errors (overlapping lower text and
section accessibility naming); both were corrected in the test, without product
changes. Passing GUI runs are Windows evidence only. Controlled clock tests are
store tests, not claims of natural GUI timing reproduction. macOS/Linux local GUI
acceptance was not performed; final remote CI results are reported separately.

## Separately tracked engine restoration fault

The three `GraphicsEngine.createShape` one-shot injection cases still demonstrate
that recipe update/undo/redo can modify engine caches before canonical project and
history commit. No normal-operation trigger was established. This patch leaves
those probes as known-fault observations and does not claim engine transactionality.

The smallest follow-up is a recipe-operation exception boundary that reloads the
canonical project's text/shape/SVG/sticker caches (and affected effect bridge state)
on failure, preserves history/journal, and returns an explicit failure. Verify
canonical snapshots and engine equality after injected update/undo/redo failures,
including a recovery-loader failure; do not swallow the exception and claim success.
Final local verification also passed all workspace typechecks and lint (warnings,
no errors), the renderer build, 170 targeted web tests (4 existing skips), and
all three GUI cases together against the rebuilt renderer.

A broader engine transaction redesign is not required by the repaired redo/order
boundaries and was deliberately excluded.

## Proposed AGENTS.md insertion (not applied)

Insert after the software-development workflow rules:

> Project history has two stacks. Whole-project replacement must call
> `ProjectState.loadProject` (`stores/project/lifecycle-slice.ts`), clearing both
> stacks and the redo journal only after confirmation; never assign a replacement
> project directly or rely on fresh entity IDs. Persisted edits must publish via
> `createProjectStore`'s default `set`/`setState` boundary or a recorded commit with
> its explicit branch envelope. Reserve `rawSet` for replay, lifecycle/recovery,
> compensation and transient Motion previews. Order action/recipe commits with
> `ActionHistory.nextSequence`, not timestamps; call `breakGroup` at external-edit
> boundaries and preserve owner-scoped gesture handles. Verify the history
> boundary/order/component tests, `project-template-history.test.ts`,
> `motion-drag-undo.test.ts`, core `action-history.test.ts`, and isolated desktop
> `template-history.e2e.ts` / `whole-template-history.e2e.ts`; commands and fault
> limits are indexed in `docs/history-boundary-fix-2026-10-15.md`. GUI tests use
> synthetic media/private profiles and never the user's open project. Built-in
> template track IDs overlap, recipe snapshots include overlays, 3D setters remain
> non-undoable, and injected engine-restore failures are a separate known issue.

Related documents: [initial recipe repair](template-redo-branch-2026-10-15.md),
[original boundary investigation](history-boundary-verification-2026-10-15.md),
[native export protection](native-export-file-protection-2026-10-15.md), and
[desktop E2E harness](../apps/desktop/e2e/README.md).

## CI focus follow-up

The initial repair commit `66448bf6c57a90d5c050758f653a76dc1f5684f7` passed
Windows Electron, Chromium and Performance workflows, but its new 3D GUI test
failed on macOS at the assertion that recipe-update undo exposed redo. The whole
project replacement test passed; the baseline screen-recording failure did not
recur. This was treated as a new regression, not dismissed because the baseline
workflow also failed.

The test had clicked the timeline to blur a recipe input before using global
keyboard input. Timeline pointer handlers prevent the default focus change, and
macOS mouse-button focus conventions can leave an input active. Project shortcut
handling intentionally ignores input targets. The follow-up sends real Undo/Redo
keyboard events through the focusable timeline locators (`Locator.press`), records
the prior DOM focus, and waits for both canonical history and text to establish
that project undo actually happened. It makes no store or engine writes and does
not change product shortcut behavior. Final-SHA CI results are reported separately.
