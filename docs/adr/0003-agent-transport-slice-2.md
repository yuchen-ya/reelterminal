# ADR 0003: Agent Transport — Slice 2 (MCP stdio + minimal CLI + SKILL)

- Status: **Proposed** (transport audit only — no implementation lands in this slice)
- Date: 2026-08-28
- Branch: `audit/slice-2-transport`
- Revision: **r2.2** (2026-08-30) — adds cross-session project
  persistence: facade verbs `project.open` / `project.save` (Decision 10),
  12 → **14** MCP tools (Decision 2, Appendix B.1), a third root class
  `projectRoots` (Decisions 1/6, Appendix B.5), one shared checkpoint
  format for `serve` / `run` / future agent bindings, the persistence E2E
  (Appendix D, scenario 2), and the fourth red-team round (Appendix E).
  (r2.1 was the r2 text after its third-round wording fixes.)
- Revision history: **r2** (2026-08-28) — incorporates the independent
  red-team round on r1: `run` is now an executable workflow
  (Decision 3/B.6), the MCP SDK is adopted and pin-locked (Consequences),
  the transport owns the signal lifecycle via a minimal runtime change
  (Decision 7), listener and hard-kill-residue wording corrected to fact
  (Decisions 1/7), paths are absolute-only (Decision 6), and the schema
  story is single-source, not twin hand-written schemas (Decision 4).
- Context: ADR 0001 (headless facade; §5 gates transports on Desktop-MCP
  hardening), ADR 0002 (Chromium runtime; containment, watchdog, honest
  capabilities), `audit/transport-audit.md` (debugger-grade verdict on the
  upstream MCP path), `audit/facade-v0.md` (contracts #1–#7), the 12-verb
  `@openreel/agent-facade` as it exists on `main` (684289a), extended to
  14 verbs by this revision (Decision 10).

> Editorial note: when this audit started, `docs/*` was git-ignored
> outside a few whitelisted paths (`docs/adr/`, `docs/slice-1b/`, …) and
> this slice could not modify `.gitignore`; the audit deliverables
> (inventory, mapping, client facts, E2E contract, adversarial review)
> therefore ride as appendices of this ADR instead of separate files.
> That policy is gone (repository-hygiene merge d60f04c on `main`), but
> the appendices stay here for this slice — one decision, one document.
> They can be split out later without changing a claim.

## Decisions

### 1. One long-lived stdio MCP server process == one `AgentFacadeSession`

`serve` runs a single MCP server over **stdio**. The process owns exactly
one `AgentFacadeSession` for its whole lifetime; the session owns exactly
one project (facade lifecycle — `project.create` is
single-initialization, ADR 0001 addendum §1). The transport exposes **no
externally reachable transport/control listener of any kind** — no TCP,
no Unix socket, no named pipe; stdio is the whole control surface. Two
internal channels exist in the process tree and neither is a control
surface: the Playwright-managed Chromium debugging channel (pipe-based),
and the runtime's internal **harness HTTP server**, which serves only the render
harness page to the Chromium page, bound to `127.0.0.1` on an ephemeral
port (`packages/runtime-chromium/src/node/runtime.ts`) — loopback-only,
not discoverable off-host, and it accepts no commands. Hardening that
internal surface further belongs to the Desktop-MCP track (ADR 0001 §5),
not to this slice. Multi-project work means multiple `serve` processes,
each with its own `mediaRoots`/`artifactRoot`/`projectRoots`/provider
set. Session configuration (`mediaRoots`, `artifactRoot`, `projectRoots`,
provider wiring) happens
**only** at process start (flags/env, Appendix B.5) — no tool can widen
the roots after start, because the facade config is constructor-only and
the transport refuses to fake a setter.

Rationale: the facade's entire guarantees stack (serialized lane, revision
counter, idempotency ledger, job registry) is per-session and in-memory.
Any transport shape that pretends *the session* survives the process
(HTTP service with reattachment, "resume" that silently rebuilds state)
would be a lie of exactly the kind ADR 0001 §5 forbids. stdio makes
client lifetime == session lifetime structurally true instead of enforced
by convention. Cross-session continuity exists only as an explicit,
agent-visible checkpoint file written and re-validated through the facade
verbs of Decision 10 — never as an implicit property of the transport.

### 2. The 14 facade verbs map 1:1 to 14 MCP tools; the 304-tool registry stays internal

Exactly one MCP tool per facade verb, flat underscore names
(`session_describe`, `capabilities_get`, `project_create`,
`project_open`, `project_save`, `project_get_state`, `media_import`,
`timeline_get`, `edit_apply`,
`preview_render_frame`, `export_start`, `job_status`, `job_cancel`,
`verify_artifact`) — MCP/client namespaces favor `[A-Za-z0-9_-]`, and the
Claude Code client constrains input-schema **property** names to the same
class (Appendix C), so dot-forms are dropped at the tool layer only; the
facade verb names remain the contract (tools echo `verb` where useful).
(`project_open` / `project_save` arrive with Decision 10 in r2.2.)
No tool is added for anything a verb cannot already express — not
`doctor`, not config, not project switching. The public surface is
exactly these 14 tools: the transport has no configuration, flag, or env
var that adds, renames, hides, or gates tools. `packages/agent`'s
`toMcpTools()` (304 tools) is **never** called by this transport; the
registry stays the internal/live surface (ADR 0001 §1,
`audit/facade-v0.md` "Why not expose the 304 directly").

### 3. CLI minimal form: `serve` · `run` · `doctor` — sufficient, and honest about state

One package — `@openreel/agent-transport`, binary `agent-video` (names
bound in r2.2) — with three subcommands:

- `serve` — the MCP stdio server of §1. This **is** the persistent
  session; nothing else pretends to be.
- `run --workflow <file>` — one process, **one fresh facade session**,
  executes an **executable workflow**, not a fixed list of literal calls:
  an ordered list of steps, each with a stable caller-chosen step ID, in
  which later steps reference earlier results through structured
  `$ref`/JSON-Pointer substitution, and job completion is expressed by a
  bounded `await` step (full format and its prohibitions: Appendix B.6).
  This is what makes the real closed loop — import → edit → export →
  await terminal → verify — expressible by a shell-only agent (Pi-class)
  without an MCP client and without string templating. Execution stops at
  the first failed step by default. Each `run` invocation is one **fresh
  facade session with an empty idempotency ledger**: no state is ever
  carried between invocations implicitly. Cross-invocation continuity
  exists only because a workflow may contain explicit `project.open` /
  `project.save` verb steps (Decision 10, r2.2) — the checkpoint file is
  the *only* cross-process state, it is agent-visible data, and it is
  byte-identical in format to what `serve` and every future agent
  binding reads and writes. The runner itself keeps nothing: no hidden
  session file, no ledger spillover, no "last project" memory.
- `doctor` — runs the real preflights (Chromium launch probe,
  ffmpeg/ffprobe resolution, codec checks via the runtime probe path,
  configured roots, provider availability) and prints one machine-readable
  JSON report to stdout; exit code says usable / degraded / unusable.
  `doctor` is the "read the truth before trusting the session" command and
  the first thing SKILL.md tells an agent to run.

Verdict: **this form is enough for slice 2.** It covers every client class
in Appendix C (MCP clients use `serve`; shell-capable agents without MCP
clients, e.g. Pi today, use `run` + `doctor`). It contains no one-shot
commands wearing a session costume: the only cross-process state is the
explicit checkpoint file of Decision 10, written and re-validated through
the same two facade verbs on every surface.

### 4. Schema single source of truth: ONE declaration per verb drives both runtime validation and the emitted MCP JSON Schema

