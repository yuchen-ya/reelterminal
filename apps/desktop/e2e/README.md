# Desktop CLI / MCP end-to-end acceptance

Build with `pnpm --filter @reelterminal/desktop build`, then run
`pnpm --filter @reelterminal/desktop test:e2e`.

The harness launches a real Electron app with an isolated user-data directory
and private endpoint path. It never uses the user's live endpoint or prints its
token. Human actions use real Playwright mouse/keyboard input. Agent actions use
independent reelctl processes or the shipped stdio MCP adapter, both forwarding
to the desktop Command API. No conversation adapter or Agent login is involved.

`reelctl.e2e.ts` verifies separate CLI processes see the same project as MCP,
a CLI edit appears in the GUI, replay across transports creates no duplicate,
shared undo restores the edit, and stale revisions fail without changes.
The other live specs cover context, media import, previews, shared history,
renderer lifecycle, security and catalog compatibility. Conversation/work-mode
specs are retired with their implementation.

Requires the built desktop renderer/main, Electron, and (for pixel/export specs)
Chromium plus ffmpeg/ffprobe. Run specs selectively using the separate
`e2e/vitest.config.ts`. Test fixture files stay in isolated run directories;
retained evidence follows the harness evidence policy. Never print descriptors.
