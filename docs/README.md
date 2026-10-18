# Documentation

## Product and usage

- [`PROJECT-ASSETS-FILTERS.md`](PROJECT-ASSETS-FILTERS.md) — project media types, save-point scope and SRT/VTT import.
- [`../README.md`](../README.md) — product overview and quick start.
- [`USER-GUIDE.md`](USER-GUIDE.md) — desktop onboarding, editor help, and save-versus-retain basics.
- [`AGENT-GUIDE.md`](AGENT-GUIDE.md) — connecting an external Agent.
- [`COMMAND-API.md`](COMMAND-API.md) — live command service and CLI contract.
- [`AGENT-WORKSPACE.md`](AGENT-WORKSPACE.md) — task files and media workspace.
- [`../SKILL.md`](../SKILL.md) — Agent workflow and command reference.

## System behavior

- [`product-scope.md`](product-scope.md) — product boundary and feature scope.
- [`design-principles.md`](design-principles.md) — current engineering principles.
- [`NAMING-AND-COMPATIBILITY.md`](NAMING-AND-COMPATIBILITY.md) — names and
  compatibility contracts.
- [`DATA-ROOT.md`](DATA-ROOT.md) — application data locations.
- [`COLOR.md`](COLOR.md) — color handling in preview and export.
- [`EXTERNAL-DEPENDENCIES.md`](EXTERNAL-DEPENDENCIES.md) — network destinations
  and data sent by the applications.
- [`CLOUD-VIDEO-REVIEW.md`](CLOUD-VIDEO-REVIEW.md) — opt-in cloud video review.
- [`MATERIAL-ANALYSIS.md`](MATERIAL-ANALYSIS.md) and
  [`MATERIAL-LIBRARY.md`](MATERIAL-LIBRARY.md) — material inspection and reuse.
- [`AUDIO-NORMALIZATION.md`](AUDIO-NORMALIZATION.md) — local two-pass loudness processing, remeasurement and explicit derived-asset registration.
- [`AUDIO-DENOISE.md`](AUDIO-DENOISE.md) — tiered local FFmpeg denoise, measured delay compensation, alignment verification and derived-asset lifecycle.
- [`AUDIO-SPEED.md`](AUDIO-SPEED.md) — audio speed behavior and rendering limits.
- [`MEDIA-REVIEW-WORKFLOWS.md`](MEDIA-REVIEW-WORKFLOWS.md) — reference comparison and media
  replacement workflows.
- [`PRODUCTION-MANAGEMENT.md`](PRODUCTION-MANAGEMENT.md) — source history, candidates, review tasks, and persistent analysis batches.
- [`MASK-PROPAGATION.md`](MASK-PROPAGATION.md) — local mask refinement and short patch propagation.
- [`../apps/desktop/RIGGING.md`](../apps/desktop/RIGGING.md) — optional Blender
  rigging backend: probing, invocation, and resource layout.
- [`build-chunking.md`](build-chunking.md) — production bundle boundaries.

## Versions and multi-project

- [`VERSION-NODES-UX.md`](VERSION-NODES-UX.md) — implemented interaction spec: compact node track, read-only version preview, explicit retention (save vs retain), adoption/deletion, and Agent-managed complexity; includes the acceptance checklist.
- [`INSPECTOR-VERSIONS-BOARD-UX.md`](INSPECTOR-VERSIONS-BOARD-UX.md) — current inspector implementation: on-demand archive tree and board panels, compact lineage, and read-only historical copy.
- [`MULTI-PROJECT-VERSIONING.md`](MULTI-PROJECT-VERSIONING.md) — multi-project workspaces, immutable version nodes, media retention, and real-use acceptance checklist; interaction defers to VERSION-NODES-UX.
- [`MULTI-PROJECT-USAGE.md`](MULTI-PROJECT-USAGE.md) — desktop version-track operations, save-versus-retain semantics, explicit CLI targets (`node.save`/`node.rename`/`node.restore`), and the external-evidence acceptance workflow.

## Distribution and attribution

- [`RELEASE-1.1.1.md`](RELEASE-1.1.1.md) — 1.1.1 change summary, local validation, and remaining release checks.
- [`ASSET-LICENSE-REVIEW.md`](ASSET-LICENSE-REVIEW.md) — review of artwork, fonts, and runtime model rights.
- [`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) — third-party code,
  assets, and optional sidecars.
- [`../apps/desktop/DISTRIBUTION.md`](../apps/desktop/DISTRIBUTION.md) — desktop
  packaging and release requirements.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — setup, checks, and pull requests.
- [`../SECURITY.md`](../SECURITY.md) — private security report instructions.

## Current planning

- [`AUDIO-TODO.md`](AUDIO-TODO.md) — current audio backlog, dependencies and acceptance criteria; planned features are not current capabilities.

## Historical acceptance records

- [`AUDIO-PIPELINE-EXECUTION-PLAN.md`](AUDIO-PIPELINE-EXECUTION-PLAN.md) — completed audio batches A–C plus the AUD-01–AUD-06 records (Silero VAD, record-driven ducking, domain-filtered schema/capabilities, silence cutting, beat-snapped splits), the AUD-08 denoise record and the AUD-10 sync-offset record, commits and validation evidence.

Dated records are kept as evidence and are not overwritten by newer rounds.
Treat them as history, not current specs; the current specs are the documents
above.

- [`NODE-UX-ACCEPTANCE-2026-10-09.md`](NODE-UX-ACCEPTANCE-2026-10-09.md) —
  independent user acceptance of the node UX round (overall: not passed at the
  time; preserved findings).
- [`NODE-UX-FIXES-2026-10-09.md`](NODE-UX-FIXES-2026-10-09.md) — fix and
  inspector implementation log responding to that acceptance round.
- [`NODE-UX-RECHECK-2026-10-09.md`](NODE-UX-RECHECK-2026-10-09.md) — follow-up
  independent recheck of the fixed package; latest conclusions at the end.