Today the facade validates with hand-rolled closed `ObjectSchema`s
(`packages/agent-facade/src/validate.ts`, per-verb constants in
`session.ts`) — strict, audited, zero-dep — and **no** JSON Schema exists
for the verb params anywhere. MCP `tools/list` requires an `inputSchema`
per tool, so schemas must appear. The decision:

**There is exactly one hand-maintained schema declaration per verb, and
both consumers derive from it.** The runtime validator and the
`tools/list` JSON Schema are two renderings of one source. The r1 text's
mechanism — a second, hand-written set of per-verb JSON Schemas kept
"side-by-side" with the runtime validators — is **rejected as an end
state**: two hand-maintained definitions of the same contract drift, and
a CI deep-equal can only catch textual drift, never semantic drift. That
arrangement may exist for at most one transitional PR inside slice 2a;
it may not ship.

Mechanism (decided by an early slice-2a spike, within these bounds):

1. The spike evaluates, in order of preference: (a) grow
   `validate.ts`'s closed `ObjectSchema` model into the single
   declaration — the validators already are a declarative schema; teach
   the same structure to *emit* draft-2020-12 JSON Schema, so validation
   and emission share one definition; (b) generate both artifacts from a
   neutral per-verb declaration via a build-time codegen step; (c) adopt
   a schema library as the declaration. Choice (c) carries the r1 zod
   verdict below and must beat (a) on audited-semantics preservation to
   win. The spike's output is a one-page addendum to this ADR naming the
   mechanism; the **requirement is not negotiable**: one hand-maintained
   definition per verb, everything else derived.
2. The transport imports the emitted schemas and assigns them verbatim:
   `tool.inputSchema = <emitted>[verb]`. It never declares a schema of
   its own. A CI assertion deep-equals every exported `tools/list` entry
   against the facade-side emission (copy-drift dies here).
3. **Adversarial / differential testing is retained regardless of
   mechanism** — a single source removes hand-drift, not emitter bugs or
   client-side schema mangling. For each verb, a fixed adversarial corpus
   (valid payloads + one payload per failure class: unknown field,
   missing required, wrong type, enum violation, plus a deterministic
   mutation sweep of each corpus entry) must classify identically under
   (a) the facade's runtime validators and (b) the emitted JSON Schema
   evaluated by ajv (devDependency of the transport only — the facade
   stays dependency-free). This test survives whatever mechanism the
   spike picks.
4. Client constraints shape the emitted schemas up front (Appendix C):
   flat top-level objects, property names `^[A-Za-z0-9_-]{1,64}$`, no
   root-level `anyOf`/`oneOf`/`allOf` (Claude Code flattens those with
   lossy notes), no `$ref` in the *emitted schema* (not dereferenced by
   at least one major client — unrelated to the workflow format's `$ref`,
   Appendix B.6). `edit_apply`'s discriminated op union lives as a nested
   `anyOf` inside `items`, which is allowed where root-level combinators
   are not.
5. **Cross-field constraints stay honest.** Some facade rules are not
   expressible in plain JSON Schema: `clip.trim` requires at least one of
   `inPoint`/`outPoint`; `verify.compare.region` requires `x+width ≤ 1`
   and `y+height ≤ 1`. Such rules live in the single declaration as
   validation-only predicates; the emitted JSON Schema is then a
   **superset filter at the boundary** and the runtime validators remain
   the only authority: a payload can be schema-valid and still fail
   `INVALID_PARAMS` at the facade, and the differential corpus must
   assert exactly that ordering (schema-valid ⇒ facade decides;
   schema-invalid ⇒ facade would also reject). The transport never
   pre-validates against the schema beyond what the MCP client itself
   does — rejecting early would mean a second validator with its own
   drift. A transport-level test pins the passthrough: a
   schema-valid-but-facade-rejected payload must surface the facade's
   `INVALID_PARAMS` from the tool result, never a transport-side
   rejection.

Alternative considered and rejected: make zod the single source (zod
infers TS types, `zod-to-json-schema` emits MCP schemas, facade
validators replaced by `.parse()`). Rejected as the *default* because it
rewrites the audited validation layer (ADV-03 strict-params semantics,
sanitizing-copy behavior), adds a runtime dependency to the pure facade,
and the tree's zod versions are split (3.22.3 / 3.25.76 / 4.4.3 in
`pnpm-lock.yaml`). The 2a spike may re-examine it as mechanism (c) only
if it demonstrably preserves the audited semantics better than growing
the existing model — the bar is high on purpose.

### 5. Facade guarantees must arrive at the agent undamaged — the transport adds no semantics and removes none

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
  immediately; `job_status`/`job_cancel` are plain tools. Export — the
  only operation whose duration is unbounded by design — is a job, which
  is what keeps default client tool timeouts (Codex `tool_timeout_sec`
  60 s, DSH `toolCallTimeoutMs` 60 000, both official-documented)
  manageable. The other verbs are synchronous in-call (`media.import`
  probes, `preview.render_frame` renders, `verify.artifact` ffprobes and
  pixel-compares): each is bounded, but only by input size, so a huge
  project can exceed a 60 s default on `preview_render_frame` — the risk
  register's per-client timeout configuration exists for exactly this
  (Appendix F). Over MCP, the poll loop
  belongs to the agent (SKILL.md gives the cadence and terminal-state
  exit conditions). In a `run` workflow the same poll is expressed as a
  bounded `await` step executed by the runner (Appendix B.6) — identical
  semantics, mandatory bounds; the runner never spins unbounded on the
  agent's behalf.
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
- **Paths.** `mediaRoots`/`artifactRoot`/`projectRoots` are startup-only
  (§1) and are
  enforced by the facade exactly as built and tested: realpath
  containment for imports (`resolveContainedPathDetailed`), symlink/
  junction refusal plus pre- and post-write containment for artifacts,
  `.part`-then-rename, post-write escape removal (ADR 0002 A5).
  `projectRoots` (r2.2, Decision 10) gets the same treatment for
  checkpoint files: realpath containment on `project.open`, symlink/
  junction refusal plus pre- and post-write containment and
  temp-then-rename on `project.save`. On top of
  that, the transport is **absolute-path-only, everywhere**: every path
  input — CLI flags, env config, workflow-step params, and every path the
  SKILL tells an agent to pass — must be absolute. At startup the
  transport canonicalizes the configured roots (they must exist, be
  directories, and are stored in their `realpath` form; a relative,
  missing, or undirectory root is a startup refusal, not a fallback). At
  the boundary, a non-absolute path param is rejected before it reaches
  the facade — nothing is ever resolved against the process cwd, and `~`
  is never expanded. The check applies to the **resolved param value at
  execution time** — after any `$ref` substitution (B.6), since a
  reference can legally carry a relative string from an earlier result —
  not only to literal workflow text; the workflow test corpus includes a
  `$ref`-fed relative path and pins its rejection. The transport passes paths verbatim otherwise: it
  never rewrites or "helpfully" normalizes into a root, and it never
  adds a root at runtime. `doctor` echoes the canonicalized roots so the
  agent can verify where it is allowed to touch. URLs are refused by the
  facade already (`hasUrlScheme`), and the transport does not loosen
  that.

### 7. Cleanup matrix (who cleans what, when) — and who owns signals

**Signal ownership (the one minimal runtime change this slice allows).**
Today Playwright registers its own `SIGINT`/`SIGTERM`/`SIGHUP` handlers
at launch (its default), which kill the browser immediately and race the
bounded cancel/dispose path below. The transport must own the signal
lifecycle, so slice 2b makes exactly one scoped change to
`@openreel/runtime-chromium`: pass `handleSIGINT: false`,
`handleSIGTERM: false`, `handleSIGHUP: false` at `chromium.launch`
(nothing else in the runtime changes — containment, watchdog, recycle,
and bounded teardown semantics are untouched). The transport then
installs the only handlers: the **first** `SIGINT`/`SIGTERM`/`SIGHUP`
runs the bounded disposal path (cancel race → provider dispose → exit
130/143/129 by signal); a **second** signal exits immediately with no
further cleanup promises (the operator's escape hatch; residue is the
`SIGKILL` row). The composed first-signal bound is stated honestly: the
cancel request goes through the public verb path, so it queues behind
any in-flight verb — worst case is *that verb's own ceiling* (e.g. the
120 s page-op bound) **plus** the facade's 10 s cancel race **plus** the
runtime's bounded teardown (10 s browser + 5 s harness server); the
second signal is the escape hatch for the pathological case. No other
product-code change is authorized by this ADR.

