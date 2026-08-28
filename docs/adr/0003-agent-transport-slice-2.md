# ADR 0003: Agent Transport — Slice 2 (MCP stdio + minimal CLI + SKILL)

- Status: **Proposed** (transport audit only — no implementation lands in this slice)
- Date: 2026-08-28
- Branch: `audit/slice-2-transport`
- Context: ADR 0001 (headless facade; §5 gates transports on Desktop-MCP
  hardening), ADR 0002 (Chromium runtime; containment, watchdog, honest
  capabilities), `audit/transport-audit.md` (debugger-grade verdict on the
  upstream MCP path), `audit/facade-v0.md` (contracts #1–#7), the 12-verb
  `@openreel/agent-facade` as it exists on `main` (684289a).

> Editorial note: `docs/*` is git-ignored outside a few whitelisted paths
> (`docs/adr/`, `docs/slice-1b/`, …), and this slice may not modify
> `.gitignore`. The audit deliverables (inventory, mapping, client facts,
> E2E contract, adversarial review) therefore ride as appendices of this
> ADR instead of separate files. If the whitelist is ever widened they can
> be split out without changing a claim.

## Decisions

### 1. One long-lived stdio MCP server process == one `AgentFacadeSession`

`serve` runs a single MCP server over **stdio**. The process owns exactly
one `AgentFacadeSession` for its whole lifetime; the session owns exactly
one project (facade lifecycle — `project.create` is
single-initialization, ADR 0001 addendum §1). There is no TCP listener:
the only socket the process opens is the ones Chromium/ffmpeg need.
Multi-project work means multiple `serve` processes, each with its own
`mediaRoots`/`artifactRoot`/provider set. Session configuration
(`mediaRoots`, `artifactRoot`, provider wiring) happens **only** at
process start (flags/env, Appendix B.4) — no tool can widen the roots
after start, because the facade config is constructor-only and the
transport refuses to fake a setter.

Rationale: the facade's entire guarantees stack (serialized lane, revision
counter, idempotency ledger, job registry) is per-session and in-memory.
Any transport shape that pretends state survives the process (HTTP service
with reattachment, "resume" across restarts) would be a lie of exactly the
kind ADR 0001 §5 forbids. stdio makes client lifetime == session lifetime
structurally true instead of enforced by convention.

### 2. The 12 facade verbs map 1:1 to 12 MCP tools; the 304-tool registry stays internal

Exactly one MCP tool per facade verb, flat underscore names
(`session_describe`, `capabilities_get`, `project_create`,
`project_get_state`, `media_import`, `timeline_get`, `edit_apply`,
`preview_render_frame`, `export_start`, `job_status`, `job_cancel`,
`verify_artifact`) — MCP/client namespaces favor `[A-Za-z0-9_-]`, and the
Claude Code client constrains input-schema **property** names to the same
class (Appendix C), so dot-forms are dropped at the tool layer only; the
facade verb names remain the contract (tools echo `verb` where useful).
No tool is added for anything a verb cannot already express — not
`doctor`, not config, not project switching. `packages/agent`'
`toMcpTools()` (304 tools) is **never** called by this transport; the
registry stays the internal/live surface (ADR 0001 §1,
`audit/facade-v0.md` "Why not expose the 304 directly").

### 3. CLI minimal form: `serve` · `run` · `doctor` — sufficient, and honest about state

One package (proposed name `@openreel/agent-transport`, non-binding) with
one binary and three subcommands:

- `serve` — the MCP stdio server of §1. This **is** the persistent
  session; nothing else pretends to be.
- `run --workflow <file.json|file.jsonl>` — one process, **one fresh
  facade session**, executes the workflow (one step per JSON line/object;
  each step = `{verb, params}`), writes one JSON line per step result to
  stdout. `run` is explicitly stateless across invocations: no project
  file I/O exists in the verb set (no `project.open`/`save`), so a
  workflow is a single in-process session from `project.create` to
  `verify.artifact`. This is *not* a disguised session and must never grow
  one — cross-invocation persistence arrives only with facade open/save
  verbs (slice 3+, listed as a product decision).
- `doctor` — runs the real preflights (Chromium launch probe,
  ffmpeg/ffprobe resolution, codec checks via the runtime probe path,
  configured roots, provider availability) and prints one machine-readable
  JSON report to stdout; exit code says usable / degraded / unusable.
  `doctor` is the "read the truth before trusting the session" command and
  the first thing SKILL.md tells an agent to run.

Verdict: **this form is enough for slice 2.** It covers every client class
in Appendix C (MCP clients use `serve`; shell-capable agents without MCP
clients, e.g. Pi today, use `run` + `doctor`). It contains no one-shot
commands wearing a session costume: anything that mutates state across
processes is impossible in this verb set, and the CLI does not fake it.

### 4. Schema single source of truth: JSON Schemas exported BY the facade, imported (never copied) by transports

Today the facade validates with hand-rolled closed `ObjectSchema`s
(`packages/agent-facade/src/validate.ts`, per-verb constants in
`session.ts`) — strict, audited, zero-dep — and **no** JSON Schema exists
for the verb params anywhere. MCP `tools/list` requires an `inputSchema`
per tool, so something must generate them. Mechanism (concrete):

1. `@openreel/agent-facade` gains a pure-data module (proposed
   `src/schemas.ts`) exporting `FACADE_TOOL_SCHEMAS: Record<FacadeVerb,
   JsonSchema>` (draft 2020-12), written **side-by-side with** the runtime
   `*_SCHEMA` constants in `session.ts` — same file neighborhoods, one PR
   reviews both halves of any change.
