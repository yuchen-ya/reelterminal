# Material inspection and audio analysis

ReelTerminal provides read-only inspection of imported media and local audio
measurements. These tools report evidence; they do not infer semantic intent
or apply edits.

For local two-pass loudness normalization and derived asset registration, see
[Audio normalization](AUDIO-NORMALIZATION.md). That workflow uses explicit
write commands and preserves the source asset.

## Source inspection

`media.import_preflight {path}` checks that a file is inside the allowed media
roots and can be read. A successful preflight does not guarantee codec support.
Live GUI imports are limited to 256 MiB.

`media.inspect` samples up to 12 source timestamps. It accepts a source range,
explicit timestamps or a sample count, and an optional normalized region of
interest. Results include frame artifacts, source coordinates, and the current
timeline mapping when a clip uses that media. The configured byte budget may
deliver a compressed or smaller image; inspect each artifact's `fidelity`
metadata before using it as evidence.

## Audio summary

`media.analyze_start` with `analysisTypes: ["audioSummary"]` runs locally with
FFmpeg and ffprobe. It reports stream facts, integrated loudness, true peak,
loudness range, bounded waveform levels, silence intervals, and onset
candidates. It does not upload audio or modify the project.

Audio analysis (`audioSummary`, `silence`, `beatGrid`, `speechActivity`,
`speechTranscript`, `speakerDiarization`, `syncOffset`) requires `artifactRoot`.
Without it, capabilities report these types unavailable and the start request
is rejected before creating a job.
`job.status` returns audio counts and scalar measurements plus
`summary.analysisRecord.id`; use that ID to read details. Restored jobs and
batch checkpoints use the same compact audio view.

Source ranges: the three local PCM/loudnorm analyses (`audioSummary`,
`silence`, `beatGrid`) accept up to 3600 seconds (AUD-11) — their decodes
run as ONE continuous FFmpeg process whose stdout is consumed in bounded
chunks, so kernel memory stays bounded by derived window/energy state
(whole-stream ceiling 340 MiB, per-process wall budget `60 s + 2 s per
source second`); the integrated LUFS always comes from a single whole-range
loudnorm pass, never an average of chunk measurements, and streamed silence
windows sit at absolute sample indices so regions equal the whole-buffer
kernel exactly — nothing is lost or duplicated across chunk boundaries. The
model-backed analyses (`speechActivity`, `speechTranscript`,
`speakerDiarization`) and `syncOffset` keep the 120-second cap; longer
material must be split into explicit ranges. At most two analysis jobs run
per session, with four local audio subprocesses per process. Each buffered
process has a 60-second deadline and a 16 MiB combined output limit.
Missing FFmpeg or ffprobe is reported through capabilities and job results.

### Speech activity (VAD)

`media.analyze_start` with `analysisTypes: ["speechActivity"]` runs Silero VAD
v5.1.2 locally through the optional `onnxruntime-node` package — the same
locked runtime and weights for live and headless sessions. Audio is decoded by
the local FFmpeg path above from the first audio stream (`0:a:0`) into a
16 kHz strongest-absolute-sample mono mix (right-only speech survives;
anti-phase channels cannot cancel), then scored in 512-sample (32 ms) chunks
with carried model state.

Regions are hysteresis-thresholded speech probabilities (enter `threshold`,
exit `threshold − 0.15`), filtered by minimum speech/silence durations and
padded, in original source seconds. Overlapping padded regions are merged, so
regions are disjoint and `totalSpeechDurationSec`/`speechRatio` describe the
actual union; a decode shorter than the requested range is reported as
`truncated` with regions clamped to the decoded span. Tuning mirrors the
Silero reference and is adjustable via
`vadParams {threshold, minSpeechSec, minSilenceSec, padSec}`
(defaults 0.5 / 0.25 s / 0.1 s / 0.03 s); the effective values (including the
computed exit threshold) are persisted in the record config, while GUI
rechecks replay the four input fields and recompute the exit threshold.
Results report `granularitySec` and `boundaryUncertaintySec` of
0.032: boundaries land on chunk edges plus the requested padding, and the
final partial chunk is zero-padded with ends clamped to the analyzed range.

The pinned model (2 327 524 bytes, sha256
`2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f`, MIT) is
downloaded once on first use from the locked GitHub tag into
`~/.reelterminal/models/silero-vad-5.1.2/`, or supplied via
`REELTERMINAL_VAD_MODEL` (still sha-verified). Capabilities never download and
never report the type ready when the runtime or model is missing; the download
is bounded, abort-aware, sha-verified and atomically published. No audio is
uploaded.

