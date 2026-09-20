/**
 * Standalone twin of `apps/desktop/src/shared/endpoint-paths.ts` for the
 * dependency-free conversation adapter (N03, docs/NAMING-AND-COMPATIBILITY.md
 * §4 "端点目录迁移"). The adapter cannot import the desktop's TypeScript
 * module (it must run under plain `node scripts/conversation-adapter/…`),
 * so the same resolution order and ownership rules are implemented here and
 * pinned to identical outputs by a cross-side consistency test.
 *
 * Canonical location:  ~/.reelterminal/<resource>
 * Legacy location:     ~/.openreel/<resource> — read-only compat discovery,
 * plus a narrow ownership-checked write-back mirror so old clients that
 * only read the legacy path can still find a new host.
 *
 * Descriptors are credentials: nothing here logs, returns, or echoes
 * descriptor contents, and the liveness probe sends no Authorization header.
 */
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const ENDPOINT_PRODUCT_ID = "reelterminal";
export const ENDPOINT_DIR_NAME = ".reelterminal";
export const LEGACY_ENDPOINT_DIR_NAME = ".openreel";

export const ENDPOINT_RESOURCES = {
  liveEndpoint: "live-endpoint",
  conversationEndpoint: "conversation-endpoint",
  conversationVisualState: "conversation-visual-state",
};

const RESOURCE_NAMES = {
  "live-endpoint": "live-endpoint.json",
  "conversation-endpoint": "conversation-endpoint.json",
  "conversation-visual-state": "conversation-visual-state",
};

const OVERRIDE_ENV_NAMES = {
  "live-endpoint": {
    newName: "REELTERMINAL_LIVE_ENDPOINT_FILE",
    oldName: "OPENREEL_LIVE_ENDPOINT_FILE",
  },
  "conversation-endpoint": {
    newName: "REELTERMINAL_CONVERSATION_ENDPOINT_FILE",
    oldName: "OPENREEL_CONVERSATION_ENDPOINT_FILE",
  },
  "conversation-visual-state": {
    newName: "REELTERMINAL_CONVERSATION_VISUAL_STATE_ROOT",
    oldName: "OPENREEL_CONVERSATION_VISUAL_STATE_ROOT",
  },
};

const MAX_DESCRIPTOR_PROBE_BYTES = 64 * 1024;

export function defaultEndpointHome() {
  return os.homedir();
}

export function canonicalEndpointPath(
  home,
  resource,
) {
  return path.join(home, ENDPOINT_DIR_NAME, RESOURCE_NAMES[resource]);
}

export function legacyEndpointPath(home, resource) {
  return path.join(home, LEGACY_ENDPOINT_DIR_NAME, RESOURCE_NAMES[resource]);
}

export function endpointOverrideEnvNames(resource) {
  return OVERRIDE_ENV_NAMES[resource];
}

/**
 * readEnvAlias semantics: the new REELTERMINAL_* name wins when set (an
 * empty string counts as set), otherwise the legacy OPENREEL_* fallback.
 */
export function endpointOverridePath(env, resource) {
  const { newName, oldName } = OVERRIDE_ENV_NAMES[resource];
  if (env && env[newName] !== undefined) return env[newName];
  return env ? env[oldName] : undefined;
}

function acceptsOverride(resource, value) {
  if (resource === "live-endpoint") return value.length > 0;
  return path.isAbsolute(value);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Shape written by the conversation adapter before N03. */
function matchesLegacyConversationShape(value) {
  return (
    isRecord(value) &&
    value.version === 1 &&
    value.transport === "http-jsonrpc-long-poll" &&
    typeof value.endpoint === "string" &&
    value.endpoint.length > 0 &&
    typeof value.token === "string" &&
    value.token.length > 0 &&
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    isRecord(value.agent) &&
    typeof value.agent.name === "string" &&
    value.agent.name.length > 0 &&
    isRecord(value.adapter) &&
    typeof value.adapter.name === "string" &&
    value.adapter.name.length > 0
  );
}

/** Shape written by live-endpoint-server.ts before N03: {url, port, token}. */
function matchesLegacyLiveShape(value) {
  return (
    isRecord(value) &&
    typeof value.url === "string" &&
    value.url.length > 0 &&
    typeof value.token === "string" &&
    value.token.length > 0 &&
    typeof value.port === "number" &&
    Number.isFinite(value.port)
  );
}

/**
 * Ownership classes mirror the TypeScript module exactly:
 * "product" | "legacy-shape" | "foreign" | "invalid".
 */
export function classifyDescriptorOwnership(resource, parsed) {
  if (!isRecord(parsed)) return "invalid";
  if (typeof parsed.product === "string") {
    return parsed.product === ENDPOINT_PRODUCT_ID ? "product" : "foreign";
  }
  if (resource === "live-endpoint") {
    return matchesLegacyLiveShape(parsed) ? "legacy-shape" : "invalid";
  }
  return matchesLegacyConversationShape(parsed) ? "legacy-shape" : "invalid";
}

export function isOwnedDescriptor(ownership) {
  return ownership === "product" || ownership === "legacy-shape";
}

export function isLoopbackHttpUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return (
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "[::1]" ||
    host === "::1" ||
    host === "0.0.0.0"
  );
}