2. The transport imports the schemas and assigns them verbatim:
   `tool.inputSchema = FACADE_TOOL_SCHEMAS[verb]`. It never declares a
   schema of its own. A CI assertion deep-equals every exported
   `tools/list` entry against the facade export (copy-drift dies here).
3. A CI **differential test** pins semantic equivalence: for each verb, a
   fixed adversarial corpus (valid payloads + one payload per failure
   class: unknown field, missing required, wrong type, enum violation,
   plus a deterministic mutation sweep of each corpus entry) must classify
   identically under (a) the facade's runtime `validateObject` validators
   and (b) the exported JSON Schema evaluated by ajv (devDependency of the
   transport only — the facade stays dependency-free).
4. Client constraints shape the schemas up front (Appendix C): flat
   top-level objects, property names `^[A-Za-z0-9_-]{1,64}$`, no
   root-level `anyOf`/`oneOf`/`allOf` (Claude Code flattens those with
   lossy notes), no `$ref` (not dereferenced by at least one major
   client). `edit_apply`'s discriminated op union lives as a nested
   `anyOf` inside `items`, which is allowed where root-level combinators
   are not.
5. **Known, bounded drift surface — cross-field constraints.** Some
   facade rules are not expressible in plain JSON Schema: `clip.trim`
   requires at least one of `inPoint`/`outPoint`; `verify.compare.region`
   requires `x+width ≤ 1` and `y+height ≤ 1`. The twin schemas are
   therefore a **superset filter at the boundary**, and the runtime
   validators remain the only authority: a payload can be schema-valid
   and still fail `INVALID_PARAMS` at the facade, and the differential
   test must assert exactly that ordering (schema-valid ⇒ facade decides;
   schema-invalid ⇒ facade would also reject). The transport never
   pre-validates against the schema beyond what the MCP client itself
   does — rejecting early would mean a second validator with its own
   drift.

Alternative considered and rejected for this slice: make zod the single
source (zod infers TS types, `zod-to-json-schema` emits MCP schemas,
facade validators replaced by `.parse()`). Rejected because it rewrites
the audited validation layer (ADV-03 strict-params semantics,
sanitizing-copy behavior), adds a runtime dependency to the pure facade,
and the tree's zod versions are split (3.22.3 / 3.25.76 / 4.4.3 in
`pnpm-lock.yaml`) — churn with no transport-visible win. Revisit if verb
widening makes twin-maintenance painful (tracked as a product decision).

### 5. Facade guarantees must arrive at the agent undamaged — the transport adds nothing and removes nothing

- **Error codes.** All 8 codes (`INVALID_PARAMS`, `NOT_FOUND`, `CONFLICT`,
  `UNSUPPORTED`, `CONFIRMATION_REQUIRED`, `JOB_FAILED`, `ACTION_FAILED`,
  `INTERNAL`) cross verbatim: a domain failure is the tool result
  `isError: true` with content being the full `FacadeErrorBody` JSON
  (`{code, message, details}`). Domain failures are never converted to
  JSON-RPC protocol errors and never string-mangled; agents match on
  `code`, mirroring `errors.ts`'s rule. Transport-level failures (bad JSON
  frame, unknown method) use JSON-RPC protocol errors — a separate,
  non-overlapping channel.
- **Revision / idempotency.** `expectedRevision` and `idempotencyKey`
  pass through in every mutating tool's schema, untouched. The transport
  never mints keys, never retries a mutating call on the agent's behalf,
  and never hides a `CONFLICT` — silent transport-side retry/dedupe would
  mask exactly the bugs the ledger exists to surface. SKILL.md teaches
  key discipline: one key per logical mutation, and a retry reuses the
  same key with the byte-identical payload.
- **Jobs.** `export_start` already returns `{jobId, state:"queued"}`
  immediately; `job_status`/`job_cancel` are plain tools. This shape is
  what makes default client tool timeouts (Codex `tool_timeout_sec` 60 s,
  DSH `toolCallTimeoutMs` 60 000, both official-documented) a non-issue:
  no tool call is ever long-blocking by design. The poll loop belongs to
  the agent (SKILL.md gives the cadence and terminal-state exit
  conditions).
- **Capability honesty.** `capabilities_get`/`session_describe` are
  passthrough to the live provider preflights (ADR 0002: availability
  flips only when a preflight passed *in this session*). The transport
  reports the MCP server's own facts (pid, args, contract version) in
  `serverInfo`/initialization only — never as capabilities. A tool whose
  capability is unavailable fails `UNSUPPORTED` with the provider's
  reason, exactly as in-process.

### 6. stdout carries protocol; stderr carries logs; paths stay contained where the facade already contains them

- **stdout**: MCP JSON-RPC frames in `serve`; the documented one-JSON-line-
  per-step stream in `run`; the `doctor` report — nothing else, ever.
  Every child process (Chromium via Playwright, ffmpeg/ffprobe) is spawned
  with stdio that cannot inherit the transport's stdout (pipe → forwarded
  to stderr or swallowed). The transport installs a fail-fast guard in
  tests: any non-protocol byte on stdout in CI fails the suite. Playwright
  debug logging is opt-in via env and lands on stderr.
- **stderr**: single-line JSON logs (`{ts, level, scope, msg, …}`),
  level-gated by env (`OPENREEL_TRANSPORT_LOG=error|info|debug`).
  Human-facing `console.*` from dependencies is redirected here.
