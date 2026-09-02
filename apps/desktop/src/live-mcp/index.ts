#!/usr/bin/env node
/**
 * openreel-live-mcp — stdio to the external-agent live endpoint.
 *
 * This deliberately forwards only the MCP methods implemented by the
 * 15-tool Slice 3 live endpoint. It never imports a registry, provider,
 * model, keychain, or conversation service. The descriptor is written by
 * the desktop live host while collaboration is enabled:
 *   default: ~/.openreel/live-endpoint.json
 *   override: OPENREEL_LIVE_ENDPOINT_FILE
 */
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

interface RpcMessage {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

interface LiveEndpoint {
  readonly url: string;
  readonly token: string;
}

const LIVE_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "notifications/cancelled",
  "ping",
  "tools/list",
  "tools/call",
]);
const LIVE_TOOL_NAMES = new Set([
  "session_describe",
  "capabilities_get",
  "project_create",
  "project_open",
  "project_save",
  "project_get_state",
  "media_import",
  "timeline_get",
  "editor_get_context",
  "edit_apply",
  "preview_render_frame",
  "export_start",
  "job_status",
  "job_cancel",
  "verify_artifact",
]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const REQUEST_TIMEOUT_MS = 30_000;

/** Fail closed: the descriptor may only target ReelTerminal's local HTTP host. */
export function validateLiveEndpointUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("live endpoint descriptor contains an invalid URL");
  }
  if (
    url.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error("live endpoint must use plain HTTP on a loopback host");
  }
  return url;
}

export function endpointFilePath(): string {
  const override = process.env.OPENREEL_LIVE_ENDPOINT_FILE;
  return override && override.length > 0
    ? override
    : path.join(os.homedir(), ".openreel", "live-endpoint.json");
}

function readEndpoint(): LiveEndpoint {
  const file = endpointFilePath();
  let parsed: Partial<LiveEndpoint>;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<LiveEndpoint>;
  } catch (error) {
    throw new Error(
      `Unable to read live endpoint descriptor at ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed.url !== "string" || !parsed.url || typeof parsed.token !== "string" || !parsed.token) {
    throw new Error(`Invalid live endpoint descriptor at ${file}`);
  }
  validateLiveEndpointUrl(parsed.url);
  return { url: parsed.url, token: parsed.token };
}

export type RpcPoster = (message: RpcMessage) => Promise<unknown>;

function postRpc(endpoint: LiveEndpoint, message: RpcMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = validateLiveEndpointUrl(endpoint.url);
    } catch (error) {
      reject(error);
      return;
    }
    const body = JSON.stringify(message);
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: `Bearer ${endpoint.token}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode === 202 || text.length === 0) {
            resolve(null);
            return;
          }
          if (res.statusCode === undefined || res.statusCode >= 400) {
            // The upstream body may contain project data or internal details;
            // never reflect it into the external Agent's transcript.
            reject(new Error(`live endpoint HTTP ${res.statusCode ?? "unknown"}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error("live endpoint returned invalid JSON"));
          }
        });
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error("live endpoint request timed out"));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** Forward one newline-delimited MCP message, or return null for notifications. */
export async function forwardLine(line: string, post: RpcPoster): Promise<string | null> {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let message: RpcMessage;
  try {
    message = JSON.parse(trimmed) as RpcMessage;
  } catch {
    return null;
  }
  const isNotification = message.id === undefined || message.id === null;
  if (typeof message.method !== "string" || !LIVE_METHODS.has(message.method)) {
    if (isNotification) return null;
    return JSON.stringify({
      jsonrpc: "2.0",
      id: message.id ?? null,
      error: { code: -32601, message: `Method not supported by live endpoint: ${message.method ?? "(none)"}` },
    });
  }
  if (message.method === "tools/call") {
    const name = message.params?.name;
    if (typeof name !== "string" || !LIVE_TOOL_NAMES.has(name)) {
      if (isNotification) return null;
      return JSON.stringify({
        jsonrpc: "2.0",
        id: message.id ?? null,
        error: { code: -32602, message: `Unknown live tool: ${typeof name === "string" ? name : "(none)"}` },
      });
    }
  }
  try {
    const response = await post(message);
    return response === null || response === undefined ? null : JSON.stringify(response);
  } catch (error) {
    if (isNotification) return null;
    return JSON.stringify({
      jsonrpc: "2.0",
      id: message.id ?? null,
      error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
    });
  }
}

function main(): void {
  let endpoint: LiveEndpoint;
  try {
    endpoint = readEndpoint();
  } catch (error) {
    process.stderr.write(
      `openreel-live-mcp: ${error instanceof Error ? error.message : String(error)}\n` +
        "Enable ReelTerminal Agent Session and try again.\n",
    );
    process.exit(1);
  }
  const post: RpcPoster = (message) => postRpc(endpoint, message);
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    void forwardLine(line, post).then((response) => {
      if (response !== null) process.stdout.write(`${response}\n`);
    });
  });
}

if (require.main === module) main();
