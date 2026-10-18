import { PLUGIN_TOOLS } from "./plugins";
import { MAX_TIMELINE_SOURCE_MAP_POINTS } from "./timeline-source-map";
import type { FacadeVerb } from "./types";

const HEADLESS_DESCRIPTIONS: Readonly<Record<string, string>> = {
  session_describe:
    "Describe the facade session: contract, runtime, and live access/writer state when applicable.",
  capabilities_get:
    "Report live provider capabilities and the recommended Agent workspace root/layout, with honest reasons when unavailable. An optional domain param (audio, video, frames, motion, render, export) scopes probing to that domain; other probe-backed statuses are reported as not-probed, never available.",
  project_create:
    "Create this session's single project (single-initialization lifecycle verb).",
  project_open:
    "Open a checkpoint file into this session's empty project slot (single-initialization lifecycle verb).",
  project_save:
    "Save the active project to a checkpoint file (a snapshot, not a mutation).",
  project_list: "List persisted project identities and their default workspaces.",
  workspace_list: "List workspaces belonging to one explicit project.",
  workspace_create: "Create a workspace from an explicit project, node, or workspace source.",
  workspace_delete: "Delete one non-default workspace after an expected-revision check.",
  workspace_close: "Release one workspace runtime while retaining its saved draft and nodes.",
  workspace_switch_view: "Show an existing project workspace in the GUI without changing its data revision.",
  workspace_list_drafts: "List recoverable drafts retained for one explicit workspace.",
  workspace_recover_draft: "Recover one protected draft into its explicit workspace with revision and idempotency guards.",
  node_list: "List immutable saved nodes for one project.",
  node_get: "Read the complete immutable snapshot for one saved node.",
  node_save: "Save the explicit workspace as an immutable node; a matching retry returns the same node.",
  node_restore: "Restore an immutable node into an explicit workspace after protecting its dirty draft.",
  node_rename: "Rename one immutable node's display metadata in place; snapshots, ids and parentage never change.",
  node_media: "List the saved media dependencies of one immutable node and report missing dependencies.",
  node_compare: "Compare two immutable nodes by added, replaced, and removed media IDs.",
  media_references: "Show which saved nodes, workspace drafts, and tasks retain a media version.",
  media_cleanup_plan: "Plan safe removal of unreferenced controlled media and report file sizes and reasons.",
  media_cleanup_execute: "Recheck and execute one previously returned media cleanup plan.",
  project_rename:
    "Rename the active project with revision and idempotency guards; never renames an existing checkpoint path.",
  project_get_state:
    "Return the full canonical project state at the current revision.",
  requirements_list:
    "List project requirement summaries at one revision without transferring media caches.",
  requirements_get:
    "Read one project requirement by Q reference or internal id at one revision.",
  project_changes:
    "Return a bounded, paged structural delta since a project revision, or require a full refresh when history was evicted.",
  media_import:
    "Import a local media file from a configured media root into the project.",
  audio_process_normalize:
    "Start a local two-pass FFmpeg loudnorm job for one imported mediaId, audioStream, and source startSec/endSec range (at most 120 seconds). targetLufs, truePeakDbtp, loudnessRangeLu, sampleRate:48000, and channels:1|2 are required; the job reports fresh post-render measurements. Poll job.status and call audio.process.register only after the job is done; an idempotencyKey replays the same job.",
  audio_process_denoise:
    "Start a local tiered FFmpeg denoise job for one imported mediaId, audioStream, and source startSec/endSec range (at most 120 seconds). sampleRate:48000, channels:1|2, profile:'light'|'strong' are required; optional declick. The exact chain's fixed delay is measured, trimmed and verified against the source, so the published WAV is sample-aligned; loudness is remeasured. Dynamic processing and loudness normalization are separate verbs. Poll job.status, then audio.process.register; an idempotencyKey replays the same job.",
  audio_process_register:
    "Register a completed audio-process job's persistent generated audio file through the normal media import path, guarded by expectedRevision. Registration is idempotent by jobId and does not replace clips or remove the source media.",
  media_render_html:
    "Render constrained local HTML/CSS to a transparent-capable PNG artifact inside the media roots (needs the local playwright Chromium); output flows to media.import by path. Scripts, frames, event handlers and network references are rejected; relative assets resolve only inside assetsRoot; blocked/missing assets are listed, not failed.",
  media_analyze_start:
    "Start an asynchronous analysis job for an imported media item; unavailable analysis types fail honestly before a job is created. Audio analysis requires artifactRoot to persist complete details. Poll job.status for a compact audio summary and analysisRecord.id, then use analysis.get for explicit event pages or waveform samples.",
  timeline_get: "Return the compact timeline view (tracks, clips, text overlays).",
  timeline_query:
    "Query a bounded timeline slice by namespaced refs, ids, time range, track/entity types, and allowlisted fields.",
  timeline_mapSourceTimes:
    `Map 1–${MAX_TIMELINE_SOURCE_MAP_POINTS} explicit absolute timeline times for one clip through Core's playback-speed and freeze evaluator. Returns the snapshot revision, clip-local seconds, source-relative seconds, absolute source-media seconds (inPoint + relative), and freeze status. Points must lie within the clip; no source-to-timeline inverse is provided.`,
  editor_get_context:
    "Return editor context (selection, playhead, time range, canvas point); headless sessions answer honestly with contextAvailable:false.",
  editor_control:
    "Control ephemeral live-editor UI state: play, pause, seek, or select/reveal clip, text, or media targets without changing project revision or undo history.",
  edit_validate:
    "Dry-run edit.apply ops (top-level input omits idempotencyKey) without side effects and report conflicts, warnings, and estimated impact.",
  edit_apply:
    "Apply an atomic batch of closed edit ops to the project. clip.setSpeedConfig replaces speed, reverse, pitch correction, source-relative keyframes and freeze frames together; speed is [0.1, 20], keyframe.time/freeze.sourceTime are source seconds from inPoint, and freeze.startTime includes earlier freeze durations. When keyframes exist they replace base speed; the curve integrates in ascending source-relative time, then reverse reflects the resulting offset across the source span. freeze.sourceTime stays literal under reverse, and easing overshoot clamps to [0.1, 20]. clip.split and clip.trim reject speed-ramped or frozen clips; ReviewRange requires forward constant speed. clip.setDuckingFromAnalysis (AUD-02) drives clip.setDucking from a speechActivity analysis record: speech regions are mapped through the speech clip's placement/trim/speed curve/reverse/freeze timing (shared core SpeedEngine) onto the ducked clip before the mutation starts; stale records, wrong-media or wrong-audio-stream records and no-overlap placements are rejected, and an existing volume envelope needs existingEnvelope:\"replace\". clip.cutSilenceFromAnalysis (AUD-05) cuts a clip's silences from a silence analysis record as one undo unit: regions below minSilenceSec stay as pauses, paddingSec keeps both cut edges, fadeSec protects cut points, aligned timing-identical A/V siblings are cut together, ripple shifts later clips on each affected track only; speed curves, freeze frames, non-zero audioTrackIndex, desyncing subtitles and too many regions are rejected before any mutation. clip.splitAtBeat snaps a desired cut point to the nearest beatGrid beat within an explicit maxShiftSec and applies as clip.split in the same batch; requests with no beat inside the allowed movement are rejected honestly.",
  history_get:
    "Return bounded undo/redo availability and summaries from the canonical editor history.",
  history_control:
    "Execute undo or redo through the canonical live GUI/Core history path with revision and idempotency guards.",
  preview_render_frame:
    "Render one frame of the project to a PNG artifact and return its artifact reference.",
  preview_render_comparison:
    "Render one reference-comparison inspection still: left the decoded reference frame at the MAPPED time, right the canonical timeline render — or a blended overlay. Requires the shared reference.setComparison config; the response discloses the mapping (referenceSec, clamped) and limitations.",
  visual_inspect:
    "Sample 1–12 real frames for a clip or time range; each frame is fitted into a per-frame byte budget (default 1.5 MiB, maxFrameBytes tunes it) — lossless PNG when it fits, otherwise a JPEG quality/width ladder — with per-frame fidelity metadata plus a contact sheet when supported.",
  export_start:
    "Start an export job for a snapshot of the current project; returns a jobId immediately.",
  job_status: "Return the current status of an export, media-analysis, or audio-processing job. Completed analysis results contain scalar summaries, counts and analysisRecord.id; audio-process results contain the generated path, provenance, applied parameters, source range, sample timing, and before/after measurements.",
  job_cancel: "Request cooperative cancellation of an export, media-analysis, or audio-processing job (idempotent on terminal jobs).",
  verify_artifact:
    "Verify an artifact with ffprobe/pixel checks and return the report as data.",
  analysis_list:
    "List durable analysis records (newest first): subject media, analysis types, staleness and recheck linkage. Filter by mediaId.",
  analysis_get:
    "Read a durable analysis record. Defaults to compact summary; audio event arrays and waveform bins are omitted. Use view:'events' with one of audioSummary.onsets, audioSummary.silence, silence.silentRegions, beatGrid.beats, or speechActivity.speechRegions for a half-open source-time window and bounded pages (limit ≤256, default 100); pass the returned cursor unchanged to continue. Use view:'waveform' for a bounded source window (maxPoints ≤600, default 150). Summary includes per-series stored/total counts and completeness; historical truncation is disclosed. Metadata, provenance, unknowns, recheck configuration, and staleness remain available.",
  material_list:
    "Unavailable headless — the user-level material library lives in the desktop GUI renderer.",
  material_get:
    "Unavailable headless — the user-level material library lives in the desktop GUI renderer.",
  material_create:
    "Unavailable headless — the user-level material library lives in the desktop GUI renderer.",
  material_update:
    "Unavailable headless — the user-level material library lives in the desktop GUI renderer.",
  material_batch_update:
    "Unavailable headless — the user-level material library lives in the desktop GUI renderer.",
  material_remove:
    "Unavailable headless — the user-level material library lives in the desktop GUI renderer.",
  material_attach:
    "Unavailable headless — the user-level material library lives in the desktop GUI renderer.",
  material_undo:
    "Unavailable headless — the user-level material library lives in the desktop GUI renderer.",
  font_upload:
    "Unavailable headless — custom fonts live in the desktop GUI renderer's font store.",
  font_list:
    "Unavailable headless — custom fonts live in the desktop GUI renderer's font store.",
  preset_list:
    "Unavailable headless — user-level presets live in the desktop GUI renderer.",
  preset_get:
    "Unavailable headless — user-level presets live in the desktop GUI renderer.",
  preset_create:
    "Unavailable headless — user-level presets live in the desktop GUI renderer.",
  preset_update:
    "Unavailable headless — user-level presets live in the desktop GUI renderer.",
  preset_remove:
    "Unavailable headless — user-level presets live in the desktop GUI renderer.",
  preset_apply:
    "Unavailable headless — user-level presets live in the desktop GUI renderer.",
  help_list_screens:
    "List the shipped GUI manual's screen index: id, zh/en title and one-line summary per screen, plus the manual's content version, bound app version, and languages. Static data — available in every mode.",
  help_describe:
    "Return ONE GUI screen's manual page: entry path, visibility condition, common steps, keyboard-shortcut references (ids; live bindings live in Settings → Shortcuts), and honest limitations. Screenshots are reserved and reported as pending until delivered. Static data — available in every mode.",
  help_search:
    "Search the shipped GUI manual by a zh/en keyword matched over titles, summaries, entries, steps, limitations, shortcut ids and keywords; returns restrained hits (id + title + summary), never full page bodies. Static data — available in every mode.",
};

