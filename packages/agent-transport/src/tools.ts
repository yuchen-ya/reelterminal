/** MCP is a formatting adapter over the facade's protocol-neutral catalog. */
import {
  getCommandCatalog,
  type CommandCatalogEntry,
  type FacadeToolName,
  type FacadeVerb,
} from "@reelterminal/agent-facade";

export type ToolName = FacadeToolName;

/** B.1 tool names, in the facade's stable command order. */
export const TOOL_NAMES: readonly ToolName[] = getCommandCatalog("headless").map(
  (command) => command.toolName,
);

export const TOOL_TO_VERB: Readonly<Record<ToolName, FacadeVerb>> =
  Object.fromEntries(
    getCommandCatalog("headless").map((command) => [command.toolName, command.name]),
  ) as Record<ToolName, FacadeVerb>;

export const VERB_TO_TOOL: Readonly<Record<FacadeVerb, ToolName>> =
  Object.fromEntries(
    getCommandCatalog("headless").map((command) => [command.name, command.toolName]),
  ) as Record<FacadeVerb, ToolName>;

export interface McpTool {
  readonly name: ToolName;
  readonly description: string;
  readonly inputSchema: CommandCatalogEntry["inputSchema"];
  /** Successful `{ok:true,value}` structuredContent shape. */
  readonly outputSchema: Record<string, unknown>;
}

/** The exact tools/list payload. Schemas are passed through by reference. */
export const TOOLS: readonly McpTool[] = getCommandCatalog("headless").map(
  (command) => ({
    name: command.toolName,
    description: command.description,
    inputSchema: command.inputSchema,
    outputSchema: command.outputSchema,
  }),
);
