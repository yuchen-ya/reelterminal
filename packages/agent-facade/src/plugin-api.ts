import type { Project } from "@openreel/core/types/project";
import type { RenderProvider } from "./providers";
import type { OutputSchemaNode } from "./output-schemas";
import { validateObject, type ObjectSchema } from "./validate";
import { ok, toFailure, type FacadeResult } from "./errors";

/** Trusted, bundled plugins. This is an authoring API, not a sandbox. */
export interface ToolContext {
  readonly mode: "live" | "headless";
  readonly snapshot: () => Promise<{ project: Project; revision: number }>;
  readonly renderProvider?: RenderProvider;
  readonly artifactRoot?: string;
  readonly mediaRoots: readonly string[];
  readonly resolveMediaPath: (mediaId: string, project: Project) => Promise<string>;
}

export interface ToolDefinition<Name extends string = string, Input = unknown, Output = unknown> {
  readonly name: Name;
  readonly description: string;
  readonly input: ObjectSchema;
  readonly output: OutputSchemaNode;
  /** Initial extension surface is read-only; edits keep using edit.apply. */
  readonly effect: "read";
  readonly requires?: readonly ("render" | "artifactRoot" | "mediaRoots")[];
  readonly schemaCases: readonly { name: string; params: unknown; expectValid: boolean }[];
  readonly presentation?: "image-collection";
  readonly execute: (input: Input, context: ToolContext) => Promise<Output>;
}

export function defineTool<const Name extends string, Input, Output>(
  definition: ToolDefinition<Name, Input, Output>,
): ToolDefinition<Name, Input, Output> {
  if (!/^[a-z][a-z0-9]*(?:[._][a-z0-9]+)*$/.test(definition.name)) {
    throw new Error(`Invalid tool name: ${definition.name}`);
  }
  return Object.freeze(definition);
}

export function definePlugin<const Tools extends readonly ToolDefinition<string, never, unknown>[]>(
  definition: { readonly id: string; readonly tools: Tools },
): { readonly id: string; readonly tools: Tools } {
  return Object.freeze(definition);
}

export type PluginBindings<Tools extends readonly ToolDefinition<string, never, unknown>[]> = {
  [Tool in Tools[number] as Tool["name"]]: (
    input: Parameters<Tool["execute"]>[0],
  ) => Promise<FacadeResult<Awaited<ReturnType<Tool["execute"]>>>>;
};

/** Validation and domain errors are identical for every transport and mode. */
export function bindTools<const Tools extends readonly ToolDefinition<string, never, unknown>[]>(
  definitions: Tools,
  context: ToolContext,
): PluginBindings<Tools> {
  return Object.fromEntries(definitions.map((tool) => [tool.name, async (input: unknown) => {
    try {
      const valid = validateObject<never>(input, tool.input, `${tool.name} params`);
      return ok(await tool.execute(valid, context));
    } catch (error) {
      return toFailure(error);
    }
  }])) as PluginBindings<Tools>;
}

export function assertUniqueToolNames(names: readonly string[]): void {
  const seen = new Set<string>();
  for (const name of names) {
    const mcpName = name.replace(/\./g, "_");
    if (seen.has(mcpName)) throw new Error(`Duplicate MCP tool name: ${mcpName}`);
    seen.add(mcpName);
  }
}

export function collectPluginTools<const Plugins extends readonly { readonly id: string; readonly tools: readonly ToolDefinition<string, never, unknown>[] }[]>(plugins: Plugins): Plugins[number]["tools"][number][] {
  const ids = plugins.map((plugin) => plugin.id);
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate plugin id");
  const tools = plugins.flatMap((plugin) => plugin.tools);
  assertUniqueToolNames(tools.map((tool) => tool.name));
  return tools as Plugins[number]["tools"][number][];
}