Read regions with `analysis.get {view: "events", series:
"speechActivity.speechRegions"}` using the same half-open source-seconds
windows and cursors as the other series. Speech regions are acoustic model
inferences, not semantic understanding: singing and speech-like sounds can be
missed or falsely included, and non-speech intervals are not automatically
deletable gaps.

### Anonymous speaker diarization

`media.analyze_start` with `analysisTypes: ["speakerDiarization"]` reuses the
Silero VAD sentence segments and clusters CAM++ speaker-verification embeddings
by cosine similarity (`diarizationParams {threshold, maxSpeakers,
allowModelDownload}`, defaults 0.7 / 8). Labels are **anonymous clusters**
(`speaker-1`, `speaker-2`, …) — never real identities. Overlapping speech is
not separated, and segment boundaries remain external VAD boundaries. The
pinned ~28 MB CAM++ model is only downloaded after explicit consent; missing
runtime/model is reported honestly. Page results with `analysis.get
{view:"events", series:"speakerDiarization.segments"}`. See
[Speaker diarization and separation](AUDIO-SEPARATION-DIARIZATION.md).

### Sync offset between two media

`media.analyze_start` with `analysisTypes: ["syncOffset"]` correlates the
analyzed media range against an explicit reference media from the same
project, using local FFmpeg PCM decoding and a GCC-PHAT kernel (no model). The
required tuning is
`syncOffsetParams {referenceMediaId, referenceStartSec, searchRangeSec, windowSec}`
(defaults 0 s, 2 s, 30 s). The reference range starts at `referenceStartSec`
and spans the same duration as the target range; it is resolved inside the
configured media roots and must exist in the media library.

`offsetSec`/`offsetMs` are measured in source seconds and follow one locked
sign convention: **positive means the target is later than the reference
(target lags reference), negative means the target leads**. The raw GCC lag has
the opposite sign; the implementation and tests pin the public contract. A
result is only reported as `verdict: "ok"` when the correlation peak stands at
least 6 dB above the median |correlation| and the best competing local peak
outside a ±50 ms guard is at least 3 dB below the main peak; otherwise the
verdict is `ambiguous` or `no-match`. Prominence and margin are correlation
statistics, not a calibrated confidence score.

Ranges are split into windows (10–60 s, at least 4 × the search range, at most
12 windows). Three or more usable windows are linearly regressed; a strong
monotonic trend is reported as `verdict: "clock-drift"` with `driftPpm`,
`rSquared` and per-window offsets. Version 1 reports drift but never silently
corrects it, and `fixedOffsetSupported` is false. Silent windows are disclosed
and skipped, a short decode is marked `truncated`, and a reference file that
changes during the run fails the job instead of publishing a stale
measurement. The analysis reads only the first audio stream (`0:a:0`) of each
media and never moves clips, gain, markers or project revision; acting on the
measured offset remains an explicit `edit.apply` decision.

### Reading durable analysis records

`analysis.get {recordId}` defaults to `view: "summary"`. It returns the
record's metadata, provenance, unknowns, recheck configuration and staleness,
plus per-series `totalCount`, `storedCount` and `complete` in `details`. Dense
audio onset, silence and beat arrays and waveform bins are omitted from the
summary. New schema-version 3 records persist the full audio event arrays
before publishing a successful job. Other observation facts keep their
existing shape. The desktop's internal `analysisRecords.get` IPC deliberately
continues to load full records; Agent callers that previously depended on
default audio arrays must switch to the explicit views below.

Request one event series at a time. Windows use original source seconds and
the half-open interval `[startSec, endSec)`. Point events are included when
their timestamp is in that interval; an interval event is included when it
intersects the window, with its original start/end boundaries and stable ID
preserved. Repeated interval IDs across adjacent windows identify the same
event; deduplicate by ID when combining windows. Pages are ordered by source
timestamp, with original storage order breaking ties, and contain at most 256
events (default 100). Omitted boundaries default to the record's analyzed
range; requested windows must lie within it. Supported series are
`audioSummary.onsets`, `audioSummary.silence`, `silence.silentRegions`,
`beatGrid.beats` and `speechActivity.speechRegions`:

```json
{
  "recordId": "analysis-…",
  "view": "events",
  "series": "silence.silentRegions",
  "startSec": 10,
  "endSec": 20,
  "limit": 100
}
```

