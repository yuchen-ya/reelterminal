# Windows stability follow-up, 2026-10-15

## Baseline and scope

The clean local `main` at `8e3fd11f` was fast-forwarded to
`7e467bacd1aefc8d4666d10d3e59ab2d9f7c4667`. Active-process inspection found no
ReelTerminal application or repository build/test process before testing. All
work used the sole checkout, disposable harness profiles and serial tests.
Initial investigation excluded packaging. The later user instruction authorizes
an isolated local Windows candidate after targeted validation; package identity
and smoke results will be recorded separately. No signing or actual publication
is authorized for this Windows task.

The three committed Mac reports and their JSON were read from the fetched
baseline. Their raw Mac evidence is **not available on this Windows host**.
This follow-up does not replace their conclusions or repeat the completed
ten-export/300.442-second Mac round.

## Startup and export investigation

- The baseline source build passed. The first build invocation failed because
  this process did not have `pnpm` on PATH; a temporary Corepack shim fixed the
  test environment. Both logs are retained.
- One existing full calibration passed on Windows: 20/20 ABBA groups, 57.242
  seconds in the test, artifact `probe-calibration-1792053603829.json`. This is
  one successful startup, not an attribution or resolution of the four older
  Mac `open_fixture` timeouts.
- Calibration stages now distinguish the project click, editor mount, Agent
  enablement, endpoint wait and connector connection. The previous
  `open_fixture` label covered all five and could not identify the failed
  boundary. Primary-error/log preservation remains unchanged.
- The 46 tests in `export-engine`, `mediabunny-export-decoder`,
  `video-engine-export-effects` and `video-engine-mask-compositing` passed
  serially on Windows (1.71 seconds). These validate the synced cursor fixes;
  they do not establish a bound on native/shared memory.
- The later Mac handoff `54a12cd9`, preserved through `7440fbe8`, supplies
  redacted original error/log excerpts and matching-build controls. It confirms
  three failures in the exact Open-button locator/click wait, before any
  logged click was dispatched; the first primary error was lost. It still
  cannot distinguish missing React/library DOM from a stalled injected-script
  poll. No existing evidence supplies that missing DOM retrospectively.
  Native memory attribution
  still needs the existing phase/idle vmmap stdout **and stderr**, process-role
  samples and comparable retained-object/allocator evidence. History/GUI heap
  attribution needs the retained R02 idle samples and matching object-retainer
  evidence. No Mac task or full rerun was requested or started.

## Comparison layout: test timing defect

