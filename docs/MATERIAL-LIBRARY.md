# User-level material library

The material library is a **user-level** collection of creative resources that
exists independently of any project: local media files, time ranges inside
media ("segments"), links, and reusable "skill + prompt" methods. It survives
project switches and app restarts, both the human UI and external Agents can
manage it, and projects only ever **reference** materials — they never own
them.

- Human entry point: the **Library** tab in the editor's left assets panel
  (plus "Save to material library" in a project media item's context menu).
- Agent entry point: `reelctl call material.<verb>` in a live desktop session
  (`material.list`, `material.get`, `material.create`, `material.update`,
  `material.batch_update`, `material.remove`, `material.attach`,
  `material.undo`). The optional MCP adapter exposes compatibility aliases.
  Headless sessions honestly report them UNSUPPORTED —
  the library lives in the GUI renderer's persistent storage.

## Not the same as project work assets

The assets panel also has a project-scoped **Work** tab, fed by
"Save to work asset" in a timeline clip's context menu or "Save to Work
Assets" on a media item's context menu (a media capture carries default
clip parameters) (Agent side: the `workAsset.*` edit ops). A work asset is a snapshot of one clip — its
source media, range, speed, effects, and keyframes — stored INSIDE the
open project: it saves, undoes, and reopens with the project, and
instantiating it clones the snapshot into a new timeline clip. A work
asset may also snapshot a SET of clips (the timeline's multi-select
right-click "save N selected clips"): it stores a relative member layout
inside the same project, and the project's media-byte retention treats
every member's media as referenced — not reclaimable — while the asset
(or history that could still undo it) exists. That is a
different mechanism from the library on this page, which is user-level
and cross-project, references original files instead of snapshotting
clips, and keeps its own journal and undo. The two systems do not copy to
each other: `material_attach` imports a library record into the project,
while work-asset instantiation only reuses material that is already in
the project.

Custom presets (text styles, clip effect stacks, transition parameter
sets, and inline-SVG graphics presets in the text/effects/transitions/
graphics panels) are a third, separate
user-level store: like this library they are cross-project user state,
but they hold PARAMETER bundles only — never media files, segments, or
links — and applying one copies values into the project with no lasting
reference, so deleting a preset never affects anything already built
from it. The three systems do not copy to each other.

## Resource model

Every record (`packages/core/src/material/types.ts`) carries:

| Field | Meaning |
|---|---|
| `id` | Stable `mat_…` id; never changes across projects/restarts |
| `kind` | `media` · `segment` · `link` · `method` |
| `title` / `tags` / `organizeStatus` | `inbox` (default) → `organized` |
| `userNotes` | **Human-owned.** Agent tools cannot write this field; re-analysis never overwrites it (enforced in schema, service, and core logic) |
| `aiSummary` | Agent/AI-written summary — always stored separately |
| `source` | Origin note, captured-from, `addedBy` (`user`/`agent`), `addedAt` |
| `updatedBy` / `lastAgentEditAt` | Provenance of the last write; the UI badges agent-written records |
| `revision` | Monotonic per-record counter — the CAS guard for concurrent updates |
| `usages[]` | Informational project references, including `current`/`historical` state and replacement lineage |

Kind-specific fields:

- **media**: `mediaType` (video/audio/image), `fileRef` (see below), technical
  `metadata` (duration, dimensions, frame rate, codec, size…), optional inline
  thumbnail.