Continue with the returned `nextCursor`, keeping `recordId`, `series`, window
and `limit` unchanged. The cursor is tied to that query. `storedMatched` is the
number of matching events present in the record. `totalMatched` is the true
matching count when the record has complete event details; it is null when
historical truncation means the full count cannot be recovered. `complete`
also discloses whether the event series is complete.

Waveform bins are returned only when explicitly requested. The request window
is also half-open and `maxPoints` is capped at 600 (default 150). Points retain
the source boundaries of intersecting stored bins, which can extend outside
the requested window. Aggregation uses duration-weighted RMS and the maximum
peak. More requested points cannot improve the stored waveform resolution:

```json
{
  "recordId": "analysis-…",
  "view": "waveform",
  "startSec": 10,
  "endSec": 20,
  "maxPoints": 300
}
```

Records saved before the full-event storage change remain readable. Their
`storedCount` reports what is actually present; when earlier truncation or a
missing historical count prevents a complete answer, `complete` is false and
the unknown total is null. No missing event details are reconstructed from a
count.
Historical scalar measurements remain as saved; a truncated legacy silence
total may describe only its old preview. Re-run the analysis for verified full
totals and recoverable complete details.

Loudness values may be null when the signal is silent or unmeasurable. Waveform
peaks come from an 8 kHz stereo analysis mix and are not original-stream true
peaks. Onset confidence describes interval consistency; it is not calibrated
perceptual confidence. Tempo may have half- or double-time ambiguity.

## Interpretation

Inspection frames are sparse samples and do not prove continuous motion,
editing rhythm, or what a person heard. Audio measurements are anchors for
review, not semantic speech detection or automatic edit decisions. The explicit
`beatGrid` analysis returns inferred beats/BPM, not detected downbeats. The
explicit `speechActivity` analysis returns Silero speech-probability regions,
not transcribed words or speaker identity. For cloud video
review, see [Cloud video review](CLOUD-VIDEO-REVIEW.md).

## Scope and follow-up work

`silence` is amplitude-based detection, not VAD; `speechActivity` is the local
Silero VAD view of speech presence. Audio analysis reports evidence and never
edits on its own. Speech-driven music ducking is now available as an explicit
edit: `edit.apply` with op `clip.setDuckingFromAnalysis` consumes a
`speechActivity` record id, maps its source-second regions through the speech
clip's placement/trim and shared core timing (speed curves, reverse playback
and freeze holds) onto the ducked clip, and applies the same envelope the GUI
ducking panel uses (one batch, one undo unit). Stale records, wrong-media or
wrong-audio-stream records and no-overlap placements are rejected; an existing
volume envelope requires `existingEnvelope:"replace"`. Analysis-record-driven
silence cutting is likewise an explicit edit: `edit.apply` with op
`clip.cutSilenceFromAnalysis` consumes a `silence` record id and expands into
the same split/ripple actions the GUI silence-cut panel emits (one batch, one
undo unit). Regions shorter than `minSilenceSec` stay as kept pauses,
`paddingSec` keeps extra audio on both cut edges, and `fadeSec` (default
0.01 s, audio-gain only) protects cut points against clicks. Aligned
timing-identical A/V siblings of the same media are cut together so picture
and sound stay in sync; ripple shifts later clips on each affected track
only. Speed curves, freeze frames, non-zero `audioTrackIndex`, aligned
siblings with divergent timing, subtitle cues that would desync and batches
above `maxCutRegions` (default 24) are rejected before any mutation. Beat-
snapped cut points are an explicit edit too: `edit.apply` with op
`clip.splitAtBeat` takes a desired cut point plus an explicit `maxShiftSec`,
snaps to the nearest `beatGrid` beat strictly inside the clip's trimmed source
span (mapped through the clip timing, earlier timeline beat on a tie), and
applies as a plain `clip.split` (one batch, one undo unit). A request with no
candidate beat within `maxShiftSec` is rejected — never an unsnapped cut.
Beats are grid-model beats, not downbeats: no downbeat detector is
installed, the core engine's internal every-4th-beat heuristic is a
periodicity assumption deliberately not reported, and the record's BPM may
be half or double the true tempo. New
transcription/model backends remain planned. See the
[completed audio backlog](archive/AUDIO-BACKLOG-COMPLETE.md) for priorities and acceptance criteria, and the
[completed execution record](archive/AUDIO-PIPELINE-EXECUTION-RECORD.md) for A–C and
AUD-01/AUD-02 evidence.
