# Slice-2d E2E findings (frozen-product issues discovered by this E2E)

These surfaced while executing Appendix D against the real binary. None of
them is fixable inside slice 2d: both live in frozen product code (facade /
runtime), and the ADR text is frozen too. They are recorded here so the
evidence run's two documented deviations from the Appendix D letter are
traceable, and so the runtime/facade owners get machine-readable
reproductions.

## Finding 1 — export jobs fail deterministically once the MP4 exceeds mediabunny's 4 MiB StreamTarget chunk size

- **Reproduction:** scenario 1 at the default 1080p export bitrate
  (~7465 kbps ⇒ ~4.66 MB). The job always terminalizes as `error` with
  `JOB_FAILED`: `provider wrote fewer bytes (4662175) than it reported
  (4662183) for …/output.mp4` — a constant +8 overcount.
  `evidence/findings/finding1-export-overcount/transcript-default-bitrate-failure.jsonl`
  holds two full failing runs.
- **Mechanism:** the in-page muxer (mediabunny `StreamTarget`,
  `chunked: true`, `chunkSize: 4 MiB`) emits chunk writes with absolute
  positions and rewrites a region (8 bytes) once a mid-stream flush has
  happened. `PartFileWriter.bytesWritten`
  (`packages/runtime-chromium/src/node/runtime.ts`) sums EVERY chunk,
  including the rewritten overlap, so the completion's
  `sizeBytes = writer.bytes` exceeds the real file size by exactly the
  rewritten byte count. The facade's honest artifact guard
  (`artifactRefFor`, `packages/agent-facade/src/session.ts`: "provider wrote
  fewer bytes … than it reported") then rejects the good file. Exports that
  stay under one chunk (all slice-1b tests at 320×180, ~small MB) never
  flush mid-stream, so the bug is invisible to the existing suites.
- **Status:** NOT fixed here (frozen runtime + facade semantics). The E2E
  exercises the agent-legal lever instead: `export_start` accepts
  `settings.videoBitrateKbps`, and the evidence runs pass `4000`
  (~2.5 MB ⇒ single-chunk export ⇒ job completes `done`). Appendix D does
  not pin the bitrate; every other step-9 assertion (1920×1080, h264,
  `frameCount == 150`, both pixel compares) is asserted unchanged.
- **Suggested owner fix (for a future decision, not this slice):** report
  the post-finalize file size (or make `PartFileWriter.bytes` a high-water
  mark of `position`) instead of the accumulated write sum.

## Finding 2 — Appendix D's `durationToleranceSec: 1/30` is unachievable for any export of this runtime

- **Reproduction:** any completed export probed with
  `expect.durationSec: 5, durationToleranceSec: 1/30` fails the facade's
  `duration` check: `expected 5s ±0.033s, probed 5.077s (Δ 0.077s)`.
- **Mechanism:** `verify_artifact`'s `probe.durationSec` is the ffprobe
  FORMAT (container) duration
  (`packages/runtime-chromium/src/node/verify.ts`), and every export of this
  runtime muxes a silent AAC track: the timeline-audio renderer treats
  video tracks as audio carriers (`export-engine.ts` `hasAudio`) and the
  closed headless op set has no way to mute or omit the track. The AAC
  priming/padding extends the container duration to ~5.077 s. The video
  stream itself is exactly 150 frames ( asserted exact in this E2E).
  The runtime's own suites use `durationToleranceSec: 0.12` ("±1 frame +
  mux epsilon", `providers.ts ArtifactProbeExpectation`, slice-1b e2e) for
  exactly this reason.
- **Status:** the ADR text is frozen, so this E2E asserts the ADR's
  `frameCount == 150` exactly (the load-bearing frame-exactness claim) and
  uses the runtime's documented 0.12 s mux-epsilon tolerance for the
  container-duration check, with the deviation recorded here and in
  REPORT.md.
