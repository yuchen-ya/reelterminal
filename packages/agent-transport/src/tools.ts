/**
 * The 17 facade verbs ⇄ 17 MCP tools, 1:1 (ADR 0003 Decision 2, B.1/B.2;
 * ADR 0004 adds editor.get_context/editor.control).
 *
 * `inputSchema` is ALWAYS the facade's emitted JSON Schema, verbatim — the
 * transport never declares a schema of its own (Decision 4). Tool
 * descriptions are one short hand-written purpose string each (B.2): no
 * parameter semantics, no defaults, no workarounds — those live in the
 * facade and the SKILL. No config/flag/env adds, renames, hides, or gates
 * tools, and `packages/agent`'s 304-tool registry is never imported.
 */
import {
  EMITTED_VERB_JSON_SCHEMAS,
  EMITTED_VERB_OUTPUT_JSON_SCHEMAS,
  type JsonSchemaObject,
} from "@openreel/agent-facade";
import { FACADE_VERBS, type FacadeVerb } from "@openreel/agent-facade";

/** B.1 tool names, flat underscore form, in B.1 table order. */
export const TOOL_NAMES = [
  "session_describe",
  "capabilities_get",
  "project_create",
  "project_open",
  "project_save",
  "project_get_state",
  "media_import",
  "timeline_get",
  "editor_get_context",
  "editor_control",
  "edit_apply",
  "preview_render_frame",
  "visual_inspect",
  "export_start",
  "job_status",
  "job_cancel",
  "verify_artifact",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/** B.1 order maps 1:1 onto FACADE_VERBS order — assert it at load. */
const VERBS_IN_TOOL_ORDER: readonly FacadeVerb[] = [...FACADE_VERBS];

if (VERBS_IN_TOOL_ORDER.length !== TOOL_NAMES.length) {
  throw new Error(
    `tool map: facade has ${VERBS_IN_TOOL_ORDER.length} verbs but the transport maps ${TOOL_NAMES.length} tools (facade/transport must stay 1:1)`,
  );
}

export const TOOL_TO_VERB: Readonly<Record<ToolName, FacadeVerb>> =
  Object.fromEntries(
    TOOL_NAMES.map((tool, index) => [tool, VERBS_IN_TOOL_ORDER[index]]),
  ) as Readonly<Record<ToolName, FacadeVerb>>;

export const VERB_TO_TOOL: Readonly<Record<FacadeVerb, ToolName>> =
  Object.fromEntries(
    TOOL_NAMES.map((tool, index) => [VERBS_IN_TOOL_ORDER[index], tool]),
  ) as Readonly<Record<FacadeVerb, ToolName>>;

/** B.2: purpose only — parameter semantics live in the facade/schemas. */
const TOOL_DESCRIPTIONS: Readonly<Record<ToolName, string>> = {
  session_describe:
    "Describe the facade session: contract version, the 17 verbs, error codes, runtime step letters.",
  capabilities_get:
    "Report live provider capabilities (media import, preview, visual inspection, export, verify) with honest reasons when unavailable.",
  project_create:
    "Create this session's single project (single-initialization lifecycle verb).",
  project_open:
    "Open a checkpoint file into this session's empty project slot (single-initialization lifecycle verb).",
  project_save:
    "Save the active project to a checkpoint file (a snapshot, not a mutation).",
  project_get_state:
    "Return the full canonical project state at the current revision.",
  media_import:
    "Import a local media file from a configured media root into the project.",
  timeline_get: "Return the compact timeline view (tracks, clips, text overlays).",
  editor_get_context:
    "Return the editor context (selection, playhead, time range, canvas point); headless sessions answer honestly with contextAvailable:false.",
  editor_control:
    "Control ephemeral live-editor UI state: play, pause, seek, or select/reveal clip, text, or media targets without changing project revision or undo history.",
  edit_apply:
    "Apply an atomic batch of closed edit ops to the project, including safe removal of empty tracks and unreferenced media.",
  preview_render_frame:
    "Render one frame of the project to a PNG artifact and return its artifact reference.",
  visual_inspect:
    "Sample 1–12 real frames for a clip or time range and return PNG artifacts plus a contact sheet when supported.",
  export_start:
    "Start an export job for a snapshot of the current project; returns a jobId immediately.",
  job_status: "Return the current status of an export job.",
  job_cancel: "Request cooperative cancellation of an export job (idempotent on terminal jobs).",
  verify_artifact:
    "Verify an artifact with ffprobe/pixel checks and return the report as data.",
};

export interface McpTool {
  readonly name: ToolName;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
  /** Successful `{ok:true,value}` structuredContent shape. */
  readonly outputSchema: Record<string, unknown>;
}

/**
 * The exact tools/list payload. `inputSchema` is the facade emission,
 * assigned VERBATIM by reference — a CI test deep-equals the served
 * tools/list against EMITTED_VERB_JSON_SCHEMAS, so copy drift dies there.
 */
export const TOOLS: readonly McpTool[] = TOOL_NAMES.map((tool) => {
  const verb = TOOL_TO_VERB[tool];
  const inputSchema = EMITTED_VERB_JSON_SCHEMAS[verb];
  if (inputSchema === undefined) {
    throw new Error(`tool map: no emitted JSON schema for verb "${verb}"`);
  }
  return {
    name: tool,
    description: TOOL_DESCRIPTIONS[tool],
    inputSchema,
    outputSchema: EMITTED_VERB_OUTPUT_JSON_SCHEMAS[verb] as unknown as Record<string, unknown>,
  };
});
