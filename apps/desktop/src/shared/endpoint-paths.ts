/**
 * Central endpoint-directory resolution for the desktop host and the
 * live-mcp connector.
 *
 * Canonical location:  ~/.reelterminal/<resource>
 * Legacy location:     ~/.openreel/<resource>
 *
 * Per-resource resolution order:
 *   1. explicit REELTERMINAL_* override;
 *   2. the canonical `~/.reelterminal/` path;
 *   3. compatibility discovery of the legacy `~/.openreel/` path — read-only
 *      positioning, and only when (i) the canonical path does not exist and
 *      (ii) the legacy descriptor passes ownership validation.
 *
 * Descriptor ownership: descriptors written by this application carry
 * `product: "reelterminal"`. Unmarked descriptors that match the supported
 * legacy structure are recognized as `legacy-shape`. A descriptor
 * with a different product id is never discovered, never written back, and
 * — for explicit override targets — refuses the operation instead of
 * silently cross-connecting to another product or session.
 *
 * Descriptors are credentials: nothing in this module logs, returns, or
 * echoes descriptor contents.
 */
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Product identity written into endpoint descriptors by this application. */
export const ENDPOINT_PRODUCT_ID = "reelterminal";

export const ENDPOINT_DIR_NAME = ".reelterminal";
export const LEGACY_ENDPOINT_DIR_NAME = ".openreel";

export type EndpointResource = "live-endpoint";

const RESOURCE_NAMES: Record<EndpointResource, string> = {
  "live-endpoint": "live-endpoint.json",
};

const OVERRIDE_ENV_NAMES: Record<
  EndpointResource,
  { readonly newName: string }
> = {
  "live-endpoint": {
    newName: "REELTERMINAL_LIVE_ENDPOINT_FILE",
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

/**
 * Raw REELTERMINAL_* override value; empty string counts as set-and-empty.
 * The live endpoint accepts any non-empty value.
 */
export function endpointOverridePath(
  env: NodeJS.ProcessEnv,
  resource: EndpointResource,
): string | undefined {
  const { newName } = OVERRIDE_ENV_NAMES[resource];
  return env[newName];
}

function acceptsOverride(value: string): boolean {
  return value.length > 0;
}

/* --------------------------- ownership model ----------------------------- */

/**
 * - `product`: the descriptor carries `product: "reelterminal"`.
 * - `legacy-shape`: no product field, but the JSON matches the exact
 *   supported unmarked endpoint structure.
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

/** Check the supported unmarked endpoint structure. */
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

/**
 * Classify a parsed descriptor without looking at secret fields. The
 * product id of a foreign writer is safe to surface in error messages;
 * tokens and URLs never are.
 */
export function classifyDescriptorOwnership(
  _resource: EndpointResource,
  parsed: unknown,
): DescriptorOwnership {
  if (!isRecord(parsed)) return "invalid";
  if (typeof parsed.product === "string") {
    return parsed.product === ENDPOINT_PRODUCT_ID ? "product" : "foreign";
  }
  return matchesLegacyLiveShape(parsed) ? "legacy-shape" : "invalid";
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

/* --------------------------- read resolution ----------------------------- */

export interface EndpointPathResolution {
  /** The path a reader should open. */
  readonly path: string;
  /**
   * When set, discovery cannot choose and the reader must fail with
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
  if (override !== undefined && acceptsOverride(override)) {
    return { path: override };
  }
  const canonical = canonicalEndpointPath(home, resource);
  const legacy = legacyEndpointPath(home, resource);
  const canonicalExists = exists(canonical);
  const legacyExists = exists(legacy);
  if (canonicalExists && legacyExists) {
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
