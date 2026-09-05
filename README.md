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

The product and repository are named **ReelTerminal**. Inherited technical
identifiers—including `@openreel/*` packages, `.openreel` project/state paths,
the `window.openreel` preload bridge, and `openreel-*` protocol/CLI names—stay
unchanged for compatibility. They are implementation contracts, not the
user-facing brand.

## Current status

Slice 3 is the current product foundation. The status below intentionally
separates what is implemented, what is a reusable foundation, and what remains
for concrete external integrations.

### Implemented in this checkout

- The browser/desktop editor and the canonical ReelTerminal `Project` model share
  one editing world.
- A token-authenticated loopback MCP endpoint exposes exactly **17 live-facade
  tools**:

  `session.describe` · `capabilities.get` · `project.create` · `project.open` ·
  `project.save` · `project.get_state` · `media.import` · `timeline.get` ·
  `editor.get_context` · `editor.control` · `edit.apply` ·
  `preview.render_frame` · `visual.inspect` · `export.start` · `job.status` ·
  `job.cancel` · `verify.artifact`.

  The facade verbs above use dotted names; on the MCP wire each dot becomes an
  underscore (`session.describe` → `session_describe`, `editor.control` →
  `editor_control`). `session_describe` reports the same 17 verbs.

  In live mode, project creation/open remain GUI-owned. An Agent can import
  local video and audio from the roots reported by `capabilities.get`; the
  media appears immediately in the open GUI project and uses the shared undo
  history. The other tools operate on that same project through the live bridge.
- Live revision and context checks, one-writer lease semantics, independent
  Guided / Collaborative / Autonomous work modes, shared undo, and action
  activity status are in place.
- `visual_inspect` provides bounded, read-only frame sampling by clip or time
  range, with revision-tagged PNG artifacts and a real contact sheet when the
  configured renderer supports native composition.
- The atomic `edit_apply` vocabulary covers placement, moving, trimming,
  splitting, duplication, ripple deletion, constant speed/reverse, visual
  transforms and crop, volume, fades, ordinary removal, clip transitions,
  and text overlay creation/update/deletion. Creation operations report their
  real ids so an Agent can continue editing them in later calls.
- Users can mark audio, video, text, media, and graphics entities as stable
  Agent references (`#1`, `#2`, `#3`, …). Multi-selection assignment is
  deterministic; repeated marks keep their number; deleted entities remain
  stale and never silently rebind. References are visible in the editor and
  available as a machine-readable mapping from `editor.get_context`.
- The retained product UI is wired for English and Simplified Chinese
  (`zh-CN`). Current static surfaces are translated, while English remains the
  fallback for newly introduced or missing copy.
- The desktop GUI conversation panel and loopback client transport are landed.
  The shipped Codex reference adapter creates or resumes a Codex App Server
  thread, connects that same thread to the 17-tool live MCP facade, and
  projects only safe display events into the panel. Other Agent hosts can use
  the provider-neutral adapter kit and conversation protocol.
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
- Project persistence, the live-store seam, desktop IPC, the external MCP
  endpoint, and the external-session conversation protocol/client projection
  provide the foundation for external-agent collaboration.

### Remaining integration work

- External Agent hosts other than Codex must run and configure their thin
  `/conversation` server-side adapter, own the descriptor writer lifecycle,
  and remove the `0600` descriptor on exit. ReelTerminal has no universal
  provider connector and never embeds a model.
- Wider editing verbs and richer external-agent interoperability will be
  added only when they improve the finishing workflow and preserve the
  product boundary. Generators integrate outside ReelTerminal through the Agent.

See [`docs/design-principles.md`](docs/design-principles.md) for the enduring
rules and [`docs/product-scope.md`](docs/product-scope.md) for the product
boundary and retention rule.

## Architecture

```text
human GUI ───────────────┐
                         ├─ canonical Project/actions ─ preview/export
external Agent via MCP ─┘
```

