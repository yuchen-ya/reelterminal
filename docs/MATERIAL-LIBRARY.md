# User-level material library

The material library is a **user-level** collection of creative resources that
exists independently of any project: local media files, time ranges inside
media ("segments"), links, and reusable "skill + prompt" methods. It survives
project switches and app restarts, both the human UI and external Agents can
manage it, and projects only ever **reference** materials — they never own
them.

- Human entry point: the **Library** tab in the editor's left assets panel
  (plus "Save to material library" in a project media item's context menu).
- Agent entry point: the `material_*` MCP tools in a live desktop session
  (`material_list`, `material_get`, `material_create`, `material_update`,
  `material_batch_update`, `material_remove`, `material_attach`,
  `material_undo`). Headless sessions honestly report them UNSUPPORTED —
  the library lives in the GUI renderer's persistent storage.

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
| `usages[]` | Informational project references (projectId, mediaIdInProject, range, attachedAt/By) |

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
**the library's own blob copy** in IndexedDB. Removing a library entry
reclaims only that copy — original files on disk are never deleted by the
library.

## Persistence and compatibility

- Storage: dedicated IndexedDB database `openreel-material-library`
  (stores: `materials`, `journal`, `blobs`), separate from the project
  database `openreel-db` so project schemas are untouched.
- Every mutation batch is one IDB transaction (record(s) + journal entry
  commit atomically) and one journal entry (one undo unit).
- Records and journal entries carry `schemaVersion` (currently `1`). Reads
  normalize defensively: missing optional fields are filled, corrupt rows are
  skipped, never fatal. A future format bump migrates by version.

## Undo, batches, and concurrency

- The library keeps its **own journal** (last 100 entries), independent of
  project history — undo survives project switches. The Library panel's
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
  a media material cascades its segments (both restore on undo).

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
// A segment (or explicit startSec/endSec) instead adds a timeline clip
// scoped to that range as one additional undo unit.

// If step 3 went wrong: material_undo { "idempotencyKey": "u1" }
// undoes the latest library entry; project edits use the normal GUI history.
```

Failure modes are always structured: `INVALID_PARAMS` (validation, missing
file with `details.reason:"missing_file"`, outside media roots), `NOT_FOUND`,
`CONFLICT` (CAS, referenced-without-force, idempotency payload mismatch),
`UNSUPPORTED` (no bridge / headless).

## What is deliberately NOT built (yet)

No vector/semantic search (plain multi-token substring), no automatic link
crawling or content fetching, no skill install/execution, no dedupe or
auto-deletion, no cloud sync/permissions/team features, no relationship-graph
UI. Web (non-desktop) runs keep full UI + storage, but cannot verify
path-referenced materials created on desktop ("Unverified" badge) and expose
no agent tools (live-only). The workspace rules in
[`AGENT-WORKSPACE.md`](AGENT-WORKSPACE.md) still apply: generated media
belongs in the Agent workspace, not the repository.
