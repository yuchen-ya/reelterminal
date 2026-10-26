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

The independent review acceptance specs are `review-foundation-{context,service,
ui,process,attach,migration,rework,scale}.e2e.ts`. They cover no-project identity,
transactions, four content types, processing comparisons, packages, migration,
independent project copies and bounded UI pages. `scale` reports warm text-only
interaction timings and sampled working sets; it is not a media throughput gate.
Set `REELTERMINAL_E2E_APP_EXECUTABLE` to an unpacked EXE to use the same isolated
profiles against a packaged app; external calls normally use the current build CLI.

`review-video-a7.e2e.ts` uses generated VFR, 90-degree display-matrix and nonzero
start-time MP4s. `harness/review-video-fixtures.ts` records ffprobe timestamps and
actual autorotated FFmpeg RGB samples; GUI canvas pixels and video-frame-callback
mediaTime are checked independently. Real pointer seeks/drawing, marker feedback,
v1 publication/v2 rework, profile reopen, mapped 2x comparison and unmapped
independent seeking are covered. Evidence is `e2e/.artifacts/review-video-a7*`.
Legacy `*PtsSec` fields use browser currentTime, not an assumed container PTS;
this test does not create an automatic source-frame mapping or fake frame index.

`review-foundation-native-drag.e2e.ts` is opt-in with
`REELTERMINAL_REVIEW_NATIVE_DRAG=1`. It opens the formal export dialog and an empty
temporary Explorer destination. A human drags a single file, then multiple files
and a folder; the test verifies actual received bytes. It never synthesizes a drop
or equates OS drag initiation with target receipt. In packaged mode it also checks
the actual packaged CLI through Electron's Node runtime. Preview appearance still
requires human feedback. No user project/profile is used.

The P2 synthetic performance suite is opt-in and remains skipped by ordinary
E2E runs. Use `test:perf:counts`, `test:perf:quick`, or `test:perf:benchmark`;
see [P2 runner](../../../docs/performance/p2-runner.md) for strict CLI options,
production build stamps, cold/warm definitions and measurement limitations.

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
