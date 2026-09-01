/**
 * External-agent channel: a REAL MCP stdio client (official sdk Client over
 * StdioClientTransport) spawning the built openreel-mcp shim, which forwards
 * NDJSON JSON-RPC to the desktop live endpoint with bearer auth — exactly the
 * path an external Codex/Claude-style agent takes (ADR 0004 Decision 9).
 *
 * The test process NEVER calls the facade in-process; every agent-side verb
 * goes through this client.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { MCP_SHIM_PATH } from "./paths";

/** FacadeResult as returned inside the endpoint's tools/call payload. */
export interface FacadeCallResult<T = unknown> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: { code: string; message: string; details?: Record<string, unknown> };
  /** MCP-level isError flag (domain failures surface here, not as throws). */
  readonly isError: boolean;
  /** The raw MCP tools/call result (evidence). */
  readonly raw: unknown;
}

export interface ExternalAgent {
  readonly client: Client;
  callTool<T = unknown>(
    name: string,
    args?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<FacadeCallResult<T>>;
  listTools(): Promise<string[]>;
  /** Shim stderr (endpoint-miss errors land here). */
  shimStderr(): string;
  close(): Promise<void>;
}

export async function connectExternalAgent(endpointFile: string): Promise<ExternalAgent> {
  let shimErr = "";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_SHIM_PATH],
    env: {
      ...getDefaultEnvironment(),
      OPENREEL_MCP_ENDPOINT_FILE: endpointFile,
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer) => {
    shimErr += chunk.toString("utf8");
  });

  const client = new Client(
    { name: "openreel-e2e-external-agent", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);

  return {
    client,

    async callTool(name, args = {}, options = {}) {
      const result = await client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: options.timeoutMs ?? 120_000 },
      );
      const structured = (result as { structuredContent?: unknown }).structuredContent;
      const textBlock = Array.isArray(result.content)
        ? result.content.find((c) => c.type === "text")
        : undefined;
      const parsed =
        structured ??
        (textBlock && "text" in textBlock ? JSON.parse(textBlock.text as string) : undefined);
      const isError = (result as { isError?: boolean }).isError === true;
      return { ...(parsed as object), isError, raw: result } as FacadeCallResult<T>;
    },

    async listTools() {
      const { tools } = await client.listTools();
      return tools.map((t) => t.name);
    },

    shimStderr: () => shimErr,

    async close() {
      await client.close().catch(() => undefined);
    },
  };
}