export function descriptorEndpointUrl(resource, parsed) {
  if (!isRecord(parsed)) return undefined;
  const raw = resource === "live-endpoint" ? parsed.url : parsed.endpoint;
  return typeof raw === "string" && isLoopbackHttpUrl(raw) ? raw : undefined;
}

export function probeDescriptorOwnership(filePath, resource) {
  let raw;
  try {
    const info = readFileSync(filePath);
    if (info.byteLength > MAX_DESCRIPTOR_PROBE_BYTES) return { kind: "unreadable" };
    raw = info.toString("utf8");
  } catch {
    return { kind: "unreadable" };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "ownership", ownership: "invalid" };
  }
  return {
    kind: "ownership",
    ownership: classifyDescriptorOwnership(resource, parsed),
  };
}

function readForeignProductId(filePath) {
  try {
    const info = readFileSync(filePath);
    if (info.byteLength > MAX_DESCRIPTOR_PROBE_BYTES) return undefined;
    const parsed = JSON.parse(info.toString("utf8"));
    if (
      isRecord(parsed) &&
      typeof parsed.product === "string" &&
      parsed.product.length > 0
    ) {
      return parsed.product;
    }
  } catch {
    // Never surface descriptor contents.
  }
  return undefined;
}

/**
 * Refusal message for an explicit host target that already holds another
 * product's descriptor (undefined when absent or owned by this family).
 */
export function foreignDescriptorRefusal(resource, filePath) {
  const probe = probeDescriptorOwnership(filePath, resource);
  if (probe.kind !== "ownership" || probe.ownership !== "foreign") {
    return undefined;
  }
  const foreignProduct = readForeignProductId(filePath) ?? "unknown";
  return foreignOverrideMessage(resource, filePath, foreignProduct);
}

function foreignConflictMessage(resource, canonical, legacy, foreignProduct) {
  const { newName } = OVERRIDE_ENV_NAMES[resource];
  return (
    `Both ${canonical} and ${legacy} exist and the legacy descriptor belongs ` +
    `to another product (product "${foreignProduct}"); set ${newName} to the ` +
    `descriptor path you want instead of relying on default discovery.`
  );
}

function foreignOverrideMessage(resource, filePath, foreignProduct) {
  const { newName } = OVERRIDE_ENV_NAMES[resource];
  return (
    `${filePath} is the descriptor of another product (product ` +
    `"${foreignProduct}"), not ReelTerminal. Point ${newName} at a ` +
    `ReelTerminal endpoint descriptor to connect.`
  );
}

function invalidLegacyMessage(resource, legacy) {
  const { newName } = OVERRIDE_ENV_NAMES[resource];
  return (
    `${legacy} is present but is not a readable ReelTerminal endpoint ` +
    `descriptor; set ${newName} to a descriptor path, or remove the stale ` +
    `file and restart the ReelTerminal host.`
  );
}

/**
 * Resolve the descriptor path a client should read:
 * override → canonical → legacy compat discovery, with foreign-identity
 * conflicts surfaced as `conflict` instead of a silent cross-connect.
 */
