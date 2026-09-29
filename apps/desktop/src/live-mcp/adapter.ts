#!/usr/bin/env node
/** Explicit stdio MCP adapter over the same live Command API client as reelctl. */
import { createInterface } from "node:readline";
import { LIVE_HEARTBEAT_INTERVAL_MS } from "../shared/live";
import {
  endpointFilePath,
  LiveCliError,
  LiveCommandClient,
  readEndpointCredentials,
  catalogCommand,
  type FacadeResult,
} from "../reelctl/client";
import { validateLoopbackUrl } from "../reelctl/client";

export { endpointFilePath };
export const validateLiveEndpointUrl = (raw: string): URL => validateLoopbackUrl(raw, "live endpoint");
/** Legacy descriptor shape helper retained for migration compatibility tests. */
export const readEndpoint = readEndpointCredentials;

interface RpcMessage {
  readonly jsonrpc?: unknown;
  readonly id?: string | number | null;
  readonly method?: unknown;
  readonly params?: Record<string, unknown>;
}

type JsonRpcResponse = Record<string, unknown>;
type McpProgressToken = string | number;

const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);

const METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "notifications/cancelled",
  "ping",
  "tools/list",
  "tools/call",
]);
const TERMINAL_STATES = new Set(["done", "error", "cancelled"]);
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rpcError(id: RpcMessage["id"], code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function commandResult(result: FacadeResult<unknown>, images: readonly { data: string; mimeType: string }[] = []): JsonRpcResponse {
  const content: Array<Record<string, unknown>> = [{ type: "text", text: JSON.stringify(result) }];
  for (const image of images) content.push({ type: "image", data: image.data, mimeType: image.mimeType });
  return {
    content,
    structuredContent: result,
    isError: !result.ok,
  };
}

function artifactRefs(result: FacadeResult<unknown>): Array<{ path: string; sha256: string }> {
  if (!result.ok || !isRecord(result.value)) return [];
  const value = result.value;
  const refs: Array<{ path: string; sha256: string }> = [];
  const add = (candidate: unknown): void => {
    if (!isRecord(candidate) || candidate.kind !== "image" || typeof candidate.path !== "string" || typeof candidate.sha256 !== "string") return;
    refs.push({ path: candidate.path, sha256: candidate.sha256 });
  };
  add(value.artifact);
  add(value.contactSheet);
  if (Array.isArray(value.frames)) {
    for (const frame of value.frames) {
      if (!isRecord(frame)) continue;
      add(frame.artifact);
      add(frame.regionArtifact);
    }
  }
  return refs.slice(0, 12);
}

async function imagesFor(client: LiveCommandClient, result: FacadeResult<unknown>): Promise<Array<{ data: string; mimeType: string }>> {
  const refs = artifactRefs(result);
  const resultValue = result.ok && isRecord(result.value) ? result.value : undefined;
  const contactSheet = isRecord(resultValue?.contactSheet) ? resultValue.contactSheet : undefined;
  const contactPath = typeof contactSheet?.path === "string" ? contactSheet.path : undefined;
  const hasRegions = Array.isArray(resultValue?.frames) && resultValue.frames.some((frame) => isRecord(frame) && isRecord(frame.regionArtifact));
  const preferred = contactPath !== undefined && !hasRegions ? refs.filter((ref) => ref.path === contactPath) : [];
  const eligible = hasRegions && contactPath !== undefined ? refs.filter((ref) => ref.path !== contactPath) : refs;
  const ordered = [...preferred, ...eligible.filter((ref) => !preferred.includes(ref))];
  const images: Array<{ data: string; mimeType: string }> = [];
  let totalBytes = 0;
  for (const ref of ordered) {
    const image = await client.artifact(ref.path, ref.sha256);
    if (!image) continue;
    const bytes = Buffer.byteLength(image.data);
    if (bytes > MAX_IMAGE_BYTES || totalBytes + bytes > MAX_IMAGE_BYTES * 2) continue;
    totalBytes += bytes;
    images.push(image);
    if (preferred.length > 0 && preferred.includes(ref)) break;
  }
  return images;
}

function progressToken(params: Record<string, unknown> | undefined): McpProgressToken | undefined {
  const meta = params?._meta;
  if (!isRecord(meta)) return undefined;
  const token = meta.progressToken;
  return typeof token === "string" || typeof token === "number" ? token : undefined;
}

function jobInfo(result: FacadeResult<unknown>): { jobId: string; state?: string; percent?: number; phase?: string } | null {
  if (!result.ok || !isRecord(result.value)) return null;
  const jobId = typeof result.value.jobId === "string" ? result.value.jobId : undefined;
  if (!jobId) return null;
  const progress = isRecord(result.value.progress) ? result.value.progress : undefined;
  return {
    jobId,
    ...(typeof result.value.state === "string" ? { state: result.value.state } : {}),
    ...(typeof progress?.percent === "number" ? { percent: progress.percent } : {}),
    ...(typeof progress?.phase === "string" ? { phase: progress.phase.slice(0, 64) } : {}),
  };
}

export async function handleRpc(
  rawMessage: unknown,
  client: LiveCommandClient,
  notify: (message: JsonRpcResponse) => Promise<void> = async () => undefined,
  watchSignal?: AbortSignal,
): Promise<JsonRpcResponse | null> {
  if (!isRecord(rawMessage)) return rpcError(null, -32600, "Invalid JSON-RPC request");
  const message = rawMessage as RpcMessage;
  const id = message.id ?? null;
  const notification = message.id === undefined || message.id === null;
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return notification ? null : rpcError(id, -32600, "Invalid JSON-RPC request");
  }
  if (!METHODS.has(message.method)) return notification ? null : rpcError(id, -32601, `Method not supported: ${message.method}`);
  try {
    switch (message.method) {
      case "initialize":
        await client.status();
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: typeof message.params?.protocolVersion === "string" && SUPPORTED_PROTOCOL_VERSIONS.has(message.params.protocolVersion)
              ? message.params?.protocolVersion
              : "2024-11-05",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "reelctl-live", version: "1.0.0" },
          },
        };
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;
      case "ping":
        await client.status();
        return notification ? null : { jsonrpc: "2.0", id, result: {} };
      case "tools/list": {
        const catalog = await client.catalog();
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: catalog.commands.map((entry) => ({
              name: entry.toolName,
              description: entry.description,
              inputSchema: entry.inputSchema,
              ...(entry.outputSchema === undefined ? {} : { outputSchema: entry.outputSchema }),
            })),
          },
        };
      }
      case "tools/call": {
        const name = message.params?.name;
        if (typeof name !== "string") return rpcError(id, -32602, "Invalid params: missing tool name");
        const catalog = await client.catalog();
        const entry = catalogCommand(catalog, name);
        if (!entry) return rpcError(id, -32602, `Unknown live tool: ${name}`);
        const rawArgs = message.params?.arguments;
        if (rawArgs !== undefined && !isRecord(rawArgs)) return rpcError(id, -32602, "Tool arguments must be an object");
        const args = (rawArgs ?? {}) as Record<string, unknown>;
        const result = await client.command(entry.name, args, {
          retry: entry.retry ?? "never",
          addIdempotencyKey: entry.retry === "idempotent" && Object.prototype.hasOwnProperty.call(entry.inputSchema.properties ?? {}, "idempotencyKey"),
        });
        const images = await imagesFor(client, result);
        const response: JsonRpcResponse = {
          jsonrpc: "2.0",
          id,
          result: commandResult(result, images),
        };
        const token = progressToken(message.params);
        const started = jobInfo(result);
        if (token !== undefined && started !== null && (entry.name === "export.start" || entry.name === "media.analyze_start")) {
          if (watchSignal !== undefined) void watchJob(client, started.jobId, token, notify, watchSignal);
        }
        return response;
      }
  }
  return null;
} catch (error) {
    if (notification) return null;
    const messageText = error instanceof LiveCliError ? error.message : error instanceof Error ? error.message : "Live Command API failure";
    return rpcError(id, -32000, messageText);
  }
}

