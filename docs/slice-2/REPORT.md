# Slice 2d — black-box E2E evidence report (ADR 0003 Appendix D)

Executed by `scripts/slice2-e2e/run.mjs` against the REAL built transport binary `packages/agent-transport/dist/cli.js`; this report is rendered from the committed transcripts by `scripts/slice2-e2e/report.mjs` — every number below is derived from the recorded assertions.

## Method note (honesty rule, Appendix D)

Both executed paths are **scripted simulators** and are labeled **`simulated`**: path `run` authors Appendix-B.6 JSONL workflows and invokes `agent-video run`; path `mcp` is a raw-NDJSON stdio MCP client over `agent-video serve` (same framing as `packages/agent-transport/test/helpers.ts`). Per Appendix D, a client may be claimed "verified" only when executed by that client's real binary — no such claim is made here.

Real-client CLI probe (probed 2026-08-31T05:17:03.101Z):

| CLI | Probe | Result |
|---|---|---|
| `claude` | `which claude` | not installed |
| `codex` | `which codex` | not installed |
| `pi` | `which pi` | not installed |
| `zcode` | `which zcode` | not installed |
| `dsh` | `which dsh` | not installed |

No real client binary is installed on this machine (the same finding as Appendix C's probe), so no client is claimed as verified. Scenario 1 of Appendix F's 2d definition asked for "≥2 real clients" — that part is **not done** and is recorded honestly here; the rest of the contract (both scenarios, completely, over both transport paths) is executed and evidenced.

## Environment

| Fact | Value |
|---|---|
| Repo HEAD SHA | `e36925a4bd2ec9a38a83846e99be21b2d4d7af97` |
| Host | darwin arm64 (24.6.0) |
| Node | v23.11.0 |
| ffmpeg | ffmpeg version 9.0.1 Copyright (c) 2000-2026 the FFmpeg developers |
| ffprobe | ffprobe version 9.0.1 Copyright (c) 2007-2026 the FFmpeg developers |
| Binary under test | `/Users/macbuke/my-project/agent-video-engine-lab-wt/slice-2/packages/agent-transport/dist/cli.js` |
| Binary sha256 | `ef2c3b634013a43d0f2adfe3b4582d8c74ea10b873a62dcb53e9c87eafb88bc9` |
| Chromium build (doctor) | 148.0.7778.96 |
| Transport version | 0.1.0 |
| Export route (doctor preflight) | chromium-webcodecs |
| Evidence generated at | 2026-08-31T05:17:03.091Z |

## Results overview

| Execution | Checks | Result | Evidence |
|---|---|---|---|
| scenario 1 (`slice2-transport-e2e`) — run path | 82/82 | PASS | `docs/slice-2/evidence/scenario1/run/` |
| scenario 1 (`slice2-transport-e2e`) — mcp path | 75/75 | PASS | `docs/slice-2/evidence/scenario1/mcp/` |
| scenario 2 (`slice2-persistence-e2e`) — run path, SIGTERM variant | 103/103 | PASS | `docs/slice-2/evidence/scenario2/run-sigterm/` |
| scenario 2 (`slice2-persistence-e2e`) — run path, SIGKILL variant | 103/103 | PASS | `docs/slice-2/evidence/scenario2/run-sigkill/` |
| scenario 2 (`slice2-persistence-e2e`) — mcp path, SIGTERM variant | 97/97 | PASS | `docs/slice-2/evidence/scenario2/mcp-sigterm/` |
| scenario 2 (`slice2-persistence-e2e`) — mcp path, SIGKILL variant | 97/97 | PASS | `docs/slice-2/evidence/scenario2/mcp-sigkill/` |

## scenario 1 (`slice2-transport-e2e`) — run path

Checks: **82/82 passed**. Transcript: `evidence/scenario1/run/transcript.jsonl` · sha256 manifest: `evidence/scenario1/run/sha256s.txt`. Full per-check table: `evidence/scenario1/run/assertions.md`.

| Step | Contract step | Checks | Result |
|---|---|---|---|
| 1 | doctor report is usable and complete | 8/8 | PASS |
| 2 | session_describe: contract, 14 verbs, 8 error codes; capabilities all available | 9/9 | PASS |
| 3 | project_create ⇒ ok, revision 0, replayed false | 5/5 | PASS |
| 4 | media_import ⇒ revision 1, mediaId, duration >= 5 s | 4/4 | PASS |
| 5 | edit_apply ⇒ revision 2 (0→1→2 arithmetic) | 3/3 | PASS |
| 6a | media_import outside roots ⇒ INVALID_PARAMS (escape wording) | 4/4 | PASS |
| 6b | replay same key+payload ⇒ identical result replayed:true | 3/3 | PASS |
| 6c | same key different payload ⇒ CONFLICT | 3/3 | PASS |
| 6d | timeline_get deep-check: exactly the constructed world (conflict applied nothing) | 5/5 | PASS |
| 6e | timeline_get deep-check: main session world | 5/5 | PASS |
| 7 | preview PNG {sizeBytes>0, sha256, sourceRevision:2} inside artifactRoot | 6/6 | PASS |
| 8a | export_start ⇒ {jobId, state:queued, sourceRevision:2} | 3/3 | PASS |
| 8b | bounded await step reached terminal done with artifact + route (150 frames implied by 5s x 30fps) | 3/3 | PASS |
| 9a | verify_artifact full battery ⇒ probe.frameCount == 150, all checks pass | 8/8 | PASS |
| 9b | compare similar vs step-7 preview PNG (same project/revision) | 3/3 | PASS |
| 9c | compare different vs raw input.mp4 (minChangedPixelsRatio > 0 — the load-bearing pixel proof) | 3/3 | PASS |
| 10a | restart ⇒ fresh session has no project and no jobs (NOT_FOUND on reads) | 4/4 | PASS |
| 10b | doctor lists the orphan; nothing auto-deleted | 3/3 | PASS |

## scenario 1 (`slice2-transport-e2e`) — mcp path

Checks: **75/75 passed**. Transcript: `evidence/scenario1/mcp/transcript.jsonl` · sha256 manifest: `evidence/scenario1/mcp/sha256s.txt`. Full per-check table: `evidence/scenario1/mcp/assertions.md`.

| Step | Contract step | Checks | Result |
|---|---|---|---|
| 1 | doctor report is usable and complete | 8/8 | PASS |
| 2 | session_describe: contract, 14 verbs, 8 error codes; capabilities all available | 9/9 | PASS |
| 3 | project_create ⇒ ok, revision 0, replayed false | 5/5 | PASS |
| 4 | media_import ⇒ revision 1, mediaId, duration >= 5 s | 4/4 | PASS |
| 5 | edit_apply ⇒ revision 2 (0→1→2 arithmetic) | 3/3 | PASS |
| 6a | media_import outside roots ⇒ INVALID_PARAMS (escape wording) | 3/3 | PASS |
| 6b | replay same key+payload ⇒ identical result replayed:true | 3/3 | PASS |
| 6c | same key different payload ⇒ CONFLICT | 2/2 | PASS |
| 6d | timeline_get deep-check: exactly the constructed world | 5/5 | PASS |
| 7 | preview PNG {sizeBytes>0, sha256, sourceRevision:2} inside artifactRoot | 6/6 | PASS |
| 8a | export_start ⇒ {jobId, state:queued, sourceRevision:2} | 3/3 | PASS |
| 8b | poll job_status (2–5 s cadence) reached terminal done with artifact + route | 3/3 | PASS |
| 9a | verify_artifact full battery ⇒ probe.frameCount == 150, all checks pass | 8/8 | PASS |
| 9b | compare similar vs step-7 preview PNG (same project/revision) | 3/3 | PASS |
| 9c | compare different vs raw input.mp4 (minChangedPixelsRatio > 0 — the load-bearing pixel proof) | 3/3 | PASS |
| 10a | restart ⇒ fresh session has no project and no jobs (NOT_FOUND on reads) | 4/4 | PASS |
| 10b | doctor lists the orphan; nothing auto-deleted | 3/3 | PASS |

## scenario 2 (`slice2-persistence-e2e`) — run path, SIGTERM variant

Checks: **103/103 passed**. Transcript: `evidence/scenario2/run-sigterm/transcript.jsonl` · sha256 manifest: `evidence/scenario2/run-sigterm/sha256s.txt`. Full per-check table: `evidence/scenario2/run-sigterm/assertions.md`.

| Step | Contract step | Checks | Result |
|---|---|---|---|
| 0 | doctor report is usable and complete | 8/8 | PASS |
| 1 | process A: create + import + edit + previewA at 2.5 s | 18/18 | PASS |
| 2 | process A: save checkpoint ⇒ ok; revision == revisionBefore; exact path; no .tmp siblings | 7/7 | PASS |
| 3 | process A killed entirely (SIGTERM) — checkpoint already complete and visible | 2/2 | PASS |
| 4a | third process: project_create then project_open ⇒ CONFLICT | 3/3 | PASS |
| 4b | process B: fresh session, empty ledger — project_open ⇒ adopted at revisionBefore; timeline deep-equals | 7/7 | PASS |
| 5a | process B: continue edit (expectedRevision == revisionBefore) ⇒ revision + 1 | 2/2 | PASS |
| 5b | process B: save to NEW path e2e-v2 ⇒ ok | 5/5 | PASS |
| 5c | process B: save back onto v1 without overwrite ⇒ CONFLICT (default no-overwrite) | 2/2 | PASS |
| 6a | process B: pixels — previewB renders the pre-restart content | 6/6 | PASS |
| 6b | process B: compare similar previewB vs previewA — pixel continuity across the restart | 3/3 | PASS |
| 8a | process B export_start ⇒ queued | 3/3 | PASS |
| 8b | process B export reached terminal done | 3/3 | PASS |
| 6c | process B: full verify battery of scenario 1 step 9 incl. compare-similar vs its own preview | 11/11 | PASS |
| 6d-i | byte flip inside project ⇒ integrity refusal (stateSha256 mismatch) | 4/4 | PASS |
| 6d-ii | formatVersion 999 ⇒ UNSUPPORTED (unknown-version wording) | 4/4 | PASS |
| 6d-iii | mediaRefs path diverging from originalUrl (hash recomputed) ⇒ binding refusal naming step 5 | 4/4 | PASS |
| 6d-iii-2 | binding refusal names the offending mediaId | 1/1 | PASS |
| 6d-iv | referenced media renamed away ⇒ open refuses, details naming the mediaId | 4/4 | PASS |
| 6d-iv-2 | media-moved refusal names the offending mediaId | 1/1 | PASS |
| 6d-v | checkpoint path through a symlinked dir escaping projectRoots ⇒ INVALID_PARAMS (escape wording) | 4/4 | PASS |
| 9 | scenario 2 complete (run path) | 1/1 | PASS |

## scenario 2 (`slice2-persistence-e2e`) — run path, SIGKILL variant

Checks: **103/103 passed**. Transcript: `evidence/scenario2/run-sigkill/transcript.jsonl` · sha256 manifest: `evidence/scenario2/run-sigkill/sha256s.txt`. Full per-check table: `evidence/scenario2/run-sigkill/assertions.md`.

| Step | Contract step | Checks | Result |
|---|---|---|---|
| 0 | doctor report is usable and complete | 8/8 | PASS |
| 1 | process A: create + import + edit + previewA at 2.5 s | 18/18 | PASS |
| 2 | process A: save checkpoint ⇒ ok; revision == revisionBefore; exact path; no .tmp siblings | 7/7 | PASS |
| 3 | process A killed entirely (SIGKILL) — checkpoint already complete and visible | 2/2 | PASS |
| 4a | third process: project_create then project_open ⇒ CONFLICT | 3/3 | PASS |
| 4b | process B: fresh session, empty ledger — project_open ⇒ adopted at revisionBefore; timeline deep-equals | 7/7 | PASS |
| 5a | process B: continue edit (expectedRevision == revisionBefore) ⇒ revision + 1 | 2/2 | PASS |
| 5b | process B: save to NEW path e2e-v2 ⇒ ok | 5/5 | PASS |
| 5c | process B: save back onto v1 without overwrite ⇒ CONFLICT (default no-overwrite) | 2/2 | PASS |
| 6a | process B: pixels — previewB renders the pre-restart content | 6/6 | PASS |
| 6b | process B: compare similar previewB vs previewA — pixel continuity across the restart | 3/3 | PASS |
| 8a | process B export_start ⇒ queued | 3/3 | PASS |
| 8b | process B export reached terminal done | 3/3 | PASS |
| 6c | process B: full verify battery of scenario 1 step 9 incl. compare-similar vs its own preview | 11/11 | PASS |
| 6d-i | byte flip inside project ⇒ integrity refusal (stateSha256 mismatch) | 4/4 | PASS |
| 6d-ii | formatVersion 999 ⇒ UNSUPPORTED (unknown-version wording) | 4/4 | PASS |
| 6d-iii | mediaRefs path diverging from originalUrl (hash recomputed) ⇒ binding refusal naming step 5 | 4/4 | PASS |
| 6d-iii-2 | binding refusal names the offending mediaId | 1/1 | PASS |
| 6d-iv | referenced media renamed away ⇒ open refuses, details naming the mediaId | 4/4 | PASS |
| 6d-iv-2 | media-moved refusal names the offending mediaId | 1/1 | PASS |
| 6d-v | checkpoint path through a symlinked dir escaping projectRoots ⇒ INVALID_PARAMS (escape wording) | 4/4 | PASS |
| 9 | scenario 2 complete (run path) | 1/1 | PASS |

## scenario 2 (`slice2-persistence-e2e`) — mcp path, SIGTERM variant

Checks: **97/97 passed**. Transcript: `evidence/scenario2/mcp-sigterm/transcript.jsonl` · sha256 manifest: `evidence/scenario2/mcp-sigterm/sha256s.txt`. Full per-check table: `evidence/scenario2/mcp-sigterm/assertions.md`.

| Step | Contract step | Checks | Result |
|---|---|---|---|
| 0 | doctor report is usable and complete | 8/8 | PASS |
| 1 | process A: create + import + edit + previewA at 2.5 s | 18/18 | PASS |
| 2 | process A: save checkpoint ⇒ ok; revision == revisionBefore; exact path; no .tmp siblings | 7/7 | PASS |
| 3 | process A killed entirely (SIGTERM) — checkpoint already complete and visible | 2/2 | PASS |
| 4a | third process: project_create then project_open ⇒ CONFLICT | 2/2 | PASS |
| 4b | process B: fresh session, empty ledger — project_open ⇒ adopted at revisionBefore; timeline deep-equals | 7/7 | PASS |
| 5a | process B: continue edit (expectedRevision == revisionBefore) ⇒ revision + 1 | 2/2 | PASS |
| 5b | process B: save to NEW path e2e-v2 ⇒ ok | 5/5 | PASS |
| 5c | process B: save back onto v1 without overwrite ⇒ CONFLICT (default no-overwrite) | 2/2 | PASS |
| 6a | process B: pixels — previewB renders the pre-restart content | 6/6 | PASS |
| 8 | process B export_start ⇒ queued → terminal done (poll 2.5 s) | 6/6 | PASS |
| 6b | process B: compare similar previewB vs previewA — pixel continuity across the restart | 3/3 | PASS |
| 6c | process B: full verify battery of scenario 1 step 9 incl. compare-similar vs its own preview | 11/11 | PASS |
| 6d-i | byte flip inside project ⇒ integrity refusal (stateSha256 mismatch) | 3/3 | PASS |
| 6d-ii | formatVersion 999 ⇒ UNSUPPORTED (unknown-version wording) | 3/3 | PASS |
| 6d-iii | mediaRefs path diverging from originalUrl (hash recomputed) ⇒ binding refusal naming step 5 | 3/3 | PASS |
| 6d-iii-2 | binding refusal names the offending mediaId | 1/1 | PASS |
| 6d-iv | referenced media renamed away ⇒ open refuses, details naming the mediaId | 3/3 | PASS |
| 6d-iv-2 | media-moved refusal names the offending mediaId | 1/1 | PASS |
| 6d-v | checkpoint path through a symlinked dir escaping projectRoots ⇒ INVALID_PARAMS (escape wording) | 3/3 | PASS |
| 9 | scenario 2 complete (mcp path) | 1/1 | PASS |

## scenario 2 (`slice2-persistence-e2e`) — mcp path, SIGKILL variant

Checks: **97/97 passed**. Transcript: `evidence/scenario2/mcp-sigkill/transcript.jsonl` · sha256 manifest: `evidence/scenario2/mcp-sigkill/sha256s.txt`. Full per-check table: `evidence/scenario2/mcp-sigkill/assertions.md`.

| Step | Contract step | Checks | Result |
|---|---|---|---|
| 0 | doctor report is usable and complete | 8/8 | PASS |
| 1 | process A: create + import + edit + previewA at 2.5 s | 18/18 | PASS |
| 2 | process A: save checkpoint ⇒ ok; revision == revisionBefore; exact path; no .tmp siblings | 7/7 | PASS |
| 3 | process A killed entirely (SIGKILL) — checkpoint already complete and visible | 2/2 | PASS |
| 4a | third process: project_create then project_open ⇒ CONFLICT | 2/2 | PASS |
| 4b | process B: fresh session, empty ledger — project_open ⇒ adopted at revisionBefore; timeline deep-equals | 7/7 | PASS |
| 5a | process B: continue edit (expectedRevision == revisionBefore) ⇒ revision + 1 | 2/2 | PASS |
| 5b | process B: save to NEW path e2e-v2 ⇒ ok | 5/5 | PASS |
| 5c | process B: save back onto v1 without overwrite ⇒ CONFLICT (default no-overwrite) | 2/2 | PASS |
| 6a | process B: pixels — previewB renders the pre-restart content | 6/6 | PASS |
| 8 | process B export_start ⇒ queued → terminal done (poll 2.5 s) | 6/6 | PASS |
| 6b | process B: compare similar previewB vs previewA — pixel continuity across the restart | 3/3 | PASS |
| 6c | process B: full verify battery of scenario 1 step 9 incl. compare-similar vs its own preview | 11/11 | PASS |
| 6d-i | byte flip inside project ⇒ integrity refusal (stateSha256 mismatch) | 3/3 | PASS |
| 6d-ii | formatVersion 999 ⇒ UNSUPPORTED (unknown-version wording) | 3/3 | PASS |
| 6d-iii | mediaRefs path diverging from originalUrl (hash recomputed) ⇒ binding refusal naming step 5 | 3/3 | PASS |
| 6d-iii-2 | binding refusal names the offending mediaId | 1/1 | PASS |
| 6d-iv | referenced media renamed away ⇒ open refuses, details naming the mediaId | 3/3 | PASS |
| 6d-iv-2 | media-moved refusal names the offending mediaId | 1/1 | PASS |
| 6d-v | checkpoint path through a symlinked dir escaping projectRoots ⇒ INVALID_PARAMS (escape wording) | 3/3 | PASS |
| 9 | scenario 2 complete (mcp path) | 1/1 | PASS |

## Findings against frozen product code (documented deviations)

Two issues in FROZEN product code (facade/runtime — not modifiable by slice 2d) forced two documented deviations from the Appendix D letter. Full reproductions and transcripts: [`evidence/findings/FINDINGS.md`](evidence/findings/FINDINGS.md).

1. **Export jobs fail deterministically once the MP4 exceeds mediabunny's 4 MiB StreamTarget chunk size** (`PartFileWriter.bytes` counts rewritten chunk overlap; the facade's honest byte guard then rejects the file — `provider wrote fewer bytes (…−8) than it reported (…)`). *Deviation:* the evidence runs pass the agent-legal `settings.videoBitrateKbps: 4000` (Appendix D does not pin bitrate) so the export stays single-chunk; every other step-9 assertion (1920×1080, h264, `frameCount == 150`, both pixel compares) is unchanged. Failing transcripts at default bitrate are committed under `evidence/findings/finding1-export-overcount/`.

2. **Appendix D's `durationToleranceSec: 1/30` is unachievable in this runtime** — every export muxes a silent AAC track (video tracks always count as audio carriers; the closed op set has no mute), and `verify_artifact` probes the container duration, which lands at ~5.077 s. *Deviation:* the E2E asserts the ADR's load-bearing `probe.frameCount == 150` exactly, and uses the runtime's own documented `0.12` s "±1 frame + mux epsilon" tolerance for the container-duration check (same value the slice-1b suites use).

Both scenarios otherwise run COMPLETELY: every lettered step of Appendix D scenario 1 and scenario 2 (including all four honesty probes of scenario-1 step 6, both kill variants of scenario-2 step 3, and all five corruption probes of scenario-2 step 6d) is machine-checked over both paths, with the raw transcripts committed alongside.
