# Desktop third-party notices

The packaged desktop app contains the root `LICENSE.txt` copy, the license
files in this directory, and the font licenses copied with the renderer under
`resources/renderer/fonts/licenses/`.

## Application source

ReelTerminal includes code from the MIT-licensed OpenReel project. Preserve the
copyright and license notice included as `LICENSE.txt`.

## Runtime assets

- FFmpeg binaries may be included under `resources/bin/`. Their versions,
  sources, licenses, and source-distribution requirements are in
  [`FFMPEG.md`](FFMPEG.md).
- Blender binaries may be included under `resources/rigging/`. See
  [`BLENDER.md`](BLENDER.md) before distributing a package containing Blender.
- `resources/aurora/` holds prebuilt native sidecars built from the
  in-repository `packages/creation-core` sources (see
  [`../DISTRIBUTION.md`](../DISTRIBUTION.md)); they are not third-party code.
- The renderer includes local font assets and their family-specific license
  texts under `resources/renderer/fonts/licenses/`.

## JavaScript packages

The desktop runtime includes the following packages:

| Package | Version | License text |
|---|---:|---|
| `@paper-design/shaders` | 0.0.72 | `PAPER-DESIGN-SHADERS-0.0.72-MIT.txt` |
| `mediabunny` | 1.55.4 | `MEDIABUNNY-1.55.4-MPL-2.0.txt` |

The installed renderer and application dependencies are identified by their
upstream package manifests. This notice covers the files and sidecars bundled
by the desktop packaging configuration; it is not a generated inventory of all
transitive package licenses.
