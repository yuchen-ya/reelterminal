/**
 * Protocol-neutral description of facade commands.
 *
 * MCP tool schemas and live CLI discovery are generated from this catalog.
 * The facade remains the authority for validation and execution; this module
 * only describes each already-registered verb and its operational behavior.
 */
import {
  EMITTED_VERB_JSON_SCHEMAS,
  LIVE_VERB_INPUT_SCHEMA_OVERRIDES,
  type JsonSchemaObject,
} from "./jsonschema";
import { EMITTED_VERB_OUTPUT_JSON_SCHEMAS } from "./output-schemas";
import { PLUGIN_TOOLS } from "./plugins";
import { facadeToolNameForVerb, FACADE_VERBS, isReadOnlyVerb, type FacadeToolName, type FacadeVerb } from "./types";
import { toolDescription } from "./tool-catalog";

export type CommandCatalogMode = "live" | "headless";
export type CommandEffect = "read" | "write" | "task" | "filesystem";
export type CommandRetryPolicy = "safe" | "idempotent" | "never";
/** Short compatibility alias for consumers rendering the retry field. */
export type RetryPolicy = CommandRetryPolicy;

export interface CommandCatalogEntry {
  /** Canonical facade command name, such as `edit.apply`. */
  readonly name: FacadeVerb;
  /** Compatibility MCP spelling, derived from the canonical name. */
  readonly toolName: FacadeToolName;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
  readonly outputSchema: Record<string, unknown>;
  /** Observable effects; an entry can have more than one. */
  readonly effects: readonly CommandEffect[];
  /** Whether a transport may repeat this request after an uncertain response. */
  readonly retry: CommandRetryPolicy;
}

const TASK_VERBS = new Set<FacadeVerb>([
  "media.analyze_start",
  "preview.render_frame",
  "preview.render_comparison",
  "visual.inspect",
  "export.start",
  "job.cancel",
]);

const FILESYSTEM_VERBS = new Set<FacadeVerb>([
  "project.create",
  "project.open",
  "project.save",
  "media.import",
  "media.render_html",
  "media.analyze_start",
  "preview.render_frame",
  "preview.render_comparison",
  "visual.inspect",
  "export.start",
  "verify.artifact",
  "font.upload",
  "font.list",
]);

function hasIdempotencyKey(schema: JsonSchemaObject): boolean {
  return Object.hasOwn(schema.properties, "idempotencyKey");
}

function effectsFor(verb: FacadeVerb): readonly CommandEffect[] {
  const effects: CommandEffect[] = [];
  const plugin = PLUGIN_TOOLS.find((tool) => tool.name === verb);
  if (isReadOnlyVerb(verb) && verb !== "editor.control") effects.push("read");
  else effects.push("write");
  if (TASK_VERBS.has(verb) || plugin?.requires?.includes("render")) effects.push("task");
  if (
    FILESYSTEM_VERBS.has(verb)
    || plugin?.requires?.some((requirement) => requirement === "artifactRoot" || requirement === "mediaRoots")
  ) effects.push("filesystem");
  return effects;
}

function retryFor(verb: FacadeVerb, schema: JsonSchemaObject): CommandRetryPolicy {
  // Starting work can consume substantial local/cloud resources. Even when
  // an idempotency key exists, transports must make retry decisions explicit.
  if (effectsFor(verb).includes("task")) return "never";
  if (!effectsFor(verb).includes("write")) return "safe";
  return hasIdempotencyKey(schema) ? "idempotent" : "never";
}

function entryFor(verb: FacadeVerb, mode: CommandCatalogMode): CommandCatalogEntry {
  const inputSchema = mode === "live"
    ? LIVE_VERB_INPUT_SCHEMA_OVERRIDES[verb] ?? EMITTED_VERB_JSON_SCHEMAS[verb]
    : EMITTED_VERB_JSON_SCHEMAS[verb];
  if (inputSchema === undefined) {
    throw new Error(`command catalog: no input schema for ${verb} (${mode})`);
  }
  const outputSchema = EMITTED_VERB_OUTPUT_JSON_SCHEMAS[verb];
  if (outputSchema === undefined) {
    throw new Error(`command catalog: no output schema for ${verb}`);
  }
  return Object.freeze({
    name: verb,
    toolName: facadeToolNameForVerb(verb),
    description: toolDescription(verb, mode),
    inputSchema,
    outputSchema: outputSchema as unknown as Record<string, unknown>,
    effects: Object.freeze(effectsFor(verb)),
    retry: retryFor(verb, inputSchema),
  });
}

const LIVE_COMMANDS = Object.freeze(FACADE_VERBS.map((verb) => entryFor(verb, "live")));
const HEADLESS_COMMANDS = Object.freeze(FACADE_VERBS.map((verb) => entryFor(verb, "headless")));

/** Return every registered command in stable facade order, including plugins. */
export function getCommandCatalog(mode: CommandCatalogMode): readonly CommandCatalogEntry[] {
  return mode === "live" ? LIVE_COMMANDS : HEADLESS_COMMANDS;
}

/** Return one canonical dotted command, or undefined when it is unknown. */
export function getCommandCatalogEntry(
  name: string,
  mode: CommandCatalogMode,
): CommandCatalogEntry | undefined {
  return getCommandCatalog(mode).find((command) => command.name === name);
}
