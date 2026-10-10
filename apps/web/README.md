# @reelterminal/web

The React editor that serves two build modes from one codebase:

- **Browser editor (lightweight web version)** — `pnpm dev` from the repository
  root runs the Vite dev server; `pnpm build` produces the standalone web app.
- **Desktop renderer** — `apps/desktop` builds this package with
  `REELTERMINAL_DESKTOP=1` (`build:renderer`) and packages `dist/` into the
  Electron app. Changes to the renderer reach the desktop only after that
  rebuild.

The UI is built on the Astryx design system (`@astryxdesign/core`); see the
repository-root [`ASTRYX.md`](../../ASTRYX.md) for the component workflow.
Bundle boundaries are described in [`docs/build-chunking.md`](../../docs/build-chunking.md).
