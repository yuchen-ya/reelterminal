# Bilingual UI regression checks

Run `pnpm lint:i18n` (also part of `pnpm lint`). The TypeScript AST check covers
production web source and the native document/screen-capture boundaries. It
checks Chinese literals, static translation keys, English JSX on the review and
cleanup surfaces, catalog parity, dynamic key families, and translations frozen
at module initialization. Comments and tests are excluded.

Use render-time `useTranslation()` for UI labels. Memoized presentation values
must depend on the current translator. Imperative callbacks can use the shared
`t` helper at invocation time. Dates/numbers use the selected app locale; the
native fallback recording menu receives the resolved app preference via the
trusted editor IPC bridge.

`uiMessage()` produces canonical English application diagnostics/metadata;
`LocalizedMessage` and `localizeUiMessage` translate known app messages when
rendered, including retained messages after switching languages. Never apply
these helpers to saved names, document text, Agent output, or user-authored
notification bodies. Toast bodies containing only a user name/path explicitly
set `{ localizeMessage: false }`.

Persisted identity is independent of presentation. In particular, legacy cleanup
handoff scope/retention and legacy video-note sentinels retain their original
bytes. Existing names are never renamed on a language switch. `data-literals.json`
records reviewed data exceptions by exact file, normalized literal SHA-256,
expected occurrence count and reason. A changed/new exception requires review;
do not add blanket file or line-count waivers.

The AST check cannot establish interaction correctness. Keep component/service
regressions for hot switching, drafts, selection, errors, native menu preference
and cross-language handoff replay. Electron E2E defaults to English; tests that
select Chinese keep their Chinese selectors. Preserve authored Chinese fixtures.
Before release, manually inspect EN / 简体中文 / System, an explicit language
opposite the OS, viewer/dialog/Excalidraw state, cancellation and errors, and the
app-owned recording fallback menu. OS-native pickers use the OS language.
