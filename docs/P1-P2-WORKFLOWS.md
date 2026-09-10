# Reference comparison, media replacement and traceable analysis (P1/P2)

How the three field-report workflows map onto the product after this change.
Color policy is documented separately in [COLOR.md](COLOR.md).

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
  audioSummary), `static-sampling` (frame/contact-sheet inspections),
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
