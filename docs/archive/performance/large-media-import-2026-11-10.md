# Large video import investigation — 2026-11-10

The desktop import path now avoids a redundant renderer SHA-256 pass and a
whole-file temporary copy for audio probing. Large-video thumbnails no longer
block the durable project commit.

## Observed costs and changes

`AssetsPanel.handleDrop` snapshots native Files, optionally captures file handles,
then calls the same `handleFileImport`/project-store path as file selection.
The store calls `MediaBridge.importFile`, which extracts metadata and confirms
audio-track count, then persists the bytes before publishing the project.

Three waits were confirmed with a real generated 298,973,521-byte MP4:

1. `saveMediaBlob` spent 3,038 ms computing SHA-256 with the renderer's incremental
   JS implementation. The controlled native writer then computed SHA-256 again
   while writing the same bytes. New desktop versions now use the native writer's
   actual digest; existing ids, legacy records and browser saves still verify the
   incoming Blob. An optional expected hash remains enforced before native publication.
2. Native audio probing spent 530 ms materializing the entire video via sequential
   IPC writes, then 24 ms probing it. The read-only probe now resolves a genuine
   native File with preload `webUtils.getPathForFile`. No arbitrary `File.path`
   is trusted. Synthetic Files/Blobs and older bridges retain byte materialization.
3. The >50 MiB quick mode skipped service thumbnails, but the store immediately
   awaited a 266 ms thumbnail fallback. Large videos now use the existing guarded
   post-commit thumbnail job. Small-video behavior remains unchanged.

Representative phase timings from the first complete before/after runs:

| Phase | Before | After |
| --- | ---: | ---: |
| Metadata/preflight | ~13 ms combined remainder | 5.65 ms metadata; 40.23 ms entire bridge import |
| Audio source materialization | 530.16 ms | no whole-file copy; native path resolved |
| Audio probe, including materialization | 554.19 ms | 25.98 ms |
| Thumbnails before publication | 265.63 ms | deferred until after publication |
| Renderer SHA-256 | 3,038.23 ms | no extra pass for a new desktop id |
| Controlled write, native hashing and sync | 596.53 ms | 616.28 ms including initial lookup |
| IndexedDB write | 61.87 ms | 59.48 ms |
| Entire persistence phase | 3,696.65 ms | 675.81 ms |

Metadata has a dedicated span only in the later build. The before remainder is
bridge import minus its native probe, not a claim of isolated metadata timing.
Native hashing is included in controlled-write time; it has not been measured
independently from IPC, disk writes and sync.

The native store still publishes an atomically linked, synced temporary file.
Its final filename uses the actual streaming digest. Expected-hash mismatches,
competing commits and reuse of an id with different bytes are rejected. IndexedDB
remains required before project/history publication. Project identity, executor,
revision, undo and late-thumbnail Blob identity guards remain in place.

## Measured result

Windows checkout production renderer/main builds, Node 22.22.0, pnpm 11.7.0,
FFmpeg 8.1.1. Fixture: 24 seconds, 1280×720, 24 fps, H.264 ultrafast CBR with
100 Mbit/s filler and one AAC audio track. Each run generated fresh media and
used the repository's isolated Electron profile. Source hashing before timing
warmed the OS file cache in every case.

| Build/run | Visible asset card | Decode-ready source preview |
| --- | ---: | ---: |
| Before, one complete baseline | 4,997.87 ms | 5,052.60 ms |
| Probe/preview fixes only | 4,051.39 ms | 4,143.83 ms |
| Full fix 1 | 893.91 ms | 973.11 ms |
| Full fix 2 | 868.01 ms | 939.74 ms |
| Full fix 3 | 868.05 ms | 932.92 ms |
| Full fix, enhanced playback assertion | 847.29 ms | 970.76 ms |
| Full fix median | **868.03 ms** | **955.25 ms** |

The medians are 82.6% and 81.1% lower than the single baseline respectively.
These are local diagnostic samples, not a statistical benchmark or product SLA.
Visibility uses Playwright's DOM-visible condition; preview readiness uses the
actual GUI video element's `readyState >= 2`, including automation round trips.
Neither endpoint claims compositor presentation. The final run additionally
starts playback and verifies time advances after save, source removal and relaunch.

