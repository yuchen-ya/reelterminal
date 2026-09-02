/**
 * LiveEndpointServer — the token-authenticated loopback MCP endpoint for
 * EXTERNAL agents (ADR 0004 Decision 9). An external agent posts MCP
 * JSON-RPC here; every tools/call runs through the external live facade
 * session hosted in this process.
 *
 * Hardened shape: 127.0.0.1-only bind,
 * POST-only, 4 MB body cap, no GET/SSE. The MCP surface is exactly
 * initialize / ping / tools/list / tools/call:
 *
 *  - tools/list is answered IN MAIN from the facade's own verb list + emitted
 *    JSON Schemas (no renderer round-trip): 15 tools, verb dots mapped to
 *    underscores (editor.get_context → editor_get_context), same envelope
 *    shape agent-transport produces.
 *  - tools/call returns the FacadeResult as ONE text content block plus
 *    verbatim structuredContent, isError: !result.ok (mirror of
 *    agent-transport serve.ts); an unknown tool is a JSON-RPC protocol error.
 *
 * Auth: a 32-byte random bearer token per endpoint lifetime, compared with
 * timingSafeEqual on EVERY request. The endpoint file
 * (~/.openreel/live-endpoint.json, mode 0600) is written on start and
 * deleted on stop. THE TOKEN IS NEVER SENT TO THE RENDERER AND NEVER LOGGED
 * It appears only in the 0600 endpoint file, never in any IPC payload,
 * status object, or response body beyond the file itself.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EMITTED_VERB_JSON_SCHEMAS,
  FACADE_VERBS,
  type FacadeResult,
  type FacadeVerb,
  type JsonSchemaObject,
} from "@openreel/agent-facade";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** MCP protocol versions supported by the live endpoint. */
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
]);

class BodyTooLargeError extends Error {}

/* ------------------------- the 15 facade tools -------------------------- */

export interface LiveTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
}

export function toolNameForVerb(verb: FacadeVerb): string {
  return verb.replace(/\./g, "_");
}

/**
 * One short purpose string per tool (parameter semantics live in the facade
 * schemas, same discipline as agent-transport tools.ts) — live-mode honest:
 * the lifecycle/import verbs exist in the contract but report unavailable.
 */
const TOOL_DESCRIPTIONS: Readonly<Record<FacadeVerb, string>> = {
  "session.describe":
    "Describe this live collaboration session: runtime, the 15 verbs, error codes, mode and writer state.",
  "capabilities.get":
    "Report live provider capabilities (preview, export, verify) with honest reasons when unavailable.",
  "project.create":
    "Unavailable in live mode — the GUI owns the project lifecycle; a live session attaches to the open project.",
  "project.open":
    "Unavailable in live mode — the GUI owns the project lifecycle; a live session attaches to the open project.",
  "project.save":
    "Flush the GUI's autosave/recovery snapshot for the open project and report the current revision; does not write a .openreel project file.",
  "project.get_state":
    "Return the full canonical project state at the current revision.",
  "media.import":
    "Unavailable in live mode — the GUI owns media import; reference already-imported media by mediaId.",
  "timeline.get":
    "Return the compact timeline view (tracks, clips, text overlays) at the current revision.",
  "editor.get_context":
    "Return the live editor context: selection, playhead, time range, canvas point, project/context revisions.",
  "edit.apply":
    "Apply an atomic batch of closed edit ops as ONE undo unit. The revision CAS is unconditional in live mode: an omitted expectedRevision is guarded with the revision of the snapshot the ops were translated against; expectedContextRevision remains optional.",
  "preview.render_frame":
    "Render one frame of the current project snapshot to a PNG artifact and return its reference.",
  "export.start":
    "Start an export job for a snapshot of the current project; returns a jobId immediately.",
  "job.status": "Return the current status of an export job.",
  "job.cancel":
    "Request cooperative cancellation of an export job (idempotent on terminal jobs).",
  "verify.artifact":
    "Verify an artifact under the session artifactRoot with ffprobe/pixel checks and return the report.",
};

