# ADR 0005: External-Agent Conversation Bridge Foundation

- Status: **Desktop UI and loopback reference transport landed; external server adapters required** (2026-09-02)
- Scope: provider-neutral protocol, attachment service, ephemeral display
  state, landed desktop conversation UI, and the loopback HTTP JSON-RPC
  long-poll reference transport; no universal external-Agent connector or
  embedded model
- Related: `docs/product-scope.md`, ADR 0003 (MCP transport), ADR 0004
  (live canonical project and writer lease)
- Normative adapter contract: [`docs/external-agent-conversation-adapter.md`](../external-agent-conversation-adapter.md)

## Context

OpenReel's product boundary is the finishing editor and its canonical project.
The user's external agent owns reasoning, model/provider configuration,
credentials, and conversation history. OpenReel must not recreate that stack
inside the editor. The legacy embedded BYOK chat loop and the 304-tool desktop
endpoint are removed from the product contract; this ADR defines the external
adapter boundary that replaces those responsibilities without moving them
into OpenReel.

The conversation panel lets the user see the external agent's work beside the
timeline. It is a client/view of the same remote session as the agent's native
chat. A second local conversation would split history and make it possible to
claim that an action happened in a conversation the agent never saw.

## MCP and the conversation bridge have different jobs

| Boundary | Owner | Purpose | OpenReel state kept |
|---|---|---|---|
| MCP (`tools/list`, `tools/call`) | OpenReel | Editor tools and context: reads, actions, jobs, artifacts | Canonical project, revisions, context, undo, and lease state |
| ACP-style conversation bridge | External agent | Attach/resume a conversation, send prompts, receive session updates, cancel | A bounded in-memory display projection only |
| Native agent chat | User's agent | Reasoning and durable conversation | Agent-owned, outside OpenReel |

The bridge never calls an OpenReel edit verb on behalf of the panel. The
external agent receives the prompt and uses its already paired MCP connection
to read or edit the canonical project. Human GUI actions and those MCP actions
continue to share the project, revision CAS, and undo history from ADR 0004.

ACP is a useful reference for this optional surface because its client/agent
model defines `initialize`, session attachment/resume, `session/prompt`,
streamed `session/update`, and `session/cancel`. The protocol is broader than
this editor needs, so the implementation is an explicitly labelled
attachment subset rather than a full ACP implementation. The landed loopback
carrier standardizes those messages as JSON-RPC POSTs to `/conversation` and
`openreel/session/updates` long polling. See the
[ACP v2 overview](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v2/overview.mdx)
for the upstream lifecycle and extension rules.

## Decisions

### 1. Pair an existing external session; never create a local one

`ExternalAgentPairing.sessionId` is an opaque id minted and owned by the
external agent. `ExternalConversationBridge.connect()` always performs:

1. `initialize` with OpenReel client identity, `sessionUpdate: true`, and the
   full nested `clientCapabilities.conversation` boolean shape;
2. `session/resume` for the paired id;
3. `ready` only after resume succeeds.

The bridge never calls `session/new`, invents message ids, or persists a
conversation. A connector owns endpoint selection, process/socket framing,
authentication, and secrets. Those values do not enter bridge state, events,
or display metadata.

### 2. Explicit ownership and local attachment lease

The remote session has one owner: `sessionOwner: "external-agent"`.
OpenReel owns only an ephemeral view attachment:
`attachmentOwner: "openreel-client"`, identified by a local `connectionId`.
An optional `ConversationAttachmentLease` prevents two local panels from
claiming the same attachment slot. It is not a project lock and does not
replace the live MCP writer lease.

The integration may provide `onAttachmentReleased`. It is called once, after
the transport is detached, for every successful attachment so the host can
release view-only resources. It must **not** release the external MCP writer
lease: the same agent may continue from its native chat after this optional
view closes. MCP writer release follows MCP transport/session disconnect or
its own TTL, independently of this view. Release is idempotent and keyed by
both connection id and remote session id; a stale client cannot release a
newer attachment.

### 3. Lifecycle and event semantics are typed and monotonic

Normal connection lifecycle:

```text
idle → pairing → connecting → resuming → ready
                                      ├→ disconnecting → disconnected
                                      ├→ unsupported
                                      └→ error
```

Every bridge event has a local monotonic `sequence` and timestamp. Lifecycle
events carry connection id, remote session id, ownership, and (when relevant)
fallback/error information. `session_update` events are accepted only when
their session id equals the currently paired id; updates for another session
are ignored. Agent-provided sequence numbers are retained as optional display
metadata and are never used as local ordering authority.

`prompt` emits only `submitted`/`accepted`/`cancel_requested` phases and the
opaque ids. Prompt text is not copied into OpenReel state or events. A
`user_message` update from the external agent is the source of truth for
displaying an accepted user message. `session/cancel` is a notification.