| Trigger | Actions | Guaranteed residue |
|---|---|---|
| Clean shutdown (stdio EOF / client exit / `shutdown`) | Stop accepting calls → request cancel on every non-terminal job (bounded wait, the facade's own 10 s cancel race, invoked through the public `job.cancel` verb path — no back doors) → dispose provider runtime (bounded graceful teardown, ADR 0002 A7) → flush stderr logs → exit 0 | None new. Artifacts and checkpoint files persist (they are the deliverables); a cancelled export leaves no success-looking file (job-dir sweep) |
| `SIGINT` / `SIGTERM` / `SIGHUP` (first) | Same disposal path, same bounds, owned by the transport (Playwright signal handlers disabled, above); exit 130/143/129. A second signal = immediate hard exit | Same as above; after a hard exit, the `SIGKILL` row |
| Client abrupt disconnect (stdin EOF without handshake) | stdio EOF *is* the disconnect signal; identical to clean shutdown. No half-open connections exist on stdio — the class of "client vanished but server keeps serving" bugs cannot occur **under the direct-spawn configs of Appendix C** (a wrapper/shell that holds stdin's write end open after the client dies would defeat EOF detection; clients must spawn the server directly, and SKILL says so) | Same as row 1 |
| `SIGKILL` / hard crash | Nothing in-process runs. Job dies with the process; job registry (in-memory) is gone. An in-flight export leaves one of two residues, depending on where the kill lands: (a) mid-write — an inert `exports/<jobId>/output.mp4.part`; (b) in the **rename→hash/registration window** — a byte-complete `exports/<jobId>/output.mp4` that no successful `ArtifactRef` ever reported (the rename happens before the facade hashes and terminalizes the job; a kill between them strands the file) | Either residue is **unregistered**: it must never be reported as, or mistaken for, a successful artifact — no ArtifactRef exists for it, and residue (b) is indistinguishable from a real deliverable by bytes alone. `doctor` lists per-job directories under `artifactRoot` and labels any file not referenced by a live session as an **orphan — unverifiable, do not trust as an artifact**. Slice 2 does **not** auto-delete orphans (GC is a deferred candidate, Appendix F) |
| Running export at any shutdown | Best-effort cooperative cancel first (job settles `cancelled`/`error` with the job-dir sweep); if the window is lost, the `SIGKILL` row applies | Same as above |
| Chromium crash / watchdog mid-job | Handled entirely inside `@openreel/runtime-chromium` (recycle + generation bump, exactly-once terminalization, ADR 0002 A6/A7). Transport is a bystander; next capability read re-preflights honestly | None new |
| SKILL contract for agents | Poll `job_status` to a terminal state **before** disconnecting; a session that dies takes its jobs with it (documented facade limitation, not restart-durable) | — |

### 8. Context budget: compact-by-default reads, path-not-pixels, and SKILL-taught discipline

| Result | Size behavior | Transport/SKILL contract |
|---|---|---|
| `project_get_state` | Unbounded (full canonical `Project` clone — the hydration contract) | SKILL: use `timeline_get` for orientation; `project_get_state` only when a full dump is truly needed. Paging/summary verbs are a facade change (deferred candidate, Appendix F), not transport-side field-dropping |
| `project_open` | Same class as `project_get_state` (the opened state is returned) | SKILL: after a successful open, orient with `timeline_get`; the open result's full dump is for checkpoint verification, not routine reading |
| `project_save` | Small (`{path, revision, bytesWritten, stateSha256, savedAt}`) | — |
| `timeline_get` | Compact by design (facade view: tracks/clips/text only) | Preferred read verb |
| `preview_render_frame` | Returns an **ArtifactRef** (`{path, sizeBytes, sha256, sourceRevision, …}`) — **never** pixel bytes | The default tool result is the ArtifactRef, full stop. MCP image content blocks (inline PNG) are **not emitted by default**; enabling them is an explicit config flag and a deferred product decision (Appendix F). Visual truth is obtained via `verify_artifact` compare numbers, not by inlining PNGs |
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
is unavailable, the 14 tools and their one-line purposes, the
mediaRoots/artifactRoot/projectRoots world model, idempotency-key
discipline, the
**absolute-paths-only rule** (agents always pass absolute paths; the
transports reject relative ones), the `export_start` → poll/await →
`verify_artifact` loop, the "disconnect kills jobs" rule, and the
checkpoint discipline of Decision 10 (save to a **new** versioned path
per milestone — overwrite is off by default; resume by opening the
checkpoint in a fresh session/process; mint **fresh** idempotency keys
after every open, because the ledger is per-session and is never saved;
poll jobs to a terminal state **before** saving a checkpoint you intend
to resume from). It does
**not**: restate parameter defaults or semantics that
live in the facade (it links), add fallback behaviors or retries the
facade doesn't have, carry client-specific tool variants (the same 14
tools for every client; per-client config snippets are configuration, not
variants), or encode any business decision the verbs should have made.
If a capability is missing, the skill's instruction is "read
`capabilities_get`'s reason", never "do this instead" — a second logic
layer in prose would drift exactly like a second schema would.

### 10. Cross-session project persistence — one honest checkpoint format behind `project.save` / `project.open` (r2.2)

r1/r2 deferred persistence because faking it in the transport would have
been a lie. r2.2 adds it **in the facade**, where the guarantees stack
lives, so the human↔agent collaboration loop (iterate on one project
across many sessions and processes) becomes real. The design rule: a
checkpoint is *data the agent can see and the facade re-validates*, never
transport-side session magic.

**10.1 A third root class: `projectRoots`.** Checkpoint paths are
gated by their own startup-only root set (flags `--project-root`, env
`OPENREEL_AVE_PROJECT_ROOTS`; Appendix B.5), canonicalized to realpath
form at startup exactly like the other roots (must exist, be a
directory; relative/missing/non-directory is a startup refusal). A
session with zero `projectRoots` is honest: `project.open`/`project.save`
fail `UNSUPPORTED`. Every checkpoint path must be **absolute** (Decision
6, including after `$ref` substitution in workflows) and must resolve
inside `projectRoots`:

- on `project.open`: the facade's realpath containment
  (`resolveContainedPathDetailed`) must place the resolved file inside a
  root — a symlinked *file* is followed and contained by realpath, and an
  escape is `INVALID_PARAMS` with the escape wording;
- on `project.save`: the artifact-write discipline, reused — the target
  directory must exist, must resolve inside a root, and no path component
  may be a symlink/junction (refuse, never write through a link), with
  pre- and post-write containment checks. The parent directory is **not**
  auto-created (typo-safe; the operator or agent creates it once, the
  same way roots come to exist).

**10.2 The checkpoint document — `openreel-project@1`.** One JSON
document, one format, every surface (`serve`, `run` workflows, future
agent bindings). Top level:

| Field | Content |
|---|---|
| `format` | the literal string `"openreel-project"` |
| `formatVersion` | integer `1` |
| `contract` | the facade contract label, `"facade-slice-2"` |
| `savedAt` | ms epoch of the save |
| `revision` | the project revision at save time (non-negative integer) |
| `project` | the canonical `Project` JSON, exactly the `project.get_state` payload (runtime-only fields are already `null` in headless sessions: `fileHandle`, `blob`, `thumbnailUrl`, `waveformData`) |
| `mediaRefs` | one entry per media item: `{mediaId, path, sourceFile:{name,size,lastModified}, metadata}` — `path` is the absolute realpath recorded at import |
| `stateSha256` | hex SHA-256 over the canonical serialization of `{formatVersion, revision, project, mediaRefs}` |

**Explicitly never saved:** the idempotency ledger, the job registry and
any job state (queued/running/terminal), provider handles or runtime
state, session configuration (roots, provider wiring), and artifact
bytes (artifacts live under `artifactRoot`, referenced by path at most).
`stateSha256` is **corruption detection, not tamper-proofing** — it
catches truncation, bit-rot, and incomplete writes; anyone can recompute
it after a deliberate edit, and the format claims nothing stronger.

**10.3 `project.save {path, expectedRevision?, overwrite?}` — a snapshot,
not a mutation.** Saving does **not** bump the project revision, creates
no ledger entry, and needs no `idempotencyKey`; the result is
`{path, revision, bytesWritten, stateSha256, savedAt}` with `revision`
equal to the pre-save revision. An optional `expectedRevision` acts as a
pure guard (`CONFLICT` if the session has moved on) — a guard, not a
mutation. Saves run through the session's serialized lane, so a
checkpoint can never capture a half-applied batch. Without an active
project: `NOT_FOUND`. Atomicity: write a uniquely named temp sibling
(`<name>.<uuid>.tmp`) in the target directory, flush + fsync, **atomic
rename** onto the target, then best-effort directory fsync. A crash
mid-save leaves at most an inert, clearly named `.tmp` file — never a
half-written checkpoint at the target path, and `project.open` refuses
anything that fails full validation regardless of name. **Default is
no-overwrite:** if the target path already exists (file, or dangling
symlink), save fails `CONFLICT`. Iteration therefore uses *versioned
checkpoints* — the caller picks a fresh path per milestone
(`promo-v1.openreel.json`, `promo-v2.openreel.json`, …); `overwrite:true`
is the explicit opt-in for replacing one's own checkpoint and still
refuses symlinks. (Platform note, stated plainly: rename-over-existing
is atomic on POSIX and on current Windows/libuv for regular files, but
fails there for read-only targets — the default no-overwrite mode is
unaffected.)

**10.4 `project.open {path, idempotencyKey?}` — a lifecycle verb that
commits only after *everything* validates.** Like `project.create`, open
is single-initialization: legal **only** in a session with no active
project; with an active project it fails `CONFLICT` — it can never
silently replace or reset a live project (a second project means a
second `serve` process, as in Decision 1). The optional
`idempotencyKey` carries create-style replay semantics: an exact retry
returns the committed open snapshot without re-reading the file. Before
the session adopts anything, all of the following must pass, in order —
any failure leaves the session empty and unchanged:

1. **Containment:** path absolute; resolves inside `projectRoots` via
   realpath (10.1); is a regular, readable file. Escape ⇒
   `INVALID_PARAMS` (escape wording); missing/unreadable ⇒
   `INVALID_PARAMS` (cannot-be-read wording), mirroring `media.import`.
2. **Format:** parses as JSON; `format == "openreel-project"` and
   `formatVersion` is in the supported set (`{1}`). Anything else ⇒
   `UNSUPPORTED` naming the found version and the supported set — an
   **honest refusal, never a silent downgrade or a guessed migration**.
   This slice ships no migration framework; a future version bump is a
   new reader decided by its own ADR.
3. **Integrity:** `stateSha256` recomputes to the stored value; mismatch
   ⇒ `INVALID_PARAMS` ("checkpoint corrupted or hand-edited" wording).
4. **Structure:** `project` validates against a strict closed-schema
   project-document declaration (same single-source machinery as the
   verb schemas, Decision 4); `revision` is a non-negative integer.
   Provenance beyond this is not claimed (10.6).
5. **Media references:** every `mediaRefs` entry's `path` is absolute,
   resolves inside the **current** session's `mediaRoots`, exists, is
   readable, and its `{size, lastModified}` fingerprint matches the
   recorded `sourceFile`. A project with zero media items needs no
   `mediaRoots`; a project referencing media in a session without
   matching roots fails here. Missing, moved, or changed media ⇒ the
   open **fails** (`INVALID_PARAMS`) with details listing *every*
   offending `mediaId` — no silent relink, no fuzzy matching, no
   placeholder substitution. (A relink verb is a deferred candidate,
   Appendix F.)

Only then does the session adopt the project **at the saved revision**:
`timeline_get`/`project_get_state` continue from it, and the next
committed mutation bumps `revision + 1` — revision arithmetic is
continuous across the process boundary. The idempotency ledger after
open is **empty** (it was never saved): keys minted before the restart
do not replay, and agents mint fresh keys per session (SKILL, Decision
9). With this verb pair the facade contract reported by
`session.describe` becomes **`facade-slice-2`, 14 verbs**.

**10.5 One format, every surface.** `serve`, `run` (open/save are
ordinary verb steps in the B.6 workflow format), and any future agent
binding read and write the same `openreel-project@1` document through
these two verbs. There is no transport-side side format, no runner-only
shortcut, and no third way to persist a project.

**10.6 Honesty boundaries (restated in SKILL and `doctor`).** Durable:
exactly one thing — the checkpoint file. Not durable: jobs, the ledger,
provider state, in-flight previews/exports. The media fingerprint is
`size + lastModified`: it detects moved, replaced, and edited media in
practice; it is not a content hash, and a same-size same-mtime swap is
outside the threat model (risk register). `stateSha256` detects
corruption, not malice (10.2): a hand-edited checkpoint that passes
structural validation is operator input, trusted at the level of the
operator — the same trust class as the root configuration itself. The
realpath-then-read sequence on open has the same TOCTOU shape as the
facade's existing import containment; it is accepted and documented, not
claimed away (Appendix E, fourth round).

## Consequences

- Product code changes are limited to exactly three, all scoped here: (a)
  the facade gains the single-source schema mechanism of Decision 4 (2a)
  — a validation-side change with zero behavioral drift, pinned by the
  differential corpus; (b) the one-line signal-ownership launch change in
  `@openreel/runtime-chromium` of Decision 7 (2b); (c) the facade gains
  the persistence pair of Decision 10 (r2.2) — `project.open` /
  `project.save`, the `projectRoots` config slot, and the
  `openreel-project@1` document module with its full-validation reader
  and atomic writer. Everything else in the
  facade and runtime packages lands **unchanged**. Slice 2 adds a new
  transport package and the SKILL. ADR 0001 §5's
  Desktop-MCP gate is untouched — this transport **does not reuse** the
  desktop path (Appendix A), so the gate is not a blocker for a Proposed
  slice, but exposure still does not widen beyond what a Draft PR implies.
- **The MCP core is the official `@modelcontextprotocol/sdk`, exactly
  pin-locked** — no hand-rolled MCP core, in this slice or as a
  "fallback". The desktop's hand-rolled core
  (`apps/desktop/src/main/mcp/core.ts`) remains prior art to read, never
  code to import. The dependency is confined to the transport package:
  package.json pins an exact version with no semver range (pin candidate
  at decision time: `1.30.0`, npm `latest` verified 2026-08-28; the
  implementation PR records the final pin, and any later bump is its own
  reviewed change). The SDK's spec-revision behavior is verified against
  Appendix C's client facts at implementation time.
- **Slice 2 scope exclusions, stated positively:** this slice does *not*
  add a media-relink verb, a checkpoint migration framework, a complete
  artifact-GC verb, idempotency-ledger GC, or new paging/summary read
  verbs. All five are recorded as
  deferred candidates in Appendix F with their motivations; each needs
  its own decision before it lands. The transport must not smuggle any of
  them in as conveniences. (`project.open`/`project.save` were this
  list's item 2 in r2.1 — they are Decision 10 now.)
- **The Desktop-MCP hardening track stays independent.** It remains gated
  by ADR 0001 §5 and its own future decision; this slice neither depends
  on it nor advances it, and the old Desktop MCP is not this slice's
  transport in any form.
- Restart durability is exactly one thing: the checkpoint file of
  Decision 10. Session, idempotency ledger, jobs, and provider state
  still die with the process — stated in SKILL and doctor output, and
  pinned by the E2E (Appendix D, scenario 1 step 10 and scenario 2).
- The E2E contract (Appendix D) is defined but **not executed** in this
  slice; executing it is the next slice's deliverable, with committed
  evidence under `docs/slice-2/`. (The old "docs ignored unless
  whitelisted" policy was removed by the repository-hygiene merge;
  `docs/slice-2/` needs no `.gitignore` change.)

---

## Appendix A: Transport inventory / reuse matrix

Letters: **P** production-ready as-is (reuse) · **A** adapt (reuse with
modification) · **C** create new · **X** exclude (do not import; prior art
at most). Reuse estimates are of the slice-2 transport's *total surface*.

| # | Asset | Where | What it is | Verdict | Notes / reuse |
|---|---|---|---|---|---|
| 1 | `AgentFacadeSession` + 12 verbs | `packages/agent-facade/src/{session,types,errors,idempotency,jobs,capabilities}.ts` | State semantics: atomic batches, revision, ledger, job registry, capability preflight, containment | **P** | ~100% reused unchanged; r2.2 adds 2 persistence verbs (row 19). This is the product; the transport is a socket on it |
| 2 | Closed-schema validators | `packages/agent-facade/src/validate.ts` + per-verb schemas | Strict boundary validation, zero deps | **P** | Unchanged. The single-source declaration per verb + emitted JSON Schemas (Decision 4) are the only addition |
| 3 | Providers (render/export/verify) | `packages/runtime-chromium` | Chromium pixels, H.264 export, ffprobe verify, watchdog/recycle | **P** | Reused verbatim; transport only constructs and disposes them |
| 4 | MCP JSON-RPC core | `apps/desktop/src/main/mcp/core.ts` | Hand-rolled initialize/tools-list/call, protocol 2024-11-05→2025-06-18, content blocks; unit-tested | **X** (prior art) | Bound to the desktop tool-provider shape; superseded by the official SDK (row 11). No hand-rolled core in this slice — not imported, not rewritten. Read, don't import |
| 5 | Renderer-bridge dispatcher | `apps/desktop/src/main/mcp/dispatcher.ts`, `renderer-bridge.ts` | callId-correlated IPC promises; **timeouts abandon calls that keep mutating** | **X** | Its timeout semantics are DESK-04 — the exact trap this slice must not reproduce. Not needed: stdio is single-caller request/response |
| 6 | Loopback HTTP server + bearer auth | `apps/desktop/src/main/mcp/http-server.ts` | 127.0.0.1 bind, timing-safe token, 4 MB body cap, tested | **X** for v0 | Good engineering, wrong default: Decision 1 exposes no transport/control listener. Revisit only behind a future explicit remote-transport ADR |
| 7 | stdio shim | `apps/desktop/src/mcp-shim/index.ts` | readline stdio → HTTP forwarder, endpoint file w/ token | **X** | Exists to bridge to #6; pattern (readline framing, 0600 endpoint file) noted for `serve`'s own stdio loop |
| 8 | 304-tool registry + `toMcpTools()` | `packages/agent/src/registry.ts` (31 930 lines) | Internal/live editing surface | **X** — **never exposed** | The audit's central prohibition (`audit/facade-v0.md`). Stays internal |
| 9 | `openreel-agent` CLI | `packages/agent-runner/src/cli.ts` + `run.ts` | LLM-driven headless editor (BYOK keys, prompt in → LLM loop → project mutated) | **X** | An LLM *orchestrator*, not an agent-facing transport; drives the 304 registry. Its `bin` + tsup packaging is the (trivial) pattern to copy |
| 10 | LLM loop / hosts / evals | `packages/agent-runner/src/{run,node-llm,evals}`, `packages/agent/src/{loop,host,headless-host}` | BYOK turn loop over registry | **X** | Same reason as #9; orthogonal to transport |
| 11 | MCP SDK | — (`@modelcontextprotocol/sdk`) | stdio server, framing, protocol negotiation | **C** (adopt — decided) | The MCP core for this slice. Official upstream, exact-pinned (no range; candidate `1.30.0` verified 2026-08-28), confined to the transport package. Hand-rolling is rejected |
| 12 | JSON Schema evaluation (CI only) | — (`ajv`) | Differential schema test | **C** | devDependency of transport only; facade stays pure |
| 13 | CLI arg parsing | `packages/agent-runner/src/cli.ts` pattern | ~80-line hand-rolled switch | **A** (pattern) | 3 subcommands need no framework. commander/yargs/cac exist in-tree only as transitive deps — not first-party, not adopted |
| 14 | stdio handling | `node:readline` (as in `mcp-shim`) / `process.stdin` | NDJSON framing | **C** (trivial) | — |
| 15 | Config loading | Desktop env-var + endpoint-file precedent | Flags + `OPENREEL_*` env | **C** (minimal) | No config library exists or is added; see B.5 |
| 16 | Binary packaging | `tsup` (used by agent-runner, desktop) | Single-file bin | **P** | In-tree, proven |
| 17 | zod | `apps/desktop@^3.23.8`; 3.x/4.x split in lock | Schema→types | **X** for slice 2 | Rejected as schema source (Decision 4); exists in tree, not in facade |
| 18 | Chromium E2E scenario | `packages/runtime-chromium/examples/hello-world-e2e.mts` | create→import→trim→text→PNG→MP4→verify | **A** | Template for Appendix D's scenario; re-expressed as agent-driven tool calls |
| 19 | Checkpoint persistence | new in facade (Decision 10, r2.2): document module + reader/writer + `projectRoots` containment | `openreel-project@1` save/open | **C** | Built from existing pieces: `resolveContainedPathDetailed`, the artifact write discipline (link refusal, pre/post-write checks, temp+rename), the closed-schema machinery |

**Reuse ratio estimate:** ≈85–90 % of slice 2's shipped behavior is
existing, tested facade + runtime code; the new code is the schema
single-source + emitter, the checkpoint document module, the stdio
server shell, `run`, `doctor`, and
SKILL.md. The risk
concentrates where the new code is: framing, lifecycle, checkpoint
read/write validation, and the honest
cleanup matrix — hence Appendix E.

## Appendix B: 14 verbs → MCP tools / CLI mapping + schema ownership

### B.1 Tool map (complete; no other tools exist)

| Facade verb | MCP tool | CLI `run` step verb | Mutating? | Notes |
|---|---|---|---|---|
| `session.describe` | `session_describe` | same | no | Facade self-description (verbs, error codes, step letters) — distinct from MCP `initialize` |
| `capabilities.get` | `capabilities_get` | same | no | Live provider preflights |
| `project.create` | `project_create` | same | lifecycle | No `expectedRevision` (single-initialization); `idempotencyKey` only |
| `project.open` | `project_open` | same | lifecycle | Empty-session-only (`CONFLICT` otherwise); full pre-commit validation (Decision 10.4); create-style `idempotencyKey` replay |
| `project.save` | `project_save` | same | no (snapshot) | Revision unchanged; no ledger entry; optional `expectedRevision` guard; default no-overwrite (`CONFLICT` on existing target) |
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

### B.3 `edit_apply` inputSchema (illustrative emitted shape, pinned by Decision 4)

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
agent-video serve \
  --media-root /abs/a --media-root /abs/b \
  --artifact-root /abs/out \
  --project-root /abs/checkpoints \
  --log-level info          # stderr JSON logs
```

Env equivalents: `OPENREEL_AVE_MEDIA_ROOTS` (path-separator list),
`OPENREEL_AVE_ARTIFACT_ROOT`, `OPENREEL_AVE_PROJECT_ROOTS`
(path-separator list, r2.2), `OPENREEL_TRANSPORT_LOG`. Roots must be
**absolute**; at startup each is canonicalized to its `realpath` form and
must exist and be a directory — a relative, missing, or non-directory
root is a startup refusal (Decision 6), never a cwd-relative resolution
and never a `~` expansion. Absent roots are honest: imports/artifacts/
checkpoints
then fail `UNSUPPORTED` with the facade's own message, and `doctor` says
so. (Names proposed; mechanism is the decision.)

### B.6 `run` workflow format — an executable workflow, not a literal call list

A workflow file is JSONL, one **step** per line. Two step kinds exist:

- **Verb step:** `{"id": <stepId>, "verb": <facade verb>, "params": {…}}`
- **Await step:** `{"id": <stepId>, "await": {…}}` — bounded wait on a
  job reaching a terminal state (below).

**Step IDs.** Every step carries a caller-chosen `id`
(`^[A-Za-z0-9_-]{1,64}$`, unique within the file, required). References
are by ID only — never by line position, so reordering lines cannot
silently rewire a workflow.

**Structured references (`$ref`).** Any param value may be a reference
object `{"$ref": "<stepId>"}` or `{"$ref": "<stepId>#/<pointer>"}`:

- `<stepId>` alone resolves to that step's whole `result.value`;
  `#/<pointer>` is an RFC 6901 JSON Pointer into that value.
- A reference object is the **entire value at its position** and
  substitutes structurally (the referenced JSON value is spliced in).
  There is no string interpolation — `$ref` text inside a string is just
  a string — and **no expression language, no arithmetic, no template
  syntax, no eval of any kind**. This is a deliberate ceiling: workflows
  stay data, auditable by reading, and the runner is never a code
  executor.
- Substitution is **single-pass**: a substituted value is never
  re-scanned for further `$ref` objects — reference chaining is not a
  feature, it is how data-injection bugs would arrive.
- Statically validated before step 1 runs: IDs unique; every `$ref`
  names an existing, **earlier** step; pointers syntactically valid;
  every verb known; every `await.jobId` is either a literal job id or a
  single `$ref` directly into an `export.start` step's result value
  (e.g. `{"$ref":"export#/jobId"}` — "one hop": no chained references,
  per the single-pass rule).
- At runtime: a pointer miss, or a reference to a failed/skipped step,
  is a **workflow error** — distinct from a verb's `ok:false`. A
  workflow error fails the referencing step; under the default
  stop-on-first-failure it also aborts the run, and under `--keep-going`
  the run continues with later steps (exit code still reflects the first
  failure). Workflow errors are reported on their own stdout line shape
  (`{index, id, workflowError}`) so agents never confuse them with verb
  results.

**Await semantics (bounded, always).**
`{"id": "wait", "await": {"jobId": {"$ref": "export#/jobId"},
"timeoutMs": 600000, "pollMs": 2000}}` polls `job.status` through the
session's serialized lane until the job reaches a terminal state
(`done`/`error`/`cancelled`) or `timeoutMs` elapses. `timeoutMs` is
**required** and bounded (≤ 3 600 000); `pollMs` defaults to 2000 and is
bounded (250–30 000). The await step's result value **is** the terminal
job status value, so later steps can reference `#/artifact/path` and
friends. A timeout, or a terminal state other than `done`, is a step
failure. The runner never waits unbounded on the agent's behalf.

**Failure semantics.** Default is stop-on-first-failure: the first step
whose result is `ok:false` (verb failure, await timeout/non-done,
reference resolution failure) aborts the run with exit 1; later steps do
not execute. `--keep-going` is the opt-in escape (exit code still
reflects the first failure).

**Example — the real closed loop (import → edit → export → await →
verify), with the revision arithmetic stated exactly** (`project.create`
is lifecycle: it leaves the session at revision 0; each committed
mutation bumps exactly once):

```jsonl
{"id":"create","verb":"project.create","params":{"name":"Demo","idempotencyKey":"c1"}}
{"id":"import","verb":"media.import","params":{"path":"/abs/a/input.mp4","expectedRevision":0,"idempotencyKey":"i1"}}
{"id":"edit","verb":"edit.apply","params":{"ops":[{"op":"track.add","trackType":"video","trackId":"v1"},{"op":"clip.add","trackId":"v1","mediaId":{"$ref":"import#/mediaId"},"startTime":0,"duration":5,"clipId":"c1"}],"expectedRevision":1,"idempotencyKey":"e1"}}
{"id":"export","verb":"export.start","params":{"idempotencyKey":"x1"}}
{"id":"wait","await":{"jobId":{"$ref":"export#/jobId"},"timeoutMs":600000,"pollMs":2000}}
{"id":"verify","verb":"verify.artifact","params":{"path":{"$ref":"wait#/artifact/path"},"expect":{"container":"mp4","videoCodec":"h264"}}}
```

(create ⇒ revision 0; import with `expectedRevision:0` ⇒ revision 1;
edit with `expectedRevision:1` ⇒ revision 2. `mediaId`, `jobId`, and
the artifact path are never guessed or handwritten — they flow through
`$ref`.)

One JSON line in → one JSON line out (`{index, id, verb|await,
result}`), in order, through the session's serialized lane. All path
params are absolute (Decision 6 — the runner rejects relative paths
rather than resolving them against its cwd). Logs → stderr. Re-run
semantics, stated plainly: a second `run` starts a **fresh session** —
the empty ledger means no cross-process dedupe (that is what `serve`
plus agent-owned idempotency keys are for); a workflow that rebuilds a
project from scratch gets a fresh project id, so prior runs' artifacts
can never collide.

r2.2: `project.open` / `project.save` are ordinary verb steps in this
format. A workflow that starts with `project.open` continues at the
checkpoint's saved revision (Decision 10.4 — the next mutation expects
`savedRevision` and commits `savedRevision + 1`), so two `run`
invocations with a checkpoint between them express the full
cross-process loop of Appendix D scenario 2. The checkpoint file is the
only state that crosses invocations; the runner carries nothing itself.

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

## Appendix D: Black-box E2E contracts (defined here, executed in the implementation slice)

**Scenario 1 name:** `slice2-transport-e2e`. **Actors:** a *fresh* agent
(empty context) of one of the client classes in Appendix C + this repo at
a pinned SHA with dependencies installed. The agent gets ONLY: the repo,
the SKILL, and its client. No human fills in tool calls.

**Environment contract (setup script, not agent work):**
`corepack pnpm install`; `pnpm --filter @openreel/runtime-chromium exec
playwright-core install chromium`; `ffmpeg`+`ffprobe` on PATH; `input.mp4`
(≥5 s, visually distinctive) placed under a `mediaRoots` dir; empty
`artifactRoot` dir; empty `projectRoots` dir; agent never given any of
these paths except via config.

**Steps (each assertion is machine-checked; any failure aborts with the
raw result transcript):**

1. **Doctor** — run `doctor`; expect exit "usable"; report lists
   Chromium build, ffmpeg/ffprobe paths, codec preflight results, the
   canonicalized roots. (MCP-clients path: `serve` configured per
   Appendix C and connected; Pi-class path: agent authors the Appendix
   B.6 workflow.)
2. **Discover** — `session_describe`: contract `facade-slice-2`, **14**
   verbs, 8 error codes. `capabilities_get`: `mediaImport.available`
   true; `preview`/`export` available with route details;
   `verify` available. If any is false ⇒ the scenario records the reason
   and **stops honestly** (no workaround may exist in SKILL — that's the
   point of Decision 9).
3. **Create** — `project_create {name, settings:{1920×1080@30},
   idempotencyKey:"s2-create"}` ⇒ ok, revision 0, `replayed:false`.
4. **Import** — `media_import {path:<input.mp4>, expectedRevision:0,
   idempotencyKey:"s2-imp"}` ⇒ ok, `mediaId`, revision 1; metadata
   duration ≥5 s.
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
   constructed world. For MCP-less (Pi-class) agents these
   expected-failure probes are **multi-invocation work by design**: a
   deliberately failing step aborts a default `run` workflow
   (stop-on-first-failure is the honesty mechanism, not an obstacle), so
   each negative probe is its own `run` invocation — or one
   `--keep-going` run whose nonzero exit is itself the expected outcome.
7. **Preview** — `preview_render_frame {timeSec:2.5}` ⇒ PNG artifact
   `{path, sizeBytes>0, sha256, sourceRevision:2}` inside `artifactRoot`.
8. **Export** — `export_start {idempotencyKey:"s2-exp"}` ⇒ `{jobId,
   state:"queued", sourceRevision:2}`; reach a terminal state — MCP path:
   poll `job_status` (2–5 s cadence); `run`-workflow path: a bounded
   `await` step — to `done` with `artifact` and `route` recorded; total
   frames implied 5 s × 30 fps = **150**.
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
    project (`NOT_FOUND` on reads) and the old job is gone. Whatever the
    orphaned job left in `artifactRoot` — an inert `.part`, or, if the
    kill landed in the rename→hash window, a byte-complete `output.mp4`
    — was **never reported by a successful ArtifactRef**; `doctor` lists
    it as an orphan ("unverifiable — do not trust as an artifact") and
    nothing auto-deletes it in this slice.

**Scenario 2 name:** `slice2-persistence-e2e` (r2.2, Decision 10). Same
actor and environment contract as scenario 1. This scenario is what
licenses the claim "resume works": it proves the checkpoint — not a
long-lived in-memory session — carries the project across a full process
boundary, with model state *and* pixels continuous.

1. **Create + edit (process A)** — `project_create`, `media_import`,
   `edit_apply` (trim + a text overlay), then `preview_render_frame
   {timeSec:2.5}` ⇒ `previewA.png` (kept for step 6).
2. **Save checkpoint (process A)** — record `revisionBefore` from
   `timeline_get`; `project_save {path:<projectRoots>/e2e-v1.openreel.json}`
   ⇒ ok; assert `result.revision == revisionBefore` (save is not a
   mutation) and the file exists at exactly that path with no `.tmp`
   siblings left behind.
3. **Kill process A entirely** — after the save has completed (the
   scenario runs both a clean-SIGTERM variant and a SIGKILL variant;
   both must pass, because the checkpoint contract is "durable once
   `project_save` returned ok", not "durable if shutdown was polite").
4. **Open in a brand-new process B** — fresh `serve` (or a second `run`
   invocation), fresh session, empty ledger: `project_open
   {path:<…>/e2e-v1.openreel.json}` ⇒ ok, `result.revision ==
   revisionBefore`; `timeline_get` deep-equals process A's pre-save
   timeline. A `project_create` attempt before the open in a third
   process, followed by `project_open`, ⇒ `CONFLICT` (open can only
   initialize an empty session — no silent takeover of a live project).
5. **Continue edit + export (process B)** — `edit_apply` (a second text
   overlay, `expectedRevision == revisionBefore`) ⇒ revision
   `revisionBefore + 1` (revision arithmetic unbroken across the
   restart); `project_save` to a **new** path `e2e-v2.openreel.json` ⇒
   ok; `project_save` back onto `e2e-v1.openreel.json` without
   `overwrite` ⇒ `CONFLICT` (default no-overwrite); then `export_start`
   → terminal `done`.
6. **Verify continuity (process B)** — (a) model: revision and timeline
   assertions above; (b) pixels: `preview_render_frame {timeSec:2.5}` in
   process B ⇒ `previewB.png`, and `verify_artifact` compare
   `{referencePath: previewA.png, mode:"similar"}` passes — the
   pre-restart content renders pixel-continuous in the new process;
   (c) the export passes the full `verify_artifact` battery of scenario
   1 step 9, including compare-similar against process B's own preview;
   (d) corruption honesty probes: a copy of `e2e-v1.openreel.json` with
   one byte flipped inside `project` ⇒ open refuses (integrity wording);
   a copy with `formatVersion: 999` ⇒ `UNSUPPORTED` (unknown-version
   wording); a copy opened after one referenced media file is renamed
   away ⇒ open refuses, details naming the offending `mediaId`; a
   checkpoint path supplied through a symlinked directory that escapes
   `projectRoots` ⇒ `INVALID_PARAMS` (escape wording).

**Evidence (both scenarios):** committed transcript (tool calls +
results), artifacts' and checkpoints' sha256s, client name/version, and
the per-step letter table — under
`docs/slice-2/` (tracked by default on `main`, Appendix F). A run may
only claim a
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
   with their own ADR). **Closed in r2.2:** the verbs landed — in the
   facade, with their own Decision 10 and the fourth red-team round
   below; the runner still carries no state of its own.
2. **Schema drift** — attack: schemas copied into the transport will rot;
   a schema-valid payload that the facade rejects would surface as a
   mysterious INTERNAL instead of INVALID_PARAMS. *Response:* Decision 4
   makes copies structurally impossible (import + CI deep-equal +
   differential corpus) and pins the drift ordering (Decision 4 ¶5: the
   schema is a boundary superset filter; the facade validators remain the
   only authority for cross-field rules such as `clip.trim`'s
   "at least one of in/out" and `verify` region bounds — the corpus must
   include schema-valid/facade-rejected cases and assert they surface as
   `INVALID_PARAMS`). Residual: even from a single declaration, an
   emitter bug could make the emitted schema diverge semantically from
   the runtime validator on exotic inputs; mitigated by the mutation
   sweep, accepted as CI-covered risk.
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
   remain the real fix (Appendix F, deferred candidate).

### Second round (r2, 2026-08-28) — findings that changed the text

8. **`run` could not express the loop it claims to support** — attack: a
   Pi-class agent must hand-write `job-…` and the artifact path into
   literal steps (impossible — they are minted at runtime), and the r1
   example's `expectedRevision:2` contradicted the facade (create ⇒ 0,
   import ⇒ 1, edit expects 1). *Response:* B.6 is now an executable
   workflow (stable step IDs, structural `$ref`/JSON-Pointer
   substitution, bounded `await`), with string templating and expression
   execution explicitly forbidden, and the revision example corrected.
