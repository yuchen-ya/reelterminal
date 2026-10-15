# Windows stability follow-up, 2026-10-15

## Baseline and scope

The clean local `main` at `8e3fd11f` was fast-forwarded to
`7e467bacd1aefc8d4666d10d3e59ab2d9f7c4667`. Active-process inspection found no
ReelTerminal application or repository build/test process before testing. All
work used the sole checkout, disposable harness profiles and serial tests.
No installer, native package, signing or Release operation was run.

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
- Old Mac startup attribution needs only the four retained original test logs,
  failure JSON and corresponding main/renderer logs. Native memory attribution
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

## Retained local evidence

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

## Retained local evidence

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
