# ReelTerminal

> **ReelTerminal，你的 AI 视频终点站。生成发生在任何地方，成片发生在这里。**
>
> **ReelTerminal — your AI video's final stop. Generate anywhere; finish here.**

ReelTerminal is an agent-native video finishing editor. An external Agent, a
skill, ComfyUI, or any other creation system may generate video, images,
audio, animation, and text. ReelTerminal turns those ingredients into one
reviewable timeline and one finished, verifiable film.

The human and the external Agent are equal peers: they have equal semantic
authority over the same project, but use different paths. The user works in
the GUI; the Agent works through the live facade. Both paths meet at the
canonical `Project`, revision checks, undo/redo, preview, and export.

ReelTerminal does not embed a general-purpose conversational Agent or generative
model, select its provider, hold its BYOK key, run its tool-use loop, or own
conversation history. It is the place where generated inputs become a
finished film—not another agent or chat provider. Task-specific finishing
algorithms such as transcription remain ordinary editor tools; they never
become a second conversational authority.

The product and repository are named **ReelTerminal**. Workspace packages are
unified under `@reelterminal/*`, the desktop bridge's primary key is
`window.reelterminal` (the legacy `window.openreel` key remains available as a
compatibility alias), agent endpoint files live under `~/.reelterminal/` by
default (legacy `~/.openreel/` paths are still discovered when owned by this
app), and the CLI ships under `reelterminal-*` names with thin legacy-command
aliases. Remaining inherited identifiers—`.openreel` project/state formats,
persistence keys, and `openreel-*` protocol markers—are versioned compatibility
contracts, not the user-facing brand. The authoritative naming and
compatibility policy is
[`docs/NAMING-AND-COMPATIBILITY.md`](docs/NAMING-AND-COMPATIBILITY.md).

## Current status

The current foundation combines live collaboration, scoped editing and analysis
tools, and bundled read-only tool extensions. The status below separates
implemented features, reusable foundations, and remaining integration work.

### Implemented in this checkout

- The browser/desktop editor and the canonical ReelTerminal `Project` model share
  one editing world.
- A token-authenticated loopback Command API exposes the canonical command
  catalog, including bundled plugins. `reelctl` is the default Agent entry point;
  `reelctl mcp serve` is an explicit compatibility adapter. Discover commands
  and parameters with `reelctl schema` and `reelctl help`.
- Live revision and context checks, one-writer lease semantics, independent
  explicit read-only/write access, shared undo, and action
  activity status are in place.
- `visual_inspect` provides bounded, read-only frame sampling by clip or time
  range, with revision-tagged PNG artifacts and a real contact sheet when the
  configured renderer supports native composition.
- `media.inspect` samples original imported video ranges, including media not
  on the timeline, using a detached render composition. Both inspection tools
  can show verified PNG evidence in the desktop's dismissible inspection panel.
  Sparse frames do not review continuous motion, audio, or editing rhythm.
