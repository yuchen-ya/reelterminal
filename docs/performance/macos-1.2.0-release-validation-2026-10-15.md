# macOS 1.2.0 package acceptance — 2026-10-15

**The new Apple Silicon packages passed the scoped acceptance and privacy
checks. They have no Developer ID signature or notarization.** Publication
remains with the main session; this session created no tag or Release,
uploaded no attachments and overwrote no remote assets.

The main session explicitly froze
`3a5a47a8245ba5cf2187b892b71e458e7bd7d250` for both platforms. The build used
that clean commit, all 15 package versions are 1.2.0, and the production stamp
records the exact SHA with `dirty=false`. Moving main was not used as a freeze.
Older packages and historical reports were preserved. This is a new build,
not a renamed 1.1.2 package.

At the closing remote check, the main session's annotated `v1.2.0` tag peeled
to that same frozen SHA. Its Release draft used the approved user-facing
description. This session only read those records; it did not change them.

## Packages

Directory: `apps/desktop/release/macos-1.2.0-3a5a47a8-2026-10-15/`.

| File | Bytes | SHA256 |
| --- | ---: | --- |
| `ReelTerminal-1.2.0-arm64.dmg` | 163893512 | `9097d906d73bd364bfe71af7e58e42a6b8e4ce78648d73fd8c1734a180cdd90f` |
| `ReelTerminal-1.2.0-arm64.zip` | 164107809 | `07552412110420bd606f12120a458b36dcf2ac66a5b6e818b1e4e00e5cfa982a` |

`SHA256SUMS.txt` and `MAC-PACKAGE-NOTES.md` are beside them. Raw evidence and
`builder-debug.yml` are not release attachments. Full component identities and
scope are in the [JSON report](macos-1.2.0-3a5a47a8-2026-10-15.json).

The normal frozen-lockfile install, WASM build and desktop `dist` scripts were
used with `--mac dmg zip --arm64 --publish never`, an independent output, and
explicit `mac.identity=null`, `mac.notarize=false` and disabled identity discovery.
Electron remains 44.5.1; Node 23.11.0 and pnpm 11.7.0 were used. No dependency
upgrade, credential creation, security-setting change or signing-service
operation was performed.

## Actual new-package checks

- Info.plist, packaged package.json and build stamp agree on 1.2.0. All 16
  Mach-O files are thin arm64. ASAR header, file and block integrity passed.
  app.asar SHA256:
  `faa733469ccad7829a9fd04f6268cc586e8dc21ed26280f2c954b8044f87d7f8`.
- All 14 dist files, main/preload, CLI/MCP, browser worker, 190 renderer assets,
  four renderer workers and 38 dependency records were checked against the
  frozen build. Only an empty source `.gitkeep` is omitted from renderer assets.
- ZIP CRCs passed. ZIP and read-only-mounted DMG contain the same app as tested:
  all 886 entries match content, symlinks and permissions. The DMG was detached.
- The actual packaged `.app` passed **30/30 tests in 12 files, 122.86 seconds,
  retry 0**. Isolated profiles and synthetic projects covered startup/open,
  real CLI/MCP-to-GUI collaboration, edit, undo/redo, save/reopen, archive
  save points and previews, comparison opacity, small-window player/review
  controls, explicit review workspace, durable checkpoints and process recovery.
  Connectors ran from build-output files verified byte-identical to the packaged
  components; no facade stub replaced the real connection.
- GUI export produced a synthetic H.264 1920×1080@30 file, 150 frames/5 seconds.
  The unchanged onboarding test decoded the complete file with FFmpeg. This
  single image-based export has no audio stream; it is not a new audio-export
  endurance claim. Output SHA256:
  `f9efb2c5f28f8070fb310619744025af58b0cf7d7e90432be7c016706ad23366`.
- The Aurora renderer in the final app matches the committed corrected binary,
  SHA256 `6df7a37a1139924b792917295776c3f8f6790c5fb1aa6b1391a65e3644f4d096`.
  It actually loaded the packaged colocated dylib and passed the triangle-render
  self-test. Explicitly selecting this packaged renderer also passed the existing
  native-backend preview and committed golden tests, **2/2**, without CPU fallback.

Action budgets, assertions and retry settings were unchanged. Test processes
were closed; no main process from this packaged candidate remained. Raw logs,
synthetic output and screenshots remain in the ignored local E2E evidence area.

Supplemental source regressions for failed-analysis rollback, job completion,
batch checkpoints and the task ledger passed **29 tests**; two Windows-only
checkpoint sharing/concurrent-reader cases were skipped on macOS. These are
source unit checks, separate from the 30 packaged GUI tests.

## Privacy and signing boundary

Final app, ASAR, ZIP, DMG root metadata, update metadata, checksum file and
package notes were scanned. The private Aurora RPATH and the two old local
runtime `.artifacts` reports are absent. No credential/profile file, source map,
recognized private-key/token pattern, real project/media or raw test evidence
was found. Public dependency strings were checked against installed upstream
files and retained. This is a bounded package scan, not a universal secrecy claim.

The native helper's local ad-hoc signature verifies successfully. The whole app
retains Electron's inherited linker ad-hoc signature, has no Developer ID or
stapled notarization ticket, and fails whole-app strict signature verification.
These are unsigned/unnotarized developer packages, not formally signed installers.
Clean-machine Gatekeeper/installation behavior was not qualified.

**The private path previously entered remote Git history.** The new version is
cleaned; historical blobs and distributed copies remain. No history was rewritten,
and the whole repository history is not claimed free of personal information.
See the [native correction record](macos-1.2.0-native-privacy-2026-10-15.md).

## Retained limits

The old hosted Flow A drag failure remains unattributed; later diagnostic rounds
and this package's passing gesture do not establish a fix. Historical startup
and audio timeouts, the clipboard anomaly, long-term shared/browser memory
retention and the small post-saturation history heap trend remain unresolved.
This is scoped functional evidence, not a claim of
complete stability in all environments or a performance baseline.

Capture implementation files and the lockfile are unchanged from the earlier
`a8c6925cfa067a25e347db41ba7be050b5c4757d` Mac package; recording dependencies
were not upgraded. Native source-picking/recording specialty tests were therefore
not repeated. The earlier ten real exports, **300.442-second** idle observation,
human synthetic-window capture and native cancel evidence retain their original
**arm64 1.1.2** identity. No long stress suite was rerun or relabelled as 1.2.0.
Intel/x64, formal signing/notarization and long-term memory bounds are not covered.
The original [export/idle report](macos-native-export-retest-2026-10-15.md) and
[native-picker acceptance](macos-native-picker-release-gate-2026-10-15.md) remain
the evidence for those earlier packages.
