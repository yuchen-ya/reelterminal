# Windows local release candidate, 2026-10-15

## Latest candidate: 81c1ea4e

The final retained candidate is **81c1ea4eea460e1e49078e1eaa5a2b7e28f7ea1b**,
version 1.1.2, Windows x64, under
`apps/desktop/release/windows-rc-1.1.2-81c1ea4e/`. It is unsigned,
uninstalled and unpublished. Its embedded source stamp is clean; all five
runtime components and 190 renderer files match the built source.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Installer | 138861226 | `0d6ee07f4caaf1e036121722d76de29aab7c278e5e569000c820999e99350968` |
| ZIP | 188922592 | `b8d13a0f76651f4e75296eb2ca558d80098da1d5e134c5e2bbf107a7e43adae7` |

Packaged validation: **26/26 core tests pass across eleven files in 83.50 s**.
M3 passes in 15.77 s with the original 120-second condition and durable-state
agreement. Fast opacity input, actual connector/CAS/pixel checks, GUI undo,
save/reopen, native playback, offline first frame and MP4 export remain active.
The startup window is the normal isolated window; the comparison test itself
requests 1280x720, 1280x700 and 1279x700 and keeps the original >40 px limit.
This does not reclassify the earlier 1024-request/1023-native-width setup
failure as passed. No small-window setup guard was relaxed.

The earlier 79c5f780 full local core round retains its two empty native
clipboard failures. They were not repeated in this affected/core selection,
and are not counted as passes. The native synthetic roundtrip failed as well;
its OS/runtime cause remains unresolved. No system clipboard policy or user
application was changed. Full hosted copy/archives verification is recorded
separately against the frozen source SHA.

Full final identity and evidence:
[candidate JSON](windows-rc-1.1.2-81c1ea4e-2026-10-15.json) and
[stability continuation](windows-hosted-core-followup-2026-10-15.md).
Release qualification remains withheld for native-memory, historical-startup
and latest-source Mac-package evidence gaps. Mac 5f447ab7 verifies the existing
a8c6925c package's real system cancel and designated synthetic-window
record/stop/import/full-decode chain. That feature-specific manual acceptance
is passed. It does not attribute or fix the old ten-second timeout, and does
not qualify a Mac package built from all latest source changes.

## Historical 79c5f780 candidate

The latest retained candidate is **79c5f7802ddbde0c1ded5a9b5b27b30a85703273**,
version 1.1.2, Windows x64, under
`apps/desktop/release/windows-rc-1.1.2-79c5f780/`. It is unsigned,
uninstalled and unpublished. Its embedded stamp is clean; five runtime
components and 190 renderer files match the built source. It supersedes the
e04622a3 candidate described in the historical sections below.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Installer | 138861223 | `c7cda350fee810d868f23bb8e9356ada1a42d6fb5365cba986fb9c1a4d92991f` |
| ZIP | 188922560 | `472e71273b5862894398d60deb1c73402b48134f1e09f46dd9e4a1ef741e76e9` |

Packaged core checks: **38 passed / 2 failed across 40 tests**, in two
serial invocations (11/11 in 26.88 s; 27/29 in 134.54 s). The two failures
are copied-prompt assertions reading an empty native clipboard; a separate
synthetic native Electron roundtrip also fails on this host. Its OS/runtime
cause remains unknown. No assertion or clipboard policy was bypassed.
M3 passed in 15.36 s, including exact frame evidence, strict rejection,
adoption/undo, durable checkpoint agreement and process recovery, with the
original 120-second condition. Comparison at minimum window size, decode
first frame, edit/CAS/undo, read-only archive, protected draft, recycling,
save/reopen, immutable media and fixed-input MP4 export checks passed.

Additional runtime fixes since e04622a3: minimum-window grid space
(`5aece717`), failed analysis-record completion rollback (`cbdc9b09`),
bounded Windows checkpoint sharing conflicts (`79c5f780`). Test-only native
lifecycle and input contracts are `0e706cd0`. Full diagnosis, original
failures, controlled reproductions and hosted terminal results are in
[the continuation report](windows-hosted-core-followup-2026-10-15.md).

Release qualification remains withheld. The old Mac startup incidents,
native-picker acceptance, shared-memory retention and history heap trend
retain their earlier evidence limitations. No original Mac logs were read
from this Windows host and no new task was started on the user's Mac.

