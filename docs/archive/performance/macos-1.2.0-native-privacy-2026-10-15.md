# macOS 1.2.0 native privacy correction — 2026-10-15

**Status: native correction verified; awaiting the main session's unified final
source freeze. No Mac package is approved for delivery.** The earlier clean
`29524f053c0789227e31cd58f925985d6742baab` build remains a local candidate only.
No tag, Release, attachment upload, history rewrite or force-push was performed.

## Exact correction

Only `apps/desktop/resources/aurora/creation_aurora_renderer` and this note are
included in the correction commit. No CMake, application implementation,
dependency, Electron version, security setting or public API changed.

The renderer had two `LC_RPATH` entries: `@executable_path` and a private absolute
build directory. Its non-system dependency is
`@rpath/libcreation_core.dylib`, shipped beside the executable. A temporary copy
with only the private entry removed loaded that colocated library and passed
the existing native self-test, proving the absolute entry unnecessary.

`install_name_tool -delete_rpath` removed that one entry; no binary string
replacement or blanket RPATH deletion was used. Local
`codesign --force --sign -` restored a valid ad-hoc signature after modifying
the Mach-O. No identity, credential, Developer ID or notarization was used.

| Identity | Before | After |
| --- | --- | --- |
| SHA256 | `e0028083c6c4b579ed07bee3288bbeecfa6c908f1916e611b11e52566e1187d6` | `6df7a37a1139924b792917295776c3f8f6790c5fb1aa6b1391a65e3644f4d096` |
| Bytes | 172408 | 171568 |
| Architecture | arm64 | arm64 |
| RPATH | `@executable_path` plus one private entry | `@executable_path` |
| Signature | linker ad-hoc; strict verification exit 0 | local ad-hoc; strict verification exit 0 |

Dynamic dependencies remain exactly `@rpath/libcreation_core.dylib`,
`/usr/lib/libc++.1.dylib` and `/usr/lib/libSystem.B.dylib`. The executable
`__TEXT,__text` SHA256 remains
`5dacbcddedbda17f1caed8ad73f141e3b944454762e16ab59af2b8fef68f1493`.
The unchanged dylib retains its `@loader_path` RPATH and
`@rpath/libcreation_core.dylib` install name.

## Verification and build boundary

- Existing CTest native tests: **2/2 passed** (core and renderer self-test).
- A fresh temporary directory containing only the corrected renderer and its
  dylib passed `--self-test` with all inherited `DYLD_*` overrides removed.
  Local dyld diagnostics confirmed the colocated library actually loaded.
  The self-test checks a 48×48 triangle render, pixels and both file/serve protocols.
- Existing desktop native preview and committed golden tests: **2/2 passed**,
  explicitly selecting the corrected renderer. The native backend assertion
  prevents a CPU fallback from concealing a loading failure.
- The corrected executable contains no `/Users/` or `/home/` path. Architecture,
  dependency and signature checks used Mach-O tools plus structured load-command
  inspection. Original path values and raw dyld logs are not published here.
- The ignored local native build copy was synchronized, so
  `prepare-aurora-native.mjs` will not restore the old binary during the next
  desktop build. The shared build scripts were deliberately left unchanged;
  a future native recompilation must repeat the RPATH privacy check.

Remote `71ff40a2b46c1609faf6c4323ff3989608470abe` separately adds distribution
filters for local evidence, tests and sensitive files, and platform-specific
native resources. It is retained as the parent line of this correction.
The main session must confirm a new complete source SHA before final Mac
DMG/ZIP production. Recheck final archive contents, actual packaged native
loading, source stamp, signatures and checksums after that build.

## Remote history and privacy scope

**The same private path already exists in remote Git history**, including
`c8e1591ff5ec30f8b7dd147f205c79b69c0dcade` and the old 1.2.0 candidate source.
An earlier binary at `7ef1b6c1225f945aa5ddaebf42c92ce2820cd2ca` also contains
a personal absolute path, with a different value. This commit cleans new
versions only; it does not remove old blobs, clones, caches or distributed
copies. Historical release attachments were not independently audited in this
step. No history cleanup is authorized or attempted.

The old candidate also includes two raw local runtime diagnostic reports in
`app.asar/node_modules/@reelterminal/runtime-chromium/.artifacts/`. They contain
no detected secret/endpoint fields or personal paths, but remain disallowed
debug artifacts. The upstream packaging filters address this; the final package
must prove their absence. Public upstream dependency paths and fictional source
test paths were distinguished from actual private build data and not deleted.
The candidate scan found no credential file, private-key block or recognized
GitHub/OpenAI token pattern; this is a bounded scan, not a universal guarantee.

## Earlier candidate acceptance, not final-package acceptance

The independent arm64 1.2.0 candidate was built clean from `29524f05` using the
normal frozen-lockfile, WASM and desktop distribution scripts. Its real `.app`
passed **30/30 tests across 12 files in 152.07 seconds**, retry 0: startup/open,
real CLI/MCP collaboration, edit, undo/redo, save/reopen, archive nodes, review
workspace, small-window playback, durable checkpoints/process recovery and
export/full FFmpeg decode. Connector/CLI processes used the build output,
verified byte-identical to their packaged counterparts. No action budget or
business assertion was weakened. This evidence does not qualify a later package.

Local candidate directory:
`apps/desktop/release/macos-1.2.0-29524f05-2026-10-15/`.
Both archives match the tested app's content, symlinks and permissions;
ZIP CRCs passed and the DMG was mounted read-only and detached.

| Local candidate; do not upload | Bytes | SHA256 |
| --- | ---: | --- |
| `ReelTerminal-1.2.0-arm64.dmg` | 164600039 | `1aec97d4256cb2e1bf07967698c5c7341ab24e14857232ab84e8376f820ac88b` |
| `ReelTerminal-1.2.0-arm64.zip` | 164795757 | `b0d1d8e276da16bd172ec812dd542be2c6e70df64e221cedb5cc77537c909f2e` |

Its app.asar SHA256 is
`c24f4b2d780044be44f5c6c79070febc104d40344c24b93425d7f837364620a4`.
Package identity, all main components, 190 renderer assets, four workers,
dependencies and all 16 arm64 Mach-O files were checked. There is no Developer
ID signature or notarization; the app retains an Electron linker ad-hoc
signature and fails whole-app strict signature verification. This remains an
unsigned/unnotarized developer candidate.

The old Flow A drag failure remains unattributed despite later diagnostic and
this candidate's passing rounds. Historical startup/audio timeouts, clipboard
anomaly and long-term memory-retention risks remain open. The earlier ten real
exports, 300.442-second idle observation and human native capture/cancel evidence
remain attached to **a8c6925c / arm64 1.1.2**, not this version. Capture code and
dependencies were unchanged through `29524f05`; no recording specialty or long
stress suite was repeated. Raw evidence remains local, outside release assets;
previous packages and historical reports are preserved.
