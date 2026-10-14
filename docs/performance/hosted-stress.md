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
descriptors, source/export videos, screenshots and traces are excluded. The
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
completed all 20 groups and failed the existing overhead gate. No measurement
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
