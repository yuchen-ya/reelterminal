# Docs index — where information lives

One fact, one home. Before adding documentation, pick the row whose audience
you are writing for; do not copy content across rows — link instead.

| Home | Owns | Audience |
|---|---|---|
| [`README.md`](../README.md) (root) | What the project is, current stage, quick start, repo map | First-time visitor |
| `packages/<pkg>/README.md` | That package's API, usage, guarantees, and limits | Package user |
| [`docs/adr/`](adr/) | **Why** the design is what it is — point-in-time decisions, frozen once accepted | Maintainer |
| [`docs/design-principles.md`](design-principles.md) | Enduring principles (Principle 1: Human–Agent Operational Parity) with an honest conformance table | Everyone |
| [`audit/`](../audit/) | **Historical evidence**: the 2026-08-27 extraction audit (304 tools, 52 risks) and reproducible probes. Frozen; never rewritten as product docs | Archeologist |
| `docs/slice-1b/` | Committed machine-readable platform evidence (runtime probe / verify reports) | Verifier |
| PR descriptions | What **that PR** changes and how it was verified — never a manual | Reviewer |

## Current contents

- [`adr/0001-headless-facade-slice-1.md`](adr/0001-headless-facade-slice-1.md) —
  Slice 1: in-process facade, Project-authoritative state, no transport.
- [`adr/0002-chromium-runtime-slice-1b.md`](adr/0002-chromium-runtime-slice-1b.md) —
  Slice 1b: provider interfaces, runtime probe, honest export routes,
  containment, watchdog (incl. amendments A3–A7).
- [`design-principles.md`](design-principles.md) — Principle 1:
  Human–Agent Operational Parity.
- [`slice-1b/runtime-probe/`](slice-1b/runtime-probe/) — platform evidence:
  `windows-local.json` (+ `-verify-report.json`), `macos-local.json`
  (+ `-verify-report.json`). Linux evidence lives in the CI
  `chromium-e2e-evidence` artifact.

## Inherited upstream docs (kept for reference, not the lab's contract)

- [`AGENT-GUIDE.md`](AGENT-GUIDE.md) — upstream product guide for AI editing
  (web BYOK chat, Desktop MCP, headless runner). Describes the **upstream**
  surfaces, not the facade; its "72 tools" figure is stale.
- [`AGENT-CAPABILITIES.md`](AGENT-CAPABILITIES.md) — auto-generated upstream
  tool reference. **Stale**: says 228 tools; the audit counted 304
  (`audit/AUDIT-SUMMARY.md`). Do not regenerate by hand.
- [`AUTH-BROKER.md`](AUTH-BROKER.md) — upstream GPU-job auth broker contract.
- [`superpowers/`](superpowers/) — upstream planning history (2026-05 →
  2026-07 plans and specs). Historical.

## House rules

- `docs/*` is git-ignored by default (leftover scratch-docs policy). Real
  documents must be un-ignored in `.gitignore` — as `adr/`, `slice-1b/`,
  `design-principles.md`, and this index already are. If you add a doc and it
  does not show up in `git status`, that is why.
- Audit files and ADRs are frozen once landed: correct them by amendment
  (see ADR 0002's A3–A7), not by silent rewrite.