Raw product-clock phase events and runner-clock endpoint durations are in:

- `apps/desktop/e2e/.artifacts/large-media-import-before-1794321837529.json`
- `apps/desktop/e2e/.artifacts/large-media-import-probe-preview-only-1794321937874.json`
- `apps/desktop/e2e/.artifacts/large-media-import-after-1-1794322136163.json`
- `apps/desktop/e2e/.artifacts/large-media-import-after-2-1794322165724.json`
- `apps/desktop/e2e/.artifacts/large-media-import-after-3-1794322174390.json`
- `apps/desktop/e2e/.artifacts/large-media-import-after-playback-1794322214095.json`

These local JSON artifacts are gitignored. No video bytes were uploaded or added
to the checkout; the harness removed isolated media/profiles after each run.

## Validation and reproduction

Changed files:

- Import scheduling: `apps/web/src/stores/project/media-slice.ts`.
- Native audio probe and phase timing: `packages/core/src/media/native-media-bridge.ts`,
  `packages/core/src/media/media-import-service.ts`.
- Native streaming hash/persistence contract: `apps/web/src/services/media-storage.ts`,
  `apps/desktop/src/main/controlled-media-store.ts`,
  `apps/desktop/src/main/ipc/controlled-media.ts`,
  `apps/desktop/src/preload/index.ts`, `apps/web/src/types/global.d.ts`.
- Regression coverage: `apps/web/src/stores/project/media-slice.quick-import.test.ts`,
  `apps/web/src/services/media-storage.test.ts`,
  `packages/core/src/media/native-media-bridge.test.ts`,
  `apps/desktop/src/main/controlled-media-store.test.ts`,
  `apps/desktop/e2e/large-media-import.e2e.ts`.
- Test instructions/evidence: `apps/desktop/e2e/README.md` and this document.

Pre-existing root README/docs changes from other tasks were preserved.

114 distinct selected unit tests passed: web media persistence/quick import/
compound import/replacement/GC (46), core native bridge/hash/media retention/
action history (51), desktop controlled store/preload (17). Added tests cover
unknown-hash streaming publication and races, explicit hash mismatch, unchanged
immutable bytes, blocked persistence, revision/project changes, undo/redo and
late thumbnails after project/Blob changes.

Both `media-import.e2e.ts` and the new large-file E2E passed on built checkout
binaries. The latter checks the independently computed source digest against
both the project digest and a fresh digest of the controlled file, eventual
thumbnails, source removal, project save/relaunch and recovered video playback.

Core/desktop typechecks and desktop `build:renderer` (including web typecheck)
and `build:main` passed. Targeted web ESLint had zero errors and the existing
`media-slice.ts:590` prefer-const warning. `git diff --check` passed.

```powershell
pnpm --filter @reelterminal/desktop build:renderer
pnpm --filter @reelterminal/desktop build:main
$env:TEMP='<local-temp-dir>'
$env:TMP='<local-temp-dir>'
$env:REELTERMINAL_LARGE_IMPORT_E2E='1'
$env:REELTERMINAL_LARGE_IMPORT_LABEL='current'
pnpm --filter @reelterminal/desktop exec vitest run --config e2e/vitest.config.ts e2e/large-media-import.e2e.ts e2e/media-import.e2e.ts
```

The local sandbox blocked Electron launch and native hard links; normal-environment
isolated runs passed. An early measurement-script duration setting and asset-card
locator were corrected before collecting the successful baseline. Those failed
attempts are excluded from the timings above.

Limitations: no user footage or real OS drag gesture was used, no full repository
suite or packaged installer was run, and no package was published. Transcoding,
unusual codecs, long GOPs, network/slow disks, browser-only hashing and duplicate-id
verification can still cost time. A matching rebuilt main/preload/renderer is
required for the native hash change; an already installed app is not updated by
these source changes. The user's open project and live endpoint were untouched.
