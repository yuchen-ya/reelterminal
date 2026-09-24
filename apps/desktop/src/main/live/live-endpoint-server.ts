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
 *    JSON Schemas (no renderer round-trip): registered tools, verb dots mapped to
 *    underscores (editor.get_context → editor_get_context), same envelope
 *    shape agent-transport produces.
 *  - tools/call returns the FacadeResult as ONE text content block plus
 *    verbatim structuredContent, isError: !result.ok (mirror of
 *    agent-transport serve.ts); an unknown tool is a JSON-RPC protocol error.
 *
 * Auth: a 32-byte random bearer token per endpoint lifetime, compared with
 * timingSafeEqual on EVERY request. The endpoint file
 * (~/.reelterminal/live-endpoint.json, mode 0600) is written on start and
 * deleted on stop; a legacy ~/.openreel descriptor that provably belonged
 * to this application family and no longer has a live publisher is
 * atomically updated so old connectors can discover the new host. THE TOKEN
 * IS NEVER SENT TO THE RENDERER AND NEVER LOGGED
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
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { readEnvAlias } from "../../shared/env-alias";
import {
  canonicalEndpointPath,
  describeWritebackDecision,
  endpointOverridePath,
  foreignDescriptorRefusal,
  planLegacyCompatWriteback,
  ENDPOINT_PRODUCT_ID,
} from "../../shared/endpoint-paths";
import {
  toolDescription,
  toolPresentation,
  EMITTED_VERB_JSON_SCHEMAS,
  EMITTED_VERB_OUTPUT_JSON_SCHEMAS,
  FACADE_VERBS,
  FACADE_TOOL_TO_VERB,
  LIVE_VERB_INPUT_SCHEMA_OVERRIDES,
  facadeToolNameForVerb,
  type FacadeToolName,
  type FacadeResult,
  type FacadeVerb,
  type JsonSchemaObject,
} from "@reelterminal/agent-facade";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** MCP protocol versions supported by the live endpoint. */
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
]);

class BodyTooLargeError extends Error {}

const MAX_MCP_IMAGE_BYTES = 8 * 1024 * 1024;

