# Material inspection and audio analysis

ReelTerminal provides read-only inspection of imported media and local audio
measurements. These tools report evidence; they do not infer semantic intent
or apply edits.

## Source inspection

`media_import_preflight {path}` checks that a file is inside the allowed media
roots and can be read. A successful preflight does not guarantee codec support.
Live GUI imports are limited to 256 MiB.

`media_inspect` samples up to 12 source timestamps. It accepts a source range,
explicit timestamps or a sample count, and an optional normalized region of
interest. Results include frame artifacts, source coordinates, and the current
timeline mapping when a clip uses that media. The configured byte budget may
deliver a compressed or smaller image; inspect each artifact's `fidelity`
metadata before using it as evidence.

## Audio summary

`media_analyze_start` with `analysisTypes: ["audioSummary"]` runs locally with
FFmpeg and ffprobe. It reports stream facts, integrated loudness, true peak,
loudness range, bounded waveform levels, silence intervals, and onset
candidates. It does not upload audio or modify the project.

Source ranges are limited to 120 seconds. At most two analysis jobs run per
session, with four local audio subprocesses per process. Each process has a
60-second deadline and a 16 MiB combined output limit. Missing FFmpeg or ffprobe
is reported through capabilities and job results.

Loudness values may be null when the signal is silent or unmeasurable. Waveform
peaks come from an 8 kHz stereo analysis mix and are not original-stream true
peaks. Onset confidence describes interval consistency; it is not calibrated
perceptual confidence. Tempo may have half- or double-time ambiguity.

## Interpretation

Inspection frames are sparse samples and do not prove continuous motion,
editing rhythm, or what a person heard. Audio measurements are anchors for
review, not automatic beat grids or edit recommendations. For cloud video
review, see [Cloud video review](CLOUD-VIDEO-REVIEW.md).
