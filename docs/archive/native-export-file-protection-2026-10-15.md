# Native export destination protection

Verified on Windows x64, 2026-10-15. All media was synthesized in OS temporary
directories and removed by the tests. No existing user media or project was used.

## Affected versions and route

Published v1.2.0 resolves to `3a5a47a8245ba5cf2187b892b71e458e7bd7d250`.
Before this fix, its `export-job.ts` and `ipc/export.ts` were byte-identical to
current `main` (`eea22864264ab72d68b65151e7d57dddac337d2b`). Both are affected.
The published source was also temporarily loaded for the six real-FFmpeg
matrix tests, then the working source was restored byte-for-byte.

GUI native export reaches `NativeFFmpegBackend` through the desktop export
button/backend factory, then preload export IPC, `startExport`, audio completion,
and `ExportJob`. Native choices include ProRes/AV1/Smallest and applicable
WebCodecs fallbacks. H.264/HEVC fast/balanced can instead use WebCodecs.
The CLI/Agent `export.start` uses `ChromiumExportProvider`, isolated job artifacts
and exclusive delivery; it does not invoke this native `ExportJob`. Passing
Chromium tests would not establish native file safety.

## Reproduction and regression evidence

The real native tests use the vendored FFmpeg, synthesized RGBA frames/silent WAV,
and a generated valid red MP4. Cancellation waits for positive encoded-frame
progress and observed nonempty output bytes, rather than an assumed delay.

| Target / result | Published source | Fixed source |
| --- | --- | --- |
| Existing / success | Complete replacement, decodes | Complete replacement, decodes |
| New / success | Complete output, decodes | Complete output, decodes |
| Existing / cancel after writing | Old file destroyed, decode fails | Old bytes and SHA256 unchanged, decodes |
| New / cancel after writing | Partial MP4 remains | Final target absent |
| Existing / encoder initialization failure | Old file preserved | Old bytes and SHA256 unchanged, decodes |
| New / encoder initialization failure | Target absent | Final target absent |

In the recorded baseline cancellation, the old video was 2,394 bytes,
SHA256 `956592f36205bcf59adf426e85c3d9982f88a117ebff10151a778e30d075b6c7`.
It became 48 bytes,
SHA256 `64d52708f594e8a1a3a4f76deef7275c8ad5184480c9473d8f60a0c9b6f4628b`.
Full FFmpeg decoding with `-xerror` changed from success to failure.
The fixed checks compare exact bytes, byte count, SHA256 and full decode.

Additional passing regressions cover Windows `FileShare.None` preventing final
replacement (error reported, original preserved and decodable); two real jobs
sharing a target where cancellation cannot erase the completed job; deterministic
close-zero/cancel ordering in both directions; nonzero exit after partial writing;
spawn error followed by close; failed commit; cancellation racing audio writes;
and waiting for process shutdown before WAV removal, including application quit.
The deterministic race/IPC tests failed before the fix. Midstream encoder failure
is simulated at process close; the real failure matrix uses an unavailable
encoder and explicitly verifies failure before a positive encoded frame.

Commands used:

```text
pnpm --filter @reelterminal/desktop exec vitest run src/main/sidecar/export-job.test.ts src/main/ipc/export.test.ts test/export-file-protection.test.ts test/export-integration.test.ts test/ipc-contract.test.ts
pnpm --filter @reelterminal/desktop typecheck
pnpm --filter @reelterminal/web exec vitest run src/services/native-ffmpeg-backend.test.ts src/services/export-runner.test.ts
```

The desktop group passes 36 tests; the renderer group passes 30 tests. The real
file-protection suite contains eight cases, including the Windows-only lock case.
FFmpeg-less development environments skip real-encode tests; `EXPECT_FFMPEG=1`
makes a missing binary a setup failure, as in the existing integration suite.

## Minimal fix and platform boundaries

Each job reserves a unique sibling output with exclusive creation and the original
extension, so FFmpeg's muxer selection is unchanged. Only successful child `close`
without prior cancellation commits via one `renameSync`; the old target is never
pre-deleted. Cancellation is synchronous to request and asynchronous to complete:
the process must close before owned temporary output/WAV removal. Pending audio
completion cannot start a cancelled job. Quit awaits this shutdown work.

The synchronous commit is the cancellation boundary: cancellation before commit
preserves the old result; cancellation after commit leaves the completed result.
Concurrent successful exports retain the existing overwrite policy: the last
successful commit wins, but no job writes into another job's partial file.
Commit errors are reported without retry, and the previous destination survives.

On Linux/macOS, same-filesystem rename replaces a regular file atomically; an
already open reader can retain the old inode. Windows libuv uses
`MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)` and a handle denying deletion can
reject replacement, as verified here. See [Node rename documentation](https://nodejs.org/api/fs.html#fsrenameoldpath-newpath-callback)
and [libuv Windows implementation](https://github.com/libuv/libuv/blob/v1.x/src/win/fs.c).
macOS/Linux runtime, network filesystems, power loss, and disk exhaustion were
not exercised. This is process cancellation/error protection, not a crash-durable
filesystem transaction. The release binaries were not executed or modified.

The released-version risk was reported immediately. Until a patch is distributed,
export native video to a new filename and verify it before manually replacing an
existing movie. A 1.2.1 patch release is recommended after platform acceptance;
this task does not package, publish, move tags or change release attachments.
