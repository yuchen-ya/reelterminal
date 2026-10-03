# Third-party notices

The repository contains independently licensed dependencies and assets. This
index identifies the checked-in items and optional desktop sidecars that need
separate review. Workspace package manifests and `pnpm-lock.yaml` identify the
JavaScript dependency set; this file is not a generated dependency inventory.

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
| `posthog-js` | 1.335.2 | Apache-2.0 | [`POSTHOG-JS-1.335.2-APACHE-2.0.txt`](apps/desktop/LICENSES/POSTHOG-JS-1.335.2-APACHE-2.0.txt) |

## Fonts

The font assets in `apps/web/public/fonts/` include 56 Google Fonts families
and two Helvetiker typeface files. Their family-to-file mapping, upstream
copyright notices, and full license texts are in
[`apps/web/public/fonts/licenses/manifest.json`](apps/web/public/fonts/licenses/manifest.json)
and its adjacent license files. Helvetiker carries the Magenta/MgOpen license
embedded in its typeface metadata.

## Optional desktop sidecars

Desktop packages can include FFmpeg and Blender binaries. Their notices and
license texts are in [`apps/desktop/LICENSES/`](apps/desktop/LICENSES/).
Binary release requirements are described in
[`apps/desktop/DISTRIBUTION.md`](apps/desktop/DISTRIBUTION.md).
Electron Builder includes a copy of the project MIT license and desktop notices
from that directory. Font license files are copied with the renderer assets.