function buildLiveTools(): {
  tools: readonly LiveTool[];
  toolToVerb: ReadonlyMap<string, FacadeVerb>;
} {
  const tools: LiveTool[] = [];
  const toolToVerb = new Map<string, FacadeVerb>();
  for (const verb of FACADE_VERBS) {
    const inputSchema = EMITTED_VERB_JSON_SCHEMAS[verb];
    if (inputSchema === undefined) {
      throw new Error(`live endpoint: no emitted JSON schema for verb "${verb}"`);
    }
    const name = toolNameForVerb(verb);
    tools.push({ name, description: TOOL_DESCRIPTIONS[verb], inputSchema });
    toolToVerb.set(name, verb);
  }
  return { tools, toolToVerb };
}

const { tools: LIVE_TOOLS, toolToVerb: LIVE_TOOL_TO_VERB } = buildLiveTools();

/* --------------------------- endpoint file ------------------------------ */

export interface LiveEndpointFile {
  readonly url: string;
  readonly port: number;
  readonly token: string;
}

/**
 * Stable location external clients read (overridable for tests via
 * OPENREEL_LIVE_ENDPOINT_FILE so they never touch the real file).
 */
export function liveEndpointFilePath(): string {
  const override = process.env.OPENREEL_LIVE_ENDPOINT_FILE;
  if (override && override.length > 0) return override;
  return path.join(os.homedir(), ".openreel", "live-endpoint.json");
}

function writeEndpointFile(file: string, endpoint: LiveEndpointFile): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(endpoint, null, 2), { mode: 0o600 });
  // mode in writeFileSync only applies on create; enforce 0600 if it pre-existed.
  try {
    chmodSync(file, 0o600);
  } catch {
    // best-effort
  }
}

function removeEndpointFile(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // best-effort cleanup
  }
}

/* ------------------------------ JSON-RPC -------------------------------- */

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface LiveEndpointOptions {
  /** Routes one facade verb call to the external live session (host-owned). */
  readonly callVerb: (
    verb: FacadeVerb,
    params: unknown,
  ) => Promise<FacadeResult<unknown>>;
  /** Fires on the first initialize / tools/call (externalConnected). */
  readonly onExternalActivity?: () => void;
  readonly serverInfo: { name: string; version: string };
  readonly host?: string;
  /** Defaults to OPENREEL_LIVE_PORT, else a random port. */
  readonly port?: number;
  /** Defaults to liveEndpointFilePath(). */
  readonly endpointFilePath?: string;
}

export interface RunningLiveEndpoint {
  readonly server: Server;
  readonly port: number;
  readonly host: string;
  readonly url: string;
  readonly endpointFile: string;
  /** Stops the server and deletes the endpoint file. */
  close(): Promise<void>;
}

function isNotification(msg: JsonRpcMessage): boolean {
  return msg.id === undefined || msg.id === null;
}

