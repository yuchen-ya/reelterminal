// NOTE: subpath imports (not the package index) on purpose — the facade's
// index.ts pulls in session.ts → node:fs/node:path/node:crypto, which must
// never reach the web bundle. jsonschema.ts/types.ts are dependency-pure.
import { EMITTED_VERB_JSON_SCHEMAS } from "@openreel/agent-facade/jsonschema";
import { READ_ONLY_VERBS } from "@openreel/agent-facade/types";
import type {
  ToolExecutor,
  ToolGating,
  JSONSchema,
} from "@openreel/agent";

/**
 * Desktop live-collaboration chat adapter (ADR 0004 Decision 8). On desktop
 * the embedded chat runs against the SAME 15-verb facade contract as external
 * agents, reached over `window.openreel.facade.call` into the main-process
 * live session. This module is the single seam for facade specifics:
 *   1. tool defs — facade-emitted JSON Schemas wrapped for Anthropic/OpenAI;
 *   2. executor  — tool name → facade verb → IPC call → ToolResult with a
 *      short human-readable summary (never raw JSON);
 *   3. gating    — which verbs are read-only / expensive for the loop's
 *      dry-run and confirm paths;
 *   4. the live-collaboration system prompt.
 *
 * All 15 verbs (including editor.get_context) and edit.apply's
 * expectedContextRevision param are picked up automatically from
 * EMITTED_VERB_JSON_SCHEMAS.
 */

/** MCP-style tool spelling ↔ facade verb spelling ("edit.apply" ↔ "edit_apply"). */
export function toolNameForVerb(verb: string): string {
  return verb.replace(/\./g, "_");
}

const VERB_BY_TOOL_NAME: ReadonlyMap<string, string> = new Map(
  Object.keys(EMITTED_VERB_JSON_SCHEMAS).map((verb) => [
    toolNameForVerb(verb),
    verb,
  ]),
);

export function verbForToolName(name: string): string | null {
  return VERB_BY_TOOL_NAME.get(name) ?? null;
}

const VERB_DESCRIPTIONS: Record<string, string> = {
  "session.describe":
    "Describe this live collaboration session: runtime, available verbs, edit ops, and error codes.",
  "capabilities.get":
    "Get the editing capability manifest (blend modes, effect types, enums) to ground edits in valid values.",
  "project.create":
    "Create a new project. Unavailable in live mode — the GUI owns project lifecycle.",
  "project.open":
    "Open an existing project. Unavailable in live mode — the GUI owns project lifecycle.",
  "project.save":
    "Save the open project via the GUI's own save path. Params: path (string, optional in live mode).",
  "project.get_state":
    "Read the full canonical project state plus its current revision.",
  "media.import":
    "Import a media file. Unavailable in live mode — the GUI owns media import.",
  "timeline.get":
    "Read the timeline projection: tracks, clips, and text overlays with ids, plus the current revision.",
  "editor.get_context":
    "Read the LIVE editor context: playhead, selected clip/text ids, time range, canvas target point, project revision and contextRevision. Call this before any edit that depends on what the user is looking at or has selected.",
  "edit.apply":
    "Apply a batch of edit ops (track.add, clip.add, clip.trim, clip.remove, clip.setVolume, text.create, text.update, text.delete) as ONE undo unit. Supports expectedRevision and expectedContextRevision CAS guards — pass them when the edit derives from state or context you read earlier.",
  "preview.render_frame":
    "Render a frame of the current project to a PNG artifact at a given time.",
  "export.start":
    "Start a video export job of the current project (expensive).",
  "job.status": "Check the state/progress of an export job.",
  "job.cancel": "Cancel a running export job.",
  "verify.artifact":
    "Verify an exported artifact (duration, size, pixel probes) against expectations.",
};

interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: JSONSchema;
}

/** Anthropic Messages API tool format, backed by the facade's emitted schemas. */
export function facadeAnthropicTools(): AnthropicToolDef[] {
  return Object.entries(EMITTED_VERB_JSON_SCHEMAS).map(([verb, schema]) => ({
    name: toolNameForVerb(verb),
    description: VERB_DESCRIPTIONS[verb] ?? `Facade verb ${verb}`,
    input_schema: schema as unknown as JSONSchema,
  }));
}

