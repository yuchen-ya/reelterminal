# Slice-2d E2E findings (frozen-product issues discovered by this E2E)

These surfaced while executing Appendix D against the real binary. Both
are now resolved by the coordinator after the 2d evidence landed:
finding 1 by a runtime defect fix (`1866110`, proven by the resolution
evidence under `finding1-export-overcount/resolution/`), finding 2 by an
ADR errata (Appendix D step 9 + Appendix E post-implementation errata).
The pre-fix evidence runs' two documented deviations from the Appendix D
letter remain traceable below.

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
- **Status:** **FIXED** (2026-08-31, commit `1866110` —
  `PartFileWriter` reports the high-water mark of written end positions,
  i.e. the true file size; unit tests pin sequential, backward-rewrite,
  extending-rewrite, and sparse shapes in
  `packages/runtime-chromium/src/node/part-file-writer.test.ts`).
  Resolution evidence: scenario 1 (run path) re-executed at
  `SLICE2_E2E_FORCE_MULTICHUNK=1` (8000 kbps ⇒ 4,986,587-byte
  multi-chunk export, the exact finding shape) reaching `done`,
  **82/82 checks** — `resolution/scenario1/run/`. The runner keeps the
  4000 kbps guard-rail by default so the committed pre-fix evidence set
  remains byte-identical when re-generated at its recorded SHA; the
  pre-fix evidence below is preserved verbatim.
- **Pre-fix status (historical):** the E2E exercised the agent-legal
  lever instead: `export_start` accepts `settings.videoBitrateKbps`,
  and the evidence runs passed `4000` (~2.5 MB ⇒ single-chunk export ⇒
  job completes `done`). Appendix D does not pin bitrate; every other
  step-9 assertion (1920×1080, h264, `frameCount == 150`, both pixel
  compares) was asserted unchanged.
- **Suggested owner fix (implemented as `1866110`):** report the
  high-water mark of written end positions instead of the accumulated
  write sum.

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
- **Status:** **RESOLVED by ADR errata** (2026-08-31): Appendix D step 9
  now pins the runtime's documented 0.12 s "±1 frame + mux epsilon"
  tolerance, with the reason recorded inline and in Appendix E's
  post-implementation errata. This E2E asserts `frameCount == 150`
  exactly (the load-bearing frame-exactness claim) and uses the 0.12 s
  container-duration tolerance.
