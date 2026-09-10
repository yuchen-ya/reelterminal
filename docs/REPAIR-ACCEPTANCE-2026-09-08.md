# Combined material library and P0–P2 repair acceptance

This follow-up repairs the combined delivery, preserving the pre-existing implementation and user projects. It does not recreate or publish media. Tests use isolated desktop user data, endpoints and temporary media.

## Problems corrected

- Reference comparison controls previously changed canonical configuration without drawing the requested comparison. The panel now mirrors the canonical preview canvas alongside the reference or underneath its opacity-controlled overlay. The reference clock follows scrubs and playback drift, holds at range boundaries, and respects the selected audio side and global mute. Users can choose reference media and edit the mapping in the GUI.
- Live `media.replace` previously imported metadata without loading or persisting replacement bytes. The renderer now prepares all new media bytes before the single action-batch commit, checks project/context again, and discards prepared blobs on failure. Undo/redo retain the same media identities and durable bytes.
- Replacement idempotency previously hashed enriched operations containing newly generated media IDs. Both facade modes now check replay against validated caller operations before filesystem enrichment. A committed replacement can replay even if its source file is subsequently unavailable.
- `edit.validate` reports per-clip replacement effects, including source changes, shortened duration and vacated timeline ranges. Constant-speed shortening respects playback speed. Shortening clips with speed ramps or freeze frames is rejected until the caller explicitly trims them; equal-duration replacement preserves their edits.
- Library segment attach imports media and creates its clip in one canonical project history group. Core clip creation pins its generated ID into the history action so redo preserves the attachment identity. Library provenance is distinct from project-local replacement lineage. Usage reconciliation tracks current/historical references after replacement, undo, redo and project recovery.
- Saved analysis has a desktop browsing and recheck surface. The job captures project identity at start, and opening the panel refreshes records created since the panel mounted. Observations, inferences and suggestions remain distinct. Source timestamps map to supported timeline occurrences; unsupported variable-speed inversions are not guessed. Local recheck never requests cloud upload. Each cloud recheck requires its own explicit GUI consent.
- Inspection evidence is published without replacing an existing path. File-content identity and source-change checks protect request keys; incomplete color metadata no longer claims supported SDR.

## Transaction boundaries

Media bytes are persisted before the canonical project commit; failed preparation or validation leaves no project edit. The material library and project use separate databases. Library usage is derived, retryable provenance, not an atomic transaction spanning both databases. Reconciliation repairs a missed derived update from the canonical project snapshot.

`materialSource` identifies an actual library attachment. `versionSource` records a project replacement and its predecessor without falsely identifying the generated replacement as the old library material. Ambiguous path matches or multiple successors do not invent a unique library relationship.

## Reproducible checks

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm --filter @openreel/desktop build`
- `pnpm --filter @openreel/desktop exec vitest run --config e2e/vitest.config.ts e2e/repair-integration.e2e.ts`

The desktop suite drives real GUI controls and the real loopback MCP connector. It covers comparison interaction, live replacement validation/CAS/replay/undo/redo, compound library attach and usage changes, local analysis GUI recheck, and replacement-byte recovery after a full application restart. Technical acceptance does not evaluate artistic fidelity.

## Observed results

- Full workspace `pnpm test`: passed, including adapter tests. Subsequent fixes were rechecked with the affected suites below.
- Final core suite: 1,270 passed, 20 skipped.
- Facade full suite: 748 passed, 1 skipped; the added project-identity regression was also rerun by the analysis implementation task with the live-session suite.
- Final affected web suites: 72 passed across 8 files.
- Chromium comparison/color suites: 7 passed.
- Final real Electron + loopback integration: all 5 scenarios passed, including library replacement/undo and local analysis GUI recheck.
- Full workspace typecheck and desktop build: passed. Workspace lint completed with zero errors (warnings remain).
- No changes were committed or published. Test fixtures and desktop profiles were isolated from user projects.
