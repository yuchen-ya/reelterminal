# Docs index — where information lives

One fact, one home. Before adding documentation, pick the row whose audience
you are writing for; do not copy content across rows — link instead.

| Home | Owns | Audience |
|---|---|---|
| [`README.md`](../README.md) (root) | What the project is, current stage, quick start, repo map | First-time visitor |
| [`docs/product-scope.md`](product-scope.md) | Product boundary: external-agent ownership, finishing workflow, and native feature retention rule | Product + engineering |
| [`docs/external-agent-conversation-adapter.md`](external-agent-conversation-adapter.md) | Open protocol for attaching an optional view to an external Agent conversation | Adapter authors |
| `packages/<pkg>/README.md` | That package's API, usage, guarantees, and limits | Package user |
| [`docs/adr/`](adr/) | **Why** the design is what it is — point-in-time decisions, frozen once accepted | Maintainer |
| [`docs/design-principles.md`](design-principles.md) | Enduring principles (Principle 1: Human–Agent Operational Parity) with an honest conformance table | Everyone |
| [`audit/`](../audit/) | **Historical evidence**: the 2026-08-27 extraction audit (304 tools, 52 risks) and reproducible probes. Frozen; never rewritten as product docs | Archeologist |
| `docs/slice-1b/` | Committed machine-readable platform evidence (runtime probe / verify reports) | Verifier |
| PR descriptions | What **that PR** changes and how it was verified — never a manual | Reviewer |

## Current contents

- [`product-scope.md`](product-scope.md) — ReelTerminal as the last stop for AI
  video: external-agent session ownership, shared project authority, numbered
  references, localization, and the rule for pruning inherited features.
- [`adr/0001-headless-facade-slice-1.md`](adr/0001-headless-facade-slice-1.md) —
  Slice 1: in-process facade, Project-authoritative state, no transport.
- [`adr/0002-chromium-runtime-slice-1b.md`](adr/0002-chromium-runtime-slice-1b.md) —
  Slice 1b: provider interfaces, runtime probe, honest export routes,
  containment, watchdog (incl. amendments A3–A7).
- [`adr/0005-external-agent-conversation-bridge.md`](adr/0005-external-agent-conversation-bridge.md) —
  provider-neutral external-session attachment foundation, landed loopback
  reference transport, and the open thin-adapter contract.
- [`external-agent-conversation-adapter.md`](external-agent-conversation-adapter.md) —
  capability levels, session attach, loopback descriptor, JSON-RPC/event
  sequencing, ownership, safe event vocabulary, and downgrade rules.
- [`../scripts/conversation-adapter/`](../scripts/conversation-adapter/) —
  minimal `basic`/observable (`full`) fixtures and the network-free conformance
  validator.
- [`design-principles.md`](design-principles.md) — Principle 1:
  Human–Agent Operational Parity.
- [`slice-1b/runtime-probe/`](slice-1b/runtime-probe/) — platform evidence:
  `windows-local.json` (+ `-verify-report.json`), `macos-local.json`
  (+ `-verify-report.json`). Linux evidence lives in the CI
  `chromium-e2e-evidence` artifact.

## Guides and inherited history

- [`AGENT-GUIDE.md`](AGENT-GUIDE.md) — current external-Agent desktop
  connection guide. It describes the 17-tool live facade and explicitly does
  not provide embedded BYOK chat.
- [`superpowers/`](superpowers/) — upstream planning history (2026-05 →
  2026-07 plans and specs). Historical.

## House rules

- `docs/` is tracked by default. The old scratch-docs policy (`docs/*`
  git-ignored, real documents force-added) is gone; the only ignore patterns
  are precise scratch rules in `.gitignore` (`docs/**/*.local.md`,
  `docs/**/scratch/`). If a new doc does not show up in `git status`, check
  it does not match those.
- Audit files and ADRs are frozen once landed: correct them by amendment
  (see ADR 0002's A3–A7), not by silent rewrite.
