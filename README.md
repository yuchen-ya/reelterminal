# Agent Video Engine Lab

A video engine where humans and agents can each edit independently—or work
together in the same timeline. One canonical project world, three modes:
human-only (GUI), agent-only (MCP/CLI/headless), and live human+agent
collaboration. Forked from [OpenReel](https://github.com/Augani/openreel-video)
(MIT), being prepared for open-sourcing.

**Stage: early slices.** Two slices of real, tested machinery exist (below);
everything else — transports, full verb coverage, live GUI↔agent parity — is
roadmap, not present.

## Status at a glance

| Slice | State | What it proves |
|---|---|---|
| Slice 1 — headless agent facade | **Merged** ([PR #1](https://github.com/yuchen-ya/agent-video-engine-lab/pull/1)) | An agent can create a project, import media, build and trim a timeline, and add text — atomically, idempotently, over the canonical `Project` state, in pure Node. |
| Slice 1b — Chromium render/export runtime | **Merged** ([PR #2](https://github.com/yuchen-ya/agent-video-engine-lab/pull/2)) | The same agent surface renders real pixels: PNG frame previews, H.264 MP4 exports with audio, and ffprobe/pixel-level artifact verification — with probe-verified, honestly reported capabilities. |
| Slice 2+ (MCP/CLI/SKILL transports, wider verbs, live GUI parity) | Not started | See [Roadmap](#roadmap-near-term). |

## Relationship to OpenReel

This repository is a fork of the OpenReel video editor by **Augustus Otu and
Contributors**, MIT licensed ([LICENSE](LICENSE), copyright retained).

**Inherited from upstream** (kept, not re-verified by this lab beyond what the
slices exercise): the browser editor product (`apps/web`), the desktop /
studio / image apps, the core engines and canonical `Project` model
(`packages/core`), and the upstream 304-tool agent registry
(`packages/agent`, `packages/agent-runner`).

**Built by this lab:** the extraction audit (`audit/`), the agent facade
(`packages/agent-facade`), the Chromium runtime (`packages/runtime-chromium`),
the ADRs (`docs/adr/`), and the design principles
([`docs/design-principles.md`](docs/design-principles.md)).

The upstream product's feature list and browser-support claims are **not**
re-claimed here; for the product itself, see upstream. This README only
describes what this repository has actually built and verified.

## The first principle: Human–Agent Operational Parity

*One project world, two interfaces, equal operational authority.*

The GUI and the agent API must drive the same canonical `Project`, the same
editing engine, and the same artifact world: GUI buttons, state, and visual
results have stable agent commands, machine-readable state, and observable
artifacts as counterparts — and agent edits are reflected in the same project
the human sees. No GUI-only business state, no agent shadow state, no
second-class "AI features" surface. Parity means equal semantic capability
within the same safety boundaries; it never licenses bypassing them.

Full text and today's honest conformance table:
[`docs/design-principles.md`](docs/design-principles.md).

## What works today (verified)

The facade exposes **12 verbs** returning typed results
(`{ok:true,value} | {ok:false,error}`), with atomic snapshot batches,
`expectedRevision` optimistic concurrency, idempotency keys, strict closed
schemas, and live-preflight capability reporting:

- **Slice 1:** `session.describe` · `capabilities.get` · `project.create` ·
  `project.get_state` · `media.import` · `timeline.get` · `edit.apply`
- **Slice 1b:** `preview.render_frame` · `export.start` · `job.status` ·
  `job.cancel` · `verify.artifact`

API, usage, and per-package limits:
[`packages/agent-facade/README.md`](packages/agent-facade/README.md) ·
[`packages/runtime-chromium/README.md`](packages/runtime-chromium/README.md).

**Platform evidence (machine-readable):**

- Windows (`win32/x64` in the probe; Windows 11 per PR #2), Chromium 148:
  [`docs/slice-1b/runtime-probe/windows-local.json`](docs/slice-1b/runtime-probe/windows-local.json)
  and
  [`…-verify-report.json`](docs/slice-1b/runtime-probe/windows-local-verify-report.json)
  — route `chromium-webcodecs`, 150-frame H.264/AAC MP4, pixel checks pass.
- macOS (`darwin/arm64` in the probe; macOS 15 on the host), Node 22,
  Chromium 148:
  [`docs/slice-1b/runtime-probe/macos-local.json`](docs/slice-1b/runtime-probe/macos-local.json)
  and
  [`…-verify-report.json`](docs/slice-1b/runtime-probe/macos-local-verify-report.json)
  — route `chromium-webcodecs`, 150-frame H.264/AAC MP4, pixel checks pass.
- Linux CI: the `chromium-e2e-evidence` artifact uploaded by every
  `Chromium E2E (Slice 1b)` run.

## Architecture

```
packages/core              canonical Project model + engines (inherited upstream)
packages/agent-facade      pure-Node, in-process, transport-agnostic agent API
                           (12 verbs; owns state semantics, jobs, idempotency)
packages/runtime-chromium  Playwright-driven Chromium + ffmpeg providers
                           (pixels, H.264 export, artifact verification)
apps/web                   inherited browser editor GUI (Vite/React)
audit/                     frozen extraction audit + machine evidence (historical)
docs/adr/                  why the design is what it is (ADR 0001, 0002)
docs/design-principles.md  enduring principles (Principle 1: parity)
docs/slice-1b/             committed platform probe/verify evidence
```

The facade never imports Chromium/Playwright/ffmpeg; pixels arrive through
three independent provider interfaces (`RenderProvider`, `ExportProvider`,
`ArtifactVerifier`). Export defaults to **Route W** (in-page WebCodecs H.264
+ AAC); **Route F** (frames→ffmpeg) is a video-only, explicitly forced
experiment — never a silent fallback. Details and rationale:
[ADR 0002](docs/adr/0002-chromium-runtime-slice-1b.md).

## Quick start

Prerequisites, as verified on this machine (macOS arm64) and in CI (Ubuntu):

- **Node 22** (CI uses 22; `engines` floor is 18)
- **pnpm 11.7** via corepack — the repo pins `packageManager: pnpm@11.7.0`
- **ffmpeg + ffprobe** on `PATH` (`brew install ffmpeg` on macOS;
  `apt-get install ffmpeg` on Ubuntu) — needed for `verify.artifact`
- **Chromium** via Playwright (installed below), or a system Chrome passed
  via config (`executablePath`)

```bash
git clone git@github.com:yuchen-ya/agent-video-engine-lab.git
# or over HTTPS: git clone https://github.com/yuchen-ya/agent-video-engine-lab.git
cd agent-video-engine-lab

corepack pnpm install

# one-time browser install for the render/export runtime
pnpm --filter @openreel/runtime-chromium exec playwright-core install chromium

# focused test suites — the lab's verified surface
pnpm --filter @openreel/agent-facade test:run       # 18 files, pure Node
pnpm --filter @openreel/runtime-chromium test:run   # 6 files, real Chromium
```

To run the inherited browser editor GUI: `pnpm dev` (Vite dev server).
A full end-to-end agent scenario (create → import → trim → text → PNG →
MP4 → verify) lives in
[`packages/runtime-chromium/examples/hello-world-e2e.mts`](packages/runtime-chromium/examples/hello-world-e2e.mts).

## Repository map

| Path | What it is | Status |
|---|---|---|
| `packages/agent-facade` | The lab's agent API (Slice 1 + 1b verbs) | Active, tested |
| `packages/runtime-chromium` | Chromium render/export providers | Active, tested |
| `packages/core` | Canonical `Project` model, engines | Inherited; exercised by the slices |
| `packages/agent`, `packages/agent-runner` | Upstream 304-tool agent layer + CLI | Inherited; **not** the lab's contract |
| `apps/web` | Browser editor GUI | Inherited; runs via `pnpm dev` |
| `apps/desktop`, `apps/studio`, `apps/image` | Desktop/studio/image apps | Inherited |
| `audit/` | Extraction audit (304 tools, 52 risks) + reproducible probes | Frozen historical evidence |
| `docs/adr/` | Architecture decision records | Canonical "why" |
| `docs/design-principles.md` | Enduring design principles | Canonical |
| `docs/slice-1b/` | Platform probe/verify evidence JSON | Growing evidence |
| `docs/AGENT-*.md`, `docs/AUTH-BROKER.md`, `docs/superpowers/` | Upstream product/planning docs | Historical; partially stale (see [`docs/README.md`](docs/README.md)) |

## Testing

- Focused: the two `pnpm --filter … test:run` commands above.
- Repo-wide: `pnpm test` · `pnpm typecheck` · `pnpm lint`.
- CI (`.github/workflows/`): `ci.yml` runs typecheck/lint/tests + build on
  Ubuntu with Node 22, Chromium, and ffmpeg; `chromium-e2e.yml` runs the
  focused Slice-1b suites and always uploads the probe/verify evidence
  artifact.

## Not implemented yet

- **No MCP / CLI / SKILL transports for the facade.** It is an in-process
  library by design (ADR 0001); transports are a future slice.
- The inherited upstream surfaces — the Desktop MCP shim (`apps/desktop`) and
  the `@openreel/agent-runner` CLI — are **not** the lab's contract; the
  audit rates the Desktop MCP debugger-grade (DESK-01/02/04) and ADR 0001
  requires hardening before any public transport exposure.
- **No live GUI↔agent session.** The facade runs headless; the parity gap is
  tracked in `docs/design-principles.md`.
- Most of the wider verb set from `audit/facade-v0.md` (project open/save,
  `history.*`, media list/delete, richer edit ops).
- No cloud GPU, no OCR, no project replace/reset.

## Known limitations (slice-scoped)

One Chromium page serializes preview/export per session · Route F is
video-only by design · codec support is build-dependent and probe-measured,
never assumed · files >2 GiB are refused · the idempotency ledger is not
restart-durable · one project per session, no reset verb. Full lists:
package READMEs linked above.

## Roadmap (near term)

1. ~~Land Slice 1b (PR #2), including this documentation overhaul.~~ **Done**
   — merged to `main`.
2. Slice 2: thin MCP + CLI + SKILL transports over the existing 12 verbs —
   no copy of the internal 304-tool registry (still gated on the Desktop-MCP
   hardening decision in ADR 0001).
3. Black-box E2E with a fresh Codex / Claude Code / Pi-class agent over those
   transports: discover capabilities, import media, edit, preview, export,
   verify.
4. Widen the verb / edit-op set based on real agent-usage friction and
   `audit/runtime-matrix.csv` (including remaining `facade-v0` verbs:
   open/save, history, media management).
5. Progressively close the live-GUI parity gap last
   (`docs/design-principles.md` conformance table).

## License and attribution

MIT — see [LICENSE](LICENSE). Copyright (c) 2024–2026 Augustus Otu and
Contributors (upstream OpenReel); lab contributions are under the same
license. Built on [mediabunny](https://mediabunny.dev),
[Playwright](https://playwright.dev), [FFmpeg](https://ffmpeg.org), React,
and TypeScript.
