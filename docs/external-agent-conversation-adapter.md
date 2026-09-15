# ReelTerminal External-Agent Conversation Adapter Protocol

**Protocol:** `openreel-conversation/1`

**Status:** open contract for the landed loopback reference transport; each
external Agent or host supplies a thin adapter (updated 2026-09-04)

**Related:** [ADR 0005](adr/0005-external-agent-conversation-bridge.md),
[product scope](product-scope.md)

## 1. Purpose and boundary

This document defines the smallest open protocol an external Agent or Agent
host can implement so a ReelTerminal client can attach to that Agent's existing
session. The loopback HTTP JSON-RPC long-poll reference transport and ReelTerminal
desktop client are landed. An external Agent or host supplies the thin
server-side adapter: it owns the `/conversation` service, atomically writes
the descriptor with mode `0600`, and removes it when the service exits. ReelTerminal
only reads that descriptor and posts requests/polls updates.

ReelTerminal is the client of this protocol. The external Agent owns the model,
reasoning, credentials, conversation identity, and durable history. ReelTerminal
owns the editor, the canonical project, and the separate 37-tool live MCP
facade. The conversation adapter never becomes a second writer and never
calls ReelTerminal edit tools on behalf of a chat panel.

```text
external Agent conversation ── thin adapter ── optional ReelTerminal view
             │
             └────────────── 37-tool MCP ────────────── ReelTerminal live project
```

The conversation endpoint and the MCP endpoint are separate contracts. The
MCP facade remains discoverable through `~/.openreel/live-endpoint.json` and
`/mcp`; this protocol uses `~/.openreel/conversation-endpoint.json` and
`/conversation`. Neither endpoint is a transcript store, a model provider, or
a replacement for the Agent's native chat.

## 2. Capability levels

The descriptor's `adapter.capabilityLevel` MUST be one of `basic`, `streaming`,
or `observable`, and MUST name the highest level the adapter can actually
honor. ReelTerminal advertises the complete `clientCapabilities.conversation`
shape during `initialize`; the Agent reports the booleans it supports in
`sessionCapabilities.conversation`. A capability name is not permission to
silently emulate missing behavior.

| Level | Meaning | Required behavior |
|---|---|---|
| `basic` | Minimal existing-session attachment | `initialize`, `session/resume`, `session/prompt`, `session/cancel`, `formalReply`, and `openreel/session/updates` with text/state updates, explicit ownership, and safe detach. |
| `streaming` | Resumable incremental delivery | Everything in `basic`, plus `streaming` chunks, opaque `after` replay, bounded long polling, and monotonic remote event sequences. |
| `observable` | Rich safe collaboration telemetry | Everything in `streaming`, plus user-safe `reasoningSummary` and the advertised `toolEvents`, `approval`, `usage`, `subtask`, and `artifact` event families. |

An implementation MAY expose `mcp-only` as a local fallback state when it has
no conversation attachment. `mcp-only` is not a value for
`adapter.capabilityLevel`: the Agent can still use ReelTerminal's independent
37-tool live MCP endpoint and its native chat.

### 2.1 Negotiation

The first request is JSON-RPC `initialize`. The descriptor names the adapter's
claimed presentation tier; the initialize result's nested booleans are the
authoritative capabilities for this session:

```json
{
  "jsonrpc": "2.0",
  "id": "init-1",
  "method": "initialize",
  "params": {
    "protocolVersion": "openreel-conversation/1",
    "clientInfo": { "name": "ReelTerminal", "version": "0.1.0" },
    "clientContext": {
      "workMode": "collaborative",
      "semantics": {
        "id": "collaborative",
        "label": "Collaborative",
        "summary": "Work as the user's peer: perform low-risk reversible actions, align on uncertain creative direction, high cost, or large changes, and follow complete user plans without tutorial detours.",
        "deliveryRequiresExplicitAuthorization": true
      }
    },
    "clientCapabilities": {
      "sessionUpdate": true,
      "conversation": {
        "formalReply": true,
        "streaming": true,
        "reasoningSummary": true,
        "toolEvents": true,
        "approval": true,
        "usage": true,
        "artifact": true,
        "subtask": true
      }
    }
  }
}
```

