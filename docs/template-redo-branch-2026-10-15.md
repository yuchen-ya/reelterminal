# Editing recipe redo branch invalidation

Verified on Windows x64, 2026-10-15, using independent real-store and isolated
Electron GUI reproductions. No user project, profile, endpoint or media was used.
Synthetic fixtures and raw local evidence are not committed.

## Finding and reachability

Both published v1.2.0 (`3a5a47a8245ba5cf2187b892b71e458e7bd7d250`) and the
pre-fix source are affected. `project-store.ts`, `project/history-slice.ts`,
the recipe UI and ActionHistory had no differences between that release commit
and the starting source. The isolated GUI baseline used a renderer built from
the unchanged recipe source, not an assumed preexisting build. Release binaries
were not run or modified.

This finding concerns clip-scoped editing recipes: RecipesTab calls synchronous
`applyEditingTemplate`; inspector controls call `updateEditingTemplateApplication`,
and recipe removal calls `removeEditingTemplateApplication`. These share the real
project store with ordinary action edits. Ordinary action undo and recipe undo
remain separate stacks, coordinated by timestamps and the redo journal.

The original implementation cleared only template redo on recipe apply/update,
leaving action redo and journal entries. Its redo fallback could replay an old
track-add after the new recipe edit. Ordinary overlay edits/media edits could also
leave an undone recipe available to replay after their new edits.

## Reproduction evidence

All writes in the GUI test use actual buttons or keyboard input. The external
Agent connection only reads `project_get_state` and `history_get`; no store
injection or Agent edit substitutes for a GUI gesture.

| GUI step | Baseline result | Fixed result |
| --- | --- | --- |
| Import synthesized video, add to timeline | Revision 2, two action history entries | Same |
| Add audio track | Revision 3, Audio 1 present | Same |
| Undo audio track | Revision 4, Audio 1 absent, redo count 1 | Same |
| Open/leave Recipes without Apply | Revision/history unchanged | Same |
| Apply Lower Third to selected clip | Revision 5, recipe applied, stale redo count 1 | Revision 5, recipe applied, redo count 0 |
| Actual redo keyboard shortcut | Revision 6, Audio 1 reappears | Revision stays 5, no audio track |
| Undo then redo the recipe | Existing store regression passed | GUI verifies recipe removed/restored; no audio resurrection |

The initial ten real-store cases against old source produced six failures and
four passes: stale action redo after recipe apply/update/remove, and stale
template journal entries after recipe update/remove or an ordinary action.
The initial reproduction explicitly called redo and observed the old audio track
return. Separate overlay-create/media-rename red tests then observed the undone
recipe actually return, including its two text overlays and one shape.
These are behavioral failures, not merely button-state checks.

The final dedicated store file passes 13 cases, covering initial and loaded
project histories, successful apply/update/remove, same-value update under the
existing edit convention, ordinary/recipe interleaving, recipe undo/redo, overlay
creation, media rename, failed recipe/action/update/remove, queue cancellation,
and existing empty-history no-op results. It checks project content, all redo
branches/journal, and preservation of valid undo. The core regression also
verifies that clearing redo releases discarded entries without discarding undo.

The recipe apply itself has no mid-apply cancellation API. Cancellation coverage
is the existing queued workspace mutation rejection before execution, plus GUI
browsing without applying. Invalid operations remain no-ops; same-value recipe
update remains a committed edit, as before this fix.

## Minimal repair and validation

`ActionHistory.clearRedo()` discards only redo and snapshots beyond the current
undo depth, using the existing eviction notification contract. A shared store
helper invalidates ordinary redo, template redo and the redo journal only at
validated new-edit commits. It obtains the current history instance, including
after create/load replaces it. Existing overlay and media commits receive the
same helper. No history selection algorithm or stack structure was merged or
rewritten; no new feature was added.

Passing commands:

```text
pnpm --filter @reelterminal/web exec vitest run src/stores/project-template-history.test.ts src/stores/project-store.test.ts src/stores/project/media-gc.test.ts src/stores/project-revision.test.ts src/stores/project/media-slice.replace.test.ts src/stores/project/media-slice.atomic.test.ts
pnpm --filter @reelterminal/core exec vitest run src/actions/action-history.test.ts
pnpm --filter @reelterminal/web typecheck
pnpm --filter @reelterminal/core typecheck
pnpm --filter @reelterminal/desktop build:renderer
pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts e2e/template-history.e2e.ts
```

The web group passes 143 tests; its four skips are existing subtitle tests whose
subtitles have been consolidated into text clips. Core history passes 19 tests.
The isolated GUI regression passes and includes valid recipe undo/redo after the
branch test. Renderer build/typechecks pass. No installer/package was produced.

## Limits

macOS/Linux GUI execution was not performed. This fixes redo invalidation at the
identified action/recipe commit paths, not every existing history behavior:

- Whole-project Project Templates uses a different replacement path. In
  `TemplatesTab`, it directly assigns a project instead of the other template
  entrances' `loadProject` history reset. Static inspection indicates it can
  retain prior project history; it was not GUI-reproduced or changed here.
- Existing setters that do not record ActionHistory, such as some 3D transform
  updates and source-file recovery, are outside these history commit paths.
  This patch does not establish redo invalidation for every direct project setter.
- Existing undo ordering uses millisecond timestamps; equal timestamps and rapid
  auto-groupable actions on both sides of a recipe are not guaranteed to express
  strict chronological ordering. Changing that contract needs separate work.
- Mid-restore overlay engine failures in recipe update/undo/redo were not injected.
  Static inspection suggests incomplete engine restoration is possible independently
  of the canonical history stacks. Tested failure cases preserve legitimate
  history, but do not establish recovery from those engine failures.

These bounds do not invalidate the reproduced stale-redo fix. They prevent a
claim that the two existing history systems are now universally transactional.
Together with the separately confirmed native export data-loss risk, a 1.2.1
patch release is recommended after platform acceptance. Tags and release assets
remain unchanged by this task.
