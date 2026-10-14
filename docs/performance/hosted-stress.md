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