/** OpenAI Chat Completions tool format, backed by the facade's emitted schemas. */
export function facadeOpenAITools(): Array<{
  type: "function";
  function: { name: string; description: string; parameters: JSONSchema };
}> {
  return facadeAnthropicTools().map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}

const READ_ONLY_VERB_SET: ReadonlySet<string> = new Set(READ_ONLY_VERBS);

const EXPENSIVE_VERBS = new Set(["export.start"]);

/**
 * Gating for the facade tool surface. Read-only mirrors the facade's own
 * READ_ONLY_VERBS (Observe-mode surface). Assist mode deliberately has no
 * per-op confirmations (ADR 0004 Decision 7), so nothing is "destructive";
 * export is expensive (real render cost) and stays behind the loop's confirm
 * gate.
 */
export const facadeGating: ToolGating = {
  isReadOnly: (name) => {
    const verb = verbForToolName(name);
    return verb !== null && READ_ONLY_VERB_SET.has(verb);
  },
  isDestructive: () => false,
  isExpensive: (name) => {
    const verb = verbForToolName(name);
    return verb !== null && EXPENSIVE_VERBS.has(verb);
  },
};

/* ------------------------------------------------------------------------ */

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * The IPC contract documents facade.call results as `{ ok, data?, error? }`
 * while the in-process FacadeResult is `{ ok, value } | { ok, false, error }`.
 * Accept both so the adapter works against either serialization.
 */
function facadeResultData(result: Record<string, unknown>): unknown {
  return "data" in result ? result.data : result.value;
}

function collectAffectedIds(data: unknown): string[] | undefined {
  const applied = asRecord(data)?.applied;
  if (!Array.isArray(applied)) return undefined;
  const ids: string[] = [];
  for (const entry of applied) {
    const created = asRecord(entry)?.createdIds;
    if (Array.isArray(created)) {
      for (const id of created) {
        if (typeof id === "string") ids.push(id);
      }
    }
  }
  return ids;
}

function summarizeOps(data: unknown): string {
  const applied = asRecord(data)?.applied;
  if (!Array.isArray(applied) || applied.length === 0) return "no edits";
  const ops = applied
    .map((entry) => asString(asRecord(entry)?.op))
    .filter((op): op is string => op !== null);
  if (ops.length <= 3) return ops.join(", ");
  return `${ops.slice(0, 3).join(", ")} +${ops.length - 3} more`;
}

/**
 * Short human-readable summaries per verb (Decision 8: "no raw JSON blobs in
 * the UI"). The data payload keeps machine-readable fields — revision and
 * affectedIds feed the chat's per-tool-call metadata.
 */