- **Paths.** `mediaRoots`/`artifactRoot` are startup-only (§1) and are
  enforced by the facade exactly as built and tested: realpath
  containment for imports (`resolveContainedPathDetailed`), symlink/
  junction refusal plus pre- and post-write containment for artifacts,
  `.part`-then-rename, post-write escape removal (ADR 0002 A5). The
  transport passes paths verbatim — it never rewrites, resolves-relative-
  silently, or "helpfully" expands `~` into a root, and it never adds a
  root at runtime. `doctor` echoes the configured roots so the agent can
  verify where it is allowed to touch. URLs are refused by the facade
  already (`hasUrlScheme`), and the transport does not loosen that.

### 7. Cleanup matrix (who cleans what, when)

| Trigger | Actions | Guaranteed residue |
|---|---|---|
| Clean shutdown (stdio EOF / client exit / `shutdown`) | Stop accepting calls → request cancel on every non-terminal job (bounded wait, the facade's own 10 s cancel race, invoked through the public `job.cancel` verb path — no back doors) → dispose provider runtime (bounded graceful teardown, ADR 0002 A7) → flush stderr logs → exit 0 | None new. Artifacts persist (they are the deliverable); a cancelled export leaves no success-looking file (`.part` sweep) |
| `SIGINT` / `SIGTERM` | Same disposal path, same bounds; exit 130/143 | Same as above |
| Client abrupt disconnect (stdin EOF without handshake) | stdio EOF *is* the disconnect signal; identical to clean shutdown. No half-open connections exist on stdio — the class of "client vanished but server keeps serving" bugs cannot occur | Same as above |
| `SIGKILL` / hard crash | Nothing in-process runs. Job dies with the process; job registry (in-memory) is gone; an in-flight export leaves `exports/<jobId>/*.part` | Inert `.part` in a unique per-job directory — never a valid-looking artifact (rename-on-success, ADR 0002 §5). GC is future work (product decision) |
| Running export at any shutdown | Best-effort cooperative cancel first (job settles `cancelled`/`error`); if the window is lost, the `SIGKILL` row applies | Same as above |
| Chromium crash / watchdog mid-job | Handled entirely inside `@openreel/runtime-chromium` (recycle + generation bump, exactly-once terminalization, ADR 0002 A6/A7). Transport is a bystander; next capability read re-preflights honestly | None new |
| SKILL contract for agents | Poll `job_status` to a terminal state **before** disconnecting; a session that dies takes its jobs with it (documented facade limitation, not restart-durable) | — |

### 8. Context budget: compact-by-default reads, path-not-pixels, and SKILL-taught discipline

| Result | Size behavior | Transport/SKILL contract |
|---|---|---|
| `project_get_state` | Unbounded (full canonical `Project` clone — the hydration contract) | SKILL: use `timeline_get` for orientation; `project_get_state` only when a full dump is truly needed. Paging/summary verbs are a facade change (slice 3 product decision), not transport-side field-dropping |
| `timeline_get` | Compact by design (facade view: tracks/clips/text only) | Preferred read verb |
| `preview_render_frame` | Returns `{path, sizeBytes, sha256, …}` — **never** pixel bytes | MCP image content blocks stay **off** by default (config flag, product decision). Visual truth is obtained via `verify_artifact` compare numbers, not by inlining PNGs |
| `verify_artifact` | Bounded report (`checks[]`, probe fields, compare numbers) — evidence files stay on disk, referenced by path | SKILL: assert on `checks[].pass` |
| `job_status` | Small | SKILL: poll every 2–5 s, stop at terminal state; don't spin |
| Errors | Bounded `{code, message, details}` | — |

Client-side ceilings that make this mandatory (Appendix C): Claude Code
warns past 10 k tokens and defaults `MAX_MCP_OUTPUT_TOKENS` to 25 000,
after which output is truncated/replaced by a file path; tool
descriptions/instructions are truncated at 2 KB. Results that cannot fit
are a contract failure, not a runtime surprise — hence compact-by-default
at the source.

### 9. SKILL.md: one skill, discovery + workflow only, no second brain

One transport-agnostic SKILL.md ships in the repo. It teaches: how to
configure `serve` per client (snippets for Codex/Claude Code/DSH; the
`run`+`doctor` path for MCP-less agents), to run `doctor` and
`capabilities_get` **first** and to trust their reasons when a capability
is unavailable, the 12 tools and their one-line purposes, the
mediaRoots/artifactRoot world model, idempotency-key discipline, the
`export_start` → poll → `verify_artifact` loop, and the "disconnect kills
jobs" rule. It does **not**: restate parameter defaults or semantics that
live in the facade (it links), add fallback behaviors or retries the
facade doesn't have, carry client-specific tool variants (the same 12
tools for every client; per-client config snippets are configuration, not
variants), or encode any business decision the verbs should have made.
If a capability is missing, the skill's instruction is "read
`capabilities_get`'s reason", never "do this instead" — a second logic
layer in prose would drift exactly like a second schema would.

## Consequences

- No product code changes: the facade's runtime behavior and the runtime
  package land **unchanged**; the only facade addition is the data-only
  schema module of Decision 4 (2a). Slice 2 adds a new transport package
  and the SKILL. ADR 0001 §5's
  Desktop-MCP gate is untouched — this transport **does not reuse** the
  desktop path (Appendix A), so the gate is not a blocker for a Proposed
  slice, but exposure still does not widen beyond what a Draft PR implies.