The Agent responds with only the capabilities it will honor:

```json
{
  "jsonrpc": "2.0",
  "id": "init-1",
  "result": {
    "protocolVersion": "openreel-conversation/1",
    "agentInfo": { "name": "Example Agent", "version": "2.4" },
    "sessionCapabilities": {
      "resume": true,
      "prompt": true,
      "cancel": true,
      "conversation": {
        "formalReply": true,
        "streaming": true,
        "reasoningSummary": true,
        "toolEvents": true,
        "approval": true,
        "usage": true,
        "artifact": true,
        "subtask": true
      }
    }
  }
}
```

`clientInfo` and `agentInfo` are display metadata only. They MUST NOT contain
API keys, bearer tokens, model secrets, or raw prompts. Unknown capability keys
are ignored. If no supported level can be negotiated, the adapter reports
`unsupported` and uses the `mcp-only` fallback.

### 2.2 Work-mode context

ReelTerminal sends the current `clientContext` during `initialize`,
`session/resume`, and every `session/prompt`. It also sends an
`openreel/work_mode` JSON-RPC notification whenever the user changes modes
while the attachment is live. An adapter may ignore the notification, because
the next prompt repeats the complete current context; the reference adapter's
optional `onWorkMode` hook receives it immediately.

`workMode` is one of `guided`, `collaborative`, or `autonomous`. The accompanying
`semantics` object is the authoritative, user-visible meaning for that mode.
It always states `deliveryRequiresExplicitAuthorization: true`. Work mode
controls initiative and alignment density only: it does not grant editor write
access, bypass approvals, transfer conversation ownership, or authorize export
or delivery. MCP `session.describe` separately reports the live session's
`access` and writer-lease state.

### 2.3 Visual-state context

Desktop prompts may also carry a bounded `visualState`. A full `keyframe`
contains a 960×540 overview of the current preview, timeline, playhead,
selection, and references. A `delta` contains a compact atlas of up to four
32px-aligned changed regions and identifies the preceding `baseRef`; `metadata` means the pixels are
unchanged and carries no image. A new keyframe is emitted after seven image
deltas, on project/conversation change, or when the changed crop is large.

The structured fields are authoritative for ids and concurrency. The image is
only for global visual understanding: adapters MUST keep `projectRevision` and
`contextRevision` available to mutations and MUST use an MCP read when an exact
required field is missing or stale.

## 3. Existing-session attachment

The Agent MUST mint and own the opaque `sessionId`. ReelTerminal MUST attach to an
existing session and MUST NOT call `session/new`, invent an id, or create a
local conversation. The descriptor's `sessionId` is the default id for the
attachment; a resume request MUST use that same id.

The normal sequence is:

```text
initialize → session/resume(sessionId) → ready
```

`session/resume` accepts only the existing session id. Poll replay state is
sent separately on `openreel/session/updates`:

```json
{
  "jsonrpc": "2.0",
  "id": "resume-1",
  "method": "session/resume",
  "params": {
    "sessionId": "agent-session-opaque",
    "clientContext": {
      "workMode": "collaborative",
      "semantics": {
        "id": "collaborative",
        "label": "Collaborative",
        "summary": "Work as the user's peer while aligning on uncertainty, high cost, or large changes.",
        "deliveryRequiresExplicitAuthorization": true
      }
    }
  }
}
```

The Agent MUST reject a session id it does not own or cannot resume. A
successful resume establishes the attachment; subsequent polls may replay
events after the supplied `after` checkpoint. Replayed events retain their
original sequence and MUST NOT be assigned new semantic meaning.

ReelTerminal's attachment is view-only ownership:

```json
{
  "sessionOwner": "external-agent",
  "attachmentOwner": "openreel-client",
  "sessionId": "agent-session-opaque",
  "connectionId": "openreel-attachment-opaque"
}
```

The external Agent remains free to use its native chat. Closing or losing the
ReelTerminal view detaches the transport; it MUST NOT send `session/close` or
delete the remote conversation. The ReelTerminal attachment lease and the live MCP
writer lease are independent. A view disconnect MUST NOT release the Agent's
MCP writer lease.

