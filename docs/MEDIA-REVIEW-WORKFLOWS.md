# Media review and replacement

This guide describes reference comparison, media replacement, and traceable
analysis. Color handling is documented in [COLOR.md](COLOR.md).

## Frame-exact repair loop (scene candidates → extract → patch → compare → adopt)

The M1 frame-exact tools cover the recurring manual repair loop — locate a
frame range, inspect it, patch a region, verify, then adopt through the
NORMAL undoable edit path. All four verbs are read-only candidate producers:
they never touch the timeline, and every result lands under the session's
`artifactRoot` with per-artifact hashes. Adoption always flows through
`edit.validate` / `edit.apply` / `media.replace`, so the GUI and CLI keep one
state, revision checks, and undo history.

Coordinates: frame numbers are **zero-based decode/presentation indices** of
the source file; ranges are half-open `[startFrame, endFrame)`. Extraction
selects on those indices directly (never `seconds × nominal rate`), and every
returned frame carries its real PTS from `showinfo`. Seconds↔frame
conversion is claimed only when the stream's frame timing was **verified
CFR** (sampled PTS agree with the header rates); VFR sources get real PTS
values and honest nulls instead of guessed indices.

1. **Locate candidates** — `media.analyze_start` with the local analysis
   types (job system, cancellation, durable records, recheck):
   - `sceneCuts`: FFmpeg select scene score — inter-frame SAD over the LUMA
     plane only (libavfilter `ff_scene_sad`; a plain pixel-difference
     detector, NOT PySceneDetect HSV-Content) → boundary candidates with
     `{frameIndex, ptsTimeSec, score}`; each candidate's frame IS the
     representative frame (the new shot's first frame).
   - `blackFrames`: `blackdetect` luma ranges → candidates; intentional dark
     scenes are NOT failures.
   - `duplicateFrames`: `freezedetect` ranges → FROZEN/near-static INTERVAL
     candidates (consecutive near-identical frames only — this is NOT
     arbitrary duplicate-frame retrieval); intentional freeze frames and
     static graphics repeat legitimately.
   All three report `parameters` + `limitations` and never auto-edit.
   `technicalQuality` now also carries `frames` (decoded/header frame count,
   time base, CFR/VFR verdict) when local ffprobe is available.
2. **Extract** — `frames.extract {source: {mediaId} | {path}, selection:
   {frames: [...]} | {startFrame, endFrame}}` → lossless PNGs named
   `f<frame:06d>.png` plus a per-frame `{frame, ptsTimeSec, artifact}`
   mapping. ≤600 frames per call; paths with spaces/Chinese characters are
   ordinary argv values.
3. **Contact sheet** — `frames.contact_sheet {frames: [{path, frame?,
   label?}], columns, cellWidth, roi?}` → one grid PNG with a black label
   strip BELOW each cell (labels never cover content), no stretching, and a
   `cells[]` position mapping. Without a usable system font the sheet omits
   text labels and says so.
4. **Patch** — `patch.apply {source, range: {startFrame, endFrame,
   frames?}, patch: {path, x, y, width, height}}` with a FULL-FRAME patch
   PNG and an integer-pixel rectangle mask in the source raster → candidate
   frame sequence + `manifest.json` (per-frame status/sha256). Untouched
   frames are byte-identical copies; every patched frame is pixel-VERIFIED
   so everything outside the mask is unchanged, and the whole call fails
   (listing the failing frames) if that contract breaks. Frame count and
   order are preserved.
5. **Compare** — `video.compare {reference, candidate, positions:
   [{referenceFrame, candidateFrame}], layout, roi?}` compares the ORIGINAL
   SOURCE FILES at explicit indices (use `preview.render_comparison` for
   timeline renders): side-by-side / overlay / difference composites plus
   ROI-restricted `meanAbsDiff` / `changedPixelsRatio` (same semantics as
   `verify.artifact`). Metrics are alignment evidence, never a naturalness
   verdict; audio is out of scope.
6. **Adopt** — assemble the accepted candidate into a new production file,
   then `media.replace {mediaId, filePath, scope}` (or `edit.apply`) as ONE
   undo unit; `history.control undo` reverts it. Nothing is adopted
   implicitly by steps 1–5.

Dependencies: the tools need local `ffmpeg` + `ffprobe` (PATH, or
`REELTERMINAL_FFMPEG_PATH` / `REELTERMINAL_FFPROBE_PATH`). Missing binaries
fail `UNSUPPORTED` with the concrete reason, and `capabilities.get` reports
the same under `frameTools` (ffmpeg preflight, label font, per-call limits).

## Image alignment and region motion tracking (optimization plan M2)

`image.align` and `motion.track` are read-only candidate producers backed by
a **probed local OpenCV interpreter** — Python is resolved from
`REELTERMINAL_OPENCV_PYTHON` / `REELTERMINAL_PYTHON_PATH` or PATH
(`python3`/`python`) and accepted only when it can import `cv2` + `numpy`.
Nothing is ever downloaded or auto-installed, no interpreter path is
hardcoded, and absence is honest: the verbs fail `UNSUPPORTED` and
`capabilities.get` reports the same under `motionTools.opencv`.

**`image.align`** estimates how one PNG still must be transformed to sit on
another:

```bash
reelctl image align --file align.json
# align.json:
# { "reference": {"path": "C:/w/ref.png"}, "moving": {"path": "C:/w/mov.png"},
#   "transform": "translation" | "similarity" | "affine",
#   "stableRegion": {"x":0,"y":0,"width":150,"height":240} }
```

- `translation` runs ECC (mask-supported, sub-pixel); `similarity` and
  `affine` run ORB feature matching + RANSAC
  (`estimateAffinePartial2D` / `estimateAffine2D`). No free-form deformation
  is fitted.
- Output: the homogeneous **moving→reference** matrix (row-major 3×3, the
  direction `warpAffine(moving, M)` needs), the aligned candidate PNG, its
  **valid-coverage polygon** (black fill outside the warped image is
  excluded), a grayscale residual computed only inside
  `validCoverage ∩ stableRegion`, and **method-specific scores** — the ECC
  correlation coefficient vs ORB inlier count/RMSE/RANSAC ratio. These are
  different measurements, never a unified confidence.
- Both rasters must match exactly (≤4096px). Low texture, too few features,
  no overlap and failed estimation return `status: "failed"` with a
  `reasonCode` — never an identity matrix, never a guessed result.

**`motion.track`** follows a user-drawn region through an explicit
source-frame range:

```bash
reelctl motion track --file track.json
# track.json:
# { "source": {"mediaId": "m1"}, "range": {"startFrame": 10, "endFrame": 42},
#   "region": {"x": 14, "y": 54, "width": 60, "height": 60},
#   "options": {"maxForwardBackwardError": 2, "minInliers": 4, "overlayCount": 12} }
```

- Algorithm: corner seeds (`goodFeaturesToTrack` inside the region) → LK
  sparse optical flow with forward–backward checking → RANSAC similarity
  estimation. Points that fail drop out and are never re-seeded, so drift
  stays visible in `trackedPointCount` / `inlierRmsePx`.
- Frames are extracted by the M1 frame-exact core: zero-based decode indices
  with the **real PTS per frame** (`frameMapping`), exact for VFR sources.
  Tracking is defined for source-native playback only; timeline speed /
  reverse mappings are the caller's job and are deliberately not guessed.
- Failure is a first-class result: the first frame whose forward–backward
  check or RANSAC fit collapses ends the run with `lostAtFrame` +
  `terminationReasonCode` (`forward_backward_error`,
  `insufficient_inliers`, `region_out_of_bounds`, …), and every later frame
  is `not_tracked` with a null matrix. The tracker **never glides across a
  cut** and never re-seeds to keep the numbers looking alive.
- Outputs: per-frame cumulative region transform (row-major 3×3, start-frame
  region → this frame), per-frame error statistics, trajectory overlay PNGs
  + a review contact sheet, and `manifest.json` under the artifact root.
  At most 240 frames per call. No timeline keyframes are written and the
  GUI's motion engine state is untouched; nothing about physical
  plausibility or action naturalness is claimed — success means a
  trustworthy report, not automatic repair.

## Reference comparison (sync compare against a reference)

One shared configuration lives on the canonical project
(`project.referenceComparison`); the GUI panel and the Agent verbs read and
write the SAME state through the same undoable core actions
(`reference/setComparison`, `reference/clearComparison`).

```jsonc
// edit.apply
{ "op": "reference.setComparison", "config": {
  "referenceMediaId": "<media id in the project>",
  "refStartSec": 0.5,          // reference in-point
  "refEndSec": 20,             // clamping boundary
  "timelineStartSec": 0,       // timeline time aligned to refStartSec
  "rate": 1,                   // v1: exactly 1 (constant rate + offset)
  "audioSide": "timeline",     // timeline | reference | none — never both
  "layout": "side-by-side"     // or "overlay" (+ overlayOpacity 0..1)
}}
```

- **Mapping**: `referenceSec(t) = refStartSec + (timelineSec - timelineStartSec)`.
  Rates ≠ 1 are rejected at validation time, not approximated. Beyond
  `refEndSec` the reference side clamps onto its nearest frame and every
  result says so (`clamped: "after"`, plus a limitation note).
- **Inspection still**: `preview.render_comparison {timeSec, width?, height?,
  layout?, maxFrameBytes?}` → left cell the decoded reference frame at the
  MAPPED time, right cell the canonical timeline render (the same renderer as
  `preview.render_frame`), letterboxed to preserve aspect — never cropped.
  The reference decode is matrix-aware ([COLOR.md](COLOR.md)).
- **Comparison export**: `export.start {comparison: {startSec, endSec}}` →
  one canonical timeline render (the ordinary export pipeline), then one
  ffmpeg compose pass with the reference for the mapped range. Side-by-side
  cells are each at the full export raster; audio comes from exactly ONE
  side (`config.audioSide`); output tagged per the color policy. The job
  reports `route: "comparison-compose"`.
- **GUI**: the preview's "Reference comparison" panel mirrors the shared
  config: synced transport (play/pause/±1 frame drive the canonical
  playhead), aspect-preserving reference video, layout/audio-side switches
  that go through the same undoable actions, and a live mapping readout.

## Media version replacement and relink (two different operations)

- `media.replace {mediaId, filePath, scope: "project"|"clip", clipId?}` —
  swap in a NEW production version. The new file imports as its own media
  item (the old file is never overwritten; both versions coexist), every
  clip in scope keeps startTime/duration/in-out/transform/keyframes/fades,
  and the clip records `metadata.supersedesMediaId` lineage. Timing clamps
  to the new source's duration — the timeline can only shrink, never extend;
  a clip whose `inPoint` is beyond the new duration fails the whole batch
  with an explicit error. One `edit.apply` batch = one atomic undo unit.
- `media.relink {mediaId, filePath}` — the SAME content at a new location
  (missing/moved file). Only the file reference changes; ids and timing are
  untouched. Deliberately not a version swap.

Project media stores `versionSource` separately from `materialSource` (an
actual library attachment). The material library reconciles current/historical
usages and unambiguous replacement links after project edits, undo/redo and
recovery. It retains history without treating the new version as the old
library entry. This is a derived, retryable library update, not a transaction
spanning both databases; see [MATERIAL-LIBRARY.md](MATERIAL-LIBRARY.md).

Before replacing, use `edit.validate` with the same operations and revision.
Its `REPLACEMENT_IMPACT` / `REPLACEMENT_SHORTENS_CLIPS` warning includes every
changed clip's old/new source and duration, shortening amount, and vacated
timeline range (which may be covered by other layers). Constant-speed clips
shorten in timeline seconds accounting for their playback rate. Shortening a
speed-ramped or freeze-frame clip requires an explicit trim first; it is
rejected instead of silently changing its time mapping. Live replacements
persist new media bytes before the single canonical batch commit. Replayed
requests use caller parameters, independent of generated media IDs.

## Traceable, re-checkable analysis records

Every `media.analyze_start` completion now persists a durable record under
`<artifactRoot>/analysis-records/<id>.json` and links it from the job
summary (`analysisRecord: {id, recordPath, recheckOf}`):

- **Provenance per source**: `local-measurement` (technicalQuality,
  audioSummary, sceneCuts, blackFrames, duplicateFrames),
  `static-sampling` (frame/contact-sheet inspections),
  `cloud-opinion` (provider + model text stored verbatim AS DATA — never
  executed, never a verdict).
- **Separation**: `observations` (measured facts), `inferences` (analyzer
  conclusions), `recommendations` (proposals) never blend; there is no
  "pass" concept anywhere in the schema.
- **Honest unknowns**: e.g. `videoReview.serverSamplingFps` is stored as an
  explicit `unknowns` entry with the reason — confidences are never invented.
- **Staleness**: reads re-stat the source file against the recorded
  fingerprint (`current` / `source-changed` / `source-missing`), so a
  regenerated source can't masquerade as analyzed.
- **Recheck**: pass `recheckOfRecordId` to `media.analyze_start`; the new
  record links back, and `analysis.list {mediaId}` shows the before/after
  chain (newest first).

Query verbs (read-only, both headless and live): `analysis.list
{mediaId?, limit?}` and `analysis.get {recordId}`. Cloud upload consent is
unchanged: `videoReview` still requires the explicit `cloudUpload: true`
after user authorization; local analysis types never upload anything.

The desktop collaboration bar's **Analysis** entry lists records for the open
project and keeps observations, inferences, recommendations, unknowns, and
cloud opinion visibly separate. Timestamped local evidence can seek to a
constant-speed occurrence on the timeline or loop the analyzed range; ranges
that are absent from the timeline or use variable-speed/freeze mapping are
reported as unavailable rather than approximated. Current/source-changed/
source-missing state is checked when the panel reads each record.

The same panel can run a linked same-configuration recheck while Agent Session
is enabled. Local rechecks omit all cloud fields. A record containing
`videoReview` requires a new, unchecked-by-default upload authorization for
each run; the earlier review's authorization is never reused. Provider status
and prose remain labeled **Cloud opinion · not a pass**.
