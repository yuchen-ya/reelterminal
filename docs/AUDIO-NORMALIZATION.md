# Local loudness normalization

`audio.process.normalize` creates a derived audio file using local FFmpeg
two-pass `loudnorm`. `audio.process.register` imports that completed file through
the existing media importer. Both commands require write access in live mode.
Neither command replaces the original media or any timeline clip.

## Start, inspect, register

Use `reelctl call audio.process.normalize --file normalize.json` with:

```json
{
  "projectId": "project-id",
  "workspaceId": "workspace-id",
  "mediaId": "media-id",
  "audioStream": 0,
  "startSec": 1.123,
  "endSec": 4.234,
  "targetLufs": -16,
  "truePeakDbtp": -1,
  "loudnessRangeLu": 11,
  "sampleRate": 48000,
  "channels": 2,
  "expectedRevision": 7,
  "idempotencyKey": "normalize-dialogue-take-1"
}
```

The desktop transport carries project/workspace IDs in its existing request
context; direct in-process facade calls omit these two transport fields.
`audioStream` is the zero-based index among the source's audio streams.
Processing fields are required. LUFS accepts -70 through -5, true peak -9
through 0 dBTP, LRA 1 through 50 LU. These are configurable targets, without
claiming a universal delivery standard. Ranges must fit the selected audio
stream and span at most 3600 seconds (AUD-11; previously 120). Output is
48 kHz mono or stereo PCM 24-bit WAV; FFmpeg's native channel-layout
conversion applies before measuring.

Long ranges are bounded explicitly rather than by a small cap: each loudnorm
pass streams inside one FFmpeg process (no PCM buffering in this process),
the per-pass wall-clock budget is `180 s + 8 s per source second`
(cancellation stays available), the whole-range integrated LUFS always comes
from one two-pass run over the exact requested window — never an average of
chunk measurements — and the output budget is 288 KB/s for stereo s24le
(about 1.0 GiB per hour). Job progress now tracks each pass through FFmpeg
`-progress` reporting.

The start response contains `jobId`, `kind: "audio-process"`, source revision,
state and `replayed`. Poll `reelctl job wait <jobId>` or `job.status`. A completed
job's `result` contains `path`, `provenancePath`, source project/workspace/media
identity and range, effective `parameters`, actual `before`/`after` measurements,
output `timing`, byte count and digest. The result remains bounded and contains
no sample arrays. Target values are never substituted for achieved measurements.
Publication requires the measured integrated loudness to be within 1 LU of the
requested target and true peak to be at most 0.2 dB above its ceiling. A result
outside these tolerances fails without an asset, including short high-crest
material which FFmpeg cannot bring to the requested target. There is no automatic
gain retry or compensation loop. The configured LRA is supplied to loudnorm;
its achieved value is reported rather than promised to equal the setting.

After `state: "done"`, reread the target project's revision and call:

```text
reelctl call audio.process.register --project-id project-id --workspace-id workspace-id --job-id job-id --expected-revision 7
```

Registration returns the standard `media.import` result, including the new
`mediaId`, resulting revision and `replayed`. It uses the same headless mutation
lane or live renderer import bridge, CAS, durable live import receipts and
undo/history group as ordinary media import. A stale revision fails with
`CONFLICT`; inspect intervening edits and explicitly supply the new revision
to register. It refuses jobs from another project/workspace, non-completed
jobs and WAV bytes changed after measurement. Repeating registration for the
same job returns the original import receipt and does not insert another asset.
As with ordinary media import, a committed receipt replays before filesystem
checks; it does not restore a file subsequently removed outside the application.

## Processing and mutation boundary

Processing snapshots the source project revision and retains existing live task
input references. It never commits a project mutation in the background. Human
edits, navigation and workspace switches therefore cannot cause an automatic
import into another project. Registration must explicitly target the original
project/workspace. The live bridge keeps the existing request-local workspace
identity and commit-time revision protection.

The required normalization idempotency key pins all processing parameters in
that project/workspace. Reusing it with changed parameters fails with `CONFLICT`;
retrying the same request returns the existing job, including its failure or
cancellation state. Use a new key for a deliberate rerun. Live task-ledger
recovery restores completed results/receipts; work interrupted by a desktop
restart is reported interrupted, never fabricated as completed. A headless
session's job registry is in memory; import before disposing it, or use the
published file with ordinary `media.import` in a later session.

The first pass measures the converted source range. The second pass supplies
`measured_I`, `measured_TP`, `measured_LRA`, `measured_thresh` and the first pass's
`target_offset`. `linear=true` requests linear mode; FFmpeg can choose dynamic
mode when the measured material/targets require it. No `speechnorm` or separate
limiter is appended. The written WAV is probed for sample count/layout and
independently measured again after all resampling and sample-length operations.
All-silent, too-short/unmeasurable, missing-audio-stream and decode failures
produce an error with no successful asset or invented metrics.

