# Production management (M3)

Implemented 2026-10-04 on the existing project, edit history, requirement board,
comparison panel and local analysis jobs. No model is installed or run implicitly.

## Source history and candidate versions

Right-click a project media card → **Production and candidates**. Record status,
notes and actual operations, tools/models and input media versions. An optional
zero-based, half-open **source** frame range applies each operation to only that
segment. Multiple steps can describe a mixed source. Unrecorded media remain
unknown; they are not classified as originals automatically.

The asset panel filters by operation or candidate status. CLI/MCP read exactly
the same project metadata:

```json
{"command":"media.production_list","params":{"operation":"generation","status":"pending"}}
```

Save the params object to a JSON file and call
`reelctl call <command> --file request.json` (or pass it through `--stdin`).
Discover exact transport options with `reelctl help`.
`reelctl schema edit.apply` includes the new operation:

```json
{
  "expectedRevision": 12,
  "ops": [{
    "op": "media.setProduction",
    "mediaId": "candidate-id",
    "production": {
      "status": "pending",
      "notes": "Review frames 20–35 before adoption",
      "steps": [{
        "operation": "modelEnhancement",
        "tool": "explicit external backend",
        "model": "actual model name/version",
        "inputMediaIds": ["previous-version-id"],
        "range": {"startFrame": 0, "endFrame": 60}
      }]
    }
  }]
}
```

Operations: `original`, `generation`, `redraw`, `composite`, `resize`,
`modelEnhancement`. Enhancement requires a model name. Records are creator
declarations, not execution attestations. Selecting `adopted` in this metadata
editor does not switch any timeline references. Records persist in the project
and use the normal undo/redo history. Invalid records are rejected at action and
project-import boundaries.

`media.replace` retains old media/files and its existing `versionSource` lineage.
`media.production_list` returns this lineage and actual clip usage alongside the
declared status. A rejected version is retained for comparison or later reuse.

## Review → board → candidate → adoption

The preview toolbar's **Create review task** accepts a title and a zero-based,
half-open **timeline** frame range. It independently renders the selected start frame through the desktop render
backend, regardless of the current playhead or pending preview draw. The task
stores that timeline frame number, exact requested time, source project revision,
artifact path, reference configuration, media version IDs and timeline/source-second
mappings. A project change during rendering rejects task creation. The image is a
scaled timeline render; use `frames.extract` for native source pixels. Legacy tasks
without evidence metadata retain their original, unbound preview screenshots. Source seconds are not converted to frame
indices using a nominal media frame rate.

Forward constant-speed clips are supported. Reverse, speed-ramp and freeze-frame
mapping are rejected instead of guessed. Tasks can describe mixed clips, but
direct candidate adoption requires one source version. Submit candidates through
the existing `requirement.update` operation's `resultMediaIds` and `status: review`.

The board shows the saved range/image, locates the range and opens a candidate
comparison. **Adopt full-source candidate (undoable)** repoints the reviewed clips,
marks the candidate adopted and marks the task done in one atomic history group.
It requires imported file-backed full-source videos. Before mutation, the same
FFprobe helper as CLI strict replacement checks equal decoded frame counts and
verified CFR rates. Changed files or project revisions are rejected. It preserves
all clip timing and other edits, retains the old media, and refuses changed source
mappings. A crop-only/short segment is not a full-source replacement. Use the
existing edit/trim workflow explicitly for such candidates. Comparison of mixed
ranges remains a manual configuration task.

GUI adoption always performs strict verification; there is no duration-only
fallback. Missing desktop/FFprobe support or unsupported timing produces a visible
error without repointing clips. Verified frame duration avoids rounded container
duration tail errors. CLI callers opt into the same check with `preserveFrames`.

## Persistent local analysis batches

`batch.start`, `batch.get`, `batch.resume` wrap the existing
`media.analyze_start` jobs; this is not a new workflow engine. Supported types:
`technicalQuality`, `sceneCuts`, `blackFrames`, `duplicateFrames`. There is no
cloud submission, model execution or automatic timeline backfill.

```json
{
  "batchId": "opening-review-1",
  "mediaIds": ["media-a", "media-b"],
  "analysisTypes": ["technicalQuality", "blackFrames"],
  "expectedRevision": 12
}
```

Pass this to `batch.start`. IDs are unique and existing manifests are never
overwritten by start. At most 20 distinct media IDs are accepted. Use
`media.production_list` to select a specific source class first.

