# ADR 0004: Live Human–Agent Collaboration — Slice 3

- Status: **Accepted** (r1, 2026-09-01); Decision 8 superseded by ADR 0005
  (2026-09-02), Decision 7 superseded by ADR 0006 (2026-09-04)
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
5. **No Privileged Editor** — GUI users and external agents
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
      The batch commits atomically as ONE history group (one undo unit)
      and ONE project revision.
      Returns the new revision plus the ids that genuinely exist
      afterwards (core mints entity ids; the store diffs canonical state). */
  applyActions(
    actions: readonly Action[],
    opts: { groupLabel: string; expectedRevision?: number; expectedContextRevision?: number },
  ): Promise<{ revision: number; createdIds: string[] }>;
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

### 2. One write path for mutations; live batches stage before commit

`edit.apply` in live mode validates ops and translates them to core actions
with the **same** `ops.ts` translator as headless mode (single contract).
The renderer bridge sends the translated actions to
`store.executeActionBatch`. That store method clones the canonical project,
validates and applies every supported action synchronously with
`ActionExecutor` against the isolated draft, and publishes the draft only
after every action succeeds. Text-track dependencies are also created inside
the draft. A failure discards the draft without touching canonical project or
history state; a success publishes the project once, synchronizes the derived
overlay/effect/transition engines, and copies the draft history into one
owner-scoped group.

Therefore **one Agent `edit.apply` batch is one atomic project commit, one
project revision, and exactly one GUI undo unit**. The user can undo/redo it
through the normal Cmd+Z path. Actions with asynchronous handlers are rejected
by this transaction path before their handler runs instead of being presented
as atomic. The public facade accepts at most 100 ops and the renderer accepts at
most 256 expanded core actions, keeping a batch below retained history bounds.
History eviction removes complete oldest groups. Derived engine/cache refresh
failures are diagnostic and never turn an already committed batch into a
reported failure that an idempotent caller might retry.

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
desktop main session host) grants write access to **at most one external Agent
MCP session**. The optional conversation panel is only a view/client of that
Agent's existing session and never becomes another writer. A session without the lease
gets read-only verbs; write verbs fail `CONFLICT` with holder information.
The human never acquires the lease and can always edit; revision CAS
(Decision 3) is the concurrency guard, per the product rule "Human 始终可以操作".

The JSON-safe Electron contract for status, live-store requests/replies,
events, control APIs, and external-conversation snapshots is defined once in
`packages/agent-facade/src/desktop-protocol.ts`. Desktop shared modules expose
compatibility aliases and the renderer's `global.d.ts` references those types;
neither side maintains a structural mirror. Runtime validation and sender
authorization remain main-process responsibilities.

### 7. Session modes: Observe / Assist / Autonomous; default Assist

**Superseded by ADR 0006 on 2026-09-04.** The combined mode below is retained
as decision history. Current implementations separate Guided / Collaborative /
Autonomous work preference from read-only / write access.

Each AI session is created with a mode:

- **Observe** — read-only verbs only (`session.describe`,
  `capabilities.get`, `project.get_state`, `timeline.get`,
  `editor.get_context`, `job.status`, `verify.artifact`).
- **Assist** (default) — full verbs within the conversation; every action is
  visible in the chat and the status bar, cancellable mid-turn, and undoable.
  No per-op confirmation dialogs at the editor-facade boundary.
- **Autonomous** — same verb surface, larger step budget for multi-step
  tasks.

Mode is enforced at the facade session boundary (the verb gate), not by UI
convention. Conversation cancellation is forwarded to the external Agent;
undo/redo remains part of the shared canonical editor history.

### 8. Superseded: embedded chat