- New runtime dependency recommended for the transport package only:
  `@modelcontextprotocol/sdk` (absent from the workspace today — 0 hits in
  `pnpm-lock.yaml`; the desktop MCP is hand-rolled). Adopting the SDK is a
  product decision (Appendix F); hand-rolling a minimal stdio JSON-RPC
  layer is the fallback, using `apps/desktop/src/main/mcp/core.ts` as
  prior art, *not* as imported code.
- No restart durability anywhere: session, ledger, and jobs die with the
  process — now true of the whole agent surface, stated in SKILL and
  doctor output.
- The E2E contract (Appendix D) is defined but **not executed** in this
  slice; executing it is the next slice's deliverable, with committed
  evidence under `docs/slice-2/` (requires a maintainer `.gitignore`
  whitelist entry — product decision).

---

## Appendix A: Transport inventory / reuse matrix

Letters: **P** production-ready as-is (reuse) · **A** adapt (reuse with
modification) · **C** create new · **X** exclude (do not import; prior art
at most). Reuse estimates are of the slice-2 transport's *total surface*.

| # | Asset | Where | What it is | Verdict | Notes / reuse |
|---|---|---|---|---|---|
| 1 | `AgentFacadeSession` + 12 verbs | `packages/agent-facade/src/{session,types,errors,idempotency,jobs,capabilities}.ts` | State semantics: atomic batches, revision, ledger, job registry, capability preflight, containment | **P** | ~100% reused unchanged. This is the product; the transport is a socket on it |
| 2 | Closed-schema validators | `packages/agent-facade/src/validate.ts` + per-verb schemas | Strict boundary validation, zero deps | **P** | Unchanged. Twin JSON Schemas (Decision 4) are the only addition |
| 3 | Providers (render/export/verify) | `packages/runtime-chromium` | Chromium pixels, H.264 export, ffprobe verify, watchdog/recycle | **P** | Reused verbatim; transport only constructs and disposes them |
| 4 | MCP JSON-RPC core | `apps/desktop/src/main/mcp/core.ts` | Hand-rolled initialize/tools-list/call, protocol 2024-11-05→2025-06-18, content blocks; unit-tested | **X** (prior art) | Architecturally fine but bound to the desktop tool-provider shape; superseded by SDK (or a fresh minimal core). Read, don't import |
| 5 | Renderer-bridge dispatcher | `apps/desktop/src/main/mcp/dispatcher.ts`, `renderer-bridge.ts` | callId-correlated IPC promises; **timeouts abandon calls that keep mutating** | **X** | Its timeout semantics are DESK-04 — the exact trap this slice must not reproduce. Not needed: stdio is single-caller request/response |
| 6 | Loopback HTTP server + bearer auth | `apps/desktop/src/main/mcp/http-server.ts` | 127.0.0.1 bind, timing-safe token, 4 MB body cap, tested | **X** for v0 | Good engineering, wrong default: Decision 1 forbids TCP. Revisit only behind a future explicit remote-transport ADR |
| 7 | stdio shim | `apps/desktop/src/mcp-shim/index.ts` | readline stdio → HTTP forwarder, endpoint file w/ token | **X** | Exists to bridge to #6; pattern (readline framing, 0600 endpoint file) noted for `serve`'s own stdio loop |
| 8 | 304-tool registry + `toMcpTools()` | `packages/agent/src/registry.ts` (31 930 lines) | Internal/live editing surface | **X** — **never exposed** | The audit's central prohibition (`audit/facade-v0.md`). Stays internal |
| 9 | `openreel-agent` CLI | `packages/agent-runner/src/cli.ts` + `run.ts` | LLM-driven headless editor (BYOK keys, prompt in → LLM loop → project mutated) | **X** | An LLM *orchestrator*, not an agent-facing transport; drives the 304 registry. Its `bin` + tsup packaging is the (trivial) pattern to copy |
| 10 | LLM loop / hosts / evals | `packages/agent-runner/src/{run,node-llm,evals}`, `packages/agent/src/{loop,host,headless-host}` | BYOK turn loop over registry | **X** | Same reason as #9; orthogonal to transport |
| 11 | MCP SDK | — (`@modelcontextprotocol/sdk`) | stdio server, framing, protocol negotiation | **C** (adopt) | Production-ready upstream; new dep confined to the transport package. Product decision F.1 |
| 12 | JSON Schema evaluation (CI only) | — (`ajv`) | Differential schema test | **C** | devDependency of transport only; facade stays pure |
| 13 | CLI arg parsing | `packages/agent-runner/src/cli.ts` pattern | ~80-line hand-rolled switch | **A** (pattern) | 3 subcommands need no framework. commander/yargs/cac exist in-tree only as transitive deps — not first-party, not adopted |
| 14 | stdio handling | `node:readline` (as in `mcp-shim`) / `process.stdin` | NDJSON framing | **C** (trivial) | — |
| 15 | Config loading | Desktop env-var + endpoint-file precedent | Flags + `OPENREEL_*` env | **C** (minimal) | No config library exists or is added; see B.4 |
| 16 | Binary packaging | `tsup` (used by agent-runner, desktop) | Single-file bin | **P** | In-tree, proven |
| 17 | zod | `apps/desktop@^3.23.8`; 3.x/4.x split in lock | Schema→types | **X** for slice 2 | Rejected as schema source (Decision 4); exists in tree, not in facade |
| 18 | Chromium E2E scenario | `packages/runtime-chromium/examples/hello-world-e2e.mts` | create→import→trim→text→PNG→MP4→verify | **A** | Template for Appendix D's scenario; re-expressed as agent-driven tool calls |

