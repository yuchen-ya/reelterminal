/**
 * Central endpoint-directory resolution for the desktop host and the
 * live-mcp connector (docs/NAMING-AND-COMPATIBILITY.md §4 "端点目录迁移").
 *
 * Canonical location:  ~/.reelterminal/<resource>
 * Legacy location:     ~/.openreel/<resource>
 *
 * Per-resource resolution order:
 *   1. explicit override env (new `REELTERMINAL_*` name first, legacy
 *      `OPENREEL_*` fallback via the shared readEnvAlias semantics);
 *   2. the canonical `~/.reelterminal/` path;
 *   3. compatibility discovery of the legacy `~/.openreel/` path — read-only
 *      positioning, and only when (i) the canonical path does not exist and
 *      (ii) the legacy descriptor passes ownership validation.
 *
 * Descriptor ownership: descriptors written by this application carry
 * `product: "reelterminal"` (added in N03). Descriptors written by earlier
 * versions of this application family have no product field and are
 * recognized by their exact known structure (`legacy-shape`). A descriptor
 * with a different product id is never discovered, never written back, and
 * — for explicit override targets — refuses the operation instead of
 * silently cross-connecting to another product or session.
 *
 * The standalone conversation adapter (scripts/conversation-adapter/) keeps
 * an equivalent inline implementation in endpoint-paths.mjs; a consistency
 * test pins both to the same outputs. Descriptors are credentials: nothing
 * in this module logs, returns, or echoes descriptor contents, and any
 * liveness probe is sent WITHOUT the bearer token.
 */
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readEnvAlias } from "./env-alias";

/** Product identity written into endpoint descriptors by this application. */
export const ENDPOINT_PRODUCT_ID = "reelterminal";

export const ENDPOINT_DIR_NAME = ".reelterminal";
export const LEGACY_ENDPOINT_DIR_NAME = ".openreel";

export type EndpointResource =
  | "live-endpoint"
  | "conversation-endpoint"
  | "conversation-visual-state";

const RESOURCE_NAMES: Record<EndpointResource, string> = {
  "live-endpoint": "live-endpoint.json",
  "conversation-endpoint": "conversation-endpoint.json",
  "conversation-visual-state": "conversation-visual-state",
};

const OVERRIDE_ENV_NAMES: Record<
  EndpointResource,
  { readonly newName: string; readonly oldName: string }
