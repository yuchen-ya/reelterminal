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
