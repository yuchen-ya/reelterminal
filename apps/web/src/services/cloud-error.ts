import type { CloudFailureKind } from "@openreel/core";

export type { CloudFailureKind };

/**
 * A cloud failure reduced to what the UI needs: a category that maps to
 * a localized, understandable title plus the original detail text kept
 * readable for debugging. `cloudOrigin` distinguishes failures that
 * demonstrably came from a cloud request from local preconditions (e.g.
 * a missing transcript), which must not be presented as cloud outages.
 */
export interface ClassifiedCloudError {
  kind: CloudFailureKind;
  status?: number | undefined;
  detail: string;
  cloudOrigin: boolean;
}

const CLOUD_FAILURE_KINDS: readonly string[] = [
  "network",
  "server",
  "rateLimited",
  "taskFailed",
  "timeout",
  "responseInvalid",
];

/**
 * Structured failures (CloudRequestError from the cloud services) are
 * matched by their `kind` field rather than by instanceof so the
 * classifier stays decoupled from the core module boundary.
 */
function hasCloudFailureKind(err: unknown): err is {
  kind: CloudFailureKind;
  status?: number | undefined;
  detail: string;
  message: string;
} {
  return (
    err instanceof Error &&
    typeof (err as unknown as { kind?: unknown }).kind === "string" &&
    CLOUD_FAILURE_KINDS.includes(
      (err as unknown as { kind: string }).kind,
    )
  );
}

/**
 * Pure classifier: maps a thrown value (fetch rejection, Response-derived
 * error, job-status failure, timeout) to a CloudFailureKind.
 *
 * Priority: structured kind -> fetch/network failure -> timeout ->
 * unparseable response -> HTTP status text backstops -> everything else
 * stays an unclassified (possibly local) failure.
 */
export function classifyCloudError(err: unknown): ClassifiedCloudError {
  const message = err instanceof Error ? err.message : String(err);

  if (hasCloudFailureKind(err)) {
    return {
      kind: err.kind,
      status: err.status,
      detail: err.detail || message,
      cloudOrigin: true,
    };
  }

  // fetch() rejects with TypeError ("Failed to fetch" in Chromium,
  // "Load failed" in WebKit) when the endpoint is unreachable, refused,
  // or blocked; services also wrap the same situation in plain errors.
  // Word boundaries matter: "Upload failed" must not match "load failed".
  if (
    (err instanceof TypeError && /fetch|network|load failed/i.test(message)) ||
    /\bfailed to fetch\b|\bcould not reach\b|\bload failed\b|\bnetwork error\b/i.test(
      message,
    )
  ) {
    return { kind: "network", detail: message, cloudOrigin: true };
  }

  if (/\btimed out\b|\btimeout\b/i.test(message)) {
    return { kind: "timeout", detail: message, cloudOrigin: true };
  }

  // A 2xx whose body could not be parsed.
  if (
    err instanceof SyntaxError ||
    /unexpected token|is not valid json|invalid json/i.test(message)
  ) {
    return { kind: "responseInvalid", detail: message, cloudOrigin: true };
  }

  // Backstops for services that report HTTP failures as plain strings.
  const apiErrorMatch = /\bAPI error:\s*(\d{3})\b/i.exec(message);
  if (apiErrorMatch) {
    const status = Number(apiErrorMatch[1]);
    return {
      kind: status === 429 ? "rateLimited" : "server",
      status,
      detail: message,
      cloudOrigin: true,
    };
  }
  const tooManyMatch = /\b429\b|\brate limit/i.exec(message);
  if (tooManyMatch) {
    return { kind: "rateLimited", detail: message, cloudOrigin: true };
  }
  const serverStatusMatch = /\b5\d{2}\b/.exec(message);
  if (serverStatusMatch) {
    return {
      kind: "server",
      status: Number(serverStatusMatch[0]),
      detail: message,
      cloudOrigin: true,
    };
  }

  // Anything else keeps the generic failure wording: it may be a local
  // problem (empty transcript, audio decode) rather than a cloud one.
  return { kind: "taskFailed", detail: message, cloudOrigin: false };
}

export interface CloudFailureMessage {
  /** i18n key under the cloud.failure namespace. */
  key: string;
  options?: Record<string, unknown>;
  /** Whether the raw detail belongs on a separate secondary line. */
  showDetail: boolean;
}

/**
 * Maps a classified failure to its localized title key. Returns null for
 * non-cloud failures so the caller can keep its generic wording.
 */
export function cloudFailureMessage(
  classified: ClassifiedCloudError,
): CloudFailureMessage | null {
  if (!classified.cloudOrigin) return null;

  switch (classified.kind) {
    case "server":
      return {
        key: "cloud.failure.server",
        options: { status: classified.status ?? "?" },
        showDetail: true,
      };
    case "taskFailed":
      // The title already interpolates the server-provided reason.
      return {
        key: "cloud.failure.taskFailed",
        options: { message: classified.detail },
        showDetail: false,
      };
    default:
      return { key: `cloud.failure.${classified.kind}`, showDetail: true };
  }
}