> = {
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

/** Bounded descriptor read: descriptors are small, private JSON files. */
const MAX_DESCRIPTOR_PROBE_BYTES = 64 * 1024;

export function canonicalEndpointPath(
  home: string,
  resource: EndpointResource,
): string {
  return path.join(home, ENDPOINT_DIR_NAME, RESOURCE_NAMES[resource]);
}

export function legacyEndpointPath(
  home: string,
  resource: EndpointResource,
): string {
  return path.join(home, LEGACY_ENDPOINT_DIR_NAME, RESOURCE_NAMES[resource]);
}

export function endpointOverrideEnvNames(
  resource: EndpointResource,
): { readonly newName: string; readonly oldName: string } {
  return OVERRIDE_ENV_NAMES[resource];
}

/**
 * Raw override value with N02 readEnvAlias precedence (new name set wins,
 * empty string counts as set-and-empty). Call sites keep their historical
 * acceptance predicates: the live endpoint accepts any non-empty value,
 * conversation resources require an absolute path.
 */
export function endpointOverridePath(
  env: NodeJS.ProcessEnv,
  resource: EndpointResource,
): string | undefined {
  const { newName, oldName } = OVERRIDE_ENV_NAMES[resource];
  return readEnvAlias(env, newName, oldName);
}

function acceptsOverride(
  resource: EndpointResource,
  value: string,
): boolean {
  if (resource === "live-endpoint") return value.length > 0;
  return path.isAbsolute(value);
}

/* --------------------------- ownership model ----------------------------- */

/**
 * - `product`: the descriptor carries `product: "reelterminal"`.
 * - `legacy-shape`: no product field, but the JSON matches the exact
 *   structure this application family wrote before the product field
 *   existed (pre-N03 ReelTerminal/OpenReel lineage).
 * - `foreign`: carries an explicit `product` id of another application.
 * - `invalid`: not recognizable as any descriptor shape this application
 *   family wrote (unparseable, wrong types, or truncated).
 */
export type DescriptorOwnership =
  | "product"
  | "legacy-shape"
  | "foreign"
  | "invalid";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Shape written by live-endpoint-server.ts before N03: {url, port, token}. */
function matchesLegacyLiveShape(value: unknown): boolean {
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

/** Shape written by the conversation adapter before N03. */
function matchesLegacyConversationShape(value: unknown): boolean {
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

/**
 * Classify a parsed descriptor without looking at secret fields. The
 * product id of a foreign writer is safe to surface in error messages;
 * tokens and URLs never are.
 */
export function classifyDescriptorOwnership(
  resource: EndpointResource,
  parsed: unknown,
): DescriptorOwnership {
  if (!isRecord(parsed)) return "invalid";
  if (typeof parsed.product === "string") {
    return parsed.product === ENDPOINT_PRODUCT_ID ? "product" : "foreign";
  }
  return resource === "live-endpoint"
    ? matchesLegacyLiveShape(parsed)
      ? "legacy-shape"
      : "invalid"
    : matchesLegacyConversationShape(parsed)
      ? "legacy-shape"
      : "invalid";
}

export type DescriptorProbe =
  | { readonly kind: "ownership"; readonly ownership: DescriptorOwnership }
  | { readonly kind: "unreadable" };

/**
 * Read and classify the descriptor at `filePath`. Never throws; never
 * returns descriptor contents. A present-but-unreadable file (permission,
 * size, encoding) probes as `unreadable` so callers can fail closed
 * without overwriting data they could not identify.
 */
export function probeDescriptorOwnership(
  filePath: string,
  resource: EndpointResource,
): DescriptorProbe {
  let raw: string;
  try {
    const info = readFileSync(filePath);
    if (info.byteLength > MAX_DESCRIPTOR_PROBE_BYTES) {
      return { kind: "unreadable" };
    }
    raw = info.toString("utf8");
  } catch {
    return { kind: "unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      kind: "ownership",
      ownership: "invalid",
    };
  }
  return {
    kind: "ownership",
    ownership: classifyDescriptorOwnership(resource, parsed),
  };
}

export function isOwnedDescriptor(
  ownership: DescriptorOwnership,
): boolean {
  return ownership === "product" || ownership === "legacy-shape";
}

/** Loopback-only http(s) URL check; liveness probes never leave the machine. */
export function isLoopbackHttpUrl(raw: string): boolean {
  let url: URL;
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

/** Extract the endpoint URL of a descriptor without exposing any token. */
export function descriptorEndpointUrl(
  resource: EndpointResource,
  parsed: unknown,
): string | undefined {
  if (!isRecord(parsed)) return undefined;
  const raw =
    resource === "live-endpoint" ? parsed.url : parsed.endpoint;
  return typeof raw === "string" && isLoopbackHttpUrl(raw) ? raw : undefined;
}

/* --------------------------- read resolution ----------------------------- */

export interface EndpointPathResolution {
  /** The path a reader should open. */
  readonly path: string;
  /**
   * When set, discovery refused to choose and the reader must fail with
   * this message instead of reading anything (explicit-path guidance).
   */
  readonly conflict?: string;
  /** True when the legacy directory was selected via compat discovery. */
  readonly legacyDiscovery?: boolean;
}

export interface EndpointPathOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly exists?: (candidate: string) => boolean;
}

function foreignConflictMessage(
  resource: EndpointResource,
  canonical: string,
  legacy: string,
  foreignProduct: string,
): string {
  const { newName } = OVERRIDE_ENV_NAMES[resource];
  return (
    `Both ${canonical} and ${legacy} exist and the legacy descriptor belongs ` +
    `to another product (product "${foreignProduct}"); set ${newName} to the ` +
    `descriptor path you want instead of relying on default discovery.`
  );
}

function foreignOverrideMessage(
  resource: EndpointResource,
  filePath: string,
  foreignProduct: string,
): string {
  const { newName } = OVERRIDE_ENV_NAMES[resource];
  return (
    `${filePath} is the descriptor of another product (product ` +
    `"${foreignProduct}"), not ReelTerminal. Point ${newName} at a ` +
    `ReelTerminal endpoint descriptor to connect.`
  );
}

function invalidLegacyMessage(
  resource: EndpointResource,
  legacy: string,
): string {
  const { newName } = OVERRIDE_ENV_NAMES[resource];
  return (
    `${legacy} is present but is not a readable ReelTerminal endpoint ` +
    `descriptor; set ${newName} to a descriptor path, or remove the stale ` +
    `file and restart the ReelTerminal host.`
  );
}

/**
 * Resolve the descriptor path a CLIENT should read:
 * override → canonical → legacy compat discovery, with foreign-identity
 * conflicts surfacing as `conflict` instead of a silent cross-connect.
 */
export function resolveEndpointReadPath(
  resource: EndpointResource,
  options: EndpointPathOptions = {},
): EndpointPathResolution {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
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
    // Canonical wins for anything this application family wrote; a foreign
    // product at the legacy path makes the choice unsafe → explicit path.
    const probe = probeDescriptorOwnership(legacy, resource);
    if (
      probe.kind === "ownership" &&
      probe.ownership === "foreign"
    ) {
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

function readForeignProductId(filePath: string): string | undefined {
  try {
    const info = readFileSync(filePath);
    if (info.byteLength > MAX_DESCRIPTOR_PROBE_BYTES) return undefined;
    const parsed: unknown = JSON.parse(info.toString("utf8"));
    if (
      isRecord(parsed) &&
      typeof parsed.product === "string" &&
      parsed.product.length > 0
    ) {
      return parsed.product;
    }
  } catch {
    // The ownership probe already classified this file; never surface contents.
  }
  return undefined;
}

/**
 * Refusal message for an explicit host target that already holds another
 * product's descriptor: the host must fail loudly instead of silently
 * replacing (and redirecting) another product's endpoint file. Returns
 * undefined when the target is absent or identifiable as this product
 * family's descriptor.
 */
export function foreignDescriptorRefusal(
  resource: EndpointResource,
  filePath: string,
): string | undefined {
  const probe = probeDescriptorOwnership(filePath, resource);
  if (probe.kind !== "ownership" || probe.ownership !== "foreign") {
    return undefined;
  }
  const foreignProduct = readForeignProductId(filePath) ?? "unknown";
  return foreignOverrideMessage(resource, filePath, foreignProduct);
}

/* ------------------------- host compat write-back ------------------------ */

export type CompatWritebackReason =
  | "owned-stale" // write back: legacy holds this app family's dead descriptor
  | "no-legacy" // nothing at the legacy path
  | "alive" // a running instance still serves the legacy endpoint
  | "foreign" // another product's descriptor — never overwrite
  | "invalid" // unidentifiable file — never overwrite
  | "explicit-target"; // host was given an explicit/env target, not the default

export interface CompatWritebackPlan {
  readonly writeback: boolean;
  readonly reason: CompatWritebackReason;
  readonly legacyPath: string;
}

export interface CompatWritebackOptions {
  readonly resource: "live-endpoint" | "conversation-endpoint";
  /** The host's resolved write target (override or canonical). */
  readonly targetPath: string;
  /** True when the target came from an explicit option or env override. */
  readonly explicitTarget: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly exists?: (candidate: string) => boolean;
  readonly probeAlive?: (endpointUrl: string) => Promise<boolean>;
}

/**
 * Default liveness probe: one GET without any Authorization header. Any
 * HTTP response means a server is still publishing on that endpoint; the
 * bearer token is never sent, read, or logged.
 */
export async function probeLoopbackEndpointAlive(
  endpointUrl: string,
  timeoutMs = 1_500,
): Promise<boolean> {
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

/**
 * Decide whether a host that is about to serve `targetPath` should ALSO
 * republish its descriptor at the legacy path so read-only-legacy clients
 * can discover it. Only an owned (product or legacy-shape) and provably
 * dead legacy descriptor is replaced; the decision reads no secret values.
 */
export async function planLegacyCompatWriteback(
  options: CompatWritebackOptions,
): Promise<CompatWritebackPlan> {
  const home = options.home ?? os.homedir();
  const exists = options.exists ?? existsSync;
  const legacyPath = legacyEndpointPath(home, options.resource);
  if (options.explicitTarget || options.targetPath !== canonicalEndpointPath(home, options.resource)) {
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

function parseDescriptorForProbe(filePath: string): unknown {
  try {
    const info = readFileSync(filePath);
    if (info.byteLength > MAX_DESCRIPTOR_PROBE_BYTES) return undefined;
    return JSON.parse(info.toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Human-readable, credential-free explanation for a declined write-back,
 * for host logs. `logCompatNotice` never receives descriptor contents.
 */
export function describeWritebackDecision(
  plan: CompatWritebackPlan,
): string | undefined {
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