Each manifest under `<artifactRoot>/production-batches/<batchId>.json` stores
project identity/revision/modification time, per-item inputs/parameters, job IDs,
states, errors and results. Job state transitions synchronously flush a temporary
manifest and atomically replace the prior file before publishing the new state.
`batch.get {"batchId":"opening-review-1"}` reads the latest record; it is not
required for persistence. Individual jobs retain `job.status` and `job.cancel`.
Storage failures produce `BATCH_PERSISTENCE_FAILED` and never expose false success.
Small manifest reads also close synchronously, preventing an in-flight Windows
read handle from racing with automatic atomic replacement.

After interruption call `batch.resume` with the same ID. Durably completed items
and still-running jobs are skipped. Unfinished/cancelled items can restart;
failed items restart only when named in `retryMediaIds`. The project identity,
modification time must still match. If reopening resets the session revision,
pass the freshly read `expectedRevision` to resume; this does not bypass the
project identity/modification-time checks. A changed project requires a
new batch; backfill uses the existing identity/epoch/revision guards in
`edit.validate` / `edit.apply`.

**Persistence boundary:** completion, failure, cancellation and progress are saved
by job observers, including while no client is polling. After application exit,
completed items retain their result; unfinished items resume through the existing
recovery command. Observers release when a job becomes terminal. Batch controls
remain CLI/MCP commands; no separate GUI batch panel is added.

## Strict replacement

Set `preserveFrames: true` on the existing `media.replace` edit operation. Both
source and replacement must be contained, file-backed videos. The existing local
FFmpeg/FFprobe backend must report equal actual decoded frame counts and matching
verified CFR rates. Missing dependencies, VFR/unknown timing and incomplete
bounded scans fail explicitly. No nominal-rate duration arithmetic substitutes
for decoded counts. Equal-frame replacements preserve clip duration/in/out values
exactly, including harmless container-duration floating-point tail differences.

Without this flag, existing shorter-source clamping behavior is unchanged. Use
`edit.validate` first and the normal identity/epoch/revision guards for application.
No new runtime dependency was added: use the existing FFmpeg discovery/configuration.

## Text and enhancement disclosure

Titles and credits use existing text layers; subtitles use existing subtitle
layers. Text now rasterizes at the requested output resolution while keeping
layout, animation and style units in project coordinates. Subtitle layout scales
with the output too. Burned-in text receives no OCR or rewriting.

The export toggle explicitly says **Resampling and sharpening (no AI model)**.
It still uses the existing deterministic WebGPU resampler. Model enhancement is
an explicit external operation: filter sources, run the chosen backend outside
the editor, import candidates, record the actual tool/model, review and adopt.

## Validation

- Real FFprobe strict replacement of a contained file with a Chinese/space path.
- Shared production records, mixed-source filters, invalid input rejection,
  legacy undo and redo, project JSON persistence.
- Batch persistence/restart, no duplicate running jobs, explicit failure retry,
  changed-project refusal.
- Half-open review mapping, candidate adoption and undo, stale mapping refusal.
- Real Chromium pixel comparison: enlarged titles match target-size glyphs more
  closely than a scaled low-resolution text bitmap.
- Command/schema/output discovery tests, core/export tests, board/store tests,
  type checks, web production build and desktop main/CLI bundle build.

### Live acceptance, 2026-10-04

`pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts e2e/production-management.e2e.ts`

Passed against a visible, built Electron desktop in an isolated profile (46.24 s).
The test uses the real file-import UI, review form, comparison/adoption buttons,
GUI undo, reelctl and a persistent external MCP connector. It does not replace
FFprobe, rendering, job execution or project mutations with mocks.

- Imported a synthetic 60-frame red/blue source. With the playhead at 1.5 s (blue),
  selected timeline frame 15 (0.5 s, red). The persisted evidence reports frame 15,
  revision 6 and time 0.5 s; decoded pixels verify red.
- Rejected a 59-frame candidate without changing clip references or task status.
- Compared and adopted an equal-frame candidate, then undid the entire adoption
  from the GUI. Source timing, original reference and task review status returned.
- Started real local analysis of a short clip and a 180-second clip. Without any
  `batch.get` polling, the manifest recorded `done` and `cancelled`.
- Resumed the cancelled item, exited the application while it was running,
  reopened the saved project from Recent, and resumed again. The completed item
  retained its original job ID; only the unfinished item received a new job ID.
  Both completion results reached disk automatically.
- Saved review evidence survived reopening. A blocker found during this test was
  fixed: successful explicit saves now register new projects in Recent, making
  their persisted snapshot reachable from the desktop start screen.

Retained local evidence (outside the checkout):
`<temp-dir>/reelterminal-e2e-<run>/jobs/<date>-m3-live-<id>/`.
The `project/manifest.json` records assertions; `evidence/` contains selected-frame,
strict-rejection, adoption and reopened-project screenshots. This is a synthetic
acceptance project; the user's existing projects were not modified.
