# Windows 1.2.0 release validation — 2026-10-15

**Latest outcome:** Windows 1.2.0 was published from the later unified privacy-fixed `3a5a47a8` source. See [final publication/privacy report](windows-1.2.0-publication-2026-10-15.md). The earlier stages below retain their original identities and failures.

Initial-stage status: **publication paused for a new hosted Flow A failure**. No v1.2.0 tag or
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

## Bounded Flow A investigation after the initial block

`git diff 9db42277 ee1062ec -- apps packages` confirms that, apart from
package versions and distribution documentation, the only product source
change is `GUI_MANUAL_APP_VERSION: 1.1.2 -> 1.2.0`. Flow A and all timeline,
gesture and persistence product code are unchanged. This is evidence against
a newly introduced gesture implementation regression, not proof that the
failure is environmental or test-only.

The existing Flow A test now records immediately pre/post gesture context and
canonical timeline **before assertions**, bounded real input/focus/hit/preview
DOM samples, and the existing product capture trace. No product monitoring
module was added. One gesture, its original 400ms wait and `startTime > 0`
remain. Revision is now compared against the immediate pre-drag revision,
strengthening the former assertion. Diagnostic/screenshot failures cannot
replace the primary action error.

Two single-gesture probes ran against the retained ee1062ec 1.2.0 package:

| Probe | Result | Canonical observation |
| --- | --- | --- |
| Normal native window | 5/5 Flow A tests, 4.69s total | Revision 4 -> 5, start 0 -> 0.4277159966s; correct hit, focused and visible |
| Narrow window, controlled CPU throttle 8 | 5/5, 5.88s total | Requested 1024x720; actual 1023x720. Revision 4 -> 5, start 0 -> 0.6640106242s; canonical commit 8.83ms after release, before the original read point |

The second probe matches the narrow-layout intent, not the hosted machine's
exact native geometry/DPR; it does not claim the strict small-startup guard
passed. Temporary size/CPU controls were removed from the source. Both probes
retained the original observation point. They **did not reproduce** the
hosted failure and do not justify calling the problem fixed or increasing a
timeout. Capture can perturb timing; a later instrumented pass alone also
cannot attribute the original failed run. The targeted test typecheck passes
with DOM/DOM.Iterable browser libraries.

One normal automatic CI round will carry the stronger diagnostic test to the
hosted environment. No manual duplicate, retries or historical long stress
runs are requested. If the original failure remains unattributed, publication
requires an explicit choice to accept that bounded risk or continue a focused
investigation; it must not silently become a green-only release claim.


The diagnostic test commit is `85bdde07f98b881d6980b461774e3e1e4c06469d`.
Its one automatic [Electron run](https://github.com/yuchen-ya/reelterminal/actions/runs/38743806319)
is the bounded hosted follow-up, not a manual rerun. Publication remains pending
at the time of this note. Current user-facing documentation now points readers
to the actual Release status rather than embedding a temporary publication state;
the unattributed failure and platform/unsigned limitations remain explicit.
A fresh independent package from the following clean documentation freeze may
be prepared while CI runs; that preparation does not accept the unknown risk or
publish anything. In the CPU-throttled probe, capture-stop cleanup closed a
pending performance span as cancelled after the successful canonical commit;
that collector cleanup is not evidence of a physical window blur/cancel.

## Latest independent 1.2.0 candidate: 29524f05

Latest build source: **29524f053c0789227e31cd58f925985d6742baab**.
Directory: `apps/desktop/release/windows-1.2.0-29524f05/`. It was built clean
with the normal scripts into its own directory; older candidates are preserved.
Compared with hosted diagnostic source 85bdde07, only documentation changed.

- Packaged app/installer version 1.2.0, exact source stamp and dirty=false verified.
- Installer/application NotSigned, no installer wizard or installation replacement.
- Packaged core **27/27 / 12 files / 92.40s / retry 0**, including the stronger
  immediate-pre-drag revision check; no timeouts or thresholds raised.
- ZIP all CRCs valid; all 302 files match the tested unpacked candidate.
- Application payload hashes match the previous ee1062ec package for all 213
  compared files, excluding the intentionally different build identity. Dependency
  inputs unchanged. This is not full installer byte equivalence and does not erase
  a prior failed interaction.

Identity, checksums and scope: [candidate JSON](windows-1.2.0-29524f05-2026-10-15.json).
[Runtime hash proof](windows-runtime-payload-equivalence-29524f05-2026-10-15.json)
and its per-file companion are retained as inspectable source-backed evidence.

The one automatic [diagnostic Electron run 38743806319](https://github.com/yuchen-ya/reelterminal/actions/runs/38743806319)
completed on Windows with **123 passed / 13 skipped**, 356.19s. Its real drag
hit the text clip, remained focused/visible, previewed 100px and committed
revision 4 -> 5 at 1.235ms after mouse-up. Canonical start changed 0 ->
0.6631299735s before the unchanged 400ms observation. The existing product
trace records a successful final gesture commit. These details validate that
round; they cannot recover the missing input/commit trace of the old failure.

No reproducible product defect was established by the bounded investigation.
No test-environment-only root cause was established either. The proven test
improvements are the stricter revision baseline and retaining evidence before
assertions, **not** a claimed fix of the failed startTime observation.

No further automatic/manual test rounds are planned solely to obtain green.
Remaining automatic CI terminals are tracked in the candidate JSON. The residual
choice is whether to publish the verified Windows scope while explicitly
retaining this one unattributed failure as a known risk, or keep publication
blocked pending an actual instrumented reproduction. A later passing run alone
must not silently decide that risk question. No tag or Release exists at the
time of this update; Mac 1.2.0 package acceptance is still absent.


Terminal follow-up: all four 85bdde07 automatic workflows passed:
[CI](https://github.com/yuchen-ya/reelterminal/actions/runs/38743806400),
[Electron E2E](https://github.com/yuchen-ya/reelterminal/actions/runs/38743806319),
[Chromium E2E](https://github.com/yuchen-ya/reelterminal/actions/runs/38743806316),
[performance contracts](https://github.com/yuchen-ya/reelterminal/actions/runs/38743806298).
Mac source Electron also completed with 123 passed / 13 skipped, 550.32s; this
is not a Mac package acceptance. No retries/manual duplicates were requested.
The documentation freeze 29524f05 shares exactly these product/test sources.
The explicit risk choice has been requested after completing the concrete
candidate, evidence and release-note draft. No answer is inferred from a green
run, elapsed time or the existing general release authorization.
