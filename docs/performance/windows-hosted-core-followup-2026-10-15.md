# Hosted core validation follow-up, 2026-10-15

Scope: supported editing, preview, save-point/data recovery and export flows.
This continues the [Windows candidate report](windows-rc-1.1.2-2026-10-15.md).
No installer was installed; no tag, release, signing or installer upload occurred.
Only the existing checkout and isolated test profiles were used, serially.

## Current handoff

Runtime candidate: `b62ef59eb61f57c42f250b80ae2e66544cabefac`, unsigned and
unpublished, with 27/27 packaged core checks passing. Final validation source
`9db422776d0e90cc5859a79985aa252412698e1d` passes ordinary CI, Chromium,
performance contracts and both Electron platforms (123 passed / 13 opt-in
skips each). Save completion synchronization preserves the original shared
30-second GUI action budget and one-second post-completion node assertion.
The new clean build matches 213 compared candidate payload files; the build
identity intentionally remains b62 in the retained package. No repackaging
was required for the test/comment-only follow-up.

Existing Mac a8c6925c native recording manual specialty acceptance is passed
(5f447ab7). Historical startup/source and five-second audio-test incidents,
native memory retention/bound and the local clipboard boundary remain known
risks or evidence gaps, rather than automatic hard gates for every narrower
Windows use. Latest-source Mac package and long-term no-leak claims are not
established. The final section separates supported scope from wider claims
and the user's subsequent release decision. No publication was performed.

## Existing hosted round: 7e841bf9

The already-triggered runs were reused, with no manual rerun:

