# Contributing to ReelTerminal

This is the **ReelTerminal** repository (`yuchen-ya/reelterminal`): an
agent-native video finishing editor forked from OpenReel. This guide describes
how to set it up, where the project-specific code lives, and what "done" means
here.

> **Attribution.** This repository is a fork of
> [OpenReel](https://github.com/Augani/openreel-video) by **Augustus Otu and
> Contributors**, MIT licensed. The browser editor (`apps/web`), the desktop /
> studio / image apps, and the core engines and canonical `Project` model
> (`packages/core`) are inherited from upstream; copyright and license are
> retained ([LICENSE](LICENSE)). The extraction audit, the agent facade,
> Chromium runtime, and external-Agent integration are maintained by
> ReelTerminal. Upstream claims do not automatically become ReelTerminal
> claims.

## What this repo is (and is not)

Read [`README.md`](README.md) first, especially the product boundary and
current-status sections. ReelTerminal keeps a deliberately small, tested Agent
surface over a large inherited editor codebase. Do not present unverified
inherited behavior as ReelTerminal-specific work.

Design background, in reading order:

- [`docs/design-principles.md`](docs/design-principles.md) — enduring
  principles (Principle 1: Human–Agent Operational Parity) with an honest
  conformance table.
- [`docs/adr/`](docs/adr/) — why the design is what it is. ADRs are frozen
  once accepted; correct them by amendment, not silent rewrite.
- [`docs/README.md`](docs/README.md) — docs index and house rules.

## Getting started

Prerequisites (as verified on macOS arm64 and Ubuntu CI):

- **Node 22** (CI uses 22; the `engines` floor is 18)
- **pnpm 11.7** via corepack — the repo pins `packageManager: pnpm@11.7.0`
- **ffmpeg + ffprobe** on `PATH` — needed by the runtime's artifact verifier
- **Chromium** via Playwright (installed below)

```bash
git clone https://github.com/yuchen-ya/reelterminal.git
cd reelterminal

corepack pnpm install

# one-time browser install for the render/export runtime
pnpm --filter @openreel/runtime-chromium exec playwright-core install chromium

# focused test suites — the lab's verified surface
pnpm --filter @openreel/agent-facade test:run       # pure Node
pnpm --filter @openreel/runtime-chromium test:run   # real Chromium + ffmpeg

# the inherited browser editor GUI (optional)
pnpm dev
```

## Repository layout

```
apps/web                   inherited browser editor GUI (Vite/React)
apps/desktop|studio|image  inherited Electron / auxiliary apps
packages/core              canonical Project model + engines (inherited)
packages/agent-facade      typed headless/live API (16 verbs)
packages/runtime-chromium  Chromium render/export + verification
packages/agent-transport   optional headless MCP/workflow transport
audit/                     frozen extraction audit + machine evidence
docs/adr|slice-1b          ADRs and committed platform evidence
```

Package names stay `@openreel/*` for source and project-format compatibility;
the product and repository are named `ReelTerminal`.

## Making changes

### Scope discipline

- Changes to the lab's verified surface (`agent-facade`,
  `runtime-chromium`) must come with tests and, when they change behavior,
  updated package-README limits and — for durable decisions — an ADR or ADR
  amendment.
- Inherited code: fix build breakage and real bugs; do not refactor or
  "clean up" wholesale. The audit (`audit/`) is frozen historical evidence —
  never rewrite it; amend instead.
- Do not widen claims: if a test does not cover it, do not document it as
  verified.

### Branches and commits

```bash
git checkout -b feat/add-transition-effects   # feat/ | fix/ | docs/ | chore/
```

Follow conventional commits:

```
feat: add crossfade transition verb
fix: resolve timeline scrubbing lag
docs: update ADR 0002 with amendment A8
chore: bump playwright-core
```

Keep commits focused and atomic; rebase onto `origin/main` before opening a PR.

### Coding standards (inherited baseline)

- TypeScript strict mode; prefer `interface` for object shapes; avoid `any`
  (use `unknown` or proper types).
- Naming: components `PascalCase`, functions `camelCase`, constants
  `UPPER_SNAKE_CASE`; files `kebab-case.ts` or `PascalCase.tsx` for components.
- Comment *why*, not *what*; add JSDoc for public APIs; no stray
  `console.log` or TODOs without an issue.

## Testing

```bash
pnpm test        # repo-wide, single run
pnpm typecheck
pnpm lint
pnpm build       # wasm + web build
```

CI (`.github/workflows/`): `ci.yml` runs typecheck/lint/tests + build on
Ubuntu with Node 22, Chromium, and ffmpeg; `chromium-e2e.yml` runs the focused
Slice-1b suites and always uploads the probe/verify evidence artifact.

For runtime changes, tests must produce real evidence (probe/verify JSON),
not just assertions — see `packages/runtime-chromium/README.md`.

## Submitting changes

1. Push your branch and open a PR against `main` (the PR template asks for
   description, testing, and verification evidence).
2. Keep the description honest about what was verified and what was not.
3. Respond to review feedback; push updates to the same branch.
4. ReelTerminal PRs are reviewed directly by the maintainer.

## Questions

Open a [GitHub issue](https://github.com/yuchen-ya/reelterminal/issues).
For the upstream OpenReel product itself, see
[upstream](https://github.com/Augani/openreel-video).

---

Thank you for contributing — and for keeping ReelTerminal's reporting honest. 🎬