## 4. Loopback endpoint descriptor

An external Agent or host adapter starts the loopback `/conversation` service
and atomically writes a short-lived descriptor at:

```text
~/.openreel/conversation-endpoint.json
```

The descriptor has this shape (the token below is a fixture value, not a
usable secret):

```json
{
  "version": 1,
  "transport": "http-jsonrpc-long-poll",
  "endpoint": "http://127.0.0.1:43127/conversation",
  "token": "fixture-token-1234567890",
  "sessionId": "agent-session-opaque",
  "agent": { "name": "Example Agent", "version": "2.4" },
  "adapter": {
    "name": "example-conversation-adapter",
    "capabilityLevel": "observable"
  }
}
```

The descriptor fields are:

| Field | Requirement |
|---|---|
| `version` | Required integer `1`. |
| `transport` | Required exact value `http-jsonrpc-long-poll`. |
| `endpoint` | Required loopback HTTP URL ending in `/conversation`; POST JSON-RPC requests here. |
| `token` | Required opaque bearer token with at least 16 characters. Never expose it in prompts, events, logs, or project state. |
| `sessionId` | Required opaque id for the already existing external session. |
| `agent` | Required object with non-empty `name`; `version` is optional display metadata. |
| `adapter` | Required object with non-empty `name` and `capabilityLevel` equal to `basic`, `streaming`, or `observable`. |

Unknown descriptor fields MUST be ignored. The conversation descriptor is not
the MCP descriptor. The `openreel-live-mcp` connector reads
`~/.openreel/live-endpoint.json` for the independent MCP facade. ReelTerminal's
conversation client reads only `conversation-endpoint.json`; it never creates,
rewrites, or owns that file. The conversation endpoint is loopback-only,
POST-only, and token authenticated.

The external Agent/host adapter MUST:

- start the `/conversation` service before publishing its descriptor;
- atomically replace the descriptor (for example, write a temporary file,
  enforce mode `0600`, then rename it into place);
- remove the descriptor when the service exits or the session is disabled;
- keep the token in memory only for the service lifetime and never print,
  persist, or include it in prompts, events, project files, or telemetry; and
- refuse non-loopback endpoints or a missing/short token.

The ReelTerminal client MUST read the descriptor as a private regular file, reject
non-`0600` files where supported, keep the token in memory for the connection,
and never log it.

## 5. JSON-RPC carrier and event delivery

Every request, response, and notification uses JSON-RPC 2.0. The ReelTerminal
client POSTs the JSON-RPC body to the descriptor's `endpoint`; there is no
second events URL. Request ids are opaque strings or numbers. A response MUST
carry the matching id and exactly one of `result` or `error`. Notifications
have no id.
Malformed JSON, unknown methods, and invalid params use standard protocol
errors such as `-32600`, `-32601`, and `-32602`.

### 5.1 Requests

The required method set is:

| Method | Level | Meaning |
|---|---:|---|
| `initialize` | basic | Confirm protocol and negotiate capabilities. |
| `session/resume` | basic | Attach to the existing external session by `sessionId`. |
| `session/prompt` | basic | Forward a user prompt to that session. |
| `session/cancel` | basic | Request cancellation of the current turn. |
| `openreel/work_mode` | basic notification | Report a changed work mode immediately; the complete context is repeated with every prompt. |
| `openreel/session/updates` | basic | Long-poll updates after an opaque `after` cursor. Returns `{cursor,notifications}`. |
| `session/approval` | observable | Return an explicit user decision for an approval request. |
| `session/close` | reserved, not called by the shipped UI | A future explicit operation may end the remote session; normal detach never calls it. |

`session/prompt` carries text to the Agent but the ReelTerminal view MUST NOT copy
the prompt into durable project or conversation state:

```json
{
  "jsonrpc": "2.0",
  "id": "prompt-7",
  "method": "session/prompt",
  "params": {
    "sessionId": "agent-session-opaque",
    "prompt": [{ "type": "text", "text": "Review Agent reference @A2." }],
    "clientContext": {
      "workMode": "guided",
      "semantics": {
        "id": "guided",
        "label": "Guided",
        "summary": "Propose sensible defaults, explain consequential choices, and invite review.",
        "deliveryRequiresExplicitAuthorization": true
      }
    },
    "visualState": {
      "version": 1,
      "stateRef": "vs-window-7",
      "baseRef": "vs-window-6",
      "kind": "delta",
      "projectRevision": 12,
      "contextRevision": 4,
      "playheadSeconds": 2.5,
      "selectedClipIds": ["clip-1"],
      "selectedTextIds": [],
      "selectedMediaIds": [],
      "changed": ["preview", "timeline"],
      "image": {
        "type": "localImage",
        "path": "/main-owned-runtime/0007-state.png",
        "width": 320,
        "height": 192,
        "sha256": "<64 lowercase hex characters>",
        "regions": [
          { "x": 320, "y": 0, "width": 320, "height": 192, "imageX": 0, "imageY": 0 }
        ]
      }
    }
  }
}
```

`session/cancel` requests cancellation; it does not imply that already
committed editor actions are rolled back. `session/approval` is required only
when the negotiated level advertises approval events. The user decision is
never inferred from a timeout or a missing capability.

The adapter and client must keep `session/cancel` and `openreel/work_mode` on
an out-of-band control path: neither may wait behind an unresolved
`session/prompt` request. Only one prompt may be in flight for an attachment;
a second prompt fails explicitly instead of being queued invisibly. This keeps
mid-turn cancellation and collaboration-mode changes responsive even when an
Agent returns from `session/prompt` only after the turn finishes. ReelTerminal
does not impose the ordinary 30-second request timeout on `session/prompt`;
transport close, fatal update polling, detach/replacement, and an explicit
caller abort remain termination boundaries.

The `visualState.image.path` is ephemeral application context, not an arbitrary
file attachment. Provider adapters MUST accept it only from a configured,
main-owned visual-state root and SHOULD verify file type, size, and digest before
mapping it to their native image-input form. Invalid or unavailable images are
dropped; the text prompt and MCP fallback remain usable. Paths and digests MUST
NOT appear in display updates or durable project state.

### 5.2 Long-poll updates

The canonical event sequence uses `openreel/session/updates`, sent as a JSON-
RPC request to the same `/conversation` endpoint:

```json
{
  "jsonrpc": "2.0",
  "id": "poll-12",
  "method": "openreel/session/updates",
  "params": {
    "sessionId": "agent-session-opaque",
    "after": "cursor-41",
    "waitMs": 25000
  }
}
```

The successful response MUST have a `cursor` and `notifications` array:

```json
{
  "jsonrpc": "2.0",
  "id": "poll-12",
  "result": {
    "cursor": "cursor-42",
    "notifications": [
      {
        "method": "session/update",
        "params": {
          "sessionId": "agent-session-opaque",
          "sequence": 42,
          "update": {
            "sessionUpdate": "state_update",
            "state": "idle"
          }
        }
      }
    ]
  }
}
```

`cursor` is an opaque checkpoint: clients MUST store it only for the current
ephemeral attachment and MUST NOT parse, increment, or compare it. For a given
remote session, `params.sequence` starts at 1, increases strictly, and is
never reused. The sequence is the ordering authority for replay and the
notifications returned by long polling. An adapter MAY retain a separate
local display sequence, but MUST preserve the remote sequence as metadata.
Updates for a different session id MUST be ignored and MUST NOT be rebound to
the current session.

`waitMs` is bounded by the adapter; a client SHOULD use at most 30 seconds. An
empty `notifications` result is a successful poll, not a conversation message.
The client must retain only the cursor needed for the current ephemeral
attachment; there is no ReelTerminal conversation log.

An implementation may internally receive push events, but the loopback
reference transport exposes them through this long-poll method so adapters do
not need a second carrier or endpoint.

## 6. Update and event vocabulary