9. **Signal ownership was racing Playwright** — attack: Playwright's
   default signal handlers kill the browser mid-dispose, defeating the
   bounded cleanup matrix. *Response:* Decision 7 now owns the lifecycle
   (`handleSIGINT/SIGTERM/SIGHUP: false` at launch — the slice's one
   minimal runtime change; first signal bounded cancel+dispose, second
   signal hard exit).
10. **"No TCP listener" was false as written** — the runtime's internal
    harness server binds `127.0.0.1:<ephemeral>`. *Response:* Decision 1
    now says what is true: no externally reachable transport/control
    listener; the loopback harness server is named, scoped, and its
    further hardening assigned to the Desktop-MCP track.
11. **Hard-kill residue was sugar-coated** — r1 promised "at most an
    inert `.part`", but a kill in the rename→hash/registration window
    strands a byte-complete `output.mp4`. *Response:* Decision 7 states
    both residues and the rule that neither may ever be reported as a
    successful ArtifactRef; `doctor` lists orphans without deleting them;
    E2E step 10 amended.
12. **Silent cwd-relative paths** — attack: relative paths in workflows
    or flags resolve against whatever cwd the runner happened to start
    in. *Response:* Decision 6 is absolute-path-only: roots canonicalized
    (realpath) at startup, non-absolute params rejected at the boundary,
    no `~` expansion.