The foundation's `sequence` is a local display-event sequence and its optional
`remoteSequence` records what the Agent supplied. For the open wire adapter
contract, the Agent's per-session `sequence` is the replay ordering authority
and `openreel/session/updates` returns the next opaque `cursor` with a
`notifications` array. An adapter MUST follow the stricter rules in the
normative protocol document and must not silently reorder or rebind events.

### 4. Disconnect detaches; it does not close the remote conversation

`disconnect()` transitions through `disconnecting`, removes notification
listeners, closes the transport, releases the local attachment lease, invokes
the release callback, and ends in `disconnected`. It deliberately does **not**
send `session/close`: closing an optional view must not terminate the native
agent session or delete its history. A future explicit "end remote session"
control can add a capability-gated `session/close` operation separately.

Remote transport closure follows the same release path with reason
`transport_closed`. Release is attempted even when transport cleanup or the
integration callback fails. The last opaque session id may remain as a
reconnect hint, but no messages survive the disconnect.

### 5. Display state is memory-bounded and non-persistent

`conversation-state.ts` is a pure reducer over protocol events. The bridge
keeps the newest 200 events by default (configurable for tests/integrations),
and returns detached snapshots. There is no storage adapter, checkpoint field,
IndexedDB entry, autosave path, or conversation array. Reconnecting clears the
display projection; the external agent may replay history during `resume` and
those streamed updates can repopulate the view.

### 6. Unsupported agents fall back honestly to native chat + MCP

If `initialize`/`session/resume` is missing, rejected as unsupported, or
returns an invalid initialize response, the bridge releases its attachment and
reports:

```text
lifecycle: "unsupported"
fallback: "mcp-only"
lastError.code: "UNSUPPORTED"
```

The UI must present this as “use the agent's native chat” (the agent can still
use OpenReel's MCP server). It must not silently start an embedded model, ask
OpenReel for a provider key, or retain a partial local conversation.

## Implementation

The foundation lives in three provider-neutral files under
`packages/agent-facade/src/`:

- `conversation-protocol.ts` — ACP-style wire names, transport/connector
  interfaces, typed ownership/lifecycle/events, and narrow runtime guards;
- `conversation-state.ts` — pure bounded display projection;
- `conversation-bridge.ts` — serialized attach/prompt/cancel/detach service.

The transport is injected, so the landed loopback HTTP client remains
provider/model independent and other carriers can be supplied by a host if
needed. Tests use a fake transport and verify resume, event filtering, bounded
state, unsupported fallback, lease release, remote disconnect, and the absence
of a local prompt history.

## Amendment A1 — loopback reference transport and thin adapters (2026-09-02)

The bridge foundation is intentionally useful to more than one external-agent
implementation. The loopback reference transport and desktop client are
landed as an open, provider-neutral contract. Each Agent, MCP host, or future
integration supplies a thin server-side adapter that runs `/conversation`,
atomically writes `~/.openreel/conversation-endpoint.json` with mode `0600`,
and removes it on exit. OpenReel only reads the descriptor, POSTs JSON-RPC to
the endpoint, and long-polls `openreel/session/updates`. The adapter must
implement the contract in
[`docs/external-agent-conversation-adapter.md`](../external-agent-conversation-adapter.md),
including:

- capability levels (`basic`, `streaming`, and `observable`) and honest negotiation;
- attaching/resuming an existing opaque external session, never creating a
  local OpenReel conversation;
- the separate conversation endpoint descriptor and its secret-handling
  rules; the MCP endpoint descriptor remains an independent 15-tool facade;
- JSON-RPC request/response framing at `/conversation`,
  `openreel/session/updates` results shaped as `{cursor,notifications}`, and
  monotonic event sequences;
- explicit remote session ownership versus a local ephemeral attachment;
- safe, user-facing reasoning summaries rather than raw chain-of-thought;
- tool, approval, subtask, artifact, text, and lifecycle event forms;
- sensitive-field redaction and `_`-prefixed unknown-extension handling; and
- safe downgrade to MCP-only/native Agent chat when a capability is absent.

The minimal fixtures under
[`scripts/conversation-adapter/fixtures/`](../scripts/conversation-adapter/fixtures/)
are normative examples for `basic` and `observable` (full event surface)
adapters. Run the offline
conformance check with:

```sh
node scripts/conversation-adapter/validate.mjs
```

This validator checks protocol shape and safety invariants only; it does not
connect to a network or start an Agent. The desktop UI and loopback client are
landed; external Agents still own their server adapters, descriptors, sessions,
and credentials.

## Operational ownership and future validation

1. Each external Agent/host implements the server-side adapter: own the
   `/conversation` service, atomically publish the private descriptor, and
   remove it on shutdown. It must not ask OpenReel to create a session or
   descriptor.
2. Keep external MCP writer release tied to MCP disconnect/TTL,
   independently of the view-only conversation attachment.
3. Add end-to-end coverage proving that a prompt sent in the landed panel is
   visible in the agent's native session and that an agent MCP edit appears
   immediately in the human GUI with one canonical revision/undo entry.