Every standard update has a `sessionUpdate` discriminator. Basic Agents MUST
support `user_message`, the formal `agent_message` reply, and `state_update`.
Only a streaming-capable Agent may send `agent_message_chunk`; it MUST preserve
chunk order and replay cursors. Observable Agents MAY advertise the following
additional families; a host MUST render only events supported by the nested
`sessionCapabilities.conversation` booleans.

### 6.1 Messages and state

```json
{ "sessionUpdate": "user_message", "messageId": "m1", "content": [{ "type": "text", "text": "Make the opening tighter." }] }
{ "sessionUpdate": "agent_message", "messageId": "m2", "content": [{ "type": "text", "text": "I will compare @A1 and @A2." }] }
{ "sessionUpdate": "state_update", "state": "working", "stopReason": "tool_use" }
```

The external Agent is the source of truth for accepted user messages. The
ReelTerminal client MAY display an echoed `user_message`; it MUST NOT invent a
second local copy when the echo is absent.

### 6.2 Reasoning summaries, never raw chain-of-thought

The only reasoning event in this protocol is a user-safe summary:

```json
{
  "sessionUpdate": "reasoning_summary",
  "summary": "Comparing the first two shots for continuity before trimming."
}
```

`summary` is a concise explanation suitable for the user. It MUST NOT contain
raw chain-of-thought, hidden deliberation, token traces, system prompts,
credentials, or private provider metadata. If an Agent has raw reasoning, it
must keep it outside this protocol. An adapter receiving a non-standard
`reasoning` or `chain_of_thought` field MUST discard it and MUST NOT render or
persist it.

### 6.3 Tool events

Tool events describe observable progress, not a second execution channel:

```json
{
  "sessionUpdate": "tool_call",
  "toolCallId": "tool-3",
  "title": "Trim opening clip",
  "status": "running",
  "summary": "Trimming Agent reference A1 to 4.5 seconds."
}
```

`tool_call_update` and `tool_result` use the same four display fields:
`toolCallId`, `title`, `status`, and `summary` (plus the discriminator).
`tool_result` uses a terminal status: `completed`, `failed`, or `cancelled`.
Raw params, raw results, access tokens, and unredacted local paths MUST NOT be
sent as display event fields. The actual editor mutation is always the live
MCP tool call and its canonical action/revision result.

### 6.4 Approval events

An Agent requests a human decision without assuming consent:

```json
{
  "sessionUpdate": "approval_request",
  "requestId": "approval-4",
  "title": "Replace review artifact",
  "summary": "Export will overwrite an existing deliverable.",
  "options": [
    { "id": "approved", "label": "Replace it" },
    { "id": "denied", "label": "Keep existing artifact" }
  ]
}
```

The client answers explicitly:

```json
{
  "jsonrpc": "2.0",
  "id": "approval-response-4",
  "method": "session/approval",
  "params": {
    "sessionId": "agent-session-opaque",
    "requestId": "approval-4",
    "decision": "denied"
  }
}
```

Valid decisions are `approved` and `denied`. A client MUST NOT convert a
missing approval capability into automatic approval; it falls back to native
Agent interaction or MCP-only use.

### 6.5 Subtasks and plans

Observable Agents MAY expose bounded progress for delegated work:

```json
{
  "sessionUpdate": "subtask",
  "subtaskId": "subtask-2",
  "title": "Check audio continuity",
  "status": "completed",
  "summary": "No discontinuity found."
}
```

Statuses are `pending`, `running`, `completed`, `failed`, and `cancelled`.
The older compact `plan` form is also allowed for basic progress display. A
subtask event never grants the subtask a separate ReelTerminal writer lease.

### 6.6 Artifact events

Artifact events carry safe metadata only:

```json
{
  "sessionUpdate": "artifact",
  "artifactId": "artifact-5",
  "kind": "video",
  "label": "review export",
  "mimeType": "video/mp4",
  "sizeBytes": 184320,
  "status": "available"
}
```

Artifact `status` is `available`, `pending`, or `failed`. Local filesystem
paths, bearer tokens, signed URLs, and provider credentials are not display
metadata. The Agent should use
the live facade's `export.start`, `job.status`, and `verify.artifact` results
for actual artifact access.

### 6.7 Usage events

