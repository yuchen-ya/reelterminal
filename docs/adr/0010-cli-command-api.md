# ADR 0010 — CLI-first desktop Command API

Status: accepted and implemented. Supersedes the conversation/work-mode/automatic
visual-state integration in ADRs 0005, 0006 and 0007. The editor's selection,
playhead, references and context revision remain part of the editing contract.

## Ownership and entry points

The desktop owns the open project, guarded edits, shared undo, media, preview,
analysis and export jobs. Agents own installation, login, conversations, history,
context compression and decisions about when to read editor state.

Default: Agent → reelctl → loopback Command API → live facade → canonical GUI.
Compatibility: Agent MCP client → reelctl mcp serve → the same Command API.
Headless reelterminal-agent serve/run/doctor remains separately opt-in.

The desktop starts no MCP stdio process or conversation adapter and never
modifies Agent configuration. Agent Access exposes enable/disable, read-only/write
and current activity. Existing read-only preferences migrate without widening
access; the legacy preference file is retained for migration, containing only
version and access after normalization.

## Single command contract

The facade Command Catalog owns canonical names, input/output schemas,
live/headless descriptions, effects and retry metadata, including plugins.
CLI aliases and MCP underscore names map onto it; they do not implement edits.
Removing work-mode output fields advances the facade contract to facade-slice-8.
MCP compatibility preserves command names and editing semantics, not removed
conversation preference fields. The new CLI requires recorded revision and
project guards for edit/apply and history control. Existing MCP callers retain
the facade's legacy optional revision semantics: omission uses snapshot CAS,
which protects concurrent commits but cannot identify an already-stale plan.
Callers should provide recorded preconditions whenever planning ahead.

The authenticated API offers GET /v1/status, GET /v1/catalog,
GET /v1/catalog/<canonical.command>, and POST /v1/command. Requests contain
command, arguments and optional expectedProjectId/expectedProjectEpoch guards.
Results retain the facade {ok:true,value} / {ok:false,error} envelope.
The live endpoint descriptor publishes commandApi discovery metadata. No token
appears in status, catalog, logs or renderer events. Local loopback, short-lived
tokens, bounded request bodies, root containment and access checks remain.
The old desktop /mcp route is removed after adapter migration.

## Concurrency and lifecycle

Short-lived clients reuse the desktop's external facade. All clients share that
external writer identity: the lease is not a per-client exclusive lock. Revision
CAS and atomic serialization arbitrate writes. Human edits use the same revision
and undo history. Read-only access rejects writes independently of client behavior.

Project identity and an opaque project-opening epoch travel through request-local
async context to the renderer. The renderer checks them before operations and
inside queued writes, including after asynchronous media preparation. Reopening
the same project creates a new epoch. Explicit plan guards reject work prepared
for another opening; automatically capturing current identity protects only
against in-flight switches. Old plans must preserve identity and expectedRevision
from their read. Selection-based operations should preserve context revision too.

Idempotency records are scoped to the facade session and project opening. Only
commands with safe catalog retry semantics may be retried automatically. A CLI
invocation reuses its key across network retries; cross-process recovery requires
the caller's explicit key and identical payload. No automatic retry regenerates
a key after an uncertain commit. Jobs survive CLI exit and inactivity lease
release, but not an explicit desktop session shutdown. job wait is client polling.

## Output and compatibility

Machine-readable JSON is the CLI default; stderr carries diagnostics. Human
formatting is opt-in. Field projection preserves envelope and safety metadata.
Large results are saved outside the source tree and returned by path and summary.
Image artifacts are translated into bounded MCP blocks in the adapter.
Legacy reelterminal-live-mcp/openreel-live-mcp names invoke the same adapter.
Installed desktop distributions include a runnable CLI launcher; a source build
also supports node apps/desktop/dist/reelctl/index.js.

## Retired features and migration order

1. Catalog and canonical schemas.
2. Command API alongside the former route during implementation.
3. CLI plus installed launchers and high-frequency aliases.
4. MCP adapter parity, then removal of the old HTTP MCP route.
5. CLI-first docs and Agent Access interface.
6. Removal of chat, onboarding, App Server/conversation adapters, automatic visual
   injection, work-mode notifications and conversation descriptor infrastructure.

Voiceover/music prompt submission and retries are disabled until an independent
task mechanism exists. Existing task records and generated artifacts are retained.
This migration does not delete user data or install/configure an external Agent.

## Acceptance

Validate facade schemas and business regressions; loopback authentication,
malformed requests, catalog discovery and stale project guards; CLI JSON and
exit codes; shared-state calls across independent CLI processes; MCP equivalence;
atomic failure, idempotent response-loss replay, revision conflict and shared undo;
job lifetime/cancellation; renderer reload and access revocation. Build the desktop
and renderer, and smoke-test the actual launcher rather than only package metadata.
