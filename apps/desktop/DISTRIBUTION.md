# Desktop distribution

## Build

From the repository root:

```bash
pnpm --filter @reelterminal/desktop build
pnpm --filter @reelterminal/desktop pack
pnpm --filter @reelterminal/desktop dist
```

`pack` creates an unpacked local build. `dist` creates installers for macOS
(arm64 and x64), Windows (x64), and Linux (x64). Both packaging commands fetch
the pinned FFmpeg binary for the build platform. To fetch every platform
binary, run `node apps/desktop/scripts/fetch-ffmpeg.mjs --all`.

Electron Builder includes `apps/web/dist`, desktop resources, the application
license notices, and the generated Help pages. Blender is an optional sidecar;
files under `apps/desktop/resources/rigging/` are included in desktop packages.

## Signing and updates

macOS release builds enable hardened runtime and notarization. Configure an
Apple signing identity and notarization credentials through the build
environment. Windows release signing requires an Authenticode certificate
configured for Electron Builder. Use `pack` for a local unpacked build.

The update feed is configured for GitHub Releases. The repository currently
has no automated desktop release publisher; release assets must be published
separately.

## Third-party binaries

Desktop packages fetch GPL-configured FFmpeg sidecars. Before distributing a
package that contains them, provide the complete corresponding source for each
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