## Historical e04622a3 candidate

**A local Windows candidate is prepared; release approval is withheld.** The
frozen product source is `e04622a372797a50fc056f4614baeb04ee73b009`, version
1.1.2, win32 x64. Subsequent report-only commits do not change that package.
No tag, Release, installer upload, signing or installation was performed.

## Candidate identity

Local directory:
`apps/desktop/release/windows-rc-1.1.2-e04622a3/`.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| ReelTerminal-1.1.2-x64.exe | 138859736 | `d1b85fb482c88db0fdf0d8cca93fadf08d47a0375338bb35feaf4f5b1bca25b7` |
| ReelTerminal-1.1.2-x64.zip | 188919397 | `7d82ec8860b090020316f5b093f2ee07f16e5ea6218c2c5bc6cb4864c254b791` |
| win-unpacked/ReelTerminal.exe | 245726208 | `8994ef6130b4fae3e9e020a0a4e362a0f337f001ddfb6c662969fd4a1c075aa2` |

Both application and installer report `NotSigned`. The installer wizard was
not exercised. The isolated unpacked application was exercised directly.

Build used the existing desktop `dist` script with
`--win nsis zip --x64 --publish never
--config.directories.output=release/windows-rc-1.1.2-e04622a3` and
`CSC_IDENTITY_AUTO_DISCOVERY=false`. The source stamp embedded in app.asar
reports the frozen SHA and `dirty: false`. Main, preload, browser worker,
live connector and CLI bundles match the built source hashes; all 190 runtime
renderer files match. The only excluded placeholder is `workers/.gitkeep`.
The stamp's executable hash describes the pre-package Electron runtime;
the table above identifies the actual packaged executable.

Full component, archive and blockmap hashes are in the accompanying
[JSON](windows-rc-1.1.2-2026-10-15.json) and local `PACKAGE-IDENTITY.json`.
Existing release-root binaries were preserved.

## Verified scope and remaining gates

| Area | Evidence and result | Gate |
| --- | --- | --- |
| Packaged Windows core workflow | 15 tests / 6 files passed in 50.65 s: M3 recovery, onboarding, reelctl, flow A, project entry, decoder worker. Actual packaged app identifies 1.1.2 / packaged=true. Open, edit, CAS, undo, save, full reopen, MP4 export/full FFmpeg decode and eight-second first-frame checks retained. | Passed for this scope |
| Review/replacement target routing | Explicit project/workspace passed through GUI, IPC and main service; 2 main tests and 4 GUI tests pass. Real M3 frame 15 / 0.5 s evidence, strict short-candidate rejection, valid adoption and GUI undo observed. | Targeted fix verified |
| Batch process recovery | Original failure attributed to batch observer replacing durable task observer. Fixed in `e04622a3`; actual packaged M3 passed in 17.49 s with unchanged 120 s assertion and added durable-state agreement. Hosted M3 stops earlier at a notification-covered button. | Local reproduction passed; hosted coverage blocked |
| Mac native recording | Committed Mac report records native picker timeout; actual choice/cancel/record/import/decode remains unverified. Windows cannot qualify this path. | Blocked |
| Old Mac startup timeouts | Three retained failures reach the exact Open-button click wait; first primary error is lost. Added bounded DOM/lifecycle diagnostics, without a product startup fix or raised timeout. | Unattributed |
| Native/export/history memory | Existing Mac ten-export/300.442 s idle round was not repeated. Shared memory retention and history heap trend have no established cause or long-term bound. | Stability qualification incomplete |
| Installer / full suite | Unsigned installer produced but not installed. Frozen-SHA performance passed; CI, Chromium and Electron workflows failed. Terminal details below. | Release qualification blocked |

The parent release owner must choose any restricted Windows release scope;
this report does not approve a general stability release. No RSS/top MEM/
working-set sums or RSS decrease are used to claim memory release.

## Tests, commits and retained evidence

Product fixes are `255503c4` (semantic selection/CAS), `f0dd64d1` (library
dialog portal), `ca8126cf` (review workspace routing), and frozen `e04622a3`
(task/batch durable checkpoint coexistence). Test/diagnostic
changes are `abb75cb2`, `2960eb36`, `cf7bf9cb`. Details and earlier failures:
[Windows stability follow-up](windows-stability-followup-2026-10-15.md).

