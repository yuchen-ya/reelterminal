import { PLUGIN_TOOLS } from "./plugins";
import type { FacadeVerb } from "./types";

const HEADLESS_DESCRIPTIONS: Readonly<Record<string, string>> = {
  session_describe:
    "Describe the facade session: contract, runtime, and live access/writer state when applicable.",
  capabilities_get:
    "Report live provider capabilities and the recommended Agent workspace root/layout, with honest reasons when unavailable.",
  project_create:
    "Create this session's single project (single-initialization lifecycle verb).",
  project_open:
    "Open a checkpoint file into this session's empty project slot (single-initialization lifecycle verb).",
  project_save:
    "Save the active project to a checkpoint file (a snapshot, not a mutation).",
  project_rename:
    "Rename the active project with revision and idempotency guards; never renames an existing checkpoint path.",
  project_get_state:
    "Return the full canonical project state at the current revision.",
  project_changes:
    "Return a bounded, paged structural delta since a project revision, or require a full refresh when history was evicted.",
  media_import:
    "Import a local media file from a configured media root into the project.",
  media_render_html:
    "Render constrained local HTML/CSS to a transparent-capable PNG artifact inside the media roots (needs the local playwright Chromium); output flows to media.import by path. Scripts, frames, event handlers and network references are rejected; relative assets resolve only inside assetsRoot; blocked/missing assets are listed, not failed.",
  media_analyze_start:
    "Start an asynchronous analysis job for an imported media item; unavailable analysis types fail honestly before a job is created.",
  timeline_get: "Return the compact timeline view (tracks, clips, text overlays).",
  timeline_query:
    "Query a bounded timeline slice by namespaced refs, ids, time range, track/entity types, and allowlisted fields.",
  editor_get_context:
    "Return editor context (selection, playhead, time range, canvas point); headless sessions answer honestly with contextAvailable:false.",
  editor_control:
    "Control ephemeral live-editor UI state: play, pause, seek, or select/reveal clip, text, or media targets without changing project revision or undo history.",
  edit_validate:
    "Dry-run edit.apply ops (top-level input omits idempotencyKey) without side effects and report conflicts, warnings, and estimated impact.",
  edit_apply:
    "Apply an atomic batch of closed edit ops to the project, including safe removal of empty tracks and unreferenced media.",
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
  job_status: "Return the current status of an export or media-analysis job.",
  job_cancel: "Request cooperative cancellation of an export or media-analysis job (idempotent on terminal jobs).",
  verify_artifact:
    "Verify an artifact with ffprobe/pixel checks and return the report as data.",
  analysis_list:
    "List durable analysis records (newest first): subject media, analysis types, staleness and recheck linkage. Filter by mediaId.",
  analysis_get:
    "Return one full analysis record: separated observations/inferences/recommendations, provenance (local measurement / static sampling / cloud opinion), explicit unknowns, the exact recheck configuration, and current staleness against the source file.",
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
  "session.describe":
    "Describe this live collaboration session: runtime, independent access/writer state, available commands, and error codes.",
  "capabilities.get":
    "Report live provider capabilities (preview, visual inspection, export, verify) with honest reasons when unavailable.",
  "project.create":
    "Unavailable in live mode — the GUI owns the project lifecycle; a live session attaches to the open project.",
  "project.open":
    "Unavailable in live mode — the GUI owns the project lifecycle; a live session attaches to the open project.",
  "project.save":
    "Flush the GUI's autosave/recovery snapshot for the open project and report the current revision; does not write a .openreel project file.",
  "project.rename":
    "Rename the open GUI project through the canonical undoable project action. This changes the display name and future suggested export/save names, but never renames an existing project file path.",
  "project.get_state":
    "Return the full canonical project state at the current revision.",
  "project.changes":
    "Return bounded structural changes since a project revision, including both GUI and Agent edits, or require a full refresh when retained history is unavailable.",
  "media.import":
    "Import a local video, audio, or image file (PNG, JPEG, GIF, WebP) into the open GUI project. Use an absolute path under one of capabilities_get.mediaImport.mediaRoots; the returned mediaId can be passed to clip.add, the Media panel updates immediately, and the import is undoable in the GUI.",
  "media.render_html":
    "Render constrained local HTML/CSS markup to a PNG file under the media roots (default <mediaRoots[0]>/jobs/html-render/<requestKey>/), then media.import that path to put it on the timeline. source is {kind:'path',path} (an .html file inside a media root) or {kind:'inline',html} (raw markup ≤512 KiB). width/height are even integers in [2,4096]; transparent defaults to true; timeoutMs defaults to 30000 (≤120000). Scripts, iframe/object/embed, event handlers, javascript:/non-image data: URIs and network references (http(s), file, protocol-relative, srcset, CSS url(http)/@import/@font-face url(http)) are rejected; local subresources resolve only inside assetsRoot and remote/missing ones are aborted and returned in missingAssets — the render still succeeds. Requires this machine's playwright Chromium (same supply as preview) and a configured media root; transparent PNGs composite cleanly over the timeline. Changes no project state — import the returned path afterwards.",
  "media.analyze_start":
    "Start a read-only asynchronous analysis job. videoReview sends an explicit <=20s source range to the selected cloud provider (default Alibaba qwen3.5-omni-flash via DASHSCOPE_API_KEY; REELTERMINAL_VIDEO_REVIEW_PROVIDER selects the provider), requires artifactRoot and cloudUpload:true; optional reviewQuestion (<=1000 chars). The bounded inspection copy is transcoded once and cached (source fingerprint + range keyed); each review still uploads once. Returns fallible cloud opinions, not acceptance; no automatic retry. audioSummary uses local FFmpeg for LUFS, true peak, waveforms, silence and onset/periodicity candidates with explicit source startSec/endSec (max 120s), without listening or editing; capabilities_get reports each analysis type honestly.",
  "timeline.get":
    "Return the compact timeline view (tracks, clips, text overlays) at the current revision. Persisted review markers use namespaced ids R1, R2, and so on.",
  "timeline.query":
    "Query a bounded local timeline slice by @A/R refs, ids, time, track/entity type, and allowlisted fields without dumping the full project.",
  "editor.get_context":
    "Return live editor context: selection, playhead, time range, canvas point, namespaced Agent references A1/A2, and project/context revisions.",
  "editor.control":
    "Control ephemeral live-editor UI state: play, pause, seek, or select/reveal one or more clip, text, or media targets without changing project revision or undo history.",
  "edit.validate":
    "Dry-run edit.apply ops (top-level input omits idempotencyKey) against the current canonical snapshot and report conflicts, warnings, and estimated impact without side effects.",
  "edit.apply":
    "Apply an atomic batch of closed edit ops as ONE undo unit. Live clip.add forbids explicit clipId; use the returned createdIds for dependent transactions, including safe track.remove (empty tracks only) and media.remove (unreferenced media only). The revision CAS is unconditional in live mode: an omitted expectedRevision is guarded with the revision of the snapshot the ops were translated against; expectedContextRevision remains optional. Layering semantics: track index 0 is the TOP z-order layer (tracks draw in descending index order), so put cross-shot foreground elements on a LOWER track index than the backgrounds they span; track.add accepts a zero-based position for exactly that. Clip transform position is a project-pixel offset from frame center (not normalized), scale multiplies the canvas-fit draw size, and clip keyframes animate on the clip's own [0, duration) local clock — one foreground clip spanning a background cut keeps a single continuous animation across the cut.",
  "history.get":
    "Return bounded undo/redo availability and summaries from the canonical GUI/Core history.",
  "history.control":
    "Execute undo or redo through the canonical GUI/Core history with writer lease, revision CAS, and idempotency guards.",
  "preview.render_frame":
    "Render one frame of the current project snapshot to a PNG artifact and return its reference.",
  "preview.render_comparison":
    'Render one reference-comparison still at a timeline time from the SHARED referenceComparison config (left reference / right timeline, letterboxed, or overlay). The mapping is constant-rate 1.0 with a start offset; beyond refEndSec the reference side holds its last frame and the response says so.',
  "media.replace":
    "Replace the source of timeline references with a NEW production version: the new file imports as its own media item (the old file is never overwritten; both versions coexist and clips record supersedesMediaId lineage), clips keep all edits, and timing clamps to the new source duration — the timeline never extends. scope project repoints every clip on that media; scope clip repoints one.",
  "media.relink":
    "Relink ONE media item to its same content at a new file location (missing/moved file fix). Only the file reference changes — never content, never clip timing. Use media.replace to swap in a new production version.",
  "visual.inspect":
    'Sample 1–12 real frames plus a contact sheet when supported. Pass exactly ONE selector: clipId (a timeline clip id from timeline_get) or timeRange as {"startSec": <number>, "endSec": <number>} in timeline seconds with endSec > startSec ≥ 0. Optional: sampleCount (1–12, default 6), width/height (even, ≤1024), maxFrameBytes (per-frame byte budget, 32768–8388608, default 1572864; oversized PNGs are JPEG-re-encoded to fit, with frames[].fidelity disclosing the delivered raster/format).',
  "export.start":
    'Start an export job for a snapshot of the current project; returns a jobId immediately. Optional destinationPath "<deliveryRoot>/jobs/<slug>/output/<name>.mp4" copies the verified artifact into the Agent workspace deliverables directory after completion (never overwrites; see capabilities_get.export.details.deliveryRoots). Poll job.status until done, then check deliveredTo/deliveryError.',
  "job.status": "Return the current status of an export or media-analysis job.",
  "job.cancel":
    "Request cooperative cancellation of an export or media-analysis job (idempotent on terminal jobs).",
  "verify.artifact":
    "Verify an artifact under the session artifactRoot with ffprobe/pixel checks and return the report.",
  "analysis.list":
    "List durable analysis records (newest first): subject media, analysis types, staleness (source-changed/missing vs current) and recheck linkage. Filter by mediaId.",
  "analysis.get":
    "Return one full analysis record: separated observations/inferences/recommendations, provenance per source (local measurement / static sampling / cloud opinion), explicit unknowns, the exact stored configuration for a same-config recheck (media.analyze_start recheckOfRecordId), and current staleness. Cloud model text is stored as data — it is never executed and never becomes a quality verdict.",
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