/** Read only facade-verified images (PNG or budget-fitted JPEG) under the host artifact root. */
export function visualImageContent(
  result: FacadeResult<unknown>,
  artifactRoot: string | undefined,
): (
  | { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" }
  | { type: "text"; text: string }
)[] {
  if (!result.ok || artifactRoot === undefined) return [];
  const value = result.value as {
    readonly contactSheet?: { readonly path?: unknown } | null;
    readonly frames?: readonly { readonly artifact?: { readonly path?: unknown }; readonly regionArtifact?: { readonly path?: unknown } }[];
  };
  const contactPath = typeof value.contactSheet?.path === "string"
    ? value.contactSheet.path
    : undefined;
  const framePaths = (value.frames ?? [])
    .flatMap((frame) => [frame.artifact?.path, frame.regionArtifact?.path].filter(Boolean))
    .filter((candidate): candidate is string => typeof candidate === "string")
    .slice(0, 12);
  // Prefer the single sheet, but fall back to frames if that artifact is no
  // longer readable, fails PNG validation, or exceeds the image budget.
  const hasRegions = value.frames?.some((frame) => frame.regionArtifact);
  const paths = hasRegions || contactPath === undefined ? framePaths : [contactPath, ...framePaths];
  let root: string;
  try {
    root = realpathSync(path.resolve(artifactRoot));
  } catch {
    return [];
  }
  const blocks: (
    | { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" }
    | { type: "text"; text: string }
  )[] = [];
  let totalBase64 = 0;
  let skipped = (value.frames ?? []).reduce((count, frame) => count + (frame.regionArtifact ? 2 : 1), 0) > 12;
  for (const filePath of paths) {
    if (!path.isAbsolute(filePath)) {
      skipped = true;
      continue;
    }
    let verified: string;
    try {
      verified = realpathSync(filePath);
    } catch {
      skipped = true;
      continue;
    }
    const rel = path.relative(root, verified);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      skipped = true;
      continue;
    }
    let bytes: Buffer;
    try {
      const info = statSync(verified);
      if (!info.isFile() || info.size === 0 || info.size > MAX_MCP_IMAGE_BYTES) {
        skipped = true;
        continue;
      }
      bytes = readFileSync(verified);
      if (bytes.length === 0 || bytes.length > MAX_MCP_IMAGE_BYTES) {
        skipped = true;
        continue;
      }
    } catch {
      skipped = true;
      continue;
    }
    // Image signature check at the transport boundary: frames are lossless
    // PNG or the facade's budget-fitted JPEG re-encodes.
    const isPng = bytes.length >= 8
      && bytes.readUInt32BE(0) === 0x89504e47
      && bytes.readUInt32BE(4) === 0x0d0a1a0a;
    const isJpeg = bytes.length >= 3
      && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (!isPng && !isJpeg) {
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
    blocks.push({ type: "image", data: encoded, mimeType: isPng ? "image/png" : "image/jpeg" });
    totalBase64 += encoded.length;
    if (contactPath !== undefined && filePath === contactPath) break;
  }
  if (skipped) {
    blocks.push({
      type: "text",
      text: JSON.stringify({
        visualImageLimitation:
          "Some visual image artifacts were not embedded because the MCP image containment, signature, or response-size limit was reached; structuredContent retains every artifact reference.",
      }),
    });
  }
  return blocks;
}

/* ------------------------- registered facade tools -------------------------- */

export interface LiveTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
  /** Successful/failed FacadeResult envelope shape, when declared. */
  readonly outputSchema?: Record<string, unknown>;
}

export function toolNameForVerb(verb: FacadeVerb): FacadeToolName {
  return facadeToolNameForVerb(verb);
}

/**
 * One short purpose string per tool (parameter semantics live in the facade
 * schemas, same discipline as agent-transport tools.ts) — live-mode honest:
 * project lifecycle remains GUI-owned while media import targets the open
 * GUI project through the canonical store bridge.
 */


function buildLiveTools(): {
  tools: readonly LiveTool[];
  toolToVerb: ReadonlyMap<string, FacadeVerb>;
} {
  const tools: LiveTool[] = [];
  const toolToVerb = new Map<string, FacadeVerb>();
  for (const verb of FACADE_VERBS) {
    // Live-honest input surface: live project.save takes no params (the GUI
    // owns the save target) and must not advertise the headless checkpoint
    // schema; every other verb serves the shared facade emission verbatim.
    const inputSchema =
      LIVE_VERB_INPUT_SCHEMA_OVERRIDES[verb] ?? EMITTED_VERB_JSON_SCHEMAS[verb];
    if (inputSchema === undefined) {
      throw new Error(`live endpoint: no emitted JSON schema for verb "${verb}"`);
    }
    const name = toolNameForVerb(verb);
    tools.push({
      name,
      description: toolDescription(verb, "live"),
      inputSchema,
      outputSchema: EMITTED_VERB_OUTPUT_JSON_SCHEMAS[verb] as Readonly<
        Record<string, unknown>
      >,
    });
    toolToVerb.set(name, FACADE_TOOL_TO_VERB[name]);
  }
  return { tools, toolToVerb };
}

const { tools: LIVE_TOOLS, toolToVerb: LIVE_TOOL_TO_VERB } = buildLiveTools();

/* --------------------------- endpoint file ------------------------------ */

export interface LiveEndpointFile {
  readonly url: string;
  readonly port: number;
  readonly token: string;
  /**
   * Written by this host since N03 so clients can verify descriptor
   * ownership during legacy-path discovery. Readers that predate the field
   * ignore it (they read url/port/token only).
   */
  readonly product?: string;
}

export interface LiveEndpointFileResolution {
  readonly file: string;
  /** True when an explicit option or env override chose the path. */
  readonly explicit: boolean;
}

/**
 * Resolve the host's descriptor write target. An explicit option or env
 * override (REELTERMINAL_LIVE_ENDPOINT_FILE, legacy OPENREEL_) is used
 * exactly and disables compat write-back; otherwise the canonical
 * ~/.reelterminal path is served (and a qualifying legacy descriptor is
 * updated for old readers). `home` is injectable for tests.
 */
export function liveEndpointFileResolution(
  explicitPath?: string,
  home = os.homedir(),
): LiveEndpointFileResolution {
  if (explicitPath !== undefined) return { file: explicitPath, explicit: true };
  const override = endpointOverridePath(process.env, "live-endpoint");
  if (override !== undefined && override.length > 0) {
    return { file: override, explicit: true };
  }
  return { file: canonicalEndpointPath(home, "live-endpoint"), explicit: false };
}

function writeEndpointFile(file: string, endpoint: LiveEndpointFile): void {
  const parent = path.dirname(file);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporaryFile = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const payload = `${JSON.stringify({ product: ENDPOINT_PRODUCT_ID, ...endpoint }, null, 2)}\n`;
  let descriptorFd: number | undefined;
  try {
    descriptorFd = openSync(temporaryFile, "wx", 0o600);
    writeFileSync(descriptorFd, payload, "utf8");
    chmodSync(temporaryFile, 0o600);
    fsyncSync(descriptorFd);
    closeSync(descriptorFd);
    descriptorFd = undefined;
    // Publishing is one rename, so a racing connector sees either the old
    // complete descriptor or the new complete descriptor, never partial JSON.
    renameSync(temporaryFile, file);
    chmodSync(file, 0o600);

    // Best-effort directory sync makes the rename crash-durable on platforms
    // that permit opening directories. Descriptor correctness never depends on
    // this optional durability step.
    let parentFd: number | undefined;
    try {
      parentFd = openSync(parent, "r");
      fsyncSync(parentFd);
    } catch {
      // Directory fsync is not supported everywhere (notably Windows).
    } finally {
      if (parentFd !== undefined) closeSync(parentFd);
    }
  } catch (error) {
    if (descriptorFd !== undefined) closeSync(descriptorFd);
    try {
      unlinkSync(temporaryFile);
    } catch {
      // The rename may already have published the descriptor.
    }
    throw error;
  }
}

function removeEndpointFile(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // best-effort cleanup
  }
}