- Scoped `timeline.query` reads, `project.changes` delta recovery,
  `edit.validate` preflight, and live `history.get`/`history.control` support
  iterative editing. `media.analyze_start` implements `technicalQuality`
  (built-in probe), `audioSummary` (local FFmpeg), the dedicated
  `silence` and `beatGrid` types that share the GUI panels' core silence
  and beat-detection kernels, and the opt-in cloud `videoReview` (the
  user's own provider credential); the remaining declared analysis types
  report unavailable.
- The atomic `edit_apply` vocabulary covers placement, moving, trimming,
  splitting, duplication, ripple deletion, constant speed/reverse, visual
  transforms and crop, volume, fades, ordinary removal, clip transitions,
  text overlay creation/update/deletion, track updates, media display-name
  renaming, safe track/media removal,
  review markers, SRT subtitle import, temperature/tint grading, clip
  video-effect stack application (closed parametered engine effect types;
  the GUI's "Auto-Color" is a fixed preset, not AI), fixed-key
  chroma keying (green screen), local audio noise reduction, audio ducking
  via envelope keyframes, AI background removal (matte; rendered inside the
  desktop GUI via MediaPipe person segmentation), Auto Reframe
  crop-plan application (keyframed single-clip crop with canvas retarget),
  self-contained SVG overlay creation/update/removal on graphics tracks,
  media source
  replace/relink, review comparisons, project-scoped work-asset capture
  and reuse (single clips or multi-clip selections saved as one asset and
  restored by relative time and lane relations), and supported
  transform/opacity
  keyframes. Creation operations report their
  real ids so an Agent can continue editing them in later calls.
- Users can save custom presets — text styles, clip effect stacks,
  transition parameter sets, and inline-SVG graphics presets — in the GUI
  preset panels, and Agents manage
  and apply the same user-level presets with the `preset.*` tools in a
  live session.
- A shipped GUI manual travels with the app as version-bound bilingual
  (`zh`/`en`) data: Agents answer "how do I reach/rename/mute/export …"
  questions from 18 curated screen guides through the read-only
  `help.list_screens`/`help.describe`/`help.search` tools — no project and
  no source reading required. Six screens ship a real screenshot; the rest
  honestly report their screenshot as pending.
- From the audio panel or the action rail, users can dispatch voiceover and
  music generation tasks to the connected external Agent session: ReelTerminal
  casts the request (text, requirements, optional adjustments, insert intent)
  into the session as one prompt, tracks a seven-state task list with retry
  and local cancel, then imports the artifact for audition and timeline
  insertion. Generation happens entirely in the external Agent — ReelTerminal
  holds no provider keys, never calls a generation service, and honestly
  fails a task that no connected Agent can fulfill.
- Users can mark audio, video, text, media, and graphics entities as stable
  Agent references (`@A1`, `@A2`, `@A3`, …). Multi-selection assignment is
  deterministic; repeated marks keep their number; deleted entities remain
  stale and never silently rebind. References are visible in the editor and
  available as a machine-readable mapping from `editor.get_context`.
- The retained product UI is wired for English and Simplified Chinese
  (`zh-CN`). English remains the fallback for newly introduced or missing copy;
  the new inspection panel currently uses English labels.
- Agents own their installation, authentication, conversations and context.
  The desktop shows Agent Access and current activity. The former conversation
  panel, onboarding, prompt forwarding and collaboration modes are removed.
  Voiceover/music prompt submission is disabled pending independent tasks;
  existing task records and artifacts remain available.
- The legacy 304-tool desktop endpoint and the embedded BYOK agent/chat path
  are removed from the ReelTerminal product contract. The extraction audit and
  inherited source remain historical reference material only.

### Foundation already available

- The pure-Node facade provides canonical project operations with typed
  results, strict schemas, atomic batches, optimistic revisions, serialized
  execution, and idempotency.
- The Chromium runtime provides preview, H.264/AAC export, and artifact
  verification through independent provider interfaces and honest preflight
  capability reporting.
- Project persistence, the live-store seam, desktop IPC, the Command API
  endpoint, and the shared CLI/MCP command client
  provide the foundation for external-agent collaboration.

### Remaining integration work

- Wider editing verbs and richer external-agent interoperability will be
  added only when they improve the finishing workflow and preserve the
  product boundary. Generators integrate outside ReelTerminal through the Agent.

See [`docs/design-principles.md`](docs/design-principles.md) for the enduring
rules and [`docs/product-scope.md`](docs/product-scope.md) for the product
boundary and retention rule.
[`docs/README.md`](docs/README.md) — docs index and house rules.

## Architecture

```text
human GUI ───────────────┐
                         ├─ canonical Project/actions ─ preview/export
Agent → reelctl → Command API ─┘
```

```text
packages/core              canonical Project model + editing engines
packages/ui                shared React UI component library (Radix + Tailwind)
packages/agent-facade      typed command catalog + facade, headless and live sessions
packages/runtime-chromium  Chromium render/export providers + verification
packages/agent-transport   optional headless MCP/CLI transport foundation
packages/creation-schema   creation scene schema, primitives, and validation
packages/creation-agent    creation-scene tools registered for agent tool protocols
packages/creation-bindings native/WASM creation backend with core CPU fallback
packages/creation-core     C++20 native creation engine (C ABI; needs cmake/emscripten, outside root -r scripts)
packages/fxpkg             .fxpkg artifact contract, node graph validation, filter/template compiler
packages/image-core        imperative image-editing core (adjustments, commands, masks, history)
apps/web                   ReelTerminal editor GUI and renderer-side live bridge
apps/desktop               desktop shell, Command API, reelctl and MCP adapter
apps/studio                experimental VFX/filter creation workbench (local creation usable; publishing targets an out-of-repo worker)
apps/image                 standalone image editor (experimental/dormant)
docs/adr/                  point-in-time architecture decisions
docs/design-principles.md  enduring product and engineering principles
docs/product-scope.md      product boundary and feature-retention rule
audit/                     frozen historical extraction audit and evidence
```

The facade never owns a model or a conversation. It reads and mutates the
canonical project through the appropriate store seam, and it reports the
current live context on demand. The renderer-side bridge carries actions and
detached context; it does not synchronize a second Agent project model.

### Agent references

References are ephemeral editor context, not project content. Each mark stores
the entity kind, stable entity ID, human label, timeline timing when present,
and the project revision at which it was marked. Numbers are session-local and
monotonic: they are never renumbered or reused, including after deletion.

`editor.get_context` exposes them as a number-keyed mapping:

```json
{
  "references": {
    "1": {
      "number": 1,
      "ref": "A1",
      "kind": "video",
      "entityId": "clip-abc",
      "label": "Opening shot",
      "timing": { "startSeconds": 0, "endSeconds": 4.5 },
      "revisionAtMark": 12,
      "stale": false
    }
  }
}
```

## What the facade covers

The generated command contract is shared by headless and live facade sessions. In a
headless session, project lifecycle and local media operations are available
subject to configured roots. In a live session, the GUI owns the open project;
the facade can import media and edit that shared project while reporting live
capabilities honestly.

The live surface also reports the current selection, playhead, selected time
range, canvas target, context revision, and stable Agent references. Write
operations use the same revision and writer-lease boundaries as the rest of
the editor. A live facade action is one undoable history group in the GUI.

Package API details and limits live in
[`packages/agent-facade/README.md`](packages/agent-facade/README.md). Runtime
details live in
[`packages/runtime-chromium/README.md`](packages/runtime-chromium/README.md).

## Quick start

Prerequisites:

- Node 22 (the CI runtime; the package engine floor is 18)
- pnpm 11.7 via Corepack (`packageManager` is pinned)
- ffmpeg and ffprobe on `PATH` for artifact verification
- Chromium installed through Playwright for render/export tests

```bash
git clone https://github.com/yuchen-ya/reelterminal.git
cd reelterminal

corepack pnpm install
pnpm --filter @reelterminal/runtime-chromium exec playwright-core install chromium

# Headless facade tests
pnpm --filter @reelterminal/agent-facade test:run

# Chromium runtime tests
pnpm --filter @reelterminal/runtime-chromium test:run

# Open the editor GUI
pnpm dev
```

The runtime example covers create → import → edit → preview → export → verify:
[`packages/runtime-chromium/examples/hello-world-e2e.mts`](packages/runtime-chromium/examples/hello-world-e2e.mts).

### 普通用户最短出片路径

1. 在“媒体”面板点击“导入媒体”，选择视频、图片或音频。
2. 把素材拖到时间线；选中片段后，可在时间线工具栏/右键菜单完成分割、复制、波纹删除，在检查器调整画面、速度和声音。
3. 在相邻片段的切点添加转场，用预览窗口和播放控制检查成片。
4. 点击右上角“导出”，选择分辨率与质量并生成视频。

这些操作与外部 Agent 使用的是同一个项目、动作历史和渲染/导出链路；用户可随时撤销 Agent 的一整批改动，也可以继续手工调整。

## Desktop live workflow

Open the editor and project, enable **Agent Access**, then run:

```powershell
reelctl status
reelctl context --compact
reelctl schema edit.apply
reelctl edit validate --file validation.json
reelctl edit apply --file changes.json
```

Use the context's project identity, project epoch and revision when preparing
edits. CLI processes share the desktop's canonical state, undo history, jobs and
idempotency records. See [the Agent guide](docs/AGENT-GUIDE.md),
[workspace layout](docs/AGENT-WORKSPACE.md), and
[architecture decision](docs/adr/0010-cli-command-api.md).

MCP clients explicitly launch `reelctl mcp serve`; old live MCP launcher names
remain compatibility aliases. Headless `reelterminal-agent` commands remain
available for explicitly selected standalone workflows.

## Repository map and historical boundaries

| Path | Role | Current status |
|---|---|---|
| `packages/core` | Canonical project and editing engines | Active foundation |
| `packages/ui` | Shared React UI component library | Active foundation |
| `packages/agent-facade` | Headless/live command catalog | Active |
| `packages/runtime-chromium` | Render, export, and verification providers | Active foundation |
| `packages/agent-transport` | Headless MCP/CLI transport foundation | Optional |
| `packages/creation-schema` | Creation scene schema and validation | Active foundation |
| `packages/creation-agent` | Creation-scene tools for agent tool protocols | Foundation; no in-repo consumer yet |
| `packages/creation-bindings` | Native/WASM creation backend with core CPU fallback | Active foundation |
| `packages/creation-core` | C++20 native creation engine (C ABI) | Requires cmake/emscripten; outside root `-r` scripts |
| `packages/fxpkg` | `.fxpkg` contract, node graph validation, filter/template compiler | Active foundation |
| `packages/image-core` | Imperative image-editing core (commands, masks, history) | Stable; consumed only by `apps/image` |
| `apps/web` | ReelTerminal editor and live renderer bridge | Active |
| `apps/desktop` | Desktop shell and live endpoint host | Active |
| `apps/studio` | Experimental VFX/filter creation workbench (`pnpm --filter @reelterminal/studio dev`); local creation, compiling, and tutorials work | Experimental; publishing targets an out-of-repo worker |
| `apps/image` | Standalone image editor (`pnpm --filter @reelterminal/image dev`); self-hosted Cloudflare Pages deploy (`openreel-image`), not covered by the root `deploy` | Experimental / dormant; not on the current mainline; low test coverage |
| `audit/` | 304-tool extraction audit and risk evidence | Frozen historical material |
| `docs/adr/` | Architecture decisions | Historical record; do not rewrite |

The legacy desktop 304-tool endpoint, its registry, the embedded
provider/model selection and BYOK inference loop, the LLM-driven runner, and
project-owned chat history have been removed from the active source tree.
Upstream planning documents may mention them; those documents are historical
and do not override the product boundary described here.

## Testing

Focused package tests are the primary evidence for the headless facade and
Chromium runtime. The repository also provides:

```bash
# Windows: requires Node >= 21 (Node 22 recommended) for the repo-wide suite
pnpm test
pnpm typecheck
pnpm lint
```

Desktop live collaboration tests cover Command API authentication and MCP adapter parity,
the generated command catalog, the renderer bridge, session host, lease, status events,
and shared revision behavior.

## License and attribution

MIT — see [`LICENSE`](LICENSE). ReelTerminal is built on the MIT-licensed
[OpenReel](https://github.com/Augani/openreel-video) editor by Augustus Otu
and Contributors; the upstream copyright is retained.
The project also uses [mediabunny](https://mediabunny.dev),
[Playwright](https://playwright.dev), [FFmpeg](https://ffmpeg.org), React, and
TypeScript.
