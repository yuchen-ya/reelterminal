#!/usr/bin/env node
/**
 * openreel-live-mcp — stdio to the external-agent live endpoint.
 *
 * This deliberately forwards only the MCP methods and facade-owned tool
 * names implemented by the live endpoint. It never imports a provider,
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
import { FACADE_TOOL_NAMES } from "@reelterminal/agent-facade";
import { LIVE_HEARTBEAT_INTERVAL_MS } from "../shared/live";

interface RpcMessage {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

type McpProgressToken = string | number;

interface LiveJobStatus {
  readonly state: "queued" | "running" | "done" | "error" | "cancelled";
  readonly progress: { readonly percent: number; readonly phase?: string } | null;
}

interface ExportStartedOptions {
  /** Called only after a successful export_start response with a token. */
  readonly onExportStarted?: (jobId: string, progressToken: McpProgressToken) => void;
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
const LIVE_TOOL_NAMES = new Set<string>(FACADE_TOOL_NAMES);
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

export interface ProgressNotification {
  readonly progressToken: McpProgressToken;
  readonly progress: number;
  readonly total: 1;
  readonly message: string;
}

export interface ProgressWatch {
  readonly done: Promise<void>;
  stop(): void;
}

export interface LiveHeartbeat {
  stop(): void;
}

/**
 * Keep the host-side external writer lease alive while this stdio connector
 * exists. Heartbeats use a private request id and never enter MCP stdout.
 */
export function startLiveHeartbeat(
  post: RpcPoster,
  intervalMs = LIVE_HEARTBEAT_INTERVAL_MS,
): LiveHeartbeat {
  let sequence = 0;
  const timer = setInterval(() => {
    sequence += 1;
    void Promise.resolve()
      .then(() =>
        post({
          jsonrpc: "2.0",
          id: `openreel-heartbeat-${sequence}`,
          method: "ping",
        }),
      )
      .catch(() => undefined);
  }, Math.max(1, intervalMs));
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  return { stop: () => clearInterval(timer) };
}

export interface ProgressWatchOptions {
  readonly jobId: string;
  readonly progressToken: McpProgressToken;
  readonly readStatus: (jobId: string) => Promise<LiveJobStatus | null>;
  readonly notify: (notification: ProgressNotification) => Promise<void>;
  readonly pollMs?: number;
}

const TERMINAL_JOB_STATES = new Set<LiveJobStatus["state"]>([
  "done",
  "error",
  "cancelled",
]);

function boundedProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Poll a live job only when the caller supplied an MCP progress token.
 * Notifications are monotonic and deduplicated by the emitted progress and
 * message, rather than by provider bookkeeping fields which may change while
 * the user-visible percentage stays the same.
 */
export function startProgressWatch(options: ProgressWatchOptions): ProgressWatch {
  const pollMs = Math.max(10, options.pollMs ?? 500);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let releaseWait: (() => void) | null = null;
  let lastProgress = 0;
  let lastMessage: string | null = null;
  let hasNotification = false;

  const wait = (): Promise<void> =>
    new Promise((resolve) => {
      releaseWait = () => {
        releaseWait = null;
        timer = null;
        resolve();
      };
      timer = setTimeout(() => releaseWait?.(), pollMs);
      if (typeof timer === "object" && "unref" in timer) timer.unref();
    });

  const done = (async () => {
    while (!stopped) {
      const status = await Promise.resolve()
        .then(() => options.readStatus(options.jobId))
        .catch(() => null);
      if (stopped || status === null) return;

      let notification: ProgressNotification | null = null;
      if (status.state === "done") {
        notification = {
          progressToken: options.progressToken,
          progress: 1,
          total: 1,
          message: "complete",
        };
      } else if (status.state === "queued") {
        notification = {
          progressToken: options.progressToken,
          progress: 0,
          total: 1,
          message: "queued",
        };
      } else if (status.state === "running" && status.progress !== null) {
        const phase = typeof status.progress.phase === "string" && status.progress.phase.length > 0
          ? status.progress.phase.slice(0, 64)
          : "running";
        notification = {
          progressToken: options.progressToken,
          progress: Math.max(lastProgress, boundedProgress(status.progress.percent)),
          total: 1,
          message: phase,
        };
      }

      if (
        notification !== null &&
        (!hasNotification ||
          notification.progress !== lastProgress ||
          notification.message !== lastMessage)
      ) {
        hasNotification = true;
        lastProgress = notification.progress;
        lastMessage = notification.message;
        await Promise.resolve()
          .then(() => options.notify(notification))
          .catch(() => undefined);
      }
      if (TERMINAL_JOB_STATES.has(status.state)) return;
      await wait();
    }
  })();

  return {
    done,
    stop: () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      releaseWait?.();
    },
  };
}