/**
 * Remove a legacy-path descriptor only when it is still the one this host
 * wrote (url and token both match). A file another instance replaced in
 * the meantime is left alone — the same ownership guard the conversation
 * adapter applies on shutdown.
 */
function removeOwnedEndpointFile(
  file: string,
  endpoint: Pick<LiveEndpointFile, "url" | "token">,
): void {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as { url?: unknown }).url === endpoint.url &&
      (parsed as { token?: unknown }).token === endpoint.token
    ) {
      rmSync(file, { force: true });
    }
  } catch {
    // Nothing identifiable to remove.
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
  /** Fires on authenticated initialize, ping, or tools/call activity. */
  readonly onExternalActivity?: () => void;
  readonly serverInfo: { name: string; version: string };
  /** Facade-verified image artifacts may be embedded only from this root. */
  readonly artifactRoot?: string;
  readonly host?: string;
  /** Defaults to REELTERMINAL_LIVE_PORT (legacy OPENREEL_), else random. */
  readonly port?: number;
  /** Defaults to the canonical/overridden endpoint path resolution. */
  readonly endpointFilePath?: string;
  /**
   * Home directory for canonical/legacy endpoint resolution. Injectable so
   * tests never touch the real ~/.reelterminal or ~/.openreel.
   */
  readonly home?: string;
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
        options.onExternalActivity?.();
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
        const content: Array<
          | { type: "text"; text: string }
          | { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" }
        > = [{ type: "text", text: JSON.stringify(result) }];
        if (toolPresentation(verb) === "image-collection" && result.ok) {
          content.push(...visualImageContent(result, options.artifactRoot));
        }
        return reply({
          content,
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
  const endpointResolution = liveEndpointFileResolution(
    options.endpointFilePath,
    options.home,
  );
  const endpointFile = endpointResolution.file;
  // An explicit override that already holds another product's descriptor is
  // a hard startup failure: rewriting it would silently redirect that
  // product's clients to this process (or vice versa).
  if (endpointResolution.explicit) {
    const refusal = foreignDescriptorRefusal("live-endpoint", endpointFile);
    if (refusal !== undefined) return Promise.reject(new Error(refusal));
  }

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
    const envPort = Number(
      readEnvAlias(process.env, "REELTERMINAL_LIVE_PORT", "OPENREEL_LIVE_PORT") ?? 0,
    );
    const port = options.port ?? (Number.isFinite(envPort) && envPort > 0 ? envPort : 0);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      const address = server.address();
      const boundPort =
        typeof address === "object" && address ? address.port : 0;
      const url = `http://127.0.0.1:${boundPort}/mcp`;
      const descriptor: LiveEndpointFile = { url, port: boundPort, token };
      void (async () => {
        try {
          writeEndpointFile(endpointFile, descriptor);
        } catch (error) {
          // A descriptor write failure (e.g. an unwritable home directory)
          // must settle like the bind-failure path ("error" → reject):
          // reject so the caller's enable() can roll back and be retried,
          // and close the half-started server so no listener is left behind.
          server.close();
          reject(error);
          return;
        }
        // N03 compat write-back: when serving from the canonical path, also
        // republish the descriptor at the legacy path IF it holds this
        // application family's descriptor and nothing live is behind it —
        // so connectors that only read ~/.openreel discover the new host.
        // Any other legacy content (foreign product, unidentifiable,
        // still-served) is left untouched with a credential-free log line.
        // Awaited before resolve() so a subsequent close() can remove the
        // mirror deterministically.
        let legacyMirror: string | null = null;
        if (!endpointResolution.explicit) {
          try {
            const plan = await planLegacyCompatWriteback({
              resource: "live-endpoint",
              targetPath: endpointFile,
              explicitTarget: endpointResolution.explicit,
              home: options.home,
            });
            if (plan.writeback) {
              writeEndpointFile(plan.legacyPath, descriptor);
              legacyMirror = plan.legacyPath;
            } else {
              const note = describeWritebackDecision(plan);
              if (note) console.error(`[live-endpoint] ${note}.`);
            }
          } catch (error) {
            // The canonical descriptor is already published; a failed legacy
            // update must not take the running host down.
            console.error(
              `[live-endpoint] legacy compat descriptor update failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
        resolve({
          server,
          port: boundPort,
          host,
          url,
          endpointFile,
          close: () =>
            new Promise<void>((resolveClose) => {
              if (legacyMirror !== null) {
                removeOwnedEndpointFile(legacyMirror, descriptor);
              }
              removeEndpointFile(endpointFile);
              server.close(() => resolveClose());
            }),
        });
      })();
    });
  });
}