`job.cancel` requests abort; an audio-process job settles to `cancelled` after
the child process exits and owned output files have been cleaned. Cleanup
failure is an error. Cancelled/failed jobs have no successful result and cannot
be registered. Session close aborts live audio-processing work. The existing
two-task live queue and two-job headless audio/analysis limit remain in force.

## Timing and durable storage

The half-open source range `[startSec,endSec)` is trimmed, timestamps are reset
to zero, and the sample rate/layout is fixed before measuring. The output has
exactly `round((endSec-startSec)*48000)` samples, with duration `sampleCount/48000`.
The final trim/pad enforces that count before the output is remeasured. Output
sample zero corresponds nominally to `startSec`; sample `n` corresponds to
`startSec+n/48000`. Decoded source-sample rounding and sample-rate conversion
limit boundary precision; choosing a range does not promise fractional-source-
sample accuracy. `processingDelaySamples: 0` describes the compensated file
timeline, rather than the runtime latency needed to compute it. The regression
fixtures check nonzero source starts, 44.1→48 kHz conversion and pulse positions.

Completed WAV and provenance JSON live together under:

```text
<mediaRoots[0]>/generated-assets/audio-normalize/<jobId>/
  normalized.wav
  provenance.json
```

This directory is persistent generated media, separate from `artifactRoot`,
analysis records and disposable `jobs/` contents. Both files are fully produced
and verified before publication. Provenance retains source identity/range,
source digest, effective parameters, both measured results and timing. Imported
project/checkpoint references keep the WAV usable after analysis-cache cleanup.
Back up this generated media alongside its project; do not treat it as cache.
Registration failure leaves a valid completed output available for an explicit
retry. Abandoned completed files are not automatically garbage-collected.

Live and headless expose the same commands and `capabilities.get.audioNormalize`.
Availability requires local FFmpeg/ffprobe with the `loudnorm` filter, configured media roots and, in live
mode, the existing operational media-import bridge. No live user project is
needed for development validation.

Audio streams with a nonzero offset relative to the media's timestamp origin
are supported since AUD-12, with the mapping fixed explicitly instead of
rejecting the stream:

- source media time = container time − the format's timestamp origin;
- audio track time = source media time − the stream's start offset;
- output time zero = the requested `startSec` in source media time.

A range that starts before the audio track begins keeps the gap as real
output silence (`timing.leadSilenceSamples`), so a legal leading delay is
preserved and nothing is silently shifted; a negative stream offset simply
means the track has content before the media origin, which the PTS-based
trim never requests. Provenance records `sourceStreamStartSec` and
`sourceStreamOffsetSec` alongside the existing timestamp origin. A shared
positive format/audio timestamp origin is still preserved during source
trimming and then mapped to output zero. Container-reported stream starts
carry codec priming (AAC ≈ 22 ms), so the preserved lead is the container's
reported offset, not a nominal value. A range ending before the track starts
is rejected; a range past the track's honest coverage fails measurement
rather than publishing padded silence as normalized. The denoise and
separation verbs still reject offset tracks (their delay-compensation and
model paths have not adopted the mapping).

Source decoding is bounded by the per-pass budget above and output limits.
Headless transport shutdown waits up to ten seconds for requested audio
cancellation to settle; forced process termination can leave an unpublished
staging directory. The desktop host only sweeps
`.<jobId>.<pid>.<uuid>.pending` directories whose owner process is confirmed
absent. Live owners, permission-unknown owners and legacy directories without
a PID are retained. Published assets are never swept.

## Content-addressed reuse and lifecycle (AUD-13)

A new job whose full effective identity — source content SHA-256, audio
stream, sample-exact range, all effective parameters, preprocessing chain
version and the FFmpeg runtime version, never `mediaId` alone — matches a
previously published artifact reuses those exact bytes: the WAV is copied
into the new job's staging directory, verified (existence, WAV and provenance
SHA-256, version),
and published under the new jobId with `reusedFrom` disclosed in provenance
alongside the original run's measurements, which describe exactly those
bytes. Any doubt (missing file, changed bytes, version drift) recomputes
from scratch and repairs the index. The reuse index
(`generated-assets/<kind>/.reuse-index.json`) only names published
artifacts and deletes nothing: registered assets, project references and
undo history are never treated as cache, and a completed-but-unregistered
job keeps its artifact available for later registration. Undo/redo of a
registration replays retained media bytes; reuse is an optimization, not a
promise of zero recomputation. Restored after-restart receipts replay under
their own verb (normalize/denoise/separate), so a same-key retry no longer
starts a duplicate job.

## Follow-up work

Headless cross-session job recovery beyond the existing durable live ledger,
DeepFilterNet-tier denoising and further lifecycle automation are tracked in
[AUDIO-BACKLOG-COMPLETE.md](archive/AUDIO-BACKLOG-COMPLETE.md). VAD, denoising, transcription and source
separation are separate work; normalization does not imply those models are
installed. This page describes implemented source behavior; query the
running installation's catalog and capabilities before invoking it.