const LIVE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "project.list": "List persisted project identities and their default workspace IDs without changing the current GUI view.",
  "workspace.list": "List the workspaces belonging to an explicit projectId.",
  "workspace.create": "Create a workspace from an explicit project and optional node/workspace source; this does not change the GUI view.",
  "workspace.delete": "Delete an explicit non-default workspace with expectedRevision and optional idempotencyKey.",
  "workspace.close": "Release the runtime for an explicit workspace; its persisted draft and nodes remain available.",
  "workspace.switch_view": "Explicitly show an existing workspace in the GUI. This is a view operation and does not change its data revision.",
  "workspace.list_drafts": "List recoverable drafts for one explicit project/workspace.",
  "workspace.recover_draft": "Recover a protected draft into its explicit project/workspace with expectedRevision and idempotencyKey.",
  "node.list": "List immutable saved nodes for one explicit project.",
  "node.get": "Read the complete immutable snapshot for one saved node.",
  "node.save": "Save one explicit workspace as an immutable node with expectedRevision and persistent idempotencyKey.",
  "node.restore": "Restore one immutable node into an explicit workspace after protecting its dirty draft.",
  "node.rename": "Rename one immutable node's display name (and optional summary) in place; the snapshot, ids and parentage never change and no new version is created.",
  "node.media": "List media saved by one immutable node and disclose missing dependencies.",
  "node.compare": "Compare two immutable nodes and return added, replaced, and removed media IDs.",
  "media.references": "Query the retained-reference roots for one media version.",
  "media.cleanup.plan": "Build a bounded cleanup plan for unreferenced controlled media; execution rechecks references.",
  "media.cleanup.execute": "Recheck and execute a prior cleanup plan by planId.",
  "session.describe":
    "Describe this live collaboration session: runtime, independent access/writer state, available commands, and error codes.",
  "capabilities.get":
    "Report live provider capabilities (preview, visual inspection, export, verify) with honest reasons when unavailable. An optional domain param (audio, video, frames, motion, render, export) scopes probing to that domain; other probe-backed statuses are reported as not-probed, never available.",
  "project.create":
    "Create a durable project with its default workspace without switching the GUI view. Use the returned projectId/defaultWorkspaceId for subsequent explicit target commands.",
  "project.open":
    "Unavailable in live mode — the GUI owns the project lifecycle; a live session attaches to the open project.",
  "project.save":
    "Save the explicit target workspace as a new immutable project node. Supply projectId, workspaceId, expectedRevision, and a persistent idempotencyKey; this does not change the GUI view.",
  "project.rename":
    "Rename the explicitly targeted project through its canonical undoable action. Supply projectId, workspaceId, and expectedRevision; this changes the display name, never an existing file path.",
  "project.get_state":
    "Return the full canonical project state for the explicit project/workspace target.",
  "requirements.list":
    "List requirement summaries for an explicit project/workspace, optionally filtered by status. Returns revision without transferring the full project.",
  "requirements.get":
    "Read one requirement by requirementId (Q reference or internal id) in an explicit project/workspace. Returns the requirement and its snapshot revision.",
  "project.changes":
    "Return bounded structural changes for the explicit project/workspace target since a revision, or require a full refresh when retained history is unavailable.",
  "media.import":
    "Import a local video, audio, or image file into the explicit project/workspace. Supply projectId, workspaceId, expectedRevision, and an absolute path under capabilities_get.mediaImport.mediaRoots; the import is undoable in the GUI when that workspace is foreground.",
  "audio.process.normalize":
    "Start a local two-pass FFmpeg loudnorm job for an imported mediaId, explicit audioStream and source startSec/endSec range (at most 120 seconds), with targetLufs, truePeakDbtp, loudnessRangeLu, sampleRate:48000, and channels:1|2 all explicit. The job snapshots the target project/workspace revision, publishes a persistent generated file only after successful processing, remeasures output loudness, and records the source range, sample timing and applied settings. Poll job.status and register the completed artifact with audio.process.register; the source media and timeline clips remain untouched. Retries with the same idempotencyKey replay the same job.",
  "audio.process.denoise":
    "Start a local tiered FFmpeg denoise job for an imported mediaId, explicit audioStream and source startSec/endSec range (at most 120 seconds), with sampleRate:48000, channels:1|2, profile:'light'|'strong' and optional declick. light is afftdn nr=12/nf=-25 for steady low-level noise; strong is afftdn nr=24/nf=-35. Dynamic processing (de-esser/compressor/EQ) is deliberately NOT included — the 2026-10-18 audit measured SI-SDR degradation and loudness normalization keeps its own verb. The exact chain's fixed delay (1200 samples at 48 kHz for afftdn/adeclick) is measured with a deterministic probe, trimmed and tail-padded, the published sample count is re-verified, and the output is cross-correlated against the source; an unverified alignment is disclosed instead of claimed. The job publishes a persistent 48 kHz PCM WAV, remeasures loudness, and leaves the source/clips untouched. Poll job.status, then register the completed artifact with audio.process.register. Retries with the same idempotencyKey replay the same job.",
  "audio.process.register":
    "Register one completed audio-process job into the explicit project/workspace through the standard media import path. Supply jobId and required expectedRevision; the job's generated file is imported idempotently, and no clip is inserted or replaced.",
  "media.render_html":
    "Render constrained local HTML/CSS markup to a PNG file under the media roots (default <mediaRoots[0]>/jobs/html-render/<requestKey>/), then media.import that path to put it on the timeline. source is {kind:'path',path} (an .html file inside a media root) or {kind:'inline',html} (raw markup ≤512 KiB). width/height are even integers in [2,4096]; transparent defaults to true; timeoutMs defaults to 30000 (≤120000). Scripts, iframe/object/embed, event handlers, javascript:/non-image data: URIs and network references (http(s), file, protocol-relative, srcset, CSS url(http)/@import/@font-face url(http)) are rejected; local subresources resolve only inside assetsRoot and remote/missing ones are aborted and returned in missingAssets — the render still succeeds. Requires this machine's playwright Chromium (same supply as preview) and a configured media root; transparent PNGs composite cleanly over the timeline. Changes no project state — import the returned path afterwards.",
  "media.analyze_start":
    "Start a read-only asynchronous analysis job. videoReview sends an explicit <=20s source range to the selected cloud provider (default Alibaba qwen3.5-omni-flash via DASHSCOPE_API_KEY; REELTERMINAL_VIDEO_REVIEW_PROVIDER selects the provider), requires artifactRoot and cloudUpload:true; optional reviewQuestion (<=1000 chars). The bounded inspection copy is transcoded once and cached (source fingerprint + range keyed); each review still uploads once. Returns fallible cloud opinions, not acceptance; no automatic retry. audioSummary uses local FFmpeg for LUFS, true peak, waveforms, silence and onset/periodicity candidates with explicit source startSec/endSec (max 120s), without listening or editing. speechActivity runs local Silero VAD v5.1.2 (onnxruntime-node, model downloaded on first use from the pinned GitHub tag, or REELTERMINAL_VAD_MODEL) and returns speech regions with 32 ms boundary granularity; it is acoustic inference, not semantics, and non-speech gaps are not automatically deletable — tune with vadParams. syncOffset correlates the target range against an explicit reference media (syncOffsetParams.referenceMediaId) with local GCC-PHAT: positive offsetSec means the target lags the reference, only a >=6 dB peak prominence and >=3 dB second-peak margin report verdict ok, ambiguous/no-match are honest refusals, and clock drift is reported (driftPpm) but never silently corrected. audioSummary/silence/beatGrid/speechActivity/syncOffset require artifactRoot and persist complete audio details; job.status returns a compact audio summary and analysisRecord.id, then analysis.get reads explicit event pages or waveform samples. capabilities_get reports each analysis type honestly.",
  "timeline.get":
    "Return the compact timeline view (tracks, clips, text overlays) at the current revision. Persisted review markers use namespaced ids R1, R2, and so on.",
  "timeline.query":
    "Query a bounded local timeline slice by @A/R refs, ids, time, track/entity type, and allowlisted fields without dumping the full project.",
  "timeline.mapSourceTimes":
    `Map 1–${MAX_TIMELINE_SOURCE_MAP_POINTS} explicit absolute timeline times for one clip through Core's playback-speed and freeze evaluator. Returns the snapshot revision, clip-local seconds, source-relative seconds, absolute source-media seconds (inPoint + relative), and freeze status. Points must lie within the clip; this does not infer an interval or map source time back to timeline time.`,
  "editor.get_context":
    "Return live editor context: selection, playhead, time range, canvas point, namespaced Agent references A1/A2, and project/context revisions.",
  "editor.control":
    "Control ephemeral live-editor UI state: play, pause, seek, or select/reveal one or more clip, text, or media targets without changing project revision or undo history.",
  "edit.validate":
    "Dry-run edit.apply ops (top-level input omits idempotencyKey) against the current canonical snapshot and report conflicts, warnings, and estimated impact without side effects.",
  "edit.apply":
    "Apply an atomic batch of closed edit ops as ONE undo unit. clip.setSpeedConfig replaces speed, reverse, pitch correction, source-relative speed keyframes and freeze frames together; speed is [0.1, 20], keyframe.time and freeze.sourceTime are source seconds from inPoint, and freeze.startTime is clip-local playback time including earlier freezes. When keyframes exist they replace base speed; the curve integrates in ascending source-relative time, then reverse reflects the resulting offset across the source span. freeze.sourceTime stays literal under reverse, and easing overshoot clamps to [0.1, 20]. clip.split and clip.trim reject speed-ramped or frozen clips; ReviewRange requires forward constant speed. Live clip.add forbids explicit clipId; use returned createdIds for dependent transactions. The revision CAS is unconditional in live mode: an omitted expectedRevision is guarded with the revision of the snapshot the ops were translated against; expectedContextRevision remains optional. Layering semantics: track index 0 is the TOP z-order layer. Clip transform position is a project-pixel offset from frame center, scale multiplies the canvas-fit draw size, and clip keyframes animate on the clip's own [0, duration) local clock. clip.setDuckingFromAnalysis maps a speechActivity record through the speech clip's placement/trim/speed curve/reverse/freeze timing (shared core SpeedEngine), rejects stale/wrong-media/wrong-audio-stream/no-overlap cases, and requires existingEnvelope:\"replace\" before overwriting a volume envelope. clip.cutSilenceFromAnalysis cuts a clip's silences from a silence record in the same batch/undo unit (kept pauses, edge padding, fade protection, aligned siblings cut together, per-track ripple; unsupported timings and desyncing subtitles are rejected up front). clip.splitAtBeat (AUD-06) snaps a desired cut point to the nearest beat of a beatGrid record within an explicit maxShiftSec and applies as clip.split; requests with no beat inside the allowed movement are rejected, never an unsnapped cut. Beats are grid beats, not downbeats — no downbeat detector is installed and none is fabricated; the record BPM may be half/double the true tempo.",
  "history.get":
    "Return bounded undo/redo availability and summaries from the canonical GUI/Core history.",
  "history.control":
    "Execute undo or redo through the canonical GUI/Core history with writer lease, revision CAS, and idempotency guards.",
  "preview.render_frame":
    "Render one frame of the current project snapshot to a PNG artifact and return its reference.",
  "preview.render_comparison":
    'Render one reference-comparison still at a timeline time from the SHARED referenceComparison config (left reference / right timeline, letterboxed, or overlay). The mapping is constant-rate 1.0 with a start offset; beyond refEndSec the reference side holds its last frame and the response says so.',
  "media.replace":
    "Replace timeline references with a new immutable media version, supplied by filePath or an already imported replacementMediaId candidate. The old version remains available to saved nodes. Clips keep their edits and timing clamps to the new source duration; scope project repoints all references and scope clip repoints one clip. Preserve the existing speed-ramp/freeze restrictions.",
  "media.relink":
    "Relink ONE media item to its same content at a new file location (missing/moved file fix). Only the file reference changes — never content, never clip timing. Use media.replace to swap in a new production version.",
  "visual.inspect":
    'Sample 1–12 real frames plus a contact sheet when supported. Pass exactly ONE selector: clipId (a timeline clip id from timeline_get) or timeRange as {"startSec": <number>, "endSec": <number>} in timeline seconds with endSec > startSec ≥ 0. Optional: sampleCount (1–12, default 6), width/height (even, ≤1024), maxFrameBytes (per-frame byte budget, 32768–8388608, default 1572864; oversized PNGs are JPEG-re-encoded to fit, with frames[].fidelity disclosing the delivered raster/format).',
  "export.start":
    'Start an export job for a snapshot of the current project; returns a jobId immediately. Optional destinationPath "<deliveryRoot>/jobs/<slug>/output/<name>.mp4" copies the verified artifact into the Agent workspace deliverables directory after completion (never overwrites; see capabilities_get.export.details.deliveryRoots). Poll job.status until done, then check deliveredTo/deliveryError.',
  "job.status": "Return the current status of an export, media-analysis, or audio-processing job. Completed analysis results contain scalar summaries, counts and analysisRecord.id; completed audio-process results contain the generated path, provenance, applied parameters, source range, sample timing, and before/after measurements.",
  "job.cancel":
    "Request cooperative cancellation of an export, media-analysis, or audio-processing job (idempotent on terminal jobs).",
  "verify.artifact":
    "Verify an artifact under the session artifactRoot with ffprobe/pixel checks and return the report.",
  "analysis.list":
    "List durable analysis records (newest first): subject media, analysis types, staleness (source-changed/missing vs current) and recheck linkage. Filter by mediaId.",
  "analysis.get":
    "Read a durable analysis record. Defaults to compact summary; audio event arrays and waveform bins are omitted. Use view:'events' with one of audioSummary.onsets, audioSummary.silence, silence.silentRegions, beatGrid.beats, or speechActivity.speechRegions for a half-open source-time window and bounded pages (limit ≤256, default 100); pass the returned cursor unchanged to continue. Use view:'waveform' for a bounded source window (maxPoints ≤600, default 150). Summary includes per-series stored/total counts and completeness; historical truncation is disclosed. Metadata, provenance, unknowns, recheck configuration, and staleness remain available. Cloud model text is stored as data — it is never executed and never becomes a quality verdict.",
  "material.list":
    "Search and paginate the user-level material library (media, segments, links, methods) by kind, tag, organize status and free-text query. The library is user state, independent of the open project.",
  "material.get":
    "Return one material-library entry in full: title, tags, organize status, separate user notes and AI summary, kind-specific fields (file reference, segment range, url, method prompt), provenance, and project usages.",
  "material.create":
    "Create a material-library entry: media (absolute path inside a configured media root; the original file is referenced, never moved), a time-range segment of an existing media material, an http(s) link, or a reusable skill+prompt method. Saving never installs skills or executes prompts.",
  "material.update":
    "Update one material's title, AI summary, tags, organize status, or link description. User notes are intentionally not writable by agents; pass expectedRevision (the material's revision) for CAS protection.",
  "material.batch_update":
    "Apply updates to many materials in ONE all-or-nothing batch (also one undoable journal entry). Any missing id or revision conflict rejects the whole batch with per-item details and applies nothing.",
  "material.remove":
    "Remove entries from the user-level material library. Removing an entry never deletes the original file; materials still referenced by projects require force:true (project copies are unaffected). Cascades a media material's segments.",
  "material.attach":
    "Reference a material into the CURRENT project through the canonical import path: media imports into the project library; segments (or an explicit startSec/endSec range) additionally add a timeline clip with those in/out points. One undo unit in the GUI history; use a fresh idempotencyKey.",
  "material.undo":
    "Undo one user-level library journal entry (default: the latest undoable change — e.g. an agent batch organize). Library undo is independent of project undo and survives project switches; use a fresh idempotencyKey.",
  "font.upload":
    "Install a custom font for the user: a .ttf, .otf, .woff or .woff2 file (<=10 MiB) read from an absolute path inside a configured media root, or raw base64 bytes. The bytes are validated by signature and activated in the GUI's font store, so the family appears in the GUI font pickers immediately and persists across restarts. The response reports the ACTUAL fontFamily — a duplicate base name is suffixed ('Bar' -> 'Bar 2'), never overwritten; use it verbatim in text styling. font.list first to avoid accidental duplicates.",
  "font.list":
    "List the user's installed custom fonts (name, format, size, upload time; never the bytes). These families are usable in text styling right now; built-in fonts are not included.",
  "preset.list":
    "List the user's saved custom presets (text styles, clip effect stacks, transition parameter sets) as metadata; pass kind to filter and includePayload to embed each parameter bundle. Presets are user state, independent of the open project.",
  "preset.get":
    "Return one custom preset in full: kind, name, tags, the validated parameter payload, thumbnail, and revision.",
  "preset.create":
    "Save a reusable preset for the user: text (whitelisted text style fields), effect (1-8 engine clip effects with parameter objects), or transition (engine transition type with parameter and duration overrides). Unknown fields and out-of-range values are rejected, never stored; the preset appears in the matching GUI panel immediately.",
  "preset.update":
    "Rename a custom preset, replace its tags, or replace its parameter payload. Pass expectedRevision (the preset's revision) for CAS protection; a concurrent GUI edit fails CONFLICT instead of being overwritten.",
  "preset.remove":
    "Delete a custom preset. Projects already built from it keep their parameter copies and are never affected; removal is permanent and idempotent on retries.",
  "preset.apply":
    "Apply a custom preset to the open project as one undoable batch: text presets restyle an existing text clip (mode updateStyle), effect presets apply their stack to explicit clipIds, transition presets set the parameters on a cut (clipAId, optional clipBId; omitting clipBId targets the out-point edge), graphics presets create a NEW SVG clip on a graphics track (optional trackId/startTime/durationSec; omitting trackId picks or creates the graphics track). Placement limits are hard rejections, never clamped; use a fresh idempotencyKey.",
  "help.list_screens":
    "List the shipped GUI manual's screen index: id, zh/en title and one-line summary per screen, plus the manual's content version, bound app version, and languages. Static data — available in every mode.",
  "help.describe":
    "Return ONE GUI screen's manual page: entry path, visibility condition, common steps, keyboard-shortcut references (ids; live bindings live in Settings → Shortcuts), and honest limitations. Screenshots are reserved and reported as pending until delivered. Static data — available in every mode.",
  "help.search":
    "Search the shipped GUI manual by a zh/en keyword matched over titles, summaries, entries, steps, limitations, shortcut ids and keywords; returns restrained hits (id + title + summary), never full page bodies. Static data — available in every mode.",
};

export function toolDescription(verb: FacadeVerb, mode: "live" | "headless"): string {
  const plugin = PLUGIN_TOOLS.find((tool) => tool.name === verb);
  const description = plugin?.description ?? (mode === "live" ? LIVE_DESCRIPTIONS[verb] : HEADLESS_DESCRIPTIONS[verb.replace(/\./g, "_")]);
  if (!description) throw new Error(`Missing tool description: ${verb}`);
  return description;
}

export function toolPresentation(verb: FacadeVerb): "image-collection" | undefined {
  return PLUGIN_TOOLS.find((tool) => tool.name === verb)?.presentation ?? (verb === "visual.inspect" ? "image-collection" : undefined);
}
