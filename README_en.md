<div align="center">

**English** | [简体中文](README.md) · [Review Workspace](README_review_en.md)

<img src="docs/assets/logo.png" alt="ReelTerminal" width="100" height="100" />

# ReelTerminal

A collaborative video editor for people and AI assistants. Generate anywhere; finish here.

[Download](https://github.com/yuchen-ya/reelterminal/releases) · [User guide](docs/USER-GUIDE.md) · [Report an issue](https://github.com/yuchen-ya/reelterminal/issues)

</div>

ReelTerminal connects a timeline, canvas and external AI assistant to the same project. You make creative decisions, preview and refine; your assistant handles batch or structured edits. Both share project state, editing history and version comparison.

![ReelTerminal desktop: media library, preview, timeline and version history](docs/assets/desktop-screenshot.png)

## What you can do

| Workflow | Capabilities |
| --- | --- |
| Edit and deliver video | Arrange media, adjust clips and audio, preview and export. Constant-speed retiming preserves pitch by default; inspect individual frames and compare saved versions. |
| Collaborate with an external assistant | Give the app's startup prompt to an assistant with local command execution. The CLI discovers tools on demand and uses explicit targets, revision checks and undoable edits. |
| Multimodal review (experimental) | Curate image, text, table, video and GLB batches, record issues, repair content, and hand decisions or rework back to your assistant. |
| Private free boards (experimental) | Organize images, text, video, GLB, Markdown, HTML and web pages in reorderable tabs. Capture rectangles, polygons or freehand selections with optional transparency. Board content stays outside Agent context. |
| Captions and audio cleanup | Generate local captions with Qwen or SenseVoice. Analyze loudness, speech activity, silence and beats, then explicitly apply the desired timeline edits. |

Projects, media caches, editing and rendering run locally. See [external dependencies](docs/EXTERNAL-DEPENDENCIES.md) for model downloads, external pages and optional network services. You choose and configure the AI assistant separately.

## Get started

1. Download the Windows x64 installer or portable ZIP from [Releases](https://github.com/yuchen-ya/reelterminal/releases). Extract the entire ZIP before running `ReelTerminal.exe`. Available packages for other platforms are listed on the release page.
2. Create or open a video project. For standalone asset curation, enter Review Workspace without creating a video project.
3. To collaborate with an assistant, copy the app's startup prompt into an assistant with local command execution. Connections start read-only; enable editing for the intended target when needed.
4. Preview and refine in the app, retain the versions you need, and export the result.

Dragging an object on a free board moves it within the layout. To drag out a system file, select the content, choose 「单个文件：拖出 / 保存」, then drag the output panel's 「拖出文件」 button to the destination.

### Installation and compatibility

- Windows builds are unsigned. Download from the official release page and verify `SHA256SUMS.txt`; Windows may display a publisher or SmartScreen warning.
- Before upgrading, read the [Windows upgrade and backup guide](docs/WINDOWS-UPGRADE.md). Keep existing projects and data; a portable ZIP may still read the existing data directory.
- Features requiring FFmpeg/ffprobe use separately installed tools. Caption models and optional Python/OpenCV environments need configuration; the app does not silently run `pip` in the background.
- Project templates contain structural snapshots rather than all source media. Retain a version node before major experiments. See the [user guide](docs/USER-GUIDE.md) for feature limits.

## Run from source

Use Node.js 22.13.0 or newer and the repository's pinned pnpm 11.7.0.

```bash
git clone https://github.com/yuchen-ya/reelterminal.git
cd reelterminal
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm build:wasm
corepack pnpm --filter @reelterminal/desktop build
corepack pnpm --filter @reelterminal/desktop start
```

For browser development, use `corepack pnpm dev`. Desktop collaboration and native file operations require the desktop app. See [CONTRIBUTING.md](CONTRIBUTING.md) and [desktop distribution](apps/desktop/DISTRIBUTION.md) for builds and packaging.

## Documentation and feedback

- [Desktop user guide](docs/USER-GUIDE.md): interface, workflows and limits. Help in the app includes English and Chinese offline manuals.
- [Review Workspace and private free boards](README_review_en.md): batch curation, repair, rework handoff and file output.
- [Agent guide](docs/AGENT-GUIDE.md) and [Command API](docs/COMMAND-API.md): connections, permissions and selective tool discovery.
- [Agent workspace guide](docs/AGENT-WORKSPACE.md): media-production file conventions. Repository development follows [AGENTS.md](AGENTS.md), with isolated test profiles.
- [External dependencies](docs/EXTERNAL-DEPENDENCIES.md) and [color management](docs/COLOR.md): environment setup and media-processing conventions.

Send bugs and suggestions to [GitHub Issues](https://github.com/yuchen-ya/reelterminal/issues). Report security vulnerabilities privately through [SECURITY.md](SECURITY.md). Packages, checksums and version changes are collected in [Releases](https://github.com/yuchen-ya/reelterminal/releases).

## License and attribution

- The project's core code is available under the [MIT License](LICENSE).
- ReelTerminal builds on the MIT-licensed [OpenReel](https://github.com/Augustus-Otu/openreel) project by Augustus Otu and contributors. Original copyright notices are preserved.
- Separately licensed components, fonts and model resources are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
