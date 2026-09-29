/**
 * Token-authenticated loopback Command API for external local clients.
 * All commands pass through the host's shared live facade session. The API
 * exposes the command catalog, safe editor status, guarded command dispatch,
 * and verified image artifact reads. Credentials are only written to the
 * private endpoint descriptor and never returned in API responses.
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
  renameSync,
  rmSync,
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
import { readVerifiedImageArtifact } from "./artifact-images";
import {
  getCommandCatalog,
  getCommandCatalogEntry,
  FACADE_CONTRACT_VERSION,
  type FacadeErrorCode,
  type FacadeResult,
  type FacadeVerb,
} from "@reelterminal/agent-facade";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const COMMAND_API_VERSION = 1;

class BodyTooLargeError extends Error {}
/* --------------------------- endpoint file ------------------------------ */

export interface LiveEndpointFile {
  /** Deprecated convenience alias for commandApi.url; currently points to /v1. */
  readonly url: string;
  readonly port: number;
  readonly token: string;
  /** Protocol-neutral entry point used by reelctl clients. */
  readonly commandApi: { readonly url: string; readonly version: number };
  /**
   * Allows clients to verify descriptor ownership during legacy-path discovery.
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
 * the meantime is left alone.
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

export interface LiveEndpointOptions {
  /** Routes one facade verb call to the external live session (host-owned). */
  readonly callVerb: (
    verb: FacadeVerb,
    params: unknown,
    guard?: CommandProjectGuard,
  ) => Promise<FacadeResult<unknown>>;
  /** Fires on every authenticated API request. */
  readonly onExternalActivity?: () => void;
  /** Credential-free view of the current editor/session state. */
  readonly getStatus?: () => Promise<CommandStatusSnapshot> | CommandStatusSnapshot;
  /** Product name and version exposed to local clients. */
  readonly serverInfo: { readonly name: string; readonly version: string };
  /** Verified image reads are limited to this facade artifact directory. */
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

export interface CommandProjectGuard {
  readonly expectedProjectId?: string;
  readonly expectedProjectEpoch?: string;
}

export interface CommandStatusSnapshot {
  readonly instanceId: string;
  readonly projectId: string | null;
  readonly projectEpoch: string | null;
  readonly access: "read-only" | "write";
  readonly currentAction: string | null;
  readonly enabled: boolean;
}

export interface RunningLiveEndpoint {
  readonly server: Server;
  readonly port: number;
  readonly host: string;
  /** Command API base URL. Kept as url for older descriptor readers. */
  readonly url: string;
  readonly commandApiUrl: string;
  readonly endpointFile: string;
  /** Stops the server and deletes the endpoint file. */
  close(): Promise<void>;
}

/* -------------------------------- HTTP ---------------------------------- */

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        reject(new BodyTooLargeError("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => {
      if (!tooLarge) reject(error);
    });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function commandFailure(code: FacadeErrorCode, message: string): FacadeResult<never> {
  return { ok: false, error: { code, message } };
}

function defaultCommandStatus(): CommandStatusSnapshot {
  return {
    instanceId: `pid-${process.pid}`,
    projectId: null,
    projectEpoch: null,
    access: "write",
    currentAction: null,
    enabled: true,
  };
}

async function handleCommandApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  options: LiveEndpointOptions,
): Promise<boolean> {
  const statusRoute = pathname === "/v1/status";
  const catalogRoute = pathname === "/v1/catalog";
  const commandRoute = pathname === "/v1/command";
  const catalogEntryRoute = pathname.startsWith("/v1/catalog/");
  const artifactRoute = pathname === "/v1/artifact";
  if (!statusRoute && !catalogRoute && !commandRoute && !catalogEntryRoute && !artifactRoute) return false;

  const allowedMethod = (statusRoute || catalogRoute || catalogEntryRoute || artifactRoute)
    ? req.method === "GET"
    : req.method === "POST";
  if (!allowedMethod) {
    sendJson(res, 405, commandFailure("INVALID_PARAMS", "Method not allowed"));
    return true;
  }
  options.onExternalActivity?.();

  if (statusRoute) {
    const status = options.getStatus
      ? await options.getStatus()
      : defaultCommandStatus();
    sendJson(res, 200, {
      ok: true,
      apiVersion: COMMAND_API_VERSION,
      contractVersion: FACADE_CONTRACT_VERSION,
      serverInfo: options.serverInfo,
      instanceId: status.instanceId,
      projectId: status.projectId,
      projectEpoch: status.projectEpoch,
      access: status.access,
      currentAction: status.currentAction,
      enabled: status.enabled,
    });
    return true;
  }
  if (catalogRoute) {
    const requestedMode = new URL(req.url ?? "/v1/catalog", "http://127.0.0.1").searchParams.get("mode");
    if (requestedMode !== null && requestedMode !== "live") {
      sendJson(res, 400, commandFailure("INVALID_PARAMS", "The desktop endpoint only serves the live command catalog"));
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      apiVersion: COMMAND_API_VERSION,
      contractVersion: FACADE_CONTRACT_VERSION,
      serverInfo: options.serverInfo,
      commands: getCommandCatalog("live"),
    });
    return true;
  }
  if (catalogEntryRoute) {
    let name: string;
    try {
      name = decodeURIComponent(pathname.slice("/v1/catalog/".length));
    } catch {
      sendJson(res, 400, commandFailure("INVALID_PARAMS", "Malformed command name"));
      return true;
    }
    if (!name || name.includes("/")) {
      sendJson(res, 400, commandFailure("INVALID_PARAMS", "Expected one dotted command name"));
      return true;
    }
    const command = getCommandCatalogEntry(name, "live");
    if (!command) {
      sendJson(res, 404, commandFailure("NOT_FOUND", `Unknown command: ${name}`));
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      apiVersion: COMMAND_API_VERSION,
      contractVersion: FACADE_CONTRACT_VERSION,
      serverInfo: options.serverInfo,
      command,
    });
    return true;
  }
  if (artifactRoute) {
    const requestUrl = new URL(req.url ?? "/v1/artifact", "http://127.0.0.1");
    const artifactPath = requestUrl.searchParams.get("path");
    const sha256 = requestUrl.searchParams.get("sha256");
    if (!artifactPath || artifactPath.length > 4096 || !sha256) {
      sendJson(res, 400, commandFailure("INVALID_PARAMS", "Expected artifact path and sha256"));
      return true;
    }
    const artifact = readVerifiedImageArtifact(artifactPath, sha256, options.artifactRoot);
    if (!artifact) {
      sendJson(res, 404, commandFailure("NOT_FOUND", "Verified image artifact was not found"));
      return true;
    }
    res.writeHead(200, {
      "Content-Type": artifact.mimeType,
      "Content-Length": artifact.bytes.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(artifact.bytes);
    return true;
  }

  let body: unknown;
  try {
    const text = await readBody(req);
    if (!text) {
      sendJson(res, 400, commandFailure("INVALID_PARAMS", "Empty request body"));
      return true;
    }
    body = JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      if (!res.headersSent) sendJson(res, 413, commandFailure("INVALID_PARAMS", "Request body too large"));
      return true;
    }
    sendJson(res, 400, commandFailure("INVALID_PARAMS", "Invalid JSON request body"));
    return true;
  }
  if (!isRecord(body)) {
    sendJson(res, 400, commandFailure("INVALID_PARAMS", "Request body must be a JSON object"));
    return true;
  }
  const commandName = body.command;
  if (typeof commandName !== "string" || commandName.length === 0) {
    sendJson(res, 400, commandFailure("INVALID_PARAMS", "Missing command name"));
    return true;
  }
  const command = getCommandCatalogEntry(commandName, "live");
  if (!command) {
    sendJson(res, 404, commandFailure("NOT_FOUND", `Unknown command: ${commandName}`));
    return true;
  }
  const args = body.arguments === undefined ? {} : body.arguments;
  if (!isRecord(args)) {
    sendJson(res, 400, commandFailure("INVALID_PARAMS", "arguments must be a JSON object"));
    return true;
  }
  const expectedProjectId = body.expectedProjectId;
  const expectedProjectEpoch = body.expectedProjectEpoch;
  if (expectedProjectId !== undefined && typeof expectedProjectId !== "string") {
    sendJson(res, 400, commandFailure("INVALID_PARAMS", "expectedProjectId must be a string"));
    return true;
  }
  if (expectedProjectEpoch !== undefined && typeof expectedProjectEpoch !== "string") {
    sendJson(res, 400, commandFailure("INVALID_PARAMS", "expectedProjectEpoch must be a string"));
    return true;
  }

  const guard: CommandProjectGuard = {
    ...(expectedProjectId !== undefined ? { expectedProjectId } : {}),
    ...(expectedProjectEpoch !== undefined ? { expectedProjectEpoch } : {}),
  };
  if (options.getStatus && Object.keys(guard).length > 0) {
    const status = await options.getStatus();
    if (
      (expectedProjectId !== undefined && expectedProjectId !== status.projectId)
      || (expectedProjectEpoch !== undefined && expectedProjectEpoch !== status.projectEpoch)
    ) {
      sendJson(res, 409, commandFailure("CONFLICT", "The open project changed since this request was prepared"));
      return true;
    }
  }
  try {
    const result = await options.callVerb(
      command.name,
      args,
      Object.keys(guard).length > 0 ? guard : undefined,
    );
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, 500, commandFailure("INTERNAL", error instanceof Error ? error.message : "Command failed"));
  }
  return true;
}