- **segment**: `parentMaterialId`, `startSec`, `endSec`. The range is part of
  the USER-LEVEL identity: every project attach of a segment reuses exactly
  this in/out. (Anything project-specific — further trims, speed — belongs to
  the project's own clip, not the material.)
- **link**: `url` (http/https), optional `description`.
- **method**: optional `skillName`, `prompt`, optional `steps[]`/`inputs[]`.
  Saving a method stores text for reuse only — it never installs a skill and
  never executes prompts or scripts.

## File reference policy (explicit, never silent)

Desktop media materials **reference the original file at its absolute path**.
Nothing is copied or moved; the library probes existence on demand and shows
a "File missing" badge when the file went away — a missing source fails
attach/preview with a clear error instead of pretending to work. Agent-side
`material_create`/`attach` paths must stay inside the configured `mediaRoots`
(the same containment as `media_import`).

In the browser build (no stable paths), saving a file into the library stores
**the library's own blob copy** in IndexedDB. Original files on disk are never
deleted by the library. Removing a library entry does not reclaim that copy
immediately: the bytes are kept while the removal can still be undone (within
the library's 100-entry undo window) and are reclaimed automatically once no
surviving library record or journal entry references them.

## Persistence and compatibility

- Storage: dedicated IndexedDB database `openreel-material-library`
  (stores: `materials`, `journal`, `blobs`), separate from the project
  database `openreel-db`. Project media may carry optional `materialSource`
  and `versionSource` provenance; old project documents remain valid.
- Every mutation batch is one IDB transaction (record(s) + journal entry
  commit atomically) and one journal entry (one undo unit).
- Records and journal entries carry `schemaVersion` (currently `2`). Reads
  normalize defensively: missing optional fields are filled, corrupt rows are
  skipped, never fatal. Schema-v1 usages normalize to `status:"current"`.
- Project edits and the user-level library live in different databases. A
  project commit is authoritative; usage reconciliation is a separate,
  serialized, retryable derived write. This is not presented as a cross-DB
  transaction. Library reads wait for already-queued reconciliation so an
  Agent does not immediately observe stale provenance after a replacement.

## Undo, batches, and concurrency

- The library keeps its **own journal** (last 100 entries), independent of
  project history — undo survives project switches (entries leaving the
  window are no longer undoable and release any blob bytes only they
  referenced). The Library panel's
  History menu lists entries with actor labels and per-entry undo; the
  header shows one-click "Undo agent batch" for the latest agent entry.
  `material_undo` does the same for agents (pass a fresh `idempotencyKey`).
- `material_batch_update` (and the UI's batch bar) is **all-or-nothing**: any
  missing id or `expectedRevision` mismatch rejects the whole batch with
  per-item details, and nothing is applied.
- Concurrent edits: updates may pass `expectedRevision` (the material's own
  counter — not the project revision). A mismatch returns `CONFLICT` with the
  current value; the UI detail editor always saves with CAS and surfaces a
  "changed elsewhere" notice instead of overwriting.
- Removing a material that still has project `usages` requires `force:true`
  (the UI asks explicitly). Existing project copies are unaffected. Removing
  a media material cascades its segments (both restore on undo, including
  the library's own blob copy of a browser import).
- A segment/ranged attach persists the imported bytes first, then validates
  `media/import + track/add + clip/add` on one isolated project draft. It
  publishes one project commit and one undo unit; any failed follow-up removes
  the uncommitted blob and leaves no project media, track, clip, or history
  fragment behind.
- Project media imported from the library carries a stable `materialSource`.
  `media.replace` writes a separate version lineage. Reconciliation marks the
  old usage `historical` only after all timeline references have moved; a
  clip-scoped replacement that leaves an old reference keeps both versions
  current. Undo/redo/reload reconcile from canonical project state. An exact,
  unique replacement path can link the new version to an existing library
  material; ambiguous paths remain unlinked instead of being guessed.

## Agent workflow example: search → batch organize → attach

```jsonc
// 1. Search the inbox for untagged drone footage
material_list { "status": "inbox", "query": "drone", "pageSize": 50 }
// → { items: [ { id: "mat_ab…", revision: 1, … }, … ] }

// 2. Batch-organize in ONE all-or-nothing, one-undo call
material_batch_update {
  "updates": [
    { "id": "mat_ab…", "expectedRevision": 1,
      "aiSummary": "Aerial city flyover, sunset, ~40s usable",
      "tags": ["drone", "city", "sunset"], "organizeStatus": "organized" }
    // …more items, each with the revision observed above
  ],
  "idempotencyKey": "organize-2026-09-08-1"
}
// → { materials: […], journalEntryId: "mjr_…" }
// The user sees the batch in the Library panel immediately
// ("Agent" badges + History entry) and can undo it with one click.

// 3. Reference the material into the current project
material_attach {
  "materialId": "mat_ab…",
  "expectedRevision": 12,          // project revision from project_get_state
  "idempotencyKey": "attach-ab-1"
}
// → { mediaIdInProject: "…", clipId: null, revision: 13 }
// A segment (or explicit startSec/endSec) atomically imports and adds a
// ranged timeline clip as one project undo unit.

// If step 3 went wrong: material_undo { "idempotencyKey": "u1" }
// undoes the latest library entry; project edits use the normal GUI history.
```

Failure modes are always structured: `INVALID_PARAMS` (validation, missing
file with `details.reason:"missing_file"`, outside media roots), `NOT_FOUND`,
`CONFLICT` (CAS, referenced-without-force, idempotency payload mismatch),
`UNSUPPORTED` (no bridge / headless).

## Current limits

Search uses plain multi-token substring matching. The library does not crawl
links, fetch content, install or execute skills, deduplicate or auto-delete
records, sync to the cloud, manage teams or permissions, or show a relationship
graph. The web app keeps its UI and storage but cannot verify path-referenced
materials created on desktop (shown as "Unverified") and does not expose Agent
tools. The workspace rules in
[`AGENT-WORKSPACE.md`](AGENT-WORKSPACE.md) still apply: generated media
belongs in the Agent workspace, not the repository.
