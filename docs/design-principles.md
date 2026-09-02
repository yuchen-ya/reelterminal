# Design Principles

These are the durable product and engineering commitments for ReelTerminal. ADRs
in [`docs/adr/`](adr/) record point-in-time decisions; this document records
the direction those decisions must serve.

## Product anchor

> **ReelTerminal，你的 AI 视频终点站。生成发生在任何地方，成片发生在这里。**

ReelTerminal is a video finishing editor for work produced by agents, skills,
ComfyUI, model APIs, and other creation systems. Generation may happen
anywhere. ReelTerminal owns the last mile: one canonical project, one reviewable
timeline, and a finished, verifiable artifact.

ReelTerminal owns:

- the canonical `Project`, timeline, media inventory, editor context,
  revisions, undo/redo, preview, verification, and export;
- direct human editing through the GUI;
- a compact, typed **16-tool live facade** for an external Agent to inspect
  and edit the same open project;
- stable, human-readable Agent references such as `#1`, `#2`, and `#3`;
- English and Simplified Chinese (`zh-CN`) product UI.

ReelTerminal does not own:

- an embedded LLM or embedded Agent;
- model/provider selection, provider API keys, or an inference/tool-use loop;
- conversation creation, storage, history, summarization, or identity;
- generation features that are better supplied by the user's Agent, a skill,
  ComfyUI, or a dedicated creation service.

The legacy 304-tool desktop endpoint and the embedded BYOK agent/chat path are
removed from the product contract. The extraction audit and inherited source
may remain as historical reference material; they are not supported ReelTerminal
interfaces.

## Principle 1: Human–Agent Operational Parity

*One project world, two interfaces, equal operational authority.*

### Statement

The human GUI and the external Agent operate on the **same canonical
`Project`, the same editing actions, and the same artifact world**. They are
equal peers with different paths:

```text
human GUI ───────────────┐
                         ├─ canonical Project/actions ─ preview/export
external Agent via MCP ─┘
```

The user acts directly in the GUI. The external Agent acts through the live
facade's 16-tool MCP interface. Neither path gets a private project model or
a privileged mutation backdoor.

### Requirements

- A GUI capability should have a stable, machine-readable counterpart when it
  is in the Agent contract; gaps must be named rather than hidden.
- Agent mutations are immediately reflected in the same canonical project and
  visible editor when a live session is attached.
- Both sides use the same revision/conflict boundary, undo history, preview,
  export, and verification semantics.
- Equality means equal semantic authority within the same safety boundaries;
  it does not require identical UI and API shapes.

### Conformance today (2026-09-02)

| Requirement | Status |
|---|---|
| Same canonical `Project` for GUI and Agent edits | **Yes** — the renderer store is canonical; the live bridge carries actions rather than a second project snapshot. |
| Machine-readable live state | **Yes (Slice 3 vertical)** — `editor.get_context` reports selection, playhead, ranges, canvas target, context revision, and stable references. |
| Observable preview/export/verification | **Yes (provider-scoped)** — live capability preflights determine what this session can honestly render, export, and verify. |
| Stable Agent references | **Yes** — selected entities receive monotonic session-local numbers; duplicate marks retain their number and deleted entities remain stale. |
| GUI control and Agent control | **Yes** — the human always retains direct GUI control; observe/assist/autonomous modes and the writer lease make boundaries explicit. |
| GUI buttons ↔ complete Agent command coverage | **Partial** — the 16-tool contract and closed edit-op set cover the live vertical, not every inherited editor feature. |
| External conversation client in the GUI | **Yes** — the desktop conversation UI and loopback client transport attach to an existing external session; the external Agent/host supplies the server-side adapter and descriptor writer. |
| Simplified Chinese UI | **Yes (retained product UI)** — `en` and `zh-CN` locale wiring covers the retained static web surfaces, with English fallback for future or missing copy and a dry-run codemod check guarding current coverage. |

## Principle 2: One World, Two Interfaces, Three Modes

*People and Agents may work independently or together, but the film has one
canonical home.*

The product has three operating modes over one project world:

1. **Human-only** — the user edits through the GUI.
2. **Agent-only** — an external Agent uses the headless facade and optional
   headless MCP/CLI transport.