export function resolveEndpointReadPath(resource, options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? defaultEndpointHome();
  const exists = options.exists ?? existsSync;
  const override = endpointOverridePath(env, resource);
  if (override !== undefined && acceptsOverride(resource, override)) {
    return { path: override };
  }
  const canonical = canonicalEndpointPath(home, resource);
  const legacy = legacyEndpointPath(home, resource);
  const canonicalExists = exists(canonical);
  const legacyExists = exists(legacy);
  if (canonicalExists && legacyExists) {
    // The visual-state root is a plain directory (no descriptor identity):
    // canonical wins by pure precedence.
    if (resource === "conversation-visual-state") return { path: canonical };
    const probe = probeDescriptorOwnership(legacy, resource);
    if (probe.kind === "ownership" && probe.ownership === "foreign") {
      const foreignProduct = readForeignProductId(legacy);
      return {
        path: canonical,
        conflict: foreignConflictMessage(
          resource,
          canonical,
          legacy,
          foreignProduct ?? "unknown",
        ),
      };
    }
    return { path: canonical };
  }
  if (canonicalExists) return { path: canonical };
  if (legacyExists) {
    if (resource === "conversation-visual-state") {
      return { path: legacy, legacyDiscovery: true };
    }
    const probe = probeDescriptorOwnership(legacy, resource);
    if (probe.kind === "unreadable") {
      return { path: legacy, conflict: invalidLegacyMessage(resource, legacy) };
    }
    if (probe.ownership === "foreign") {
      const foreignProduct = readForeignProductId(legacy);
      return {
        path: legacy,
        conflict: foreignOverrideMessage(
          resource,
          legacy,
          foreignProduct ?? "unknown",
        ),
      };
    }
    if (probe.ownership === "invalid") {
      return { path: legacy, conflict: invalidLegacyMessage(resource, legacy) };
    }
    return { path: legacy, legacyDiscovery: true };
  }
  return { path: canonical };
}

/**
 * Default liveness probe: one GET without any Authorization header. Any
 * HTTP response means a server is still publishing there; the bearer token
 * is never sent, read, or logged.
 */
export async function probeLoopbackEndpointAlive(endpointUrl, timeoutMs = 1_500) {
  if (!isLoopbackHttpUrl(endpointUrl)) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpointUrl, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
    });
    return response.status >= 100 && response.status < 600;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function parseDescriptorForProbe(filePath) {
  try {
    const info = readFileSync(filePath);
    if (info.byteLength > MAX_DESCRIPTOR_PROBE_BYTES) return undefined;
    return JSON.parse(info.toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Decide whether a conversation host publishing `targetPath` should ALSO
 * republish its descriptor at the legacy path. Only an owned and provably
 * dead legacy descriptor is replaced; no secret values are read to decide.
 */
export async function planLegacyCompatWriteback(options) {
  const home = options.home ?? defaultEndpointHome();
  const exists = options.exists ?? existsSync;
  const legacyPath = legacyEndpointPath(home, options.resource);
  if (
    options.explicitTarget ||
    options.targetPath !== canonicalEndpointPath(home, options.resource)
  ) {
    return { writeback: false, reason: "explicit-target", legacyPath };
  }
  if (!exists(legacyPath)) {
    return { writeback: false, reason: "no-legacy", legacyPath };
  }
  const probe = probeDescriptorOwnership(legacyPath, options.resource);
  if (probe.kind === "unreadable") {
    return { writeback: false, reason: "invalid", legacyPath };
  }
  if (probe.ownership === "foreign" || probe.ownership === "invalid") {
    return { writeback: false, reason: probe.ownership, legacyPath };
  }
  const url = descriptorEndpointUrl(
    options.resource,
    parseDescriptorForProbe(legacyPath),
  );
  if (url === undefined) {
    return { writeback: false, reason: "invalid", legacyPath };
  }
  const alive = await (options.probeAlive ?? probeLoopbackEndpointAlive)(url);
  return {
    writeback: !alive,
    reason: alive ? "alive" : "owned-stale",
    legacyPath,
  };
}

/** Credential-free explanation for a declined write-back, for host logs. */
export function describeWritebackDecision(plan) {
  switch (plan.reason) {
    case "alive":
      return (
        `legacy descriptor at ${plan.legacyPath} is still served by a ` +
        `running instance; it was left untouched and the new host serves ` +
        `on its own canonical descriptor only`
      );
    case "foreign":
      return (
        `legacy descriptor at ${plan.legacyPath} belongs to another ` +
        `product; it was left untouched (the host serves on its canonical ` +
        `descriptor)`
      );
    case "invalid":
      return (
        `legacy descriptor at ${plan.legacyPath} could not be identified ` +
        `as a ReelTerminal descriptor; it was left untouched`
      );
    default:
      return undefined;
  }
}
