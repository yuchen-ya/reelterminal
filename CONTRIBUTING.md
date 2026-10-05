# Contributing to ReelTerminal

ReelTerminal is a video-finishing editor with a desktop GUI and a shared API
for external Agents. Start with the [README](README.md) and the
[documentation index](docs/README.md).

## Attribution and licensing

The repository includes code from the MIT-licensed OpenReel project. Preserve
its copyright and license notice in [`LICENSE`](LICENSE). The repository also
contains separately licensed dependencies and assets; see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and the notices beside each
package or asset.

The `apps/image` app depends on `@imgly/background-removal`, which is licensed
under AGPL-3.0. Its license text is included in that app's public assets.

## Set up

Use Node.js 22.13.0 or newer, Corepack, and the repository-pinned pnpm 11.7.0:

```bash
git clone https://github.com/yuchen-ya/reelterminal.git
cd reelterminal
corepack pnpm install
pnpm build:wasm
pnpm --filter @reelterminal/runtime-chromium exec playwright-core install chromium
```

FFmpeg and ffprobe are required by runtime verification tests. Start the browser
editor with `pnpm dev`.
The desktop build/start workflow is described in the root README. OpenCV tools
optionally need a local Python with `cv2` and `numpy`; Blender is a separate
optional rigging dependency. Missing optional tools are reported as unavailable.

## Checks

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

For focused work, run the affected package checks. Desktop live collaboration
tests are in `apps/desktop`; the GitHub workflows show the CI checks and
platforms.
The root `pnpm test` runs the packages' default Vitest suites. Desktop GUI/CLI/MCP
acceptance uses a separate config: build the desktop, then run
`pnpm --filter @reelterminal/desktop test:e2e`. Native C++ tests and the Python
filter-tool checks are separate as well; see `.github/workflows/ci.yml`.

## Changes and pull requests

- Keep changes focused on the reported behavior.
- Add or update tests for observable behavior changes.
- Update current user or API documentation when a public contract changes.
- Keep comments short and explain behavior that is not clear from the code.
- Describe the change and list the checks you ran in the pull request.

Open security reports privately using [`SECURITY.md`](SECURITY.md). Use GitHub
issues for ordinary bugs and feature requests.
