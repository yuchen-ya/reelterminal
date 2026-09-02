/**
 * External-agent channel: a real stdio MCP client spawning the shipped
 * openreel-live-mcp connector, which forwards to the token-authenticated
 * desktop live endpoint. This is the same path a Codex/Claude-style external
 * Agent takes.
 *
 * The test process NEVER calls the facade in-process; every agent-side verb
 * goes through this client.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { LIVE_MCP_CONNECTOR_PATH } from "./paths";

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
  readonly client: { listTools(): Promise<{ tools: readonly McpTool[] }> };
  callTool<T = unknown>(
    name: string,
    args?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<FacadeCallResult<T>>;
  listTools(): Promise<string[]>;
  /** Connector stderr, captured without exposing the endpoint descriptor. */
  clientStderr(): string;
  /** @deprecated compatibility alias for existing evidence records. */
  shimStderr(): string;
  close(): Promise<void>;
}

interface McpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

interface JsonRpcResult {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly result?: {
    readonly tools?: readonly McpTool[];
    readonly content?: readonly { type?: string; text?: string }[];
    readonly structuredContent?: unknown;
    readonly isError?: boolean;
  };
  readonly error?: { code?: number; message?: string };
}

export async function connectExternalAgent(endpointFile: string): Promise<ExternalAgent> {
  let requestId = 0;
  let connectorErr = "";
  let closed = false;
  const pending = new Map<
    number,
    {
      resolve: (value: JsonRpcResult) => void;
      reject: (reason: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  const connector: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [LIVE_MCP_CONNECTOR_PATH],
    {
      env: {
        ...process.env,
        OPENREEL_LIVE_ENDPOINT_FILE: endpointFile,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  connector.stderr.on("data", (chunk: Buffer) => {
    connectorErr += chunk.toString("utf8");
  });

  const rejectPending = (reason: Error): void => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
    pending.clear();
  };

  connector.once("error", (error) => rejectPending(error));
  connector.once("exit", (code, signal) => {
    closed = true;
    rejectPending(
      new Error(
        `openreel-live-mcp exited before replying (code ${code ?? "null"}, signal ${signal ?? "none"})`,
      ),
    );
  });

  const output = createInterface({ input: connector.stdout });
  output.on("line", (line) => {
    let message: JsonRpcResult;
    try {
      message = JSON.parse(line) as JsonRpcResult;
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(new Error(message.error.message ?? "MCP request failed"));
    } else {
      entry.resolve(message);
    }
  });

  const request = (
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 120_000,
  ): Promise<JsonRpcResult> => {
    if (closed || connector.stdin.destroyed) {
      return Promise.reject(new Error("openreel-live-mcp is not running"));
    }
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      connector.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        (error) => {
          if (!error) return;
          const entry = pending.get(id);
          if (!entry) return;
          pending.delete(id);
          clearTimeout(entry.timer);
          entry.reject(error);
        },
      );
    });
  };

  await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "openreel-e2e-external-agent", version: "0.0.0" },
  });
  connector.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );

  const client = {
    async listTools() {
      const response = await request("tools/list");
      return { tools: response.result?.tools ?? [] };
    },
  };

  return {
    client,

    async callTool(name, args = {}, options = {}) {
      const result = await request(
        "tools/call",
        { name, arguments: args },
        options.timeoutMs ?? 120_000,
      );
      const payload = result.result ?? {};
      const structured = payload.structuredContent;
      const textBlock = Array.isArray(payload.content)
        ? payload.content.find((c) => c.type === "text")
        : undefined;
      const parsed =
        structured ??
        (textBlock && "text" in textBlock ? JSON.parse(textBlock.text as string) : undefined);
      const isError = payload.isError === true;
      return { ...(parsed as object), isError, raw: result } as FacadeCallResult<T>;
    },

    async listTools() {
      const { tools } = await client.listTools();
      return tools.map((t) => t.name);
    },

    clientStderr: () => connectorErr,
    shimStderr: () => connectorErr,

    async close() {
      if (closed) return;
      closed = true;
      output.close();
      connector.stdin.end();
      await new Promise<void>((resolve) => {
        if (connector.exitCode !== null) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          if (connector.exitCode === null) connector.kill("SIGKILL");
          resolve();
        }, 5_000);
        connector.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}