[Baseline Electron run](https://github.com/yuchen-ya/reelterminal/actions/runs/38697797091)
still failed on both operating systems. Its Windows decoder-worker pair passed
(6.463 seconds), unlike the older first-frame failure; that older failure is
not treated as a continuously reproduced product defect.

The comparison assertion was reproduced locally twice without changing product
code or its `height > 40` threshold. Initial heights were 24.615 and 23.198 CSS
pixels. A bounded five-sample diagnostic trace showed the same frame becoming
57.656 pixels high after about 500 ms and remaining there. The existing CSS
size transition was still running when the old test measured the frame.

The test now waits for the frame/video area's actual transitions to finish and
for the displayed dimensions to match the requested inline dimensions, within
the existing five-second wait. The original layout, playback and reference
alignment assertions remain. Geometry and a screenshot are always retained.

Serial targeted verification: comparison playback, offline decode worker,
first visible frame while optional workers are held, and calibration failure
preservation: **5 passed, 11.33 seconds**. The unchanged first-frame condition
still has its original eight-second timeout. No product layout change was
justified by this reproduction.

## Duplicate selection: product context-CAS defect

Updating the old flow tests to pass explicit project/workspace ids exposed a
second failure: Flow A's valid rewrite was rejected with context revision
`3 -> 4`, while project revision, selection ids, playhead, target point,
references and workspace identity were unchanged. This was not bypassed with
a fresh read/retry or by removing the context-CAS expectation.

Temporary selection-boundary diagnostics (removed from product source before
commit) showed a second `select` from the title's `onClick`, publishing an
identical `{ type, id, trackId }` selection. The context subscription incremented
its revision solely because the selection array had a new reference. The
saved trace is `flow-a-selection-trace.json`; `flow-a-context-before.json` and
the three diagnosis logs retain the rejected requests.

The product now compares selection length and ordered type/id/track tuples
before incrementing context revision, with a reference-equality fast path.
Repeated identical selection and redundant deselect/clear preserve the guard;
actual selection, type, track and order changes still invalidate it.

The new regression failed before the fix (expected revision 12, received 15).
After the fix, context-store and live-bridge tests passed **57/57**. Rebuilt
Windows Electron flows A/B and cross-cutting passed **12/12, 24.60 seconds**,
including real connector writes, stale-context/project conflicts, GUI undo/redo,
rendered caption pixels, save/relaunch/reopen and endpoint security. Existing
CAS expectations and assertions were preserved. Explicit node save now supplies
the required revision and idempotency key as well as the target ids.

The evidence includes `context-unit-before.log`, `context-unit-after.log`,
`flow-a-selection-trace.json`, `context-fixed-build.log`, and
`explicit-target-flows-fixed.log` under the task artifact directory below.

## Personal library: product dialog occlusion

The baseline small-window test reproduced a real hit-testing failure: the
center of the Add link dialog's Save button was covered by the timeline
toolbar (`relative z-50`). Its unchanged normal Playwright click timed out.
The retained screenshot also shows the lower dialog controls occluded.

Both library entry dialogs were rendered inside the asset region, outside the
app's established body-portal layer contract. They now portal to `document.body`
using the existing `--z-dialog` level and desktop theme scope. The same Save
button center now hits the button, and an ordinary mouse click persists the
link. Dialog labels/roles expose the modal boundary without changing the
existing forms or save behavior.

The current project-browser test was also updated to use the existing More
actions menu, Filters/Asset form and separate sort selector. Its original
240/320/480-pixel overflow assertions are unchanged; timeline selection is
scoped to the real timeline rather than matching the asset representation.

Verification: **6 unit tests** (both portal ownership/cancel paths plus the four
existing library cases), source renderer build/typecheck, and **2 real Electron
asset-browser tests, 6.86 seconds**, passed. Failed attempts to drive the Radix
menu in JSDOM are retained; the focused unit fixture now stubs only that menu's
action callbacks. The Electron tests still drive the real menus, normal
pointer events, preview, link save, batch organization and project attachment.
No test timeout or assertion threshold was relaxed.

Task evidence: `library-dialog-before.log`,
`asset-link-dialog-1792054420749` JSON/PNG (blocked),
`asset-link-dialog-1792054580729` JSON/PNG (unobstructed),
`library-fixed-build.log`, `library-portal-unit-isolated.log`, and
`library-browser-fixed.log`. Intermediate fixture failures remain in the
`library-portal-unit*` logs; they are not counted as passing runs.

## Current connector, CLI and archive contracts

The real CLI and generated-tool-registry tests now pass explicit project and
workspace targets. Their writes keep revision/context guards, idempotency
replay, stale-revision rejection and shared GUI undo assertions. Live save
provides the required revision/idempotency key, and the advertised save schema
must contain those fields without exposing the headless filesystem path.

The paused-title regression waits for the current `Current edits saved` toast
before the full relaunch; its reopened visible-pixel assertion is unchanged.
The archive/board test now expects all five current menu actions by exact text
and still checks every row's minimum size, alignment and non-overlap, preview
isolation, trial edits, board targeting and project-switch form retention.
All **9 Electron tests in these four files passed in 25.90 seconds**.

The three pre-existing naming failures were reproduced and removed individually:
the audio checkpoint fixture uses `.oreel`; the historical cloud-round text no
longer repeats the obsolete filename; the manual export diagnostic's existing
internal browser API has an exact-file/category-5 registry entry. The naming
gate passed, and all **5 audio-process checkpoint tests passed** (2.81 seconds).
The historical cloud run is still a fixed older SHA, not current release
qualification.

Evidence: `cli-registry-guards.log`, `archive-paused-current-ui.log` (intermediate
failures), `current-contract-e2e.log`, `naming-before.log`, `naming-after.log`,
and `audio-checkpoint-fixture.log` in the task artifact directory.

## Bounded startup evidence after the Mac handoff

The three agreed common harness files now collect structural startup evidence,
without changing product loading, increasing the click timeout, or treating an
about:blank document as React-ready. The launcher attaches timestamped page
navigation/load/crash/close observations early, plus main-process load-failure,
renderer-gone and unresponsive/responsive events. Main observation is asynchronous
and does not become a startup gate. URLs exclude query/fragment fields.

Calibration records readyState, root/library/editor presence, root child count,
locale, visibility/focus and the exact Open-button locator count before clicking
and again on failure. Document and locator probes each have an independent
two-second diagnostic deadline. Primary error/build/control/log files are
written before the optional failure snapshot (4.5-second outer deadline) and
screenshot. A hung diagnostic cannot replace the actual failure.

This observation can affect startup timing and is **diagnostic tooling, not a
root-cause fix**. The old timeout attribution and the Mac picker/native-memory
blocks remain. The Mac report was read here; original Mac profiles/log files
were not accessed. No Mac task, full calibration/stress rerun or native-picker
permission change was initiated from Windows.

Verification: performance-harness typecheck passed; **7 tests passed** (five
privacy/deadline/primary-error checks plus the two real decoder-worker tests,
4.29 seconds). The first-frame timeout remains eight seconds. Evidence:
`startup-diagnostics-typecheck.log`, `startup-diagnostics-tests.log`.

## Review evidence and strict adoption: product target routing

The real M3 test exposed another product error: creating frame-bound review
evidence failed visibly because the main production service called
`project.get_state` with `{}`. Its strict service regression failed before the
fix with `explicit workspace target required`.

The renderer, IPC guard and main service now carry both project and workspace
ids into the pre/post snapshot reads and frame render. Existing revision/frame
checks remain, and the GUI refuses adoption if the workspace changes during
native verification. No new stored fields or product feature was added.

Validation: **2 main-service tests and 4 GUI-adoption tests passed**, desktop
typecheck and the normal full desktop source build passed. The real GUI created
the requested frame 15 / 0.5-second evidence independently of its playhead,
rejected the short candidate, adopted the valid candidate and undid that
adoption correctly. The two onboarding tests also passed, including an actual
import/edit/save/MP4 export and complete FFmpeg decode.

Onboarding uses the existing explicit Add to timeline button once; the earlier
small-window container double-click produced two actual timeline ids. That
ambiguous double-click stimulus was not claimed fixed or silently accepted by
loosening clip counts. Its failed output remains in
`production-recovery-old-ui.log`. The M3 test navigates back to the preserved
inspector list and supplies explicit retry ids for honest INTERRUPTED jobs;
its original safety, undo and recovery assertions remain.

**Full M3 process recovery still fails.** With explicit retry, the original
120-second completion assertion failed (132.91 seconds total). Retained ledger
snapshots include INTERRUPTED errors and a new queued job; the batch did not
reach all-done. This is an unresolved local batch-recovery gate, not a passed
recovery test and not attributed to a mere locator issue. Investigation stops
here under the user's release-candidate convergence instruction.

Evidence: `production-target-before.log`, `production-target-after.log`,
`production-review-final.log`, `production-target-typecheck.log`,
`production-target-build.log`, `production-recovery-final.log`,
`production-recovery-explicit-retry.log`, and `m3-recovery-failure-summary.json`.
Earlier unit-fixture/type failures are retained separately. Mac report
`ef1fa632` is preserved; its native recording release gate remains blocked.

## Retained local evidence

The later authorized local Windows 1.1.2 candidate is frozen at `ca8126cf`.
Its actual packaged application passed 14 targeted E2E tests in 34.50 seconds.
Package identity, hashes, CI links and remaining release gates are recorded in
[the candidate report](windows-rc-1.1.2-2026-10-15.md) and its JSON companion.
No release was published; M3 recovery and Mac recording remain blocked.

Under `apps/desktop/e2e/.artifacts/windows-stability-2026-10-15/`:

- `electron-baseline.log`, `ci-baseline.log`: latest fixed-SHA remote failures.
- `build-baseline.log`, `build-baseline-r2.log`: environment failure and build.
- `calibration-baseline.log`, `export-regressions.log`.
- `comparison-before.log`, `comparison-diagnosis.log`,
  `startup-comparison-after.log`: failures, diagnostic trace run and verification.

Geometry JSON/screenshots are `comparison-layout-1792053695886`,
`comparison-layout-1792053758643` (five samples), and
`comparison-layout-1792053825627` (after synchronization), in the existing
harness artifact root. These ignored local artifacts are not hosted downloads.