Prior candidate `ca8126cf` hosted snapshot (superseded): [Performance regression passed](https://github.com/yuchen-ya/reelterminal/actions/runs/38714368764);
[CI](https://github.com/yuchen-ya/reelterminal/actions/runs/38714368748),
[Chromium E2E](https://github.com/yuchen-ya/reelterminal/actions/runs/38714368814)
and [Electron E2E](https://github.com/yuchen-ya/reelterminal/actions/runs/38714368785)
subsequently ended cancelled after the report-only push. They did not qualify
that source. New frozen-SHA terminal results are recorded below.
The earlier hosted stress result at `c971815f` is not qualification of this SHA.

Ignored local evidence directory:
`apps/desktop/e2e/.artifacts/windows-stability-2026-10-15/`.
It contains `windows-rc-package.log`, `windows-rc-smoke.log`,
`production-recovery-explicit-retry.log`, and
`m3-recovery-failure-summary.json`; hashes are in the JSON companion.
Package metadata additionally resides in the candidate directory. These local
artifacts are retained on this host and are not hosted downloads.

Mac conclusions come only from committed reports/JSON, including
[startup handoff](macos-startup-picker-handoff-2026-10-15.md) and
[native picker gate](macos-native-picker-release-gate-2026-10-15.md).
Raw Mac evidence was not read here. Minimum next evidence, if later authorized:
the existing failure's bounded DOM/lifecycle and primary-error log for startup;
an owned-PID native picker/source result plus track/record/import/decode outcome
for recording; native allocation/shared-region ownership around an export and
idle boundary for memory. No new Mac task or full rerun is requested here.

## Recovery fix and replacement candidate

The original 132.91-second failure and its evidence remain retained. The
120-second assertion waited on the batch manifest, not an obsolete UI label.
The one-observer registry let the batch overwrite the live task-ledger
subscription, leaving durable records queued despite completed batch entries.
Owner-scoped observers now coexist; repeated batch subscriptions replace the
previous batch callback. A checkpoint failure reports error and corrects every
writable checkpoint before publication.

The new regression failed before the fix. Registry/batch 18 tests, real-disk
ledger 8 tests, live-session 77 tests, and both relevant typechecks passed.
The real M3 passed in 18.08 seconds, then in 18.22 seconds with added assertions
for durable done/cancelled states before exit, preserved done/interrupted states
after restart, and final done agreement. The completion limit remains 120 s.
The old candidate directory remains intact; this report now identifies its
independent replacement at `e04622a3`. The original M3 blocker is superseded
by this proven product diagnosis and fix.

Replacement packaged smoke: **15/15 tests, 6/6 files passed in 50.65 s**.
This includes real M3 process recovery in **17.49 s**, with the 120 s all-done
assertion unchanged and durable-store agreement asserted before/after restart.
Evidence: `windows-rc-e04622a3-package.log`, `windows-rc-e04622a3-smoke.log`.
Both packaged application and installer remain unsigned; no installer was run.

## Frozen-source CI and release judgment

Frozen source is `e04622a372797a50fc056f4614baeb04ee73b009`. No workflow was
rerun to obtain a different outcome. The report-only push is held until the
observed runs finish, so it does not cancel this validation round.

- [Performance regression](https://github.com/yuchen-ya/reelterminal/actions/runs/38716429450): passed.
- [Chromium E2E](https://github.com/yuchen-ya/reelterminal/actions/runs/38716429124): the
  macOS facade job failed `audio-normalize.test.ts:93`, the right-channel-only
  44.1 kHz range to exact durable 48 kHz WAV test, at the existing 5000 ms
  limit. It reported 2070 passed / 1 failed / 13 skipped. Ubuntu facade passed.
  This is an unattributed timing failure; no timeout increase or rerun was used.
  The real Chromium runtime/transport job also passed; the workflow is failed
  because of the macOS facade job.
- [CI](https://github.com/yuchen-ya/reelterminal/actions/runs/38716429407) and
  [Electron E2E](https://github.com/yuchen-ya/reelterminal/actions/runs/38716429519):
  both failed. All four workflows reached terminal states before this report
  was committed; none was cancelled by the final documentation push.

| Failed area | Observed evidence | Attribution / impact |
| --- | --- | --- |
| CI web unit test | `AssetsPanel.work-asset.test.tsx:110`, named timeline-selection save, exceeded original 20000 ms; web suite 1847 passed / 1 failed / 7 skipped. Typecheck, lint, naming and security steps passed. | Unattributed timeout; CI build job skipped after test failure. |
| Electron M3, both platforms | `production-management.e2e.ts:273` times out after 30 s clicking Back to list. Playwright identifies the persistent Copy startup prompt notification intercepting pointer events. Selected-frame check passed; strict adoption and the recovery section had not been reached. | Distinct visible precondition failure. Hosted recovery is unqualified; this is not a recurrence of the 120 s recovery defect. |
| Missing test inputs | `desktop-portals-theme`, `paused-inspector-history`, `paused-project-switch`, `preview-copy` explicitly require external job/source configuration absent in the workflow. | Coverage unavailable, not an established product failure. |
| Outdated explicit-target/version assertions | `repair-integration` reports `media.import requires projectId`; `media-import` calls `project_get_state` without a target; `node-ux-fixes` expects connector 1.6.0, receives 1.7.3. | Observable test contract mismatches; these cases do not verify their intended product paths. |
| Archive/version suite | Both platforms show empty-node count/menu failures followed by missing-node errors. Mac additionally has close/relaunch errors; Windows has close-menu/relaunch errors and long-path vs 8.3-path string mismatch. | Mixed failures require separate diagnosis; do not classify the entire suite as test-only or infer data loss from cascaded errors. |
| Mac geometry | Comparison picture height 37 vs required >40; canvas point requested (0.6,0.35), observed approximately (0.6130,0.3999). | Unattributed layout/input failures; thresholds unchanged. |

Electron totals: Windows **17 failed / 104 passed / 15 skipped** (9 failed,
31 passed, 9 skipped files); Mac **21 failed / 100 passed / 15 skipped**
(11 failed, 29 passed, 9 skipped files). Decoder-worker's two tests passed on
both hosted platforms with the existing first-frame condition. These results
are hosted-runner logs, not the unavailable original Mac production evidence.
The complete failure inventory is included in the JSON companion.

Retained CI evidence: `e04622a3-ci-terminal.json`, `e04622a3-ci-failed.log`,
`e04622a3-chromium-failed.log`, `e04622a3-electron-failed.log`, and
`e04622a3-electron-failure-inventory.json` in the existing local evidence root.

The reproduced M3 recovery risk is resolved within the verified scope.
General stability release approval remains withheld: whole-suite failures,
unsigned/uninstalled installer coverage, Mac recording and the existing
unattributed startup/memory limits are not cleared by the packaged smoke.

## Narrow CI compatibility follow-up

After preserving the terminal failures above, only tests and this report were
changed. The candidate's runtime source remains frozen at `e04622a3`; no
additional product change or package replacement was needed for this follow-up.

- M3 now clicks the persistent startup hint's real **Dismiss notification**
  button after granting editing access and waits for that hint to detach.
  This follows the shipped UI; there is no forced click, DOM removal or store
  mutation. The full M3 then passed against the existing candidate in **16.35 s**,
  including the unchanged 120 s recovery assertion and durable-state checks.
- The web work-asset test passed locally but took about 17 seconds. Bounded
  phase records put save click at 177 ms and the store-wait completion at
  17007 ms. A temporary CPU profile of that interval (17.648 s) was dominated
  by JSDOM/nwsapi `Element.matches` / `isFullscreen` recursion. The installed
  nwsapi fallback calls `node.matches(':fullscreen')`, which re-enters its
  own JSDOM matcher. This is a reproduced local test-environment problem.
  The fixture now models the absent fullscreen/modal states as false while
  delegating every other selector to the original matcher and restoring it
  after each test. Capture, state persistence, UI assertions and the 20 s
  test limit remain real and unchanged. Both tests passed in **223 ms**
  (3.98 s including imports/setup). This supports the CI timeout diagnosis;
  the original hosted failure has not been replaced by a successful hosted run.

Temporary phase/profiler code was removed. Evidence:
`m3-startup-dismiss-target.log`, `assets-work-capture-target.log`,
`assets-work-capture-phases-detail.json`, `assets-work-capture.cpuprofile`,
`assets-work-capture-profile-summary.json`, `assets-work-capture-jsdom-fix.log`.
Other full-suite failures remain as recorded; no broad suite or failed workflow
was manually rerun. Normal publication of this test/report commit may trigger
the repository's ordinary CI, whose result is not claimed here.
