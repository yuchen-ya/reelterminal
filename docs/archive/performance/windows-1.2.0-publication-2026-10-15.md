# Windows 1.2.0 publication and privacy review — 2026-10-15

**Published:** [ReelTerminal v1.2.0](https://github.com/yuchen-ya/reelterminal/releases/tag/v1.2.0)
at 2026-10-15 14:28:47 UTC. Anonymous API readback returned HTTP 200.
Non-draft, non-prerelease, Latest; annotated tag resolves to
`3a5a47a8245ba5cf2187b892b71e458e7bd7d250`.

The public body exactly matches the user-approved `docs/archive/RELEASE-1.2.0-PUBLIC.md`
(normalized line endings/trailing newline). It contains the approved product,
download and usage guidance, without added internal debugging details.
Only these five custom assets were uploaded; each server SHA-256 digest and
byte size matched its local final file after publication:

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| latest.yml | 349 | `edb8aea6dd349eec662bbf75bfda127b240159117abe296606713a739895b860` |
| ReelTerminal-1.2.0-x64.exe | 138367405 | `954673bf9cb8f3f5c37a07d4c8f47d865cd943d3c0268858126b61e413989401` |
| ReelTerminal-1.2.0-x64.exe.blockmap | 146124 | `c3ee9823a3b7bc608b46a7cf3f665f9225023331e84c072e72676ba013511842` |
| ReelTerminal-1.2.0-x64.zip | 188223361 | `f83072f3fab8b29a3f2e5a49eac8989c9f3f3b7c5f5c7b1d41310b889bc024f5` |
| SHA256SUMS.txt | 365 | `205adef491ae93aa13d5d374f936fb8a447db9eb1dde1c283dd9f8b430a14355` |

No old 1.1.2 package, Mac package, raw test log/screenshot/recording, identity
report, builder-debug file or private scan output was uploaded. The Release's
Mac “being prepared” wording remains until the separately coordinated writer
actually adds the new Mac assets. This task will not concurrently edit it.

## Final Windows package and validation

The normal scripts built an independent directory
`apps/desktop/release/windows-1.2.0-3a5a47a8/` from clean source. App version
1.2.0, exact build-stamp SHA and dirty=false verified. App and installer are
NotSigned. No install/uninstall wizard was executed and no user installation
was replaced.

Final packaged core: **27 passed / 12 files / 93.65 seconds / retry 0**.
Actual connector/CAS, undo, save/reopen, M3 recovery, export/full decode,
first-frame and visible GUI conditions remain. The stricter immediately
pre-drag revision assertion remains; no budget, threshold or business assertion
was relaxed. The normal local startup size was used; this does not claim the
strict hosted small-startup size guard passed locally.

All 2,220 asar payload files excluding the truthful source stamp match the
preceding tested Windows privacy-remediation package. Full installer binary
equivalence is not claimed. The installer was not launched: 7-Zip extracted
its embedded main payload and all **301 files** matched the audited unpacked
output. ZIP CRCs passed and its **300 files** matched. The extra installed
payload helper is not an omitted user media file.

## Privacy checks and bounded conclusion

The old 29524f05 candidate contained two development `.artifacts` reports with
path metadata, dependency test sources and inapplicable Mac sidecars. It was
never released. Commit 71ff40a2 adds actual packaging exclusions and platform
sidecar selection; the final source includes the separate Mac native rpath fix.
No private path value is reproduced in this report, and Git history was not
rewritten.

The final audit used Node/Python filesystem/asar reads, 7-Zip 24.09 extraction,
SHA-256/SHA-512 comparisons, UTF-8 text and binary ASCII/UTF-16 pattern scans,
inline-image/source-map decoding, PNG metadata checks and visual inspection of
three existing shipped manual images. It reviewed 2,221 asar entries, 301 disk
files, changed source/docs, approved notes, installer wrapper, decoded blockmap
and the other precise upload files; repeated/decoded object checks total 2,572
objects and about 670.7MB. Nine unique inline images were decoded and scanned.

Actual inventory contains no `.artifacts`, test files/directories, source maps,
`.git`, `.env*`, credential files, user profile/project directories or foreign
Mac Aurora binaries. Known private-key blocks, provider key/token formats, JWT,
credential literals and the local build-workspace path produced zero matches.
All 38 home-prefix candidates were classified: 35 inherited from byte-identical
installed upstream dependencies/original Electron, one Emscripten virtual home,
and two generic prefix literals in the redacted Mac report. Public upstream
license/font author emails and incidental binary/compressed pattern matches
were retained, not mislabelled as the user's private data. No first-party
private user information or valid secret was identified within this review.

Remaining tiny media fixture source declares deterministic FFmpeg lavfi
color/smptebars generation; it is not the user's media. The three existing
public manual images show generic editor/shortcut/work-assets UI, with no
visible personal paths/credentials and no PNG text/Exif chunks. They are not
raw screenshots from this task.

**Limits:** heuristic rules and selected visual checks cannot prove the
absolute absence of unrecognized/arbitrarily encoded private data. Native
binaries and opaque auxiliary installer code were not exhaustively reverse
engineered. Existing public Git history and author identities were not
anonymized; the user was informed of the historical-path boundary. This Windows
audit does not qualify a Mac DMG/ZIP. Detailed sanitized identities, rule names,
coverage, limitations and public readback are in the [JSON companion](windows-1.2.0-publication-2026-10-15.json).

## Honest source-CI and residual scope

For the frozen source, [CI](https://github.com/yuchen-ya/reelterminal/actions/runs/38749005297),
[Chromium E2E](https://github.com/yuchen-ya/reelterminal/actions/runs/38749004910)
and [performance contracts](https://github.com/yuchen-ya/reelterminal/actions/runs/38749005294)
passed. [Electron E2E](https://github.com/yuchen-ya/reelterminal/actions/runs/38749005390)
overall failed: Windows 123 passed / 13 skipped; Mac 122 passed / 1 failed /
13 skipped. Mac's optional-worker nonblocking first-frame marker exceeded its
unchanged 8000ms budget in `decoder-worker.e2e.ts:125`; no root cause or fix is
claimed, and no rerun-to-green was requested. The corresponding final packaged
Windows check passed. These are different scopes; this is not all-platform
stability or Mac package acceptance.

The original ee1062ec Flow A drag failure remains unattributed, despite later
bounded instrumented gestures committing correctly. The user explicitly
accepted residual risk and approved the concise usage warnings. Local clipboard
anomaly, historical startup/audio timeouts and long-term memory/history bounds
remain limited/unattributed as recorded in earlier reports. Nothing here
asserts all use cases or indefinite leak-free operation.
