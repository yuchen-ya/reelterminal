# ADR 0006: Agent Work Modes Are Not Permissions

- Status: **Accepted**
- Date: 2026-09-04
- Supersedes: ADR 0004 Decision 7 (the combined Observe / Assist / Autonomous mode)

## Context

The original live-session mode combined two unrelated concerns. Observe was a
read-only authorization, while Assist and Autonomous described how proactively
an Agent should work. Renaming those values directly would let a migrated
Observe session gain writes, and recreating the facade on every mode switch
discarded session-local state for a change that should be behavioral only.

Professional production also does not follow a rigid sequence. A user may give
one sentence or a complete script/edit plan, and research, selection,
previsualization, assembly, sound, and review may be skipped, reordered, or
revisited.

## Decision

The persisted main-process preference is:

```ts
{
  workMode: "guided" | "collaborative" | "autonomous";
  access: "read-only" | "write";
}
```

`workMode` controls default initiative and alignment density only. `access`,
the enabled Agent Session boundary, the single-writer lease, revision/context
CAS, and explicit destructive/delivery authorization continue to enforce
safety. The facade verb gate never branches on `workMode`.

Collaborative is the default. The compact status-bar selector can change work
mode at any time, including while Agent Session is disabled. The desktop main
process persists it atomically and owns the single source of truth; renderer
stores only mirror status. A mode switch does not recreate the live facade,
conversation attachment, project, references, or floating window.

`session.describe` and `editor.get_context` expose `workMode` and
`workModeSemantics` in both live and headless contracts. Live
`session.describe` additionally exposes `access` and writer-lease state.
Headless defaults to Collaborative unless its host configures another work
mode. The optional external-conversation transport includes the same context
during `initialize`, `session/resume`, every `session/prompt`, and the
namespaced `openreel/work_mode` change notification.

Legacy persisted values migrate without expanding authority:

| Legacy value | Work mode | Access |
|---|---|---|
| `observe` | `guided` | `read-only` |
| `assist` | `collaborative` | `write` |
| `autonomous` | `autonomous` | `write` |

A migrated `observe` preference therefore displays an explicit **Enable
editing** action beside the read-only badge. This calls the separate
`collabControl.setAccess("write")` authorization IPC and persists the choice;
changing Guided/Collaborative/Autonomous never calls it. Revoking access
releases the external writer lease immediately. Restoring access keeps the
same live facade, jobs, and idempotency ledger and reacquires the writer lease
lazily on the next write verb.

## Consequences

- Guided, Collaborative, and Autonomous can share one authorized tool surface.
- Autonomous still does not imply destructive permission or final delivery.
- Work-mode guidance remains an elastic Agent heuristic, not a GUI workflow
  panel or required stage machine.
- Conversation history remains externally owned and is never persisted by
  ReelTerminal.
- Future selects, storyboard, animatic, transactional assembly, comparison,
  mixing, and review-cut systems can be added without encoding them as work
  mode states.
- A safely migrated read-only preference has a discoverable recovery path,
  while recovery remains an explicit user authorization rather than an
  incidental mode rename.