/** Serialize all connector stdout frames, including asynchronous progress. */
export function createSerializedLineWriter(
  writeLine: (line: string) => Promise<void>,
): (line: string) => Promise<void> {
  let tail = Promise.resolve();
  return (line) => {
    const next = tail.then(() => writeLine(line));
    tail = next.catch(() => undefined);
    return next;
  };
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function progressTokenFor(message: RpcMessage): McpProgressToken | undefined {
  const token = message.params?._meta;
  if (!isRecord(token)) return undefined;
  const value = token.progressToken;
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function exportJobIdFromResponse(response: unknown): string | undefined {
  if (!isRecord(response) || !isRecord(response.result)) return undefined;
  const structured = response.result.structuredContent;
  if (!isRecord(structured) || structured.ok !== true || !isRecord(structured.value)) {
    return undefined;
  }
  const jobId = structured.value.jobId;
  return typeof jobId === "string" && jobId.length > 0 ? jobId : undefined;
}

function jobStatusFromResponse(response: unknown): LiveJobStatus | null {
  if (!isRecord(response) || !isRecord(response.result)) return null;
  const structured = response.result.structuredContent;
  if (!isRecord(structured) || structured.ok !== true || !isRecord(structured.value)) {
    return null;
  }
  const state = structured.value.state;
  if (
    state !== "queued" &&
    state !== "running" &&
    state !== "done" &&
    state !== "error" &&
    state !== "cancelled"
  ) {
    return null;
  }
  const rawProgress = structured.value.progress;
  let progress: LiveJobStatus["progress"] = null;
  if (isRecord(rawProgress) && typeof rawProgress.percent === "number") {
    progress = {
      percent: rawProgress.percent,
      ...(typeof rawProgress.phase === "string" ? { phase: rawProgress.phase } : {}),
    };
  }
  return { state, progress };
}

/** Forward one newline-delimited MCP message, or return null for notifications. */
export async function forwardLine(
  line: string,
  post: RpcPoster,
  options: ExportStartedOptions = {},
): Promise<string | null> {
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
    if (message.method === "tools/call" && message.params?.name === "export_start") {
      const progressToken = progressTokenFor(message);
      const jobId = exportJobIdFromResponse(response);
      if (progressToken !== undefined && jobId !== undefined) {
        // A watcher is best-effort and must never turn a successful tool call
        // into a connector error if its polling setup fails.
        try {
          options.onExportStarted?.(jobId, progressToken);
        } catch {
          // The main tools/call response remains authoritative.
        }
      }
    }
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
  const heartbeat = startLiveHeartbeat(post);
  const writeLine = createSerializedLineWriter(
    (line) =>
      new Promise<void>((resolve, reject) => {
        process.stdout.write(`${line}\n`, (error) => (error ? reject(error) : resolve()));
      }),
  );
  const progressWatches = new Map<string, ProgressWatch>();
  let closing = false;
  const watchKey = (jobId: string, progressToken: McpProgressToken): string =>
    JSON.stringify([jobId, progressToken]);
  const stopProgressWatches = (): void => {
    closing = true;
    heartbeat.stop();
    for (const watch of progressWatches.values()) watch.stop();
    progressWatches.clear();
  };
  const watchExportProgress = (jobId: string, progressToken: McpProgressToken): void => {
    if (closing) return;
    const key = watchKey(jobId, progressToken);
    progressWatches.get(key)?.stop();
    const watch = startProgressWatch({
      jobId,
      progressToken,
      readStatus: async (id) => {
        const response = await post({
          jsonrpc: "2.0",
          id: `progress-${id}`,
          method: "tools/call",
          params: { name: "job_status", arguments: { jobId: id } },
        });
        return jobStatusFromResponse(response);
      },
      notify: (notification) =>
        writeLine(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: notification,
          }),
        ),
    });
    progressWatches.set(key, watch);
    void watch.done.finally(() => {
      if (progressWatches.get(key) === watch) progressWatches.delete(key);
    });
  };
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    void forwardLine(line, post, { onExportStarted: watchExportProgress }).then((response) => {
      if (response !== null) void writeLine(response);
    });
  });
  rl.on("close", stopProgressWatches);
  process.once("exit", stopProgressWatches);
}

if (require.main === module) main();