**Reuse ratio estimate:** ≈85–90 % of slice 2's shipped behavior is
existing, tested facade + runtime code; the new code is the schema twin
(data), the stdio server shell, `run`, `doctor`, and SKILL.md. The risk
concentrates where the new code is: framing, lifecycle, and the honest
cleanup matrix — hence Appendix E.

## Appendix B: 12 verbs → MCP tools / CLI mapping + schema ownership

### B.1 Tool map (complete; no other tools exist)

| Facade verb | MCP tool | CLI `run` step verb | Mutating? | Notes |
|---|---|---|---|---|
| `session.describe` | `session_describe` | same | no | Facade self-description (verbs, error codes, step letters) — distinct from MCP `initialize` |
| `capabilities.get` | `capabilities_get` | same | no | Live provider preflights |
| `project.create` | `project_create` | same | lifecycle | No `expectedRevision` (single-initialization); `idempotencyKey` only |
| `project.get_state` | `project_get_state` | same | no | Full canonical dump (Decision 8) |
| `media.import` | `media_import` | same | yes | Path inside `mediaRoots`; URLs refused |
| `timeline.get` | `timeline_get` | same | no | Compact view — preferred read |
| `edit.apply` | `edit_apply` | same | yes | Closed op set; atomic; `expectedRevision` + `idempotencyKey` |
| `preview.render_frame` | `preview_render_frame` | same | no* | *Replay/ledger only; artifact to `artifactRoot` |
| `export.start` | `export_start` | same | no* | *Snapshot job; returns `jobId` immediately |
| `job.status` | `job_status` | same | no | Poll to terminal |
| `job.cancel` | `job_cancel` | same | no | Cooperative; idempotent on terminal jobs |
| `verify.artifact` | `verify_artifact` | same | no | ffprobe/pixel checks as data |

### B.2 Tool descriptions

Hand-written, one short string per tool in the transport (well under the
2 KB truncation some clients apply — Appendix C). A description names the
verb's purpose and nothing else: no parameter semantics, no defaults, no
workarounds — those live in the facade and the SKILL, and a description
that restates them is drift waiting to happen.

### B.3 `edit_apply` inputSchema (illustrative twin, shape pinned by Decision 4)

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "ops": {
      "type": "array", "minItems": 1,
      "items": { "anyOf": [
        { "type": "object", "additionalProperties": false,
          "properties": { "op": {"const": "track.add"},
                          "trackType": {"enum": ["video","audio","image","text","graphics"]},
                          "trackId": {"type": "string", "minLength": 1} },
          "required": ["op", "trackType"] },
        { "type": "object", "additionalProperties": false,
          "properties": { "op": {"const": "clip.add"},
                          "trackId": {"type": "string", "minLength": 1},
                          "mediaId": {"type": "string", "minLength": 1},
                          "startTime": {"type": "number", "minimum": 0},
                          "duration": {"type": "number"},
                          "inPoint": {"type": "number"},
                          "outPoint": {"type": "number"},
                          "clipId": {"type": "string", "minLength": 1} },
          "required": ["op", "trackId", "mediaId", "startTime"] },
        { "...clip.trim..." }, { "...text.create..." }
      ]}
    },
    "expectedRevision": {"type": "integer", "minimum": 0},
    "idempotencyKey": {"type": "string", "minLength": 1}
  },
  "required": ["ops"]
}
```

Root is a flat object (client-safe); the union is nested in `items`.
Result content is the `FacadeResult` JSON verbatim; `ok:false` ⇒
`isError: true`.

### B.4 Result envelope contract

Every tool result = the facade's `FacadeResult<T>` serialized as the
single text content block (`structuredContent` also populated if the
chosen SDK/spec revision supports it — verify at implementation time):
success ⇒ `{ok:true, value:{…}}`; domain failure ⇒ `{ok:false,
error:{code, message, details?}}` **and** `isError: true`. Agents never
parse prose.

### B.5 Process configuration (the only config surface)

Flags beat env beats defaults; no config files (none exist in-repo today):

```
openreel-agent-transport serve \
  --media-root /abs/a --media-root /abs/b \
  --artifact-root /abs/out \
  --log-level info          # stderr JSON logs
