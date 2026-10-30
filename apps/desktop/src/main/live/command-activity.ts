import type { DesktopCommandActivity } from "@reelterminal/agent-facade/desktop-protocol";

const privateKey = /token|secret|password|credential|authorization|api[-_]?key|cookie|base64|imageData|dataUrl/i;
const contentKey = /^(?:text|body|content|prompt|message|description|feedback|value)$/i;

export function activityText(value: string, limit = 512): string {
  return value
    .replace(/data:[^\s"']+/gi, "[image/data omitted]")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/(["']?(?:token|secret|password|credential|authorization|api[-_]?key|cookie)["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,"']+)/gi, "$1[redacted]")
    .slice(0, limit);
}

/** UI only: never retain credentials, media bytes, or unbounded geometry. */
export function commandActivityDetails(params: unknown): Omit<DesktopCommandActivity, "callId" | "startedAt"> {
  let remaining = 6_000;
  const project = (value: unknown, depth = 0): unknown => {
    if (remaining <= 0) return "[truncated]";
    if (typeof value === "string") {
      const text = activityText(value, Math.min(512, remaining));
      remaining -= text.length;
      return text.length < value.length ? `${text}…` : text;
    }
    if (value === null || typeof value !== "object") return value;
    if (depth >= 6) return "[nested value omitted]";
    if (Array.isArray(value)) {
      const preview = value.slice(0, 8).map(item => project(item, depth + 1));
      return value.length > 8 ? { count: value.length, preview, omitted: value.length - 8 } : preview;
    }
    const entries = Object.entries(value).slice(0, 30);
    remaining -= entries.length * 16;
    return Object.fromEntries(entries.map(([key, item]) => [key, privateKey.test(key) ? "[redacted]" : contentKey.test(key) ? "[content omitted]" : project(item, depth + 1)]));
  };
  const record = params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : {};
  const target = record.target as Record<string, unknown> | undefined;
  const reviewTarget = target && typeof target.reviewWorkspaceId === "string" && typeof target.instanceId === "string"
    ? { reviewWorkspaceId: target.reviewWorkspaceId, instanceId: target.instanceId, ...(typeof target.nodeId === "string" ? { nodeId: target.nodeId } : {}) }
    : undefined;
  const projected = project(record) as Record<string, unknown>;
  const summary = Object.entries(projected).filter(([key]) => !["target", "requestId", "expectedNodeRevision"].includes(key))
    .slice(0, 4).map(([key, value]) => `${key}=${typeof value === "object" ? Array.isArray(record[key]) ? `[${(record[key] as unknown[]).length}]` : "{…}" : String(value)}`).join(" · ");
  return { ...(reviewTarget ? { reviewTarget } : {}), arguments: JSON.stringify(projected, null, 2).slice(0, 10_000), argumentSummary: activityText(summary, 180) };
}