An observable Agent MAY expose bounded session totals, turn deltas, cache
breakdowns, and current-context counters without identifying a provider or
model:

```json
{
  "sessionUpdate": "usage",
  "inputTokens": 120,
  "cachedInputTokens": 80,
  "outputTokens": 48,
  "reasoningOutputTokens": 12,
  "totalTokens": 168,
  "turnTotalTokens": 68,
  "currentContextTokens": 96,
  "contextWindowTokens": 500000
}
```

Each counter, when present, is a non-negative integer. Usage is display-only
and MUST NOT contain credentials, provider metadata, or raw prompts.

The shipped Codex adapter treats an exact `/compact` prompt as the external
Agent's explicit context-compaction command. It never triggers compaction from
token thresholds. After Codex reports `contextCompaction` completion, the next
turn receives a compact ReelTerminal state capsule containing project identity,
revisions, selection, and the current A/R reference directories.

## 7. Sensitive fields and unknown extensions

Adapters MUST treat all incoming text, metadata, and errors as untrusted. At a
minimum, the following field names are sensitive and MUST be redacted from
logs and display metadata (case-insensitive, including nested objects):

```text
token, authorization, apiKey, api_key, secret, password, cookie,
privateKey, accessKey, refreshToken, bearer, sessionToken
```

Raw prompt text and raw tool input/output are not part of ReelTerminal's durable
state. An adapter may render a user message or a bounded summary transiently,
but MUST NOT put conversation text into project files, checkpoints, undo
history, or analytics by default.

Unknown fields on a known request or update are ignored unless the protocol
version marks them required. Vendor extensions MUST use an update discriminator
beginning with `_` (for example, `sessionUpdate: "_vendor_progress"`). An
adapter MAY preserve such an extension as opaque in its bounded in-memory
projection, but MUST NOT execute it, reinterpret it as a standard event, or
send it to the editor as an action. Unknown non-extension update types are
ignored with a diagnostic; they do not cause a model fallback or session
rebind.

## 8. Safe degradation and failure handling

| Condition | Required behavior |
|---|---|
| No descriptor/token or non-loopback endpoint | Refuse the conversation connection; do not guess or log secrets. |
| `initialize` or `session/resume` unsupported | Report `unsupported`, detach, and keep native Agent chat + ReelTerminal MCP (`mcp-only`). |
| `observable` unavailable but `streaming` works | Negotiate `streaming`; omit rich event UI and retain chunk/state updates. |
| `streaming` unavailable but `basic` works | Negotiate `basic`; omit replay/rich event UI and retain text/state updates. |
| Loopback service or long poll unavailable | Detach safely and fall back to native Agent chat + ReelTerminal MCP (`mcp-only`). |
| Unknown standard update | Ignore and diagnose; do not invent content or stop the editor. |
| Malformed, cross-session, or out-of-order event | Ignore or terminate the attachment safely; never rebind it to another session. |
| Approval capability absent | Never auto-approve; defer the decision to native Agent interaction or MCP-only use. |
| Transport closes | Detach, release only the local attachment lease, and leave the remote session alive. |
| Adapter error or protocol mismatch | Show a bounded error, preserve the editor, and never start an embedded model. |

The fallback order is therefore:

```text
observable → streaming → basic → native Agent chat + ReelTerminal MCP (mcp-only)
```

There is no embedded ReelTerminal model, BYOK request, silent provider switch, or
project-owned conversation fallback.

## 9. Conformance

An external server adapter is `basic`-conformant when it can:

1. answer ReelTerminal's `initialize` request with
   `sessionCapabilities.conversation.formalReply: true`;
2. attach/resume an existing opaque session from the descriptor;
3. forward prompt and cancel requests to that session;
4. accept `openreel/session/updates` and return text/state notifications with a
   session identity and `cursor` response (using `after` for subsequent polls);
5. preserve explicit remote ownership and detach without closing; and
6. avoid persisting prompts, messages, credentials, or raw reasoning.

