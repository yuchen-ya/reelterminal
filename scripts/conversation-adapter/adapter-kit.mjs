/**
 * Small, dependency-free reference adapter for an external Agent.
 *
 * This module owns only an HTTP JSON-RPC carrier and discovery descriptor. It
 * does not create an Agent session, retain history, call MCP, or know about a
 * provider/model. The hooks are the external Agent's boundary.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, isAbsolute, resolve } from "node:path";
import { ENDPOINT_PRODUCT_ID } from "./endpoint-paths.mjs";

export const MAX_REQUEST_BYTES = 256 * 1024;
export const CONVERSATION_ENDPOINT_PATH = "/conversation";
export const CONVERSATION_PROTOCOL_VERSION = "openreel-conversation/1";

const MAX_SESSION_ID_LENGTH = 512;
const MAX_NAME_LENGTH = 256;
const MAX_VERSION_LENGTH = 128;
const MAX_DESCRIPTOR_LENGTH = 64 * 1024;
const MAX_MIRROR_DESCRIPTOR_PATHS = 4;
const CAPABILITY_LEVELS = new Set(["basic", "streaming", "observable"]);
const WORK_MODES = new Set(["guided", "collaborative", "autonomous"]);
const VISUAL_STATE_KINDS = new Set(["keyframe", "delta", "metadata"]);
const VISUAL_STATE_CHANGES = new Set([
  "project",
  "preview",
  "timeline",
  "playhead",
  "selection",
  "references",
]);

class RpcFault extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RpcFault";
    this.code = code;
  }
}

class RequestTooLarge extends Error {
  constructor() {
    super("Request body is too large");
    this.name = "RequestTooLarge";
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRequestId(value) {
  return (
    (typeof value === "string" && value.length > 0 && value.length <= 512) ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}

function isCursor(value) {
  return (
    (typeof value === "string" && value.length <= 512) ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}

function requiredString(value, field, maxLength) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    throw new TypeError(`Invalid ${field}`);
  }
  return value;
}

function optionalString(value, field, maxLength) {
  if (value === undefined) return undefined;
  return requiredString(value, field, maxLength);
}

function normalizeAgent(agent) {
  if (!isRecord(agent)) throw new TypeError("Invalid agent descriptor");
  const name = requiredString(agent.name, "agent name", MAX_NAME_LENGTH);
  const version = optionalString(agent.version, "agent version", MAX_VERSION_LENGTH);
  return { name, ...(version === undefined ? {} : { version }) };
}

function normalizeAdapter(adapter) {
  if (!isRecord(adapter)) throw new TypeError("Invalid adapter descriptor");
  const name = requiredString(adapter.name, "adapter name", MAX_NAME_LENGTH);
  const capabilityLevel = adapter.capabilityLevel;
  if (typeof capabilityLevel !== "string" || !CAPABILITY_LEVELS.has(capabilityLevel)) {
    throw new TypeError("Invalid adapter capability level");
  }
  return { name, capabilityLevel };
}

function normalizeOptions(options) {
  if (!isRecord(options)) throw new TypeError("Adapter options are required");
  const sessionId = requiredString(options.sessionId, "session id", MAX_SESSION_ID_LENGTH);
  const descriptorPath = requiredString(options.descriptorPath, "descriptor path", 4_096);
  const agent = normalizeAgent(options.agent);
  const adapter = normalizeAdapter(options.adapter);
  // N03 compat mirrors: extra legacy-path copies of the descriptor for
  // clients that only read the legacy directory. Written after the primary
  // descriptor exists and removed on close with the same ownership guard.
  const rawMirrors = options.mirrorDescriptorPaths;
  const mirrorDescriptorPaths = rawMirrors === undefined ? [] : rawMirrors;
  if (
    !Array.isArray(mirrorDescriptorPaths) ||
    mirrorDescriptorPaths.length > MAX_MIRROR_DESCRIPTOR_PATHS ||
    mirrorDescriptorPaths.some((candidate) => typeof candidate !== "string" || candidate.length === 0)
  ) {
    throw new TypeError("mirrorDescriptorPaths must be an array of at most 4 path strings");
  }
  for (const name of [
    "onInitialize",
    "onResume",
    "onPrompt",
    "onCancel",
    "onApproval",
    "onWorkMode",
    "onUpdates",
  ]) {
    if (options[name] !== undefined && typeof options[name] !== "function") {
      throw new TypeError(`${name} must be a function`);
    }
  }
  return {
    sessionId,
    descriptorPath: resolve(descriptorPath),
    mirrorDescriptorPaths: mirrorDescriptorPaths.map((candidate) => resolve(candidate)),
    agent,
    adapter,
    onInitialize: options.onInitialize,
    onResume: options.onResume,
    onPrompt: options.onPrompt,
    onCancel: options.onCancel,
    onApproval: options.onApproval,
    onWorkMode: options.onWorkMode,
    onUpdates: options.onUpdates,
  };
}

function conversationCapabilities(capabilityLevel, options) {
  const streaming = capabilityLevel === "streaming" || capabilityLevel === "observable";
  const observable = capabilityLevel === "observable";
  return {
    formalReply: true,
    streaming,
    reasoningSummary: observable,
    toolEvents: observable,
    approval: observable && typeof options.onApproval === "function",
    usage: observable,
    artifact: observable,
    subtask: observable,
  };
}

function defaultInitialize(options) {
  return {
    protocolVersion: CONVERSATION_PROTOCOL_VERSION,
    agentInfo: options.agent,
    sessionCapabilities: {
      resume: true,
      prompt: true,
      cancel: true,
      conversation: conversationCapabilities(options.adapter.capabilityLevel, options),
    },
  };
}

function defaultUpdates(params) {
  return {
    cursor: isRecord(params) && isCursor(params.after) ? params.after : "0",
    notifications: [],
  };
}

function genericHookFailure() {
  // Never include hook exception text: it may contain a token, prompt, path,
  // provider detail, or another secret supplied by the external Agent.
  return new RpcFault(-32000, "External Agent request failed");
}

async function invokeHook(hook, params, fallback) {
  if (!hook) return fallback();
  try {
    const result = await hook(params);
    return result === undefined ? fallback() : result;
  } catch {
    throw genericHookFailure();
  }
}

function requireParams(request) {
  if (!isRecord(request.params)) throw new RpcFault(-32602, "Invalid params");
  return request.params;
}

function requireSession(params, sessionId) {
  if (params.sessionId !== sessionId) throw new RpcFault(-32602, "Invalid params");
}

function requireConversationParams(params, sessionId) {
  requireSession(params, sessionId);
  return params;
}

function normalizeNotifications(result) {
  if (
    !isRecord(result) ||
    !isCursor(result.cursor) ||
    !Array.isArray(result.notifications)
  ) {
    throw new RpcFault(-32001, "External Agent returned an invalid update batch");
  }
  const notifications = result.notifications.map((notification) => {
    if (!isRecord(notification) || typeof notification.method !== "string") {
      throw new RpcFault(-32001, "External Agent returned an invalid update batch");
    }
    return {
      method: notification.method,
      ...(notification.params === undefined ? {} : { params: notification.params }),
    };
  });
  return { cursor: result.cursor, notifications };
}

function validatePromptParams(params, sessionId) {
  requireConversationParams(params, sessionId);
  if (
    !Array.isArray(params.prompt) ||
    params.prompt.some(
      (part) =>
        !isRecord(part) ||
        part.type !== "text" ||
        typeof part.text !== "string",
    )
  ) {
    throw new RpcFault(-32602, "Invalid params");
  }
  if (params.visualState !== undefined) validateVisualState(params.visualState);
  return params;
}

function validBoundedIds(value) {
  return (
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every(
      (item) => typeof item === "string" && item.length > 0 && item.length <= 256,
    )
  );
}

function validRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validRegion(value) {
  return (
    isRecord(value) &&
    [value.x, value.y, value.imageX, value.imageY].every(
      (item) => Number.isSafeInteger(item) && item >= 0 && item <= 2_048,
    ) &&
    [value.width, value.height].every(
      (item) => Number.isSafeInteger(item) && item >= 1 && item <= 2_048,
    )
  );
}

function validAgentReference(value) {
  return (
    isRecord(value) &&
    typeof value.ref === "string" &&
    /^A[1-9]\d{0,8}$/.test(value.ref) &&
    Number.isSafeInteger(value.number) &&
    value.number > 0 &&
    ["video", "audio", "text", "media"].includes(value.kind) &&
    typeof value.entityId === "string" &&
    value.entityId.length > 0 &&
    value.entityId.length <= 256 &&
    typeof value.label === "string" &&
    value.label.length <= 512 &&
    isRecord(value.timing) &&
    [value.timing.startSeconds, value.timing.endSeconds].every(
      (item) => item === null || (typeof item === "number" && Number.isFinite(item) && item >= 0),
    ) &&
    validRevision(value.revisionAtMark) &&
    typeof value.stale === "boolean"
  );
}

function validReviewMarker(value) {
  if (
    !isRecord(value) ||
    typeof value.ref !== "string" ||
    !/^R[1-9]\d{0,8}$/.test(value.ref) ||
    !Number.isSafeInteger(value.number) ||
    value.number < 1 ||
    typeof value.id !== "string" ||
    value.id.length < 1 ||
    value.id.length > 256 ||
    !isRecord(value.target) ||
    (value.label !== undefined && (typeof value.label !== "string" || value.label.length > 200))
  ) return false;
  const target = value.target;
  if (target.kind === "asset") return typeof target.mediaId === "string" && target.mediaId.length > 0;
  if (target.kind === "clip") return typeof target.clipId === "string" && target.clipId.length > 0;
  if (target.kind === "text") return typeof target.textClipId === "string" && target.textClipId.length > 0;
  return target.kind === "timeRange" &&
    typeof target.start === "number" && Number.isFinite(target.start) && target.start >= 0 &&
    typeof target.end === "number" && Number.isFinite(target.end) && target.end >= target.start;
}

function validateVisualState(value) {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.stateRef !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(value.stateRef) ||
    (value.baseRef !== undefined &&
      (typeof value.baseRef !== "string" ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(value.baseRef))) ||
    !VISUAL_STATE_KINDS.has(value.kind) ||
    !validRevision(value.projectRevision) ||
    !validRevision(value.contextRevision) ||
    typeof value.playheadSeconds !== "number" ||
    !Number.isFinite(value.playheadSeconds) ||
    value.playheadSeconds < 0 ||
    !validBoundedIds(value.selectedClipIds) ||
    !validBoundedIds(value.selectedTextIds) ||
    !validBoundedIds(value.selectedMediaIds) ||
    (value.projectId !== undefined &&
      (typeof value.projectId !== "string" || value.projectId.length < 1 || value.projectId.length > 256)) ||
    (value.projectName !== undefined &&
      (typeof value.projectName !== "string" || value.projectName.length > 512)) ||
    (value.references !== undefined &&
      (!Array.isArray(value.references) || value.references.length > 64 ||
        !value.references.every(validAgentReference))) ||
    (value.reviewMarkers !== undefined &&
      (!Array.isArray(value.reviewMarkers) || value.reviewMarkers.length > 64 ||
        !value.reviewMarkers.every(validReviewMarker))) ||
    !Array.isArray(value.changed) ||
    value.changed.length > VISUAL_STATE_CHANGES.size ||
    !value.changed.every((item) => VISUAL_STATE_CHANGES.has(item))
  ) {
    throw new RpcFault(-32602, "Invalid params");
  }
  const image = value.image;
  if (value.kind === "metadata") {
    if (image !== undefined) throw new RpcFault(-32602, "Invalid params");
    return;
  }
  if (
    !isRecord(image) ||
    image.type !== "localImage" ||
    typeof image.path !== "string" ||
    image.path.length > 2_048 ||
    !isAbsolute(image.path) ||
    !Number.isSafeInteger(image.width) ||
    image.width < 1 ||
    image.width > 2_048 ||
    !Number.isSafeInteger(image.height) ||
    image.height < 1 ||
    image.height > 2_048 ||
    typeof image.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(image.sha256) ||
    (value.kind === "delta" &&
      (!Array.isArray(image.regions) ||
        image.regions.length < 1 ||
        image.regions.length > 4 ||
        image.regions.some(
          (region) =>
            !validRegion(region) ||
            region.x + region.width > 960 ||
            region.y + region.height > 540 ||
            region.imageX + region.width > image.width ||
            region.imageY + region.height > image.height,
        ))) ||
    (value.kind === "keyframe" && image.regions !== undefined)
  ) {
    throw new RpcFault(-32602, "Invalid params");
  }
}

function validateApprovalParams(params, sessionId) {
  requireConversationParams(params, sessionId);
  if (
    typeof params.requestId !== "string" ||
    params.requestId.length === 0 ||
    (params.decision !== "approved" && params.decision !== "denied")
  ) {
    throw new RpcFault(-32602, "Invalid params");
  }
  return params;
}

function validateWorkModeParams(params, sessionId) {
  requireConversationParams(params, sessionId);
  const context = params.clientContext;
  if (
    !isRecord(context) ||
    !WORK_MODES.has(context.workMode) ||
    !isRecord(context.semantics) ||
    context.semantics.id !== context.workMode ||
    typeof context.semantics.label !== "string" ||
    typeof context.semantics.summary !== "string" ||
    context.semantics.deliveryRequiresExplicitAuthorization !== true
  ) {
    throw new RpcFault(-32602, "Invalid params");
  }
  return params;
}

function validateUpdateParams(params, sessionId) {
  requireConversationParams(params, sessionId);
  if (params.after !== undefined && !isCursor(params.after)) {
    throw new RpcFault(-32602, "Invalid params");
  }
  if (
    params.waitMs !== undefined &&
    (typeof params.waitMs !== "number" ||
      !Number.isSafeInteger(params.waitMs) ||
      params.waitMs < 0 ||
      params.waitMs > 30_000)
  ) {
    throw new RpcFault(-32602, "Invalid params");
  }
  return params;
}

async function dispatch(request, options) {
  const method = request.method;
  switch (method) {
    case "initialize": {
      if (!isRecord(request.params)) throw new RpcFault(-32602, "Invalid params");
      if (
        request.params.protocolVersion !== undefined &&
        request.params.protocolVersion !== CONVERSATION_PROTOCOL_VERSION
      ) {
        throw new RpcFault(-32602, "Unsupported protocol version");
      }
      return invokeHook(
        options.onInitialize,
        request.params,
        () => defaultInitialize(options),
      );
    }
    case "session/resume": {
      const params = requireParams(request);
      requireSession(params, options.sessionId);
      return invokeHook(options.onResume, params, () => ({ sessionId: options.sessionId }));
    }
    case "session/prompt": {
      const params = validatePromptParams(requireParams(request), options.sessionId);
      return invokeHook(options.onPrompt, params, () => ({}));
    }
    case "session/cancel": {
      const params = requireParams(request);
      requireSession(params, options.sessionId);
      await invokeHook(options.onCancel, params, () => undefined);
      return {};
    }
    case "session/approval": {
      if (!options.onApproval) throw new RpcFault(-32601, "Method not found");
      const params = validateApprovalParams(requireParams(request), options.sessionId);
      return invokeHook(options.onApproval, params, () => ({}));
    }
    case "openreel/work_mode": {
      const params = validateWorkModeParams(requireParams(request), options.sessionId);
      return invokeHook(options.onWorkMode, params, () => ({}));
    }
    case "openreel/session/updates": {
      const params = validateUpdateParams(requireParams(request), options.sessionId);
      const result = await invokeHook(options.onUpdates, params, () => defaultUpdates(params));
      return normalizeNotifications(result);
    }
    default:
      throw new RpcFault(-32601, "Method not found");
  }
}

function responseBody(id, result, token) {
  // Hook results are Agent-owned data. Keep the adapter's bearer secret out
  // even if an accidentally broad hook result includes it as a string.
  return JSON.stringify({ jsonrpc: "2.0", id, result }).split(token).join("[redacted]");
}

function errorBody(id, error) {
  const fault = error instanceof RpcFault ? error : genericHookFailure();
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code: fault.code, message: fault.message },
  });
}

function sendJson(response, statusCode, body) {
  const payload = Buffer.from(body, "utf8");
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": payload.byteLength,
    "cache-control": "no-store",
  });
  response.end(payload);
}

function sendNoContent(response) {
  response.writeHead(204, { "cache-control": "no-store" });
  response.end();
}

function authorizationMatches(value, token) {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(typeof value === "string" ? value : "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readRequestBody(request) {
  const contentLength = request.headers["content-length"];
  if (
    contentLength !== undefined &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_REQUEST_BYTES)
  ) {
    throw new RequestTooLarge();
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > MAX_REQUEST_BYTES) throw new RequestTooLarge();
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof RequestTooLarge) throw error;
    throw new RpcFault(-32700, "Parse error");
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

function requestId(request) {
  if (!Object.hasOwn(request, "id") || request.id === undefined) {
    return { notification: true, id: null };
  }
  if (!isRequestId(request.id)) throw new RpcFault(-32600, "Invalid Request");
  return { notification: false, id: request.id };
}

async function writeDescriptor(descriptorPath, descriptor) {
  const parent = dirname(descriptorPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporaryPath = `${descriptorPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const payload = JSON.stringify(descriptor, null, 2) + "\n";
  if (Buffer.byteLength(payload, "utf8") > MAX_DESCRIPTOR_LENGTH) {
    throw new Error("Adapter descriptor is too large");
  }
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(payload, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, descriptorPath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function removeOwnedDescriptor(descriptorPath, endpoint, token) {
  let raw;
  try {
    raw = await readFile(descriptorPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    return;
  }
  let descriptor;
  try {
    descriptor = JSON.parse(raw);
  } catch {
    return;
  }
  // A later adapter atomically replaces the descriptor. Leave that instance
  // untouched when either ownership marker no longer matches.
  if (
    !isRecord(descriptor) ||
    descriptor.endpoint !== endpoint ||
    descriptor.token !== token
  ) {
    return;
  }
  await unlink(descriptorPath).catch(() => undefined);
}

function closeServer(server, sockets) {
  for (const socket of sockets) socket.destroy();
  return new Promise((resolveClose) => {
    server.close(() => resolveClose());
  });
}

/**
 * Start a thin external-Agent conversation carrier.
 *
 * The descriptor shape intentionally mirrors ConversationEndpointDescriptor
 * in the desktop loopback connector: no extra endpoint, model, key, or
 * transcript fields are written. Hooks receive protocol params only.
 */
