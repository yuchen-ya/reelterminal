/**
 * Classification for local caption model download failures.
 *
 * The whisper worker downloads model files over fetch
 * (apps/web/src/workers/whisper-worker.ts, `MODEL_HOST`). When that fails,
 * the raw browser error ("Failed to fetch") used to be rendered verbatim.
 * This module classifies the thrown value into evidence-backed kinds so
 * the UI can show an understandable, localized explanation plus an
 * actionable suggestion — without inventing causes that are not in the
 * error itself.
 */

export type WhisperDownloadErrorKind = "network" | "http" | "storage" | "unknown";

export interface ClassifiedWhisperDownloadError {
  kind: WhisperDownloadErrorKind;
  /** HTTP status for the "http" kind (from the transformers.js message). */
  status?: number | undefined;
  /** Original error message, kept readable as a debugging detail line. */
  message: string;
}

/**
 * transformers.js maps known HTTP statuses to fixed phrases before
 * throwing (hub.js ERROR_MAPPING, @huggingface/transformers 3.8.1):
 * `Error("${message}: "${remoteURL}".")`.
 */
const HTTP_STATUS_PHRASES: ReadonlyArray<readonly [RegExp, number]> = [
  [/^Bad request error occurred while trying to load file\b/, 400],
  [/^Unauthorized access to file\b/, 401],
  [/^Forbidden access to file\b/, 403],
  [/^Could not locate file\b/, 404],
  [/^Request timeout error occurred while trying to load file\b/, 408],
  [/^Internal server error error occurred while trying to load file\b/, 500],
  [/^Bad gateway error occurred while trying to load file\b/, 502],
  [/^Service unavailable error occurred while trying to load file\b/, 503],
  [/^Gateway timeout error occurred while trying to load file\b/, 504],
];

/** Unknown statuses keep the generic transformers.js wording. */
const GENERIC_HTTP_STATUS = /\bError \((\d{3})\) occurred while trying to load file\b/;

/**
 * Reads name/message without assuming `instanceof Error`: storage
 * failures surface as DOMException (e.g. QuotaExceededError), which is
 * not an Error subclass in every engine.
 */
function readErrorParts(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  if (typeof error === "object" && error !== null) {
    const candidate = error as { name?: unknown; message?: unknown };
    return {
      name: typeof candidate.name === "string" ? candidate.name : "",
      message:
        typeof candidate.message === "string" ? candidate.message : String(error),
    };
  }
  return { name: "", message: String(error) };
}

/**
 * Pure classifier: maps a thrown value from the model download to a
 * WhisperDownloadErrorKind. Only patterns with real evidence are
 * classified; everything else stays "unknown" so the UI keeps the raw
 * message instead of guessing a cause.
 */
export function classifyWhisperDownloadError(
  error: unknown,
): ClassifiedWhisperDownloadError {
  const { name, message } = readErrorParts(error);

  // fetch() rejects with TypeError when the endpoint is unreachable,
  // refused, or blocked (offline, DNS, proxy). The wording is
  // engine-specific: "Failed to fetch" (Chromium), "Load failed"
  // (WebKit/Bun), "NetworkError when attempting to fetch resource"
  // (Firefox). Message matching is deliberate — a bare `TypeError`
  // check would also swallow unrelated programming errors such as
  // "Cannot read properties of undefined". Word boundaries keep
  // "Upload failed" from matching "load failed".
  if (
    /\bfailed to fetch\b/i.test(message) ||
    /\bload failed\b/i.test(message) ||
    /\bnetworkerror when attempting to fetch resource\b/i.test(message)
  ) {
    return { kind: "network", message };
  }

  // Browser storage / Cache API failures: quota exceeded, storage
  // disabled, or transformers.js reporting the browser cache missing.
  if (
    name === "QuotaExceededError" ||
    /\bquota/i.test(message) ||
    /\bbrowser cache is not available\b/i.test(message) ||
    /\bcachestorage\b/i.test(message)
  ) {
    return { kind: "storage", message };
  }

  for (const [pattern, status] of HTTP_STATUS_PHRASES) {
    if (pattern.test(message)) {
      return { kind: "http", status, message };
    }
  }
  const genericStatus = GENERIC_HTTP_STATUS.exec(message);
  if (genericStatus) {
    return { kind: "http", status: Number(genericStatus[1]), message };
  }

  return { kind: "unknown", message };
}

export interface WhisperDownloadFailureView {
  kind: WhisperDownloadErrorKind;
  status?: number | undefined;
  /** Raw original message, rendered as the secondary detail line. */
  rawMessage: string;
}

export interface WhisperDownloadFailureCopy {
  /** i18n key under the captions.modelDownloadFailure namespace. */
  key: string;
  options?: Record<string, unknown>;
}

/**
 * Maps a classified failure to its localized title key. Returns null for
 * unclassified failures so the caller keeps the raw message as the title
 * instead of asserting a cause it does not have.
 */
export function whisperDownloadFailureCopy(
  failure: WhisperDownloadFailureView,
  context: { model: string; size: string },
): WhisperDownloadFailureCopy | null {
  switch (failure.kind) {
    case "network":
      return {
        key: "captions.modelDownloadFailure.network",
        options: { model: context.model, size: context.size },
      };
    case "http":
      return {
        key: "captions.modelDownloadFailure.http",
        options: { model: context.model, status: failure.status ?? "?" },
      };
    case "storage":
      return {
        key: "captions.modelDownloadFailure.storage",
        options: { model: context.model },
      };
    default:
      return null;
  }
}
