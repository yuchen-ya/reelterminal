import { PLUGIN_TOOLS } from "./plugins";
import type { FacadeVerb } from "./types";

const HEADLESS_DESCRIPTIONS: Readonly<Record<string, string>> = {
  session_describe:
    "Describe the facade session: contract, runtime, current Agent work mode and its semantics, plus live access/writer state when applicable.",
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
  media_analyze_start:
    "Start an asynchronous analysis job for an imported media item; unavailable analysis types fail honestly before a job is created.",
  timeline_get: "Return the compact timeline view (tracks, clips, text overlays).",
  timeline_query:
    "Query a bounded timeline slice by namespaced refs, ids, time range, track/entity types, and allowlisted fields.",
  editor_get_context:
    "Return the current Agent work mode plus editor context (selection, playhead, time range, canvas point); headless sessions answer honestly with contextAvailable:false.",
  editor_control:
    "Control ephemeral live-editor UI state: play, pause, seek, or select/reveal clip, text, or media targets without changing project revision or undo history.",
  edit_validate:
    "Dry-run the exact edit.apply op vocabulary without side effects and report conflicts, warnings, and estimated impact.",
  edit_apply:
    "Apply an atomic batch of closed edit ops to the project, including safe removal of empty tracks and unreferenced media.",
  history_get:
    "Return bounded undo/redo availability and summaries from the canonical editor history.",
  history_control:
    "Execute undo or redo through the canonical live GUI/Core history path with revision and idempotency guards.",
  preview_render_frame:
    "Render one frame of the project to a PNG artifact and return its artifact reference.",
  visual_inspect:
    "Sample 1–12 real frames for a clip or time range and return PNG artifacts plus a contact sheet when supported.",
  export_start:
    "Start an export job for a snapshot of the current project; returns a jobId immediately.",
  job_status: "Return the current status of an export or media-analysis job.",
  job_cancel: "Request cooperative cancellation of an export or media-analysis job (idempotent on terminal jobs).",
  verify_artifact:
    "Verify an artifact with ffprobe/pixel checks and return the report as data.",
};

const LIVE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "session.describe":
    "Describe this live collaboration session: runtime, current Agent work mode and explicit semantics, independent access/writer state, verbs, and error codes.",
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
    "Import a local video or audio file into the open GUI project. Use an absolute path under one of capabilities_get.mediaImport.mediaRoots; the returned mediaId can be passed to clip.add, the Media panel updates immediately, and the import is undoable in the GUI.",
  "media.analyze_start":
    "Start an asynchronous analysis job for an imported file-backed media item; capabilities_get reports each analysis type honestly.",
  "timeline.get":
    "Return the compact timeline view (tracks, clips, text overlays) at the current revision. Persisted review markers use namespaced ids R1, R2, and so on.",
  "timeline.query":
    "Query a bounded local timeline slice by @A/R refs, ids, time, track/entity type, and allowlisted fields without dumping the full project.",
  "editor.get_context":
    "Return the current Agent work mode plus live editor context: selection, playhead, time range, canvas point, namespaced Agent references A1/A2, and project/context revisions.",
  "editor.control":
    "Control ephemeral live-editor UI state: play, pause, seek, or select/reveal one or more clip, text, or media targets without changing project revision or undo history.",
  "edit.validate":
    "Dry-run the exact edit.apply op schema against the current canonical snapshot and report conflicts, warnings, and estimated impact without side effects.",
  "edit.apply":
    "Apply an atomic batch of closed edit ops as ONE undo unit, including safe track.remove (empty tracks only) and media.remove (unreferenced media only). The revision CAS is unconditional in live mode: an omitted expectedRevision is guarded with the revision of the snapshot the ops were translated against; expectedContextRevision remains optional.",
  "history.get":
    "Return bounded undo/redo availability and summaries from the canonical GUI/Core history.",
  "history.control":
    "Execute undo or redo through the canonical GUI/Core history with writer lease, revision CAS, and idempotency guards.",
  "preview.render_frame":
    "Render one frame of the current project snapshot to a PNG artifact and return its reference.",
  "visual.inspect":
    'Sample 1–12 real frames and return PNG artifacts plus a contact sheet when supported. Pass exactly ONE selector: clipId (a timeline clip id from timeline_get) or timeRange as {"startSec": <number>, "endSec": <number>} in timeline seconds with endSec > startSec ≥ 0. Optional: sampleCount (1–12, default 6), width/height (even, ≤1024).',
  "export.start":
    'Start an export job for a snapshot of the current project; returns a jobId immediately. Optional destinationPath "<deliveryRoot>/jobs/<slug>/output/<name>.mp4" copies the verified artifact into the Agent workspace deliverables directory after completion (never overwrites; see capabilities_get.export.details.deliveryRoots). Poll job.status until done, then check deliveredTo/deliveryError.',
  "job.status": "Return the current status of an export or media-analysis job.",
  "job.cancel":
    "Request cooperative cancellation of an export or media-analysis job (idempotent on terminal jobs).",
  "verify.artifact":
    "Verify an artifact under the session artifactRoot with ffprobe/pixel checks and return the report.",
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
