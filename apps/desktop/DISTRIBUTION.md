# Desktop distribution

## Build

From the repository root:

```bash
pnpm build:wasm
pnpm --filter @reelterminal/desktop build
pnpm --filter @reelterminal/desktop pack
pnpm --filter @reelterminal/desktop dist
```

`pack` creates an unpacked local build. `dist` builds the configured targets for
the current host platform: macOS (arm64 and x64), Windows (x64), or Linux (x64).
It does not build and sign all three operating systems in one invocation; use
appropriate build hosts and signing credentials for each release target.
`build:wasm` generates the core WASM assets omitted from Git. These commands do not download
or include FFmpeg or Blender binaries, even when a developer has fetched them
locally. Install FFmpeg/ffprobe separately and put them on PATH. For desktop
media processing, `REELTERMINAL_FFMPEG_PATH` can select an explicit executable;
Agent runtime verification also supports `REELTERMINAL_FFPROBE_PATH`.
Configure an installed Blender with `REELTERMINAL_BLENDER_PATH` for rigging.

Electron Builder includes `apps/web/dist`, desktop resources, the application
license notices, and the generated Help pages. The `resources/rigging/blender/`
directory is excluded from packages; rigging helper scripts remain included.
The build also generates a production dependency inventory and copies available
npm license/notice texts into `LICENSES/`. For npm archives without a license
file, the checked-in upstream source map supplies the complete text only when
the package release or its recorded source revision can be matched. The
inventory retains the upstream URL for each copied text. Entries without an
archive or verified upstream text remain marked in the generated inventory;
resolve those entries before publishing final installers. See
[`LICENSES/RELEASE-READINESS.md`](LICENSES/RELEASE-READINESS.md) for the checked
items and signing evidence.

## Signing and updates

macOS release builds enable hardened runtime and notarization. Configure an
Apple signing identity and notarization credentials through the build
environment. Windows release signing requires an Authenticode certificate
configured for Electron Builder. Use `pack` for a local unpacked build.

The update feed is configured for GitHub Releases. The repository currently
has no automated desktop release publisher; release assets must be published
separately.

## Third-party binaries

The development-only `fetch:ffmpeg` command downloads pinned GPL-configured
FFmpeg sidecars. Development builds can use them; distributed builds use the
user-provided executable. If packaging is changed to distribute a
package that contains these binaries, provide the complete corresponding source for each
binary, including its build configuration and applicable patches, using a
source-access method allowed by the relevant GPL version. The repository pins
binary sources and hashes, but does not include the corresponding source
archives, complete build configurations, or applicable patches. Do not
distribute these binaries until the required source materials accompany the
release. See [`LICENSES/FFMPEG.md`](LICENSES/FFMPEG.md).

If a package includes Blender, include the Blender license and corresponding
source materials for the bundled version. See
[`LICENSES/BLENDER.md`](LICENSES/BLENDER.md). The repository does not provide a
Blender download or source-offer service.

## Aurora native sidecars

`resources/aurora/` may contain prebuilt native sidecars
(`creation_aurora_renderer`, `libcreation_core.dylib`) checked in from a macOS
build of the in-repository [`packages/creation-core`](../../packages/creation-core)
C++ sources. They are convenience artifacts, not third-party code: rebuild them
locally with `pnpm --filter @reelterminal/creation-core build:native` followed by
`node apps/desktop/scripts/prepare-aurora-native.mjs`, or delete them — when the
sidecars are absent, the desktop falls back to the CPU reference implementation
in `@reelterminal/core/creation`. The checked-in binaries were not produced by a
reproducible build pipeline; verify or rebuild them before trusting them in a
release.
