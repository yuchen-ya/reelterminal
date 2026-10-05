# Third-party license materials and signing review

Updated on 2026-10-05 against the published npm packages, their license
declarations, and the production dependency inventory for desktop and renderer.

## npm license materials

The current inventory contains 199 packages. Sixteen dependency records have no
standalone license file in the npm archive; all sixteen now have supplementary
materials with their source and basis identified. Every record has either archive
files or supplementary materials. This measures material coverage, not certified
copyright ownership or clearance of every asset used by the application.

The five previously flagged records were addressed as follows:

| Package | Evidence and change |
| --- | --- |
| `format@0.2.2` | The actual published manifest declares MIT in the legacy `licenses` array. The earlier claim that it declared no license was incorrect. Its [exact source header](https://raw.githubusercontent.com/samsonjs/format/4f898096759776b7c84fa7a25b13c923dadfe46e/format.js) contains the 2010–2013 Sami Samhuri copyright notice and MIT declaration. That notice is preserved with the standard MIT terms. |
| `html-parse-stringify@3.1.0` | Upgraded from 3.0.1 within react-i18next's existing `^3.0.1` constraint. The installed [3.1.0 npm package](https://registry.npmjs.org/html-parse-stringify/3.1.0) includes its full MIT LICENSE and 2025 Henrik Joreteg notice. The i18n and dialog regressions passed. No unrelated dependency versions were changed. |
| `react-remove-scroll-bar@2.3.8` | Its published manifest declares MIT. The official repository's [later LICENSE](https://raw.githubusercontent.com/theKashey/react-remove-scroll-bar/8ca9ba5ea52de03308fe8ced94f7b159a44d28ff/LICENSE) supplies the full terms and 2025 Anton Korzunov notice. It is copied as a later upstream notice, not represented as a file originally shipped in the 2.3.8 archive. |
| `guid-typescript@1.0.9` | The [exact npm package](https://registry.npmjs.org/guid-typescript/1.0.9) declares ISC and supplies author metadata `nicolas`. The complete standard ISC reference accompanies that declaration. No package-specific copyright holder or year is invented. The original npm gitHead was unavailable; the repository now redirects to `snico-dev/guid-typescript`. |
| `lazy-val@1.0.5` | The published package and [exact source manifest](https://raw.githubusercontent.com/develar/lazy-val/b69ad4119f1b19bdab13c61ee2fcc88d46b89071/package.json) declare MIT and author Vladimir Krivosheev. The complete standard MIT reference accompanies that declaration. Its template copyright placeholder is not asserted as the package's copyright notice. |

For `guid-typescript` and `lazy-val`, an upstream package-specific copyright
notice has not been located. The standard reference supplies the full license
terms; it does not create new rights or fabricate an upstream document. If a
downstream distribution policy requires an original package-specific notice,
these two still need upstream confirmation. They are labelled separately in both
the generated text and inventory so reference coverage cannot be mistaken for
that confirmation.

Standard references are pinned to SPDX license-list-data v3.27.0:
[MIT](https://raw.githubusercontent.com/spdx/license-list-data/v3.27.0/text/MIT.txt)
and [ISC](https://raw.githubusercontent.com/spdx/license-list-data/v3.27.0/text/ISC.txt).
The generator verifies supplemented declarations against the installed package's
manifest, including legacy arrays. See [npm's license field guidance](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#license).
License expressions remain labelled as reported by pnpm.

The previous twelve supplements are retained, including the complete MIT section
from `splaytree@3.2.3`'s published README and the official CC0-1.0 legal code for
`highlightjs-vue@1.0.0`. Source/version mappings and review notes are in
[`npm-upstream-sources.json`](npm-upstream-sources.json).
`@stylexjs/stylex@0.18.3` uses the exact npm gitHead's root MIT license; that
commit's package manifest says 0.18.2, so the metadata mismatch remains visible.
PostHog is absent from the current production dependency closure.

Run `pnpm --filter @reelterminal/desktop test:licenses` to verify reference
labelling, legacy license declarations and declaration mismatch rejection, then regenerate with
`pnpm --filter @reelterminal/desktop build:licenses`. Inspect the generated
inventory and the packaged `resources/LICENSES/` directory. FFmpeg, Blender,
fonts and model assets have separate obligations described in their own notices.

## Signing and notarization

Publishing the source repository does not require a code signing certificate.
An explicitly labelled unsigned Windows alpha is a possible early distribution
choice, with the installation restrictions described in
[`../DISTRIBUTION.md`](../DISTRIBUTION.md). Signing helps verify the publisher and
improve installation experience; it is separate from third-party licensing.
It does not guarantee the absence of SmartScreen warnings. Normal macOS
distribution outside the Store should use Developer ID signing and notarization.

The 2026-10-04 build-host check found no usable Authenticode identity or standard
signing/notarization environment configuration. Repository-level GitHub Actions
secrets had none of the standard signing names; organization/environment secrets
were not inspected. No signed Windows installer or signed/notarized macOS build
has been produced or verified. The macOS configuration enables hardened runtime
and notarization, but configuration alone is not acceptance evidence.

These remain release-experience tasks if distributing an unsigned Windows alpha;
complete and verify them before claiming a signed or notarized release. The
2026-10-05 Windows unpacked verification build includes the 199-record inventory
and all supplementary materials; Authenticode reports the application executable
as `NotSigned`. The packager's "signing with signtool" log is not proof of a
valid signature. Keep private keys and signing credentials out of Git and chat
output.
