# ADR 0007: Visual state packets for external-Agent turns

**Status:** Accepted

## Context

An external Agent previously began routine ReelTerminal turns by calling
`capabilities_get`, `editor_get_context`, and `timeline_get`. Those reads are
correct but expensive: every extra tool round repeats the Agent prompt and tool
schemas, while a large JSON timeline is a poor representation of visual layout.

Codex App Server accepts `text` and `localImage` items in the same `turn/start`
input. ReelTerminal can therefore provide the state the user is already looking
at without turning its conversation panel into a second project store.

## Decision

Every desktop conversation prompt may carry a `visualState` packet:

- a 960×540 **keyframe** combines the current preview, a compact timeline map,
  playhead, selection, and reference summary;
- a **delta** is a compact atlas of up to four 32-pixel-aligned changed regions
  and names its `baseRef` plus each tile's location in the full board;
- a **metadata** packet carries no image when pixels did not change;
- a fresh keyframe is forced for a new conversation/project, when a delta covers
  more than 35% of the board, or after seven image deltas.

Small exact fields accompany all three forms: `projectRevision`,
`contextRevision`, playhead seconds, selected ids, `stateRef`, `baseRef`, and a
bounded changed-field list. The image explains the global situation; structured
fields preserve exact identity and concurrency semantics.

The state board is generated only when the user sends a conversation message.
It is not persisted in the project, autosave, or external-conversation display
history. If canvas capture fails, the text turn continues with MCP reads as the
fallback.

## Security and lifecycle

PNG bytes cross only the trusted renderer-to-main IPC boundary. The main
process validates encoding, PNG signature, IHDR dimensions, and a 4 MiB size
limit, then atomically writes mode-0600 files under
`~/.openreel/conversation-visual-state/` (or the explicit runtime override).
It retains at most twelve images for the attachment and deletes its private
session directory on detach/replacement/disposal.

The external adapter receives a local path only after that write. The Codex
adapter independently resolves the root and candidate real paths, enforces root
containment, regular-file/type/size checks, and verifies the SHA-256 digest
before producing an App Server `localImage` item. Paths and hashes are never
projected into the optional conversation UI.

Images never replace MCP authorization, the one-writer lease, idempotency, or
revision CAS. An edit still carries `expectedRevision` and, when relevant,
`expectedContextRevision`. A stale or incomplete visual packet causes an exact
MCP read, not a guessed mutation.

## Consequences

Routine edits can normally proceed from one multimodal model turn to one atomic
`edit_apply` call. Exact fallback reads remain available, with Codex MCP output
budgets applied to the largest read tools. Image deltas accumulate only within a
bounded keyframe interval, and metadata-only turns add no image tokens.

The renderer owns visual composition because it owns the canonical project and
the already-rendered preview. The main process owns files and trust boundaries;
the provider adapter owns conversion to its native multimodal input.

## Acceptance result

The opt-in real-Codex E2E changed from seven MCP calls, 197,596 cumulative
tokens, and about 57 seconds on the previous bootstrap-read flow to one
`edit_apply`, 65,846 cumulative tokens, and about 41 seconds with a trusted
keyframe. The same test proves GUI visibility and one-step undo/redo. A separate
deterministic Electron E2E proves keyframe, metadata-only, and multi-region
delta-atlas turns.
