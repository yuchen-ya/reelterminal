/**
 * Redaction for the `sanitizedInfo` field stored on task records.
 *
 * Only display-grade generation summaries belong here (agent name/version,
 * the agent's self-reported label). As defense in depth the stored string is
 * scrubbed regardless of the source: absolute paths are collapsed (a local
 * path is machine detail the ledger does not need), credential-shaped
 * assignments and long opaque tokens are removed, and the result is bounded.
 */
import type { AgentMediaTaskRecord } from "./types";

export const AGENT_TASK_SANITIZED_INFO_MAX_LENGTH = 512;

// Windows/POSIX absolute paths and file URIs.
const PATH_PATTERN =
  /\b(?:file:\/\/\/?\S+|[A-Za-z]:[\\/][^\s"'，。；）、]+|(?:^|[\s(（"'])\/(?:[^\s"'，。；）、]*\/)*[^\s"'，。；）、]+)/g;
// key=value / key: value shapes carrying secret-looking values.
const CREDENTIAL_PATTERN =
  /\b(?:api[_-]?key|apikey|access[_-]?token|token|bearer|authorization|password|secret|credential)s?\b\s*[:=]\s*\S+/gi;
// Long opaque token runs (hex/base64-ish), e.g. raw keys or session ids.
const OPAQUE_TOKEN_PATTERN = /\b[A-Za-z0-9+/_-]{32,}\b/g;

export function sanitizeGenerationInfo(raw: string): string {
  const scrubbed = raw
    .replace(/\r\n?/g, "\n")
    .replace(CREDENTIAL_PATTERN, "[凭据已移除]")
    .replace(PATH_PATTERN, "[路径已省略]")
    .replace(OPAQUE_TOKEN_PATTERN, "[已脱敏]")
    .trim();
  if (scrubbed.length <= AGENT_TASK_SANITIZED_INFO_MAX_LENGTH) {
    return scrubbed;
  }
  return `${scrubbed.slice(0, AGENT_TASK_SANITIZED_INFO_MAX_LENGTH - 1)}…`;
}

export function sanitizeGenerationInfoForRecord(
  raw: string,
): Pick<AgentMediaTaskRecord, "sanitizedInfo"> {
  return { sanitizedInfo: sanitizeGenerationInfo(raw) };
}