export function startLiveEndpointServer(
  options: LiveEndpointOptions,
): Promise<RunningLiveEndpoint> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1") {
    return Promise.reject(new Error("The live Command API may only bind to 127.0.0.1"));
  }
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
      let pathname: string;
      try {
        pathname = new URL(req.url ?? "/", `http://${host}`).pathname;
      } catch {
        sendJson(res, 400, commandFailure("INVALID_PARAMS", "Invalid request URL"));
        return;
      }
      const commandApiPath = pathname === "/v1" || pathname.startsWith("/v1/");
      if (!commandApiPath) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }
      if (!tokenMatches(bearerToken(req), token)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      try {
        const handled = await handleCommandApiRequest(req, res, pathname, options);
        if (!handled && !res.headersSent) sendJson(res, 404, { error: "Not found" });
      } catch (error) {
        if (!res.headersSent) {
          sendJson(res, 500, commandFailure("INTERNAL", error instanceof Error ? error.message : "Command API failed"));
        }
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
      const commandApiUrl = `http://127.0.0.1:${boundPort}/v1`;
      const url = commandApiUrl;
      const descriptor: LiveEndpointFile = {
        url,
        port: boundPort,
        token,
        commandApi: { url: commandApiUrl, version: COMMAND_API_VERSION },
      };
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
          commandApiUrl,
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
