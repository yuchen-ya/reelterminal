# Desktop CLI end-to-end acceptance

Build with `pnpm --filter @reelterminal/desktop build`, then run
`pnpm --filter @reelterminal/desktop test:e2e`.

The harness launches a real Electron app with an isolated user-data directory
and private endpoint path. It never uses the user's live endpoint or prints its
token. Human actions use real Playwright mouse/keyboard input. Agent actions use
independent reelctl processes forwarding
to the desktop Command API. No conversation adapter or Agent login is involved.
Inherited delivery roots, fixed live ports and crash-report endpoints are cleared
unless a spec explicitly supplies a hermetic replacement; isolation paths always
win. Automatic CLI result files stay under the test run directory's `cli-data`.

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
The fixture configuration must include `qwenPython`, `qwenModelDir` and
`qwenAlignerModelDir`; Qwen and SenseVoice captions both run on CPU and use
word alignment. `caption-design.e2e.ts` checks the Chinese empty state, visible
primary action in the default narrow panel, model selection and Agent setup flow.
Inspect its `caption-design-zh--*.png` evidence as well as the assertions.

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

Experimental independent batch review is retired. Its dedicated `review-*.e2e.ts` specs no longer define supported behavior. Project-scoped `workbench*.e2e.ts` and `legacy-review-history.e2e.ts` remain active.

Current review acceptance uses `folder-review.e2e.ts`, `task-review.e2e.ts`, `task-review-recovery.e2e.ts`, and `task-review-media.e2e.ts`. `independent-batch-retirement.e2e.ts` verifies absent legacy entries, rejected CLI writes and exact preservation of an existing synthetic stored record. Board tests retain private content, pixels and real single-file exports; retired node-export assertions are replaced with independent saved-byte checks.

Set `REELTERMINAL_E2E_APP_EXECUTABLE` to an unpacked executable to use the same isolated profiles against a packaged app. External calls normally use the current build CLI unless a spec explicitly selects the packaged entry.

The P2 synthetic performance suite is opt-in and remains skipped by ordinary
E2E runs. Use `test:perf:counts`, `test:perf:quick`, or `test:perf:benchmark`;
see [P2 runner](../../../docs/performance/p2-runner.md) for strict CLI options,
production build stamps, cold/warm definitions and measurement limitations.

`cli-contract-consistency.e2e.ts` explicitly selects both the packaged EXE and
its `resources/app.asar/dist/reelctl/index.js` when
`REELTERMINAL_E2E_APP_EXECUTABLE` is set. It checks that entry using Electron's
Node runtime and fails if missing, with no checkout fallback. Only CLI children
receive `ELECTRON_RUN_AS_NODE=1`. It covers offline help/OS exit codes, controlled
red media after replacing the blue original, three media tracks and native SRT,
real export/delivery/verification, independent decode/audio checks and saved
project relaunch. Dependencies are required, not conditionally skipped. Evidence
is retained under `.artifacts/cli-contract-{checkout,packaged}-<timestamp>*`,
including actual executable/entry, JSON/exit codes, previews and MP4. Other specs
retain their existing CLI selection; switching only the EXE does not prove a
packaged CLI passed.

## Paused video frame stepping

Run `pnpm --filter @reelterminal/desktop build:renderer` and
`pnpm --filter @reelterminal/desktop build:main`, then
`pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts e2e/frame-stepping.e2e.ts`.
This regular, non-gated E2E uses an isolated profile and a generated H.264 video
whose pixels encode each source frame number. It covers global and scrub-bar
keyboard stepping, slow steps 600ms apart, repeat input, reverse stepping, and
idle decoder release/reload. Project frame rates 24/30/60 are also covered by
`playback-bridge.scrubbing.test.ts`.

The 1:1 trace is retained in `e2e/.artifacts/frame-stepping-*.json`.
`seekToCanvasFrame` correlates each accepted seek command to a complete canvas
commit by seek ID and target time. Superseded, no-op, failed and cancelled inputs
have explicit outcomes; project revision alone is insufficient to identify a
seek. Pointer gesture endpoints additionally require the final target time.
`frameDiagnostics` reports exact render/decoder counts even when event sampling
is enabled; per-seek render counts are marked incomplete when samples are lost.
All latency endpoints use the renderer clock. They do not include Playwright/CLI
round trips and do not claim compositor presentation.

The smoke gates require one render/commit per isolated step, no decode timeout,
progress before repeat input ends, exact final pixels, warm input-to-canvas and
repeat commit gaps below 250ms, and decoder reuse across slow steps. Larger
media and comparison mode can add real decoding/composition cost; the fixture's
latencies are not a hardware-independent product promise.


`review-model3d.e2e.ts` uses original MIT programmatic GLB/PNG fixtures (PBR,
alpha, skin and morph). Two real isolated GUI cases cover import/observe/pause/
seek/capture, version-bound handoff and GLB rework, step comparisons, original
byte exports, reopen/package restore/re-export, offline rejects, context loss,
rapid selection, hidden RAF and bounded dual-view measurements. It runs against
an unpacked EXE with `REELTERMINAL_E2E_APP_EXECUTABLE`. Evidence follows
`e2e/.artifacts/review-model3d*`; synthetic measurements do not validate user
models or arbitrary hardware. See `docs/REVIEW-3D-PREVIEW-DELIVERY.md` at repo root.

## 1.3.1 packaged regression selection

The local Windows package validation is recorded in
[RELEASE-1.3.1.md](../../../docs/RELEASE-1.3.1.md).
The selected specs use isolated profiles and the packaged executable:

- whole-template-history.e2e.ts saves a local project template and creates an
  independent project, preserving source content and pending redo.
- review-navigation.e2e.ts creates tasks, opens category management from the
  directory menu, uses the search/filter drawer to select a category, and
  switches batches with both mouse and keyboard.
- review-image-loading.e2e.ts checks consecutive image loading and reachable controls.
- review-issue-actions.e2e.ts explicitly opens the sidebar, issue panel and review
  details before testing their controls. After content refresh or item switches,
  it reopens the collapsed issue panel; hidden DOM is not treated as visible UI.
- titlebar-drag.e2e.ts verifies Windows caption hit regions and clickable controls.

These checks do not exercise the installation wizard, OS drag-out receipt,
pressure-sensitive hardware or optional model installation.

`large-media-import.e2e.ts` is opt-in with `REELTERMINAL_LARGE_IMPORT_E2E=1`.
It generates a roughly 299 MB H.264/AAC MP4 inside the isolated run directory,
imports a genuine OS-backed File through the file input (the same store path
as OS drop), and records import-to-visible and preview-decode-ready times plus
opt-in product phase timings. It checks independent source/controlled SHA-256,
background thumbnails, save/relaunch, and actual playback after moving the
original away. `REELTERMINAL_LARGE_IMPORT_LABEL` labels the JSON evidence under
`.artifacts/large-media-import-*.json`. This is a fresh-profile, warm-file-cache
synthetic measurement; it does not automate an OS drag gesture or establish
hardware-independent latency targets. Retain engineering measurements and raw evidence locally under the harness artifact directory; user release notes describe behavior and limitations separately.
