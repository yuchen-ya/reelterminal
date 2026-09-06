import { toolPresentation } from "@openreel/agent-facade";
/**
 * `agent-video serve` — the MCP stdio server (ADR 0003 Decisions 1/2/5/7).
 *
 * One long-lived stdio MCP server process == one AgentFacadeSession. The
 * public surface is the registered tools of the facade contract (including
 * `editor_get_context` and `visual_inspect`); every result is the facade
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
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";

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
import { startJobProgressWatch, type McpProgressToken } from "./progress";

export const TRANSPORT_VERSION = "0.1.0";

/** Exit codes mandated by Decision 7 (128 + signal number). */
const SIGNAL_EXIT_CODES: Readonly<Record<string, number>> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
};

const OWNED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

const MAX_MCP_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Add only the facade-verified contact sheet (or bounded individual frame
 * artifacts on the honest fallback) as MCP image content. The structured
 * result remains the complete machine-readable source of truth.
 */
export async function appendVisualImageContent(
  content: CallToolResult["content"],
  result: FacadeResult<unknown>,
  artifactRoot: string | undefined,
): Promise<void> {
  if (!result.ok || artifactRoot === undefined) return;
  const value = result.value as {
    readonly contactSheet?: { readonly path?: unknown } | null;
    readonly frames?: readonly { readonly artifact?: { readonly path?: unknown }; readonly regionArtifact?: { readonly path?: unknown } }[];
  };
  const contactPath = typeof value.contactSheet?.path === "string"
    ? value.contactSheet.path
    : undefined;
  const framePaths = (value.frames ?? [])
    .flatMap((frame) => [frame.artifact?.path, frame.regionArtifact?.path].filter(Boolean))
    .filter((path): path is string => typeof path === "string")
    .slice(0, 12);
  // Prefer the single sheet, but keep the verified frame artifacts as a
  // recovery path when the sheet was deleted, malformed, or too large.
  const hasRegions = value.frames?.some((frame) => frame.regionArtifact);
  const paths = hasRegions || contactPath === undefined ? framePaths : [contactPath, ...framePaths];
  const root = await realpath(resolvePath(artifactRoot)).catch(() => null);
  if (root === null) return;
  let totalBase64 = 0;
  let skipped = (value.frames ?? []).reduce((count, frame) => count + (frame.regionArtifact ? 2 : 1), 0) > 12;
  for (const filePath of paths) {
    if (!isAbsolute(filePath)) {
      skipped = true;
      continue;
    }
    const verified = await realpath(filePath).catch(() => null);
    if (verified === null) {
      skipped = true;
      continue;
    }
    const rel = relative(root, verified);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      skipped = true;
      continue;
    }
    const fileStat = await stat(verified).catch(() => null);
    if (!fileStat?.isFile() || fileStat.size === 0 || fileStat.size > MAX_MCP_IMAGE_BYTES) {
      skipped = true;
      continue;
    }
    const bytes = await readFile(verified).catch(() => null);
    if (bytes === null || bytes.length === 0 || bytes.length > MAX_MCP_IMAGE_BYTES) {
      skipped = true;
      continue;
    }
    // Re-check the PNG signature at the transport boundary before exposing
    // bytes as an image content block.
    if (
      bytes.length < 8 ||
      bytes.readUInt32BE(0) !== 0x89504e47 ||
      bytes.readUInt32BE(4) !== 0x0d0a1a0a
    ) {
      skipped = true;
      continue;
    }
    const encoded = bytes.toString("base64");
    if (encoded.length > MAX_MCP_IMAGE_BYTES) {
      skipped = true;
      continue;
    }
    if (totalBase64 + encoded.length > MAX_MCP_IMAGE_BYTES * 2) {
      skipped = true;
      break;
    }
    content.push({
      type: "image",
      data: encoded,
      mimeType: "image/png",
    });
    totalBase64 += encoded.length;
    if (contactPath !== undefined && filePath === contactPath) break;
  }
  if (skipped) {
    content.push({
      type: "text",
      text: JSON.stringify({
        visualImageLimitation:
          "Some visual PNG artifacts were not embedded because the MCP image containment, PNG, or response-size limit was reached; structuredContent retains every artifact reference.",
      }),
    });
  }
}

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
  const progressWatches = new Map<string, ReturnType<typeof startJobProgressWatch>>();

  const progressTokenFor = (request: unknown): McpProgressToken | undefined => {
    const token = (request as { params?: { _meta?: { progressToken?: unknown } } }).params?._meta?.progressToken;
    return typeof token === "string" || typeof token === "number" ? token : undefined;
  };

  const watchExportProgress = (jobId: string, progressToken: McpProgressToken): void => {
    progressWatches.get(jobId)?.stop();
    const watch = startJobProgressWatch({
      jobId,
      progressToken,
      readStatus: (id) => session.facade["job.status"]({ jobId: id }),
      notify: ({ progressToken: token, progress, total, message }) =>
        server.notification({
          method: "notifications/progress",
          params: {
            progressToken: token,
            progress,
            total,
            ...(message !== undefined ? { message } : {}),
          },
        }),
    });
    progressWatches.set(jobId, watch);
    void watch.done.finally(() => {
      if (progressWatches.get(jobId) === watch) progressWatches.delete(jobId);
    });
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS as unknown as readonly {
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      outputSchema: Record<string, unknown>;
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
      if ((verb === "export.start" || verb === "media.analyze_start") && result.ok) {
        const value = result.value as { readonly jobId?: unknown };
        if (typeof value?.jobId === "string") {
          session.trackJob(value.jobId);
          const progressToken = progressTokenFor(request);
          if (verb === "export.start" && progressToken !== undefined) {
            watchExportProgress(value.jobId, progressToken);
          }
        }
      }
      logInfo("serve", "tool call", { tool: toolName, ok: result.ok });
      // B.4 envelope: the full FacadeResult JSON as ONE text content block;
      // structuredContent is supported by the pinned SDK (1.30.0
      // CallToolResultSchema carries it) and is populated verbatim too.
      const content: CallToolResult["content"] = [
        { type: "text", text: JSON.stringify(result) },
      ];
      if (toolPresentation(verb) === "image-collection" && result.ok) {
        await appendVisualImageContent(content, result, config.artifactRoot);
      }
      return {
        content,
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

  let disposalStarted = false;
  const runBoundedShutdown = async (trigger: string, exitCode: number): Promise<void> => {
    if (disposalStarted) return;
    disposalStarted = true;
    shuttingDown = true;
    for (const watch of progressWatches.values()) watch.stop();
    progressWatches.clear();
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

  // Readiness means the process can now honor every documented shutdown
  // path. Emit this only after signal and stdin handlers are installed so a
  // client cannot observe "listening" and race into the default OS handler.
  logInfo("serve", "MCP stdio server listening", {
    pid: process.pid,
    tools: TOOLS.length,
    contract: FACADE_CONTRACT_VERSION,
    mediaRoots: [...config.mediaRoots],
    artifactRoot: config.artifactRoot,
    projectRoots: [...config.projectRoots],
  });

  // The server runs until a signal, stdin EOF, or a hard exit above.
  return new Promise<never>(() => {});
}
