# Windows 1.2.0 release validation — 2026-10-15

Status: **publication paused for a new hosted Flow A failure**. No v1.2.0 tag or
GitHub Release has been created. This is an evidence block, not a lack of
publication authorization. The user explicitly authorized a formal 1.2.0 release.

Frozen candidate source: `ee1062ecde20afd0cc0b5a91ab5ddb0996fee22a`.
The checkout was clean; all 15 workspace/root package versions follow the
repository's existing unified version convention. GUI manual app version is
1.2.0, independent content version remains 1.7.3. Frozen-lockfile validation
passed without dependency or lockfile changes. Relative to 9db42277, the new
commit changes version metadata and documentation only; historical reports retain
their real SHA/version. The baseline's green results do not erase this new failure.

## New Windows candidate

Directory: `apps/desktop/release/windows-1.2.0-ee1062ec/`.
Normal `dist --win nsis zip --x64 --publish never` created an independent 1.2.0
package. It was not renamed from 1.1.2. No signing, installer execution, user
installation replacement or publication took place.

- Packaged manifest, executable/installer version metadata and clean build stamp
  match 1.2.0 and the full frozen source SHA.
- Five main components and 190 renderer files match the normal build. Both
  offline manuals advertise 1.2.0. Update manifest version, installer size and
  SHA-512 match the output.
- ZIP CRC checks passed; all 302 files match the tested unpacked directory.
- Installer and application Authenticode status: `NotSigned`.
- GUI manual contract tests: 28/28 passed.
- Packaged core: **27/27 passed across 12 files in 92.68 seconds**, retry 0.
  Real connector, CAS, undo, save/reopen, M3 process recovery, export/full decode,
  first-frame and visible GUI checks remain. The local exact small startup
  window guard was not claimed as tested; existing M3/comparison viewport cases
  retain their actual interaction checks. This is selected packaged coverage,
  not the full hosted source suite or installer qualification.

Artifact bytes and SHA-256 values, component identity and CI snapshot are in
[the JSON companion](windows-1.2.0-release-validation-2026-10-15.json).
Local `PACKAGE-IDENTITY.json`, `SIGNATURES.json`, `ZIP-VERIFICATION.json`,
`SHA256SUMS.txt` and a prepared `RELEASE-NOTES.md` remain beside the candidate.
They have not been uploaded. Private raw test evidence is not a release asset.

## New hosted failure

[Electron run 38739785628](https://github.com/yuchen-ya/reelterminal/actions/runs/38739785628)
completed: Windows **122 passed / 1 failed / 13 skipped**, Mac **123 passed /
13 skipped**. The Windows failure is
`flow-a-text-rewrite.e2e.ts:168`, “handoff legibility: the agent observes a real
human edit as a new revision”. After one real timeline drag, the external agent
read `overlay.startTime === 0`; the retained assertion requires `> 0`.

The retained Windows artifact JSON has agent-edit revision 2 and post-undo/redo
revision 4, but no after-drag snapshot because it is recorded after the failed
assertion. The test compares the post-drag revision against old revision 2,
which cannot establish that this drag committed after undo/redo. Its driver
uses real mouse events followed by a fixed 400ms wait; that observation alone
does not prove a synchronization defect or justify increasing it. Existing
screenshots establish the pre-drag state only. Another suite's successful drag
and the local packaged Flow A pass do not attribute this failure.

No assertion, timeout or threshold was weakened; no rerun was requested to
obtain a green result. No product fix is claimed. The build is retained as a
candidate while the new failed core handoff remains unresolved.

Minimum useful next evidence is a single instrumented gesture in the existing
harness: immediately pre-drag revision/timeline, actual hit target and geometry,
mousemove/mouseup/blur events, rendered preview, command result/notification and
after-drag canonical snapshot **before** asserting. Compare against the
immediately pre-drag revision. Preserve the existing action budgets and one
real gesture. This evidence can distinguish a missed/cancelled input, pending
or rejected commit, and an incorrect canonical mutation; it does not require
another historical long stress run or access to the user's Mac.

Other source checks: [Chromium E2E](https://github.com/yuchen-ya/reelterminal/actions/runs/38739785687)
and [performance contracts](https://github.com/yuchen-ya/reelterminal/actions/runs/38739785516)
passed. [CI](https://github.com/yuchen-ya/reelterminal/actions/runs/38739785593)
also passed (tests/lint, native tools and build); terminal results are in the JSON companion. Hosted Mac results are source test
results; there is no Mac 1.2.0 package acceptance here.

## Same-source Mac handoff and remaining limits

For a future Mac candidate, safely synchronize the exact frozen SHA above with
Node >=22.13 and pnpm 11.7, frozen-lockfile install and normal WASM/build scripts.
Use an independent `apps/desktop/release/` output; verify version 1.2.0, exact
build-stamp SHA and dirty=false. Local unsigned Mac builds remain developer
evidence, not signed/notarized release assets. No personal Mac task was started.
The earlier a8 arm64 1.1.2 package must not be renamed or attached as 1.2.0; do
not repeat its completed ten-export/five-minute-idle round merely for this bump.

The local native clipboard roundtrip anomaly, historical Mac startup/audio
timeouts, shared/browser memory retention and small post-saturation history heap
trend remain unattributed. Long-term memory bounds are unproven. Metrics are not
summed and RSS reduction is not asserted as proof of deallocation. See the original reports
and [release notes](../RELEASE-1.2.0.md) for their limited scopes.
