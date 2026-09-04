import { lstat, readFile, stat } from "node:fs/promises";
import { z } from "zod";
import type {
  ExternalAgentConnector,
  ExternalAgentNotification,
  ExternalAgentPairing,
  ExternalAgentTransport,
} from "@openreel/agent-facade";
import type {
  ConversationAdapterSummary,
  ConversationCapabilityLevel,
} from "../../shared/conversation";

const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = 35_000;
const POLL_RETRY_MS = 600;
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

const descriptorSchema = z.object({
  version: z.literal(1),
  transport: z.literal("http-jsonrpc-long-poll"),
  endpoint: z.string().min(1).max(2_048),
  token: z.string().min(16).max(4_096),
  sessionId: z.string().min(1).max(512),
  agent: z.object({
    name: z.string().min(1).max(256),
    version: z.string().min(1).max(128).optional(),
  }),
  adapter: z.object({
    name: z.string().min(1).max(256),
    capabilityLevel: z.enum(["basic", "streaming", "observable"]),
  }),
});

export interface ConversationEndpointDescriptor {
  readonly version: 1;
  readonly transport: "http-jsonrpc-long-poll";
  readonly endpoint: string;
  readonly token: string;
  readonly sessionId: string;
  readonly agent: { readonly name: string; readonly version?: string };
  readonly adapter: {
    readonly name: string;
    readonly capabilityLevel: ConversationCapabilityLevel;
  };
}

export class ConversationDescriptorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationDescriptorError";
  }
}

function safeMessage(error: unknown): string {
  if (error instanceof ConversationDescriptorError) return error.message;
  if (error instanceof Error && error.name === "AbortError") {
    return "The external Agent adapter timed out";
  }
  return "The external Agent adapter is unavailable";
}

function validateLoopbackEndpoint(raw: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new ConversationDescriptorError("Adapter endpoint is not a valid URL");
  }
  if (endpoint.protocol !== "http:") {
    throw new ConversationDescriptorError("Adapter endpoint must use loopback HTTP");
  }
  if (endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "[::1]") {
    throw new ConversationDescriptorError("Adapter endpoint must use a loopback IP");
  }
  if (endpoint.username || endpoint.password || endpoint.hash) {
    throw new ConversationDescriptorError("Adapter endpoint URL contains forbidden credentials");
  }
  if (endpoint.pathname !== "/conversation" || endpoint.search) {
    throw new ConversationDescriptorError("Adapter endpoint must use the /conversation path");
  }
  return endpoint.toString();
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > MAX_RESPONSE_BYTES) {
    throw new ConversationDescriptorError("Adapter response is too large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ConversationDescriptorError("Adapter response is too large");
      }
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function safeJsonRpcEnvelope(value: unknown, requestId: number): unknown {
  if (
    !isRecord(value) ||
    value.jsonrpc !== "2.0" ||
    value.id !== requestId ||
    (("result" in value) === ("error" in value))
  ) {
    throw new ConversationDescriptorError("Adapter returned an invalid JSON-RPC response");
  }
  if (!("error" in value)) return value;
  const error = isRecord(value.error) ? value.error : {};
  const code =
    typeof error.code === "string" || typeof error.code === "number"
      ? error.code
      : "ADAPTER_ERROR";
  return {
    jsonrpc: "2.0",
    id: requestId,
    error: { code, message: "External Agent request failed" },
  };
}

async function assertPrivateRegularFile(filePath: string): Promise<void> {
  const linkInfo = await lstat(filePath);
  if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) {
    throw new ConversationDescriptorError("Adapter descriptor must be a regular file");
  }
  if (linkInfo.size > MAX_DESCRIPTOR_BYTES) {
    throw new ConversationDescriptorError("Adapter descriptor is too large");
  }
  if (process.platform !== "win32") {
    if ((linkInfo.mode & 0o077) !== 0) {
      throw new ConversationDescriptorError("Adapter descriptor permissions must be 0600");
    }
    if (typeof process.getuid === "function" && linkInfo.uid !== process.getuid()) {
      throw new ConversationDescriptorError("Adapter descriptor must be owned by the current user");
    }
  }
}

export async function readConversationEndpointDescriptor(
  filePath: string,
): Promise<ConversationEndpointDescriptor> {
  try {
    await assertPrivateRegularFile(filePath);
    const current = await stat(filePath);
    if (current.size > MAX_DESCRIPTOR_BYTES) {
      throw new ConversationDescriptorError("Adapter descriptor is too large");
    }
    const raw = await readFile(filePath, "utf8");
    const parsed = descriptorSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      throw new ConversationDescriptorError("Adapter descriptor has an unsupported shape");
    }
    return {
      ...parsed.data,
      endpoint: validateLoopbackEndpoint(parsed.data.endpoint),
    };
  } catch (error) {
    if (error instanceof ConversationDescriptorError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConversationDescriptorError("No external Agent adapter is configured");
    }
    if (error instanceof SyntaxError) {
      throw new ConversationDescriptorError("Adapter descriptor is not valid JSON");
    }
    throw new ConversationDescriptorError("Could not read the external Agent adapter descriptor");
  }
}

export function descriptorSummary(
  descriptor: ConversationEndpointDescriptor,
): ConversationAdapterSummary {
  return {
    availability: "available",
    agentLabel: descriptor.agent.name,
    adapterName: descriptor.adapter.name,
    sessionId: descriptor.sessionId,
    capabilityLevel: descriptor.adapter.capabilityLevel,
    message: null,
  };
}