```text
packages/core              canonical Project model + editing engines
packages/agent-facade      typed 17-verb facade, headless and live sessions
packages/runtime-chromium  Chromium render/export providers + verification
packages/agent-transport   optional headless MCP/CLI transport foundation
apps/web                   ReelTerminal editor GUI and renderer-side live bridge
apps/desktop               desktop shell and external live MCP endpoint
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

The 17-tool contract is shared by headless and live facade sessions. In a
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
git clone git@github.com:yuchen-ya/reelterminal.git
cd reelterminal

corepack pnpm install
pnpm --filter @openreel/runtime-chromium exec playwright-core install chromium

# Headless facade tests
pnpm --filter @openreel/agent-facade test:run

# Chromium runtime tests
pnpm --filter @openreel/runtime-chromium test:run

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

Start the desktop editor, open a project, and open the **Agent** panel. The
connection guide can enable **Agent Session**, check a locally installed and
signed-in Codex, list its real stored conversations, and either resume the
selected conversation or create a Codex-owned one for the Agent workspace.
ReelTerminal starts its packaged adapter and live MCP connector, then shows the
conversation only after the external-session handshake succeeds. No connector
build or terminal command is part of the normal Codex desktop flow.

For another Agent host, choose **Other Agent** in the same guide. That host
still owns and starts its thin conversation adapter; the guide detects the
private descriptor, verifies the session, and explains how to repair a missing
or invalid adapter. Adapter authors and headless integrations can configure the
built `apps/desktop/dist/live-mcp/index.js` MCP server manually. By default it
reads `~/.openreel/live-endpoint.json` inside the connector process to discover
the current loopback endpoint.

The external Agent and the user remain equal peers over the same GUI project.
The Agent can import local video/audio, inspect context, use stable references,
edit, preview, export, and verify through the live facade; the user keeps direct
GUI control and the shared undo path. `capabilities_get` reports the absolute
media roots allowed by the desktop host. Its `mediaImport.recommendedRoot`
points to the automatically created `ReelTerminal Agent Workspace` under
Videos. Agents keep each creation under `jobs/<date>-<slug>/`, using the
standard source/generated/work/project/output/evidence layout in
[`docs/AGENT-WORKSPACE.md`](docs/AGENT-WORKSPACE.md). The former
`ReelTerminal Agent Imports` folder remains readable for backward compatibility
but is not the destination for new work. Set
`OPENREEL_LIVE_MEDIA_ROOTS` to a platform-delimited list of existing absolute
directories before launch to replace those defaults. Other Agent hosts provide
a thin `/conversation` adapter and publish the private descriptor described in
[`docs/external-agent-conversation-adapter.md`](docs/external-agent-conversation-adapter.md).

For a standalone, headless workflow, use the optional `agent-video serve` or
`agent-video run` transport documented in the root [`SKILL.md`](SKILL.md).
Those commands are not the default ReelTerminal desktop entry point.

## Repository map and historical boundaries

| Path | Role | Current status |
|---|---|---|
| `packages/core` | Canonical project and editing engines | Active foundation |
| `packages/agent-facade` | Headless/live 17-tool contract | Active |
| `packages/runtime-chromium` | Render, export, and verification providers | Active foundation |
| `packages/agent-transport` | Headless MCP/CLI transport foundation | Optional |
| `apps/web` | ReelTerminal editor and live renderer bridge | Active |
| `apps/desktop` | Desktop shell and live endpoint host | Active |
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
pnpm test
pnpm typecheck
pnpm lint
```

Desktop live collaboration tests cover endpoint authentication and MCP shape,
the 17-tool catalog, the renderer bridge, session host, lease, status events,
and shared revision behavior.

## License and attribution

MIT — see [`LICENSE`](LICENSE). ReelTerminal is built on the MIT-licensed
[OpenReel](https://github.com/Augani/openreel-video) editor by Augustus Otu
and Contributors; the upstream copyright is retained.
The project also uses [mediabunny](https://mediabunny.dev),
[Playwright](https://playwright.dev), [FFmpeg](https://ffmpeg.org), React, and
TypeScript.
