/**
 * `agent-video serve` — the MCP stdio server (ADR 0003 Decisions 1/2/5/7).
 *
 * One long-lived stdio MCP server process == one AgentFacadeSession. The
 * public surface is exactly the 14 tools of B.1; every result is the facade
 * `FacadeResult` JSON as a single text content block (B.4), `ok:false` ⇒
 * `isError:true` — domain failures are never JSON-RPC protocol errors and
 * never string-mangled; agents match on `error.code`. Transport-level
 * failures (unknown tool, shutting down) use the JSON-RPC protocol-error
 * channel. The transport owns the ONLY SIGINT/SIGTERM/SIGHUP handlers
 * (Decision 7 — Playwright's own handlers are disabled at launch): the
 * first signal runs the bounded disposal (public job.cancel on every
 * tracked job → provider dispose → flush → exit 130/143/129); a second
 * signal exits immediately; stdin EOF (client disconnect) is the clean
 * shutdown path with exit 0.
 */
import {
  Server,
} from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { FACADE_CONTRACT_VERSION, type FacadeResult } from "@openreel/agent-facade";

import {
  parseArgv,
  resolveConfig,
  mergeEnvRoots,
  mergeEnvLogLevel,
  refuseStartup,
  type TransportConfig,
} from "./config";
import { logError, logInfo, setLogLevel } from "./log";
import { TOOL_TO_VERB, TOOLS, type ToolName } from "./tools";
import { createTransportSession, type TransportSession } from "./session";

export const TRANSPORT_VERSION = "0.1.0";

/** Exit codes mandated by Decision 7 (128 + signal number). */
const SIGNAL_EXIT_CODES: Readonly<Record<string, number>> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
};

const OWNED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export async function serveCommand(argv: readonly string[]): Promise<never> {
  let parsed;
  try {
    parsed = parseArgv(argv);
  } catch (error) {
    refuseStartup(error, "serve");
  }
  let config: TransportConfig;
  try {
    config = await resolveConfig(mergeEnvRoots(parsed.roots), mergeEnvLogLevel(parsed.logLevel));
  } catch (error) {
    refuseStartup(error, "serve");
  }
  setLogLevel(config.logLevel);

  const session: TransportSession = createTransportSession(config);

  // Decision 5: the MCP server's own facts (pid, args, facade contract)
  // ride serverInfo/initialization ONLY — never as capabilities. The
  // capabilities object carries only the standard protocol advertisement.
  // (The SDK's `Implementation` type is name+version+title; the extra
  // fields are deliberate — outgoing results are not schema-stripped by
  // the SDK, and conforming clients ignore unknown serverInfo fields.)
  const serverInfo = {
    name: "agent-video",
    version: TRANSPORT_VERSION,
    title: "OpenReel Agent Video Engine — one process, one facade session",
    pid: process.pid,
    args: [...process.argv.slice(2)],
    facadeContract: FACADE_CONTRACT_VERSION,
  };

  const server = new Server(serverInfo, {
    capabilities: {
      tools: {},
    },
    instructions:
      "One stdio session == one video project. Run capabilities_get first and trust its reasons; poll job_status to a terminal state before disconnecting.",
  });

  let shuttingDown = false;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS as unknown as readonly {
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }[],
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request): Promise<CallToolResult> => {
      const toolName = request.params.name;
      const verb = TOOL_TO_VERB[toolName as ToolName];
      if (verb === undefined) {
        // Transport-level failure ⇒ protocol error (Decision 5).
        throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${toolName}`);
      }
      if (shuttingDown) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          "agent-video is shutting down — no further tool calls are accepted",
        );
      }
      const params: unknown = request.params.arguments ?? {};
      // Facade verbs never throw for domain failures — they return
      // FacadeResult; passthrough is verbatim (Decision 5).
      const call = session.facade[verb] as unknown as (
        p: unknown,
      ) => Promise<FacadeResult<unknown>>;
      const result = await call(params);
      if (verb === "export.start" && result.ok) {
        const value = result.value as { readonly jobId?: unknown };
        if (typeof value?.jobId === "string") {
          session.trackJob(value.jobId);
        }
      }
      logInfo("serve", "tool call", { tool: toolName, ok: result.ok });
      // B.4 envelope: the full FacadeResult JSON as ONE text content block;
      // structuredContent is supported by the pinned SDK (1.30.0
      // CallToolResultSchema carries it) and is populated verbatim too.
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
        isError: !result.ok,
      };
    },
  );

  server.onerror = (error) => {
    // Bad JSON frames and socket-level noise land here; they are transport-
    // level, never confused with domain failures.
    logError("serve", "transport error", {
      error: error instanceof Error ? error.message : String(error),
    });
  };

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logInfo("serve", "MCP stdio server listening", {
    pid: process.pid,
    tools: TOOLS.length,
    contract: FACADE_CONTRACT_VERSION,
    mediaRoots: [...config.mediaRoots],
    artifactRoot: config.artifactRoot,
    projectRoots: [...config.projectRoots],
  });

  let disposalStarted = false;
  const runBoundedShutdown = async (trigger: string, exitCode: number): Promise<void> => {
    if (disposalStarted) return;
    disposalStarted = true;
    shuttingDown = true;
    logInfo("signal", "bounded disposal begins", { trigger, exitCode });
    try {
      await session.dispose(trigger);
    } finally {
      logInfo("signal", "bounded disposal complete, exiting", {
        trigger,
        exitCode,
      });
      process.exit(exitCode);
    }
  };

  // Decision 7: the transport installs the ONLY signal handlers.
  for (const signal of OWNED_SIGNALS) {
    process.on(signal, () => {
      const exitCode = SIGNAL_EXIT_CODES[signal];
      if (disposalStarted) {
        // Second signal: the operator's escape hatch — immediate hard exit,
        // no further cleanup promises (SIGKILL-row residue applies).
        logError("signal", "second signal — immediate hard exit", {
          signal,
          exitCode,
        });
        process.exit(exitCode);
        return;
      }
      logInfo("signal", "first signal received", { signal, exitCode });
      void runBoundedShutdown(signal, exitCode);
    });
  }

  // stdin EOF == client disconnect (Decision 7 cleanup matrix row 3): the
  // same bounded disposal, exit 0. SDK 1.30.0's StdioServerTransport does
  // not watch for EOF itself, so the transport owns this listener too.
  const stdin: NodeJS.ReadableStream = process.stdin;
  const onStdinEnd = (): void => {
    logInfo("signal", "stdin EOF — client disconnected", {});
    void runBoundedShutdown("stdin-eof", 0);
  };
  stdin.once("end", onStdinEnd);
  const onStdinError = (error: Error): void => {
    logError("signal", "stdin error", { error: error.message });
    void runBoundedShutdown("stdin-error", 0);
  };
  stdin.once("error", onStdinError);

  // The server runs until a signal, stdin EOF, or a hard exit above.
  return new Promise<never>(() => {});
}