export async function startConversationAdapter(options) {
  const normalized = normalizeOptions(options);
  const token = randomBytes(32).toString("hex");
  const sockets = new Set();
  let endpoint;
  let closePromise;

  const server = createServer((request, response) => {
    void (async () => {
      if (
        request.method !== "POST" ||
        request.url !== CONVERSATION_ENDPOINT_PATH
      ) {
        response.writeHead(404, { "cache-control": "no-store" });
        response.end();
        return;
      }
      if (!authorizationMatches(request.headers.authorization, token)) {
        sendJson(response, 401, JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      let body;
      try {
        body = await readRequestBody(request);
      } catch (error) {
        if (error instanceof RequestTooLarge) {
          sendJson(response, 413, JSON.stringify({ error: "Request body is too large" }));
          return;
        }
        sendJson(response, 400, errorBody(null, error));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        sendJson(response, 400, errorBody(null, new RpcFault(-32700, "Parse error")));
        return;
      }
      let requestInfo;
      try {
        if (
          !isRecord(parsed) ||
          parsed.jsonrpc !== "2.0" ||
          typeof parsed.method !== "string" ||
          parsed.method.length === 0
        ) {
          throw new RpcFault(-32600, "Invalid Request");
        }
        requestInfo = requestId(parsed);
      } catch (error) {
        sendJson(response, 400, errorBody(null, error));
        return;
      }
      try {
        const result = await dispatch(parsed, normalized);
        if (requestInfo.notification) {
          sendNoContent(response);
          return;
        }
        sendJson(response, 200, responseBody(requestInfo.id, result, token));
      } catch (error) {
        if (requestInfo.notification) {
          sendNoContent(response);
          return;
        }
        sendJson(response, 200, errorBody(requestInfo.id, error));
      }
    })().catch(() => {
      if (!response.headersSent) {
        sendJson(response, 500, errorBody(null, null));
      } else {
        response.destroy();
      }
    });
  });
  server.requestTimeout = 35_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", rejectListen);
        resolveListen();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Adapter did not receive a port");
    endpoint = `http://127.0.0.1:${address.port}${CONVERSATION_ENDPOINT_PATH}`;
    const descriptor = {
      version: 1,
      transport: "http-jsonrpc-long-poll",
      endpoint,
      token,
      sessionId: normalized.sessionId,
      // N03: lets ReelTerminal verify descriptor ownership during
      // legacy-path discovery; readers that predate the field ignore it.
      product: ENDPOINT_PRODUCT_ID,
      agent: normalized.agent,
      adapter: normalized.adapter,
    };
    await writeDescriptor(normalized.descriptorPath, descriptor);
    // Legacy-path mirrors are written after the primary descriptor exists,
    // so a reader that discovers the mirror always finds a live server.
    for (const mirrorPath of normalized.mirrorDescriptorPaths) {
      if (mirrorPath === normalized.descriptorPath) continue;
      try {
        await writeDescriptor(mirrorPath, descriptor);
      } catch (error) {
        // The primary descriptor is published; a failed legacy mirror must
        // not take the adapter down. Best-effort only.
        process.stderr.write(
          `adapter-kit: legacy compat descriptor update failed for ${mirrorPath}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  } catch (error) {
    await closeServer(server, sockets).catch(() => undefined);
    throw error;
  }

  return {
    endpoint,
    descriptorPath: normalized.descriptorPath,
    async close() {
      if (!closePromise) {
        closePromise = (async () => {
          await closeServer(server, sockets).catch(() => undefined);
          await removeOwnedDescriptor(normalized.descriptorPath, endpoint, token);
          for (const mirrorPath of normalized.mirrorDescriptorPaths) {
            if (mirrorPath === normalized.descriptorPath) continue;
            await removeOwnedDescriptor(mirrorPath, endpoint, token);
          }
        })();
      }
      return closePromise;
    },
  };
}