13. **Twin hand-written schemas were the drift trap r1 claimed to
    avoid** — 12 hand-written JSON Schemas parked next to hand-rolled
    validators is two definitions of one contract. *Response:* Decision 4
    now requires one hand-maintained declaration per verb with both
    consumers derived; mechanism deferred to a bounded 2a spike; the
    adversarial/differential corpus is retained regardless.

### Third round (independent red team on r2, 2026-08-28)

A separate read-only agent attacked the r2 text on seven axes (`run`
expressiveness, signal ownership, stdout pollution, schema drift, path
containment, job races/terminal states, absolute claims). Verdict: **no
Decision invalidated**; seven text-level findings, all folded into the
current text: the absolute-path check now explicitly applies to
`$ref`-resolved values (a relative string smuggled through a reference
would otherwise reach the facade's cwd-relative fallback —
`path-roots.ts` resolves against `process.cwd()`); an Appendix A twin-
schema remnant reworded; "no tool call is ever long-blocking" qualified
(import/preview/verify are synchronous, bounded by input size);
`--keep-going` + workflow-error semantics and single-pass substitution
pinned; the composed first-signal bound (in-flight verb ceiling + 10 s
cancel race + bounded teardown) and the SIGHUP exit code stated;
negative probes acknowledged as multi-invocation work for MCP-less
agents; and channel/socket wording, a direct-spawn caveat for EOF
detection, and a transport-passthrough test pin added. Confirmed honest
while attacking: the revision arithmetic matches the facade exactly, a
failed job can never yield a wrong-typed splice (non-done await = step
failure; null artifact = pointer miss), replayed `export.start`
converges, and the `doctor` orphan listing is framed as future work, not
existing fact.

