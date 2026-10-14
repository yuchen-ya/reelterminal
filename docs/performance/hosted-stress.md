# Manual GitHub-hosted performance runs

The `Performance regression` workflow keeps fast correctness contracts on push
and pull requests. Measurements run only through `workflow_dispatch`, on a
standard `windows-latest` runner, with `contents: read`. The former dedicated
runner schedule is removed. Manual measurements queue serially across branches
and never cancel an active soak. Each job has a 210-minute limit, including setup.

Always supply the full tested commit SHA. Checkout, build stamps, logs and
`hosted.json` record that same commit. Run `smoke` first, inspect its actual
logs and reports, then use `stress` on the same SHA:

```sh
gh workflow run performance.yml --repo yuchen-ya/reelterminal --ref main -f commit=<40-character-SHA> -f profile=smoke
gh run list --repo yuchen-ya/reelterminal --workflow performance.yml --event workflow_dispatch
gh run view <run-id> --repo yuchen-ya/reelterminal --log
# Only after the smoke run passes:
gh workflow run performance.yml --repo yuchen-ya/reelterminal --ref main -f commit=<same-SHA> -f profile=stress
```

Both profiles use the existing production build, probe calibration and
`scripts/performance/run.mjs`; no packaging or release occurs. All fixtures are
synthetic and each Electron instance owns a temporary isolated profile and
endpoint. No user project or local Agent Access descriptor is accessed.

| Workload | Smoke | Stress |
| --- | --- | --- |
| T01 timeline, H01 history, P01 durable save | 5 samples each | 5 samples each |
| T03 dense timeline | Not selected | 2000 clips, 50 tracks, 25 samples |
| H01 large history | Not selected | 1000 nodes, 25 samples |
| R01 edit/undo/redo resource cycles | 10 rounds | 500 rounds |
| R02 continuous editing/history/save observation | 60 seconds | 1800 seconds after real history saturation |

All workloads use seed 42, one repeat, and serial execution. The first failure
stops later workloads; `not_run` entries are not passing coverage. R02 remains
one continuous run and reserves startup/cleanup time in addition to its measured
duration. No assertions or calibration thresholds are weakened. Hosted duration
results are report-only because these machines are not a stable local baseline;
functional, structural, incomplete-capture and resource failures still fail.

Only anonymous CI reports, exact parameter/runner metadata and numeric resource
diagnostics are uploaded, with three-day retention. Raw profiles, endpoint
descriptors, source/export videos, full screenshots and traces are excluded. A
persistently blocked synthetic drag may retain one 200×100 input-point crop as
failure diagnostics. The
measurement job creates no new dependency/build cache.

Windows is the minimum useful hosted desktop coverage. Linux can run the contract
tests but GUI measurements need a display harness. macOS is supported by the
existing Electron harness, but is not selected for this bounded first run.
Neither hosted Windows nor software/virtual graphics measures the user's GPU,
hardware decode/encode, audio output, physical display presentation, real-media
exports or interactive responsiveness on their machine. A passing run is not a
release qualification.

## 2026-10-14 calibration review

