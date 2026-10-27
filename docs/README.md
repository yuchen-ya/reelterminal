# Documentation

## Product and usage

- [RELEASE-NOTES-DRAFT.md](RELEASE-NOTES-DRAFT.md) — unpublished summary of the latest pushed changes and release checks.
- [RELEASE-1.3.6.md](RELEASE-1.3.6.md) — latest local Windows build record; [1.3.1](RELEASE-1.3.1.md), [1.3.2](RELEASE-1.3.2.md), [1.3.3](RELEASE-1.3.3.md), [1.3.4](RELEASE-1.3.4.md) and [1.3.5](RELEASE-1.3.5.md) document earlier builds and their individual validation limits.

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
- [`AUDIO-NORMALIZATION.md`](AUDIO-NORMALIZATION.md) — local two-pass loudness processing (up to 3600 s per range), offset audio-track mapping, remeasurement, explicit derived-asset registration, content-addressed reuse and staging cleanup.
- [`AUDIO-DENOISE.md`](AUDIO-DENOISE.md) — tiered local FFmpeg denoise, measured delay compensation, alignment verification and derived-asset lifecycle.
- [`AUDIO-TRANSCRIPT.md`](AUDIO-TRANSCRIPT.md) — optional local SenseVoice transcription, external-VAD timestamps, model consent and record-driven subtitle import.
- [`AUDIO-SEPARATION-DIARIZATION.md`](AUDIO-SEPARATION-DIARIZATION.md) — anonymous CAM++ speaker clustering and optional Demucs vocal/instrumental separation, timing and limits.
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

## AI material workbench

- [`REVIEW-WORKSPACE-FOUNDATION-DESIGN.md`](REVIEW-WORKSPACE-FOUNDATION-DESIGN.md) — independent Review Workspace design: storage/resources, dual CLI scopes, native export, processing-step comparisons and migration are implemented; optional assistant remains outside this delivery.
- [`REVIEW-WORKSPACE-FOUNDATION-TASKS.md`](REVIEW-WORKSPACE-FOUNDATION-TASKS.md) — P0–P7 execution packages and acceptance gates for that foundation design.
- [`AI-MATERIAL-WORKBENCH-DESIGN.md`](AI-MATERIAL-WORKBENCH-DESIGN.md) — batch decision processor for images, text, structured data and video; provenance references, reversible decisions and explicit Agent handoff.
- [`AI-MATERIAL-WORKBENCH-INTERACTION.md`](AI-MATERIAL-WORKBENCH-INTERACTION.md) — confirmed interaction direction: existing ReelTerminal shell, pending/processed queues, lightweight edits, source-tag references and batch handoff; includes Figma prototype links and simulation limits.
- [`AI-MATERIAL-WORKBENCH-INTEGRATION.md`](AI-MATERIAL-WORKBENCH-INTEGRATION.md) — source-based integration audit of the user's React prototype: reusable components, host container changes, dependency adaptation, mock-to-production gaps and staged acceptance.
- [`AI-MATERIAL-WORKBENCH-ROUND2.md`](AI-MATERIAL-WORKBENCH-ROUND2.md) — second-round frontend restoration plan: prototype layout, empty states, editable issue panels and visual/behavioral acceptance.
- [`AI-MATERIAL-WORKBENCH-ROUND2-DELIVERY.md`](AI-MATERIAL-WORKBENCH-ROUND2-DELIVERY.md) — second-round delivery record: prototype→previous→fixed diff, paired real screenshots, measurements, real-media closure, test commands/results and open limits.
- [`AI-MATERIAL-WORKBENCH-ROUND3-DESIGN.md`](AI-MATERIAL-WORKBENCH-ROUND3-DESIGN.md) — design for the remaining work: GUI batch creation, feedback/undo consistency, data rework, handoff readback, repaired-image display and the R5 verification closure.
- [`AI-MATERIAL-WORKBENCH-ROUND3-C-DELIVERY.md`](AI-MATERIAL-WORKBENCH-ROUND3-C-DELIVERY.md) — round-3 batch C delivery: atomic issue save, versioned feedback identity, per-issue readback, tag-reference preservation and text-range verification, with unit/GUI evidence and remaining limits.
- [`AI-MATERIAL-WORKBENCH-ROUND3-BF-DELIVERY.md`](AI-MATERIAL-WORKBENCH-ROUND3-BF-DELIVERY.md) — round-3 batch B+F delivery: local media batch creation, pending/processed usage, repaired/original/draft separation, explicit repair base, window/zoom/drop-point/reopen evidence and limits.
- [`AI-MATERIAL-WORKBENCH-NEXT-BATCH.md`](AI-MATERIAL-WORKBENCH-NEXT-BATCH.md) — N1–N4 execution plan: visible-scope/rework correctness, data per-cell rework, execution-level handoff/readback and verification closure.
- [`AI-MATERIAL-WORKBENCH-ROUND3-D1E-DELIVERY.md`](AI-MATERIAL-WORKBENCH-ROUND3-D1E-DELIVERY.md) — round-3 N1 fix + D1/E delivery: visible-scope cursor, version-safe data drafts, appended text rework, handoff-bound rework, multi-cell rework badges, immutable execution snapshots, partial returns, member-scoped supersede, real GUI evidence and remaining A7/DPI limits.
- [`AI-MATERIAL-WORKBENCH-ROUND2-PROMPT.md`](AI-MATERIAL-WORKBENCH-ROUND2-PROMPT.md) — execution handoff prompt for the second round.
- [`AI-MATERIAL-WORKBENCH-TASKS.md`](AI-MATERIAL-WORKBENCH-TASKS.md) — implementation checklist with per-task acceptance evidence; first version implemented 2026-10-21 (real-device items remain open).
- [`AI-MATERIAL-WORKBENCH-RESEARCH.md`](AI-MATERIAL-WORKBENCH-RESEARCH.md) — official documentation and pinned-source research on Krita AI Diffusion, ComfyUI, Label Studio, CVAT and pressure-sensitive drawing; reuse decisions and limits.