function summarizeFacadeResult(
  verb: string,
  data: unknown,
): { summary: string; data: Record<string, unknown> } {
  const record = asRecord(data) ?? {};
  const revision = asNumber(record.revision) ?? asNumber(record.projectRevision);

  switch (verb) {
    case "edit.apply": {
      const affectedIds = collectAffectedIds(data);
      return {
        summary: `Applied ${summarizeOps(data)} (revision ${revision ?? "?"})`,
        data: {
          ...record,
          ...(revision !== null ? { revision } : {}),
          affectedIds: affectedIds ?? [],
        },
      };
    }
    case "editor.get_context": {
      const contextRevision = asNumber(record.contextRevision);
      const parts = [
        revision !== null ? `project rev ${revision}` : null,
        contextRevision !== null ? `context rev ${contextRevision}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      return {
        summary: `Read live context${parts ? ` (${parts})` : ""}`,
        data: {
          ...record,
          ...(revision !== null ? { revision } : {}),
        },
      };
    }
    case "project.get_state":
      return {
        summary: `Read project state (revision ${revision ?? "?"})`,
        data: record,
      };
    case "timeline.get": {
      const tracks = Array.isArray(record.tracks) ? record.tracks.length : "?";
      return { summary: `Read timeline (${tracks} tracks)`, data: record };
    }
    case "project.save":
      return {
        summary: `Saved project (revision ${revision ?? "?"})`,
        data: record,
      };
    case "session.describe": {
      const verbs = Array.isArray(record.verbs) ? record.verbs.length : "?";
      return { summary: `Read session description (${verbs} verbs)`, data: record };
    }
    case "capabilities.get":
      return { summary: "Read editing capabilities", data: record };
    case "preview.render_frame": {
      const timeSec = asNumber(record.timeSec);
      return {
        summary: `Rendered preview frame${timeSec !== null ? ` at ${timeSec}s` : ""}`,
        data: record,
      };
    }
    case "export.start": {
      const jobId = asString(record.jobId);
      const state = asString(record.state);
      return {
        summary: `Export job ${jobId ?? "?"} ${state ?? "started"}`,
        data: record,
      };
    }
    case "job.status": {
      const jobId = asString(record.jobId);
      const state = asString(record.state);
      const percent = asNumber(asRecord(record.progress)?.percent);
      return {
        summary: `Job ${jobId ?? "?"}: ${state ?? "unknown"}${percent !== null ? ` (${Math.round(percent)}%)` : ""}`,
        data: record,
      };
    }
    case "job.cancel": {
      const jobId = asString(record.jobId);
      return { summary: `Cancelled job ${jobId ?? "?"}`, data: record };
    }
    case "verify.artifact": {
      const ok = record.ok === true || record.passed === true;
      return {
        summary: ok ? "Artifact verified" : "Artifact verification failed",
        data: record,
      };
    }
    default:
      return { summary: `${verb} completed`, data: record };
  }
}

function facadeBridge(): {
  call(verb: string, params: unknown): Promise<unknown>;
} | null {
  if (typeof window === "undefined") return null;
  const facade = window.openreel?.facade;
  return facade && typeof facade.call === "function" ? facade : null;
}

/**
 * Loop executor for the desktop facade chat: maps the LLM-facing tool name to
 * its facade verb and calls the main-process live session over IPC. The host
 * argument is unused — the facade session reaches the canonical store through
 * the live bridge, not through this renderer's EditingHost.
 */
export const facadeChatExecutor: ToolExecutor = async (name, args) => {
  const verb = verbForToolName(name);
  if (!verb) {
    return {
      ok: false,
      summary: `Unknown tool: ${name}`,
      error: { code: "UNKNOWN_TOOL", message: `No facade verb for '${name}'` },
    };
  }
  const bridge = facadeBridge();
  if (!bridge) {
    return {
      ok: false,
      summary: "Live collaboration is only available in the desktop app",
      error: {
        code: "HOST_UNAVAILABLE",
        message: "The desktop facade bridge is not available",
      },
    };
  }

  let raw: unknown;
  try {
    raw = await bridge.call(verb, args ?? {});
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Facade call failed";
    return {
      ok: false,
      summary: message,
      error: { code: "IPC_ERROR", message },
    };
  }

  const result = asRecord(raw);
  if (!result || typeof result.ok !== "boolean") {
    return {
      ok: false,
      summary: "Malformed facade response",
      error: {
        code: "IPC_ERROR",
        message: "The facade returned a malformed response",
      },
    };
  }
  if (!result.ok) {
    const error = asRecord(result.error);
    const code = asString(error?.code) ?? "FACADE_ERROR";
    const message = asString(error?.message) ?? `${verb} failed`;
    return {
      ok: false,
      summary: message,
      error: { code, message },
    };
  }

  const { summary, data } = summarizeFacadeResult(
    verb,
    facadeResultData(result),
  );
  return { ok: true, summary, data };
};

/**
 * Compact live-collaboration system prompt (ADR 0004 Decisions 4 + 8). Kept
 * short — tool schemas carry the per-verb detail.
 */
export const LIVE_COLLAB_SYSTEM_PROMPT = [
  "You are OpenReel's live collaboration agent in the desktop app. You and the human edit the SAME open project at the SAME time — the human keeps working while you think.",
  "",
  "How to work:",
  "- Before acting, state briefly (one or two sentences) what you understood and what you will do.",
  "- ALWAYS call editor_get_context before edits that depend on the user's selection, playhead, time range, or the canvas target point — never assume they are where they were.",
  "- When an edit derives from selection, playhead, time range, or the canvas point, pass expectedContextRevision from the context you read. When an edit must not overwrite newer project state, pass expectedRevision.",
  "- On a CONFLICT error, re-read with editor_get_context or project_get_state, then retry once with fresh expectations — or ask the user.",
  "- All times are in seconds (float). Canvas positions are normalized 0..1; (0.5, 0.5) is the exact frame center.",
  "- Use timeline_get / project_get_state to ground clip, track, and overlay ids before editing them.",
  "- Your edits land as ordinary undo steps in the user's history — keep batches small and purposeful.",
  "- When done, stop and summarize what you changed.",
].join("\n");
