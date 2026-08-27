# ADR 0001: Headless Agent Facade — Slice 1 (state-level, pure Node)

- Status: Accepted
- Date: 2026-08-27
- Branch: `feat/headless-facade-slice-1`
- Context: extraction audit (`audit/AUDIT-SUMMARY.md`, CONDITIONAL GO), facade
  design (`audit/facade-v0.md`), E2E contract (`audit/e2e-contract.md`).

## Decisions

### 1. In-process library first

The agent-facing facade ships as a new pure-Node, in-process TypeScript
library (`packages/agent-facade`), not as a service and not as an extension of
the existing 304-tool registry. The registry remains the internal/live
surface; the facade is the external contract. Transports (MCP, CLI) are
deliberately out of scope for this slice and can wrap the library later
without changing its semantics.

### 2. Project-authoritative state

The core `Project` is the canonical state. The Node side performs model
editing only. Every mutation is a facade-owned snapshot transaction: ops are
applied to a `structuredClone`d draft via the core `ActionExecutor`, and the
draft replaces the live project only when every op succeeds. Atomicity
therefore does NOT depend on core `executeMany`/`batch_actions`
(non-atomic, CORE-01) or core undo (null-inverse trap, CORE-02) — a failed
batch discards the draft and the original project object is byte-exact
untouched. Interleaving safety comes from a serialized execution lane plus a
facade-owned `revision` counter (`expectedRevision` → CONFLICT) and an
idempotency ledger (`idempotencyKey` → at-most-once), because core has no
revision concept and mints fresh ids per call.

Text overlays are written as canonical `project.textClips` entries (full
`TextClip` with core defaults) on a real `type:"text"` track. We do NOT sync
the Node `titleEngine` singleton and do NOT treat it as a pixel solution;
the serialized Project alone is the hydration contract. This slice makes no
claim that text pixels were verified.

### 3. Chromium runtime adapter for pixels/export

Preview and export require browser primitives (OffscreenCanvas/WebCodecs);
no pure-Node pixel path exists (audit finding #2). The facade therefore
reserves an explicit seam — `ProjectRenderAdapter`
(`packages/agent-facade/src/render/adapter.ts`): `hydrateFromProject` +
`renderFrame` — to be implemented by a Chromium harness (Playwright driving
the existing web job runner) in Slice 1b. Until an adapter is injected,
`capabilities.get` must report preview/export as unavailable (fixing
RUNNER-06 "capability lies by omission").

### 4. system/configurable ffprobe later (Slice 1b)

Artifact verification (`verify.artifact`: container/codec/duration probe +
frame extract + OCR/pixel check) is deferred to Slice 1b and will spawn a
system or configurable ffprobe binary (~30 LOC once a binary source is
chosen). Slice 1 media metadata comes from mediabunny in-process; no ffprobe
dependency is introduced now, and no ffmpeg/ffprobe binary is committed.

### 5. Desktop MCP hardening required before public Beta

The desktop MCP transport remains debugger-grade (DESK-01/02/04: unfiltered
304-tool exposure, token written to a 0600 endpoint file AND shown in the
UI, default-on auto-allow gate, timed-out calls keep mutating). None of that
is acceptable for an external agent surface. Before any public Beta exposes a
transport, the Desktop MCP boundary must be hardened (auth scope, filtered
tool set, confirmation policy inversion, transaction semantics). This slice
ships no transport at all, so the exposure does not widen.

## Consequences

- Closed op set in `edit.apply` (`track.add`, `clip.add`, `clip.trim`,
  `text.create`); everything else fails `INVALID_PARAMS` with zero side
  effects. Widening the op set is an explicit future decision per op.
- `media.import` accepts local files under caller-configured media roots
  only; arbitrary URLs are rejected in this runtime.
- Idempotency ledger is scoped per session+project+verb and pins the
  mutation payload (key reuse with a different payload is a CONFLICT); it
  does not survive process restarts (documented v0 limitation).
- The 52 audit risks are NOT fixed wholesale here; the slice only avoids the
  audited traps on its own path (CORE-01/02/08, MEDIA-03/04, RUNNER-06,
  ADV-03).