**Superseded by ADR 0005 on 2026-09-02.** The implementation described below
is retained only as decision history. The embedded BYOK model loop, provider
picker, key storage, and local conversation store have been removed. The
shipped panel is a provider-neutral GUI client for an externally owned Agent
session; it has no model, provider key, tool loop, or durable history.

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
  → openreel-live-mcp shim (spawned by the agent; reads endpoint file itself)
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
- The endpoint serves **only the 17 facade tools** (`tools/list` answered in
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
session is a separate implementation of the same 16-verb `AgentFacade`
interface behind `createLiveFacade(...)`. `agent-transport serve/run/doctor`
behave exactly as in Slice 2, and headless continues to answer the shared
contract honestly (Decision 4). Live mode reports `project.create` and
`project.open` as unavailable because the GUI owns project lifecycle;
`project.save` routes to
the GUI's save path. As of the Slice 3 completion pass, `media.import` is
available when the host supplies both approved media roots and the renderer
store bridge: it validates and probes an absolute local file in the main
process, then imports it through the canonical GUI store as a visible,
undoable edit.

### 12. Undo-unit integrity: history groups gain an owner

Verified hazard: the original `ActionHistory.beginGroup` was proximity-based —
any push while a group token was open joined that group, so overlapping human
and Agent work could corrupt undo boundaries. `ActionHistory` now maintains an
owner-scoped stack of group handles. Callers that cross an async boundary close
the exact handle they opened, and each push carries its owner explicitly.
Additionally, a live Agent batch runs synchronously on an isolated draft and
publishes once, so human work cannot interleave inside its commit. One Agent
batch remains exactly one undo unit; human gestures keep their own units.

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
- Facade consumers (the external MCP shim and future bindings) share one
  contract and one schema source; tool count 14 → 15 everywhere.
- The renderer gains two small in-memory counters (project/context
  revision) and one bridge listener; the project file format is unchanged.
- E2E must drive the real Electron build with real clicks and a real MCP
  stdio client; no store-level impersonation of the user.

---

## Errata 1 (2026-09-01): independent red-team round — verdict SHIP-WITH-FIXES, fixes landed

An independent red team reviewed the committed slice (attack surfaces:
CAS placement, undo integrity, revision semantics, context revision,
security boundary, lease/modes, headless regression, honesty, persistence
hygiene, lockfile/build). Verdict: **SHIP-WITH-FIXES** — two High findings,
no Critical. Fixes landed in `4b77ae6`; all package suites and typechecks
re-verified green afterwards.

### Fixed in the round

- **H1 (turn undo ate human edits).** `undoLastTurn`'s baseline loop could
  revert human edits interleaved mid-turn. Fixed: `ActionHistory` gains
  `peekUndoOwner()`; the loop stops at the first non-`"agent"` unit and
  reports a partial undo honestly. The same owner-check now guards
  `LiveEditorHost.rollbackTransaction` (baseline snapshot + bounded loop).
- **H2 (stale-overwrite protection was opt-in).** `edit.apply` in live mode
  now **always** runs the revision CAS: when the caller omits
  `expectedRevision`, the facade auto-attaches the revision of the snapshot
  the ops were translated against. Unguarded writes can no longer clobber a
  fresh human edit.
- **M1 (createdIds mis-attribution).** `LiveProjectStore.applyActions` now
  returns category-partitioned ids (`{tracks, clips, textClips}`); the
  facade partitions per category, so mixed batches hand each op its own id.
- **M2 (lease wedged read-only).** The facade write-gate lazily re-attempts
  `lease.acquire` instead of failing forever; CONFLICT names the actual
  holder.
- **M5 (project.save honesty).** All descriptions now state plainly: live
  `project.save` flushes the GUI's autosave/recovery snapshot; it does not
  write a `.openreel` project file.
- **G-04 (status/lifecycle ordering).** The main-owned host now serializes
  enable/disable and stamps every status snapshot in capture order; renderer
  state ignores older replies or pushes. Concurrent toggles cannot leave a
  second endpoint or roll the UI back after a disable acknowledgement.
- **External lease expiry.** The shipped stdio connector heartbeats the
  authenticated endpoint. After the activity timeout, main marks it
  disconnected and releases only its writer lease. The facade, completed jobs,
  and idempotency ledger remain intact; the next authenticated write lazily
  reacquires the lease. In-flight verbs are never expired.
- **Desktop imports are file-backed.** The preload resolves an OS-backed
  `File` with Electron `webUtils.getPathForFile`; the canonical media item
  records that absolute path as `originalUrl`, so main-process snapshot
  preview/export can read real GUI-imported video and audio. Browser and
  synthetic `File` imports remain safely blob-only.
- **Playback-safe context CAS.** The timeline now separates explicit
  seek/scrub intent from ordinary playback clock ticks. Playback still updates
  the reported playhead but no longer invalidates a context guard every frame.
- **Owner-scoped history groups.** ActionHistory keeps overlapping human and
  Agent groups by owner and supports exact group handles. Live actions pass
  their owner per push instead of leaving a global Agent owner set across
  awaited work, so an overlapping GUI gesture is neither overwritten nor
  mis-attributed.
- **Live bridge cleanup.** The preload returns a real unsubscribe function and
  renderer teardown removes the IPC listener, preventing StrictMode or hot
  reload from processing one request more than once.
- **Live shim default.** The shipped `openreel-live-mcp` connector reads the
  17-tool live endpoint descriptor by default; no legacy endpoint override is
  required.
- **L2–L6, L9.** Idempotency ledger scoped per project; endpoint 404s
  non-`/mcp` POST paths; preview replay keeps `artifact.sourceRevision` as
  the truth carrier (mirrors headless, pinned by test); `getFullProject`/
  `forceSave` fall back to the project's own overlay arrays when an engine
  is momentarily null; `will-quit` awaits live-host disposal (no stale
  endpoint file); push-owner reset moved into `finally`.

### Known limitations and follow-ups (accepted for this slice)

- **Live preview/export still requires readable source files.** Desktop
  imports now retain their absolute native path, but browser/synthetic media
  is still blob-only and a source file moved or deleted after import is no
  longer readable. Snapshot rendering continues to fail honestly with
  UNSUPPORTED naming those media ids.
- **Conversation-channel trust (updated by ADR 0005).** The renderer receives
  only a bounded display projection over narrow IPC methods. Loopback endpoint
  credentials remain in the desktop main process and never cross into the
  renderer.