Verdict: **no finding invalidates a Decision**; two items (browser-reaper
verification, over-broad-root doctor warning) become implementation-slice
requirements; the rest is accepted, documented risk.

## Appendix F: Implementation slices, risks, and deferred candidates

**Suggested slices** (each lands tested; product-code changes are limited
to the three scoped in Consequences):

- **2a — schema single-source + facade persistence:** run the Decision-4
  spike, land the single declaration mechanism + emitter, migrate the 14
  verbs onto it,
  and pin the adversarial/differential corpus test. Validation behavior
  must not drift (the corpus proves it). Same slice lands Decision 10 in
  the facade: the `openreel-project@1` document module (atomic writer,
  full-validation reader, project-document closed schema), the
  `projectRoots` config slot, and the `project.open`/`project.save`
  verbs with their own unit + adversarial tests (atomicity, corruption,
  symlink escape, media-moved, revision continuity, active-project
  `CONFLICT`). Unblocks everything else.
- **2b — `serve`:** transport package, exact-pinned
  `@modelcontextprotocol/sdk`, stdio server, 14 tools, Decision 5/6/7
  contracts — including the one-line runtime launch change
  (`handleSIGINT/SIGTERM/SIGHUP: false`) with its own test (signal →
  bounded cancel → dispose; second signal → hard exit) — and the stdout
  guard in CI.
