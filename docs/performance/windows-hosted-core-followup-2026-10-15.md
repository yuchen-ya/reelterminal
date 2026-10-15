# Hosted core validation follow-up, 2026-10-15

Scope: supported editing, preview, save-point/data recovery and export flows.
This continues the [Windows candidate report](windows-rc-1.1.2-2026-10-15.md).
No installer was installed; no tag, release, signing or installer upload occurred.
Only the existing checkout and isolated test profiles were used, serially.

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
