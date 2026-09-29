import { readFileSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  canonicalEndpointPath,
  classifyDescriptorOwnership,
  endpointOverridePath,
  resolveEndpointReadPath,
} from "../shared/endpoint-paths";

const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export interface CommandApiDescriptor {
  readonly url: string;
  readonly version: 1;
}

export interface LiveEndpoint {
  readonly url?: string;
  readonly token: string;
  readonly commandApi: CommandApiDescriptor;
}

export interface LiveStatus {
  readonly ok: true;
  readonly apiVersion: 1;
  readonly instanceId: string;
  readonly projectId: string | null;
  readonly projectEpoch: string | null;
  readonly access?: string | { readonly mode?: string };
  readonly currentAction?: string | null;
  readonly enabled?: boolean;
  readonly [key: string]: unknown;
}

export type FacadeResult<T = unknown> =
  | { readonly ok: true; readonly value: T; readonly [key: string]: unknown }
  | { readonly ok: false; readonly error: { readonly code?: string; readonly message: string; readonly [key: string]: unknown } };

export interface CommandCatalogEntry {
  readonly name: string;
  readonly toolName: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly effects?: readonly string[];
  readonly retry?: "safe" | "idempotent" | "never";
}

export interface CommandCatalog {
  readonly ok: true;
  readonly apiVersion: 1;
  readonly commands: readonly CommandCatalogEntry[];
}

export class LiveCliError extends Error {
  constructor(
    message: string,
    readonly kind: "args" | "connection" | "business",
    readonly exitCode: 2 | 3 | 4,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "LiveCliError";
  }
}

export function endpointFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = endpointOverridePath(env, "live-endpoint");
  return override !== undefined && override.length > 0
    ? override
    : canonicalEndpointPath(os.homedir(), "live-endpoint");
}

export function validateLoopbackUrl(raw: string, label = "live Command API"): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LiveCliError(`${label} descriptor has an invalid URL`, "connection", 4);
  }
  if (
    url.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new LiveCliError(`${label} must use plain HTTP on a loopback host`, "connection", 4);
  }
  return url;
}

function readBoundedDescriptor(file: string): Record<string, unknown> {
  let raw: string;
  try {
    const size = statSync(file).size;
    if (size > MAX_DESCRIPTOR_BYTES) {
      throw new Error("descriptor exceeds the size limit");
    }
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof LiveCliError) throw error;
    throw new LiveCliError(
      `Unable to read live endpoint descriptor at ${file}: ${error instanceof Error ? error.message : "read failed"}`,
      "connection",
      4,
    );
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid descriptor");
    return parsed as Record<string, unknown>;
  } catch {
    throw new LiveCliError(`Invalid live endpoint descriptor at ${file}`, "connection", 4);
  }
}

export function readLiveEndpoint(home?: string): LiveEndpoint {
  const resolution = resolveEndpointReadPath("live-endpoint", {
    env: process.env,
    ...(home === undefined ? {} : { home }),
  });
  if (resolution.conflict) throw new LiveCliError(resolution.conflict, "connection", 4);
  const parsed = readBoundedDescriptor(resolution.path);
  if (classifyDescriptorOwnership("live-endpoint", parsed) === "foreign") {
    throw new LiveCliError(
      `The live endpoint descriptor at ${resolution.path} belongs to another product; set REELTERMINAL_LIVE_ENDPOINT_FILE to a ReelTerminal descriptor.`,
      "connection",
      4,
    );
  }
  if (typeof parsed.token !== "string" || !parsed.token) {
    throw new LiveCliError(`Invalid live endpoint descriptor at ${resolution.path}`, "connection", 4);
  }
  if (typeof parsed.url === "string" && parsed.url.length > 0) validateLoopbackUrl(parsed.url, "live endpoint");
  const commandApi = parsed.commandApi;
  if (
    !commandApi || typeof commandApi !== "object" ||
    typeof (commandApi as Record<string, unknown>).url !== "string" ||
    (commandApi as Record<string, unknown>).version !== 1
  ) {
    throw new LiveCliError(
      "The running ReelTerminal host does not advertise the live Command API yet. Update and restart ReelTerminal, then try again.",
      "connection",
      4,
    );
  }
  const api = commandApi as CommandApiDescriptor;
  const apiUrl = validateLoopbackUrl(api.url);
  if (apiUrl.pathname.replace(/\/$/, "") !== "/v1") {
    throw new LiveCliError("live Command API descriptor must point to /v1", "connection", 4);
  }
  return {
    ...(typeof parsed.url === "string" && parsed.url.length > 0 ? { url: parsed.url } : {}),
    token: parsed.token,
    commandApi: api,
  };
}

