# Review workspace tabs acceptance — 2026-10-30

This change puts review tasks and private free boards in one ordered tab strip.
The open/manage dialog owns saved-task categories and private-board management;
closing a tab retains its entity. The former review/board surface switch and
outer task/board sidebars are removed. Internal review group/item navigation,
viewers, processing records and CLI activity remain in the selected task.

The address row copies the selected review task's exact `start --target` command.
A private board instead shows the private/no-Agent-target explanation. The image
review action “加入自由画板” creates a new private board tab containing that image.

## Independent GUI acceptance

Tests use the existing Electron harness, isolated profiles/endpoints, generated
fixtures and independent reelctl processes. No user application, project, media,
endpoint, package or installer is used.

| Spec | Verified behavior |
| --- | --- |
| `review-workspace-tabs.e2e.ts` | Mixed tabs, repeated-open focus, real pointer reordering, per-task item/search state, review close/reopen, target-bound clipboard commands, pending-board-save close/reopen, restored mixed order and active tab after relaunch, last-tab empty state, entities retained after close |
| `review-navigation.e2e.ts` | Task creation/cancel, category management and task assignment from the unified dialog, internal batch selection by pointer/keyboard |
| `cli-navigation.acceptance.e2e.ts` | Existing compact/local CLI discovery and light startup, explicit video/review target ownership, private board stays selected during CLI calls, stale runtime targets rejected |
| `review-update-continuity.e2e.ts` | Decoded image/view state through real CLI revisions, explicit decode failure, CLI activity isolation when switching tasks |
| `review-repair-draft.e2e.ts` | Real repair-draft preview pixels, one-version commit and durable replay |
| `free-board-documents.e2e.ts` | Native clipboard/URI input, Markdown source/assets/edit undo/relaunch, isolated native HTML/HTTP browser and real link navigation, modal tab locking, guest destruction/focus restoration, snapshots and white-background composite |
| `human-board-acceptance.e2e.ts` | Private mixed media and exported snapshots, last-tab close followed directly by native Ctrl+V without test focus assistance, pointer geometry, video/model interaction and frozen exports, transformed image/text PNG pixels |
| `review-task-menu.e2e.ts` | Pointer-operated right-click/dropdown management, trash cancellation, right task identity and confirmed purge |

Existing desktop E2E callers of the removed surface/sidebar UI now use
`harness/workspace-tabs.ts` for the unified directory/board entry. Content, CLI,
history and pixel assertions remain; obsolete sidebar width/collapse assertions
were removed. Full desktop E2E collection succeeds; only the selected real GUI
specs above were executed.

## Evidence and checks

The renderer is built with `pnpm --filter @reelterminal/desktop build:renderer`.
Selected specs run through `vitest run --config e2e/vitest.config.ts` serially.
The first GUI pass found a real regression: the task context menu was below the
unified dialog overlay and could not receive pointer input. Its local portal
layer was repaired before final validation.

The region-PNG fixture writes IndexedDB directly, outside UI save notifications.
It now reloads before reopening that fixture so the canvas receives its seeded
geometry; source-resolution, transformed pixels and white-background assertions
are unchanged.

Screenshots and JSON are retained in `apps/desktop/e2e/.artifacts/`:

- `review-workspace-tabs--review-address-command.png`: single tab strip and
  one-line command above the task's internal navigation.
- `review-workspace-tabs--mixed-tabs-private-board.png`: reordered review/board
  tabs, private explanation and full white canvas, with no former board list.
- `review-workspace-tabs--last-tab-empty.png`: no open entity after closing all
  tabs, with the unified open/new entry.
- `free-board-browser*.png` and `human-board-region*.png`: native browser,
  composite and pixel-export evidence.

The first two workspace screenshots and the region fixture's white canvas were visually inspected in addition to
programmatic assertions. The native OS drag-out test remains opt-in and was not
performed; synthetic drop tests do not claim OS file-receipt coverage. No package
or installer validation is claimed.

Final result: 13 selected GUI tests passed. The native OS drag-out case was
skipped because its explicit manual opt-in was not enabled. The repaired task
context menu and unchanged region-PNG pixel assertions both passed against the
final rebuilt renderer. There are no remaining failures in this selection.

The final rechecks were:

```powershell
pnpm --filter @reelterminal/desktop build:renderer
pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts e2e/review-task-menu.e2e.ts
pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts e2e/review-task-menu.e2e.ts e2e/human-board-acceptance.e2e.ts -t "acts on the right-clicked|region PNG"
```