It is `streaming`-conformant when it additionally preserves chunk order,
monotonic sequences, opaque cursor replay, and bounded long-poll behavior. It
is `observable`-conformant when it additionally implements the safe event
families it advertises, including reasoning summaries (never raw chain of
thought), tool, approval, subtask, and artifact events.

The minimal repository fixtures cover `basic` and `observable` (the full event
surface) adapters and MUST pass the offline check:

```sh
node scripts/conversation-adapter/validate.mjs
```

The validator is dependency-free and network-free. It checks descriptor shape,
JSON-RPC request/response framing, session ownership, long-poll `after`/cursor
shape, event ordering, sensitive fields, raw-reasoning rejection, and safe
unknown extensions. It does not connect to an Agent or read the real endpoint
descriptor; the ReelTerminal desktop conversation UI and loopback client are
already landed.

## 10. Reference adapter kit

External Agent hosts do not need to reimplement the loopback carrier. The
dependency-free reference module at
`scripts/conversation-adapter/adapter-kit.mjs` provides
`startConversationAdapter(...)`: the host supplies its existing `sessionId`
and small hooks for initialize, resume, prompt, cancel, approval, and update
polling. The kit owns only HTTP, authentication, request limits, descriptor
publication, and safe cleanup; it never creates an Agent session, keeps a
transcript, calls MCP, or chooses a provider/model.

See `scripts/conversation-adapter/README.md` for a minimal integration.

## 11. Codex reference adapter

`scripts/conversation-adapter/codex-adapter.mjs` is the first production
provider adapter. It speaks the official Codex App Server JSONL protocol,
creates or resumes a Codex-owned thread, configures the built
`openreel-live-mcp` connector for that thread, and publishes the ordinary
private `/conversation` descriptor consumed by ReelTerminal.

Only bounded display-safe events cross into the editor: user/Agent text,
safe reasoning summaries, sanitized tool names and states, usage, plans, and
approval state. Raw reasoning, command output, tool arguments/results, paths,
URLs, provider metadata, and credentials are dropped. The adapter keeps
cancel and work-mode updates on the protocol's out-of-band control lane.

For Codex, a trusted keyframe/delta is forwarded as a `localImage` item beside
the text in `turn/start`. The small structured packet is added to the turn text,
including revision preconditions and delta-atlas coordinates, but never the local
path. Routine turns are told to skip redundant bootstrap reads; bounded MCP
output limits protect the fallback path.

Enabling Agent Session in the GUI is the coarse authorization for the dedicated
ReelTerminal MCP server, so the adapter configures that one server as approved.
The facade still enforces its own access level, writer lease, context/revision
CAS, idempotency, atomic batches, and shared undo. Codex command and file-change
requests remain interactive approvals. Run and test instructions live in
`scripts/conversation-adapter/README.md`.

## 12. Typed provider boundary

Hosts that consume the workspace TypeScript packages can implement
`ExternalConversationProviderAdapter` from
`@openreel/agent-facade/conversation-adapter`. The companion
`createExternalConversationAdapterRouter(...)` enforces the existing-session
identity, one in-flight prompt, out-of-band cancel/work-mode calls, and
explicit unsupported-operation errors. It contains no HTTP, descriptor,
credential, model, or provider logic. The dependency-free adapter kit above
remains the copyable reference loopback carrier for hosts that should not take
a workspace dependency.

Contract coverage is split intentionally:

- `packages/agent-facade/src/conversation-adapter.test.ts` checks the typed,
  provider-neutral callback boundary;
- `scripts/conversation-adapter/adapter-kit.test.mjs` checks loopback auth,
  routing, redaction, size limits, and descriptor ownership; and
- `apps/desktop/src/main/conversation/loopback-connector.test.ts` checks the
  shipped client against a real loopback server.

### 10.2 Remaining external choice

ReelTerminal cannot choose the user's external Agent host. A production
integration still needs one host-specific mapping from that host's existing
session APIs to `resume`, `prompt`, `cancel`, optional approval/work-mode
callbacks, and safe display updates. That mapping also decides how the Agent
learns ReelTerminal's separate live MCP endpoint. Provider credentials remain
inside that host and are never added to either descriptor. No credential,
provider, or model is assumed by this repository.
