# ReelTerminal

> **ReelTerminal，你的 AI 视频终点站。生成发生在任何地方，成片发生在这里。**
>
> **ReelTerminal — your AI video's final stop. Generate anywhere; finish here.**

ReelTerminal is a video-finishing editor for projects created by people,
external Agents, skills, and other tools. It brings media onto one reviewable
timeline, then previews, verifies, and exports the finished project.

## Product boundary

People edit through the desktop GUI. External Agents use the live Command API,
CLI, or explicitly started MCP adapter. Both interfaces work on the same
project, revision checks, and undo history.

Agents own their installation, credentials, model providers, conversations,
and context. ReelTerminal provides project state and finishing tools; it does
not include a conversational Agent or generate media on an Agent's behalf.

## Applications

| Path | Purpose |
|---|---|
| `apps/desktop` | Electron desktop editor and live Agent service |
| `apps/web` | Browser editor and renderer |
| `packages/core` | Project model and editing engines |
| `packages/agent-facade` | Shared command catalog and headless/live API |
| `packages/runtime-chromium` | Chromium preview, export, and artifact verification |
| `packages/agent-transport` | Standalone MCP and workflow CLI |
| `apps/studio` | Experimental VFX and filter workbench |
| `apps/image` | Experimental image editor; uses the AGPL-3.0 `@imgly/background-removal` dependency |

The root MIT notice and third-party license scope are described in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). The image app dependency has
its own license text at [`apps/image/public/licenses/AGPL-3.0.txt`](apps/image/public/licenses/AGPL-3.0.txt).

## Quick start

Prerequisites: Node.js 22.13.0 or newer, Corepack, and pnpm 11.7.0 (pinned by the repository).
The Chromium runtime tests also need FFmpeg/ffprobe and Playwright Chromium.
Desktop packages use a separately installed FFmpeg/ffprobe on PATH; they do
not include FFmpeg or Blender binaries. Rigging requires a separate Blender
installation configured with `REELTERMINAL_BLENDER_PATH`.

```bash
git clone https://github.com/yuchen-ya/reelterminal.git
cd reelterminal

corepack pnpm install
pnpm --filter @reelterminal/runtime-chromium exec playwright-core install chromium

# Open the browser editor
pnpm dev
```

Run focused checks with:

```bash
pnpm --filter @reelterminal/agent-facade test:run
pnpm --filter @reelterminal/runtime-chromium test:run
```

## Desktop and Agent use

Packaged builds include Help → Quick Start and a bilingual offline guide in the
application's `help/` folder. See the [user guide](docs/USER-GUIDE.md).

With a project open, the desktop command service provides read-only access.
Choose **Allow editing** in the status strip to grant write access. See the
[Agent guide](docs/AGENT-GUIDE.md) and [Command API](docs/COMMAND-API.md).

Use `reelctl schema` and `reelctl help` to discover commands. MCP clients start
`reelctl mcp serve`; standalone headless workflows use `reelterminal-agent`.

## Documentation

The [documentation index](docs/README.md) links current product, Agent,
workspace, and distribution guides. Desktop package instructions are in
[`apps/desktop/DISTRIBUTION.md`](apps/desktop/DISTRIBUTION.md).

## License and attribution

The repository includes the MIT-licensed OpenReel editor by Augustus Otu and
contributors. Its copyright and license notice remain in [`LICENSE`](LICENSE).
The repository also contains independently licensed dependencies, fonts, and
optional desktop sidecars; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Local-first release

ReelTerminal provides local editing, saving, export and local templates without
an operated cloud backend. Hosted cloud templates, sharing, transcription,
highlights and Studio marketplace services are not supplied by this release.
PostHog tracking is removed. Studio previews use user-imported footage.

Local captions download ONNX Community models directly from Hugging Face;
segmentation, fonts and FFmpeg browser cores still use public resource hosts.
Optional Agent cloud review uses the user's own provider key and explicit
upload authorization. See [External network access](docs/EXTERNAL-DEPENDENCIES.md).
