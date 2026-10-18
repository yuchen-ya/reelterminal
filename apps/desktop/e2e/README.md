# Desktop CLI end-to-end acceptance

Build with `pnpm --filter @reelterminal/desktop build`, then run
`pnpm --filter @reelterminal/desktop test:e2e`.

The harness launches a real Electron app with an isolated user-data directory
and private endpoint path. It never uses the user's live endpoint or prints its
token. Human actions use real Playwright mouse/keyboard input. Agent actions use
independent reelctl processes forwarding
to the desktop Command API. No conversation adapter or Agent login is involved.

`reelctl.e2e.ts` verifies separate CLI processes see the same project,
a CLI edit appears in the GUI, replay across processes creates no duplicate,
shared undo restores the edit, and stale revisions fail without changes.
The other live specs cover context, media import, previews, shared history,
renderer lifecycle, security and catalog compatibility. Conversation/work-mode
specs are retired with their implementation.

`instruction-library-environment.e2e.ts` covers compact instruction chips, copying
through the personal library, and the settings-to-Agent prompt. It uses a private
audio configuration file. `local-captions.e2e.ts` is opt-in with
`REELTERMINAL_CAPTION_E2E_CONFIG` pointing to a verified audio configuration and
`REELTERMINAL_CAPTION_E2E_WAV` to a local speech fixture. It imports the fixture
into an isolated project, generates captions through the real UI and model,
then verifies a single undo removes the captions while preserving source audio.

`instruction-design.e2e.ts` switches the real UI to Chinese and narrows the
inspector to exercise the empty state, default preset selector, hover details,
anchored editor, context menu, drag placement, muted colors and library navigation.
It captures settled screenshots in `.artifacts/instruction-design-zh--*.png`;
inspect these in addition to the assertions. Chip colors remain unchanged after
dragging. The English workflow also checks direct preset insertion, search,
duplicate prevention, edit/cancel, removal/undo and Escape focus restoration.

Requires the built desktop renderer/main, Electron, and (for pixel/export specs)
Chromium plus ffmpeg/ffprobe. Run specs selectively using the separate
`e2e/vitest.config.ts`. Test fixture files stay in isolated run directories;
retained evidence follows the harness evidence policy. Never print descriptors.

The P2 synthetic performance suite is opt-in and remains skipped by ordinary
E2E runs. Use `test:perf:counts`, `test:perf:quick`, or `test:perf:benchmark`;
see [P2 runner](../../../docs/performance/p2-runner.md) for strict CLI options,
production build stamps, cold/warm definitions and measurement limitations.
