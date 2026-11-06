# Desktop distribution

## Current candidate: 1.4.0

The source version is 1.4.0. This candidate targets a Windows x64 installer and
portable ZIP, with the built-in Agent work timeline, scoped review criteria,
feedback completion/search, real-folder review/classified export, and local
MobileSAM image/frame regions. See the [current draft notes](../../docs/RELEASE-NOTES-DRAFT.md).
The final local candidate is
`release/windows-1.4.0-20261106-054304-41a11bb9/`. Its selected packaged text/media
combination, exact-response completion replay, model/worker/runtime/license
inspection and ZIP integrity checks passed. The earlier candidate is retained as
failed/superseded after an automatic draft-save/button-disabled race; the new
package fixes that race and passes the unchanged group decision assertion.
This is not a release announcement, installer acceptance or a general model
quality guarantee. See the draft notes and the final output directory's
provenance/checksums for the precise limits.
Available downloads are listed on
[Releases](https://github.com/yuchen-ya/reelterminal/releases). The
[1.3.11 build scope](../../docs/RELEASE-1.3.11.md) remains a historical record.
Confirm the source, signing status, checksums and packaged validation for the actual
release artifacts before publication. See the [upgrade guide](../../docs/WINDOWS-UPGRADE.md)
before replacing an existing installation. Legacy unsafe uninstallers are blocked;
a successful one-off attended migration is not general automatic-upgrade support.

A local candidate includes the current working-tree contents, including dirty
and untracked source files; it is not built from HEAD alone. Freeze source writes
for the build and use a new output directory without overwriting earlier packages.
Do not commit or discard other people's edits merely to make Git clean, and do
not rename an older package to a new version. For example:

```bash
pnpm install --frozen-lockfile
pnpm build:wasm
node apps/desktop/scripts/prepare-segmentation-resources.mjs --check
pnpm --filter @reelterminal/desktop dist --win nsis zip --x64 --publish never --config.directories.output=release/windows-1.4.0-<date-and-unique-suffix>
```

The build generates `dist/performance-build.json` with the source HEAD, dirty
flag, tracked/untracked source digest and asset identity. Record the actual build
start/completion times, command and output directory alongside it in release
provenance; preparation time is not build time. Verify the packaged app version,
run the relevant isolated packaged smoke tests, and compute SHA-256 checksums.
This workflow uses `--publish never` and does not upload assets. The installer
wizard must be identified as untested unless actually exercised; running the
unpacked application does not verify installation. Explorer/WeChat receiving a
native drag is a separate user acceptance check.

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
Keep a positive `dist/**/*` entry in every platform-specific `files` list:
electron-builder adds a default `**/*` matcher to a negations-only list, which
silently packages `src/`, `e2e/` evidence and tests into `app.asar`. The app
asar should contain only `dist/`, `package.json` and production `node_modules`.
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
npm license/notice texts into `LICENSES/`. For archives without a license file,
the source map includes identified upstream notices or explicitly labelled
standard MIT/ISC reference terms accompanying the exact published package
declaration. The generator verifies that declaration and keeps the reference
distinct from a package-specific copyright statement. It preserves supplied
copyright notices and does not invent missing holders or dates. The inventory
retains the source URLs and review notes; missing materials remain visible. See
[`LICENSES/RELEASE-READINESS.md`](LICENSES/RELEASE-READINESS.md) for the checked
items and signing evidence.

## MobileSAM segmentation resources

The application bundles one pinned, source-derived MobileSAM FP32 ONNX pair;
it does not download models on startup or require Python for segmentation.
Before the first source build, explicitly stage the already validated export
directory (replace the example with the authorized local directory):

```powershell
pnpm --filter @reelterminal/desktop prepare:segmentation --source-dir E:\path\to\validated-mobilesam-export
node apps/desktop/scripts/prepare-segmentation-resources.mjs --check
```

The source directory must contain `mobilesam-encoder-fp32.onnx` (27,969,731
bytes) and `mobilesam-decoder-dynamic-fp32.onnx` (16,496,929 bytes). Preparation
checks both sizes and SHA-256 identities against
`resources/segmentation/mobilesam-manifest.json`, then copies only these models,
the manifest and model license/notices to the ignored generated directory
`apps/desktop/resources/segmentation/mobilesam/`. It performs no network access;
never copy the validation directory, research photos or original checkpoint
into a distributable. The `build:main` preflight verifies these prepared assets
and fails if absent, modified or stale. After changing pinned models/notices,
stage them again; there is no fallback to a developer cache or arbitrary model.

`tsup` emits `dist/main/segmentation/worker.js`. Electron Builder unpacks that
worker and `onnxruntime-node`/`onnxruntime-common` under `app.asar.unpacked/`;
the existing `prune-onnx-runtime.mjs` hook retains only the target native runtime.
Models and their manifest/notices are extra resources at
`process.resourcesPath/segmentation/mobilesam/`. Main creates the per-task
backend factory without loading workers/models; execution checks these exact
locations and the native binding before starting the backend. Development uses
the desktop package's `dist/` worker and staged `resources/` models.

The model source revision is
`f706ad9c4eb7f219c00d9050e46328518ffb65d2`; attribution and conversion details
are in `LICENSES/NOTICE-MobileSAM.txt`. Source preparation and unit tests do
not establish packaged execution. Before release, run segmentation in the actual
packaged application, verify native dependency resolution and resource notices,
and verify image correction/video-frame selection through the task-media UI.
FFmpeg/ffprobe remain separately installed tools with the PATH/environment
configuration above; this model integration does not bundle them.

## Signing and updates

macOS release builds enable hardened runtime and notarization. Configure an
Apple signing identity and notarization credentials through the build
environment. Windows signing requires a trusted Authenticode identity configured
for Electron Builder. Use `pack` for a local unpacked build.

Code signing is separate from open-source licensing. Publishing the source
repository does not require a signing certificate. An explicitly labelled
unsigned Windows alpha is a possible early distribution choice; it will not
display a verified publisher, may trigger SmartScreen, and may be blocked by
Smart App Control or managed-device policies. Publish through the project's
official release page with version/source links and SHA-256 checksums, state
that the build is unsigned, and do not instruct users to disable system-wide
security. Checksum files identify release artifacts but are not signatures.
Signing is recommended for releases intended for ordinary end users and a
smoother installation/update experience; it does not guarantee no SmartScreen
warnings. See [Microsoft's guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation).

macOS has a stronger default Gatekeeper boundary: Developer ID signing and
notarization are the supported path for normal outside-Store installation.
Keep unsigned local Mac builds identified as developer/test artifacts; do not
present them as notarized public releases. See
[Apple Developer ID](https://developer.apple.com/developer-id/).

For eligible OSS projects, [SignPath Foundation](https://signpath.org/terms.html)
offers free Windows signing subject to project review, verifiable builds and
release approval. Acceptance is not guaranteed. Microsoft Artifact Signing
Public Trust has identity/geographic eligibility restrictions; check the
[current prerequisites](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)
before selecting it as an individual developer's signing route. Credentials and
private keys belong in the signing service or protected CI secrets, never Git.

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