- [`REVIEW-WORKSPACE-FOUNDATION-DELIVERY.md`](REVIEW-WORKSPACE-FOUNDATION-DELIVERY.md) — foundation implementation and isolated acceptance evidence.
- [`AI-MATERIAL-WORKBENCH-ACCEPTANCE-HOTFIX.md`](AI-MATERIAL-WORKBENCH-ACCEPTANCE-HOTFIX.md) — acceptance fixes and historical verification limits.
- [`REVIEW-3D-PREVIEW-DESIGN.md`](REVIEW-3D-PREVIEW-DESIGN.md) and [`REVIEW-3D-PREVIEW-DELIVERY.md`](REVIEW-3D-PREVIEW-DELIVERY.md) — GLB observation, snapshots, rework and delivery evidence.
- [`REVIEW-AUDIT-FIX-ROUND1.md`](REVIEW-AUDIT-FIX-ROUND1.md), [`REVIEW-AUDIT-REMAINING.md`](REVIEW-AUDIT-REMAINING.md) and [`REVIEW-AUDIT-VERIFICATION.md`](REVIEW-AUDIT-VERIFICATION.md) — audit fixes, independent verification and remaining manual acceptance boundaries.

Delivery and round records remain at their active linked paths as historical evidence; current behavior is described by the implementation and current contract.

## Distribution and attribution

- [`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) — third-party code,
  assets, and optional sidecars.
- [`../apps/desktop/DISTRIBUTION.md`](../apps/desktop/DISTRIBUTION.md) — desktop
  packaging and release requirements.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — setup, checks, and pull requests.
- [`../SECURITY.md`](../SECURITY.md) — private security report instructions.

## Archive

- [`archive/README.md`](archive/README.md) — completed execution records, dated
  acceptance and evaluation evidence, and retired plans (including the fully
  implemented audio backlog; nothing is currently planned).

Dated records are kept as evidence and are not overwritten by newer rounds.
Treat them as history, not current specs; the current specs are the documents
above.