function combineSignals(
  parents: readonly (AbortSignal | undefined)[],
  timeoutMs: number | undefined,
): {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  const timeout =
    timeoutMs === undefined
      ? null
      : setTimeout(() => controller.abort(), timeoutMs);
  timeout?.unref?.();
  const abort = (): void => controller.abort();
  for (const parent of parents) {
    if (parent?.aborted) controller.abort();
    else parent?.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      if (timeout !== null) clearTimeout(timeout);
      for (const parent of parents) parent?.removeEventListener("abort", abort);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pollNotifications(value: unknown): {
  readonly cursor?: string | number;
  readonly notifications: readonly ExternalAgentNotification[];
} {
  const result = isRecord(value) && "result" in value ? value.result : value;
  if (!isRecord(result) || !Array.isArray(result.notifications)) {
    throw new ConversationDescriptorError("Adapter returned an invalid event batch");
  }
  const notifications = result.notifications.filter(
    (item): item is ExternalAgentNotification =>
      isRecord(item) && typeof item.method === "string",
  );
  const cursor = result.cursor;
  return {
    notifications,
    ...(typeof cursor === "string" || typeof cursor === "number"
      ? { cursor }
      : {}),
  };
}

class LoopbackConversationTransport implements ExternalAgentTransport {
  private readonly notificationListeners = new Set<
    (notification: ExternalAgentNotification) => void
  >();
  private readonly closeListeners = new Set<(error?: unknown) => void>();
  private readonly closeController = new AbortController();
  private nextId = 1;
  private pollStarted = false;
  private pollRequested = false;
  private initialized = false;
  private closed = false;
  private cursor: string | number | undefined;

  constructor(private readonly descriptor: ConversationEndpointDescriptor) {}

  async request<T = unknown>(
    method: string,
    params: unknown,
    options?: { readonly signal?: AbortSignal },
  ): Promise<T> {
    const result = (await this.post(
      method,
      params,
      options?.signal,
      // A prompt is allowed to settle only when the remote turn completes.
      // It remains bounded by explicit caller cancellation, detach, transport
      // close, and fatal poll failure—not an arbitrary wall-clock deadline.
      method === "session/prompt" ? undefined : REQUEST_TIMEOUT_MS,
    )) as T;
    if (method === "initialize") {
      this.initialized = true;
      this.startPollingIfReady();
    }
    return result;
  }

  async notify(method: string, params: unknown): Promise<void> {
    await this.post(method, params, undefined, REQUEST_TIMEOUT_MS, true);
  }

  onNotification(
    listener: (notification: ExternalAgentNotification) => void,
  ): () => void {
    this.notificationListeners.add(listener);
    this.pollRequested = true;
    this.startPollingIfReady();
    return () => this.notificationListeners.delete(listener);
  }

  onClose(listener: (error?: unknown) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closeController.abort();
    this.notificationListeners.clear();
    this.closeListeners.clear();
  }

  private startPollingIfReady(): void {
    if (!this.pollRequested || !this.initialized || this.pollStarted || this.closed) {
      return;
    }
    this.pollStarted = true;
    void this.pollLoop();
  }

  private async post(
    method: string,
    params: unknown,
    parentSignal: AbortSignal | undefined,
    timeoutMs: number | undefined,
    notification = false,
  ): Promise<unknown> {
    if (this.closed) throw new ConversationDescriptorError("Adapter connection is closed");
    const abort = combineSignals(
      [this.closeController.signal, parentSignal],
      timeoutMs,
    );
    try {
      const id = notification ? undefined : this.nextId++;
      const response = await fetch(this.descriptor.endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${this.descriptor.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          ...(id !== undefined ? { id } : {}),
          method,
          params,
        }),
        signal: abort.signal,
      });
      if (!response.ok) {
        throw new ConversationDescriptorError(
          `Adapter request failed with HTTP ${response.status}`,
        );
      }
      if (notification) return undefined;
      const body = await readBoundedResponse(response);
      try {
        return safeJsonRpcEnvelope(JSON.parse(body) as unknown, id as number);
      } catch (error) {
        if (error instanceof ConversationDescriptorError) throw error;
        throw new ConversationDescriptorError("Adapter response is not valid JSON-RPC");
      }
    } finally {
      abort.dispose();
    }
  }

  private async pollLoop(): Promise<void> {
    let failures = 0;
    while (!this.closed) {
      try {
        const response = await this.post(
          "openreel/session/updates",
          {
            sessionId: this.descriptor.sessionId,
            ...(this.cursor !== undefined ? { after: this.cursor } : {}),
            waitMs: 25_000,
          },
          this.closeController.signal,
          POLL_TIMEOUT_MS,
        );
        if (this.closed) return;
        const batch = pollNotifications(response);
        if (batch.cursor !== undefined) this.cursor = batch.cursor;
        for (const notification of batch.notifications) {
          for (const listener of this.notificationListeners) listener(notification);
        }
        failures = 0;
      } catch (error) {
        if (this.closed || this.closeController.signal.aborted) return;
        failures += 1;
        if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) {
          this.closed = true;
          // This is a transport-wide terminal transition. Abort every other
          // request before notifying the bridge; releaseTransport(..., false)
          // correctly assumes the transport has already closed itself.
          this.closeController.abort();
          const displayError = new ConversationDescriptorError(safeMessage(error));
          const closeListeners = [...this.closeListeners];
          this.notificationListeners.clear();
          this.closeListeners.clear();
          for (const listener of closeListeners) listener(displayError);
          return;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, POLL_RETRY_MS);
          timer.unref?.();
        });
      }
    }
  }
}

export function createLoopbackConversationConnector(
  descriptor: ConversationEndpointDescriptor,
): ExternalAgentConnector {
  return {
    async connect(pairing: ExternalAgentPairing): Promise<ExternalAgentTransport> {
      if (pairing.sessionId !== descriptor.sessionId) {
        throw new ConversationDescriptorError("Adapter session does not match the requested session");
      }
      return new LoopbackConversationTransport(descriptor);
    },
  };
}
