/**
 * Registered facade verbs ⇄ MCP tools, 1:1 (ADR 0003 Decision 2, B.1/B.2;
 * ADR 0004 adds editor.get_context/editor.control).
 *
 * `inputSchema` is ALWAYS the facade's emitted JSON Schema, verbatim — the
 * transport never declares a schema of its own (Decision 4). Tool
 * descriptions are one short hand-written purpose string each (B.2): no
 * parameter semantics, no defaults, no workarounds — those live in the
 * facade and the SKILL. Bundled plugins contribute tools through the facade registry; and `packages/agent`'s 304-tool registry is never imported.
 */
import {
  toolDescription,
  EMITTED_VERB_JSON_SCHEMAS,
  EMITTED_VERB_OUTPUT_JSON_SCHEMAS,
  FACADE_TOOL_NAMES,
  FACADE_TOOL_TO_VERB,
  FACADE_VERB_TO_TOOL,
  type FacadeToolName,
  type JsonSchemaObject,
} from "@openreel/agent-facade";
import type { FacadeVerb } from "@openreel/agent-facade";

/** B.1 tool names, flat underscore form, in B.1 table order. */
export const TOOL_NAMES = FACADE_TOOL_NAMES;

export type ToolName = FacadeToolName;

export const TOOL_TO_VERB: Readonly<Record<ToolName, FacadeVerb>> =
  FACADE_TOOL_TO_VERB;

export const VERB_TO_TOOL: Readonly<Record<FacadeVerb, ToolName>> =
  FACADE_VERB_TO_TOOL;

/** B.2: purpose only — parameter semantics live in the facade/schemas. */


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
    description: toolDescription(verb, "headless"),
    inputSchema,
    outputSchema: EMITTED_VERB_OUTPUT_JSON_SCHEMAS[verb] as unknown as Record<string, unknown>,
  };
});
