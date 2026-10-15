# Follow-up verification of history boundaries

This follow-up corrects the evidence level of the limits in
`template-redo-branch-2026-10-15.md`. At the end of the original patch, these
limits were source-audit leads, not reproduced defects. The experiments below
were run afterward against current source `62163425` on Windows x64. No product
source, published tag, release asset, user profile or user project was changed.
All test media was synthesized in an isolated OS temporary directory.

## Evidence and patch-scope decisions

| Boundary | Evidence now obtained | Impact observed | Scope recommendation |
| --- | --- | --- | --- |
| Assets rail Project Templates replacement | Real GUI plus actual React component, TemplateEngine and store | Old redo adds/removes content in the new project; undo restores old-template content into the new project | Include in 1.2.1; the original stale-redo fix is insufficient here |
| 3D setters after recipe-update undo | Real store/executor/engines; GUI calling controls inspected, not driven | Recipe redo overwrites the newly edited overlay's 3D values | Include in the redo-invalidation patch |
| Equal-millisecond undo ordering | Real store with controlled clock | Undo reverts an earlier transform while the newer recipe remains applied | Confirmed boundary defect; fix ordering explicitly or disclose before acceptance |
| Auto-grouping across a recipe | Real store with controlled 1000/1040/1080 ms times | One undo reverts both transforms on opposite sides of the recipe, which remains applied | Confirmed grouping defect; add a recipe boundary without changing normal proximity grouping |
| Overlay-engine restoration exception | Single injected throw in real GraphicsEngine.createShape | Canonical project/history remain unchanged while engine contents differ | Fault-handling consequence confirmed; normal-operation trigger not established, so track separately |

These evidence tests assert the observed faulty behavior. Their passing results
confirm reproduction and must not be presented as successful repair regressions.

## Whole-project replacement: actual GUI sequence

Affected entrance: Assets rail **Project Templates**, rendering `TemplatesTab`.
This entrance calls `TemplateEngine.applyTemplate` and directly assigns `project`
through `useProjectStore.setState`. It is distinct from the inspector/welcome
template entrances that call `loadProject`.

The isolated GUI used real mouse/keyboard/dialog interaction throughout. The
external Agent connection only read project/history state.

1. Import generated video, add it to the timeline, add Audio 1, then Undo.
   Revision 4 has no audio track and one redo entry.
2. Open Project Templates and cancel the YouTube Intro replacement confirmation.
   Full observed content and history remain unchanged, including revision 4.
3. Confirm YouTube Intro replacement. Revision 5 has the new template, but still
   has the old Add audio redo entry.
4. Redo adds Audio 1 into the new project at revision 6. Undo removes Audio 1 at
   revision 7. Neither operation restores the old source video/project.
5. In the YouTube Intro project, right-click Channel Name and Delete Track;
   then Undo. A `track/remove` redo entry remains.
6. Confirm replacement with TikTok Promo. Revision 10 contains its CTA Text
   track (`track-text-1`) and CTA clip (`clip-cta`), but retains that redo entry.
7. Redo produces revision 11: the TikTok project ID remains unchanged, while the
   CTA Text track and CTA clip are removed.
8. Undo produces revision 12: still in the TikTok project, the old Channel Name
   track and `clip-channel-name` return; the TikTok CTA does not return.

The ID overlap is real built-in template data, not an injected collision.
This proves canonical engineering content changes incorrectly, not merely an
incorrect button state. Persistence after autosave/save/reopen was not tested.
No source media file was modified by these history operations.

The React component/store probe independently reproduces old audio insertion,
old track-name undo affecting a replacement template, and CTA deletion. A control
using the actual `loadProject` replacement contract clears both history systems
and the redo journal; redo then fails without inserting old content. That is a
store-level control, not a claim that all alternate GUI entrances were tested.

The minimal direction is to use the existing whole-project replacement boundary,
including its history reset, rather than carrying the old project's undo/redo
forward. Under that existing contract the template replacement itself is not an
undoable edit. Making whole-project replacement undoable would be additional
product behavior and is not part of this investigation.

## 3D edits: successful new content overwritten by stale redo

Real-store sequence: apply Lower Third; update its name/role; Undo that update;
modify a recipe text overlay using `updateClipRotate3D`, `updateClipPerspective`
or `updateClipTransformStyle`; then Redo.

Each setter succeeds, writes the new transform value, and leaves redo available.
Redo succeeds and restores the recipe update snapshot, discarding the newly
edited 3D value. All three setters reproduce this. The GUI controls call these
setters from `Transform3DSection`; a text preset also calls rotate3D. Those
controls were inspected in source but not driven in this follow-up GUI test.

Control: after Undo of Add audio, a timeline clip's 3D change also leaves old redo
available, but Add audio redo preserves that transform. The content-loss effect
depends on whether the redone snapshot includes the newly edited object/field.
Clearing redo at these successful setters fits the existing repair; making the
3D edit itself undoable is a separate pre-existing contract issue.

## Ordering/grouping and injected failure

- Same millisecond: transform x `0.5 -> 0.25`, then apply recipe at the same
  timestamp. Undo yields x `0.5` with the recipe still applied. It should not
  choose the older action merely because timestamps tie. Changing `>` to `>=`
  would break the opposite same-millisecond order and is not an adequate repair.
- Across a recipe: transform at 1000 ms sets x `0.25`, recipe at 1040 ms, transform
  at 1080 ms sets x `0.75`. The two actions share an auto-group. Undo yields x
  `0.5`, not the pre-last-action value `0.25`; recipe remains. Redo restores
  `0.75`. Without a recipe, proximity grouping of these transforms is normal.
  No naturally occurring GUI timing reproduction was claimed.
- Restoration: one injected `GraphicsEngine.createShape` exception during recipe
  update/undo/redo leaves canonical project/history uncommitted, but the real
  engines have already removed or partly recreated overlays. Shape count can be
  canonical 1 versus engine 0, and engine text can differ from canonical text.
  This establishes a failure consequence, not the likelihood or normal trigger.

## Versions and repeatability

The affected template UI/engine and track executor/inverse paths are unchanged
from v1.2.0 (`3a5a47a8245ba5cf2187b892b71e458e7bd7d250`). The template component
and ordering probes were run against both current source and that published
source, temporarily loading the four history-related files changed by the prior
patch and restoring the working files byte-for-byte in `finally`. Both runs
confirm the same behavior (eight evidence/control cases). The direct 3D setters
and restoration selection code also match the published source; those probes
were run on current source only. The GUI run used the current built renderer;
no released binary was executed.

Evidence sources:

- `apps/web/src/components/editor/panels/TemplatesTab.history-evidence.test.tsx`
  (five evidence/control cases).
- `apps/web/src/stores/project-history-order-evidence.test.ts` (three cases).
- `apps/web/src/stores/project-history-boundary-evidence.test.ts` (nine cases:
  three recipe-overwrite, three unrelated-action controls, three injected faults).
- `apps/desktop/e2e/whole-template-history.e2e.ts` (one isolated GUI scenario).

The GUI's raw state records and screenshots remain in gitignored test artifacts.
Investigation tests/documentation are left for review; no additional repair,
commit, push, packaging or publication was performed in this follow-up.

## Subsequent repair

The investigation above is retained as the pre-repair record. The follow-up
[repair contract and validation](history-boundary-fix-2026-10-15.md) converts the
normal-operation probes to correct-behavior regressions. Injected engine restoration
failures remain separately tracked. Refer to that document for the implemented
scope, commands, actual evidence boundaries and proposed AGENTS.md guidance.
