# Transport Audit

Baseline `2566c34e0f8ea22992a85f3ff16e048307b49365`. Synthesized from
`audit/areas/desktop-mcp.md` (primary), `livehost-state.md` §5, `agent-runner-headless.md` (CLI).

## Transport inventory

| # | Transport | Endpoint / channel | Auth | Executor authority | Txn semantics | Evidence |
|---|-----------|--------------------|------|--------------------|---------------|----------|
| 1 | MCP JSON-RPC over HTTP | `POST http://127.0.0.1:<port>/mcp` (random port or `OPENREEL_MCP_PORT`) | static-per-session Bearer token, `timingSafeEqual`, required on every method incl. `tools/list`; 4MB body cap | renderer `LiveEditorHost` via IPC `openreel:mcp:request` → `handleMcpBridgeRequest` → `runExclusive(executeTool)` | **none** — fire-and-forget per call | desktop-mcp.md F1,F2,F7 |
| 2 | stdio shim `openreel-mcp` (bin) | stdin NDJSON → HTTP POST | reads `{url,port,token}` from `~/.openreel/mcp-endpoint.json` (0600) | same as #1 | same as #1 | desktop-mcp.md F4,F5 |
| 3 | Electron IPC | 58 zod-validated `openreel:*` channels + export MessagePort + aurora fork-IPC | implicitly same-process | main-process services / renderer | per-channel | desktop-mcp.md F12 |
| 4 | Agent chat loop (in-app) | n/a (in-process) | BYOK LLM key | LiveEditorHost via `runTurn` | **one EditingHost txn per turn**; commit on every stop incl. budget; rollback on throw only | agent-runner-headless.md F2; core-actions.md CORE-01 |
| 5 | Headless CLI (`openreel-agent`) | n/a (in-process) | BYOK env keys | HeadlessHost via `runHeadlessEdit` | same turn-txn, snapshot rollback; NO confirmGate passed | agent-runner-headless.md F18-F19, RUNNER-01 |
| 6 | GPU job runner | HTTPS `POST /jobs`, poll `GET /jobs/{id}` 2s/10min | broker JWT via **open unattested** challenge/token legs (`X-Bundle-ID`) | remote GPU workers | none; export-queue is an unwired library pool | agent-runner-headless.md F13-F15 |

## Findings that shape the facade contract

1. **Tool exposure is unfiltered.** `toMcpTools()` returns all 304 tools including raw
   `execute_action`/`batch_actions` (mcp-listener.ts:178-180). Destructive/expensive gating
   depends on `mcpAutoAllowTrustedLocal` which **defaults to true** (settings-store.ts:129) —
   any local process with the token can run destructive tools unattended. Confidence HIGH.
2. **No atomicity crosses any transport.** MCP calls are per-call; `batch_actions` is
   non-atomic (CORE-01); timed-out calls keep mutating (no cancel propagation;
   renderer-bridge.ts:39-68). Confidence HIGH.
3. **No idempotency.** Every write mints a fresh action id (`genId()`); retried MCP calls
   duplicate state (registry.ts:31519-31521 for execute_action). Confidence HIGH.
4. **No headless transport.** The MCP server requires an open editor window
   (renderer-bridge.ts:35-38) — desktop MCP cannot serve a windowless runtime. The headless
   entry that exists (`openreel-agent` CLI) is prompt-driven one-shot, not a server.
   Confidence HIGH.
5. **Timeouts are long and caller-side only:** 10s list / 120s call / 30min for 11
   long-running tools (export_video etc.). Async-job handles do not exist on any transport.
   Confidence HIGH.
6. **Token surface is wide:** endpoint file (0600) + `mcpGetStatus` returns the live token to
   the renderer + Settings UI displays/copies it (McpPanel.tsx:119-206). Confidence HIGH.
7. Security posture otherwise decent: loopback-only bind, contextIsolation+sandbox,
   zod-validated IPC (a few bypass schemas). Preload exposes arbitrary-path FS + keychain
   (DESK-03). Confidence HIGH.

## Verdict

The existing MCP transport is a **debugger-grade** channel: correct for a trusted local
copilot, not for an external orchestrator. The facade should NOT reuse the desktop MCP path
for the first slice (it requires a GUI window, lacks atomicity/idempotency, and leaks the
token); the correct seam is `executeTool(name, args, EditingHost)` (executor.ts:32) behind a
new thin transport, with the desktop shim kept for interactive parity only.