```

Env equivalents: `OPENREEL_AVE_MEDIA_ROOTS` (path-separator list),
`OPENREEL_AVE_ARTIFACT_ROOT`, `OPENREEL_TRANSPORT_LOG`. Absent roots are
honest: imports/artifacts then fail `UNSUPPORTED` with the facade's own
message, and `doctor` says so. (Names proposed; mechanism is the
decision.)

### B.6 `run` workflow format

```jsonl
{"verb":"project.create","params":{"name":"Demo","idempotencyKey":"c1"}}
{"verb":"media.import","params":{"path":"/abs/a/input.mp4","idempotencyKey":"i1"}}
{"verb":"edit.apply","params":{"ops":[…],"expectedRevision":2,"idempotencyKey":"e1"}}
{"verb":"export.start","params":{"idempotencyKey":"x1"}}
{"verb":"job.status","params":{"jobId":"job-…"}}
{"verb":"verify.artifact","params":{"path":"…","expect":{"container":"mp4","videoCodec":"h264"}}}
```

One JSON line in → one JSON line out (`{index, verb, result}`), in order,
through the session's serialized lane; first `ok:false` fails the run
(exit 1) unless `--keep-going`. Logs → stderr. Re-run semantics, stated
plainly: a second `run` starts a **fresh session** — the empty ledger
means no cross-process dedupe (that is what `serve` plus agent-owned
idempotency keys are for); the rebuilt project gets a fresh id, so prior
runs' artifacts can never collide, and nothing from a prior run is
reused or overwritten.

## Appendix C: Client compatibility facts (verified sources only)

Probed 2026-08-28: `codex`, `claude`, `pi`, `dsh` are **not installed on
this machine** (`command -v` miss for all four) ⇒ every runtime behavior
below is **documented, not executed** — local-probe column says 未验证 for
all. Facts marked "official" were read from the vendor's own docs/repo on
2026-08-28.

| Fact | Codex | Claude Code | Pi | DSH (deepseek-harness) |
|---|---|---|---|---|
| MCP client | **Yes** (CLI + IDE ext) — official: developers.openai.com/codex/mcp/ | **Yes** — official: code.claude.com/docs/en/mcp | **No** — official README: "No MCP. Build CLI tools with READMEs (see Skills), or build an extension that adds MCP support." (github.com/badlogic/pi-mono) | **Yes**, via optional plugin `@deepseek-ai/dsh-mcp-client` — official: deepseek-ai/deepseek-harness `packages/mcp/mcp-client/README.md` |
| Transports | stdio (`command`/`args`/`env`); Streamable HTTP (experimental, Bearer) | stdio, SSE, HTTP, WebSocket | — (extensions could add one; none built-in per README) | stdio, streamable-http |
| Config surface | `~/.codex/config.toml` `[mcp_servers.<key>]`; project `.codex/config.toml` (trusted projects); `codex mcp add` | `claude mcp add --transport stdio <name> <cmd>`; scopes local/project/user (`.mcp.json`); `add-json`; `${VAR}` expansion | — | YAML plugin entry `{serverName, transport, command/args/env/cwd \| url/headers}` |
| Tool naming | tools exposed as `server.tool` (e.g. `my_server.my_tool`); prompts become slash commands (experimental) — official MCP page | `mcp__<server>__<tool>` | — | `mcp__<serverName>__<tool>`, serverName `[A-Za-z0-9_-]{1,32}` |
| Tool-call timeout default | `tool_timeout_sec` **60 s** (`startup_timeout_sec` 10 s) | `MCP_TOOL_TIMEOUT`/per-server `timeout`; calls >2 min auto-background (v2.1.212+); stdio **no auto-reconnect**; idle 30 min | — | `toolCallTimeoutMs` **60 000**; reconnect on by default (backoff ≤30 s, 10 attempts); `failOnStartupError:false` |
| Output limits | not stated on the MCP page (未验证) | warning >10 k tokens; **`MAX_MCP_OUTPUT_TOKENS` default 25 000** then truncate/persist-to-disk; instructions & tool descriptions truncated at **2 KB**; tool search (deferred loading) on by default | — | not stated (未验证); "the tokens those tool definitions add to every request" noted |
| Schema constraints | not stated (未验证) | property names `^[A-Za-z0-9_-]{1,64}$`; draft 2020-12; root `anyOf/oneOf/allOf` flattened with note; `$ref` not dereferenced (root/property level) | — | not stated (未验证) |
| Skills / SKILL.md | **Yes** — official: developers.openai.com/codex/skills: repo `.codex/skills/`, `$CODEX_HOME/skills/`; `SKILL.md` YAML frontmatter `name`+`description` (≤1024); invoked `$name` or automatic | **Yes** — official: code.claude.com/docs/en/skills: personal `~/.claude/skills/<name>/SKILL.md`, project `.claude/skills/<name>/SKILL.md`, plugin `skills/`, bundled; frontmatter `name`+`description` (≤1024); `allowed-tools`, `disable-model-invocation` | **Yes** — Agent Skills standard: `~/.pi/agent/skills/` (`~/.agents/skills/`), project `.pi/skills/` (`.agents/skills/`) resolved from cwd upward; `/skill:name` or automatic | **Yes** — `@deepseek-ai/dsh-skill-filesystem`: `<name>/SKILL.md` bundle or flat `<name>.md` at scanned roots (project/custom/user; nested `**/SKILL.md` deliberately not discovered); frontmatter `name`+`description` required, `whenToUse`, `disable-model-invocation`, `user-invocable` optional; watched live |
| Headless/scripted mode | not confirmed on the fetched pages (未验证) | `-p` print mode widely referenced but not confirmed on the fetched pages (未验证) | `-p/--print`, `--mode json`, `--mode rpc` (official README) | `npx @deepseek-ai/dsh web` documented; other modes not verified (未验证) |
| Maturity caveat | — | — | independent OSS (badlogic/pi-mono) | **developer preview**, "compatibility-breaking changes" expected (official README); MIT |
| Our fit | `serve` via config.toml + SKILL | `serve` via `claude mcp add` + SKILL | **no MCP** ⇒ `run` + `doctor` via SKILL | `serve` via mcp-client plugin + SKILL |
| Local CLI probe | not installed — 未验证 | not installed — 未验证 | not installed — 未验证 | not installed — 未验证 |

Search-hygiene note: the first DSH search surfaced unofficial
lookalike sites (dshbase.com, dsh.market, …); all DSH facts above come
only from the official `deepseek-ai/deepseek-harness` repository.

## Appendix D: First black-box E2E contract (defined here, executed next slice)

**Scenario name:** `slice2-transport-e2e`. **Actors:** a *fresh* agent
(empty context) of one of the client classes in Appendix C + this repo at
a pinned SHA with dependencies installed. The agent gets ONLY: the repo,
the SKILL, and its client. No human fills in tool calls.

**Environment contract (setup script, not agent work):**
`corepack pnpm install`; `pnpm --filter @openreel/runtime-chromium exec
playwright-core install chromium`; `ffmpeg`+`ffprobe` on PATH; `input.mp4`
(≥5 s, visually distinctive) placed under a `mediaRoots` dir; empty
`artifactRoot` dir; agent never given either path except via config.

**Steps (each assertion is machine-checked; any failure aborts with the
raw result transcript):**

1. **Doctor** — run `doctor`; expect exit "usable"; report lists
   Chromium build, ffmpeg/ffprobe paths, codec preflight results, the two
   roots. (MCP-clients path: `serve` configured per Appendix C and
   connected; Pi-class path: agent authors the Appendix B.5 workflow.)
2. **Discover** — `session_describe`: contract `facade-slice-1b`, 12
   verbs, 8 error codes. `capabilities_get`: `mediaImport.available`
   true; `preview`/`export` available with route details;
   `verify` available. If any is false ⇒ the scenario records the reason
   and **stops honestly** (no workaround may exist in SKILL — that's the
   point of Decision 9).
3. **Create** — `project_create {name, settings:{1920×1080@30},
   idempotencyKey:"s2-create"}` ⇒ ok, revision 0, `replayed:false`.
4. **Import** — `media_import {path:<input.mp4>, idempotencyKey:"s2-imp"}`
   ⇒ ok, `mediaId`; metadata duration ≥5 s.
5. **Edit** — `edit_apply {ops:[track.add video v1, clip.add v1
   mediaId @0 clipId:"c1", clip.trim c1 outPoint 5, track.add text t1,
   text.create "Hello world" t1 0–5 s], expectedRevision:1,
   idempotencyKey:"s2-edit"}`
   ⇒ ok, revision 2 (create→0, import→1, edit→2 — each committed
   mutation bumps exactly once; the trim can reference the clip only
   because clip.add pinned its deterministic id).
6. **Negative path (honesty probes)** — `media_import` with a path
   outside roots ⇒ `INVALID_PARAMS` (escape wording); retry of step 5
   with same key+payload ⇒ identical result `replayed:true`; same key
   different payload ⇒ `CONFLICT`; `timeline_get` shows exactly the
   constructed world.
7. **Preview** — `preview_render_frame {timeSec:2.5}` ⇒ PNG artifact
   `{path, sizeBytes>0, sha256, sourceRevision:2}` inside `artifactRoot`.
8. **Export** — `export_start {idempotencyKey:"s2-exp"}` ⇒ `{jobId,
   state:"queued", sourceRevision:2}`; poll `job_status` (2–5 s cadence)
   to `done` with `artifact` and `route` recorded; total frames implied
   5 s × 30 fps = **150**.
9. **Verify** — `verify_artifact {path:<mp4>, expect:{container:"mp4",
   videoCodec:"h264", width:1920, height:1080, durationSec:5,
   durationToleranceSec:1/30}}` ⇒ `probe.frameCount == 150`, all checks
   pass. **Text pixels (two compares, both over the text's screen
   region):** (a) `compare {referencePath:<step-7 preview PNG>,
   timeSec:2.5, mode:"similar"}` — exported frame matches the preview
   render of the same project/revision; (b) `compare
   {referencePath:<input.mp4>, timeSec:2.5, mode:"different",
   minChangedPixelsRatio:>0}` — the exported frame differs from the raw
   source frame *because* "Hello world" was drawn. (b) is the load-bearing
   pixel proof; (a) guards against the export diverging from the
   previewed model.
10. **Cleanup honesty** — disconnect the client immediately after a
    second `export_start`; restart `serve`; the new session reports no
    project (`NOT_FOUND` on reads) and the old job is gone — and the
    artifactRoot contains **no** success-looking file from the orphaned
    job (only, at most, an inert `.part`).

**Evidence:** committed transcript (tool calls + results), artifacts'
sha256s, client name/version, and the per-step letter table — under
`docs/slice-2/` (whitelist pending, Appendix F). A run may only claim a
client as "verified" when executed by that client's real binary; a
scripted simulator is labeled `simulated`.

## Appendix E: Adversarial review (second pass, 2026-08-28)

Method note (honest): this track could not spawn a separate agent
process — `zcode`/`claude`/`codex`/`pi` CLIs are absent (probed). The
red-team pass below was executed by the same author working strictly from
the attack list, against the written decisions; every finding was either
folded into the text above or accepted as a listed risk. Findings kept
for the record:

1. **Session persistence masquerade** — attack: `run` + a project file
   could quietly become "save/open" and fake durability. *Response:*
   Decision 3 forbids project I/O in `run` (no `project.open`/`save`
   exists to wrap); the workflow is single-session by construction and
   the E2E step 10 pins the truth (fresh process ⇒ no project). Residual:
   none in this slice; reopen if open/save verbs land (they must come
   with their own ADR).
2. **Schema drift** — attack: schemas copied into the transport will rot;
   a schema-valid payload that the facade rejects would surface as a
   mysterious INTERNAL instead of INVALID_PARAMS. *Response:* Decision 4
   makes copies structurally impossible (import + CI deep-equal +
   differential corpus) and pins the drift ordering (Decision 4 ¶5: the
   schema is a boundary superset filter; the facade validators remain the
   only authority for cross-field rules such as `clip.trim`'s
   "at least one of in/out" and `verify` region bounds — the corpus must
   include schema-valid/facade-rejected cases and assert they surface as
   `INVALID_PARAMS`). Residual: the twin
   (`validateObject` ↔ JSON Schema) can still diverge semantically on
   exotic inputs; mitigated by the mutation sweep, accepted as CI-covered
   risk.
3. **stdout pollution** — attack: a dependency (Playwright logger,
   ffmpeg banner, a future transitive dep) prints to fd 1 and corrupts
   the protocol stream. *Response:* Decision 6: spawn discipline (children
   never inherit stdout), dependency console redirection, CI guard
   failing on any non-protocol stdout byte. Residual: a module that
   writes to `fd 1` via `fs.writeSync(1, …)` at import time would slip
   past — the doctor output starts with a known magic line and the E2E
   transcript check would surface it; accepted.
4. **Path escape** — attack: transport-level path "normalization", a
   root set to `/`, symlinked roots, `~` expansion, mid-session root
   widening. *Response:* transport never rewrites paths and roots are
   startup-only (§1, Decision 6); containment is facade-owned and
   tested (realpath, link refusal, pre/post-write, `.part`+rename). A
   root *configured* to `/` is a caller decision the facade containment
   still bounds (imports/artifacts then reach only what `/` containment
   allows — i.e. everything — so `doctor` explicitly labels
   over-broad roots as a warning). Residual: hostile *caller-chosen*
   roots are out of scope by contract (the operator configures roots;
   SKILL says so).
5. **Disconnect cleanup** — attack: client dies mid-export; server
   lingers as a zombie holding Chromium. *Response:* Decision 7 makes
   stdin EOF the shutdown signal with the same bounded disposal path;
   Chromium disposal is the runtime's bounded teardown (ADR 0002 A7).
   Residual: SIGKILL leaves a live Chromium child until its own exit —
   Playwright kills the browser on parent death via its zombie
   protection (未验证 on every platform; recorded for implementation to
   re-verify and, if needed, add an explicit `--browser` reaper).
6. **Job races** — attack: cancel arriving as the job finishes; two
   clients… (single caller); export.start replay while job terminalizes.
   *Response:* terminalization is exactly-once inside the facade/runtime
   (ADR 0002 A6); `export_start` replay returns the job's *current*
   state; `job_cancel` on a terminal job is an idempotent no-op. The
   transport serializes all calls through the session lane, so no new
   interleavings exist at the transport layer. Residual: none newly
   introduced; facade-owned behavior unchanged.
7. **Context bloat** — attack: an agent fetches `project_get_state` on a
   huge project and truncation corrupts it silently; preview PNGs
   inlined; polling spam. *Response:* Decision 8 (path-not-pixels,
   compact-by-default, SKILL poll cadence) + client ceilings documented.
   Residual: nothing prevents an agent from dumping a huge project into
   its own context — that is the agent's budget to spend; the *contract*
   failure would be the facade promising more than the transport
   delivers, which truncation (not lying) covers. Facade paging verbs
   remain the real fix (Appendix F, product decision).

Verdict: **no finding invalidates a Decision**; two items (browser-reaper
verification, over-broad-root doctor warning) become implementation-slice
requirements; the rest is accepted, documented risk.

## Appendix F: Implementation slices, risks, and product decisions

**Suggested slices** (each lands tested; none touches product code):

- **2a — schema single-source:** facade `schemas.ts` (12 JSON Schemas) +
  differential corpus test. Pure data; unblocks everything else.
- **2b — `serve`:** transport package, SDK adoption, stdio server, 12
  tools, Decision 5/6/7 contracts, stdout guard in CI.
- **2c — `run` + `doctor`:** workflow executor + honest environment
  report (incl. over-broad-root warning, browser-reaper verification from
  Appendix E).
- **2d — SKILL + black-box E2E:** SKILL.md (Decision 9), execute Appendix
  D against ≥2 real clients, commit evidence.

**Risk register (slice-specific):** SDK/spec revision churn (pin exact
version; 2025-03-26 vs 2025-06-18 framing differences) · stdout
pollution by transitive deps (guard) · client timeout defaults (60 s
Codex/DSH — solved by the job shape; document per-client config for
`preview_render_frame` on huge projects) · Claude 25 k-token ceiling vs
`project_get_state` (Decision 8; paging product decision) · jobs/ledger
die with process (documented; SKILL rule) · `.part` residue after SIGKILL
(inert; GC decision) · in-memory ledger growth on a long-lived `serve`
(product decision: ledger GC or session-uptime guidance) · DSH
developer-preview churn (evidence re-run per release) · one
server=one project means N projects need N connections (stated, not
solved).

**Product decisions requested:**

1. Adopt `@modelcontextprotocol/sdk` in a new `packages/agent-transport`
   (package/bin names non-binding) vs hand-rolled minimal stdio core.
2. Facade paging/summary read verbs (`project.state_summary` /
   `get_state` paging) for slice 3 — the real context-budget fix.
3. Facade `project.open`/`save` verbs (prerequisite for any CLI persistence
   story; must come with their own ADR per Decision 3).
4. Artifact GC verb or retention policy for `.part` residue.
5. Idempotency-ledger GC policy for long-lived `serve` sessions.
6. MCP image content blocks for previews (default **off** proposed).
7. `.gitignore` whitelist entry for `docs/slice-2/` evidence
   (maintainer-owned; this slice may not touch `.gitignore`).
8. Confirm the ADR 0001 §5 Desktop-MCP hardening track remains a separate
   product decision — this slice neither depends on it nor advances it.
