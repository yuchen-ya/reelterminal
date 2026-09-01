# Design Principles

Enduring principles that govern this project. Unlike ADRs (`docs/adr/`), which
record point-in-time decisions, principles are stable commitments: every slice,
ADR, and PR must either honor them or explicitly argue for an exception.

---

## Principle 1: Human–Agent Operational Parity

*One project world, two interfaces, equal operational authority.*

### Statement

The human GUI and the agent API operate on **the same canonical `Project`,
the same editing engine, and the same artifact world** — never on parallel
models.

- **Every GUI capability has a stable agent counterpart.** A button in the GUI
  corresponds to a stable agent command; a piece of GUI state corresponds to
  machine-readable application state; a visual result corresponds to an
  observable preview/export artifact.
- **Every agent mutation is immediately reflected** in the same project state
  and, when the human interface is attached to the session, in that interface.
  There is no "agent version" of the project.

### Prohibitions

- **No GUI-only business state.** If a piece of project state can only be
  observed or changed from the UI, the design is incomplete — the agent
  counterpart must be designed alongside, not deferred indefinitely.
- **No agent shadow state.** The agent must never keep a private model of the
  project that can diverge from the canonical one.
- **No second-class agent surface.** The agent must not be reduced to an
  observer, or to a small set of "AI features" bolted onto the product while
  the real editing surface stays GUI-only.

### Scope and limits

- Parity means **equal semantic capability within the same authorization,
  confirmation, and safety boundaries**. It does not require the GUI and the
  API to have identical shapes, and it never licenses the agent to bypass
  safety policy (confirmation gates, containment, capability honesty).
- The agent API is **kernel-level design, not a later AI add-on**. New
  business capabilities are expected to land with their agent counterpart in
  the same slice, or to declare the gap explicitly in the slice's ADR.

### Conformance today (honest status, 2026-08-28)

| Requirement | Status |
|---|---|
| Same canonical `Project` for agent edits | **Yes** — `@openreel/agent-facade` mutates the core `Project` via the core `ActionExecutor`; no shadow model exists. |
| Machine-readable state for the agent | **Partial** — `project.get_state`, `timeline.get`, `capabilities.get`, `session.describe` cover the slice-1 surface; the full GUI state space is not yet observable. |
| Observable preview/export for the agent | **Yes (slice-scoped)** — `preview.render_frame`, `export.start`, `verify.artifact` produce real, content-hashed artifacts. |
| GUI buttons ↔ agent commands | **Partial** — the closed op set (`track.add`, `clip.add`, `clip.trim`, `text.create`) covers a small fraction of the GUI's editing surface; widening is explicit per-slice work. |
| Agent edits reflected in the live GUI | **No** — the facade currently runs headless and in-process; no live session is shared with `apps/web`. This is the largest open parity gap. |

This table is expected to move toward "Yes" as slices land; a row moving
backwards requires an ADR.

---

## Principle 2: One World, Three Modes

*A video engine where humans and agents can each edit independently—or work together in the same timeline.*

### Statement

The product supports three modes over **one** world:

1. **Human-only** — the user edits entirely through the GUI.
2. **Agent-only** — an AI edits entirely through MCP/CLI/headless.
3. **Human + Agent** — both collaborate live in the same project and hand
   off to each other.

All three modes use the same project format, the same editing actions, the
same revision, the same undo history, and the same render result.

### Hard constraints

- **Shared World.** Human and AI operate on the same canonical `Project`.
  There is no agent-side copy and no GUI-only state.
- **Mutual Legibility.** The AI can read the user's current selection,
  playhead, time range, and canvas position; the user can see the AI's
  plan, actions, and results — as summaries, never raw JSON dumps.
- **Seamless Handoff.** At any revision, either side can take over and
  continue.
- **Shared Reversibility.** The human can undo/redo AI operations, and the
  AI observes the post-undo state as a new revision.
- **No Privileged Editor.** GUI, embedded AI, and external agents all go
  through the same action contract in the end; no side gets a private
  backdoor into project state.
- **No UI Automation Illusion.** The AI must never fake engine integration
  by simulating mouse clicks on the GUI, and demo material must never
  simulate collaboration that does not exist.

### Prohibitions

- **No parallel chat stack.** The embedded conversation reuses the existing
  chat UI, provider abstraction, and message flow; it is not a second agent
  application beside them.
- **No snapshot-sync shortcuts.** Live mode must not poll whole-project
  snapshots to overwrite the GUI store; mutations flow as actions through
  the canonical store, reads are on-demand.
- **No fake collaboration in promo material.** Recorded demos may only show
  real, shipped collaboration, with the user's consent for their words.

### Conformance today (honest status, 2026-09-01)

| Requirement | Status |
|---|---|
| Agent-only mode | **Yes** — headless facade + Chromium runtime + stdio transport (Slices 1–2). |
| Human-only mode | **Yes** — the inherited GUI, unchanged. |
| Human + Agent live collaboration | **In progress** — Slice 3 (ADR 0004) lands the first vertical: shared revision, live context (`editor.get_context`), embedded chat on facade contracts, single-writer lease, shared undo. |

---

*Further principles will be added here as the project earns them.*
