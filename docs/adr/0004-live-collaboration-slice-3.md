# ADR 0004: Live Human–Agent Collaboration — Slice 3

- Status: **Accepted** (r1, 2026-09-01)
- Date: 2026-09-01
- Branch: `feat/live-collaboration-slice-3` (stacked on `feat/agent-transport-slice-2`, PR #5)
- Context: ADR 0001 (headless facade), ADR 0002 (Chromium runtime), ADR 0003
  (transport, 14 verbs), `docs/design-principles.md` (Principle 1 parity,
  Principle 2 added by this ADR), the verified slice-3 audits
  (`audit/areas/livehost-state.md`, `audit/areas/desktop-mcp.md`,
  `audit/state-authority.md` — all re-verified against `6983fac`).

## Product context

The product goal is corrected: not "a GUI with an external automation tool"
but **One World, Three Modes** — human-only, agent-only, and human+agent
collaboration over the same canonical `Project`, the same editing actions,
the same revision, the same undo history, and the same render result.
Promo V3 is paused; it must later record real collaboration, never simulated
UI. This slice implements the first honest vertical of mode 3
(human + agent) on the Mac Desktop GUI.

## Hard constraints (product-level, also enshrined in design-principles.md)

1. **Shared World** — human and AI operate on the same canonical project.
2. **Mutual Legibility** — the AI can read the user's selection, playhead,
   time range, and canvas point; the user can see the AI's intent, actions,
   and results.
3. **Seamless Handoff** — at any revision, either side can take over.
4. **Shared Reversibility** — the human can undo/redo AI operations; the AI
   observes the post-undo state as a new revision.
5. **No Privileged Editor** — GUI, embedded AI, and external agents
   ultimately go through the same action contract.
6. **No UI Automation Illusion** — the AI never fakes engine integration by
   simulating mouse clicks on the GUI.

## Decisions

### 1. Live state authority: the renderer store stays canonical; the facade moves to the desktop main process

The zustand `useProjectStore` in the renderer remains the single canonical
holder of the open `Project` (verified: `apps/web/src/stores/project-store.ts`,
desktop holds no project copy). For live sessions, an
`AgentFacadeSession`-compatible **live facade session runs in the Electron
main process** (Node), because `AgentFacadeSession` imports
`node:fs`/`node:path`/`node:crypto` and cannot run in the renderer.

The main-process live session holds **no project copy**. It accesses the
canonical store exclusively through a narrow seam:

```ts
// packages/agent-facade/src/live-store.ts
export interface LiveEditorContext {
  readonly contextRevision: number;
  readonly playheadSeconds: number | null;
  readonly selectedClipIds: readonly string[];
  readonly selectedTextIds: readonly string[];
  readonly timeRange: { readonly startSeconds: number; readonly endSeconds: number } | null;
  readonly canvasPoint: { readonly x: number; readonly y: number } | null; // normalized 0..1
}

export interface LiveProjectStore {
  getIdentity(): Promise<{ projectId: string; projectName: string; windowId: string }>;
  getState(): Promise<{ project: Project; revision: number }>; // on-demand snapshot read
  getContext(): Promise<LiveEditorContext>;
  /** CAS-checked: rejects CONFLICT when expectedRevision is stale.
      The batch executes as ONE history group (one undo unit). */
  applyActions(
    actions: readonly Action[],
    opts: { groupLabel: string; expectedRevision?: number; expectedContextRevision?: number },
  ): Promise<{ revision: number }>;
  requestSave(): Promise<{ revision: number }>; // routes to the GUI's own save path
}
```

The main-process adapter (`apps/desktop/src/main/live/renderer-store-adapter.ts`)
implements this seam over a callId-correlated IPC bridge to the renderer
(same pattern as `apps/desktop/src/main/mcp/dispatcher.ts`, separate channel
namespace). The renderer-side listener
(`apps/web/src/services/agent/live-bridge.ts`) executes against the live
store via the existing `LiveEditorHost` machinery.

**No polling.** The main process reads state only when a verb is called, and
never pushes snapshots into the renderer. The renderer is never overwritten
from main; mutations only ever originate as actions applied by the renderer
itself.

### 2. One write path for mutations; overlay actions route engine-aware

`edit.apply` in live mode validates ops and translates them to core actions
with the **same** `ops.ts` translator as headless mode (single contract).
The renderer bridge dispatches each translated action:

- `text/create`, `text/update`, `text/remove` → the engine-aware store
  methods (`createTextClip`, `updateTextContent`/`updateTextStyle`,
  `deleteTextClip` — the same ones `LiveEditorHost` uses), because raw
  executor application of overlay actions writes only the project mirror and
  renders nothing (dual TitleEngine/project-mirror authority, verified in
  the audit).
- everything else → `store.executeAction` (the same path as manual GUI
  edits).

Every batch runs inside one `beginHistoryGroup(label)`/`endHistoryGroup()`
pair ⇒ **one agent `edit.apply` batch is exactly one GUI undo unit**, and
the user can undo/redo it with the normal Cmd+Z path.

### 3. Shared revision: one monotonic counter, CAS at the choke point

Core has no revision concept (verified). The renderer project store gains an
in-memory `projectRevision: number` (starts at 0, **not persisted** into
project files or checkpoints) incremented on **every** committed project
mutation — manual edits, agent edits, undo, and redo alike — via a single
subscription on the canonical `project` reference. All mutation paths
already replace the `project` object (`set({ project: { ...project } })`),
so the subscription is the single choke point.

`edit.apply` accepts optional `expectedRevision`; the CAS check executes in
the renderer inside the bridge's mutation entry, before any action is
applied. Stale ⇒ `CONFLICT`, nothing applied. Because human edits bump the
same counter, an agent can never silently overwrite a fresh human edit.

### 4. Ephemeral editor context and `editor.get_context` (14 → 15 verbs)

A new renderer-side editor-context module tracks: `contextRevision`
(monotonic, in-memory), playhead seconds (sourced from `timeline-store`),
selection (`ui-store.selectedItems` split into clip vs text ids), selected
time range (nullable; no GUI gesture defines one yet — reported `null`
honestly), and a normalized canvas point (new, Decision 5). Selection and
playhead are **not duplicated** — the context derives them from the source
stores and bumps `contextRevision` whenever any derived value changes.
None of this state is persisted into project files, autosave records, or
facade checkpoints (verified clean today; kept clean).

New facade verb **`editor.get_context`** (the 15th public tool) returns:
`mode` (`"live" | "headless"`), `projectRevision`, `contextRevision`,
`playheadSeconds`, `selectedClipIds`, `selectedTextIds`, `timeRange`,
`canvasPoint`, and `{ projectId, projectName, windowId }`. In headless
sessions it returns `mode: "headless"` with the project revision and all
context fields `null` plus an explicit `contextAvailable: false` — honest,
never fabricated.

`edit.apply` gains optional **`expectedContextRevision`**. An agent that
derived its op from selection, playhead, or canvas point MUST carry it; the
renderer bridge CAS-checks it before applying and fails `CONFLICT` on
mismatch. The agent then re-reads context and retries or asks.

### 5. Canvas point: real user gesture, normalized coordinates

The Preview canvas gains a minimal "agent target point" affordance: the
user toggles it (button / shortcut) and clicks on the canvas; the click is
converted to normalized 0..1 coordinates against the project frame (the
same normalization `text.create` already consumes), stored in the editor
context, and shown as a subtle marker until cleared. This is a real pointer
gesture on the real canvas — not UI automation, not simulated state.

### 6. One AI writer at a time; humans always write

A writer lease (`LiveWriterLease` in `@openreel/agent-facade`, held by the
desktop main session host) grants write access to **at most one AI session**
— embedded chat or external MCP, never both. A session without the lease
gets read-only verbs; write verbs fail `CONFLICT` with holder information.
The human never acquires the lease and can always edit; revision CAS
(Decision 3) is the concurrency guard, per the product rule "Human 始终可以操作".

### 7. Session modes: Observe / Assist / Autonomous; default Assist

Each AI session is created with a mode:

- **Observe** — read-only verbs only (`session.describe`,
  `capabilities.get`, `project.get_state`, `timeline.get`,
  `editor.get_context`, `job.status`, `verify.artifact`).
- **Assist** (default) — full verbs within the conversation; every action is
  visible in the chat and the status bar, cancellable mid-turn, and undoable.
  No per-op confirmation dialogs.
- **Autonomous** — same verb surface, larger step budget for multi-step
  tasks.

Mode is enforced at the facade session boundary (the verb gate), not by UI
convention. Cancel reuses the existing abort path
(`chat-store.stop()` → `AbortController` → turn rollback); undo reuses the
store's group undo.

### 8. Embedded chat: reuse the existing panel, rewire tools to the facade

The existing chat surface is reused, not rebuilt: `ChatPanel`/
`ChatMessage`/`ToolCallCard`/`ChatComposer` components, `chat-store`
turn lifecycle, BYOK transport and key storage (web IndexedDB, desktop OS
keychain), and the `packages/agent` loop. Three wiring changes:

1. **Tool surface**: the loop's hardcoded `executeTool`/registry gating
   becomes injectable (`runTurn` gains an executor + gating-table
   parameter; existing registry behavior stays the default so
   `agent-runner` and web chat are untouched). On desktop, the chat runs
   against the 15 facade verbs; tool definitions wrap the facade-emitted
   JSON Schemas into Anthropic/OpenAI format.
2. **Execution**: on desktop, the executor calls the main-process live
   facade session over IPC (`window.openreel.facade.call`) — in-process
   from the user's perspective, no stdio, no token, same contract as
   external agents.
3. **Desktop mount**: the chat panel is mounted into the desktop tree
   (`EditPage`/`Workspace`) with a collaboration status bar.

Chat messages carry structured metadata: project id, `projectRevision` and
`contextRevision` at send time, a selection snapshot, per-tool-call
summaries with affected clip/text ids, `success`/`error`/`cancelled`
status, and the undo-unit reference. **No raw JSON blobs in the UI** — tool
calls render as human-readable summaries ("Update text clip 3: '…'"), with
affected items and revisions.

### 9. External agents: stdio MCP via shim → token-authenticated loopback → same live session

External Codex/Claude-style agents keep working over stdio MCP. The path:

```
external agent (MCP stdio client)
  → openreel-mcp shim (spawned by the agent; reads endpoint file itself)
  → HTTP POST 127.0.0.1:<port> with Authorization: Bearer <token>
  → desktop main live endpoint (MCP: initialize/ping/tools/list/tools/call)
  → the same main-process live facade session
```

Security boundary (within the local user account):

- Token: 32 random bytes per endpoint lifetime, compared with
  `timingSafeEqual`, written to `~/.openreel/live-endpoint.json` mode 0600,
  deleted on stop. **The token is never sent to the renderer process and
  never logged.** (The legacy desktop MCP leaks its token to the renderer
  via `getMcpStatus` — DESK-04; the new path does not repeat that.)
- Loopback-only bind, POST-only, body-capped, no GET/SSE — same hardened
  shape as the existing `http-server.ts`.
- The endpoint serves **only the 15 facade tools** (`tools/list` answered in
  main from the facade schema; no renderer round-trip needed to list).
- The legacy 304-tool desktop MCP stays an internal/debug surface and is
  **not** resurrected as a public entry point; the internal registry remains
  hidden from external agents. (Its known findings DESK-01…06 are unchanged
  by this slice; hardening or retiring it is future work, recorded here.)

### 10. Preview/export in live mode: same renderer code, snapshot input

Live-mode `preview.render_frame` / `export.start` / `verify.artifact` reuse
the existing Chromium-runtime providers **in the main process**, fed with an
on-demand snapshot of the canonical project (a read, not a sync). The render
path (`VideoEngine.renderFrame`) is byte-identical to what the GUI and
headless mode use — one world, one render result. The GUI's own display
updates immediately because the store subscription repaints Preview on
every mutation; no agent involvement is needed for the user to see changes.

### 11. Headless mode is untouched

`AgentFacadeSession` (headless) keeps its private ownership model; the live
session is a separate implementation of the same 15-verb `AgentFacade`
interface behind `createLiveFacade(...)`. `agent-transport serve/run/doctor`
behave exactly as in Slice 2. The only shared change is the 15th verb
(schema + tools-list assertion 14 → 15), which headless answers honestly
(Decision 4). Live v1 honestly reports `media.import`, `project.create`,
and `project.open` as unavailable (the GUI owns media import and project
lifecycle in live mode); `project.save` routes to the GUI's save path.

### 12. Undo-unit integrity: history groups gain an owner

Verified hazard: `ActionHistory.beginGroup` is proximity-based — any push
while a group token is open joins that group, so a human edit landing
mid-agent-batch would join the agent's undo unit (and vice versa).
`ActionHistory` gains a minimal ownership rule: a push from a different
owner while a group is open auto-closes the open group first. Agent batches
label their group; GUI edits carry the default owner. One agent batch stays
exactly one undo unit even under interleaving; human edits keep their own
units.

### 13. What this slice deliberately does NOT build

Recorded here as design intent, explicitly not implemented in this slice:

- **Marker → transition slice** (the NEXT vertical). Audit result: markers
  (`marker/add|remove|update`, `Timeline.markers`, GUI, agent tools) and
  true two-clip transitions (`Transition`, 24 types, `TransitionEngine`,
  GUI, agent tools) already exist in core. The only gap is the facade:
  `TimelineState` projects no markers/transitions, and the closed op set
  has none. Minimal next-slice plan: `marker.add/remove`,
  `transition.add/remove` ops mapped 1:1 to the existing core actions,
  markers/transitions added to the `timeline.get` projection, pixel-verified
  midpoint-frame tests via `preview.render_frame`. No engine work needed;
  pre-rendered transition footage is prohibited.
- Agent cursor / remote selection rendering.
- Multi-agent sessions (the lease is single-writer by design).
- Full approval mode (per-op confirm UI exists from BYOK chat; wiring it to
  modes is future work — Assist default deliberately avoids per-op confirms
  while keeping cancel + undo).
- General keyframe animation system exposure through the facade.
- Embedded chat on the web (non-desktop) app — web chat keeps its existing
  registry path this slice.

## Consequences

- The desktop main process becomes the session authority for AI
  collaboration; the renderer remains the project authority. Two
  authorities, one seam (`LiveProjectStore`), CAS-guarded.
- Facade consumers (embedded chat, shim, future bindings) share one
  contract and one schema source; tool count 14 → 15 everywhere.
- The renderer gains two small in-memory counters (project/context
  revision) and one bridge listener; the project file format is unchanged.
- E2E must drive the real Electron build with real clicks and a real MCP
  stdio client; no store-level impersonation of the user.