async function handleLiveMessage(
  message: JsonRpcMessage,
  options: LiveEndpointOptions,
): Promise<JsonRpcResponse | null> {
  const id = message.id ?? null;
  const reply = (result: unknown): JsonRpcResponse => ({
    jsonrpc: "2.0",
    id,
    result,
  });
  const fail = (code: number, msg: string): JsonRpcResponse => ({
    jsonrpc: "2.0",
    id,
    error: { code, message: msg },
  });

  try {
    switch (message.method) {
      case "initialize": {
        options.onExternalActivity?.();
        const requested = message.params?.protocolVersion;
        // Echo the client's version only if supported; otherwise negotiate
        // down to the default when the client requests an unknown version.
        const protocolVersion =
          typeof requested === "string" &&
          SUPPORTED_PROTOCOL_VERSIONS.has(requested)
            ? requested
            : DEFAULT_PROTOCOL_VERSION;
        return reply({
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: options.serverInfo,
        });
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: LIVE_TOOLS });
      case "tools/call": {
        options.onExternalActivity?.();
        const name = message.params?.name;
        if (typeof name !== "string" || name.length === 0) {
          return fail(-32602, "Invalid params: missing tool name");
        }
        const verb = LIVE_TOOL_TO_VERB.get(name);
        if (verb === undefined) {
          // Transport-level failure ⇒ protocol error (never a domain result).
          return fail(-32602, `Unknown tool: ${name}`);
        }
        const rawArgs = message.params?.arguments;
        const args =
          rawArgs && typeof rawArgs === "object" ? rawArgs : {};
        const result = await options.callVerb(verb, args);
        // The full FacadeResult JSON as ONE text content block, with
        // structuredContent verbatim; domain failures are isError, never
        // protocol errors.
        return reply({
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
          isError: !result.ok,
        });
      }
      default:
        if (isNotification(message)) return null;
        return fail(
          -32601,
          `Method not found: ${message.method ?? "(none)"}`,
        );
    }
  } catch (error) {
    if (isNotification(message)) return null;
    const msg = error instanceof Error ? error.message : "Internal error";
    return fail(-32603, msg);
  }
}

/* -------------------------------- HTTP ---------------------------------- */

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLargeError("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

function tokenMatches(provided: string | null, expected: string): boolean {
  if (provided === null || expected.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function startLiveEndpointServer(
  options: LiveEndpointOptions,
): Promise<RunningLiveEndpoint> {
  const host = options.host ?? "127.0.0.1";
  // 32 random bytes per endpoint lifetime. Scoped to this closure: it is
  // written only to the 0600 endpoint file — never returned, never logged,
  // never sent to the renderer.
  const token = randomBytes(32).toString("hex");
  const endpointFile = options.endpointFilePath ?? liveEndpointFilePath();

  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }
      // Only the MCP path exists: POSTing anywhere else is a 404, not an
      // implicitly accepted request (the endpoint file advertises /mcp).
      const pathname = new URL(req.url ?? "/", `http://${host}`).pathname;
      if (pathname !== "/mcp") {
        sendJson(res, 404, { error: "Not found" });
        return;
      }
      if (!tokenMatches(bearerToken(req), token)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      try {
        const body = await readBody(req);
        if (!body) {
          sendJson(res, 400, { error: "Empty request body" });
          return;
        }
        const parsed = JSON.parse(body) as JsonRpcMessage | JsonRpcMessage[];
        const response = Array.isArray(parsed)
          ? (
              await Promise.all(
                parsed.map((m) => handleLiveMessage(m, options)),
              )
            ).filter((r) => r !== null)
          : await handleLiveMessage(parsed, options);
        if (
          response === null ||
          (Array.isArray(response) && response.length === 0)
        ) {
          res.writeHead(202).end();
          return;
        }
        sendJson(res, 200, response);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          if (!res.headersSent) {
            sendJson(res, 413, { error: "Request body too large" });
          }
          return;
        }
        const isParse = error instanceof SyntaxError;
        const message = error instanceof Error ? error.message : "Bad request";
        sendJson(res, 400, {
          jsonrpc: "2.0",
          id: null,
          error: { code: isParse ? -32700 : -32600, message },
        });
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    const envPort = Number(process.env.OPENREEL_LIVE_PORT ?? 0);
    const port = options.port ?? (Number.isFinite(envPort) && envPort > 0 ? envPort : 0);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      const address = server.address();
      const boundPort =
        typeof address === "object" && address ? address.port : 0;
      const url = `http://127.0.0.1:${boundPort}/mcp`;
      writeEndpointFile(endpointFile, { url, port: boundPort, token });
      resolve({
        server,
        port: boundPort,
        host,
        url,
        endpointFile,
        close: () =>
          new Promise<void>((resolveClose) => {
            removeEndpointFile(endpointFile);
            server.close(() => resolveClose());
          }),
      });
    });
  });
}
