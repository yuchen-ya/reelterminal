# Third-party notices

The repository contains independently licensed dependencies and assets. This
index identifies the checked-in items and optional desktop sidecars that need
separate review. Workspace package manifests and `pnpm-lock.yaml` identify the
JavaScript dependency set; this file is not a generated dependency inventory.
Desktop builds generate `dependency-inventory.json` and `DEPENDENCY_LICENSES.txt`
under `apps/desktop/resources/licenses/` and package them in `LICENSES/`.
They include the production dependency closure of the desktop and renderer,
preserving the license and notice files present in installed npm archives.
Packages whose archives omit separate license texts are explicitly identified;
review their upstream terms before publishing a binary release.

## Source attribution

ReelTerminal includes code from the MIT-licensed OpenReel project. Preserve the
upstream copyright and license notice in [`LICENSE`](LICENSE).

## Image app

`apps/image` uses `@imgly/background-removal` 1.7.0, licensed under AGPL-3.0.
Its license text is included in the app's public assets at
[`apps/image/public/licenses/AGPL-3.0.txt`](apps/image/public/licenses/AGPL-3.0.txt).
The dependency is scoped to `apps/image`; this notice does not assign one
license to every workspace package or determine the terms of a combined app
distribution.

## JavaScript packages

The desktop renderer and runtime include the following packages. The desktop
package carries these license texts in
[`apps/desktop/LICENSES/`](apps/desktop/LICENSES/).

| Package | Version | License | License text |
|---|---:|---|---|
| `@paper-design/shaders` | 0.0.72 | MIT | [`PAPER-DESIGN-SHADERS-0.0.72-MIT.txt`](apps/desktop/LICENSES/PAPER-DESIGN-SHADERS-0.0.72-MIT.txt) |
| `mediabunny` | 1.55.4 | MPL-2.0 | [`MEDIABUNNY-1.55.4-MPL-2.0.txt`](apps/desktop/LICENSES/MEDIABUNNY-1.55.4-MPL-2.0.txt) |

## Fonts

The font assets in `apps/web/public/fonts/` include 56 Google Fonts families
and two Helvetiker typeface files. Their family-to-file mapping, upstream
copyright notices, and full license texts are in
[`apps/web/public/fonts/licenses/manifest.json`](apps/web/public/fonts/licenses/manifest.json)
and its adjacent license files. Helvetiker carries the Magenta/MgOpen license
embedded in its typeface metadata.

## Optional desktop sidecars

Default desktop packages exclude FFmpeg and Blender binaries. Users install
these tools separately; development-only downloads remain available. Their notices and
license texts are in [`apps/desktop/LICENSES/`](apps/desktop/LICENSES/).
Binary release requirements are described in
[`apps/desktop/DISTRIBUTION.md`](apps/desktop/DISTRIBUTION.md).
Electron Builder includes a copy of the project MIT license and desktop notices
from that directory. Font license files are copied with the renderer assets.

## Aurora native sidecars

`apps/desktop/resources/aurora/` contains prebuilt macOS native sidecars
(`creation_aurora_renderer`, `libcreation_core.dylib`). They are build outputs
of the in-repository MIT-licensed `packages/creation-core` C++ sources, staged
by `apps/desktop/scripts/prepare-aurora-native.mjs`; they are not third-party
code. Rebuild them with
`pnpm --filter @reelterminal/creation-core build:native` plus the prepare
script, and see
[`apps/desktop/DISTRIBUTION.md`](apps/desktop/DISTRIBUTION.md) for packaging
notes. When absent, the desktop uses the CPU reference implementation from
`@reelterminal/core/creation`.