/** Compatibility-only reader used by the live-endpoint migration tests. */
export function readEndpointCredentials(home?: string): { readonly url: string; readonly token: string } {
  const resolution = resolveEndpointReadPath("live-endpoint", {
    env: process.env,
    ...(home === undefined ? {} : { home }),
  });
  if (resolution.conflict) throw new LiveCliError(resolution.conflict, "connection", 4);
  const parsed = readBoundedDescriptor(resolution.path);
  if (classifyDescriptorOwnership("live-endpoint", parsed) === "foreign") {
    throw new LiveCliError(`The live endpoint descriptor at ${resolution.path} belongs to another product`, "connection", 4);
  }
  if (typeof parsed.url !== "string" || !parsed.url || typeof parsed.token !== "string" || !parsed.token) {
    throw new LiveCliError(`Invalid live endpoint descriptor at ${resolution.path}`, "connection", 4);
  }
  validateLoopbackUrl(parsed.url, "live endpoint");
  return { url: parsed.url, token: parsed.token };
}

interface RequestOptions {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  readonly unknownCommand?: boolean;
}

function request(endpoint: LiveEndpoint, options: RequestOptions): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let base: URL;
    try {
      base = validateLoopbackUrl(endpoint.commandApi.url);
    } catch (error) {
      reject(error);
      return;
    }
    const basePath = base.pathname.replace(/\/$/, "");
    const requestPath = `${basePath}${options.path}`;
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = httpRequest({
      hostname: base.hostname,
      port: base.port || 80,
      path: requestPath,
      method: options.method,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        }),
        Authorization: `Bearer ${endpoint.token}`,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          reject(new LiveCliError("live Command API response exceeds the size limit", "connection", 4));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode === 409) {
          try {
            const conflict: unknown = JSON.parse(text);
            if (isRecord(conflict) && conflict.ok === false) {
              resolve(conflict);
              return;
            }
          } catch {
            // Never echo arbitrary upstream error bodies into the terminal.
          }
          reject(new LiveCliError("live project changed before the command could run", "business", 3));
          return;
        }
        if (res.statusCode === undefined || res.statusCode < 200 || res.statusCode >= 300) {
          const status = res.statusCode ?? "unknown";
          if (status === 404 && options.unknownCommand) {
            reject(new LiveCliError("command is not available in this ReelTerminal session", "args", 2));
            return;
          }
          if (status === 400 || status === 413) {
            reject(new LiveCliError(
              status === 413 ? "request exceeds the live Command API size limit" : "live Command API rejected the request shape",
              "args",
              2,
            ));
            return;
          }
          const safeMessage = status === 401 ? "live Command API rejected its temporary token" :
            status === 404 ? "live Command API route or command was not found" :
              status === 409 ? "live project changed before the command could run" :
                status === 413 ? "live Command API request is too large" :
                  `live Command API HTTP ${status}`;
          reject(new LiveCliError(safeMessage, "connection", 4));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new LiveCliError("live Command API returned invalid JSON", "connection", 4));
        }
      });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error("live Command API request timed out")));
    req.on("error", (error) => {
      if (error instanceof LiveCliError) reject(error);
      else reject(new LiveCliError(
        error.message.includes("timed out") ? "live Command API request timed out" : "Cannot connect to the running ReelTerminal project",
        "connection",
        4,
        true,
      ));
    });
    req.end(body);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class LiveCommandClient {
  constructor(readonly endpoint: LiveEndpoint = readLiveEndpoint()) {}

  async status(signal?: AbortSignal): Promise<LiveStatus> {
    const result = await request(this.endpoint, { method: "GET", path: "/status", ...(signal === undefined ? {} : { signal }) });
    if (!isRecord(result) || result.ok !== true || result.apiVersion !== 1) {
      throw new LiveCliError("live Command API returned an incompatible status response", "connection", 4);
    }
    return result as unknown as LiveStatus;
  }

  async catalog(mode: "live" | "headless" = "live"): Promise<CommandCatalog> {
    const result = await request(this.endpoint, { method: "GET", path: `/catalog?mode=${mode}` });
    if (!isRecord(result) || result.ok !== true || result.apiVersion !== 1 || !Array.isArray(result.commands)) {
      throw new LiveCliError("live Command API returned an incompatible command catalog", "connection", 4);
    }
    return result as unknown as CommandCatalog;
  }

  async catalogEntry(command: string): Promise<CommandCatalogEntry> {
    const result = await request(this.endpoint, {
      method: "GET",
      path: `/catalog/${encodeURIComponent(command)}`,
      unknownCommand: true,
    });
    if (!isRecord(result) || result.ok !== true || result.apiVersion !== 1 || !isRecord(result.command)) {
      throw new LiveCliError("live Command API returned an incompatible command catalog entry", "connection", 4);
    }
    return result.command as unknown as CommandCatalogEntry;
  }

  async command<T = unknown>(
    command: string,
    args: Record<string, unknown> = {},
    options: {
      readonly retry?: "safe" | "idempotent" | "never";
      readonly addIdempotencyKey?: boolean;
      readonly expectedProjectId?: string;
      readonly expectedProjectEpoch?: string;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<FacadeResult<T>> {
    const status = await this.status(options.signal);
    const input = { ...args };
    const retry = options.retry ?? "never";
    const canKey = options.addIdempotencyKey === true;
    if (retry === "idempotent" && canKey && input.idempotencyKey === undefined) {
      input.idempotencyKey = `reelctl-${cryptoRandomId()}`;
    }
    const body = {
      command,
      arguments: input,
      ...(options.expectedProjectId !== undefined
        ? { expectedProjectId: options.expectedProjectId }
        : typeof status.projectId === "string" ? { expectedProjectId: status.projectId } : {}),
      ...(options.expectedProjectEpoch !== undefined
        ? { expectedProjectEpoch: options.expectedProjectEpoch }
        : typeof status.projectEpoch === "string" ? { expectedProjectEpoch: status.projectEpoch } : {}),
    };
    const hasStableIdempotencyKey = typeof input.idempotencyKey === "string" && input.idempotencyKey.length > 0;
    const attempts = retry === "safe" || retry === "idempotent" && hasStableIdempotencyKey ? 2 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const result = await request(this.endpoint, { method: "POST", path: "/command", body, ...(options.signal === undefined ? {} : { signal: options.signal }) });
        if (!isRecord(result) || typeof result.ok !== "boolean") {
          throw new LiveCliError("live Command API returned an invalid command result", "connection", 4);
        }
        return result as unknown as FacadeResult<T>;
      } catch (error) {
        lastError = error;
        if (options.signal?.aborted) {
          throw new LiveCliError("live Command API request cancelled", "connection", 4);
        }
        // Domain and protocol errors are definitive. Retry only network/timeout failures.
        if (!(error instanceof LiveCliError) || error.kind !== "connection" || !error.retryable || attempt + 1 >= attempts) throw error;
      }
    }
    throw lastError;
  }

  async artifact(pathname: string, sha256: string): Promise<{ readonly data: string; readonly mimeType: "image/png" | "image/jpeg" } | null> {
    if (!/^[a-f0-9]{64}$/i.test(sha256)) return null;
    let base: URL;
    try {
      base = validateLoopbackUrl(this.endpoint.commandApi.url);
    } catch {
      return null;
    }
    const target = `${base.pathname.replace(/\/$/, "")}/artifact?path=${encodeURIComponent(pathname)}&sha256=${encodeURIComponent(sha256)}`;
    return new Promise((resolve) => {
      const req = httpRequest({
        hostname: base.hostname,
        port: base.port || 80,
        path: target,
        method: "GET",
        headers: { Accept: "image/png, image/jpeg", Authorization: `Bearer ${this.endpoint.token}` },
      }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) {
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (res.statusCode !== 200) return resolve(null);
          const mimeType = res.headers["content-type"]?.split(";")[0]?.trim();
          if (mimeType !== "image/png" && mimeType !== "image/jpeg") return resolve(null);
          const bytes = Buffer.concat(chunks);
          const validPng = mimeType === "image/png" && bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a;
          const validJpeg = mimeType === "image/jpeg" && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
          if (!validPng && !validJpeg) return resolve(null);
          resolve({ data: bytes.toString("base64"), mimeType });
        });
      });
      req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy());
      req.on("error", () => resolve(null));
      req.end();
    });
  }
}

function cryptoRandomId(): string {
  return randomUUID();
}

export function catalogCommand(catalog: CommandCatalog, nameOrTool: string): CommandCatalogEntry | undefined {
  return catalog.commands.find((entry) => entry.name === nameOrTool || entry.toolName === nameOrTool);
}

export function hasSchemaProperty(entry: CommandCatalogEntry, property: string): boolean {
  const schema = entry.inputSchema;
  return isRecord(schema.properties) && Object.prototype.hasOwnProperty.call(schema.properties, property);
}

export function defaultOutputDirectory(): string {
  const root = process.env.LOCALAPPDATA || path.join(os.homedir(), ".reelterminal");
  return path.join(root, "ReelTerminal", "cli-results");
}