async function watchJob(
  client: LiveCommandClient,
  jobId: string,
  token: McpProgressToken,
  notify: (message: JsonRpcResponse) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  let lastProgress = -1;
  let lastMessage = "";
  while (!signal.aborted) {
    let status: FacadeResult<unknown>;
    try {
      status = await client.command("job.status", { jobId }, { retry: "safe", signal });
    } catch {
      return;
    }
    if (!status.ok || !isRecord(status.value)) return;
    const info = jobInfo(status);
    if (!info) return;
    const state = typeof info.state === "string" ? info.state : "running";
    const phase = info.phase ?? state;
    const amount = state === "done" ? 1 : state === "queued" ? 0 : Math.max(lastProgress, Math.min(1, Math.max(0, info.percent ?? 0)));
    if (amount !== lastProgress || phase !== lastMessage) {
      lastProgress = amount;
      lastMessage = phase;
      await notify({
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken: token, progress: amount, total: 1, message: phase },
      }).catch(() => undefined);
    }
    if (TERMINAL_STATES.has(state)) return;
    const continuePolling = await new Promise<boolean>((resolve) => {
      if (signal.aborted) return resolve(false);
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve(true);
      }, 1_000);
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve(false);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    if (!continuePolling) return;
  }
}

function writeLine(line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${line}\n`, (error) => error ? reject(error) : resolve());
  });
}

export async function serveMcp(client = new LiveCommandClient()): Promise<void> {
  let outputTail = Promise.resolve();
  const pending = new Set<Promise<void>>();
  const progressAbort = new AbortController();
  const send = (line: string): Promise<void> => {
    const next = outputTail.then(() => writeLine(line));
    outputTail = next.catch(() => undefined);
    return next;
  };
  let heartbeat: ReturnType<typeof setInterval> | undefined = setInterval(() => {
    void client.status(progressAbort.signal).catch(() => undefined);
  }, Math.max(1_000, LIVE_HEARTBEAT_INTERVAL_MS));
  if (typeof heartbeat === "object" && "unref" in heartbeat) heartbeat.unref();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      const tooLarge = send(JSON.stringify(rpcError(null, -32600, "Request exceeds the MCP line limit")));
      pending.add(tooLarge);
      void tooLarge.finally(() => pending.delete(tooLarge));
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      const parseError = send(JSON.stringify(rpcError(null, -32700, "Parse error")));
      pending.add(parseError);
      void parseError.finally(() => pending.delete(parseError));
      return;
    }
    const task = handleRpc(message, client, (notification) => send(JSON.stringify(notification)), progressAbort.signal).then((response) => {
      if (response !== null) return send(JSON.stringify(response));
      return undefined;
    }).catch(() => undefined);
    pending.add(task);
    void task.finally(() => pending.delete(task));
  });
  await new Promise<void>((resolve) => input.once("close", resolve));
  progressAbort.abort();
  await Promise.allSettled([...pending]);
  await outputTail;
  if (heartbeat !== undefined) clearInterval(heartbeat);
  heartbeat = undefined;
}
