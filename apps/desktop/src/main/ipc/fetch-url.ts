import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP, BlockList } from "node:net";
import type { IncomingMessage, RequestOptions } from "node:http";

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;

export interface FetchUrlResult {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly contentType: string;
  readonly body: ArrayBuffer;
  readonly error?: string;
}

export interface FetchUrlDependencies {
  readonly lookup: (hostname: string) => Promise<LookupAddress[]>;
  readonly request: (
    url: URL,
    address: LookupAddress,
    signal: AbortSignal,
  ) => Promise<IncomingMessage>;
}

function err(message: string, status = 0): FetchUrlResult {
  return {
    ok: false,
    status,
    statusText: message,
    contentType: "",
    body: new ArrayBuffer(0),
    error: message,
  };
}

const blockedAddresses = new BlockList();

for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedAddresses.addSubnet(address, prefix, "ipv4");
}

for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedAddresses.addSubnet(address, prefix, "ipv6");
}

blockedAddresses.addRange(
  "::",
  "1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  "ipv6",
);
blockedAddresses.addRange(
  "4000::",
  "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  "ipv6",
);

function isBlockedAddress(address: string, family: number): boolean {
  if (family !== 4 && family !== 6) return true;
  return blockedAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  );
}

async function resolvePublicAddress(
  hostname: string,
  lookup: FetchUrlDependencies["lookup"],
): Promise<LookupAddress | null> {
  if (isBlockedHostname(hostname)) return null;

  const unwrappedHost = hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(unwrappedHost);
  if (literalFamily !== 0) {
    if (isBlockedAddress(unwrappedHost, literalFamily)) return null;
    return { address: unwrappedHost, family: literalFamily };
  }

  const addresses = await lookup(unwrappedHost);
  if (
    addresses.length === 0 ||
    addresses.some((entry) => isBlockedAddress(entry.address, entry.family))
  ) {
    return null;
  }
  return addresses[0] ?? null;
}

async function lookupAll(hostname: string): Promise<LookupAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

function requestPinnedUrl(
  url: URL,
  address: LookupAddress,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  const client = url.protocol === "https:" ? https : http;
  const lookup: NonNullable<RequestOptions["lookup"]> = (
    _hostname,
    options,
    callback,
  ) => {
    if (options.all) {
      callback(null, [address]);
    } else {
      callback(null, address.address, address.family);
    }
  };

  return new Promise((resolve, reject) => {
    const request = client.request(
      url,
      { method: "GET", agent: false, lookup, signal },
      resolve,
    );
    request.once("error", reject);
    request.end();
  });
}

async function readResponseBody(
  response: IncomingMessage,
  maxBytes: number,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const value of response) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (chunk.byteLength > maxBytes - total) {
      response.destroy();
      return null;
    }
    chunks.push(chunk);
    total += chunk.byteLength;
  }

  return Buffer.concat(chunks, total);
}

function exactArrayBuffer(buffer: Buffer): ArrayBuffer {
  if (
    buffer.byteOffset === 0 &&
    buffer.byteLength === buffer.buffer.byteLength
  ) {
    return buffer.buffer as ArrayBuffer;
  }
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

const defaultDependencies: FetchUrlDependencies = {
  lookup: lookupAll,
  request: requestPinnedUrl,
};

export async function fetchUrl(
  args: { url: string; maxBytes?: number },
  dependencies: FetchUrlDependencies = defaultDependencies,
): Promise<FetchUrlResult> {
  if (
    args.maxBytes !== undefined &&
    (!Number.isSafeInteger(args.maxBytes) || args.maxBytes <= 0)
  ) {
    return err("Invalid byte limit");
  }
  const maxBytes = Math.min(args.maxBytes ?? DEFAULT_MAX_BYTES, DEFAULT_MAX_BYTES);

  let parsed: URL;
  try {
    parsed = new URL(args.url);
  } catch {
    return err("Invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return err("Only http/https URLs are allowed");
  }
  if (parsed.username || parsed.password) {
    return err("URLs with embedded credentials are not allowed");
  }

  const controller = new AbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error("Request timed out"));
    }, REQUEST_TIMEOUT_MS);
  });

  try {
    const request = (async (): Promise<FetchUrlResult> => {
      const address = await resolvePublicAddress(parsed.hostname, dependencies.lookup);
      if (!address) return err("Refusing to fetch a private or non-public host");

      const response = await dependencies.request(parsed, address, controller.signal);
      const status = response.statusCode ?? 0;
      const contentType = response.headers["content-type"] ?? "";
      const declaredBytes = Number(response.headers["content-length"] ?? "0");
      if (declaredBytes > maxBytes) {
        response.destroy();
        return err(`Resource too large (max ${maxBytes} bytes)`, status);
      }
      if (status >= 300 && status < 400) {
        response.destroy();
        return err("Redirect responses are not followed", status);
      }
      if (status < 200 || status >= 300) {
        response.destroy();
        return err(response.statusMessage || `Request failed (${status})`, status);
      }

      const body = await readResponseBody(response, maxBytes);
      if (!body) return err(`Resource too large (max ${maxBytes} bytes)`, status);

      return {
        ok: true,
        status,
        statusText: response.statusMessage ?? "",
        contentType: Array.isArray(contentType) ? contentType[0] ?? "" : contentType,
        body: exactArrayBuffer(body),
      };
    })();

    return await Promise.race([request, timeoutPromise]);
  } catch (error) {
    return err(
      timedOut
        ? "Request timed out"
        : error instanceof Error
          ? error.message
          : "Fetch failed",
    );
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