- **2c — `run` + `doctor`:** the B.6 workflow executor (static
  validation, `$ref` resolution, bounded `await`, stop-on-first-failure)
  + the honest environment report (incl. over-broad-root warning,
  canonical-root echo for all three root classes, orphan-artifact
  listing, browser-reaper verification from Appendix E).
- **2d — SKILL + black-box E2E:** SKILL.md (Decision 9), execute Appendix
  D scenario 1 against ≥2 real clients and scenario 2 (persistence) at
  least over `run` and one MCP client, commit evidence.

**Risk register (slice-specific):** SDK/spec revision churn (exact pin;
2025-03-26 vs 2025-06-18 framing differences verified at implementation
time) · stdout pollution by transitive deps (guard) · client timeout
defaults (60 s Codex/DSH — solved by the job shape; document per-client
config for `preview_render_frame` on huge projects) · Claude 25 k-token
ceiling vs `project_get_state` (Decision 8; paging is a deferred
candidate) · jobs/ledger die with process (documented; SKILL rule) ·
hard-kill residue — inert `.part` **or** unregistered byte-complete
`output.mp4` (Decision 7; never reported as an ArtifactRef; `doctor`
lists orphans, no auto-delete this slice) · in-memory ledger growth on a
long-lived `serve` (deferred candidate: ledger GC or session-uptime
guidance) · DSH developer-preview churn (evidence re-run per release) ·
one server=one project means N projects need N connections (stated, not
solved) · `$ref` workflows pointing at reshaped results (pointer misses
fail the run loudly — the workflow contract is the result-value shapes,
already frozen by the facade's typed results) · checkpoint media
fingerprint is size+mtime, not a content hash (same-size same-mtime
swaps pass — accepted, 10.6) · checkpoint realpath-then-read TOCTOU
(same class as the existing import containment; accepted, 10.6) ·
hand-edited checkpoints that pass structural validation are operator
input, trusted at operator level (stateSha256 is corruption detection,
not provenance, 10.6) · save/open cost is bounded by project size and
media count respectively (full-document serialization, per-item
fingerprint stat) · Windows rename-over-existing limits surface only
under `overwrite:true` (10.3; the default no-overwrite mode is
unaffected) · versioned checkpoints accumulate by design; retention is
the operator's policy (deferred candidate 8).

**Decided by this ADR (r2.2):**

1. **MCP core = official `@modelcontextprotocol/sdk`, exact-pinned**, in
   a new `packages/agent-transport` — package name
   `@openreel/agent-transport`, binary `agent-video` (names bound in
   r2.2). No hand-rolled core. (Was product decision 1 in r1.)
2. **Desktop-MCP hardening stays a separate, independent track** (ADR
   0001 §5): this slice neither depends on it nor advances it, and the
   old Desktop MCP is not reused as this slice's transport in any form.
   (Was product decision 8 in r1.)
3. `.gitignore` whitelist entry for `docs/slice-2/` is **obsolete** —
   the repository-hygiene merge removed the ignore-by-default docs
   policy. (Was product decision 7 in r1.)
4. **Facade persistence pair (r2.2):** `project.open`/`project.save`,
   the `projectRoots` root class, and the single
   `openreel-project@1` checkpoint format shared by `serve`, `run`, and
   future agent bindings — the third scoped product-code change. The
   facade contract reported by `session.describe` becomes
   `facade-slice-2` with 14 verbs.

**Deferred candidates — explicitly NOT in slice 2** (each requires its
own future decision/ADR; the transport must not grow them as
conveniences):

1. Facade paging/summary read verbs (`project.state_summary` /
   `get_state` paging) — the real context-budget fix.
2. ~~Facade `project.open`/`save` verbs~~ — **landed in r2.2** (Decision
   10); kept here struck-through so the history of the deferral is not
   lost.
3. Artifact GC verb or retention policy for hard-kill residue (`.part`
   and unregistered `output.mp4` orphans; `doctor` already lists them).
4. Idempotency-ledger GC policy for long-lived `serve` sessions.
5. MCP image content blocks for previews (default **off** — preview
   returns an ArtifactRef).
6. Media **relink** verb — today a checkpoint whose media moved fails
   open honestly (10.4); relink is the deliberate, user-visible fix,
   not silent path fuzzing.
7. Checkpoint **migration framework** — unknown `formatVersion` is
   refused honestly (10.4); a version bump gets its own reader + ADR.
8. Checkpoint **retention/GC policy** — versioned checkpoints accumulate
   by design; cleanup is the operator's call, never the transport's.
