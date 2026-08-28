# Contributing to Agent Video Engine Lab

This is the **agent-video-engine-lab** repository (`yuchen-ya/agent-video-engine-lab`):
a laboratory for agent-first video editing, forked from the OpenReel video
editor. This guide describes *this* repository — how to set it up, where the
lab's own code lives, and what "done" means here.

> **Attribution.** This repository is a fork of
> [OpenReel](https://github.com/Augani/openreel-video) by **Augustus Otu and
> Contributors**, MIT licensed. The browser editor (`apps/web`), the desktop /
> studio / image apps, the core engines and canonical `Project` model
> (`packages/core`), and the upstream agent layer (`packages/agent`,
> `packages/agent-runner`) are inherited from upstream; copyright and license
> are retained ([LICENSE](LICENSE)). The extraction audit, the agent facade,
> the Chromium runtime, and the ADRs are built by this lab. The upstream
> project remains the place for the product itself and its feature claims.

## What this repo is (and is not)

Read [`README.md`](README.md) first — especially "Status at a glance" and
"What works today (verified)". This is a lab: a small, honest, tested surface
(`packages/agent-facade`, `packages/runtime-chromium`) over a large inherited
codebase. Most of the tree is inherited upstream code that the lab does **not**
re-verify; do not present inherited behavior as lab-verified.

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
git clone https://github.com/yuchen-ya/agent-video-engine-lab.git
cd agent-video-engine-lab

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
packages/agent-facade      lab: pure-Node agent API (12 verbs)
packages/runtime-chromium  lab: Chromium render/export + verification
packages/agent|agent-runner  inherited upstream agent layer (not the lab contract)
audit/                     frozen extraction audit + machine evidence
docs/adr|slice-1b          ADRs and committed platform evidence
```

Package names stay `@openreel/*` (inherited); the repository itself is
`agent-video-engine-lab`.

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
4. Lab PRs are reviewed directly by the maintainer.

## Questions

Open a [GitHub issue](https://github.com/yuchen-ya/agent-video-engine-lab/issues).
For the upstream OpenReel product itself, see
[upstream](https://github.com/Augani/openreel-video).

---

Thank you for contributing — and for keeping the lab's reporting honest. 🎬