3. **Human + Agent** — the user and an external Agent work live on the same
   open project through the GUI and the live facade.

The third mode does not mean ReelTerminal becomes an agent host. The Agent owns its
own reasoning and conversation path; ReelTerminal provides the editing world and
the live tool/context surface.

### Hard constraints

- **Shared world.** Human and Agent changes land in the canonical `Project`.
- **Mutual legibility.** The Agent can read current editor context and stable
  references; the user can see Agent activity, status, and results in the
  editor.
- **Seamless handoff.** Either side can continue at a known revision; stale
  revision/context expectations fail safely instead of overwriting edits.
- **Shared reversibility.** Agent batches are normal GUI undo units, and the
  Agent can observe the post-undo revision.
- **No privileged editor.** GUI and external Agent use the same action
  contract and safety boundaries. There is no embedded AI writer.
- **No UI automation illusion.** The Agent must not fake engine integration by
  clicking the GUI, and demos must not simulate collaboration that does not
  exist.

### Current live vertical

The live facade exposes the same 16-tool catalog in the desktop loopback MCP
endpoint. In live mode, project creation/open and media import are listed but
honestly unavailable because the GUI owns the open project and imported media.
Live reads and edits travel through the renderer bridge, with context/revision
checks, a single external writer lease, action activity events, and one shared
undo path.

## Principle 3: Finish, Do Not Become the Generator

*ReelTerminal makes generated inputs usable and shippable.*

The product boundary favors editing, assembly, review, finishing, and export.
Generation may be supplied by any external system. ReelTerminal must not grow a
second model/provider ecosystem merely because a generated asset needs a last
step of editing.

### Prohibitions

- No embedded conversational Agent/generative model, model picker, provider
  API-key/BYOK settings, or local
  inference loop as part of the ReelTerminal product path.
- No ReelTerminal-owned chat history, prompt identity, conversation persistence,
  or silent fallback to a bundled model.
- No reintroduction of the removed legacy 304-tool desktop endpoint as an
  alternative contract.
- No feature is kept solely because it exists upstream; it must directly help
  turn inputs into a finished film or make that workflow safe and observable.

The landed ReelTerminal conversation panel is a client of the user's external
Agent session. It does not create a local conversation or inference lane. The
external Agent/host owns the thin server-side `/conversation` adapter and its
atomic `0600` descriptor writer; ReelTerminal supplies no universal provider
connector and no embedded model.

## Principle 4: References Are Context, Not Content

*An Agent must be able to talk about what the user is pointing at without
changing the project just by pointing.*

Users can mark audio, video, text, media, and graphics entities as Agent
references. Marks are ephemeral editor context:

- numbers are assigned deterministically for multi-selection by timeline start
  and track order;
- numbers are monotonic and session-local (`#1`, `#2`, `#3`, …), never
  renumbered or reused;
- marking the same entity again returns its existing number;
- a deleted entity remains a stale reference and can never silently bind to a
  replacement;
- each mapping carries kind, entity ID, label, timing, and revision-at-mark;
- references are not project content, saved chat, or undoable history.

`editor.get_context` is the machine-readable boundary for these references.
The editor shows the same numbers as badges so a user and an Agent can refer to
the same entity without relying on array positions or fragile labels.

## Principle 5: Honest Capability and Honest Progress

Capabilities describe what this session can actually do. A live facade must
not claim that the GUI-owned lifecycle, a provider, a codec, or a transport is
available when it is not.

- The 16-tool catalog may include verbs that report `UNSUPPORTED` in live mode;
  that is more useful than silently routing around the GUI.
- Render, export, and verification availability comes from provider preflight
  and remains machine-readable.
- A missing external conversation adapter is an integration/configuration
  condition, not evidence of an embedded fallback. The desktop loopback client
  and conversation UI are already landed; ReelTerminal supplies no universal
  provider connector.
- Progress and status must expose meaningful state without leaking raw prompts,
  credentials, or internal conversation data.

These principles are the bar for future slices. A proposal that changes the
product boundary, reintroduces embedded inference, or gives one side a private
project world requires an explicit product decision before implementation.
