# Windows local release candidate, 2026-10-15

**A local Windows candidate is prepared; release approval is withheld.** The
frozen product source is `ca8126cfe297aadb47c2dcc9d6e9163e73add609`, version
1.1.2, win32 x64. Subsequent report-only commits do not change that package.
No tag, Release, installer upload, signing or installation was performed.

## Candidate identity

Local directory:
`apps/desktop/release/windows-rc-1.1.2-ca8126cf/`.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| ReelTerminal-1.1.2-x64.exe | 138859577 | `0f10b16f1e665405ce9ac43e69e9fa4ff723f0236c422e5b40e3ad0d1a4ab702` |
| ReelTerminal-1.1.2-x64.zip | 188917860 | `cae6c8cf6df988f65c702a2658b14bcd7c699408820fcf6879cc080fe25d62c5` |
| win-unpacked/ReelTerminal.exe | 245726208 | `a7f70dfca4a0c4d142fe49e4cc93c3dbc92d6eca243aa1733b0e7b223ccabd3d` |

Both application and installer report `NotSigned`. The installer wizard was
not exercised. The isolated unpacked application was exercised directly.

Build used the existing desktop `dist` script with
`--win nsis zip --x64 --publish never
--config.directories.output=release/windows-rc-1.1.2-ca8126cf` and
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
| Packaged Windows core workflow | 14 tests / 5 files passed in 34.50 s: onboarding, reelctl, flow A, project entry, decoder worker. Actual packaged app identifies 1.1.2 / packaged=true. Open, edit, CAS, undo, save, full reopen, MP4 export/full FFmpeg decode and eight-second first-frame checks retained. | Passed for this scope |
| Review/replacement target routing | Explicit project/workspace passed through GUI, IPC and main service; 2 main tests and 4 GUI tests pass. Real M3 frame 15 / 0.5 s evidence, strict short-candidate rejection, valid adoption and GUI undo observed. | Targeted fix verified |
| Batch process recovery | M3 explicit-retry run failed its unchanged 120 s all-done assertion, 132.91 s total. A previously done item is INTERRUPTED after restart; final batch is error/done while ledger retains interrupted/queued states. Root cause remains unresolved. | Blocked |
| Mac native recording | Committed Mac report records native picker timeout; actual choice/cancel/record/import/decode remains unverified. Windows cannot qualify this path. | Blocked |
| Old Mac startup timeouts | Three retained failures reach the exact Open-button click wait; first primary error is lost. Added bounded DOM/lifecycle diagnostics, without a product startup fix or raised timeout. | Unattributed |
| Native/export/history memory | Existing Mac ten-export/300.442 s idle round was not repeated. Shared memory retention and history heap trend have no established cause or long-term bound. | Stability qualification incomplete |
| Installer / full suite | Unsigned installer produced but not installed. Full frozen-SHA CI/Electron/Chromium runs were still in progress at the report snapshot. | Not qualified by this smoke |

The parent release owner must choose any restricted Windows release scope;
this report does not approve a general stability release. No RSS/top MEM/
working-set sums or RSS decrease are used to claim memory release.

## Tests, commits and retained evidence

Product fixes are `255503c4` (semantic selection/CAS), `f0dd64d1` (library
dialog portal), and frozen `ca8126cf` (review workspace routing). Test/diagnostic
changes are `abb75cb2`, `2960eb36`, `cf7bf9cb`. Details and earlier failures:
[Windows stability follow-up](windows-stability-followup-2026-10-15.md).

Frozen-SHA hosted snapshot: [Performance regression passed](https://github.com/yuchen-ya/reelterminal/actions/runs/38714368764);
[CI](https://github.com/yuchen-ya/reelterminal/actions/runs/38714368748),
[Chromium E2E](https://github.com/yuchen-ya/reelterminal/actions/runs/38714368814)
and [Electron E2E](https://github.com/yuchen-ya/reelterminal/actions/runs/38714368785)
were in progress when observed. This is not an all-green CI assertion.
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
