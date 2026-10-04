# Third-party license and signing review

Checked on 2026-10-04 against the production dependency inventory for the desktop and web renderer.

## npm license texts

The npm archives for 18 dependency records contain no standalone license file. Complete texts are now included from matching upstream release files or exact source revisions for 12 records; `splaytree@3.2.3` is copied from the complete MIT section in its published `Readme.md`. `highlightjs-vue@1.0.0` uses the official CC0-1.0 legal code. Sources and version mappings are in [`npm-upstream-sources.json`](npm-upstream-sources.json). The build inventory records the pnpm-reported license separately from the archive files and upstream source URLs.

Six records still lack an attributable complete license text:

| Package | Reported license | Evidence and release action |
| --- | --- | --- |
| `@posthog/core@1.14.0` | MIT | The package metadata reports MIT, but its exact package directory has no license file. Its source includes a complete MIT notice for TraceKit contributors, not for this package; the monorepo root license at the matching source revision is Apache-2.0. Obtain an authoritative package-specific notice or clarification. [Upstream package](https://github.com/PostHog/posthog-js/tree/2b10214aed5f2b040ff865e18bb204814ca7c3d9/packages/core) |
| `format@0.2.2` | MIT reported by pnpm | The npm registry metadata and exact published `package.json` declare no license; the exact source revision and archive have no complete license text. Treat the MIT classification as unconfirmed and obtain an upstream statement. [Exact source revision](https://github.com/samsonjs/format/tree/4f898096759776b7c84fa7a25b13c923dadfe46e) |
| `guid-typescript@1.0.9` | ISC | The archive has no complete ISC text. Its npm metadata points to an upstream repository revision that is no longer available at the listed GitHub repository. Confirm the license and obtain its notice from the maintainer. [Upstream project](https://github.com/NicolasDeveloper/guid-typescript) |
| `html-parse-stringify@3.0.1` | MIT | Neither the exact npm archive nor its source revision contains the full terms. The repository has a license file at a later release, but that does not verify the archived 3.0.1 source. [Exact source revision](https://github.com/henrikjoreteg/html-parse-stringify/tree/ce46022f537ef9b050fac592f9fcc30bf838e5ba) |
| `lazy-val@1.0.5` | MIT | The exact npm archive and source revision have no full license text in a license file, README, or source header. Obtain the release notice from upstream. [Exact source revision](https://github.com/develar/lazy-val/tree/b69ad4119f1b19bdab13c61ee2fcc88d46b89071) |
| `react-remove-scroll-bar@2.3.8` | MIT | The exact npm archive and source revision have no full license text in a license file, README, or source header. Obtain the release notice from upstream. [Upstream project](https://github.com/theKashey/react-remove-scroll-bar) |

Treat these six as an open notice-completeness item before publishing installers. The current evidence does not establish a license violation, but it is not enough to mark the bundled third-party notices complete. The generated inventory intentionally labels license expressions as reported by pnpm; it does not claim legal verification. `@stylexjs/stylex@0.18.3` is sourced from the exact npm `gitHead` and that commit's root MIT license; its checked-in package manifest says 0.18.2, so this version metadata mismatch remains visible for upstream confirmation.

## Signing and notarization

`electron-builder.yml` enables macOS hardened runtime and notarization. Windows targets are configured, but the repository has no release publisher workflow or checked-in signing certificate configuration. On the Windows build host, the check found no usable Authenticode certificate in the current-user or local-machine stores, no certificate artifact files in the workspace, and none of the standard `CSC_*`, `WIN_CSC_*`, or `APPLE_*` signing/notarization environment variables. The repository-level GitHub Actions secret list also had none of those standard names; organization- or environment-level secrets were not inspected.

No signed Windows installer or signed/notarized macOS build was produced or verified. A release machine with the appropriate signing identity and notarization credentials is still required.