| Workflow | Terminal result |
| --- | --- |
| [CI 38719480961](https://github.com/yuchen-ya/reelterminal/actions/runs/38719480961) | Success, including Test & Lint and Build |
| [Chromium 38719480777](https://github.com/yuchen-ya/reelterminal/actions/runs/38719480777) | Success, including both platform facade jobs and real runtime/transport |
| [Performance 38719480846](https://github.com/yuchen-ya/reelterminal/actions/runs/38719480846) | Success |
| [Electron 38719480730](https://github.com/yuchen-ya/reelterminal/actions/runs/38719480730) | Failed: Windows 16 failed / 105 passed / 15 skipped; Mac 20 failed / 101 passed / 15 skipped |

**M3 passed on both hosted platforms**, including the unchanged 120 s recovery
condition and dual-store assertions. The previous notification obstruction did
not recur after using its real dismiss button. The JSDOM work-asset fix also
passed the hosted main CI. These are actual hosted results, not local inference.
The earlier Mac audio-normalization 5000 ms timeout remains retained at
`e04622a3`; its cause is not declared fixed because this later facade round
passed. No additional Mac-local execution is needed for that old failure now.

## First-failure classification and user impact

| Specific test | First failing condition | Classification and action | User impact / validation |
| --- | --- | --- | --- |
| `repair-integration.e2e.ts` | Setup `media.import requires projectId` | Old explicit-target contract. Project/workspace targets now accompany scoped calls; save retains revision/idempotency guards. Normal startup-hint dismissal prevents obstruction. | No product mutation was reached by old setup. Five real connector/GUI tests now pass, including replacement CAS, undo/redo, library usage, analysis recheck and full restart (11.23 s). |
| `media-import.e2e.ts` | `project_get_state` returned INVALID_PARAMS without a target after GUI import | Old read contract; explicit scoped calls and guarded save. | Canonical GUI import was not being observed correctly. Import, undo/redo, editing and full reopen now pass (one test, 7.18 s file). |
| `multi-project-versioning.e2e.ts` | Expected zero `version-track` DOM nodes, found a hidden mounted inspector | Old UI lifecycle assumption, followed by old menu/toast labels and dependent missing-node errors. Visible active archives are now distinguished from preserved hidden panels; actions are scoped to their actual menu/notification. | All 13 Windows candidate tests pass in 45.03 s. Covers read-only preview, protected draft/adoption undo, rename, recycle/undo, cross-project isolation, fixed-input export, ask/auto/skip close and restart/idempotency. No runtime archive change was needed. |
| Same archive suite, Windows path check | Export path used long user name while expected path used 8.3 alias | Equivalent-file path contract; compare `realpathSync.native` results, retaining file existence, pinned revision and artifact verification. | Does not relax exported data validation. Verified by the same 13-test round. |
| `desktop-portals-theme.e2e.ts` | Threw `Set an external test job` | This needs no external media. It now uses its owned harness directory when no job is supplied. | Real project-menu rows, dark portal tokens and settings tested; passed (3.90 s). |
| `node-ux-fixes.e2e.ts` | Expected manual 1.6.0, received 1.7.3 | Old metadata constant; compare with the shipped manual source constant. | Real 31-second close guard, shared rename/fonts/node and packaged bilingual help passed (40.63 s). Original HEVC branch was not configured or claimed passed. |
| `paused-inspector-history.e2e.ts` | No external job/copied acceptance profile/project id | Opt-in original-project acceptance. Default skips only when no copied-profile opt-in exists; incomplete supplied configuration still fails. | Original-project paused/history combination untested here; not a default synthetic-core failure. Assertions unchanged when configured. |
| `paused-project-switch.e2e.ts`, `preview-copy.e2e.ts` | No external original HEVC source | Opt-in original-source acceptance, skipped only without that source opt-in. Supplied-source runs retain existing configuration errors and all assertions. | Original HEVC acceptance remains uncovered; synthetic save/reopen/export and immutable-media checks remain active. Three explicit skips were verified, not reported as functional passes. |
| `playback-comparison-repair.e2e.ts` | Stable Mac picture height 37 px, required >40 | Reproduced product layout defect at minimum usable height: Windows picture 39.656 px at effective 702 px window. Fixed timeline row crowded out player. Rendered split now reserves 240 px for stage and clamps the lower row without rewriting stored preference. | Before/after evidence retained. 720 and 700 requested sizes now pass the unchanged >40 limit; minimum picture 50.656 px, no controls overlap or clipped timeline (7.29 s). |
| `flow-b-canvas-caption.e2e.ts` stale-context leg | Requested (0.6,0.35), Mac observed about (0.613,0.400) | Driver cached bounds before arming and reused them after UI changes. It now waits for actual ancestor transitions, reads current bitmap/content geometry and performs one real click, with the original 0.03 tolerance and no compensating re-click. | Windows three real connector/pixel/CAS tests pass (5.68 s). Old Mac failure's exact cause cannot be proved from a Windows pass alone; updated hosted result is required before claiming that failure resolved. |

The archive first failures were not used to infer data loss. The full real
archive test now verifies the data guarantees rather than weakening them.
No timeout or geometry threshold was increased, no force-click was added,
and no assertion was removed to make these paths pass.

## Product change and candidate boundary

The only new runtime change in this continuation is the minimum-height grid
split in `apps/web/src/desktop/pages/EditPage.tsx`. Other changes are test
contracts/drivers/fixture opt-ins. Because runtime changed, a fresh clean-source
Windows candidate must replace the prior `e04622a3` candidate for release
consideration. Its identity and packaged smoke are recorded after packaging.

The local renderer build/typecheck and harness typecheck passed. The test-only
contracts above were exercised against the existing packaged runtime; the new
layout was exercised against the normally built source app. A fresh candidate
will exercise them together. Original failure rounds remain intact.

Evidence root: `apps/desktop/e2e/.artifacts/windows-stability-2026-10-15/`.
Key files: `7e841bf9-ci-terminal.json`, `7e841bf9-electron-failed.log`,
`remaining-explicit-targets.log`, `repair-explicit-targets-final.log`,
`archive-current-ui-target.log`, `archive-current-ui-scoped.log`,
`archive-current-ui-final.log`, `portal-node-ux-contracts.log`,
`external-opt-in-contract.log`, `comparison-minimum-window-before.log`,
`comparison-minimum-window-after.log`, `canvas-stable-geometry-target.log`,
`minimum-layout-renderer-build.log`, `remaining-harness-typecheck.log`.

Mac geometry screenshot/JSON came from the hosted artifact for run
38716429519 (artifact 11963870785), copied into the harness artifact root.
These are accessible hosted-runner evidence, not the unavailable original Mac
ten-export/native-picker logs. No user Mac task or permission change was made.

## Terminal hosted results for 5aece717 and follow-up

All four ordinary push runs were reused and reached terminal state:

- [CI 38722251472](https://github.com/yuchen-ya/reelterminal/actions/runs/38722251472): success, including typecheck, lint, unit tests and build.
- [Performance contracts 38722251612](https://github.com/yuchen-ya/reelterminal/actions/runs/38722251612): success.
- [Chromium 38722251509](https://github.com/yuchen-ya/reelterminal/actions/runs/38722251509): failed in the Ubuntu runtime/transport job's facade phase. The separate Ubuntu and Mac facade jobs passed. First failure was `live-session.test.ts` / `removes a saved record when the completion checkpoint fails`: terminal error was visible while `analysis.list` still contained the uncommitted record. This is a product race, not the earlier Mac five-second audio test.
- [Electron 38722251512](https://github.com/yuchen-ya/reelterminal/actions/runs/38722251512): Windows 120 passed / 3 failed / 13 skipped; Mac 114 passed / 9 failed / 13 skipped. Both passed M3, decode-worker first-frame checks and minimum-window comparison layout. Windows first failure was target-point geometry `(0.3,0.7)` versus observed `(0.293876,0.666683)`, followed by two dependent tests. Mac failures were close/relaunch lifecycle (five), unavailable Windows font (one), and comparison opacity plus two dependent undo checks (three). These are not all attributed to test tooling.

Analysis rollback now removes its small record synchronously before yielding
after a completion checkpoint rejects success. A controlled regression holds
asynchronous deletion: the original implementation fails immediately; the fix
passes. The original failing integration plus live-session and batch suites
pass (83 tests, 3.94 s), and facade typecheck passes. Evidence:
`rollback-regression-before.log`, `rollback-regression.log`,
`5aece717-chromium-failed.log`, `5aece717-electron-failed.log`.

The clean 5aece717 local candidate was built under
`apps/desktop/release/windows-rc-1.1.2-5aece717/`, unsigned and unpublished.
Its affected/core smoke **failed: 34 passed / 6 failed**, and is not a release
qualification. Failures were two clipboard checks, M3 checkpoint replacement,
and comparison opacity with two dependent undo checks. Native Electron
clipboard write/read independently returned false, as did renderer-to-native
clipboard write/read, in an active console session. This establishes a failure
below the product copy action; its OS/runtime cause is unresolved. No clipboard
policy, permission or user process was changed. Raw evidence is
`../clipboard-diagnostic-5aece717.json` and `windows-rc-5aece717-smoke.log`.

The retained M3 profile is `reelterminal-e2e-BrqHc4` under the host Temp.
The resumed job durably reports `BATCH_PERSISTENCE_FAILED`: Windows refused
renaming a new temporary checkpoint over `production-batches/m3-live.json`
with `EPERM`. Batch and task ledger agree on failure; this is not recurrence
of the repaired observer-overwrite bug. The holder/cause is unproved. No
whole-test retries or extra timeout were used to manufacture success.

The isolated opacity diagnostic passed with DOM value, video opacity and
canonical config all `0.3`; it does not explain the earlier failure. The
follow-up driver uses ordinary range arrow keys and waits for each controlled
update. It also closes Advanced before the independent replacement test, so
a failed range test cannot leave its input consuming undo. With that and
rendered-frame geometry stabilization, all eight comparison/replacement/
library/CAS/pixel/save-reopen checks passed against the retained candidate
(17.03 s). Mac still requires the next hosted result. Existing tolerances,
real connector calls and undo assertions remain intact.

Mac close coverage now proves zero real BrowserWindows before normally
quitting the owned test app, within the original forty-second total budget:
the product intentionally stays in the Dock after closing its last window.
The local-font fixture selects Arial on Mac and Microsoft YaHei on Windows;
missing-dependency assertions are unchanged. These changes await hosted Mac
validation, not a task on the user's Mac.

## Windows checkpoint sharing reproduction and repair

A controlled independent-reader reproduction in an owned Temp directory
performed 10,000 plain JSON-read/atomic-rename operations on Node 22.22.0:
2,120 renames returned EPERM. This establishes ordinary concurrent reads as
a sufficient trigger for the same Windows syscall failure; the original
profile's exact reader is still unknown. Evidence: `batch-rename-repro.json`.

Batch checkpoint replacement now retries only Windows EPERM/EACCES/EBUSY,
five attempts with at most 100 ms of wait per replacement. It preserves the
old checkpoint, reports persistent failure, and cleans its own temporary file.
It never reruns the analysis or changes the 120-second M3 acceptance timeout.
Fault-injection verifies eventual commit, bounded permanent sharing failure,
nonretryable EIO, unchanged last-good bytes, explicit job error and no stranded
temporary files. A real Windows reader-thread integration also passes 200
checkpoint replacements with the completed result intact. All nine batch
tests pass (1.62 s); the preceding combined rollback/live/batch run passed
86 tests before adding the real-reader case. Facade typecheck passes.
Evidence: `checkpoint-sharing-regression.log`, `checkpoint-real-reader.log`.

This runtime change requires a new clean candidate. The failed 5aece717
candidate and its original evidence remain retained and unqualified.

## 79c5f780 terminal results and opacity diagnosis

All ordinary runs reached terminal state without manual reruns:
[CI passed](https://github.com/yuchen-ya/reelterminal/actions/runs/38725157229),
[Chromium passed on all three jobs](https://github.com/yuchen-ya/reelterminal/actions/runs/38725157305),
[performance contracts passed](https://github.com/yuchen-ya/reelterminal/actions/runs/38725157241),
and [Electron failed](https://github.com/yuchen-ya/reelterminal/actions/runs/38725157244).
Windows: 119 passed / 4 failed / 13 skipped. Mac: 122 passed / 1 failed /
13 skipped. Mac close/relaunch, local-font node retention, archive safety,
M3 and first frame now pass. Windows copy checks pass on the hosted runner;
the local native clipboard failure remains unresolved.

Windows canvas-point failure repeats exactly `(0.293876,0.666683)`, so the
additional stable-layout wait did not fix it. A separate controlled Chromium
input diagnostic proves `pointerdown` preserves fractional protocol positions
but `click` truncates them: requested `(114.434375,118.865625)` becomes click
`(114,118)`. A single click aimed at the nearest integer pixel becomes
`(114,119)` and avoids that systematic bias. The driver now rounds once before
the one real click; the 0.03 tolerance, actual connector context and pixel/CAS
checks are unchanged. Geometry is included if it fails again. Evidence:
`mouse-coordinate-primitive.json`. This explains an input-driver mechanism;
updated small-window hosted validation is still required.

Windows comparison failure was newly added diagnostic I/O: its artifact
directory did not yet exist on the clean runner (ENOENT). Directory creation
is fixed. Mac comparison failure is different: twenty ArrowLeft inputs leave
opacity 0.4 instead of 0.05. A controlled component test proves a product
defect: while the project command is deliberately pending, input 0.4 is reset
immediately to canonical 0.35. The range was controlled by asynchronously
committed project state, so rapid gestures repeatedly started at the old value.

The normal comparison opacity input now holds its latest local gesture until
all pending canonical commands finish. It still uses the existing project
command/history path, returns to canonical state after failure, displays the
error, and follows external canonical changes when idle. Three regression
cases cover a pending gesture, overlapping commands and rejection; all 17
comparison-component tests and web typecheck pass. Original implementation
fails the controlled pending-command test. Evidence:
`comparison-pending-opacity-before.log`, `comparison-pending-opacity-after.log`.
The E2E retains fast consecutive keys to exercise this defect rather than
serializing each gesture behind command completion. This runtime repair needs
another candidate; 79c5f780 remains retained as an earlier candidate.

An independent local diagnostic also stopped before renderer setup because
Windows returned content width 1023 after a 1024 request. It is preserved in
`canvas-gesture-coordinate-diagnostic.log` and is not counted as a product
startup timeout or a functional pass. No size acceptance guard was relaxed.
Normal-window follow-up exercises all eight real comparison/connector/pixel/
undo/save-reopen tests successfully (16.57 s); small-window confirmation is
reserved for hosted evidence.

Mac picker report `ef1fa632` was read from Git. It confirms system picker
present and a 10.030 s source-start timeout, with no product fallback. Recording
remains unaccepted; manual selection is not assumed to solve it. This Windows
continuation needs no Mac file edits. If the parent later authorizes more Mac
investigation, the minimum useful evidence is the retained original startup
primary error/command timing and PID-correlated native memory-region samples
from the existing export/idle round. Do not repeat the ten-export run merely
to obtain another RSS number. No recorder code, permissions or user Mac task
was changed here.

## Fractional-width transport wrapping

The clean 3e9f853c package passed 25 of 26 selected core checks (81.69 s),
including the fast opacity input, M3 (15.89 s), first frame, real connector
CAS/pixels, undo and save/reopen. It remains unqualified: its comparison
layout test measured only 17 px picture height at actual 1279x720 after a
1280x720 request. The screenshot shows the transport's final control wrapped
onto another row. A 240 px stage reservation was insufficient for that row.
This is a supported layout defect, not a reason to change the >40 assertion.

The rendered split now reserves 288 px for the stage, retaining the existing
timeline preference and its minimum. The existing test additionally requests
1279x700 to cover native fractional-width rounding. Normal source build and
the full original playback/comparison test pass in 6.95 s: picture height is
58 px at actual 1279x720, 1279x701 and 1278x701, with settings outside the
pictures, controls above them and timeline inside the viewport. Evidence:
`windows-rc-3e9f853c-core.log`, `wrapped-transport-layout-after.log`,
`comparison-layout-1792063844525.json` (before), and
`comparison-layout-1792063975675.json` (after), under the harness artifacts.
A fresh candidate is required for this final runtime layout repair.

Remote Mac documentation commit 633b7f63 was read and fast-forwarded without
changing local implementation files. It now verifies actual native system
cancel and one current-application-window recording/import/full decode, while
the designated synthetic-window selection still times out. Overall recording
acceptance remains blocked. Its docs-only push automatically cancelled the
3e9f853c Electron run; that run is not reported as a pass. No manual rerun,
reset, force push or shared-file conflict occurred.

## 81c1ea4e terminal evidence and remaining first failures

The clean Windows candidate passed all 26 selected core checks / eleven files
in 83.50 s; M3 completed in 15.77 s. Its identity, hashes and scope are in
`windows-rc-1.1.2-81c1ea4e-2026-10-15.json`. All frozen-source workflows
reached terminal state:
[CI passed](https://github.com/yuchen-ya/reelterminal/actions/runs/38728511446),
[Chromium passed](https://github.com/yuchen-ya/reelterminal/actions/runs/38728511588),
[performance contracts passed](https://github.com/yuchen-ya/reelterminal/actions/runs/38728511369),
and [Electron failed](https://github.com/yuchen-ya/reelterminal/actions/runs/38728511463).
Both Electron platforms had 122 passed / 1 failed / 13 skipped.

Windows first failure: `inspector-archives-board.e2e.ts:38`, after the real
create-save-point click, `node.list` stayed empty during the existing one-second
assertion. The original run did not upload the profile's external evidence
directory, so there is no busy/error/post-completion state to attribute it.
A single instrumented local probe on that exact package passed the full test
in 8.64 s, with the first node present after 257 ms. That is not a diagnosis or
a repair of the hosted incident. The original assertion remains one second.
The test now uploads its evidence and captures busy state, notifications,
nodes and target context on failure, preserving the primary error. No test
timeout, assertion or save/undo contract was changed. User impact if the
incident recurs: save-point creation might be delayed or fail; data loss is
not established. Evidence: `81c1ea4e-electron-windows.log`,
`inspector-first-save-diagnostic.log`.

Mac first failure: M3 review-task form submit, before any task or batch recovery,
timed out at its original thirty-second click. The HTML element intercepted
pointer events. A 1024x700 request on Windows reproduced a concrete usability
defect: after the popover animation settled, the submit button spanned y699–731
inside a 701 px viewport; body and popover overflow were hidden. A real wheel
gesture could not reveal its center. A strengthened real-pointer regression
fails on the old package without invoking a forced click or scripted scroll.

The review popover now uses Radix's actual available-height bound and vertical
overflow scrolling. It changes no capture request, project CAS or task state.
With a real wheel gesture and positive pointer-hit assertion, full minimum-height
M3 passes in 16.25 s, retaining strict frame rejection, adoption/undo and the
120-second durable recovery assertion. Evidence:
`m3-review-natural-scroll-before.log`, `m3-review-natural-scroll-after.log`,
and `m3-review-geometry-*.json` in the harness artifact root. This fixes the
reproduced offscreen-form condition; updated hosted Mac evidence is required
to qualify that runner's path. A new candidate is needed for this runtime fix.

## Updated Mac native feature acceptance

Mac documentation 5f447ab7 was read and fast-forwarded safely. **The existing
a8c6925c arm64 package passed the manual native recording specialty test**:
real system cancel events with no media/revision change and no active tracks,
then designated green-window selection, recording, stop, import and complete
FFmpeg decode (about 43.889 s). Four nonfatal DTS warnings remain recorded.
Only the Mac-local helper window placement changed; public recorder code did
not. `feature_accepted=true`, `release_ready=false`.

Remove native recording feature acceptance itself from the remaining blockers.
The old ten-second timeout is still unattributed, and a Mac package containing
all latest source is not yet qualified. Existing native/export shared-memory
retention and history heap trend remain without an established cause or
long-term bound. No original Mac raw logs were read on Windows, no export/idle
round was repeated, and this agent did not start a personal Mac task.

## b62ef59e final runtime results and test-only save synchronization

The fresh candidate is clean, unsigned and unpublished. Five packaged runtime
components and 190 renderer files match the build. All 27 selected packaged
core checks / twelve files pass in 92.95 s, including minimum-height M3
(16.02 s) and inspector/archive/board (8.87 s, first node 199 ms). The natural
review-popover wheel gesture changes a nonreceiving pointer target into a
receiving target before the real click. Source geometry records DPR 2; native
content width rounding is observed, without attributing it to a particular
fractional display setting. Subsequent wording corrections and the save-test
synchronization do not change product runtime, so this candidate is retained.

Frozen-source terminal results:

| Run | Result and first condition |
| --- | --- |
| [CI 38731711849](https://github.com/yuchen-ya/reelterminal/actions/runs/38731711849) | Passed, including typecheck, lint, unit tests and build. |
| [Performance 38731711839](https://github.com/yuchen-ya/reelterminal/actions/runs/38731711839) | Passed contracts; no claim that historical long stresses qualify the new source. |
| [Electron 38731711875](https://github.com/yuchen-ya/reelterminal/actions/runs/38731711875) | Windows 123 passed / 13 skipped. Mac 122 passed / 1 failed / 13 skipped. M3, archive close/reopen, point/pixel/CAS, fast opacity input, minimum layout and first frame pass on both. |
| [Chromium 38731712015](https://github.com/yuchen-ya/reelterminal/actions/runs/38731712015) | Runtime/transport and Ubuntu facade passed. Mac facade: 2073 passed / 1 failed / 15 skipped; `audio-normalize.test.ts:93` exceeds the unchanged 5000 ms test deadline. |

The Mac inspector failure is now captured in the uploaded artifact. At
1071 ms: save button disabled/busy, no error notifications, no nodes yet,
project/workspace and revision unchanged. That sample establishes an in-flight
save, not its eventual outcome. Windows on the same source passes that test
with the first node after 561 ms. The earlier Windows incident remains without
its original busy-state sample; no data loss is established by either count.

The save test now requires its real success/error receipt before checking
durable nodes. Click plus receipt share the original 30-second action budget;
the original one-second node-count assertion remains unchanged afterward.
An error receipt fails immediately. A real local run passes in 9.16 s:
success receipt 226 ms, durable node 232 ms. Harness typecheck passes.
This is test synchronization only, not a change to save implementation or
a raised timeout. Its updated hosted result must be read before claiming the
Mac test correction qualified. Evidence: `inspector-save-receipt-sync.log`,
`hosted-b62ef59e-macos/inspector-layout-*/layout.json`, and the failure PNG.

The Mac audio test's five-second deadline covers normalization and subsequent
verification/decoding; the log does not identify the slow phase. Fixture
preparation is in beforeAll. Earlier passing rounds do not attribute this
repeat failure. No limit was raised, assertion removed or direct rerun started.
Minimum further evidence is stage timestamps around normalization return,
FFmpeg probe/measurement/render/verification children and final decode, with
owned-child exit/stderr. This can be a narrowly scoped standard hosted-runner
probe; it does not require rerunning the personal Mac ten-export round.

User-impact limits: this host's native clipboard roundtrip remains unresolved
at the OS/packaged-runtime boundary, so local copy-prompt acceptance is not
counted as passed. Do not change system settings or clear the user's clipboard.
If further localization is requested, obtain explicit permission for one
controlled old-versus-new package clipboard roundtrip in the same interactive
session. The native memory regions and post-saturation history trend still
have no attributed cause or proven long-term bound. Existing Mac recording
specialty acceptance remains passed; old timeouts and latest full-source Mac
package qualification remain separate open items. Release readiness is not
asserted by these results.

## Completed 9db42277 follow-up and candidate coverage

All ordinary push runs for the final test-only source reached success:
[CI 38734599840](https://github.com/yuchen-ya/reelterminal/actions/runs/38734599840),
[Electron 38734599871](https://github.com/yuchen-ya/reelterminal/actions/runs/38734599871),
[Chromium 38734599825](https://github.com/yuchen-ya/reelterminal/actions/runs/38734599825),
[performance contracts 38734599873](https://github.com/yuchen-ya/reelterminal/actions/runs/38734599873).
Windows and Mac Electron each pass 123 tests with 13 explicit opt-in skips.
The saved inspector artifacts show Windows receipt/node completion at
869/884 ms and Mac at 904/947 ms. The original node assertion, success/error
receipt, actual target, CAS, preview, board, undo and save/reopen checks remain.
The previous Mac five-second normalization test also passes at its unchanged
limit; that later pass does not establish the cause of historical timeouts.

`git diff b62ef59e..9db42277 -- apps packages scripts` contains the save-test
synchronization and comments only; production logic is unchanged. A normal
desktop build of clean 9db42277 was performed without packaging. Comparing it
with the retained b62 candidate yields zero mismatches across 213 files:
13 packaged dist files, 190 renderer files, two offline guides, three bin
resources, two aurora resources, one rigging resource and two root launchers.
Package/lock inputs are unchanged; all five retained package artifact hashes
are unchanged. Full proof and per-file SHA-256 pairs are committed:
[equivalence summary](windows-runtime-payload-equivalence-9db42277-2026-10-15.json),
[file manifest](windows-runtime-payload-equivalence-9db42277-files-2026-10-15.json).

`dist/performance-build.json` is deliberately different: it names the actual
source/build identity. Non-runtime placeholders and unshipped sourcemaps are
excluded. No hypothetical 9db installer was built, and no full-installer hash
equivalence is claimed. The existing package remains labeled b62; it contains
the same compared functional payload as 9db. Hash equality does not turn
27 packaged checks into 123 packaged checks, validate the installer wizard,
qualify a latest-source Mac package, or prove a long-term memory bound.

**Scope judgment:** evidence supports closing the tested Windows configured-core
candidate scope: edit/preview, real connector/CAS, strict review adoption/undo,
save points/board/recovery, reopen, first frame and export. Existing unsigned
portable/unpacked artifacts are reviewable. Full source Electron coverage is
separately recorded for both platforms. Historical unattributed incidents are
tracked risks and follow-up opportunities, not automatic hard gates against
every limited Windows release. Do not claim all-environment clipboard behavior,
latest packaged-Mac acceptance or indefinite no-growth memory behavior from
this evidence.

**Remaining user decisions:** choose whether a later release should accept
that limited Windows scope and its stated risks, or require wider claims first.
For wider installer, latest Mac package, local copy-prompt or long-term-memory
guarantees, authorize only the corresponding targeted acceptance; old incidents
need phase evidence rather than a blanket full rerun. This task makes no
publication decision: no installer was installed, no certificate or account
permission was changed, and no tag, Release or installer upload was performed.