The diagnostic smoke on commit `3e15fc94de57360dde952b528c6489998e27043a`
([run 38556573514](https://github.com/yuchen-ya/reelterminal/actions/runs/38556573514))
completed all 20 runs (five ABBA blocks) and failed the existing overhead gate. No measurement
scenario or representative stress run executed. The gate pools 10 off and 10
light durations and selects each sorted sample's sixth value (upper median).
It compares their difference with `max(offUpperMedian * 0.02, 30 ms)`.
The result was 19,916.205 ms versus 21,164.225 ms: +1,248.020 ms (+6.266%),
against 398.324 ms tolerance. The runner and CI evidence validator implement the
same calculation; this is not a transcription or rounding error.

Descriptive results from the same retained 20 durations, with no exclusions:

| ABBA block | Mean off ms (A1+A2)/2 | Mean light ms (B1+B2)/2 | Difference ms | Relative difference |
| --- | ---: | ---: | ---: | ---: |
| 1 | 21,015.708 | 22,275.350 | +1,259.642 | +5.994% |
| 2 | 19,644.978 | 20,679.022 | +1,034.045 | +5.264% |
| 3 | 20,346.950 | 20,228.658 | -118.293 | -0.581% |
| 4 | 24,329.637 | 22,760.650 | -1,568.987 | -6.449% |
| 5 | 19,594.460 | 20,041.927 | +447.467 | +2.284% |

Off spans 19,272.715–26,927.050 ms (sample CV 11.13%); light spans
19,087.775–24,357.075 ms (CV 8.38%). Ordinary even-sample medians give +5.984%,
so the upper-median convention alone does not explain the failure. The mean of
the five paired block differences is +210.775 ms (pooled mean ratio +1.004%).
Those means are diagnostic only and do not replace the failed median gate.
Leaving out each block in turn changes the original upper-median ratio from
-0.869% to +6.266%; this is sensitivity analysis, not permission to discard data.
Only five blocks exist, two have a negative difference, and the measurements
overlap substantially. The failed gate is real; attributing exactly 6.27% to
intrinsic probe cost is unsupported. Nor do these data prove that the probe is
within 2% or that all variation is hosted noise.

ABBA orders the same six gestures and final save as off/light/light/off. Paired
block means can cancel an approximately linear drift at evenly spaced positions;
pooling medians does not retain that cancellation. Switching the qualification
statistic would change metric meaning and requires an explicit decision, with
matching runner/validator changes and comparison-identity review. No such change
was made.

The wall window includes Playwright input driving, repeated full timeline reads
through the real MCP connector, rAF pacing, state polling, marker verification,
save completion and collector settling. Capture startup and export are outside
that wall window. CDP TaskDuration includes startup/export by the documented
contract and cannot be substituted for the wall gate or interpreted as pure
product-handler CPU. Awaiting the save toast observes the production durable
flush, so it is not evidence of a missing save await. CPU/export/per-phase data
cannot be reconstructed from the retained durations alone.

Two small forward fixes retain already-recorded numeric CPU/export/heap/event
evidence in anonymous summaries and require each light group's full driver
capture (renderer, main, and visibility) to be complete. The previous loop checked
only renderer completeness. These fixes tighten evidence quality; they do not
explain or cure the observed overhead failure. No threshold, sampling frequency,
workload, capture budget, or aggregation changed, and no new cloud retry was
triggered merely because the evidence fields changed. All cloud failures remain
in the record. The first smoke's incomplete capture lacks a retained reason code;
it must not be retroactively classified as a proven timeout.

The smallest next measurement change is bounded per-phase timing around the
existing workload, with the original gate retained, to locate input/RPC/rAF/save
waiting versus collector cost. Any plan to replace the gate with a paired
statistic needs metric agreement first; do not relabel the current failure using
the lower paired mean or repeat runs until one happens to pass.

The existing calibration now records bounded per-group phase totals for MCP
reads, input driving, geometry, rAF pacing, final-state checks, save completion,
collector settling, start and export. Drag pacing keeps the same eight rAF calls
per gesture; the existing browser calls also return their renderer-clock wait
time. Node await elapsed includes transport/scheduling, whereas renderer rAF
elapsed does not include the return trip. Their difference is diagnostic latency,
not a direct measure of operating-system scheduling or pure probe CPU. Drag
subphases are nested and must not be added to `drag_ms` again. A second pair of
CDP samples brackets the unchanged wall window outside its start/stop timestamps;
the original wider TaskDuration evidence remains separately recorded. Timing
fields do not participate in qualification or alter its upper-median/2% rule.

The phase run on commit `8688cae97e8eb23fbc2d774510c0486a78847710`
([run 38561494198](https://github.com/yuchen-ya/reelterminal/actions/runs/38561494198))
completed 13 runs; the next light run exhausted both collectors' existing
30-second budget. Its pre-gesture and verification MCP reads totaled 26,356.968
ms, dragging 3,702.963 ms (nested renderer rAF waits 369.540 ms), and save/settle
waits were small. Completed off/light renderer TaskDuration medians were
3.370/3.422 seconds, while wall medians were 25.649/23.550 seconds. These are
unequal, incomplete samples (7 off/6 light), not a qualified overhead estimate.
The retained failure now explicitly identifies `budget:capture_seconds` and
`main_capture_budget_exceeded` for this run only.

Static inspection found an existing status-path problem: `currentWriter()`
called full `session.describe`, which constructs capabilities and repeatedly
runs Python/OpenCV preflights even for ordinary status polling. Every command's
status/guard/activity updates exercised this unrelated work. The host now reads
the same session-owned writer flag through an internal, unregistered accessor;
older injected facades retain the existing fallback. Writer acquisition,
revocation and project guards are unchanged, and explicit capability/description
queries still run their real preflights. Regression checks cover lease state,
read-only/revocation, status ordering, CLI/MCP guards and absence of provider
preflights from ordinary status. This removes unrelated repeated probing rather
than increasing the capture budget or altering qualification statistics.

The first status-fix smoke completed eight runs with wall windows around
3.6 seconds and total MCP-read phases around 0.8–1.0 seconds, confirming the
large unrelated status overhead was removed. It then failed the existing
pre-input hit assertion, so it did not produce a qualified calibration. Custom
mouse input now waits at most the existing 5-second operation ceiling for its
coordinates to hit the exact target before mouse-down. A permanently blocked
target still fails and may retain the small input-point crop; no wrong-target
input is allowed. The original hit assertion and pointer/geometry checks remain.

## Fixed-commit smoke and representative stress outcome

Both final runs tested commit `afbeaa6f1549a357da3f96d4c27c7ba84bc65502`.
The stress run was dispatched once, only after the smoke had completed and its
actual report had been checked. No threshold, statistic, capture budget or
scenario assertion changed between these runs.

| Run | Hosted CPU | Contracts | Calibration | Scenario outcomes |
| --- | --- | --- | --- | --- |
| [Smoke 38565422782](https://github.com/yuchen-ya/reelterminal/actions/runs/38565422782) | AMD EPYC 7763, 4 logical cores | 258 passed, 0 failed, 0 skipped | Qualified, 20 runs / 5 ABBA blocks | 5 complete, 0 failed, 0 not run |
| [Stress 38566675353](https://github.com/yuchen-ya/reelterminal/actions/runs/38566675353) | Intel Xeon Platinum 8573C, 4 logical cores | 258 passed, 0 failed, 0 skipped | Failed, 20 runs / 5 ABBA blocks | 0 complete, 0 scenario failures, 7 not run |

Both used the standard `windows-latest` image `20260925.250.1`, with isolated
synthetic profiles. Scenario counts are result records, not Vitest test counts.
The smoke exercised T01, H01, P01, ten R01 rounds and a requested 60-second
continuous R02 observation (59 cycles; 62.043 seconds including final checks).
Its anonymous report has five results, zero warnings and zero hard failures;
hosted duration comparisons remain `report_only` with no fixed baseline.

The unchanged calibration gate uses off/light upper medians of
3,612.775/3,577.035 ms for smoke (-0.989%, tolerance 72.256 ms), and
3,364.670/3,467.220 ms for stress (+3.048%, difference 102.550 ms, tolerance
67.293 ms). Negative smoke overhead is not a claim that instrumentation makes
the product faster. All light captures in the stress calibration were complete
in both collectors, visible and free of recorded drops; this failure is
`probe_overhead_exceeded`, not an incomplete capture or drag precondition error.

Stress phase upper medians for off/light were: wall-window renderer CPU
1.9666/2.0013 seconds, pre-gesture reads 331.114/368.486 ms, verification reads
249.374/293.485 ms, drag driving 2,548.388/2,559.280 ms, renderer rAF waits
465.140/462.425 ms and save waits 154.909/213.484 ms. Phase medians come from
different samples and cannot be added to reconstruct the wall median. Export
was outside the unchanged wall window. These measurements do not isolate an
additional intrinsic collector defect, prove that hosted noise caused the
failure, or qualify the probe as within 2%.

The stress scenario step did not start: quick T01/H01/P01, dense T03, large H01,
500-round R01 and saturated-history continuous 1,800-second R02 are all
`not_run`. The report's `no_result_artifacts` hard failure follows from that
absence; it is not a second product failure. No 30-minute observation or dense
timeline qualification was obtained. The different CPUs also prevent treating
the cross-run wall difference as a controlled performance improvement.

This round ends with a passed smoke and a blocked representative stress, not a
passed long soak. A further change needs a concrete collector/RPC defect with a
focused reproduction, or explicit agreement on a different qualification metric
and its validation. Repeating hosted runs until one passes, changing the 2%
limit, replacing the statistic with the lower paired mean, or choosing another
OS to erase this Windows failure would not resolve this evidence. macOS GUI
measurements and Linux display-backed measurements remain untested here.

The Actions artifacts retain small anonymous evidence for three days. This
document preserves the tested SHA, result summary and run links after expiry.
The independent normal CI still reports the pre-existing naming violation in
`packages/agent-facade/src/audio-process.test.ts:89`; the wider Electron suite
also failed separately (Windows 74 passed / 34 failed / 15 skipped; macOS
73 passed / 35 failed / 15 skipped). Some tests retain obsolete project/CLI
contracts; other UI failures need their own reproduction. These are not covered
or certified fixed by the performance smoke. The user's earlier source-detail
and macOS audio-normalize corrections were verified rather than reimplemented.

## Cloud stability purpose (explicitly selected after the blocked stress)

The existing manual workflow also accepts `stability-smoke` and `stability`.
These reuse the exact smoke/stress workload plans in the table above, but the
purpose is crash-free completion and data correctness, not performance
qualification. The standalone probe-overhead calibration is not run for these
two profiles. The original `smoke`/`stress` profiles retain their 2% calibration
gate unchanged; the failed Windows results above remain failures.

No operation, capture-completeness, visibility, structural, correct-state,
save/reopen or resource-bound assertion is removed. Timings and memory trends
are reference observations with no performance pass claim or baseline comparison.
The final hosted summary additionally rejects missing scenario records, a
mismatched tested SHA, incomplete R01 rounds, absent T03 undo/redo evidence,
missing history saturation or an R02 elapsed duration shorter than requested.
A successful report says `stability_passed` and `performance_qualified: false`.
Trace-only or unknown correctness contracts cannot qualify as stability evidence.

Coverage is specific: T03 checks single/multiple clip edits, full-state undo/redo
and content frames on 2,000 clips / 50 tracks; H01 verifies node identity and
target frame with 1,000 nodes; P01 verifies revision and clip timing after save
and process relaunch. R01/R02 verify edit/undo/redo state, history-preview return,
save-queue drain and fixed-resource bounds. R02 observes one continuous 30-minute
interval after real history saturation; its final queue check does not itself
verify R02 process-relaunch persistence. P01 supplies the separate relaunch check.
No selected scenario is timing-only. There is no explicit injected-crash/recovery,
real-media export, physical GPU, audio-device or long local interactive coverage.

```sh
gh workflow run performance.yml --repo yuchen-ya/reelterminal --ref main -f commit=<full-SHA> -f profile=stability-smoke
# Inspect actual success and evidence first, then use the identical SHA:
gh workflow run performance.yml --repo yuchen-ya/reelterminal --ref main -f commit=<same-SHA> -f profile=stability
```

Only standard hosted Windows, serial execution, synthetic isolated profiles,
small anonymous summaries and three-day retention are used. This purpose change
does not modify the original local runner options or touch a running local test.
